#!/usr/bin/env bash
# StreamVault Linux VPS setup script.
#
# Run this from the repo root right after cloning:
#   bash deploy/setup.sh
#
# It installs+builds both the frontend and the backend, creates server/.env
# from the example file if one doesn't already exist, and creates the full
# uploads/ directory tree. It does NOT touch your database (see the printed
# next-steps at the end for that) and never overwrites an existing .env.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== StreamVault setup =="
echo "Repo root: $ROOT_DIR"
echo

# ── Prerequisite checks ───────────────────────────────────────────────────────
missing=0

check_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "MISSING: $1 -- $2"
    missing=1
  else
    echo "found: $1 ($("$1" "$3" 2>&1 | head -n1))"
  fi
}

check_cmd node "install Node.js >= 20 (https://nodejs.org or your distro's nodesource repo)" --version
check_cmd npm "comes with Node.js" --version
check_cmd ffmpeg "install with your package manager, e.g. 'sudo apt install ffmpeg'" -version
check_cmd ffprobe "ships alongside ffmpeg -- same package" -version
check_cmd mysql "install a MySQL client, e.g. 'sudo apt install mysql-client' (the server itself can run elsewhere)" --version

if [ "$missing" -eq 1 ]; then
  echo
  echo "One or more prerequisites are missing -- install them, then re-run this script."
  exit 1
fi

echo
echo "== Installing + building frontend =="
npm install
npm run build

echo
echo "== Installing + building backend =="
cd "$ROOT_DIR/server"
npm install
npm run build

# ── .env bootstrap (never overwrite an existing one) ─────────────────────────
if [ -f .env ]; then
  echo
  echo ".env already exists -- leaving it untouched."
else
  echo
  echo "Creating server/.env from .env.example -- YOU MUST EDIT IT before starting the app."
  cp .env.example .env
fi

# ── Storage directories ───────────────────────────────────────────────────────
echo
echo "== Creating uploads/ directory tree =="
mkdir -p uploads/{temp,videos,thumbnails,recordings,posters,hls/live}
echo "done: $ROOT_DIR/server/uploads"

cd "$ROOT_DIR"

cat <<'EOF'

== Setup script finished. Remaining manual steps: ==

1. Edit server/.env -- at minimum set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME,
   JWT_SECRET/JWT_REFRESH_SECRET, CLIENT_URL (your real domain), and
   PUBLIC_RTMP_HOST (your VPS's public IP/domain, NOT localhost, if you'll
   use live streaming).

2. Create the database and import the schema (only needs to be done once):
     mysql -u <user> -p -e "CREATE DATABASE IF NOT EXISTS streamvault"
     mysql -u <user> -p streamvault < server/schema.sql

3. Install the systemd service so the app survives crashes/reboots:
     sudo cp deploy/streamvault.service /etc/systemd/system/streamvault.service
     sudo systemctl daemon-reload
     sudo systemctl enable --now streamvault
     sudo systemctl status streamvault      # confirm it's running
     sudo journalctl -u streamvault -f      # tail logs

4. (Optional) If you want a domain + HTTPS in front of it, see
   deploy/apache-streamvault.conf or deploy/nginx-streamvault.conf depending
   on what's already installed on this VPS. Not sure which (or if either is)?
   Run:  sudo ss -tlnp | grep -E ':80|:443'
   If nothing is listening on 80/443, a reverse proxy is optional -- the app
   is already fully working on its own port from step 3.

5. Open port 1935 in your firewall for OBS/RTMP live streaming, e.g.:
     sudo ufw allow 1935/tcp

EOF
