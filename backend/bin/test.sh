#!/usr/bin/env bash
set -euo pipefail
umask 077

BACKEND_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PYTHON="${PYTHON:-$BACKEND_DIR/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
    printf '%s\n' 'Set PYTHON to the backend virtual-environment interpreter.' >&2
    exit 1
fi
"$PYTHON" -c 'import sys; assert sys.version_info[:3] == (3, 10, 12), "backend requires CPython 3.10.12"'

TEST_KB_ROOT="${HIS_APP_TEST_KB_ROOT:-$HOME/.cache/hardviser-test/knowledge-base}"
TEST_KB_ROOT="$("$PYTHON" - "$TEST_KB_ROOT" <<'PY'
from pathlib import Path
import sys

home = Path.home().resolve()
root = Path(sys.argv[1]).expanduser().resolve()
try:
    root.relative_to(home)
except (OSError, RuntimeError, ValueError):
    raise SystemExit(1)
if root == home:
    raise SystemExit(1)
print(root)
PY
)" || { printf '%s\n' 'HIS_APP_TEST_KB_ROOT must resolve under the current user home.' >&2; exit 1; }
if [[ -e "$TEST_KB_ROOT/runtime/postgres/connection.json" || -L "$TEST_KB_ROOT/runtime/postgres/connection.json" ]]; then
    printf '%s\n' 'Refusing a test KB root containing PostgreSQL connection configuration.' >&2
    exit 1
fi

# Retrieval requires an explicit removal-request list; the empty test KB declares none.
REQUEST_IDENTIFIERS_FILE="$TEST_KB_ROOT/config/privacy-request-identifiers.json"
if [[ ! -e "$REQUEST_IDENTIFIERS_FILE" ]]; then
    mkdir -p "$TEST_KB_ROOT/config"
    printf '%s\n' '[]' > "$REQUEST_IDENTIFIERS_FILE"
fi

# Never inherit production app, bridge, billing, or libpq configuration into tests.
unset HIS_APP_DB_HOST HIS_APP_DB_PORT HIS_APP_DB_NAME HIS_APP_DB_USER HIS_APP_DB_PASSWORD HIS_APP_DATA_ROOT
unset HIS_KB_ROOT HIS_KB_PUBLIC_CHAT_STATE_DB HIS_KB_PUBLIC_CHAT_OWNER_EXCEPTION
unset HIS_KB_PUBLIC_CHAT_RELEASE_ID HIS_KB_PUBLIC_CHAT_COLLECTIONS
unset SEVERUS_RAG_BRIDGE_HMAC_KEY SEVERUS_RAG_BRIDGE_HOST SEVERUS_RAG_BRIDGE_PORT MODEL_API_KEY
unset REVENUECAT_ENVIRONMENT REVENUECAT_API_KEY REVENUECAT_PROJECT_ID REVENUECAT_APP_ID
unset HIS_APP_BACKUP_DB_HOST HIS_APP_BACKUP_DB_PORT HIS_APP_BACKUP_DB_NAME HIS_APP_BACKUP_DB_USER
unset HIS_APP_BACKUP_CONFIG_FILE HIS_APP_BACKUP_PG_DUMP HIS_APP_BACKUP_AGE HIS_APP_BACKUP_RCLONE
unset HIS_APP_BACKUP_AGE_RECIPIENT HIS_APP_BACKUP_RCLONE_DESTINATION CREDENTIALS_DIRECTORY RCLONE_CONFIG
unset PGPASSWORD PGHOST PGPORT PGDATABASE PGUSER PGOPTIONS PGSERVICE PGSERVICEFILE PGSSLMODE

export HIS_APP_TEST_DATABASE=hardissoft_app_test
export HIS_APP_TEST_HOST="${HIS_APP_TEST_HOST:-127.0.0.1}"
export HIS_APP_TEST_PORT="${HIS_APP_TEST_PORT:-5432}"
export HIS_APP_TEST_USER=app_runtime
export HIS_APP_TEST_ADMIN_USER="${HIS_APP_TEST_ADMIN_USER:-postgres}"
export HIS_KB_ROOT="$TEST_KB_ROOT"
export XDG_DATA_HOME="$TEST_KB_ROOT/xdg-data"
export PYTHONPATH="$BACKEND_DIR/vendor/knowledge-base/src:$BACKEND_DIR"
export TOKENIZERS_PARALLELISM=false
exec "$PYTHON" -m pytest -q "$BACKEND_DIR/tests"
