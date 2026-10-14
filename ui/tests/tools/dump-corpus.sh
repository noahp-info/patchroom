#!/usr/bin/env bash
# Build the UI corpus cache: run `patchroom-claude dump` over the local transcript corpus.
#
# Usage: ui/tests/tools/dump-corpus.sh
#
# Corpus: the 40 most recent transcripts over 2 KB under ~/.claude/projects, plus older ones until
# every line type, content block, system subtype and tool in the bar is covered (corpus_select.py).
# Output: ui/node_modules/.cache/patchroom-corpus/<file-stem>.json, one `{"items","accounting"}` per
# transcript, plus summary.txt (counts only). The directory is gitignored. The corpus is local only:
# nothing derived from it is ever committed, and CI has no corpus (the corpus test then skips).
#
# Environment:
#   PR_CORPUS_ROOT   transcripts root (default ~/.claude/projects)
#   PR_CORPUS_DIR    output dir (default ui/node_modules/.cache/patchroom-corpus)
#   PR_CORPUS_COUNT  number of most recent transcripts (default 40)
#
# Exit code: 0 when every dump ran with errors=0, 1 otherwise.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
ui="$(cd "$here/../.." && pwd)"
repo="$(cd "$ui/.." && pwd)"
root="${PR_CORPUS_ROOT:-$HOME/.claude/projects}"
out="${PR_CORPUS_DIR:-$ui/node_modules/.cache/patchroom-corpus}"
count="${PR_CORPUS_COUNT:-40}"
python="${PYTHON:-python3}"
export PATH="$HOME/.cargo/bin:$PATH"

if [ ! -d "$root" ]; then
  echo "no corpus at $root" >&2
  exit 1
fi

mkdir -p "$out"
rm -f "$out"/*.json "$out"/summary.txt

list="$(mktemp)"
trap 'rm -f "$list"' EXIT
"$python" -I "$here/corpus_select.py" "$root" "$count" > "$list"
total="$(wc -l < "$list" | tr -d ' ')"
if [ "$total" -eq 0 ]; then
  echo "no transcripts over 2 KB under $root" >&2
  exit 1
fi

# Build once so each dump is just the binary start-up.
(cd "$repo" && cargo build -q -p patchroom-claude --bin patchroom-claude)

failed=0
n=0
sum_lines=0
sum_hidden=0
sum_fallback=0
sum_errors=0
summary="$out/summary.txt"
: > "$summary"
while IFS= read -r transcript; do
  stem="$(basename "$transcript" .jsonl)"
  n=$((n + 1))
  err="$(mktemp)"
  if ! (cd "$repo" && cargo run -q -p patchroom-claude --bin patchroom-claude -- dump "$transcript") > "$out/$stem.json" 2> "$err"; then
    echo "dump failed for transcript $n of $total" >&2
    rm -f "$out/$stem.json" "$err"
    failed=1
    continue
  fi
  line="$(head -n 1 "$err")"
  rm -f "$err"
  echo "$n $stem $line" >> "$summary"
  eval "$(echo "$line" | sed -E 's/([a-z]+)=([0-9]+)/v_\1=\2;/g')"
  sum_lines=$((sum_lines + v_lines))
  sum_hidden=$((sum_hidden + v_hidden))
  sum_fallback=$((sum_fallback + v_fallback))
  sum_errors=$((sum_errors + v_errors))
  if [ "$v_errors" -ne 0 ]; then
    echo "errors=$v_errors in transcript $n ($stem)" >&2
    failed=1
  fi
done < "$list"

nonhidden=$((sum_lines - sum_hidden))
pct="n/a"
if [ "$nonhidden" -gt 0 ]; then
  pct="$(awk -v f="$sum_fallback" -v n="$nonhidden" 'BEGIN { printf "%.2f%%", 100 * f / n }')"
fi
echo "total transcripts=$n lines=$sum_lines hidden=$sum_hidden fallback=$sum_fallback errors=$sum_errors fallback_of_non_hidden=$pct" | tee -a "$summary"
echo "dumps in $out"
exit "$failed"
