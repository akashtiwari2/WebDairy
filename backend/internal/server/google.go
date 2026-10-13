package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/akashtiwari2/WebDairy/backend/internal/cloud"
	"github.com/akashtiwari2/WebDairy/backend/internal/private"
	"github.com/labstack/echo/v4"
)

const googleProofCookie = "diary_google_setup"
const googleFlowCookie = "diary_google_flow"

func googleProof(c echo.Context, g *cloud.Google) *private.GoogleIdentity {
	if g == nil {
		return nil
	}
	identity, ok := g.Proof(cookie(c, googleProofCookie))
	if !ok {
		return nil
	}
	return &private.GoogleIdentity{Subject: identity.Subject, Email: identity.Email}
}
func googleFailure(c echo.Context, err error) error {
	return c.JSON(503, map[string]string{"error": "google_unavailable", "message": err.Error()})
}
func mountGoogle(e *echo.Echo, s *private.Store, g *cloud.Google, authenticate echo.MiddlewareFunc) {
	e.GET("/api/google/status", func(c echo.Context) error {
		r := map[string]any{"configured": g != nil && g.ClientID != "", "linked": false, "drive_connected": false, "setup_ready": false, "email": "", "flow_done": false, "flow_error": "", "offline_password_available": false}
		if g == nil {
			return c.JSON(200, r)
		}
		if proof := googleProof(c, g); proof != nil {
			r["setup_ready"] = true
			r["email"] = proof.Email
			r["drive_connected"] = g.Connected(proof.Subject)
		}
		if s.Authenticate(c.Request().Context(), cookie(c, sessionCookie), cookie(c, csrfCookie)) == nil {
			identity, err := s.GoogleIdentity(c.Request().Context())
			if err != nil {
				return privateFailure(c, err)
			}
			r["linked"] = identity.Subject != ""
			if identity.Subject != "" {
				has, err := s.HasPassword(c.Request().Context())
				if err != nil {
					return privateFailure(c, err)
				}
				r["offline_password_available"] = !has
			}
			r["email"] = identity.Email
			r["drive_connected"] = g.Connected(identity.Subject)
		}
		done, failure := g.Result(cookie(c, googleFlowCookie))
		r["flow_done"] = done
		r["flow_error"] = failure
		return c.JSON(200, r)
	})
	e.POST("/api/auth/offline-password", func(c echo.Context) error {
		identity, err := s.GoogleIdentity(c.Request().Context())
		if err != nil {
			return privateFailure(c, err)
		}
		if identity.Subject == "" {
			return invalid(c)
		}
		var request struct {
			Password string `json:"password"`
		}
		if err = decode(c, &request); err != nil {
			return err
		}
		if err = s.AddOfflinePassword(c.Request().Context(), request.Password); err != nil {
			return privateFailure(c, err)
		}
		return c.NoContent(204)
	}, authenticate)
	e.POST("/api/google/start", func(c echo.Context) error {
		if g == nil || g.ClientID == "" {
			return googleFailure(c, errors.New("Google connection has not been set up for this installation"))
		}
		if c.Request().Host != "127.0.0.1:4200" && c.Request().Host != "127.0.0.1:8080" {
			return googleFailure(c, errors.New("Open WebDairy at http://127.0.0.1:4200 (development) or http://127.0.0.1:8080 (desktop) before Google sign-in"))
		}
		var request struct {
			Purpose string `json:"purpose"`
		}
		if err := decode(c, &request); err != nil {
			return err
		}
		if request.Purpose != "login" && request.Purpose != "link" && request.Purpose != "drive" {
			return invalid(c)
		}
		initialized, err := s.Initialized(c.Request().Context())
		if err != nil {
			return privateFailure(c, err)
		}
		identity, err := s.GoogleIdentity(c.Request().Context())
		if err != nil {
			return privateFailure(c, err)
		}
		session, csrf := "", ""
		if s.Authenticate(c.Request().Context(), cookie(c, sessionCookie), cookie(c, csrfCookie)) == nil {
			session = cookie(c, sessionCookie)
			csrf = cookie(c, csrfCookie)
		}
		authenticated := s.Authenticate(c.Request().Context(), cookie(c, sessionCookie), cookie(c, csrfCookie)) == nil
		if request.Purpose == "link" {
			if !authenticated {
				return privateFailure(c, private.ErrUnauthenticated)
			}
			session = cookie(c, sessionCookie)
			csrf = cookie(c, csrfCookie)
		}
		if request.Purpose == "login" && initialized && identity.Subject == "" {
			return googleFailure(c, errors.New("Log in with your existing password, then link Google in Settings"))
		}
		if request.Purpose == "drive" {
			if initialized {
				if !authenticated || identity.Subject == "" {
					return privateFailure(c, private.ErrUnauthenticated)
				}
				session = cookie(c, sessionCookie)
				csrf = cookie(c, csrfCookie)
			} else {
				proof := googleProof(c, g)
				if proof == nil {
					return privateFailure(c, private.ErrUnauthenticated)
				}
				identity = *proof
			}
		}
		state, link, err := g.Start(request.Purpose, identity.Subject, session, csrf, "http://"+c.Request().Host)
		if err != nil {
			return googleFailure(c, err)
		}
		setCookie(c, googleFlowCookie, state, 600)
		return c.JSON(200, map[string]string{"url": link})
	})
	e.POST("/api/google/cancel", func(c echo.Context) error {
		if g != nil {
			g.Cancel(cookie(c, googleFlowCookie))
		}
		setCookie(c, googleFlowCookie, "", -1)
		return c.NoContent(204)
	})
	e.GET("/api/google/callback", func(c echo.Context) error {
		c.Response().Header().Set("Referrer-Policy", "no-referrer")
		if g == nil {
			return c.String(400, "Google is not configured.")
		}
		state := c.QueryParam("state")
		flow, err := g.Take(state)
		if err != nil {
			return c.String(400, "Sign-in expired or already used. Return to WebDairy and retry.")
		}
		identity, credentials, err := g.Exchange(c.Request().Context(), flow, c.QueryParam("code"))
		if g.Cancelled(state) {
			err = cloud.ErrOAuth
		}
		if c.QueryParam("error") != "" {
			err = cloud.ErrOAuth
		}
		if err == nil && flow.Session != "" {
			err = s.Authenticate(c.Request().Context(), flow.Session, flow.CSRF)
		}
		if err == nil {
			initialized, e := s.Initialized(c.Request().Context())
			err = e
			if err == nil && flow.Purpose == "link" {
				err = s.LinkGoogle(c.Request().Context(), identity.Subject, identity.Email)
			}
			if err == nil && flow.Purpose == "drive" && initialized {
				linked, e := s.GoogleIdentity(c.Request().Context())
				err = e
				if err == nil && linked.Subject != identity.Subject {
					err = cloud.ErrAccount
				}
			}
			if err == nil && flow.Purpose == "drive" {
				err = g.Save(identity.Subject, credentials)
			}
			if err == nil && flow.Purpose == "login" && initialized {
				linked, e := s.GoogleIdentity(c.Request().Context())
				err = e
				if err == nil && linked.Subject != identity.Subject {
					err = cloud.ErrOAuth
				}
				if err == nil {
					token, csrf, e := s.NewSession(c.Request().Context())
					err = e
					if err == nil && flow.Session != "" {
						err = s.Logout(c.Request().Context(), flow.Session)
					}
					if err == nil {
						setCookie(c, sessionCookie, token, 1800)
						setCookie(c, csrfCookie, csrf, 1800)
					}
				}
			}
			if err == nil && !initialized {
				setCookie(c, googleProofCookie, g.GrantProof(identity), 600)
			}
		}
		if err != nil {
			publicErr := cloud.ErrOAuth
			if errors.Is(err, cloud.ErrAccount) {
				publicErr = cloud.ErrAccount
			}
			if errors.Is(err, cloud.ErrKeyring) {
				publicErr = cloud.ErrKeyring
			}
			g.Finish(state, identity, publicErr)
			return c.String(400, "Google connection failed. Return to WebDairy and retry. Check your OAuth setup and OS keychain.")
		}
		g.Finish(state, identity, nil)
		return c.String(200, "Google connected. Close this tab and return to WebDairy. Google login does not unlock your encrypted diary.")
	})
	subject := func(c echo.Context) (string, error) {
		if g == nil {
			return "", cloud.ErrReconnect
		}
		initialized, err := s.Initialized(c.Request().Context())
		if err != nil {
			return "", err
		}
		if !initialized {
			p := googleProof(c, g)
			if p == nil {
				return "", private.ErrUnauthenticated
			}
			return p.Subject, nil
		}
		if err = s.Authenticate(c.Request().Context(), cookie(c, sessionCookie), cookie(c, csrfCookie)); err != nil {
			return "", err
		}
		identity, err := s.GoogleIdentity(c.Request().Context())
		if err != nil {
			return "", err
		}
		if identity.Subject == "" {
			return "", private.ErrUnauthenticated
		}
		return identity.Subject, nil
	}
	e.GET("/api/drive/backups", func(c echo.Context) error {
		sub, err := subject(c)
		if err != nil {
			return privateFailure(c, err)
		}
		files, err := g.List(c.Request().Context(), sub)
		if err != nil {
			return googleFailure(c, err)
		}
		return c.JSON(200, map[string]any{"backups": files})
	})
	e.GET("/api/drive/backups/:id", func(c echo.Context) error {
		sub, err := subject(c)
		if err != nil {
			return privateFailure(c, err)
		}
		data, err := g.Download(c.Request().Context(), sub, c.Param("id"), private.MaxArchive)
		if err != nil {
			return googleFailure(c, err)
		}
		var a private.Archive
		if json.Unmarshal(data, &a) != nil || !private.ValidArchive(&a) {
			return invalid(c)
		}
		return c.Blob(200, "application/json", data)
	})
	e.POST("/api/drive/upload", func(c echo.Context) error {
		sub, err := subject(c)
		if err != nil {
			return privateFailure(c, err)
		}
		var request struct {
			Operation  string          `json:"operation_id"`
			Archive    private.Archive `json:"archive"`
			SnapshotAt string          `json:"snapshot_at"`
			Keep       int             `json:"keep"`
		}
		if err = decodeLimit(c, &request, private.MaxArchive+32768); err != nil {
			return err
		}
		if !private.UUID.MatchString(request.Operation) || !private.ValidArchive(&request.Archive) || request.Keep < 3 || request.Keep > 100 {
			return invalid(c)
		}
		v, err := s.Vault(c.Request().Context())
		if err != nil {
			return privateFailure(c, err)
		}
		if v.Envelope.VaultID != request.Archive.VaultID {
			return invalid(c)
		}
		if at, e := time.Parse(time.RFC3339Nano, request.SnapshotAt); e != nil || at.After(time.Now().Add(time.Minute)) {
			return invalid(c)
		}
		data, _ := json.Marshal(request.Archive)
		file, err := g.Upload(c.Request().Context(), sub, request.Operation, request.Archive.VaultID, request.SnapshotAt, data)
		if err != nil {
			return googleFailure(c, err)
		}
		warning := ""
		if err = g.Prune(c.Request().Context(), sub, request.Archive.VaultID, request.Keep); err != nil {
			warning = "Upload verified; old backup cleanup failed. Existing backups were retained where possible."
		}
		return c.JSON(200, map[string]any{"backup": file, "warning": warning})
	}, authenticate)
	e.POST("/api/drive/disconnect", func(c echo.Context) error {
		sub, err := subject(c)
		if err != nil {
			return privateFailure(c, err)
		}
		if err = g.Disconnect(sub); err != nil {
			return googleFailure(c, err)
		}
		return c.NoContent(http.StatusNoContent)
	})
}
