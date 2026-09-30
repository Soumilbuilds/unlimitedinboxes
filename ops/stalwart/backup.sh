#!/usr/bin/env bash
set -euo pipefail

# RocksDB is copied only while Stalwart is stopped. Run in an approved
# maintenance window; this briefly interrupts SMTP and IMAP on this host.
if [[ ${1:-} != --quiesce ]]; then
  echo 'Usage: backup.sh --quiesce (brief Stalwart SMTP/IMAP interruption)' >&2
  exit 2
fi

umask 077
cd /opt/stalwart
exec 9>/opt/stalwart/backups/.lock
flock -n 9 || { echo 'A Stalwart backup is already running' >&2; exit 1; }

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="/opt/stalwart/backups/stalwart-${timestamp}.tar.gz"
temporary="${archive}.partial"
started=0

restore_service() {
  if [[ $started == 1 ]]; then
    docker compose up -d >/dev/null
  fi
  if [[ -f $temporary ]]; then
    rm -f -- "$temporary"
  fi
}
trap restore_service EXIT

started=1
docker compose stop stalwart >/dev/null
tar --numeric-owner --acls --xattrs -czf "$temporary" \
  -C /opt/stalwart compose.yaml config data secrets
mv -- "$temporary" "$archive"
sha256sum "$archive" > "${archive}.sha256"
chmod 600 "$archive" "${archive}.sha256"
docker compose up -d >/dev/null
for _ in {1..30}; do
  if [[ $(docker inspect stalwart --format '{{.State.Health.Status}}' 2>/dev/null) == healthy ]]; then
    started=0
    break
  fi
  sleep 1
done
if [[ $started == 1 ]]; then
  echo 'Backup completed but Stalwart health has not recovered' >&2
  exit 1
fi
echo "Backup created: $archive"
