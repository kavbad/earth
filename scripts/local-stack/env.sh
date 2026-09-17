#!/usr/bin/env bash
# Local stack configuration (ARCHITECTURE.md §15).
#
#   source scripts/local-stack/env.sh
#
# Exports every variable the stack processes (PostgREST, GoTrue, LiveKit, Mailpit, gateway) and the
# apps need, and writes the app-facing subset to .local/stack.env (dotenv) for `pnpm --filter
# earth-web dev`, e2e and editors. Safe under `set -euo pipefail`; every EARTH_* knob can be
# overridden by exporting it before sourcing. Ports mirror @earth/config LOCAL_PORTS and
# supabase/config.toml (scripts/local-stack/env.test.ts asserts the parity).

EARTH_STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EARTH_REPO_ROOT="$(cd "$EARTH_STACK_DIR/../.." && pwd)"
EARTH_LOCAL_DIR="$EARTH_REPO_ROOT/.local"
EARTH_BIN_DIR="$EARTH_LOCAL_DIR/bin"
EARTH_LOG_DIR="$EARTH_LOCAL_DIR/logs"
EARTH_PID_DIR="$EARTH_LOCAL_DIR/pids"
EARTH_GOTRUE_MIGRATIONS_DIR="$EARTH_LOCAL_DIR/gotrue/migrations"
EARTH_POSTGREST_CONF="$EARTH_LOCAL_DIR/postgrest.conf"
: "${EARTH_STACK_ENV_FILE:=$EARTH_LOCAL_DIR/stack.env}"
export EARTH_STACK_DIR EARTH_REPO_ROOT EARTH_LOCAL_DIR EARTH_BIN_DIR EARTH_LOG_DIR EARTH_PID_DIR
export EARTH_GOTRUE_MIGRATIONS_DIR EARTH_POSTGREST_CONF EARTH_STACK_ENV_FILE

# Runs a TypeScript script with the repository's tsx (root devDependency).
earth_tsx() {
  local tsx="$EARTH_REPO_ROOT/node_modules/.bin/tsx"
  if [[ ! -x "$tsx" ]]; then
    echo "[local-stack] $tsx is missing: run pnpm install first" >&2
    return 1
  fi
  (cd "$EARTH_REPO_ROOT" && "$tsx" "$@")
}

# --- Hosts -----------------------------------------------------------------------------------
# Host written into URLs handed to apps (@earth/config LOCAL_HOST).
: "${EARTH_STACK_HOST:=localhost}"
# Interface the services listen on. Use 0.0.0.0 to reach the stack from a phone on the LAN.
: "${EARTH_BIND_HOST:=127.0.0.1}"
# Loopback address health checks and service-to-service calls use.
: "${EARTH_PROBE_HOST:=127.0.0.1}"
export EARTH_STACK_HOST EARTH_BIND_HOST EARTH_PROBE_HOST

# --- Ports (@earth/config LOCAL_PORTS; gateway = supabase/config.toml [api].port) --------------
: "${EARTH_PORT_WEB:=3000}"
: "${EARTH_PORT_POSTGREST:=3001}"
: "${EARTH_PORT_GOTRUE:=9999}"
: "${EARTH_PORT_LIVEKIT:=7880}"
: "${EARTH_PORT_MAILPIT_SMTP:=1025}"
: "${EARTH_PORT_MAILPIT_HTTP:=8025}"
: "${EARTH_PORT_GATEWAY:=54321}"
export EARTH_PORT_WEB EARTH_PORT_POSTGREST EARTH_PORT_GOTRUE EARTH_PORT_LIVEKIT
export EARTH_PORT_MAILPIT_SMTP EARTH_PORT_MAILPIT_HTTP EARTH_PORT_GATEWAY

# --- Postgres (system service; the stack owns the earth_local database) -----------------------
: "${EARTH_DB_HOST:=127.0.0.1}"
: "${EARTH_DB_PORT:=5432}"
: "${EARTH_DB_NAME:=earth_local}"
: "${EARTH_DB_ADMIN_USER:=postgres}"
: "${EARTH_DB_ADMIN_PASSWORD:=postgres}"
# Password the Supabase shim gives the `authenticator` role (supabase/tests/sql/supabase_shim.sql).
: "${EARTH_DB_AUTHENTICATOR_PASSWORD:=postgres}"
# Debian/Ubuntu cluster up.sh starts when nothing listens on EARTH_DB_PORT.
: "${EARTH_PG_CLUSTER_VERSION:=16}"
: "${EARTH_PG_CLUSTER_NAME:=main}"
export EARTH_DB_HOST EARTH_DB_PORT EARTH_DB_NAME EARTH_DB_ADMIN_USER EARTH_DB_ADMIN_PASSWORD
export EARTH_DB_AUTHENTICATOR_PASSWORD EARTH_PG_CLUSTER_VERSION EARTH_PG_CLUSTER_NAME

