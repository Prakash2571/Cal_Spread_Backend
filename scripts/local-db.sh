#!/usr/bin/env bash
# A repository-owned local PostgreSQL cluster; no system service or data reset.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="$root/scratch/local-postgres"
data="$base/data"
socket="$base/socket"
port="${LOCAL_PG_PORT:-55472}"
if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
  printf 'LOCAL_PG_PORT must be an integer from 1 to 65535.\n' >&2
  exit 1
fi
for tool in pg_ctl pg_isready psql; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '%s is required on PATH; see README.md.\n' "$tool" >&2
    exit 1
  fi
done
urls() {
  printf 'DATABASE_URL=postgres://calspread@127.0.0.1:%s/calspread?sslmode=disable\n' "$port"
  printf 'TEST_DATABASE_URL=postgres://calspread@127.0.0.1:%s/calspread_test?sslmode=disable\n' "$port"
}
case "${1:-status}" in
  start)
    command -v initdb >/dev/null
    command -v createdb >/dev/null
    mkdir -p "$base" "$socket"
    if [[ ! -f "$data/PG_VERSION" ]]; then
      if [[ -e "$data" ]]; then
        printf 'Existing uninitialized directory left intact: %s\n' "$data" >&2
        exit 1
      fi
      initdb -D "$data" -U calspread -A trust --encoding=UTF8 --locale=C
    fi
    if ! pg_ctl -D "$data" status >/dev/null 2>&1; then
      pg_ctl -D "$data" -l "$base/postgres.log" -o "-h 127.0.0.1 -p $port -k \"$socket\"" -w start
    fi
    pg_isready -h 127.0.0.1 -p "$port" -U calspread -d postgres
    for database in calspread calspread_test; do
      exists="$(psql -h 127.0.0.1 -p "$port" -U calspread -d postgres -At -v ON_ERROR_STOP=1 -c "select 1 from pg_database where datname='$database'")"
      if [[ "$exists" != 1 ]]; then
        createdb -h 127.0.0.1 -p "$port" -U calspread "$database"
      fi
    done
    urls
    ;;
  stop)
    if [[ -f "$data/PG_VERSION" ]] && pg_ctl -D "$data" status >/dev/null 2>&1; then
      pg_ctl -D "$data" -m fast -w stop
    else
      printf 'The repository-owned PostgreSQL cluster is already stopped.\n'
    fi
    ;;
  status)
    pg_ctl -D "$data" status
    pg_isready -h 127.0.0.1 -p "$port" -U calspread -d postgres
    ;;
  url) urls ;;
  *) printf 'Usage: bash scripts/local-db.sh start|stop|status|url\n' >&2; exit 1 ;;
esac
