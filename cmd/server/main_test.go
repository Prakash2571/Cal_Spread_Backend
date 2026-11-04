package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
)

type processLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *processLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}
func (l *processLog) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

type runningServer struct {
	cmd  *exec.Cmd
	log  *processLog
	done chan error
	base string
}

func processEnvironment(dir string) []string {
	// The real binary gets neither operator credentials nor outbound access. All
	// configuration is loaded from this test's .env in its isolated directory.
	return []string{"HOME=" + dir, "TMPDIR=" + dir, "TZ=Asia/Kolkata",
		"HTTP_PROXY=http://127.0.0.1:9", "HTTPS_PROXY=http://127.0.0.1:9",
		"ALL_PROXY=http://127.0.0.1:9", "NO_PROXY=127.0.0.1,localhost"}
}

func startServer(t *testing.T, binary, database string) *runningServer {
	t.Helper()
	return startServerWithEnv(t, binary, database, "")
}

func startServerWithEnv(t *testing.T, binary, database, extraEnv string) *runningServer {
	t.Helper()
	dir := t.TempDir()
	env := "HOST=127.0.0.1\nPORT=0\nKITE_API_KEY=process-fixture-key\nKITE_API_SECRET=process-fixture-secret\n" +
		"ADMIN_SECRET=process-fixture-admin\nACCESS_SECRET=process-fixture-trade\nFRONTEND_URL=http://127.0.0.1:5173\n" +
		"DATABASE_URL=" + database + "\n" + extraEnv
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0600); err != nil {
		t.Fatal(err)
	}
	s := &runningServer{cmd: exec.Command(binary), log: &processLog{}, done: make(chan error, 1)}
	s.cmd.Dir, s.cmd.Env = dir, processEnvironment(dir)
	s.cmd.Stdout, s.cmd.Stderr = s.log, s.log
	if err := s.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { s.done <- s.cmd.Wait() }()
	t.Cleanup(func() { _ = s.cmd.Process.Kill() })
	listening := regexp.MustCompile(`listening on (http://127\.0\.0\.1:\d+)`)
	waitProcess(t, func() bool {
		if match := listening.FindStringSubmatch(s.log.text()); match != nil {
			s.base = match[1]
			return true
		}
		select {
		case err := <-s.done:
			t.Fatalf("server exited before listening: %v\n%s", err, s.log.text())
		default:
		}
		return false
	})
	return s
}