EARTH_PG_ADMIN_URL="postgres://$EARTH_DB_ADMIN_USER:$EARTH_DB_ADMIN_PASSWORD@$EARTH_DB_HOST:$EARTH_DB_PORT/postgres"
DATABASE_URL="postgres://$EARTH_DB_ADMIN_USER:$EARTH_DB_ADMIN_PASSWORD@$EARTH_DB_HOST:$EARTH_DB_PORT/$EARTH_DB_NAME"
PGRST_DB_URI="postgres://authenticator:$EARTH_DB_AUTHENTICATOR_PASSWORD@$EARTH_DB_HOST:$EARTH_DB_PORT/$EARTH_DB_NAME"
# GoTrue relies on its role's search_path being `auth` (hosted: supabase_auth_admin); passed as a
# runtime parameter here so its unqualified migrations land in the auth schema.
EARTH_GOTRUE_DB_URL="$DATABASE_URL?search_path=auth"
export EARTH_PG_ADMIN_URL DATABASE_URL PGRST_DB_URI EARTH_GOTRUE_DB_URL

# --- JWT: one dev secret shared by PostgREST, GoTrue and the server tier ----------------------
: "${EARTH_JWT_SECRET:=earth-local-dev-jwt-secret-please-change-0000}"
SUPABASE_JWT_SECRET="$EARTH_JWT_SECRET"
export EARTH_JWT_SECRET SUPABASE_JWT_SECRET
# Supabase-shaped API keys minted from the secret (deterministic; scripts/local-stack/jwt.ts).
SUPABASE_ANON_KEY="$(earth_tsx "$EARTH_STACK_DIR/jwt.ts" mint anon --secret "$SUPABASE_JWT_SECRET")"
SUPABASE_SERVICE_ROLE_KEY="$(earth_tsx "$EARTH_STACK_DIR/jwt.ts" mint service_role --secret "$SUPABASE_JWT_SECRET")"
export SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY

# --- URLs ------------------------------------------------------------------------------------
EARTH_WEB_URL="http://$EARTH_STACK_HOST:$EARTH_PORT_WEB"
EARTH_SUPABASE_URL="http://$EARTH_STACK_HOST:$EARTH_PORT_GATEWAY"
EARTH_POSTGREST_URL="http://$EARTH_STACK_HOST:$EARTH_PORT_POSTGREST"
EARTH_GOTRUE_URL="http://$EARTH_STACK_HOST:$EARTH_PORT_GOTRUE"
EARTH_LIVEKIT_URL="ws://$EARTH_STACK_HOST:$EARTH_PORT_LIVEKIT"
EARTH_MAILPIT_URL="http://$EARTH_STACK_HOST:$EARTH_PORT_MAILPIT_HTTP"
export EARTH_WEB_URL EARTH_SUPABASE_URL EARTH_POSTGREST_URL EARTH_GOTRUE_URL EARTH_LIVEKIT_URL EARTH_MAILPIT_URL

# --- LiveKit dev mode credentials (`livekit-server --dev`) ------------------------------------
LIVEKIT_API_KEY="devkey"
LIVEKIT_API_SECRET="secret"
LIVEKIT_URL="$EARTH_LIVEKIT_URL"
export LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_URL

# --- App environment (@earth/config; ARCHITECTURE.md §14) ------------------------------------
: "${APP_ENV:=development}"
: "${EARTH_MAP_STYLE_URL:=https://demotiles.maplibre.org/style.json}"
export APP_ENV EARTH_MAP_STYLE_URL
for prefix in NEXT_PUBLIC EXPO_PUBLIC; do
  export "${prefix}_SUPABASE_URL=$EARTH_SUPABASE_URL"
  export "${prefix}_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY"
  export "${prefix}_API_BASE_URL=$EARTH_WEB_URL"
  export "${prefix}_LIVEKIT_URL=$EARTH_LIVEKIT_URL"
  export "${prefix}_MAP_STYLE_URL=$EARTH_MAP_STYLE_URL"
  export "${prefix}_APP_ENV=$APP_ENV"
  export "${prefix}_WEB_ORIGIN=$EARTH_WEB_URL"
