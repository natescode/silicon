#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT=/home/natescode/repos/sigil
cd "$PROJECT_ROOT"
SRC_DIR=boot/strata/builtin
OUT=boot/embedded_bundle.si

escape_for_silicon() {
  awk 'BEGIN { RS = "\0" }
       {
         gsub(/\\/, "\\\\");
         gsub(/'\''/, "\\'\''" );
         gsub(/\n/, "\\n");
         gsub(/\r/, "\\r");
         gsub(/\t/, "\\t");
         gsub(/\0/, "\\0");
         printf "%s", $0
       }' "$1"
}

{
  printf "@let EMBEDDED_BUNDLE:String := '"
  first=1
  for f in $(ls "$SRC_DIR"/*.si | sort); do
    if [ "$first" != "1" ]; then
      printf '\\n'
    fi
    first=0
    escape_for_silicon "$f"
    printf '\\n'
  done
  printf "';\n"
} > "$OUT"

echo "Generated $OUT ($(wc -c < "$OUT") bytes)"
