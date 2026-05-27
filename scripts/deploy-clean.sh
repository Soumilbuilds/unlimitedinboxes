#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Soumilbuilds/unlimitedinboxes.git"
DEPLOY_HOST="62.171.150.14"
SSH_CREDS="speed200ignite"
SSH_CMD="sshpass -p '$SSH_CREDS' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@$DEPLOY_HOST"

echo "=== Deploying Unlimited Inboxes from GitHub ==="

# Step 1: Clone/update repo on VPS
$SSH_CMD "
  set -e
  REPO_DIR=/opt/unlimited-inboxes/repo
  SHARED_DIR=/opt/unlimited-inboxes/shared

  echo 'Creating directories...'
  mkdir -p \$REPO_DIR \$SHARED_DIR/db \$SHARED_DIR/logs \$SHARED_DIR/pids

  echo 'Cloning / updating from GitHub...'
  if [ ! -d \$REPO_DIR/.git ]; then
    git clone $REPO_URL \$REPO_DIR
  else
    cd \$REPO_DIR && git fetch --all && git reset --hard origin/main
  fi

  echo 'Linking .env and db...'
  touch \$SHARED_DIR/.env
  ln -sfn \$SHARED_DIR/.env \$REPO_DIR/server/.env 2>/dev/null || true
  touch \$SHARED_DIR/db/app.db
  ln -sfn \$SHARED_DIR/db/app.db \$REPO_DIR/server/db/app.db 2>/dev/null || true

  echo 'Installing server deps...'
  cd \$REPO_DIR/server && npm install --omit=dev 2>&1 | tail -3

  echo 'Building client...'
  cd \$REPO_DIR/client && npm install && npm run build 2>&1 | tail -3

  echo 'Stopping old server...'
  pkill -f 'node index.js' 2>/dev/null || true
  sleep 1

  echo 'Starting server...'
  cd \$REPO_DIR/server
  nohup node index.js > \$SHARED_DIR/logs/server.log 2>&1 &
  sleep 3

  if curl -s http://localhost:3000/api/health | grep -q 'ok'; then
    echo 'SUCCESS: Server is running'
  else
    echo 'ERROR: health check failed'
    tail -15 \$SHARED_DIR/logs/server.log
    exit 1
  fi
"
echo "=== Deploy complete ==="