done
unset prefix
: "${HUMAN_VERIFICATION_PROVIDER:=mock}"
: "${INTERNAL_CRON_SECRET:=earth-local-cron-secret-0000}"
: "${ROOM_GRACE_SECONDS:=120}"
E2E_BASE_URL="$EARTH_WEB_URL"
export HUMAN_VERIFICATION_PROVIDER INTERNAL_CRON_SECRET ROOM_GRACE_SECONDS E2E_BASE_URL

# --- GoTrue (Supabase Auth); values mirror supabase/config.toml [auth] --------------------------
# GoTrue also honours a bare PORT; up.sh passes it inline so it never leaks to Next.js (`next dev` reads PORT too).
# Same interface as every other service (0.0.0.0 only when EARTH_BIND_HOST asks for it).
export GOTRUE_API_HOST="$EARTH_BIND_HOST"
export GOTRUE_API_PORT="$EARTH_PORT_GOTRUE"
export API_EXTERNAL_URL="$EARTH_SUPABASE_URL/auth/v1"
export GOTRUE_API_EXTERNAL_URL="$API_EXTERNAL_URL"
export GOTRUE_DB_DRIVER="postgres"
export GOTRUE_DB_DATABASE_URL="$EARTH_GOTRUE_DB_URL"
export GOTRUE_DB_MIGRATIONS_PATH="$EARTH_GOTRUE_MIGRATIONS_DIR"
export GOTRUE_SITE_URL="$EARTH_WEB_URL"
export GOTRUE_URI_ALLOW_LIST="$EARTH_WEB_URL/**,earth://**"
export GOTRUE_DISABLE_SIGNUP="false"
export GOTRUE_JWT_SECRET="$SUPABASE_JWT_SECRET"
export GOTRUE_JWT_EXP="3600"
# Role GoTrue stores in auth.users.role and puts in the `role` JWT claim; PostgREST switches to it
# and every `to authenticated` policy depends on it (ARCHITECTURE.md §4). Hosted Supabase sets the
# same value. (The deprecation notice GoTrue logs at boot concerns GOTRUE_JWT_ADMIN_GROUP_NAME, not this.)
export GOTRUE_JWT_DEFAULT_GROUP_NAME="authenticated"
export GOTRUE_JWT_ADMIN_ROLES="service_role"
export GOTRUE_JWT_AUD="authenticated"
export GOTRUE_JWT_ISSUER="$API_EXTERNAL_URL"
export GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED="true"
export GOTRUE_EXTERNAL_EMAIL_ENABLED="true"
export GOTRUE_EXTERNAL_PHONE_ENABLED="false"
# supabase/config.toml [auth.email].enable_confirmations = false, i.e. no confirmation step (the
# Supabase CLI sets GOTRUE_MAILER_AUTOCONFIRM to its negation); OTP sign-in still emails the code.
export GOTRUE_MAILER_AUTOCONFIRM="true"
export GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED="true"
export GOTRUE_MAILER_OTP_LENGTH="6"
export GOTRUE_MAILER_OTP_EXP="600"
export GOTRUE_MAILER_URLPATHS_INVITE="/verify"
export GOTRUE_MAILER_URLPATHS_CONFIRMATION="/verify"
export GOTRUE_MAILER_URLPATHS_RECOVERY="/verify"
export GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE="/verify"
# Templates served by the gateway (scripts/local-stack/mail-templates); every one carries {{ .Token }}.
EARTH_MAIL_TEMPLATES_URL="http://$EARTH_PROBE_HOST:$EARTH_PORT_GATEWAY/local/mail-templates"
export EARTH_MAIL_TEMPLATES_URL
export GOTRUE_MAILER_TEMPLATES_INVITE="$EARTH_MAIL_TEMPLATES_URL/invite.html"
export GOTRUE_MAILER_TEMPLATES_CONFIRMATION="$EARTH_MAIL_TEMPLATES_URL/confirmation.html"
export GOTRUE_MAILER_TEMPLATES_RECOVERY="$EARTH_MAIL_TEMPLATES_URL/recovery.html"
export GOTRUE_MAILER_TEMPLATES_MAGIC_LINK="$EARTH_MAIL_TEMPLATES_URL/magic-link.html"
export GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE="$EARTH_MAIL_TEMPLATES_URL/email-change.html"
export GOTRUE_MAILER_TEMPLATES_REAUTHENTICATION="$EARTH_MAIL_TEMPLATES_URL/reauthentication.html"
export GOTRUE_MAILER_SUBJECTS_INVITE="You have been invited to Earth"
export GOTRUE_MAILER_SUBJECTS_CONFIRMATION="Your Earth code: {{ .Token }}"
export GOTRUE_MAILER_SUBJECTS_RECOVERY="Your Earth code: {{ .Token }}"
export GOTRUE_MAILER_SUBJECTS_MAGIC_LINK="Your Earth code: {{ .Token }}"
export GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE="Your Earth code: {{ .Token }}"
export GOTRUE_MAILER_SUBJECTS_REAUTHENTICATION="Your Earth code: {{ .Token }}"
export GOTRUE_SMTP_HOST="$EARTH_PROBE_HOST"
export GOTRUE_SMTP_PORT="$EARTH_PORT_MAILPIT_SMTP"
export GOTRUE_SMTP_ADMIN_EMAIL="noreply@earth.local"
export GOTRUE_SMTP_SENDER_NAME="Earth"
export GOTRUE_SMTP_MAX_FREQUENCY="1s"
export GOTRUE_RATE_LIMIT_EMAIL_SENT="1000"
export GOTRUE_RATE_LIMIT_OTP="1000"
export GOTRUE_RATE_LIMIT_VERIFY="1000"
export GOTRUE_RATE_LIMIT_ANONYMOUS_USERS="1000"
export GOTRUE_RATE_LIMIT_TOKEN_REFRESH="1000"
export GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED="true"
export GOTRUE_LOG_LEVEL="info"

