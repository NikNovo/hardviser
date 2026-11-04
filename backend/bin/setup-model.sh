#!/usr/bin/env bash
set -euo pipefail
umask 077

BACKEND_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PYTHON="${PYTHON:-$BACKEND_DIR/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
    printf '%s\n' 'Set PYTHON to the CPython 3.10.12 virtual-environment interpreter.' >&2
    exit 1
fi
"$PYTHON" -c 'import sys; assert sys.version_info[:3] == (3, 10, 12), "backend requires CPython 3.10.12"'

DEFAULT_ROOT="$HOME/.local/share/hardviser/knowledge-base"
KB_ROOT="${HIS_APP_TEST_KB_ROOT:-${HIS_KB_ROOT:-$DEFAULT_ROOT}}"
KB_ROOT="$("$PYTHON" - "$KB_ROOT" <<'PY'
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
)" || { printf '%s\n' 'Model preparation is restricted to a user-local HIS_KB_ROOT.' >&2; exit 1; }
if [[ -e "$KB_ROOT/runtime/postgres/connection.json" || -L "$KB_ROOT/runtime/postgres/connection.json" ]]; then
    printf '%s\n' 'Refusing a KB root containing PostgreSQL connection configuration.' >&2
    exit 1
fi

export HIS_KB_ROOT="$KB_ROOT"
export PYTHONPATH="$BACKEND_DIR/vendor/knowledge-base/src"
exec "$PYTHON" -m hardissoft_kb.search.vector prepare
