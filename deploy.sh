#!/bin/bash
set -euo pipefail

# =============================================================================
#  Calspread full deploy — Mumbai EC2 production
# =============================================================================
#
# ARCHITECTURE THIS SCRIPT ASSUMES
#
#   Backend   ~/Cal_Spread_Backend   port 3001, managed by PM2 as "backend".
#                                    Nginx proxies /api/* and /api/stream to
#                                    127.0.0.1:3001. Port 3001 stays PRIVATE.
#   Frontend  ~/Cal_Spread           Vite build -> ~/Cal_Spread/dist, served
#                                    DIRECTLY by Nginx. No PM2 process, no
#                                    `vite preview`, no port 4173.
#   Domain    https://calspread.online
#
# TWO DELIBERATE SAFETY PROPERTIES
#
#   1. The running backend is NEVER stopped up front. The pull, dependency
#      install and TypeScript build all happen while the old process keeps
#      serving traffic; PM2 only restarts AFTER the build succeeds. So a broken
#      commit or a failed install leaves production up, not down.
#   2. `set -euo pipefail` means any failure aborts immediately. Combined with
#      (1), an aborted deploy is a no-op against the live service rather than a
#      half-applied one.
#
# THIS SCRIPT DOES NOT TOUCH: .env files, secrets, broker credentials, AWS
# config, security groups, Certbot certificates, Nginx routing, or application
# logic. It only pulls, installs, builds, restarts the backend, and reloads Nginx.
# =============================================================================

BACKEND_DIR="$HOME/Cal_Spread_Backend"
FRONTEND_DIR="$HOME/Cal_Spread"
PM2_BACKEND_NAME="backend"
SITE_URL="https://calspread.online"

TOTAL_STEPS=7

log_step() {
  echo "[$1/$TOTAL_STEPS] $2"
}

# On any failure, say plainly what state production is in.
on_error() {
  local code=$?
  echo "" >&2
  echo "=========================================" >&2
  echo "  DEPLOY FAILED (exit $code)" >&2
  echo "=========================================" >&2
  echo "  Nothing was stopped by this script, so the previously running" >&2
  echo "  backend should still be serving traffic. Check: pm2 status" >&2
  exit "$code"
}
trap on_error ERR

# Enter a directory or fail loudly (clearer than a bare `cd` under set -e).
enter_dir() {
  if [ ! -d "$1" ]; then
    echo "ERROR: expected directory does not exist: $1" >&2
    return 1
  fi
  cd "$1"
}

# `tsconfig.tsbuildinfo` and friends are build artifacts. They are gitignored in
# both repos today, so this is normally a no-op — but if a past commit ever
# tracked one, a dirty copy would block `git pull`, so restore it when tracked.
# Untracked artifacts are left alone (they never block a pull).
restore_build_artifact() {
  local f="$1"
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    if ! git diff --quiet -- "$f"; then
      echo "  restoring tracked build artifact: $f"
      git restore -- "$f" 2>/dev/null || git checkout -- "$f"
    fi
  fi
}

# Reproducible installs: `npm ci` whenever a lockfile exists, and `npm install`
# ONLY when there is none. There is deliberately no silent `npm ci || npm install`
# fallback — that would let a desynced lockfile ship un-pinned dependency
# versions to production without anyone noticing.
install_deps() {
  local label="$1"
  if [ -f package-lock.json ]; then
    echo "  package-lock.json present -> npm ci (reproducible install)"
    if ! npm ci; then
      echo "" >&2
      echo "ERROR: 'npm ci' failed for the $label." >&2
      echo "" >&2
      echo "  The usual cause is package.json and package-lock.json being out of" >&2
      echo "  sync; npm ci refuses to guess." >&2
      echo "" >&2
      echo "  FIX (run in a DEV checkout, not on this production box), then" >&2
      echo "  commit the regenerated lockfile and re-run this deploy:" >&2
      echo "" >&2
      echo "    rm -rf node_modules package-lock.json" >&2
      echo "    npm install" >&2
      echo "    rm -rf node_modules && npm ci   # prove it is reproducible" >&2
      echo "    git add package-lock.json && git commit -m 'chore: regenerate lockfile'" >&2
      echo "" >&2
      return 1
    fi
  else
    echo "  no package-lock.json -> npm install"
    npm install
  fi
}

