#!/usr/bin/env bash
# Create the pinned pyte virtualenv used by the fidelity test as its reference emulator.
# Usage: ui/tests/tools/setup_pyte.sh   (idempotent)
# The venv lands in ui/node_modules/.pyte-venv so lint and prettier never scan it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
venv="$here/../../node_modules/.pyte-venv"
python="${PYTHON:-python3}"
"$python" -m venv "$venv"
"$venv/bin/python" -m pip install --quiet --disable-pip-version-check -r "$here/requirements.txt"
"$venv/bin/python" -I -c "import pyte" && echo "pyte venv ready at $venv"
