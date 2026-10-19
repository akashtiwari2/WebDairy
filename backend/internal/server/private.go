package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"time"

	"github.com/akashtiwari2/WebDairy/backend/internal/cloud"
	"github.com/akashtiwari2/WebDairy/backend/internal/private"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v4"
)

const sessionCookie = "diary_session"
const csrfCookie = "diary_csrf"

func cookie(c echo.Context, name string) string {
	v, e := c.Cookie(name)
	if e != nil {
		return ""
	}
	return v.Value
}
func setCookie(c echo.Context, name, value string, age int) {
	c.SetCookie(&http.Cookie{Name: name, Value: value, Path: "/api", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: c.Request().TLS != nil, MaxAge: age})
}
func privateFailure(c echo.Context, err error) error {
	var conflict *private.RecordConflict
	switch {
	case errors.As(err, &conflict):
		return c.JSON(409, map[string]any{"error": "revision_conflict", "current": conflict.Current})
	case errors.Is(err, private.ErrVaultChanged):
		return c.JSON(409, map[string]string{"error": "vault_changed"})
	case errors.Is(err, private.ErrInvalid):
		return invalid(c)
	case errors.Is(err, private.ErrConflict):
		return c.JSON(409, map[string]string{"error": "revision_conflict"})
	case errors.Is(err, private.ErrUnauthenticated):
		return c.JSON(401, map[string]string{"error": "authentication_required"})
	case errors.Is(err, private.ErrLimited):
		c.Response().Header().Set("Retry-After", "60")
		return c.JSON(429, map[string]string{"error": "try_again_later"})
	case errors.Is(err, private.ErrNotFound):
		return c.JSON(404, map[string]string{"error": "not_found"})
	default:
		return c.JSON(503, map[string]string{"error": "database_unavailable"})
	}
}

