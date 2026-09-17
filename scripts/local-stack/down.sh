#!/usr/bin/env bash
# Stops every local-stack process started by up.sh (pids in .local/pids). The database is kept.
#
#   bash scripts/local-stack/down.sh
set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$STACK_DIR/../.." && pwd)"
PID_DIR="${EARTH_PID_DIR:-$REPO_ROOT/.local/pids}"

log() { printf '[local-stack] %s\n' "$*"; }

# Reverse start order: dependents first.
ORDER=(web gateway gotrue postgrest livekit mailpit)

stop_service() {
  local name="$1" pidfile="$PID_DIR/$1.pid" pid
  [[ -f "$pidfile" ]] || return 0
  pid="$(cat "$pidfile")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    # up.sh starts services with setsid, so the pid is a process-group id; fall back to the pid.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      log "killed $name (pid $pid)"
    else
      log "stopped $name (pid $pid)"
    fi
  else
    log "$name was not running (stale pid $pid)"
  fi
  rm -f "$pidfile"
}

if [[ ! -d "$PID_DIR" ]]; then
  log "nothing to stop ($PID_DIR does not exist)"
  exit 0
fi

for name in "${ORDER[@]}"; do
  stop_service "$name"
done
# Anything else that left a pid file (e.g. from an older version of up.sh).
for pidfile in "$PID_DIR"/*.pid; do
  [[ -f "$pidfile" ]] || continue
  stop_service "$(basename "$pidfile" .pid)"
done

log "local stack stopped; the database was kept (KEEP_DB=1 pnpm stack:up reuses it)"
