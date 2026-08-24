#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/manyreach-import-watch.sh --csv PATH --cookies PATH --work-dir PATH [options]

Required:
  --csv PATH          CSV containing email,password rows.
  --cookies PATH      Authenticated Manyreach cookies JSON.
  --work-dir PATH     Durable directory for state, results, logs, and PID files.

Options:
  --target N          Expected successful senders. Default: CSV row count.
  --concurrency N     Parallel OAuth browser contexts. Default: 4.
  --max-passes N      Maximum import/retry passes. Default: 6.
  --oauth-url URL     Manyreach Microsoft OAuth URL.
  --org-id ID         Manyreach organization ID.
  --importer PATH     Importer script path.
EOF
}

CSV=''
COOKIES=''
WORK_DIR=''
TARGET=''
CONCURRENCY=4
MAX_PASSES=6
OAUTH_URL=''
ORG_ID=''
IMPORTER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/manyreach-import-microsoft.mjs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --csv) CSV="$2"; shift 2 ;;
    --cookies) COOKIES="$2"; shift 2 ;;
    --work-dir) WORK_DIR="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --max-passes) MAX_PASSES="$2"; shift 2 ;;
    --oauth-url) OAUTH_URL="$2"; shift 2 ;;
    --org-id) ORG_ID="$2"; shift 2 ;;
    --importer) IMPORTER="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$CSV" || -z "$COOKIES" || -z "$WORK_DIR" ]]; then
  usage >&2
  exit 2
fi
for integer in "$CONCURRENCY" "$MAX_PASSES"; do
  [[ "$integer" =~ ^[1-9][0-9]*$ ]] || { echo 'Concurrency and max passes must be positive integers.' >&2; exit 2; }
done
[[ -r "$CSV" ]] || { echo "CSV is not readable: $CSV" >&2; exit 2; }
[[ -r "$COOKIES" ]] || { echo "Cookies file is not readable: $COOKIES" >&2; exit 2; }
[[ -r "$IMPORTER" ]] || { echo "Importer is not readable: $IMPORTER" >&2; exit 2; }

mkdir -p "$WORK_DIR"
STATE_FILE="$WORK_DIR/state.json"
RESULTS_FILE="$WORK_DIR/results.ndjson"
IMPORT_LOG="$WORK_DIR/import.log"
WATCHER_LOG="$WORK_DIR/watcher.log"
PID_FILE="$WORK_DIR/import.pid"

if [[ -z "$TARGET" ]]; then
  TARGET="$(awk 'END { print NR > 0 ? NR - 1 : 0 }' "$CSV")"
fi
[[ "$TARGET" =~ ^[1-9][0-9]*$ ]] || { echo 'Target must be a positive integer.' >&2; exit 2; }

current_successes() {
  jq '[.accounts[]? | select(.status == "success")] | length' "$STATE_FILE" 2>/dev/null || echo 0
}

run_import() {
  local -a args=(
    node "$IMPORTER"
    --csv "$CSV"
    --cookies "$COOKIES"
    --headless
    --concurrency "$CONCURRENCY"
    --account-retries 2
    --account-timeout-ms 180000
    --state-file "$STATE_FILE"
    --results-file "$RESULTS_FILE"
  )
  [[ -n "$OAUTH_URL" ]] && args+=(--oauth-url "$OAUTH_URL")
  [[ -n "$ORG_ID" ]] && args+=(--org-id "$ORG_ID")

  "${args[@]}" >> "$IMPORT_LOG" 2>&1 &
  local child_pid=$!
  echo "$child_pid" > "$PID_FILE"
  set +e
  wait "$child_pid"
  local status=$?
  set -e
  return "$status"
}

exec >> "$WATCHER_LOG" 2>&1
echo "Started at $(date -u +%Y-%m-%dT%H:%M:%SZ); target=$TARGET concurrency=$CONCURRENCY"

for ((pass = 1; pass <= MAX_PASSES; pass += 1)); do
  successes="$(current_successes)"
  echo "Before pass $pass: $successes/$TARGET successes."
  if [[ "$successes" -ge "$TARGET" ]]; then
    echo 'Import complete.'
    exit 0
  fi

  if ! run_import; then
    echo "Pass $pass exited nonzero; resumable state was preserved."
  fi
done

successes="$(current_successes)"
echo "Finished retry budget with $successes/$TARGET successes."
[[ "$successes" -ge "$TARGET" ]]
