#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$PWD" != "$root" ]]; then
  printf 'Run this check from the backend repository root.\n' >&2
  exit 1
fi
GO="${GO:-go}"
"$GO" build ./...
"$GO" vet ./...
unformatted="$(gofmt -l internal cmd)"
if [[ -n "$unformatted" ]]; then
  printf 'Go files need formatting:\n%s\n' "$unformatted" >&2
  exit 1
fi
"$GO" mod verify
REQUIRE_DB_TESTS=1 "$GO" test -race -count=1 -timeout 900s ./...
