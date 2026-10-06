package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akashtiwari2/WebDairy/backend/internal/entries"
	"github.com/labstack/echo/v4"
)

type stub struct {
	err     error
	saves   int
	deletes int
}

func (s *stub) Dates(context.Context) ([]string, error) { return []string{"2030-10-20"}, s.err }
func (s *stub) Get(context.Context, string) (entries.Entry, error) {
	return entries.Entry{Date: "2030-10-20", Title: "Sample", Body: "Synthetic", Revision: 2}, s.err
}
func (s *stub) Save(_ context.Context, date string, write entries.Write) (entries.Entry, error) {
	s.saves++
	return entries.Entry{Date: date, Title: write.Title, Body: write.Body, Revision: write.ExpectedRevision + 1}, s.err
}
func (s *stub) Delete(context.Context, string, int64) error { s.deletes++; return s.err }

func request(e *echo.Echo, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://127.0.0.1:8080"+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if method != http.MethodGet {
		req.Header.Set("Origin", "http://127.0.0.1:8080")
	}
	result := httptest.NewRecorder()
	e.ServeHTTP(result, req)
	return result
}
func healthy(repository entries.Repository) *echo.Echo {
	return New(func(context.Context) error { return nil }, repository)
}

const validWrite = `{"title":"Sample","body":"Synthetic text","expected_revision":0,"operation_id":"11111111-1111-4111-8111-111111111111"}`

func TestReadiness(t *testing.T) {
	for _, tc := range []struct {
		name    string
		failure error
		code    int
		body    string
	}{
		{"migrated database", nil, 200, `"database":"ready"`},
		{"database unavailable", errors.New("secret connection details"), 503, `"database":"not-ready"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := request(New(func(context.Context) error { return tc.failure }, &stub{}), "GET", "/api/health", "")
			if res.Code != tc.code || !strings.Contains(res.Body.String(), tc.body) {
				t.Fatalf("unexpected readiness: %d %s", res.Code, res.Body.String())
			}
			if strings.Contains(res.Body.String(), "secret") {
				t.Fatal("database error leaked")
			}
			if res.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("readiness must not be cached")
			}
		})
	}
}
func TestCRUDContract(t *testing.T) {
	s := &stub{}
	e := healthy(s)
	for _, tc := range []struct {
		method, path, body, expected string
		code                         int
	}{
		{"GET", "/api/entries", "", `"dates":["2030-10-20"]`, 200},
		{"GET", "/api/entries/2030-10-20", "", `"revision":2`, 200},
		{"PUT", "/api/entries/2030-10-20", validWrite, `"revision":1`, 200},
		{"DELETE", "/api/entries/2030-10-20", `{"expected_revision":1}`, "", 204},
	} {
		res := request(e, tc.method, tc.path, tc.body)
		if res.Code != tc.code || !strings.Contains(res.Body.String(), tc.expected) {
			t.Fatalf("%s: %d %s", tc.method, res.Code, res.Body.String())
		}
	}
	if s.saves != 1 || s.deletes != 1 {
		t.Fatal("writes did not execute")
	}
}
func TestInvalidRequestsNeverWrite(t *testing.T) {
	for _, body := range []string{
		`{`, validWrite + `{}`, strings.Replace(validWrite, `"expected_revision":0`, `"expected_revision":-1`, 1),
		strings.Replace(validWrite, `"expected_revision":0`, `"expected_revision":1.5`, 1),
		strings.Replace(validWrite, `"expected_revision":0`, `"expected_revision":9007199254740991`, 1),
		strings.Replace(validWrite, `"operation_id":"11111111-1111-4111-8111-111111111111"`, `"operation_id":"bad"`, 1),
		`{"title":" ","body":"\n","expected_revision":0,"operation_id":"11111111-1111-4111-8111-111111111111"}`,
		strings.Replace(validWrite, `"title":"Sample"`, `"title":"`+strings.Repeat("x", 201)+`"`, 1),
		strings.Replace(validWrite, `"body":"Synthetic text"`, `"body":"`+strings.Repeat("x", 1048577)+`"`, 1),
		strings.Replace(validWrite, `"title":"Sample"`, `"unknown":true,"title":"Sample"`, 1),
	} {
		s := &stub{}
		res := request(healthy(s), "PUT", "/api/entries/2030-10-20", body)
		if res.Code != 400 || s.saves != 0 {
			t.Fatalf("invalid request executed: status=%d writes=%d", res.Code, s.saves)
		}
	}
	s := &stub{}
	res := request(healthy(s), "PUT", "/api/entries/2030-10-20", strings.Repeat("x", maxRequest+1))
	if res.Code != 413 || s.saves != 0 {
		t.Fatal("oversized request was accepted")
	}
}
func TestCalendarDateValidation(t *testing.T) {
	for _, date := range []string{"2023-02-29", "2030-13-01", "2030-04-31", "0000-01-01", "2030-1-01", "not-a-date"} {
		s := &stub{}
		res := request(healthy(s), "PUT", "/api/entries/"+date, validWrite)
		if res.Code != 400 || s.saves != 0 {
			t.Fatalf("invalid date accepted: %s", date)
		}
	}
	for _, date := range []string{"2024-02-29", "0001-01-01", "9999-12-31", "2030-10-20", "2000-01-01"} {
		if !validDate(date) {
			t.Fatalf("valid date rejected: %s", date)
		}
	}
}
func TestFailureAndConflictResponses(t *testing.T) {
	for _, tc := range []struct {
		err      error
		status   int
		expected string
	}{
		{errors.New("password and SQL details"), 503, "database_unavailable"},
		{entries.ErrNotFound, 404, "entry_not_found"},
		{&entries.Conflict{Current: &entries.Entry{Date: "2030-10-20", Title: "Other sample", Revision: 3}}, 409, "Other sample"},
		{&entries.Conflict{}, 409, `"current":null`},
	} {
		res := request(healthy(&stub{err: tc.err}), "PUT", "/api/entries/2030-10-20", validWrite)
		if res.Code != tc.status || !strings.Contains(res.Body.String(), tc.expected) || strings.Contains(res.Body.String(), "password") {
			t.Fatalf("bad error response: %d %s", res.Code, res.Body.String())
		}
	}
}
func TestLocalOriginRequired(t *testing.T) {
	for _, tc := range []struct{ host, origin, contentType string }{
		{"127.0.0.1:8080", "https://evil.example", "application/json"},
		{"evil.example", "http://evil.example", "application/json"},
		{"127.0.0.1:8080", "", "application/json"},
		{"127.0.0.1:8080", "http://127.0.0.1:8080", "text/plain"},
	} {
		s := &stub{}
		e := healthy(s)
		req := httptest.NewRequest("PUT", "http://"+tc.host+"/api/entries/2030-10-20", strings.NewReader(validWrite))
		req.Header.Set("Origin", tc.origin)
		req.Header.Set("Content-Type", tc.contentType)
		res := httptest.NewRecorder()
		e.ServeHTTP(res, req)
		if (res.Code != 403 && res.Code != 400) || s.saves != 0 {
			t.Fatal("untrusted write was accepted")
		}
	}
	// The development frontend's same-origin proxy is allowed, without CORS.
	s := &stub{}
	req := httptest.NewRequest("PUT", "http://127.0.0.1:4200/api/entries/2030-10-20", strings.NewReader(validWrite))
	req.Header.Set("Origin", "http://127.0.0.1:4200")
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	healthy(s).ServeHTTP(res, req)
	var entry entries.Entry
	if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &entry) != nil || entry.Revision != 1 {
		t.Fatal("frontend proxy write failed")
	}
}
