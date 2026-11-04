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

# The upstream pypdf lock carries its wheel hash; other dependencies are fully version-pinned.
"$PYTHON" -m pip install --only-binary=:all: --require-hashes --no-deps \
    -r "$BACKEND_DIR/vendor/knowledge-base/requirements/documents-pypdf.lock"
"$PYTHON" -m pip install --only-binary=:all: --no-deps \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    -r "$BACKEND_DIR/requirements.lock"
