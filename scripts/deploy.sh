#!/usr/bin/env bash
# Build and update the existing calspread.online VM deployment.
set -Eeuo pipefail

backend_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
frontend_dir="${CALSPREAD_FRONTEND_DIR:-$(dirname -- "$backend_dir")/Cal_Spread}"
site_origin='https://calspread.online'
production_env='/etc/calspread/calspread.env'
binary='/opt/calspread/bin/calspread'
webroot='/var/www/calspread'
stage=''
backend_changed=0
frontend_changed=0

log() { printf '\n[deploy] %s\n' "$*"; }
fail() { printf '\n[deploy] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() {
    local result=$?
    trap - EXIT INT TERM
    if (( result != 0 )); then
        if (( backend_changed )); then
            log 'Restoring the previous backend after deployment failure.'
            if ! { sudo -n install -m 0755 "$stage/previous-backend" "$binary.rollback" &&
                   sudo -n mv -f "$binary.rollback" "$binary" &&
                   sudo -n systemctl restart calspread; }; then
                printf '[deploy] ERROR: backend rollback failed; inspect systemctl status calspread.\n' >&2
            fi
        fi
        if (( frontend_changed )); then
            log 'Restoring the previous frontend entry page.'
            if ! { sudo -n install -m 0644 "$stage/previous-index.html" "$webroot/.index.rollback" &&
                   sudo -n mv -f "$webroot/.index.rollback" "$webroot/index.html"; }; then
                printf '[deploy] ERROR: frontend entry page rollback failed.\n' >&2
            fi
        fi
    fi
    if [[ -n "$stage" && -d "$stage" ]]; then rm -rf -- "$stage"; fi
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ $(id -un) == calspread ]] || fail 'Run this script as calspread; it uses sudo for service operations.'
for tool in go npm python3 psql curl sudo flock tar; do
    command -v "$tool" >/dev/null || fail "Required command is missing: $tool"
done
[[ -f "$frontend_dir/package-lock.json" ]] || fail "Frontend checkout not found: $frontend_dir"
[[ -x "$binary" && -f "$webroot/index.html" ]] || fail 'Initial VM deployment is missing; see deploy/README.md.'
# This VM permits passwordless commands; sudo -v can still demand a password.
sudo -n true 2>/dev/null || sudo -v
sudo -n test -r "$production_env" || fail "Production configuration is missing: $production_env"
mkdir -p "$backend_dir/scratch"
exec 9>"$backend_dir/scratch/deploy.lock"
flock -n 9 || fail 'Another deployment is already running.'
stage="$(mktemp -d "$backend_dir/scratch/deploy.XXXXXX")"

log '1/6 Building the Go backend.'
(cd "$backend_dir" && go build -trimpath -o "$stage/calspread" ./cmd/server)

log '2/6 Starting PostgreSQL and checking the production database connection.'
sudo -n systemctl start postgresql
sudo -n -u calspread python3 - "$production_env" <<'PY'
import os, re, subprocess, sys, time
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit
text = Path(sys.argv[1]).read_text()
values = re.findall(r'^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$', text, re.M)
if len(values) != 1:
    sys.exit('Expected exactly one DATABASE_URL in the production environment.')
url = values[0]
if url[:1] in ('"', "'") and url[-1:] == url[:1]:
    url = url[1:-1]
if not url:
    sys.exit('DATABASE_URL is empty; deployment stopped.')
# libpq does not expand a URI supplied through PGDATABASE. Pass its individual
# connection fields through the environment, keeping credentials out of argv.
parsed = urlsplit(url)
if parsed.scheme not in ('postgres', 'postgresql'):
    sys.exit('DATABASE_URL must be a PostgreSQL URI.')
fields = {'dbname': unquote(parsed.path.lstrip('/'))}
if parsed.hostname is not None:
    fields['host'] = parsed.hostname
if parsed.port is not None:
    fields['port'] = str(parsed.port)
if parsed.username is not None:
    fields['user'] = unquote(parsed.username)
if parsed.password is not None:
    fields['password'] = unquote(parsed.password)
