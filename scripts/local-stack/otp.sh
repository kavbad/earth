#!/usr/bin/env bash
# Prints the latest email one-time code Mailpit received for an address (used by e2e).
#
#   bash scripts/local-stack/otp.sh <email> [--timeout <seconds>] [--after <iso>] [--json]
#
# Reads Mailpit at EARTH_MAILPIT_URL (default http://127.0.0.1:8025). Exit 1 when no code arrives.
set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$STACK_DIR/../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: bash scripts/local-stack/otp.sh <email> [--timeout <seconds>] [--after <iso>] [--json]" >&2
  exit 1
fi

: "${EARTH_MAILPIT_URL:=http://127.0.0.1:${EARTH_PORT_MAILPIT_HTTP:-8025}}"
export EARTH_MAILPIT_URL

TSX="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX" ]] || { echo "[otp] $TSX is missing: run pnpm install first" >&2; exit 1; }
cd "$REPO_ROOT"
exec "$TSX" "$STACK_DIR/otp.ts" "$@"
