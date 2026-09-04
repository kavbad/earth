#!/usr/bin/env bash
# Quiets the Postgres service container's log so a failing CI job stays diagnosable.
#
# The runner prints the whole service-container log during post-job cleanup, after every step. Earth
# asserts refusals on purpose — hundreds in the database suite, dozens per Playwright journey — and
# Postgres logs an ERROR/CONTEXT/STATEMENT triplet for each, so that dump ran past 600k characters
# and buried the test output the job actually failed on.
#
# Usage: bash scripts/ci/quiet-postgres.sh   (PGHOST/PGPORT/PGUSER/PGPASSWORD as usual)
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGPASSWORD:=postgres}"
export PGHOST PGUSER PGPASSWORD

psql -d postgres -v ON_ERROR_STOP=1 <<'SQL'
alter system set log_checkpoints = off;
alter system set log_min_messages = fatal;
alter system set log_min_error_statement = fatal;
alter system set log_statement = 'none';
alter system set log_connections = off;
alter system set log_disconnections = off;
SQL
psql -d postgres -v ON_ERROR_STOP=1 -c 'select pg_reload_conf()'
