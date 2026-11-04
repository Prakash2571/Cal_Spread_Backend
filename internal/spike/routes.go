package spike

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
)

func Mount(router chi.Router, engine *Engine, sessions *auth.Sessions) {
	admin := func(handler http.HandlerFunc) http.HandlerFunc { return sessions.RequireAdmin(handler).ServeHTTP }
	router.Get("/api/spike/status", admin(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.JSON(w, 200, engine.Snapshot())
	}))
	router.Get("/api/spike/series", admin(func(w http.ResponseWriter, r *http.Request) {
		symbol := strings.ToUpper(r.URL.Query().Get("symbol"))
		if symbol != "NIFTY" && symbol != "SENSEX" {
			httpx.Error(w, 400, "symbol must be NIFTY or SENSEX")
			return
		}
		frame := r.URL.Query().Get("frame")
		minutes := map[string]int64{"1m": 1, "5m": 5, "30m": 30, "1h": 60}[frame]
		if minutes == 0 {
			httpx.Error(w, 400, "frame must be 1m, 5m, 30m or 1h")
			return
		}
		httpx.JSON(w, 200, struct {
			Symbol string `json:"symbol"`
			Frame  string `json:"frame"`
			Points []Bar  `json:"points"`
		}{symbol, frame, engine.Series(symbol, minutes)})
	}))
	router.Post("/api/spike/paper", admin(func(w http.ResponseWriter, r *http.Request) {
		enabled, ok := httpx.BodyObject(r)["enabled"].(bool)
		if !ok {
			httpx.Error(w, 400, "enabled must be boolean")
			return
		}
		if err := engine.SetPaper(r.Context(), enabled); err != nil {
			httpx.Error(w, 503, err.Error())
			return
		}
		httpx.JSON(w, 200, engine.Snapshot())
	}))
	router.Post("/api/spike/trades/{id}/close", admin(func(w http.ResponseWriter, r *http.Request) {
		kind, id := db.CheckID(chi.URLParam(r, "id"))
		if kind != db.IDValid {
			httpx.Error(w, 400, "Invalid paper trade id")
			return
		}
		trade, err := engine.Close(r.Context(), id)
		if err != nil {
			httpx.Error(w, 409, err.Error())
			return
		}
		httpx.JSON(w, 200, trade)
	}))
	router.Get("/api/spike/stream", func(w http.ResponseWriter, r *http.Request) {
		token := httpx.AdminToken(r)
		if token == "" {
			token = r.URL.Query().Get("x-admin-token")
		}
		if sessions.Role(token) == auth.RoleNone {
			httpx.Error(w, 403, "Admin authentication required")
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			httpx.Error(w, 500, "Streaming is unavailable")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Accel-Buffering", "no")
		updates, release := engine.Subscribe()
		defer release()
		timer := time.NewTicker(15 * time.Second)
		defer timer.Stop()
		controller := http.NewResponseController(w)
		for {
			select {
			case <-r.Context().Done():
				return
			case <-timer.C:
				if sessions.Role(token) == auth.RoleNone {
					return
				}
				_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
					return
				}
				flusher.Flush()
			case update, live := <-updates:
				if !live || sessions.Role(token) == auth.RoleNone {
					return
				}
				raw, err := json.Marshal(update)
				if err != nil {
					return
				}
				_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if _, err = fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", raw); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	})
}
