package desktop

import (
	"embed"
	"encoding/json"
	"github.com/labstack/echo/v4"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os/exec"
	"path"
	"runtime"
	"strings"
	"time"
)

//go:embed assets/* migrations/*
var resources embed.FS

func Migrations() fs.FS { f, _ := fs.Sub(resources, "migrations"); return f }
func Ready() bool       { _, err := resources.ReadFile("assets/index.html"); return err == nil }
func Mount(e *echo.Echo) {
	e.GET("/api/desktop", func(c echo.Context) error { return c.JSON(200, map[string]bool{"desktop": true}) })
	handler := func(c echo.Context) error {
		if strings.HasPrefix(c.Request().URL.Path, "/api/") {
			return c.NoContent(404)
		}
		if !Ready() {
			return c.String(503, "Desktop assets are not built. Run node scripts/package.mjs or use npm start in frontend.")
		}
		name := strings.TrimPrefix(path.Clean("/"+c.Param("*")), "/")
		if name == "" {
			name = "index.html"
		}
		data, err := resources.ReadFile("assets/" + name)
		if err != nil {
			if strings.Contains(path.Base(name), ".") {
				return c.NoContent(404)
			}
			name = "index.html"
			data, _ = resources.ReadFile("assets/index.html")
		}
		c.Response().Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		c.Response().Header().Set("Referrer-Policy", "no-referrer")
		content := mime.TypeByExtension(path.Ext(name))
		if content == "" {
			content = "application/octet-stream"
		}
		return c.Blob(http.StatusOK, content, data)
	}
	e.GET("/", handler)
	e.GET("/*", handler)
}
func Existing() bool {
	client := http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get("http://127.0.0.1:8080/api/desktop")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var status struct {
		Desktop bool `json:"desktop"`
	}
	return response.StatusCode == 200 && json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&status) == nil && status.Desktop
}
func OpenBrowser(url string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		command = exec.Command("open", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	if err := command.Start(); err != nil {
		return err
	}
	go command.Wait()
	return nil
}
