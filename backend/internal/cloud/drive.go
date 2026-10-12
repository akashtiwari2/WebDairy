package cloud

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"sort"
	"time"
)

type File struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Created    string            `json:"createdTime"`
	Size       string            `json:"size"`
	MD5        string            `json:"md5Checksum"`
	Properties map[string]string `json:"appProperties"`
}

var fileID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,200}$`)

func (g *Google) List(ctx context.Context, subject string) ([]File, error) {
	access, err := g.access(ctx, subject)
	if err != nil {
		return nil, err
	}
	files := []File{}
	cursor := ""
	for page := 0; page < 10; page++ {
		q := url.Values{"spaces": {"appDataFolder"}, "q": {"trashed = false and appProperties has { key='webdiary' and value='1' }"}, "fields": {"nextPageToken,files(id,name,createdTime,size,md5Checksum,appProperties)"}, "pageSize": {"100"}, "orderBy": {"createdTime desc"}}
		if cursor != "" {
			q.Set("pageToken", cursor)
		}
		var result struct {
			Files []File `json:"files"`
			Next  string `json:"nextPageToken"`
		}
		if err = g.decode(ctx, "GET", g.DriveURL+"?"+q.Encode(), nil, access, "", &result, 2*1024*1024); err != nil {
			return nil, err
		}
		if len(result.Files) > 100 {
			return nil, ErrReconnect
		}
		for _, f := range result.Files {
			if !fileID.MatchString(f.ID) || f.Properties["webdiary"] != "1" {
				return nil, ErrReconnect
			}
			if _, e := time.Parse(time.RFC3339Nano, f.Created); e != nil {
				return nil, ErrReconnect
			}
			if stamp := f.Properties["snapshot_at"]; stamp != "" {
				if parsed, e := time.Parse(time.RFC3339Nano, stamp); e != nil || parsed.After(time.Now().Add(time.Minute)) {
					delete(f.Properties, "snapshot_at")
				}
			}
			files = append(files, f)
		}
		if result.Next == "" {
			return files, nil
		}
		if result.Next == cursor {
			return nil, ErrReconnect
		}
		cursor = result.Next
	}
	return nil, errors.New("More than 1,000 Drive backups; review retention before uploading")
}
func (g *Google) Upload(ctx context.Context, subject, operation, vault, snapshotAt string, data []byte) (File, error) {
	g.uploadMu.Lock()
	defer g.uploadMu.Unlock()
	files, err := g.List(ctx, subject)
	if err != nil {
		return File{}, err
	}
	checksum := md5.Sum(data)
	want := hex.EncodeToString(checksum[:])
	for _, f := range files {
		if f.Properties["operation_id"] == operation {
			if f.MD5 != want {
				return File{}, errors.New("Backup retry payload changed; preserve the original pending backup")
			}
			return f, nil
		}
	}
	access, err := g.access(ctx, subject)
	if err != nil {
		return File{}, err
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	metadata, _ := json.Marshal(map[string]any{"name": "webdiary-" + operation + ".diary", "parents": []string{"appDataFolder"}, "appProperties": map[string]string{"webdiary": "1", "operation_id": operation, "vault_id": vault, "snapshot_at": snapshotAt}})
	header := textproto.MIMEHeader{}
	header.Set("Content-Type", "application/json; charset=UTF-8")
	part, _ := writer.CreatePart(header)
	part.Write(metadata)
	header = textproto.MIMEHeader{}
	header.Set("Content-Type", "application/json")
	part, _ = writer.CreatePart(header)
	part.Write(data)
	writer.Close()
	var file File
	query := url.Values{"uploadType": {"multipart"}, "fields": {"id,name,createdTime,size,md5Checksum,appProperties"}}
	if err = g.decode(ctx, "POST", g.UploadURL+"?"+query.Encode(), &body, access, "multipart/related; boundary="+writer.Boundary(), &file, 65536); err != nil {
		return File{}, err
	}
	if !fileID.MatchString(file.ID) || file.MD5 != want || file.Properties["operation_id"] != operation || file.Properties["webdiary"] != "1" {
		return File{}, errors.New("Drive upload was not verified; retain the pending backup and retry")
	}
	return file, nil
}
func (g *Google) Download(ctx context.Context, subject, id string, limit int64) ([]byte, error) {
	files, err := g.List(ctx, subject)
	if err != nil {
		return nil, err
	}
	found := false
	for _, f := range files {
		if f.ID == id {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("Choose an available WebDairy backup")
	}
	access, err := g.access(ctx, subject)
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", g.DriveURL+"/"+url.PathEscape(id)+"?alt=media", nil)
	req.Header.Set("Authorization", "Bearer "+access)
	r, err := g.HTTP.Do(req)
	if err != nil {
		return nil, ErrReconnect
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, ErrReconnect
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("Drive backup is too large or unavailable")
	}
	return data, nil
}

// Prune is explicit and called only after verified upload success. Never delete
// the newest backup or anything outside this app's private Drive folder.
func (g *Google) Prune(ctx context.Context, subject, vault string, keep int) error {
	if keep < 3 || keep > 100 {
		return errors.New("Keep 3 to 100 Drive backups")
	}
	files, err := g.List(ctx, subject)
	if err != nil {
		return err
	}
	filtered := files[:0]
	for _, f := range files {
		if f.Properties["vault_id"] == vault {
			filtered = append(filtered, f)
		}
	}
	files = filtered
	sort.Slice(files, func(i, j int) bool { return files[i].Created > files[j].Created })
	access, err := g.access(ctx, subject)
	if err != nil {
		return err
	}
	for i := keep; i < len(files); i++ {
		if !fileID.MatchString(files[i].ID) {
			return fmt.Errorf("Invalid Drive backup ID")
		}
		if err = g.decode(ctx, "DELETE", g.DriveURL+"/"+url.PathEscape(files[i].ID), nil, access, "", nil, 0); err != nil {
			return err
		}
	}
	return nil
}
