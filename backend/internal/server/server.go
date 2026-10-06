package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/akashtiwari2/WebDairy/backend/internal/entries"
	"github.com/labstack/echo/v4"
)

const maxRequest = 2 * 1024 * 1024
const maxRevision = 9007199254740990

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// New serves the loopback-only synthetic development API. Authentication and
// browser-side encryption belong to Phase 2, before any personal diary use.
func New(checkDatabase func(context.Context) error, repository entries.Repository) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Response().Header().Set("Cache-Control", "no-store")
			c.Response().Header().Set("X-Content-Type-Options", "nosniff")
			switch c.Request().Host {
			case "127.0.0.1:8080", "127.0.0.1:4200", "localhost:8080", "localhost:4200":
			default:
				return c.JSON(http.StatusForbidden, map[string]string{"error": "local_origin_required"})
			}
			origin := c.Request().Header.Get("Origin")
			if origin != "" && origin != "http://"+c.Request().Host {
				return c.JSON(http.StatusForbidden, map[string]string{"error": "local_origin_required"})
			}
			if c.Request().Method != http.MethodGet && c.Request().Method != http.MethodHead {
				if origin == "" || c.Request().Header.Get("Sec-Fetch-Site") == "cross-site" {
					return c.JSON(http.StatusForbidden, map[string]string{"error": "local_origin_required"})
				}
			}
			ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
			defer cancel()
			c.SetRequest(c.Request().WithContext(ctx))
			return next(c)
		}
	})
	e.GET("/api/health", func(c echo.Context) error {
		c.Response().Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(c.Request().Context(), 2*time.Second)
		defer cancel()
		if err := checkDatabase(ctx); err != nil {
			return c.JSON(http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "database": "not-ready"})
		}
		return c.JSON(http.StatusOK, map[string]string{"status": "ok", "database": "ready", "stage": "phase1"})
	})
	e.GET("/api/entries", func(c echo.Context) error {
		dates, err := repository.Dates(c.Request().Context())
		if err != nil {
			return failure(c, err)
		}
		return c.JSON(http.StatusOK, map[string]any{"dates": dates})
	})
	e.GET("/api/entries/:date", func(c echo.Context) error {
		if !validDate(c.Param("date")) {
			return invalid(c)
		}
		entry, err := repository.Get(c.Request().Context(), c.Param("date"))
		if err != nil {
			return failure(c, err)
		}
		return c.JSON(http.StatusOK, entry)
	})
	e.PUT("/api/entries/:date", func(c echo.Context) error {
		date := c.Param("date")
		if !validDate(date) {
			return invalid(c)
		}
		var write entries.Write
		if err := decode(c, &write); err != nil {
			return err
		}
		if write.ExpectedRevision < 0 || write.ExpectedRevision > maxRevision || !uuid.MatchString(write.OperationID) || utf8.RuneCountInString(write.Title) > 200 || len(write.Body) > 1048576 || !utf8.ValidString(write.Title) || !utf8.ValidString(write.Body) || (strings.TrimSpace(write.Title) == "" && strings.TrimSpace(write.Body) == "") {
			return invalid(c)
		}
		entry, err := repository.Save(c.Request().Context(), date, write)
		if err != nil {
			return failure(c, err)
		}
		return c.JSON(http.StatusOK, entry)
	})
	e.DELETE("/api/entries/:date", func(c echo.Context) error {
		if !validDate(c.Param("date")) {
			return invalid(c)
		}
		var request struct {
			ExpectedRevision int64 `json:"expected_revision"`
		}
		if err := decode(c, &request); err != nil {
			return err
		}
		if request.ExpectedRevision < 1 || request.ExpectedRevision > maxRevision {
			return invalid(c)
		}
		if err := repository.Delete(c.Request().Context(), c.Param("date"), request.ExpectedRevision); err != nil {
			return failure(c, err)
		}
		return c.NoContent(http.StatusNoContent)
	})
	return e
}

func validDate(date string) bool {
	parsed, err := time.Parse("2006-01-02", date)
	return err == nil && parsed.Year() > 0 && parsed.Format("2006-01-02") == date
}

func invalid(c echo.Context) error {
	return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid_request"})
}

func decode(c echo.Context, target any) error {
	mediaType, _, err := mime.ParseMediaType(c.Request().Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid_request")
	}
	data, err := io.ReadAll(io.LimitReader(c.Request().Body, maxRequest+1))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid_request")
	}
	if len(data) > maxRequest {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "request_too_large")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid_request")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid_request")
	}
	return nil
}

func failure(c echo.Context, err error) error {
	var conflict *entries.Conflict
	switch {
	case errors.As(err, &conflict):
		return c.JSON(http.StatusConflict, map[string]any{"error": "revision_conflict", "current": conflict.Current})
	case errors.Is(err, entries.ErrNotFound):
		return c.JSON(http.StatusNotFound, map[string]string{"error": "entry_not_found"})
	default:
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "database_unavailable"})
	}
}