// New exposes only authenticated opaque vault storage. The development API is
// retained for migration compatibility tests and is never mounted here.
func New(checkDatabase func(context.Context) error, s *private.Store, google ...*cloud.Google) *echo.Echo {
	var g *cloud.Google
	if len(google) > 0 {
		g = google[0]
	}
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Response().Header().Set("Cache-Control", "no-store")
			c.Response().Header().Set("X-Content-Type-Options", "nosniff")
			switch c.Request().Host {
			case "127.0.0.1:47831", "localhost:47831", "127.0.0.1:4300", "localhost:4300":
			default:
				return c.NoContent(403)
			}
			origin := c.Request().Header.Get("Origin")
			if (origin != "" && origin != "http://"+c.Request().Host) || (c.Request().Header.Get("Sec-Fetch-Site") == "cross-site" && !(c.Request().Method == http.MethodGet && c.Path() == "/api/google/callback")) {
				return c.NoContent(403)
			}
			if c.Request().Method != http.MethodGet && c.Request().Method != http.MethodHead {
				csrf := cookie(c, csrfCookie)
				provided := c.Request().Header.Get("X-CSRF-Token")
				if origin == "" || !private.ValidToken(csrf) || subtle.ConstantTimeCompare([]byte(csrf), []byte(provided)) != 1 {
					return c.NoContent(403)
				}
			}
			timeout := 10 * time.Second
			if c.Path() == "/api/restore/stage" || c.Path() == "/api/restore/commit" || c.Path() == "/api/google/callback" || c.Path() == "/api/drive/upload" || c.Path() == "/api/drive/backups/:id" {
				timeout = 60 * time.Second
			}
			ctx, cancel := context.WithTimeout(c.Request().Context(), timeout)
			defer cancel()
			c.SetRequest(c.Request().WithContext(ctx))
			return next(c)
		}
	})
	authenticate := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			token, csrf := cookie(c, sessionCookie), cookie(c, csrfCookie)
			if err := s.Authenticate(c.Request().Context(), token, csrf); err != nil {
				return privateFailure(c, err)
			}
			setCookie(c, sessionCookie, token, 1800)
			setCookie(c, csrfCookie, csrf, 1800)
			return next(c)
		}
	}
	issueSession := func(c echo.Context) error {
		token, csrf, err := s.NewSession(c.Request().Context())
		if err != nil {
			return privateFailure(c, err)
		}
		if previous := cookie(c, sessionCookie); previous != "" {
			if err = s.Logout(c.Request().Context(), previous); err != nil {
				return privateFailure(c, err)
			}
		}
		setCookie(c, sessionCookie, token, 1800)
		setCookie(c, csrfCookie, csrf, 1800)
		return c.JSON(200, map[string]any{"initialized": true, "authenticated": true, "csrf_token": csrf})
	}
	e.GET("/api/health", func(c echo.Context) error {
		if err := checkDatabase(c.Request().Context()); err != nil {
			return c.JSON(503, map[string]string{"status": "unavailable", "database": "not-ready"})
		}
		return c.JSON(200, map[string]string{"status": "ok", "database": "ready", "stage": "phase4"})
	})
	e.GET("/api/auth/session", func(c echo.Context) error {
		initialized, err := s.Initialized(c.Request().Context())
		if err != nil {
			return privateFailure(c, err)
		}
		token, csrf := cookie(c, sessionCookie), cookie(c, csrfCookie)
		err = s.Authenticate(c.Request().Context(), token, csrf)
		authenticated := err == nil
		if err != nil && !errors.Is(err, private.ErrUnauthenticated) {
			return privateFailure(c, err)
		}
		if !authenticated {
			setCookie(c, sessionCookie, "", -1)
			if !private.ValidToken(csrf) {
				csrf, err = private.Token()
				if err != nil {
					return privateFailure(c, err)
				}
			}
		} else {
			setCookie(c, sessionCookie, token, 1800)
		}
		setCookie(c, csrfCookie, csrf, 1800)
		return c.JSON(200, map[string]any{"initialized": initialized, "authenticated": authenticated, "csrf_token": csrf, "google_setup_ready": !initialized && googleProof(c, g) != nil})
	})
	e.POST("/api/auth/setup", func(c echo.Context) error {
		var request struct {
			Password  string           `json:"login_password"`
			UseGoogle bool             `json:"use_google"`
			Envelope  private.Envelope `json:"envelope"`
		}
		if err := decode(c, &request); err != nil {
			return err
		}
		var proof *private.GoogleIdentity
		if request.UseGoogle {
			proof = googleProof(c, g)
			if proof == nil {
				return c.JSON(400, map[string]string{"error": "google_setup_expired", "message": "Google confirmation is missing or expired. Cancel this setup and sign in with Google again, or choose a local login password."})
			}
		}
		if ((len(request.Password) < 12 || len(request.Password) > 1024) && proof == nil) || !private.ValidEnvelope(request.Envelope) {
			return invalid(c)
		}
		if err := s.LoginAllowed(c.Request().Context()); err != nil {
			return privateFailure(c, err)
		}
		var err error
		if proof != nil {
			err = s.SetupGoogle(c.Request().Context(), request.Envelope, *proof)
		} else {
			err = s.Setup(c.Request().Context(), request.Password, request.Envelope)
		}
		if err != nil {
			return privateFailure(c, err)
		}
		if g != nil {
			g.ClearProof(cookie(c, googleProofCookie))
			setCookie(c, googleProofCookie, "", -1)
		}
		return issueSession(c)
	})
	e.POST("/api/auth/login", func(c echo.Context) error {
		var request struct {
			Password string `json:"password"`
		}
		if err := decode(c, &request); err != nil {
			return err
		}
		if len(request.Password) > 1024 {
			return invalid(c)
		}
		if err := s.CheckPassword(c.Request().Context(), request.Password); err != nil {
			return privateFailure(c, err)
		}
		return issueSession(c)
	})
	e.POST("/api/auth/logout", func(c echo.Context) error {
		if err := s.Logout(c.Request().Context(), cookie(c, sessionCookie)); err != nil {
			return privateFailure(c, err)
		}
		setCookie(c, sessionCookie, "", -1)
		setCookie(c, csrfCookie, "", -1)
		return c.NoContent(204)
	}, authenticate)
	e.POST("/api/auth/password", func(c echo.Context) error {
		var request struct {
			Current string `json:"current_password"`
			Next    string `json:"new_password"`
		}
		if err := decode(c, &request); err != nil {
			return err
		}
		if len(request.Next) < 12 || len(request.Next) > 1024 || len(request.Current) > 1024 {
			return invalid(c)
		}
		if err := s.CheckPassword(c.Request().Context(), request.Current); err != nil {
			return privateFailure(c, err)
		}
		if err := s.ResetLogin(c.Request().Context(), request.Next); err != nil {
			return privateFailure(c, err)
		}
		setCookie(c, sessionCookie, "", -1)
		setCookie(c, csrfCookie, "", -1)
		return c.NoContent(204)
	}, authenticate)
	e.GET("/api/vault", func(c echo.Context) error {
		v, err := s.Vault(c.Request().Context())
		if err != nil {
			return privateFailure(c, err)
		}
		return c.JSON(200, v)
	}, authenticate)
	e.PUT("/api/vault", func(c echo.Context) error {
		var request struct {
			Envelope  private.Envelope `json:"envelope"`
			Revision  int64            `json:"expected_revision"`
			Operation string           `json:"operation_id"`
		}
		if err := decode(c, &request); err != nil {
			return err
		}
		if !private.ValidEnvelope(request.Envelope) || request.Revision < 1 || request.Revision > maxRevision || !private.UUID.MatchString(request.Operation) {
			return invalid(c)
		}
		current, err := s.Vault(c.Request().Context())
		if err != nil {
			return privateFailure(c, err)
		}
		if current.Envelope.VaultID != request.Envelope.VaultID {
			return invalid(c)
		}
		v, err := s.SetEnvelope(c.Request().Context(), request.Envelope, request.Revision, request.Operation)
		if err != nil {
			return privateFailure(c, err)
		}
		return c.JSON(200, v)
	}, authenticate)
	e.GET("/api/entries", func(c echo.Context) error {
		cursor := c.QueryParam("cursor")
		if cursor != "" && !private.UUID.MatchString(cursor) {
			return invalid(c)
		}
		records, next, err := s.Records(c.Request().Context(), cursor)
		if err != nil {
			return privateFailure(c, err)
		}
		return c.JSON(200, map[string]any{"records": records, "next_cursor": next})
	}, authenticate)
	e.PUT("/api/entries/:id", func(c echo.Context) error {
		if !private.UUID.MatchString(c.Param("id")) {
			return invalid(c)
		}
		var w private.Write
		if err := decode(c, &w); err != nil {
			return err
		}
		if !private.ValidWrite(w) {
			return invalid(c)
		}
		record, err := s.Save(c.Request().Context(), c.Param("id"), w)
		if err != nil {
			return privateFailure(c, err)
		}
		return c.JSON(200, record)
	}, authenticate)

	e.GET("/api/backup/snapshot", func(c echo.Context) error {
		snapshot, err := s.Snapshot(c.Request().Context())
		if err != nil {
			return privateFailure(c, err)
		}
		return c.JSON(200, snapshot)
	}, authenticate)
	e.DELETE("/api/entries/:id", func(c echo.Context) error {
		var request struct {
			Epoch     string `json:"vault_epoch"`
			Revision  int64  `json:"expected_revision"`
			Operation string `json:"operation_id"`
		}
		if err := decode(c, &request); err != nil {
			return err
		}
		if !private.UUID.MatchString(c.Param("id")) || !private.UUID.MatchString(request.Epoch) || !private.UUID.MatchString(request.Operation) || request.Revision < 1 || request.Revision > maxRevision {
			return invalid(c)
		}
		if err := s.Purge(c.Request().Context(), c.Param("id"), request.Epoch, request.Operation, request.Revision); err != nil {
			return privateFailure(c, err)
		}
		return c.NoContent(204)
	}, authenticate)
	restoreAccess := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			initialized, err := s.Initialized(c.Request().Context())
			if err != nil {
				return privateFailure(c, err)
			}
			c.Set("fresh_restore", !initialized)
			if initialized {
				return authenticate(next)(c)
			}
			return next(c)
		}
	}
	binding := func(c echo.Context) string {
		if c.Get("fresh_restore") == true {
			return cookie(c, csrfCookie)
		}
		return cookie(c, sessionCookie)
	}
	e.POST("/api/restore/stage", func(c echo.Context) error {
		var request private.Stage
		if err := decodeLimit(c, &request, 96*1024*1024); err != nil {
			return err
		}
		if !private.ValidStage(request) {
			return invalid(c)
		}
		if err := s.StageRestore(c.Request().Context(), request, binding(c)); err != nil {
			return privateFailure(c, err)
		}
		return c.JSON(200, map[string]string{"stage_id": request.ID})
	}, restoreAccess)
	e.POST("/api/restore/commit", func(c echo.Context) error {
		var request struct {
			ID        string `json:"stage_id"`
			Password  string `json:"new_login_password"`
			UseGoogle bool   `json:"use_google"`
		}
		if err := decode(c, &request); err != nil {
			return err
		}
		if !private.UUID.MatchString(request.ID) {
			return invalid(c)
		}
		fresh := c.Get("fresh_restore") == true
		var proof *private.GoogleIdentity
		if request.UseGoogle {
			if !fresh {
				return invalid(c)
			}
			proof = googleProof(c, g)
			if proof == nil {
				return c.JSON(400, map[string]string{"error": "google_setup_expired", "message": "Sign in with Google again before restoring without a local login password."})
			}
		}
		if fresh {
			if (len(request.Password) < 12 || len(request.Password) > 1024) && proof == nil {
				return invalid(c)
			}
			if err := s.LoginAllowed(c.Request().Context()); err != nil {
				return privateFailure(c, err)
			}
		} else if request.Password != "" {
			return invalid(c)
		}
		var v private.Vault
		var err error
		if fresh && proof != nil {
			v, err = s.CommitRestoreGoogle(c.Request().Context(), request.ID, binding(c), *proof)
		} else {
			v, err = s.CommitRestore(c.Request().Context(), request.ID, binding(c), request.Password)
		}
		if err != nil {
			return privateFailure(c, err)
		}
		if fresh {
			if g != nil {
				g.ClearProof(cookie(c, googleProofCookie))
				setCookie(c, googleProofCookie, "", -1)
			}
			token, csrf, err := s.NewSession(c.Request().Context())
			if err != nil {
				return privateFailure(c, err)
			}
			setCookie(c, sessionCookie, token, 1800)
			setCookie(c, csrfCookie, csrf, 1800)
		}
		return c.JSON(200, v)
	}, restoreAccess)
	e.GET("/api/backup/history", func(c echo.Context) error {
		rows, err := s.Pool.Query(c.Request().Context(), `SELECT id::text,saved_at FROM restore_backups ORDER BY saved_at DESC,id DESC LIMIT 3`)
		if err != nil {
			return privateFailure(c, err)
		}
		defer rows.Close()
		history := []map[string]any{}
		for rows.Next() {
			var id string
			var at time.Time
			if err = rows.Scan(&id, &at); err != nil {
				return privateFailure(c, err)
			}
			history = append(history, map[string]any{"id": id, "saved_at": at})
		}
		if err = rows.Err(); err != nil {
			return privateFailure(c, err)
		}
		return c.JSON(200, map[string]any{"backups": history})
	}, authenticate)
	e.GET("/api/backup/history/:id", func(c echo.Context) error {
		if !private.UUID.MatchString(c.Param("id")) {
			return invalid(c)
		}
		var encoded []byte
		err := s.Pool.QueryRow(c.Request().Context(), `SELECT archive FROM restore_backups WHERE id=$1::uuid`, c.Param("id")).Scan(&encoded)
		if errors.Is(err, pgx.ErrNoRows) {
			return privateFailure(c, private.ErrNotFound)
		}
		if err != nil {
			return privateFailure(c, err)
		}
		return c.Blob(200, "application/json", encoded)
	}, authenticate)
	mountGoogle(e, s, g, authenticate)
	return e
}
