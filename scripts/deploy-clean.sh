#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Soumilbuilds/unlimitedinboxes.git"
DEPLOY_PATH="/opt/unlimited-inboxes"
SHARED_DIR="${DEPLOY_PATH}/shared"
REPO_DIR="${DEPLOY_PATH}/repo"
LOG_DIR="${SHARED_DIR}/logs"
PID_DIR="${SHARED_DIR}/pids"
SSH_HOST="root@62.171.150.14"

echo "=== Deploying Unlimited Inboxes from GitHub ==="

sshpass -p 'speed200ignite' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$SSH_HOST" '
set -e

echo "Creating directories..."
mkdir -p "$REPO_DIR" "$SHARED_DIR/db" "$SHARED_DIR/logs" "$SHARED_DIR/pids"

echo "Cloning / updating from GitHub..."
if [ ! -d "'"$REPO_DIR"'/.git" ]; then
  git clone "'"$REPO_URL'"' "'"$REPO_DIR"'"
else
  cd "'"$REPO_DIR'"' && git fetch --all && git reset --hard origin/main
fi

echo "Setting up .env..."
if [ ! -f "'"$SHARED_DIR"'/.env" ]; then
  touch "'"$SHARED_DIR"'/.env"
fi
ln -sfn "'"$SHARED_DIR"'/.env" "'"$REPO_DIR"'/server/.env" 2>/dev/null || true

echo "Setting up database..."
touch "'"$SHARED_DIR"'/db/app.db"
ln -sfn "'"$SHARED_DIR"'/db/app.db" "'"$REPO_DIR"'/server/db/app.db" 2>/dev/null || true

echo "Installing server deps..."
cd "'"$REPO_DIR"'/server && npm install --omit=dev 2>&1 | tail -3

echo "Building client..."
cd "'"$REPO_DIR"'/client && npm install 2>&1 | tail -2 && npm run build 2>&1 | tail -3

echo "Stopping old server..."
if command -v fuser >/dev/null 2>&1; then fuser -k 3000/tcp 2>/dev/null || true; fi
pkill -f "node index.js" 2>/dev/null || true
sleep 1

echo "Starting server..."
cd "'"$REPO_DIR"'/server"

# Read secrets from shared .env
set -a && . "'"$SHARED_DIR"'/.env" && set +a

NODE_ENV=production nohup node index.js >> "'"$LOG_DIR"'/server.log" 2>&1 &
echo $! > "'"$PID_DIR"'/server.pid"

sleep 2
if curl -s http://localhost:3000/api/health | grep -q "ok"; then
  echo "SUCCESS: Server is running on port 3000"
else
  echo "WARNING: Server health check failed, check logs"
  tail -10 "'"$LOG_DIR"'/server.log"
fi
'
echo "=== Deploy complete ==="