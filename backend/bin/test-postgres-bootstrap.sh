#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly TEST_DATABASE='hardissoft_app_test'
if [[ "${HIS_APP_TEST_DATABASE:-}" != "$TEST_DATABASE" ]]; then
    printf '%s\n' 'Set HIS_APP_TEST_DATABASE=hardissoft_app_test; this script only provisions that disposable database.' >&2
    exit 1
fi
TEST_HOST="${HIS_APP_TEST_HOST:-127.0.0.1}"
case "$TEST_HOST" in
    127.0.0.1|::1|localhost) ;;
    *) printf '%s\n' 'HIS_APP_TEST_HOST must be a loopback address.' >&2; exit 1 ;;
esac
TEST_PORT="${HIS_APP_TEST_PORT:-5432}"
if [[ ! "$TEST_PORT" =~ ^[0-9]+$ ]] || (( TEST_PORT < 1 || TEST_PORT > 65535 )); then
    printf '%s\n' 'HIS_APP_TEST_PORT must be in 1..65535.' >&2
    exit 1
fi
ADMIN_USER="${HIS_APP_TEST_ADMIN_USER:-postgres}"
if [[ -z "$ADMIN_USER" || "$ADMIN_USER" == 'app_runtime' ]]; then
    printf '%s\n' 'HIS_APP_TEST_ADMIN_USER must be a separate local PostgreSQL superuser.' >&2
    exit 1
fi
PSQL_BIN="${HIS_APP_TEST_PSQL:-$(command -v psql || true)}"
if [[ -z "$PSQL_BIN" || ! -x "$PSQL_BIN" ]]; then
    printf '%s\n' 'psql is unavailable; install PostgreSQL client tools.' >&2
    exit 1
fi

# The bootstrap is fresh-cluster-only. These checks are read-only and must all pass before DDL.
unset PGPASSWORD PGHOST PGPORT PGDATABASE PGUSER PGOPTIONS PGSERVICE PGSERVICEFILE PGSSLMODE PGPASSFILE
PSQL=("$PSQL_BIN" -X -w -v ON_ERROR_STOP=1 -h "$TEST_HOST" -p "$TEST_PORT" -U "$ADMIN_USER")
BACKEND_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
MIGRATION_DIR="$BACKEND_DIR/migrations"

existing_test_database="$("${PSQL[@]}" -d postgres -Atq -c \
    "SELECT count(*) FROM pg_database WHERE datname='$TEST_DATABASE'")"
if [[ "$existing_test_database" != 0 ]]; then
    printf '%s\n' 'Refusing to adopt an existing hardissoft_app_test database; use a fresh disposable cluster.' >&2
    exit 1
fi
non_system_databases="$("${PSQL[@]}" -d postgres -Atq -c \
    "SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')")"
if [[ "$non_system_databases" != 0 ]]; then
    printf '%s\n' 'Refusing a PostgreSQL cluster with existing non-system databases; use a fresh disposable cluster.' >&2
    exit 1
fi
application_roles="$("${PSQL[@]}" -d postgres -Atq -c \
    "SELECT count(*) FROM pg_roles WHERE rolname IN ('app_owner','app_runtime')")"
if [[ "$application_roles" != 0 ]]; then
    printf '%s\n' 'Refusing to alter pre-existing app_owner or app_runtime roles; use a fresh disposable cluster.' >&2
    exit 1
fi

server_version_num="$("${PSQL[@]}" -d postgres -Atq -c "SELECT current_setting('server_version_num')")"
if [[ ! "$server_version_num" =~ ^[0-9]+$ ]] \
    || (( server_version_num < 160000 || server_version_num >= 170000 )); then
    printf '%s\n' 'The disposable test cluster must run PostgreSQL 16.' >&2
    exit 1
fi
admin_is_superuser="$("${PSQL[@]}" -d postgres -Atq -c \
    "SELECT rolsuper::text FROM pg_roles WHERE rolname=current_user")"
if [[ "$admin_is_superuser" != true ]]; then
    printf '%s\n' 'The disposable test-cluster administrator must be a PostgreSQL superuser.' >&2
    exit 1
fi
vector_extension_available="$("${PSQL[@]}" -d postgres -Atq -c \
    "SELECT count(*) FROM pg_available_extensions WHERE name='vector'")"
if [[ "$vector_extension_available" != 1 ]]; then
    printf '%s\n' 'The disposable PostgreSQL cluster must provide the vector extension.' >&2
    exit 1
fi

"${PSQL[@]}" -d postgres <<'SQL'
CREATE ROLE app_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE app_runtime LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE hardissoft_app_test OWNER app_owner;
SQL

"${PSQL[@]}" -d "$TEST_DATABASE" -c 'CREATE EXTENSION IF NOT EXISTS vector'
"${PSQL[@]}" -d "$TEST_DATABASE" -c 'SET ROLE app_owner' \
    -c 'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'

for migration in "$MIGRATION_DIR"/*.sql; do
    version="${migration##*/}"
    if [[ "$("${PSQL[@]}" -d "$TEST_DATABASE" -Atq -c \
        "SELECT 1 FROM schema_migrations WHERE version='$version'")" == '1' ]]; then
        continue
    fi
    "${PSQL[@]}" -d "$TEST_DATABASE" -c 'SET ROLE app_owner' -c 'BEGIN' \
        -f "$migration" \
        -c "INSERT INTO schema_migrations(version) VALUES ('$version')" -c 'COMMIT'
done

"${PSQL[@]}" -d "$TEST_DATABASE" <<'SQL'
SET ROLE app_owner;
REVOKE CREATE,TEMP ON DATABASE hardissoft_app_test FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE hardissoft_app_test TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
REVOKE ALL ON admin_audit FROM app_runtime;
GRANT SELECT,INSERT ON admin_audit TO app_runtime;
SQL

printf '%s\n' 'Provisioned disposable database hardissoft_app_test with all backend migrations.'
