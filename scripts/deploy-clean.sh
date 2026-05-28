#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "deploy-clean.sh is kept for compatibility. Using deploy_github.sh."
exec "$SCRIPT_DIR/deploy_github.sh" "$@"
