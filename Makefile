GO ?= go
LOCAL_PG_PORT ?= 55472
TEST_DATABASE_URL ?= postgres://calspread@127.0.0.1:$(LOCAL_PG_PORT)/calspread_test?sslmode=disable

.PHONY: build run check test db-start db-stop db-status

build:
	@mkdir -p outputs
	$(GO) build -trimpath -o outputs/calspread ./cmd/server

run:
	$(GO) run ./cmd/server

check:
	TEST_DATABASE_URL="$(TEST_DATABASE_URL)" GO="$(GO)" bash scripts/check.sh

test:
	TEST_DATABASE_URL="$(TEST_DATABASE_URL)" REQUIRE_DB_TESTS=1 $(GO) test -race -count=1 -timeout 900s ./...

db-start:
	LOCAL_PG_PORT="$(LOCAL_PG_PORT)" bash scripts/local-db.sh start

db-stop:
	LOCAL_PG_PORT="$(LOCAL_PG_PORT)" bash scripts/local-db.sh stop

db-status:
	LOCAL_PG_PORT="$(LOCAL_PG_PORT)" bash scripts/local-db.sh status
