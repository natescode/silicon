#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT=/home/natescode/repos/sigil
exec bash <(sed 's/\r//' "$PROJECT_ROOT/test.sh") "$@"