echo "========================================="
echo "  Calspread Full Deploy"
echo "========================================="
echo ""

# ---------------------------------------------------------------- backend ----
# NOTE: the backend is intentionally left RUNNING through steps 1-3.

log_step 1 "Pulling backend..."
enter_dir "$BACKEND_DIR"
restore_build_artifact tsconfig.tsbuildinfo
echo "  before: $(git rev-parse --short HEAD)"
git pull origin main
echo "  after:  $(git rev-parse --short HEAD)"
echo ""

log_step 2 "Installing backend dependencies..."
install_deps "backend"
echo ""

log_step 3 "Building backend..."
npm run build
if [ ! -f dist/index.js ]; then
  echo "ERROR: backend build produced no dist/index.js — refusing to restart PM2." >&2
  exit 1
fi
echo "  build OK -> dist/index.js"
echo ""

# Only now, with a verified build on disk, is it safe to cycle the process.
log_step 4 "Restarting backend (build succeeded)..."
if pm2 describe "$PM2_BACKEND_NAME" >/dev/null 2>&1; then
  echo "  PM2 process '$PM2_BACKEND_NAME' exists -> restart"
  pm2 restart "$PM2_BACKEND_NAME"
else
  # First-ever boot on this box. Take the production start command from
  # package.json rather than assuming one.
  start_script="$(node -p "require('./package.json').scripts?.start ?? ''" 2>/dev/null || echo '')"
  if [ -z "$start_script" ]; then
    echo "ERROR: no \"start\" script in $BACKEND_DIR/package.json; cannot create" >&2
    echo "       the PM2 process without a known production start command." >&2
    exit 1
  fi
  echo "  no PM2 process '$PM2_BACKEND_NAME' yet"
  echo "  package.json start script: $start_script"
  echo "  creating PM2 process via 'npm start'"
  pm2 start npm --name "$PM2_BACKEND_NAME" --cwd "$BACKEND_DIR" -- start
fi
pm2 save
echo ""

# --------------------------------------------------------------- frontend ----
# Build artifacts only. Nginx serves ~/Cal_Spread/dist directly, so there is no
# frontend process to manage: no PM2 entry, no `vite preview`, no port 4173.

log_step 5 "Pulling frontend..."
enter_dir "$FRONTEND_DIR"
restore_build_artifact tsconfig.tsbuildinfo
echo "  before: $(git rev-parse --short HEAD)"
git pull origin main
echo "  after:  $(git rev-parse --short HEAD)"
echo ""

log_step 6 "Installing & building frontend..."
# package-lock.json is deliberately NOT deleted here — it is what makes the
# production install reproducible.
install_deps "frontend"
npm run build
if [ ! -f dist/index.html ]; then
  echo "ERROR: frontend build produced no dist/index.html — Nginx would serve a" >&2
  echo "       stale or empty site root." >&2
  exit 1
fi
echo "  build OK -> $FRONTEND_DIR/dist (served directly by Nginx)"
echo ""

# ------------------------------------------------------------------ nginx ----
# Config is already correct and is NOT modified. Validate, then reload only if
# validation passed — `set -e` aborts the script if `nginx -t` fails, so the
# reload below can never run against a broken config.

log_step 7 "Verifying Nginx..."
sudo nginx -t
echo "  nginx config valid -> reloading"
sudo systemctl reload nginx
echo ""

echo "========================================="
echo "  Deploy complete!"
echo "========================================="
echo ""

echo "PM2:"
pm2 status
echo ""

# The frontend must NOT be a PM2 process any more. Report it if a stale one is
# left over from the old architecture; this is read-only and never fatal.
if pm2 describe frontend >/dev/null 2>&1; then
  echo "NOTE: a stale PM2 process named 'frontend' exists. The frontend is now"
  echo "      served straight from $FRONTEND_DIR/dist by Nginx, so this process"
  echo "      is unused. Remove it when convenient:  pm2 delete frontend && pm2 save"
  echo ""
fi

# Health checks are informational: a curl failure must not fail the deploy.
echo "Frontend:"
curl -I --max-time 10 "$SITE_URL" || true
echo ""

echo "Backend:"
curl --max-time 10 "$SITE_URL/api/status" || true
echo ""