func waitProcess(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("standalone process did not reach the expected state")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (s *runningServer) request(t *testing.T, method, path, token, body string, status int) string {
	t.Helper()
	req, err := http.NewRequest(method, s.base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("x-admin-token", token)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != status {
		t.Fatalf("%s %s = %d, want %d: %s", method, path, resp.StatusCode, status, data)
	}
	return string(data)
}

func (s *runningServer) login(t *testing.T, path, secret string) string {
	t.Helper()
	body := s.request(t, "POST", path, "", `{"secret":"`+secret+`"}`, 200)
	var reply struct{ Token string }
	if err := json.Unmarshal([]byte(body), &reply); err != nil || reply.Token == "" {
		t.Fatalf("invalid fixture login response: %v", err)
	}
	return reply.Token
}

func (s *runningServer) stop(t *testing.T, signal syscall.Signal) {
	t.Helper()
	if err := s.cmd.Process.Signal(signal); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-s.done:
		if err != nil {
			t.Fatalf("shutdown failed: %v\n%s", err, s.log.text())
		}
	case <-time.After(20 * time.Second):
		t.Fatal("standalone process did not stop")
	}
	if !strings.Contains(s.log.text(), "8 ok, 0 failed") || strings.Contains(s.log.text(), "DATA RACE") {
		t.Fatalf("shutdown/race log: %s", s.log.text())
	}
}

func TestStandaloneServerLifecycleAndPostgresRestart(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "calspread")
	build := exec.Command("go", "build", "-race", "-trimpath", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build standalone server: %v\n%s", err, output)
	}
	t.Run("memory-only-and-SIGINT", func(t *testing.T) {
		s := startServer(t, binary, "")
		if got := s.request(t, "GET", "/", "", "", 200); got != `{"status":"ok","authenticated":false,"hint":"Visit /api/login to authenticate with Zerodha."}` {
			t.Fatalf("health response: %s", got)
		}
		if status := s.request(t, "GET", "/api/status", "", "", 200); !strings.Contains(status, `"broker":"dhan"`) {
			t.Fatalf("fresh standalone backend did not default to Dhan: %s", status)
		}
		s.request(t, "GET", "/api/box/status", "", "", 404)
		s.request(t, "GET", "/api/fair-value/status", "", "", 403)
		token := s.login(t, "/api/admin/verify", "process-fixture-admin")
		body := s.request(t, "GET", "/api/fair-value/status", token, "", 200)
		if !strings.Contains(body, `"storage":"memory_only"`) {
			t.Fatalf("memory-only storage status: %s", body)
		}
		trade := s.login(t, "/api/access/verify", "process-fixture-trade")
		s.request(t, "GET", "/api/fair-value/status", trade, "", 403)
		s.request(t, "POST", "/api/rf", trade, `{"rf":7.25}`, 403)
		s.stop(t, syscall.SIGINT)
	})
	t.Run("PostgreSQL-and-SIGTERM-restart", func(t *testing.T) {
		pool := dbtest.New(t)
		u, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
		if err != nil {
			t.Fatal(err)
		}
		query := u.Query()
		query.Set("search_path", pool.Config().ConnConfig.RuntimeParams["search_path"])
		u.RawQuery = query.Encode()
		s := startServer(t, binary, u.String())
		token := s.login(t, "/api/admin/verify", "process-fixture-admin")
		body := s.request(t, "GET", "/api/fair-value/status", token, "", 200)
		if !strings.Contains(body, `"storage":"postgres"`) {
			t.Fatalf("PostgreSQL storage status: %s", body)
		}
		s.request(t, "POST", "/api/rf", token, `{"rf":7.25}`, 200)
		s.stop(t, syscall.SIGTERM)
		var migrations, tables, sessions int
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := pool.QueryRow(ctx, "select count(*) from schema_migrations").Scan(&migrations); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, "select count(*) from information_schema.tables where table_schema=current_schema()").Scan(&tables); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, "select count(*) from admin_sessions where id=$1", token).Scan(&sessions); err != nil {
			t.Fatal(err)
		}
		if migrations != 6 || tables != 18 || sessions != 1 {
			t.Fatalf("persisted schema/session: migrations=%d tables=%d sessions=%d", migrations, tables, sessions)
		}
		restarted := startServer(t, binary, u.String())
		waitProcess(t, func() bool {
			return strings.Contains(restarted.request(t, "GET", "/api/admin/status", token, "", 200), `"role":"full"`)
		})
		waitProcess(t, func() bool {
			return restarted.request(t, "GET", "/api/rf/current", "", "", 200) == `{"rf":7.25}`
		})
		restarted.stop(t, syscall.SIGTERM)
	})
	t.Run("Dhan-token-and-saved-selection-restart", func(t *testing.T) {
		pool := dbtest.New(t)
		ctx := context.Background()
		expiry := time.Now().Add(time.Hour).UnixMilli()
		// Restore an inactive Dhan token while Zerodha is explicitly selected.
		// No real broker feed or REST call is needed by this standalone process.
		if _, err := pool.Exec(ctx, `insert into active_broker (id, broker, generation) values ('current', 'zerodha', 7)`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `insert into dhan_session (id, access_token, dhan_client_id, expiry_time, login_date, token_source)
			values ('current', 'process-fixture-dhan-token', '1100001', $1, '2026-11-04', 'BROKER_LOGIN')`, expiry); err != nil {
			t.Fatal(err)
		}
		u, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
		if err != nil {
			t.Fatal(err)
		}
		query := u.Query()
		query.Set("search_path", pool.Config().ConnConfig.RuntimeParams["search_path"])
		u.RawQuery = query.Encode()
		check := func(s *runningServer, token string) {
			var status struct {
				Active, Authenticated, Persisted bool
				Source                           string
				TokenExpiresAt                   int64 `json:"token_expires_at"`
			}
			waitProcess(t, func() bool {
				if !strings.Contains(s.request(t, "GET", "/api/admin/status", token, "", 200), `"role":"full"`) {
					return false
				}
				body := s.request(t, "GET", "/api/dhan/status", token, "", 200)
				if json.Unmarshal([]byte(body), &status) != nil || strings.Contains(body, "process-fixture-dhan-token") {
					t.Fatal("invalid or unredacted Dhan restart status")
				}
				return status.Authenticated
			})
			if status.Active || !status.Persisted || status.Source != "BROKER_LOGIN" || status.TokenExpiresAt != expiry {
				t.Fatal("persisted Dhan token/source/expiry did not restore independently of selection")
			}
			body := s.request(t, "GET", "/api/broker/status", token, "", 200)
			if !strings.Contains(body, `"broker":"zerodha"`) || !strings.Contains(body, `"generation":7`) {
				t.Fatal("saved broker selection/generation was replaced by the fresh-start default")
			}
		}
		first := startServerWithEnv(t, binary, u.String(), "DHAN_CLIENT_ID=1100001\n")
		token := first.login(t, "/api/admin/verify", "process-fixture-admin")
		check(first, token)
		first.stop(t, syscall.SIGTERM)
		restarted := startServerWithEnv(t, binary, u.String(), "DHAN_CLIENT_ID=1100001\n")
		check(restarted, token)
		restarted.stop(t, syscall.SIGTERM)
	})
	t.Run("missing-Kite-credentials", func(t *testing.T) {
		dir := t.TempDir()
		cmd := exec.Command(binary)
		cmd.Dir, cmd.Env = dir, processEnvironment(dir)
		output, err := cmd.CombinedOutput()
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 || !strings.Contains(string(output), "KITE_API_KEY and KITE_API_SECRET must be set") {
			t.Fatalf("missing credentials did not fail before listening: %v\n%s", err, output)
		}
	})
}
