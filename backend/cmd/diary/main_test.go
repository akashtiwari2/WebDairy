package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadEnvironment(t *testing.T) {
	t.Run("loads quoted Windows line endings and keeps existing process values", func(t *testing.T) {
		previous, existed := os.LookupEnv("DATABASE_URL")
		t.Cleanup(func() {
			if existed {
				os.Setenv("DATABASE_URL", previous)
			} else {
				os.Unsetenv("DATABASE_URL")
			}
		})
		os.Unsetenv("DATABASE_URL")
		path := filepath.Join(t.TempDir(), ".env")
		want := "postgres://synthetic:encoded%40password@127.0.0.1:5432/synthetic_db?sslmode=disable"
		if err := os.WriteFile(path, []byte("# Windows file\r\nDATABASE_URL='"+want+"'\r\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := loadEnvironment(path, true); err != nil {
			t.Fatal(err)
		}
		if os.Getenv("DATABASE_URL") != want {
			t.Fatal("dotenv connection did not load")
		}
		t.Setenv("DATABASE_URL", "synthetic-process-override")
		if err := loadEnvironment(path, true); err != nil {
			t.Fatal(err)
		}
		if os.Getenv("DATABASE_URL") != "synthetic-process-override" {
			t.Fatal("dotenv replaced process configuration")
		}
	})
	t.Run("optional missing file and required missing file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "missing.env")
		if err := loadEnvironment(path, false); err != nil {
			t.Fatal(err)
		}
		if err := loadEnvironment(path, true); err == nil {
			t.Fatal("explicit missing config accepted")
		}
	})
	t.Run("malformed configuration does not expose credentials", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), ".env")
		secret := "SYNTHETIC_SECRET_NOT_FOR_LOGS"
		if err := os.WriteFile(path, []byte("DATABASE_URL=\""+secret), 0600); err != nil {
			t.Fatal(err)
		}
		err := loadEnvironment(path, true)
		if err == nil {
			t.Fatal("invalid dotenv accepted")
		}
		if strings.Contains(err.Error(), secret) {
			t.Fatal("credential echoed in error")
		}
	})
}