fields.update(parse_qsl(parsed.query, keep_blank_values=True))
names = {
    'host': 'PGHOST', 'hostaddr': 'PGHOSTADDR', 'port': 'PGPORT',
    'dbname': 'PGDATABASE', 'user': 'PGUSER', 'password': 'PGPASSWORD',
    'sslmode': 'PGSSLMODE', 'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY',
    'sslrootcert': 'PGSSLROOTCERT', 'sslcrl': 'PGSSLCRL',
    'connect_timeout': 'PGCONNECT_TIMEOUT', 'options': 'PGOPTIONS',
    'application_name': 'PGAPPNAME', 'target_session_attrs': 'PGTARGETSESSIONATTRS',
    'channel_binding': 'PGCHANNELBINDING', 'service': 'PGSERVICE',
}
if fields.keys() - names.keys():
    sys.exit('DATABASE_URL includes a parameter unsupported by the deployment preflight.')
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env.update({names[k]: v for k, v in fields.items()})
env['PGCONNECT_TIMEOUT'] = '5'
for attempt in range(5):
    check = subprocess.run(['psql', '--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1',
                            '--tuples-only', '--no-align', '--command=SELECT 1'],
                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if check.returncode == 0:
        print('Production PostgreSQL connection: OK')
        break
    if attempt == 4:
        sys.exit('Cannot connect to production PostgreSQL; check DATABASE_URL and database permissions. No app files changed.')
    time.sleep(1)
PY

log '3/6 Installing locked frontend dependencies and building the production UI.'
(cd "$frontend_dir" && npm ci --no-audit --no-fund &&
    VITE_API_BASE_URL="$site_origin" npm run build)
python3 - "$frontend_dir/dist" "$site_origin" <<'PY'
import re, sys
from pathlib import Path
root = Path(sys.argv[1])
html = (root / 'index.html').read_text()
entry = re.search(r'src="(/assets/[^\"]+\.js)"', html)
if not entry or sys.argv[2] not in (root / entry[1].lstrip('/')).read_text():
    sys.exit('Frontend build is missing the production API origin; deployment stopped.')
print('Frontend production API origin: OK')
PY

log '4/6 Checking Nginx before activating the build.'
sudo -n nginx -t
cp -- "$binary" "$stage/previous-backend"
cp -- "$webroot/index.html" "$stage/previous-index.html"

log '5/6 Installing the backend, restarting systemd, and checking database initialization.'
sudo -n install -m 0755 "$stage/calspread" "$binary.next"
backend_changed=1
sudo -n mv -f "$binary.next" "$binary"
sudo -n systemctl restart calspread
ready=0
for (( attempt=0; attempt<30; attempt++ )); do
    if sudo -n systemctl is-active --quiet calspread &&
       curl --fail --silent --max-time 2 http://127.0.0.1:3001/ >"$stage/health.json"; then
        ready=1
        break
    fi
    sleep 1
done
(( ready )) || fail 'Backend did not become healthy; restoring the previous version.'
python3 - "$stage/health.json" <<'PY'
import json, sys
if json.load(open(sys.argv[1])).get('status') != 'ok':
    sys.exit('Backend health response is invalid.')
PY
invocation="$(sudo -n systemctl show calspread -p InvocationID --value)"
sudo -n journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$invocation" >"$stage/startup.log"
if ! python3 - "$stage/startup.log" <<'PY'
from pathlib import Path
import sys
sys.exit(0 if 'Connected to PostgreSQL.' in Path(sys.argv[1]).read_text() else 1)
PY
then
    fail 'The backend did not initialize PostgreSQL persistence; inspect journalctl -u calspread.'
fi

log '6/6 Publishing frontend assets, reloading Nginx, and checking HTTPS.'
# Keep older hashed assets for browsers holding a previous page. Publish index last.
tar -C "$frontend_dir/dist" --exclude='./index.html' -cf - . |
    sudo -n tar --no-same-owner -C "$webroot" -xf -
sudo -n chown -R root:root "$webroot"
sudo -n find "$webroot" -type d -exec chmod 0755 {} +
sudo -n find "$webroot" -type f -exec chmod 0644 {} +
sudo -n install -m 0644 "$frontend_dir/dist/index.html" "$webroot/.index.next"
frontend_changed=1
sudo -n mv -f "$webroot/.index.next" "$webroot/index.html"
sudo -n nginx -t
sudo -n systemctl reload nginx
python3 - "$site_origin" "$frontend_dir/dist/index.html" <<'PY'
import json, re, sys, urllib.request
from pathlib import Path
base = sys.argv[1]
with urllib.request.urlopen(base + '/', timeout=15) as response:
    html = response.read().decode()
    if response.status != 200 or html != Path(sys.argv[2]).read_text():
        sys.exit('HTTPS is not serving the newly built frontend.')
entry = re.search(r'src="(/assets/[^\"]+\.js)"', html)
with urllib.request.urlopen(base + entry[1], timeout=15) as response:
    if base not in response.read().decode():
        sys.exit('Published JavaScript has the wrong API origin.')
with urllib.request.urlopen(base + '/api/admin/status', timeout=15) as response:
    if response.status != 200 or 'authenticated' not in json.load(response):
        sys.exit('Public API verification failed.')
print('HTTPS frontend, production JavaScript, and API proxy: OK')
PY
sudo -n systemctl is-active --quiet calspread
sudo -n systemctl is-active --quiet nginx
backend_changed=0
frontend_changed=0
log "Deployment complete: $site_origin"
