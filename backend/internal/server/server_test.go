package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
			e := New(func(context.Context) error { return tc.failure })
			res := httptest.NewRecorder()
			e.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/health", nil))
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
