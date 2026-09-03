#!/usr/bin/env bash
# Starts the local stack (ARCHITECTURE.md §15): Postgres (system service), PostgREST, GoTrue,
# LiveKit (dev mode), Mailpit and the Supabase-shaped gateway (gateway.mjs); optionally apps/web.
#
#   bash scripts/local-stack/up.sh [--with-web]
#
#   --with-web   also start `pnpm --filter earth-web dev` on EARTH_PORT_WEB
#   KEEP_DB=1    keep the existing database (GoTrue and earth migrations still run; both are idempotent)
#   NO_SEED=1    do not apply supabase/seed after a reset (never applied when APP_ENV=production)
#
# Logs: .local/logs/<service>.log   pids: .local/pids/<service>.pid   env: .local/stack.env
set -euo pipefail

# shellcheck source=./env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

log() { printf '[local-stack] %s\n' "$*"; }
die() { printf '[local-stack] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

WITH_WEB=0
for arg in "$@"; do
  case "$arg" in
    --with-web) WITH_WEB=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done

mkdir -p "$EARTH_LOG_DIR" "$EARTH_PID_DIR"

# port_open <host> <port>: true when something accepts TCP connections there (bash built-in /dev/tcp).
port_open() {
  (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null
}

# wait_http <name> <url> [timeout-seconds]: polls until the URL answers 200; fails fast when the
# service process died, printing the tail of its log.
wait_http() {
  local name="$1" url="$2" timeout="${3:-60}" pidfile="$EARTH_PID_DIR/$1.pid" code deadline
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    code="$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"
    if [[ "$code" == "200" ]]; then
      log "  ok   $name  $url"
      return 0
    fi
    if [[ -f "$pidfile" ]] && ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      tail -n 30 "$EARTH_LOG_DIR/$name.log" >&2 || true
      die "$name exited; see $EARTH_LOG_DIR/$name.log"
    fi
    if (( $(date +%s) >= deadline )); then
      tail -n 30 "$EARTH_LOG_DIR/$name.log" >&2 || true
      die "$name did not answer 200 at $url within ${timeout}s (last status: ${code:-none})"
    fi
    sleep 0.5
  done
}

# start_service <name> <command...>: background process in its own session (so down.sh can stop the
# whole process group, e.g. pnpm + next), stdout/stderr to .local/logs/<name>.log.
start_service() {
  local name="$1"
  shift
  local logfile="$EARTH_LOG_DIR/$name.log" pidfile="$EARTH_PID_DIR/$name.pid"
  : > "$logfile"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >> "$logfile" 2>&1 < /dev/null &
  else
    "$@" >> "$logfile" 2>&1 < /dev/null &
  fi
  echo $! > "$pidfile"
  log "started $name (pid $!) -> $logfile"
}

# --- 0. binaries ------------------------------------------------------------------------------
need_binaries=0
for binary in postgrest gotrue livekit-server mailpit; do
  [[ -x "$EARTH_BIN_DIR/$binary" ]] || need_binaries=1
done
[[ -d "$EARTH_GOTRUE_MIGRATIONS_DIR" ]] || need_binaries=1
if (( need_binaries )); then
  log "downloading pinned binaries into $EARTH_BIN_DIR"
  bash "$EARTH_STACK_DIR/fetch-binaries.sh"
fi

# --- 1. a previous stack? ----------------------------------------------------------------------
if compgen -G "$EARTH_PID_DIR/*.pid" > /dev/null; then
  log "stopping the previous stack"
  bash "$EARTH_STACK_DIR/down.sh"
fi

# --- 2. Postgres -----------------------------------------------------------------------------
if ! port_open "$EARTH_DB_HOST" "$EARTH_DB_PORT"; then
  if command -v pg_ctlcluster > /dev/null 2>&1; then
    log "starting Postgres cluster $EARTH_PG_CLUSTER_VERSION/$EARTH_PG_CLUSTER_NAME"
    if [[ "$(id -u)" == "0" ]] || ! command -v sudo > /dev/null 2>&1; then
      pg_ctlcluster "$EARTH_PG_CLUSTER_VERSION" "$EARTH_PG_CLUSTER_NAME" start
    else
      sudo pg_ctlcluster "$EARTH_PG_CLUSTER_VERSION" "$EARTH_PG_CLUSTER_NAME" start
    fi
  else
    die "nothing listens on $EARTH_DB_HOST:$EARTH_DB_PORT and pg_ctlcluster is unavailable; start Postgres 16 first"
  fi
fi
for _ in $(seq 1 60); do
  port_open "$EARTH_DB_HOST" "$EARTH_DB_PORT" && break
  sleep 0.5
done
port_open "$EARTH_DB_HOST" "$EARTH_DB_PORT" || die "Postgres did not come up on $EARTH_DB_HOST:$EARTH_DB_PORT"
log "postgres reachable at $EARTH_DB_HOST:$EARTH_DB_PORT"

# --- 3. ports must be free ---------------------------------------------------------------------
declare -A STACK_PORTS=(
  [postgrest]="$EARTH_PORT_POSTGREST" [gotrue]="$EARTH_PORT_GOTRUE" [livekit]="$EARTH_PORT_LIVEKIT"
  [mailpit-smtp]="$EARTH_PORT_MAILPIT_SMTP" [mailpit-http]="$EARTH_PORT_MAILPIT_HTTP" [gateway]="$EARTH_PORT_GATEWAY"
)
(( WITH_WEB )) && STACK_PORTS[web]="$EARTH_PORT_WEB"
for name in "${!STACK_PORTS[@]}"; do
  if port_open "$EARTH_PROBE_HOST" "${STACK_PORTS[$name]}"; then
    die "port ${STACK_PORTS[$name]} ($name) is already in use by something outside this stack"
  fi
done

# --- 4. database: recreate, GoTrue migrations, shim + earth migrations (+ seeds) -----------------
prepare_args=()
[[ "${KEEP_DB:-0}" == "1" ]] && prepare_args+=(--keep)
earth_tsx "$EARTH_STACK_DIR/prepare-db.ts" "${prepare_args[@]}"

log "applying GoTrue migrations from $EARTH_GOTRUE_MIGRATIONS_DIR"
if ! PORT="$EARTH_PORT_GOTRUE" "$EARTH_BIN_DIR/gotrue" migrate > "$EARTH_LOG_DIR/gotrue-migrate.log" 2>&1; then
  tail -n 20 "$EARTH_LOG_DIR/gotrue-migrate.log" >&2
  die "GoTrue migrations failed; see $EARTH_LOG_DIR/gotrue-migrate.log"
fi

migrate_args=()
if [[ "${KEEP_DB:-0}" == "1" || "${NO_SEED:-0}" == "1" || "$APP_ENV" == "production" ]]; then
  migrate_args+=(--no-seed)
else
  migrate_args+=(--seed)
fi
earth_tsx "$EARTH_REPO_ROOT/scripts/db/migrate.ts" "${migrate_args[@]}"

# --- 5. PostgREST configuration ---------------------------------------------------------------
cat > "$EARTH_POSTGREST_CONF" <<CONF
# Generated by scripts/local-stack/up.sh; mirrors supabase/config.toml [api].
db-uri = "$PGRST_DB_URI"
db-schemas = "public"
db-anon-role = "anon"
db-extra-search-path = "public, extensions"
db-max-rows = 200
db-pool = 10
jwt-secret = "$SUPABASE_JWT_SECRET"
jwt-aud = "authenticated"
server-host = "$EARTH_BIND_HOST"
server-port = $EARTH_PORT_POSTGREST
log-level = "info"
CONF

# --- 6. services -------------------------------------------------------------------------------
start_service mailpit "$EARTH_BIN_DIR/mailpit" \
  --smtp "$EARTH_BIND_HOST:$EARTH_PORT_MAILPIT_SMTP" --listen "$EARTH_BIND_HOST:$EARTH_PORT_MAILPIT_HTTP"
# livekit-server 1.9 has no --port flag: the TCP port comes from the (inline) config; --dev = keys devkey/secret.
start_service livekit "$EARTH_BIN_DIR/livekit-server" --dev --bind "$EARTH_BIND_HOST" \
  --config-body "port: $EARTH_PORT_LIVEKIT"
start_service postgrest "$EARTH_BIN_DIR/postgrest" "$EARTH_POSTGREST_CONF"
# The gateway must answer before GoTrue starts: GoTrue fetches its email templates from it at boot.
EARTH_GATEWAY_HOST="$EARTH_BIND_HOST" EARTH_UPSTREAM_HOST="$EARTH_PROBE_HOST" \
  start_service gateway node "$EARTH_STACK_DIR/gateway.mjs"
wait_http gateway "http://$EARTH_PROBE_HOST:$EARTH_PORT_GATEWAY/health" 30
PORT="$EARTH_PORT_GOTRUE" start_service gotrue "$EARTH_BIN_DIR/gotrue" serve
if (( WITH_WEB )); then
  (cd "$EARTH_REPO_ROOT" && start_service web pnpm --filter earth-web dev --port "$EARTH_PORT_WEB")
fi

# --- 7. health ---------------------------------------------------------------------------------
log "waiting for services"
probe="http://$EARTH_PROBE_HOST"
wait_http mailpit "$probe:$EARTH_PORT_MAILPIT_HTTP/api/v1/info"
wait_http livekit "$probe:$EARTH_PORT_LIVEKIT/"
wait_http postgrest "$probe:$EARTH_PORT_POSTGREST/"
wait_http gotrue "$probe:$EARTH_PORT_GOTRUE/health"
wait_http gateway "$probe:$EARTH_PORT_GATEWAY/rest/v1/"
wait_http gateway "$probe:$EARTH_PORT_GATEWAY/auth/v1/health"
if (( WITH_WEB )); then
  wait_http web "$probe:$EARTH_PORT_WEB/api/health" 180
fi

# --- 8. summary --------------------------------------------------------------------------------
earth_write_stack_env
cat <<SUMMARY

Earth local stack is up.
  Supabase URL (gateway)  $EARTH_SUPABASE_URL   -> /rest/v1 PostgREST ($EARTH_PORT_POSTGREST), /auth/v1 GoTrue ($EARTH_PORT_GOTRUE)
  Postgres                $DATABASE_URL
  LiveKit                 $EARTH_LIVEKIT_URL   (dev keys: $LIVEKIT_API_KEY / $LIVEKIT_API_SECRET)
  Mailpit                 $EARTH_MAILPIT_URL   (SMTP $EARTH_PORT_MAILPIT_SMTP; OTP codes: bash scripts/local-stack/otp.sh <email>)
  Web                     $EARTH_WEB_URL   $([[ $WITH_WEB == 1 ]] && echo '(running)' || echo '(start with pnpm dev:web or --with-web)')
  Env for apps            $EARTH_STACK_ENV_FILE
  Not available locally   Supabase Storage (501) and Realtime (503; clients fall back to polling)
  Logs / pids             $EARTH_LOG_DIR / $EARTH_PID_DIR   stop: pnpm stack:down
SUMMARY
