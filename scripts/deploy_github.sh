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
AUTO_COMMIT="${AUTO_COMMIT:-0}"
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
BUILD_CLIENT_LOCAL="${BUILD_CLIENT_LOCAL:-1}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
REPO_DIR="${DEPLOY_PATH}/repo"
RELEASES_DIR="${DEPLOY_PATH}/releases"
SHARED_DIR="${DEPLOY_PATH}/shared"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
RELEASE_DIR="${RELEASES_DIR}/${TIMESTAMP}"
KEEP_RELEASES="${KEEP_RELEASES:-10}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"

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
  if [ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]; then
    git -C "$ROOT_DIR" add -A
    git -C "$ROOT_DIR" commit -m "deploy: $(date +%Y-%m-%d_%H-%M-%S)" || {
      echo "Commit failed. Configure git user.name/email or set AUTO_COMMIT=0."
      exit 1
    }
  fi
elif [ "$ALLOW_DIRTY" != "1" ] && [ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]; then
  echo "Working tree has uncommitted changes. Commit intentionally, or rerun with AUTO_COMMIT=1."
  git -C "$ROOT_DIR" status --short
  exit 1
elif [ "$ALLOW_DIRTY" = "1" ] && [ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]; then
  echo "ALLOW_DIRTY=1 set; deploying committed origin/$BRANCH and leaving local uncommitted files untouched."
  git -C "$ROOT_DIR" status --short
fi

if [ "$BUILD_CLIENT_LOCAL" = "1" ]; then
  echo "Building client locally..."
  (cd "$ROOT_DIR/client" && (npm ci || npm install) && npm run build)
fi

echo "Pushing to GitHub..."
git -C "$ROOT_DIR" push origin "$BRANCH"

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

echo "Deploying from GitHub to ${REMOTE}:${RELEASE_DIR}"
$SSH_CMD "$REMOTE" "mkdir -p \"$REPO_DIR\" \"$RELEASES_DIR\" \"$SHARED_DIR/db\" \"$SHARED_DIR/logs\" \"$SHARED_DIR/pids\""
$SSH_CMD "$REMOTE" "mkdir -p \"$SHARED_DIR/db/backups\"; if [ -s \"$SHARED_DIR/db/app.db\" ]; then cp \"$SHARED_DIR/db/app.db\" \"$SHARED_DIR/db/backups/app-$TIMESTAMP.db\"; fi"
$SSH_CMD "$REMOTE" "if [ ! -d \"$REPO_DIR/.git\" ]; then git clone \"$REPO_URL\" \"$REPO_DIR\"; fi"
$SSH_CMD "$REMOTE" "cd \"$REPO_DIR\" && git fetch --all && git reset --hard origin/$BRANCH"

$SSH_CMD "$REMOTE" "if [ ! -f \"$SHARED_DIR/.env\" ]; then touch \"$SHARED_DIR/.env\"; fi"
$SSH_CMD "$REMOTE" "mkdir -p \"$RELEASE_DIR\" && rsync -az --delete --exclude .git --exclude node_modules --exclude client/node_modules --exclude server/node_modules --exclude server/db/app.db --exclude server/.env \"$REPO_DIR/\" \"$RELEASE_DIR/\""
$SSH_CMD "$REMOTE" "ln -sfn \"$SHARED_DIR/.env\" \"$RELEASE_DIR/server/.env\""
$SSH_CMD "$REMOTE" "touch \"$SHARED_DIR/db/app.db\"; ln -sfn \"$SHARED_DIR/db/app.db\" \"$RELEASE_DIR/server/db/app.db\""

$SSH_CMD "$REMOTE" "cd \"$RELEASE_DIR/server\" && (npm ci --omit=dev || npm install --omit=dev)"
if [ "$BUILD_CLIENT_LOCAL" = "1" ]; then
  $SSH_CMD "$REMOTE" "mkdir -p \"$RELEASE_DIR/client/dist\""
  rsync -az --delete -e "$RSYNC_RSH" "$ROOT_DIR/client/dist/" "$REMOTE:$RELEASE_DIR/client/dist/"
else
  $SSH_CMD "$REMOTE" "cd \"$RELEASE_DIR/client\" && (npm ci || npm install) && npm run build"
fi

echo "Verifying frontend assets before activation..."
$SSH_CMD "$REMOTE" "node \"$RELEASE_DIR/scripts/verify-frontend-assets.mjs\" \"$RELEASE_DIR/client/dist\""

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

echo "Deploy complete (GitHub)."
