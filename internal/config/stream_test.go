package config

import (
	"crypto/rand"
	"encoding/hex"
	"testing"
)

func TestStreamSecretLoadedOnce(t *testing.T) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal("could not generate test credential")
	}
	secret := hex.EncodeToString(raw[:])
	env := map[string]string{"CALSPREAD_STREAM_SECRET": " \t" + secret + "\n"}
	reads := 0
	cfg := Load(func(key string) string {
		if key == "CALSPREAD_STREAM_SECRET" {
			reads++
		}
		return env[key]
	})
	if cfg.StreamSecret != secret || reads != 1 {
		t.Fatal("stream credential was not trimmed and captured once")
	}
	env["CALSPREAD_STREAM_SECRET"] = ""
	if cfg.StreamSecret != secret || reads != 1 {
		t.Fatal("startup credential changed without reloading config")
	}
}
