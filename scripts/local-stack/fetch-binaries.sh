#!/usr/bin/env bash
# Downloads the pinned local-stack binaries into .local/bin (ARCHITECTURE.md §15).
#
#   bash scripts/local-stack/fetch-binaries.sh          # skips anything already present at the pinned version
#   FORCE=1 bash scripts/local-stack/fetch-binaries.sh  # re-download everything
#
# Binaries: PostgREST, GoTrue (Supabase Auth, plus its SQL migrations), LiveKit server, Mailpit.
# Linux x86_64 only: these are the release assets CI and the sandbox use. Postgres itself is the
# system service (see up.sh).
set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$STACK_DIR/../.." && pwd)"
LOCAL_DIR="$REPO_ROOT/.local"
BIN_DIR="$LOCAL_DIR/bin"
GOTRUE_DIR="$LOCAL_DIR/gotrue"
TMP_DIR="$LOCAL_DIR/tmp"

# Pinned versions (ARCHITECTURE.md §15). Bump here and in README.md together.
POSTGREST_VERSION="13.0.4"
GOTRUE_VERSION="2.185.0"
LIVEKIT_VERSION="1.9.1"
MAILPIT_VERSION="1.28.0"

POSTGREST_URL="https://github.com/PostgREST/postgrest/releases/download/v${POSTGREST_VERSION}/postgrest-v${POSTGREST_VERSION}-linux-static-x86-64.tar.xz"
GOTRUE_URL="https://github.com/supabase/auth/releases/download/v${GOTRUE_VERSION}/auth-v${GOTRUE_VERSION}-x86.tar.gz"
LIVEKIT_URL="https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz"
MAILPIT_URL="https://github.com/axllent/mailpit/releases/download/v${MAILPIT_VERSION}/mailpit-linux-amd64.tar.gz"

FORCE="${FORCE:-0}"

log() { printf '[fetch-binaries] %s\n' "$*"; }
die() { printf '[fetch-binaries] ERROR: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) ;;
  *) die "only Linux x86_64 release assets are pinned (got $(uname -s)/$(uname -m)); install the binaries into $BIN_DIR by hand" ;;
esac

command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"
command -v xz >/dev/null || die "xz is required (PostgREST ships as .tar.xz)"

mkdir -p "$BIN_DIR" "$GOTRUE_DIR" "$TMP_DIR"

# is_current <name> <version>: true when the binary exists and its version stamp matches.
is_current() {
  local name="$1" version="$2"
  [[ "$FORCE" != "1" ]] && [[ -x "$BIN_DIR/$name" ]] && [[ -f "$BIN_DIR/$name.version" ]] \
    && [[ "$(cat "$BIN_DIR/$name.version")" == "$version" ]]
}

download() {
  local url="$1" out="$2"
  log "downloading $url"
  curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$url"
}

install_postgrest() {
  is_current postgrest "$POSTGREST_VERSION" && { log "postgrest $POSTGREST_VERSION present"; return; }
  local archive="$TMP_DIR/postgrest.tar.xz" extract="$TMP_DIR/postgrest"
  download "$POSTGREST_URL" "$archive"
  rm -rf "$extract" && mkdir -p "$extract"
  tar -xJf "$archive" -C "$extract"
  install -m 0755 "$extract/postgrest" "$BIN_DIR/postgrest"
  echo "$POSTGREST_VERSION" > "$BIN_DIR/postgrest.version"
}

install_gotrue() {
  is_current gotrue "$GOTRUE_VERSION" && [[ -d "$GOTRUE_DIR/migrations" ]] \
    && { log "gotrue $GOTRUE_VERSION present"; return; }
  local archive="$TMP_DIR/gotrue.tar.gz" extract="$TMP_DIR/gotrue"
  download "$GOTRUE_URL" "$archive"
  rm -rf "$extract" && mkdir -p "$extract"
  tar -xzf "$archive" -C "$extract"
  install -m 0755 "$extract/auth" "$BIN_DIR/gotrue"
  rm -rf "$GOTRUE_DIR/migrations"
  cp -R "$extract/migrations" "$GOTRUE_DIR/migrations"
  echo "$GOTRUE_VERSION" > "$BIN_DIR/gotrue.version"
}

install_livekit() {
  is_current livekit-server "$LIVEKIT_VERSION" && { log "livekit-server $LIVEKIT_VERSION present"; return; }
  local archive="$TMP_DIR/livekit.tar.gz" extract="$TMP_DIR/livekit"
  download "$LIVEKIT_URL" "$archive"
  rm -rf "$extract" && mkdir -p "$extract"
  tar -xzf "$archive" -C "$extract"
  install -m 0755 "$extract/livekit-server" "$BIN_DIR/livekit-server"
  echo "$LIVEKIT_VERSION" > "$BIN_DIR/livekit-server.version"
}

install_mailpit() {
  is_current mailpit "$MAILPIT_VERSION" && { log "mailpit $MAILPIT_VERSION present"; return; }
  local archive="$TMP_DIR/mailpit.tar.gz" extract="$TMP_DIR/mailpit"
  download "$MAILPIT_URL" "$archive"
  rm -rf "$extract" && mkdir -p "$extract"
  tar -xzf "$archive" -C "$extract"
  install -m 0755 "$extract/mailpit" "$BIN_DIR/mailpit"
  echo "$MAILPIT_VERSION" > "$BIN_DIR/mailpit.version"
}

install_postgrest
install_gotrue
install_livekit
install_mailpit
rm -rf "$TMP_DIR"

log "installed in $BIN_DIR:"
printf '  postgrest       %s\n' "$("$BIN_DIR/postgrest" --version 2>&1 | head -n 1)"
printf '  gotrue          %s\n' "$("$BIN_DIR/gotrue" version 2>&1 | head -n 1)"
printf '  livekit-server  %s\n' "$("$BIN_DIR/livekit-server" --version 2>&1 | head -n 1)"
printf '  mailpit         %s\n' "$("$BIN_DIR/mailpit" version 2>&1 | head -n 1)"
printf '  gotrue migrations: %s files in %s\n' "$(find "$GOTRUE_DIR/migrations" -name '*.sql' | wc -l | tr -d ' ')" "$GOTRUE_DIR/migrations"
