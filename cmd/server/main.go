// Command server is the Cal_Spread backend: the Go port of src/index.ts's process shell.
// It loads .env (dotenv/config), reads the configuration from the environment (the same
// variable names), listens on PORT (default 3001) on every interface, runs the boot
// chain while serving, and on SIGINT/SIGTERM runs the graceful shutdown
// (SHUTDOWN_TIMEOUT_MS, default 12 s) and exits 0, or 1 when it timed out.
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/app"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
)

func main() {
	// `import "dotenv/config"`: before anything reads the environment.
	if _, err := app.LoadDotenv(); err != nil {
		log.Printf("[FATAL] %v", err)
		os.Exit(1)
	}
	cfg := config.Load(config.OS)

	a, err := app.New(cfg, app.Options{})
	if err != nil {
		// Node threw at module load (e.g. the KiteClient constructor without credentials)
		// and exited before listening.
		log.Printf("[FATAL] %v", err)
		os.Exit(1)
	}

	// app.listen(PORT): all interfaces, plain HTTP.
	l, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		log.Printf("[FATAL] listen: %v", err)
		os.Exit(1)
	}
	log.Printf("Cal_Spread backend listening on http://%s", l.Addr())

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		if err := a.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[FATAL] serve: %v", err)
			os.Exit(1)
		}
	}()
	go a.Start(context.Background())

	// Every signal runs (or, while one is running, waits for) the same shutdown; the
	// process exits with its result, as process.exit(shutdownExitCode(result)) did.
	for sig := range signals {
		name := "SIGTERM"
		if sig == syscall.SIGINT {
			name = "SIGINT"
		}
		go func() {
			res := a.Shutdown(context.Background(), name)
			os.Exit(res.ExitCode())
		}()
	}
}
