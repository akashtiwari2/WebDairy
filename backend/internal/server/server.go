package server

import (
	"context"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
)

// New exposes readiness only. Diary APIs and authentication are later milestones.
func New(checkDatabase func(context.Context) error) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true
	e.GET("/api/health", func(c echo.Context) error {
		c.Response().Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(c.Request().Context(), 2*time.Second)
		defer cancel()
		if err := checkDatabase(ctx); err != nil {
			return c.JSON(http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "database": "not-ready"})
		}
		return c.JSON(http.StatusOK, map[string]string{"status": "ok", "database": "ready", "stage": "scaffold"})
	})
	return e
}