# --- .local/stack.env: the app-facing subset as dotenv ---------------------------------------
EARTH_STACK_ENV_KEYS=(
  APP_ENV
  DATABASE_URL
  PGRST_DB_URI
  NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_API_BASE_URL NEXT_PUBLIC_LIVEKIT_URL
  NEXT_PUBLIC_MAP_STYLE_URL NEXT_PUBLIC_APP_ENV NEXT_PUBLIC_WEB_ORIGIN
  EXPO_PUBLIC_SUPABASE_URL EXPO_PUBLIC_SUPABASE_ANON_KEY EXPO_PUBLIC_API_BASE_URL EXPO_PUBLIC_LIVEKIT_URL
  EXPO_PUBLIC_MAP_STYLE_URL EXPO_PUBLIC_APP_ENV EXPO_PUBLIC_WEB_ORIGIN
  SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET
  LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_URL
  HUMAN_VERIFICATION_PROVIDER INTERNAL_CRON_SECRET ROOM_GRACE_SECONDS
  E2E_BASE_URL
  EARTH_SUPABASE_URL EARTH_WEB_URL EARTH_POSTGREST_URL EARTH_GOTRUE_URL EARTH_LIVEKIT_URL EARTH_MAILPIT_URL
  EARTH_PORT_WEB EARTH_PORT_POSTGREST EARTH_PORT_GOTRUE EARTH_PORT_LIVEKIT
  EARTH_PORT_MAILPIT_SMTP EARTH_PORT_MAILPIT_HTTP EARTH_PORT_GATEWAY
)

earth_write_stack_env() {
  local key value
  mkdir -p "$(dirname "$EARTH_STACK_ENV_FILE")"
  {
    echo "# Generated by scripts/local-stack/env.sh — do not edit; re-run \`pnpm stack:up\`."
    echo "# Values are for the local stack only (ARCHITECTURE.md §15). Never use them in a hosted project."
    for key in "${EARTH_STACK_ENV_KEYS[@]}"; do
      value="${!key}"
      case "$value" in
        *[[:space:]\"\'\\]*)
          echo "[local-stack] refusing to write $key: value contains whitespace or quotes" >&2
          return 1
          ;;
      esac
      echo "$key=$value"
    done
  } > "$EARTH_STACK_ENV_FILE"
}

if [[ "${EARTH_STACK_ENV_NO_WRITE:-0}" != "1" ]]; then
  earth_write_stack_env
fi
