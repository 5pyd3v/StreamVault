# StreamVault — First-Time VPS Setup

A complete walkthrough from a bare Linux VPS to a running StreamVault instance. Follow the phases in order — each one has a checkpoint to confirm before moving to the next, so problems get caught early instead of at the end.

## Phase 0 — Get the code onto the VPS

Prefer a real `git clone` over manually copying files, so future updates are a simple `git pull`:

```bash
cd /var/www
git clone <your-repo-url> StreamVault
cd StreamVault
```

## Phase 1 — Prerequisites

```bash
# Node.js 20+ (skip if already installed — check with `node --version`)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# ffmpeg
sudo apt install -y ffmpeg

# MySQL server (not just a client)
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
```

## Phase 2 — Run the setup script

```bash
bash deploy/setup.sh
```

This checks `node`/`ffmpeg`/`mysql` are present, installs and builds both the frontend and backend, creates `server/.env` from the template (only if one doesn't already exist — never overwrites), and creates the `uploads/` directory tree. It stops with a clear message if a prerequisite from Phase 1 is missing.

## Phase 3 — Configure `server/.env`

```bash
nano server/.env
```

At minimum, set:
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` — matching whatever you create in Phase 4
- `JWT_SECRET` and `JWT_REFRESH_SECRET` — any long random strings
- `CLIENT_URL` — your domain (`https://yourdomain.com`) or `http://YOUR_VPS_IP:5000` if you don't have one yet
- `PUBLIC_RTMP_HOST` — your VPS's public IP or domain (**not** `localhost`) if you'll use live streaming
- `ENCODER_SOFTWARE_PRESET` — defaults to `ultrafast` in `.env.example`, but if this file already existed from an earlier setup it may still say `superfast`; change it if you want the faster default

## Phase 4 — Database

```bash
sudo mysql -e "CREATE DATABASE streamvault; CREATE USER 'streamvault'@'localhost' IDENTIFIED BY 'CHOOSE_A_PASSWORD'; GRANT ALL ON streamvault.* TO 'streamvault'@'localhost'; FLUSH PRIVILEGES;"
mysql -u streamvault -p streamvault < server/schema.sql
```

Use the same user/password/DB name in `server/.env`'s `DB_USER`/`DB_PASSWORD`/`DB_NAME`.

## Phase 5 — Start it as a systemd service

```bash
sudo cp deploy/streamvault.service /etc/systemd/system/streamvault.service
```

**Edit the unit file before enabling it** — the shipped template's `WorkingDirectory` and `User` are placeholders and must match your actual setup exactly. Linux paths are case-sensitive; `/var/www/StreamVault` and `/var/www/streamvault` are different paths:

```bash
sudo sed -i \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=$(pwd)/server#" \
  -e 's#^User=.*#User=root#' \
  /etc/systemd/system/streamvault.service

# Confirm the values actually took before proceeding:
grep -E "WorkingDirectory|User" /etc/systemd/system/streamvault.service
```

(Replace `User=root` with a less-privileged user if you have one set up with access to this directory — check `ls -la /var/www` to see who owns it.)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now streamvault
sudo systemctl status streamvault --no-pager
```

**Checkpoint — confirm it actually started cleanly**, not just that the process launched:

```bash
sudo journalctl -u streamvault -n 20 --no-pager
curl http://localhost:5000/api/health
```

You should see `✅ MySQL connected` and `🚀 StreamVault API → ...` in the log, and the `curl` should return `{"status":"ok",...}`. If `systemctl status` shows `activating (auto-restart)` repeatedly, the log will show exactly why (commonly: wrong `WorkingDirectory`/`User`, or MySQL not reachable yet — a "Failed at step CHDIR" line means the path is wrong).

## Phase 6 — First browser test (before any reverse proxy)

```bash
sudo ufw allow 5000/tcp
```

Visit `http://YOUR_VPS_IP:5000` directly. Register an account — it's auto-promoted to admin as the first registered user.

If the page loads but looks broken/blank, check the browser console. Two secure-context browser restrictions only bite over plain `http://` on a non-localhost address (both already handled in the app, but worth knowing if you ever see them again after a code change): `crypto.randomUUID`/`crypto.subtle` and `navigator.clipboard` are unavailable without HTTPS or `localhost`. They no longer crash anything, but it's the reason copy-to-clipboard buttons quietly fall back to a legacy method at this stage.

Once you have a domain with HTTPS in front of it (Phase 7), this class of restriction disappears entirely.

## Phase 7 — Reverse proxy (optional — only if you want a domain/HTTPS)

Check what's already listening on 80/443:

```bash
sudo ss -tlnp | grep -E ':80|:443'
```

- **Nothing there** → skip this phase. `http://YOUR_VPS_IP:5000` is a complete, working setup on its own.
- **Apache** → follow the instructions at the top of `deploy/apache-streamvault.conf`. Pay particular attention to the WebSocket upgrade rule (Socket.IO silently breaks without it — everything else looks fine, but live progress/updates never arrive) and the `mod_security` note (a common cause of uploads failing with nothing reaching Node at all).
- **nginx** → follow the instructions at the top of `deploy/nginx-streamvault.conf`.

Once the proxy is confirmed working over plain HTTP, add TLS:

```bash
sudo certbot --apache -d yourdomain.com   # or --nginx
```

## Phase 8 — Live streaming firewall

```bash
sudo ufw allow 1935/tcp
```

This is separate from the web port — OBS connects to it directly, never through Apache/nginx. In OBS: Server = `rtmp://YOUR_VPS_IP:1935/live` (or your domain), Stream Key = from the channel's settings in the app.

## Deploying updates after this initial setup

Once everything above is working, pulling in later code changes is always the same four commands:

```bash
cd /var/www/StreamVault
git pull
npm run build && (cd server && npm run build)
sudo systemctl restart streamvault
```

**Always verify `git pull` actually fetched something** before assuming a fix landed — `git log HEAD..origin/main --oneline` (run before pulling) shows any commits you're missing; an empty result means you're already current. It's easy to test a fix, see it "not work," and not realize the pull silently did nothing.

## Troubleshooting quick-reference

| Symptom | Likely cause |
|---|---|
| `status=200/CHDIR` in `systemctl status` | `WorkingDirectory` in the unit file doesn't match the real (case-sensitive) path |
| Upload fails instantly, nothing in `journalctl` at all | Request isn't reaching Node — check for a reverse proxy rejecting it (body size limit, `mod_security`) before it arrives |
| Blank white page, assets fail with `ERR_SSL_PROTOCOL_ERROR` | Something is forcing an HTTPS upgrade (e.g. a stale CSP header) while served over plain HTTP — check `helmet()`'s config in `server/src/index.ts` |
| `git pull` then a bug still isn't fixed | Confirm the pull actually fetched new commits (see above) and that `npm run build` was re-run afterward — an unbuilt `.ts` change does nothing |
| Video stuck `failed` despite `hls_path` already being set | A crash occurred after the encode already succeeded — check `journalctl` for the real error near "Ready 100%"; the row can usually be corrected directly (`UPDATE videos SET status='published' WHERE ...`) once the underlying bug is fixed |
