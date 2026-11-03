package brokerlogin

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"
)

func decodeSeed(seed string) ([]byte, error) {
	seed = strings.TrimRight(strings.ToUpper(strings.TrimSpace(seed)), "=")
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(seed)
	if err != nil || len(key) < 10 {
		return nil, errors.New("DHAN_TOKEN_API_SEED must be the base32 token API seed from env_home (at least 80 bits).")
	}
	return key, nil
}

// CodeAt is RFC 6238, SHA-1, six digits and a 30-second step. This seed belongs
// to env_home's token API, not to the Dhan account's own login.
func CodeAt(seed string, at time.Time) (string, error) {
	key, err := decodeSeed(seed)
	if err != nil {
		return "", err
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(at.Unix()/30))
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(counter[:])
	digest := mac.Sum(nil)
	offset := digest[len(digest)-1] & 15
	code := binary.BigEndian.Uint32(digest[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", code%1_000_000), nil
}
