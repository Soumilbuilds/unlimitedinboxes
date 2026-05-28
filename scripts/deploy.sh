#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ROOT_DIR/.deploy.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.deploy.env"
  set +a
fi

DEPLOY_HOST="${DEPLOY_HOST:-62.171.150.14}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/unlimited-inboxes}"
SYNC_ENV="${SYNC_ENV:-1}"
BUILD_CLIENT_LOCAL="${BUILD_CLIENT_LOCAL:-1}"
KEEP_RELEASES="${KEEP_RELEASES:-10}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
RELEASES_DIR="${DEPLOY_PATH}/releases"
SHARED_DIR="${DEPLOY_PATH}/shared"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
RELEASE_DIR="${RELEASES_DIR}/${TIMESTAMP}"
SSH_CMD="ssh"
RSYNC_RSH="ssh"

if command -v sshpass >/dev/null 2>&1; then
  if [ -z "${SSHPASS:-}" ]; then
    read -r -s -p "SSH Password: " SSHPASS
    echo ""
    export SSHPASS
  fi
  SSH_CMD="sshpass -e ssh"
  RSYNC_RSH="sshpass -e ssh"
else
  echo "Tip: install sshpass for a single password prompt (brew install sshpass)."
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required but not installed."
  exit 1
fi

echo "Deploying to ${REMOTE}:${RELEASE_DIR}"

$SSH_CMD "$REMOTE" "mkdir -p \"$RELEASES_DIR\" \"$SHARED_DIR/db\" \"$SHARED_DIR/logs\" \"$SHARED_DIR/pids\""
$SSH_CMD "$REMOTE" "mkdir -p \"$SHARED_DIR/db/backups\"; if [ -s \"$SHARED_DIR/db/app.db\" ]; then cp \"$SHARED_DIR/db/app.db\" \"$SHARED_DIR/db/backups/app-$TIMESTAMP.db\"; fi"

if [ "$BUILD_CLIENT_LOCAL" = "1" ]; then
  echo "Building client locally..."
  (cd "$ROOT_DIR/client" && (npm ci || npm install) && npm run build)
fi

if [ "$SYNC_ENV" = "1" ] && [ -f "$ROOT_DIR/server/.env" ]; then
  echo "Syncing server/.env to ${SHARED_DIR}/.env"
  rsync -az -e "$RSYNC_RSH" "$ROOT_DIR/server/.env" "$REMOTE:$SHARED_DIR/.env"

  EXO_CERT_PATH="$(grep '^EXO_CERT_PFX_PATH=' "$ROOT_DIR/server/.env" | head -n1 | cut -d= -f2- || true)"
  if [ -n "$EXO_CERT_PATH" ] && [ -f "$EXO_CERT_PATH" ]; then
    echo "Syncing EXO cert to $EXO_CERT_PATH"
    EXO_DIR="$(dirname "$EXO_CERT_PATH")"
    $SSH_CMD "$REMOTE" "mkdir -p \"$EXO_DIR\""
    rsync -az -e "$RSYNC_RSH" "$EXO_CERT_PATH" "$REMOTE:$EXO_CERT_PATH"
  fi
fi

rsync -az --delete -e "$RSYNC_RSH" \
  --exclude .git \
  --exclude node_modules \
  --exclude client/node_modules \
  --exclude server/node_modules \
  --exclude server/db/app.db \
  --exclude server/.env \
  --exclude landing \
  --exclude .next \
  --exclude .DS_Store \
  "$ROOT_DIR/" "$REMOTE:$RELEASE_DIR/"

$SSH_CMD "$REMOTE" "if [ ! -f \"$SHARED_DIR/.env\" ]; then touch \"$SHARED_DIR/.env\"; fi"
$SSH_CMD "$REMOTE" "ln -sfn \"$SHARED_DIR/.env\" \"$RELEASE_DIR/server/.env\""
$SSH_CMD "$REMOTE" "touch \"$SHARED_DIR/db/app.db\"; ln -sfn \"$SHARED_DIR/db/app.db\" \"$RELEASE_DIR/server/db/app.db\""

$SSH_CMD "$REMOTE" "cd \"$RELEASE_DIR/server\" && (npm ci --omit=dev || npm install --omit=dev)"
$SSH_CMD "$REMOTE" "cd \"$RELEASE_DIR/client\" && (npm ci --omit=dev || npm install --omit=dev) || true"

PREVIOUS_RELEASE="$($SSH_CMD "$REMOTE" "readlink -f \"$DEPLOY_PATH/current\" 2>/dev/null || true")"

$SSH_CMD "$REMOTE" "ln -sfn \"$RELEASE_DIR\" \"$DEPLOY_PATH/current\""

echo "Restarting unlimited-inboxes.service..."
$SSH_CMD "$REMOTE" "systemctl daemon-reload && systemctl restart unlimited-inboxes"

echo "Checking health..."
if ! $SSH_CMD "$REMOTE" "for i in \$(seq 1 30); do curl -fsS \"$HEALTH_URL\" >/dev/null && exit 0; sleep 1; done; exit 1"; then
  echo "Health check failed."
  if [ -n "$PREVIOUS_RELEASE" ]; then
    echo "Rolling back to $PREVIOUS_RELEASE"
    $SSH_CMD "$REMOTE" "ln -sfn \"$PREVIOUS_RELEASE\" \"$DEPLOY_PATH/current\" && systemctl restart unlimited-inboxes"
  fi
  $SSH_CMD "$REMOTE" "journalctl -u unlimited-inboxes -n 80 --no-pager" || true
  exit 1
fi

$SSH_CMD "$REMOTE" "find \"$RELEASES_DIR\" -mindepth 1 -maxdepth 1 -type d | sort | head -n -$KEEP_RELEASES | xargs -r rm -rf"

echo "Deploy complete."
