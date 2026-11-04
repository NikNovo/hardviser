#!/usr/bin/env bash
set -euo pipefail
umask 077

export PYTHONDONTWRITEBYTECODE=1
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PYTHON="${PYTHON:-$SCRIPT_DIR/../.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
    printf '%s\n' 'Set PYTHON to the backend virtual-environment interpreter.' >&2
    exit 1
fi
exec "$PYTHON" "$SCRIPT_DIR/app-backup-snapshot.py"
