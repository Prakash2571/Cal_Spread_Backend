# CalSpread VM deployment

Production: https://calspread.online (www and HTTP redirect here).

Nginx serves the production frontend from `/var/www/calspread` and proxies
`/api/*`, `/login`, and `/callback` to the Go backend at `127.0.0.1:3001`.
API buffering is disabled for SSE. PostgreSQL listens locally; the backend uses
the Unix socket with peer authentication as the `calspread` OS/database user.

## Installed files

| Purpose | VM path |
| --- | --- |
| Backend binary | `/opt/calspread/bin/calspread` |
| Production configuration | `/etc/calspread/calspread.env` |
| Service | `/etc/systemd/system/calspread.service` |
| Writable service directory | `/var/lib/calspread` |
| Frontend build | `/var/www/calspread` |
| Nginx site | `/etc/nginx/sites-available/calspread.online` |
| Nginx access log format | `/etc/nginx/conf.d/calspread-log.conf` |
| Certificate | `/etc/letsencrypt/live/calspread.online/fullchain.pem` |
| Renewal hook | `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx` |

The production environment was copied from the backend checkout's `.env`, then
its `DATABASE_URL` was changed to
`postgresql://calspread@/calspread?host=/var/run/postgresql&sslmode=disable`.
Subsequent edits to the checkout's `.env` do not change production. Edit production
configuration with `sudoedit /etc/calspread/calspread.env`, then run
`sudo systemctl restart calspread`.

The unit sets `HOST=127.0.0.1`, `PORT=3001`, and
`FRONTEND_URL=https://calspread.online`. It runs as an unprivileged user, starts at
boot, and restarts automatically after the process exits. Normal shutdown allows
30 seconds for the application's default 12-second graceful shutdown.

## Broker setup still required

At deployment, `KITE_API_KEY` and `KITE_API_SECRET` contained example placeholders.
Replace them in the production environment to enable Zerodha login. Configure the
Kite app redirect as `https://calspread.online/zerodha/verify`.
`ACCESS_SECRET` was empty, so trade-access password login remains disabled until
it is configured. The existing admin secret and other service credentials were
preserved without being printed.

## Operations

```bash
sudo systemctl status calspread nginx
sudo journalctl -u calspread -f
sudo systemctl restart calspread
curl -fsS http://127.0.0.1:3001/
curl -fsS https://calspread.online/api/admin/status
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl list-timers certbot.timer
sudo certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew
```

Certbot uses the HTTP webroot `/var/www/letsencrypt` to renew both names. Keep
public TCP ports 80 and 443 open and the DNS records pointing to this VM. Its timer
renews automatically and the deploy hook validates/reloads Nginx. No contact email
was supplied when the ACME account was created; one can be added with
`sudo certbot update_account --email YOUR_EMAIL`.

The Nginx access log excludes query strings and referrers to avoid logging login
and stream credentials. Treat application and error logs as private operational
data.

## Rebuild and publish updates

Run as `calspread`; both checkouts must be clean and on `main`:

```bash
cd /home/calspread/Cal_Spread_Backend
./scripts/deploy.sh
```

The script pulls backend `origin/main`, builds Go, starts/checks PostgreSQL using
the production configuration, pulls frontend `origin/main`, installs locked
frontend dependencies, builds the UI with the production API origin, validates
Nginx, installs/restarts the backend, verifies that PostgreSQL
persistence initialized, publishes the frontend, reloads Nginx, and checks the
live HTTPS frontend, JavaScript and API. A lock prevents concurrent deployments.
It restores the previous backend and frontend entry page if activation checks
fail; older hashed assets remain available. Database migrations are not rolled
back, so back up the database before updates containing schema changes.

Git pulls use `--ff-only --no-rebase --no-autostash`; dirty checkouts, a branch
other than `main`, divergent history, or a failed pull stop deployment. Local
commits and changes are preserved. Pulls require the `calspread` user's existing
GitHub access. The script runs an in-memory copy so a backend pull cannot replace
the code being executed; changes to the deploy script take effect on the next run.

It uses the installed systemd/Nginx configuration and existing certificates;
it does not overwrite production credentials. The default
frontend checkout is `../Cal_Spread`. Override it when needed:

```bash
CALSPREAD_FRONTEND_DIR=/path/to/Cal_Spread ./scripts/deploy.sh
```

For individual manual update commands:

```bash
cd /home/calspread/Cal_Spread_Backend
go build -trimpath -o outputs/calspread ./cmd/server
sudo install -m 0755 outputs/calspread /opt/calspread/bin/calspread.next
sudo mv /opt/calspread/bin/calspread.next /opt/calspread/bin/calspread
sudo systemctl restart calspread

cd /home/calspread/Cal_Spread
npm ci --no-audit --no-fund
VITE_API_BASE_URL=https://calspread.online npm run build
sudo cp -a dist/. /var/www/calspread/
sudo chown -R root:root /var/www/calspread
sudo find /var/www/calspread -type d -exec chmod 0755 {} +
sudo find /var/www/calspread -type f -exec chmod 0644 {} +
```

Nginx does not need a reload for frontend file changes. Older hashed assets are
kept so browsers with an older page can finish loading. Back up the PostgreSQL
database and production configuration before applying future application changes
that include migrations.

## Initial HTTPS bootstrap

The checked-in `nginx-http.conf` is the temporary HTTP site used before the first
certificate exists. The final `nginx.conf` references the certificate files and
must be installed after issuance. The initial issuance command was:

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name calspread.online -d calspread.online -d www.calspread.online \
  --non-interactive --agree-tos --register-unsafely-without-email
```

Install `nginx-log.conf` into `/etc/nginx/conf.d/calspread-log.conf` before enabling
the final site, since the site uses its named log format.
