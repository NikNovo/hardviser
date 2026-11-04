#!/usr/bin/env bash
set -euo pipefail
umask 077

BACKEND_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DOCKER="${DOCKER:-$(command -v docker || true)}"
if [[ -z "$DOCKER" || ! -x "$DOCKER" ]]; then
    printf '%s\n' 'Docker is required for the isolated PostgreSQL guard smoke.' >&2
    exit 1
fi

CONTAINER="hardviser-bootstrap-guard-$$-$RANDOM-$RANDOM"
container_created=false
cleanup() {
    if [[ "$container_created" == true ]]; then
        "$DOCKER" rm --force "$CONTAINER" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT INT TERM

"$DOCKER" run --detach --rm --name "$CONTAINER" \
    --volume "$BACKEND_DIR:/candidate/backend:ro" \
    --env POSTGRES_HOST_AUTH_METHOD=trust \
    pgvector/pgvector:pg16 >/dev/null
container_created=true

ready=false
for ((attempt=0; attempt < 60; attempt++)); do
    if "$DOCKER" exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
        ready=true
        break
    fi
    sleep 1
done
if [[ "$ready" != true ]]; then
    printf '%s\n' 'The isolated PostgreSQL guard fixture did not become ready.' >&2
    exit 1
fi

psql() {
    "$DOCKER" exec "$CONTAINER" psql -X -w -v ON_ERROR_STOP=1 -U postgres "$@"
}
run_bootstrap() {
    "$DOCKER" exec \
        --env HIS_APP_TEST_DATABASE=hardissoft_app_test \
        --env HIS_APP_TEST_HOST=127.0.0.1 \
        --env HIS_APP_TEST_PORT=5432 \
        --env HIS_APP_TEST_ADMIN_USER=postgres \
        "$CONTAINER" bash /candidate/backend/bin/test-postgres-bootstrap.sh
}

# A pre-existing role with elevated attributes must be refused without alteration.
psql -d postgres -c 'CREATE ROLE app_runtime LOGIN CREATEDB CREATEROLE' >/dev/null
before="$(psql -d postgres -Atq -c \
    "SELECT rolcanlogin::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text || '|' || rolsuper::text || '|' || rolreplication::text || '|' || rolbypassrls::text FROM pg_roles WHERE rolname='app_runtime'")"
if [[ "$before" != 'true|true|true|false|false|false' ]]; then
    printf '%s\n' 'Could not establish the disposable role guard fixture.' >&2
    exit 1
fi
if run_bootstrap >/dev/null 2>&1; then
    printf '%s\n' 'Bootstrap unexpectedly accepted a pre-existing application role.' >&2
    exit 1
fi
after="$(psql -d postgres -Atq -c \
    "SELECT rolcanlogin::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text || '|' || rolsuper::text || '|' || rolreplication::text || '|' || rolbypassrls::text FROM pg_roles WHERE rolname='app_runtime'")"
if [[ "$after" != "$before" ]]; then
    printf '%s\n' 'Bootstrap changed a pre-existing application role.' >&2
    exit 1
fi
if [[ "$(psql -d postgres -Atq -c \
    "SELECT count(*) FROM pg_roles WHERE rolname='app_owner'")" != 0 || \
    "$(psql -d postgres -Atq -c \
    "SELECT count(*) FROM pg_database WHERE datname='hardissoft_app_test'")" != 0 ]]; then
    printf '%s\n' 'Bootstrap created application state before refusing the pre-existing role.' >&2
    exit 1
fi

# A cluster containing an unrelated database must also be refused before roles are created.
psql -d postgres -c 'DROP ROLE app_runtime' >/dev/null
psql -d postgres -c 'CREATE DATABASE hardviser_guard_unrelated' >/dev/null
if run_bootstrap >/dev/null 2>&1; then
    printf '%s\n' 'Bootstrap unexpectedly accepted an unrelated application database.' >&2
    exit 1
fi
if [[ "$(psql -d postgres -Atq -c \
    "SELECT count(*) FROM pg_roles WHERE rolname IN ('app_owner','app_runtime')")" != 0 || \
    "$(psql -d postgres -Atq -c \
    "SELECT count(*) FROM pg_database WHERE datname='hardissoft_app_test'")" != 0 ]]; then
    printf '%s\n' 'Bootstrap created application state before refusing the unrelated database.' >&2
    exit 1
fi

printf '%s\n' 'Bootstrap guard smoke passed: both unsafe cluster states were refused without role or test-database changes.'
