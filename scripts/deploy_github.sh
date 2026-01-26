#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ROOT_DIR/.deploy.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.deploy.env"
  set +a
fi

REPO_URL="${REPO_URL:-https://github.com/Soumilbuilds/unlimitedinboxes.git}"
BRANCH="${BRANCH:-main}"
DEPLOY_HOST="${DEPLOY_HOST:-62.171.150.14}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/unlimited-inboxes}"
SYNC_ENV="${SYNC_ENV:-1}"
AUTO_COMMIT="${AUTO_COMMIT:-1}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
REPO_DIR="${DEPLOY_PATH}/repo"
SHARED_DIR="${DEPLOY_PATH}/shared"

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

if [ "$AUTO_COMMIT" = "1" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "deploy: $(date +%Y-%m-%d_%H-%M-%S)" || {
      echo "Commit failed. Configure git user.name/email or set AUTO_COMMIT=0."
      exit 1
    }
  fi
fi

echo "Pushing to GitHub..."
git push origin "$BRANCH"

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

echo "Deploying from GitHub to ${REMOTE}:${REPO_DIR}"
$SSH_CMD "$REMOTE" "mkdir -p \"$REPO_DIR\" \"$SHARED_DIR/db\" \"$SHARED_DIR/logs\" \"$SHARED_DIR/pids\""
$SSH_CMD "$REMOTE" "if [ ! -d \"$REPO_DIR/.git\" ]; then git clone \"$REPO_URL\" \"$REPO_DIR\"; fi"
$SSH_CMD "$REMOTE" "cd \"$REPO_DIR\" && git fetch --all && git reset --hard origin/$BRANCH"

$SSH_CMD "$REMOTE" "if [ ! -f \"$SHARED_DIR/.env\" ]; then touch \"$SHARED_DIR/.env\"; fi"
$SSH_CMD "$REMOTE" "ln -sfn \"$SHARED_DIR/.env\" \"$REPO_DIR/server/.env\""
$SSH_CMD "$REMOTE" "touch \"$SHARED_DIR/db/app.db\"; ln -sfn \"$SHARED_DIR/db/app.db\" \"$REPO_DIR/server/db/app.db\""

$SSH_CMD "$REMOTE" "cd \"$REPO_DIR/server\" && (npm ci --omit=dev || npm install --omit=dev)"
$SSH_CMD "$REMOTE" "cd \"$REPO_DIR/client\" && (npm ci || npm install) && npm run build"

$SSH_CMD "$REMOTE" "pkill -f \"node index.js\" >/dev/null 2>&1 || true"
$SSH_CMD "$REMOTE" "cd \"$REPO_DIR/server\" && NODE_ENV=production nohup node index.js > \"$SHARED_DIR/logs/server.log\" 2>&1 & echo \$! > \"$SHARED_DIR/pids/server.pid\""

echo "Deploy complete (GitHub)."
