package brokers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestFeedHealthMatchesNode(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "feedhealth_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Input struct {
				Connected     bool   `json:"connected"`
				Connecting    bool   `json:"connecting"`
				Authenticated bool   `json:"authenticated"`
				Subscribed    int    `json:"subscribed"`
				Universe      *int   `json:"universe"`
				LastTickAt    *int64 `json:"lastTickAt"`
				StaleAfterMs  int64  `json:"staleAfterMs"`
				Now           int64  `json:"now"`
			} `json:"input"`
			Expected json.RawMessage `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 1000 {
		t.Fatalf("only %d reference cases", len(f.Cases))
	}
	states := map[FeedState]int{}
	for i, c := range f.Cases {
		in := c.Input
		got := ComputeFeedHealth(FeedHealthInput{
			Connected: in.Connected, Connecting: in.Connecting, Authenticated: in.Authenticated,
			Subscribed: in.Subscribed, Universe: in.Universe, LastTickAt: in.LastTickAt,
			StaleAfterMs: in.StaleAfterMs, NowMs: in.Now,
		})
		states[got.State]++
		b, _ := json.Marshal(got)
		// Compare as JSON text: this also pins key order and null-versus-number.
		if string(b) != string(c.Expected) {
			t.Fatalf("case %d (%+v):\n got  %s\n want %s", i, in, b, c.Expected)
		}
	}
	for _, s := range []FeedState{FeedDown, FeedConnecting, FeedConnectedNoSubscription, FeedLive, FeedStale} {
		if states[s] == 0 {
			t.Errorf("reference set never produced state %s", s)
		}
	}
}

func TestIsUsableOnlyWhenLive(t *testing.T) {
	for s, want := range map[FeedState]bool{FeedLive: true, FeedStale: false, FeedDown: false, FeedConnecting: false, FeedConnectedNoSubscription: false} {
		if (FeedHealth{State: s}).IsUsable() != want {
			t.Errorf("%s", s)
		}
	}
}
