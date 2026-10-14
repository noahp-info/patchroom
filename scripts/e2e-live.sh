#!/usr/bin/env bash
# Live "both" script for Patchroom P2: the real claude CLI (haiku) behind the real UI.
#
# Builds a debug app with the in-app e2e runner, runs ui/src/e2e/both.script.js inside the app
# (DOM events on the real controls; works with the screen locked), then checks what only the
# shell can see: leftover claude and hook processes after quit, and config file checksums.
# Prints a pass/fail table and the report path. Exit 0 only when every row passes.
#
# Usage: scripts/e2e-live.sh            build, run, report
#        E2E_SKIP_BUILD=1 scripts/e2e-live.sh   reuse the last e2e build
#        E2E_TIMEOUT=900 ...            seconds before the run is killed
#
# Everything runs in temp dirs under $E2E_BASE (default /tmp/pr-e2e-<pid>) with PATCHROOM_DATA_DIR
# there too. Only `--model haiku` is used. The only network use is claude's own API traffic.
# This script never writes the user's claude settings, shell profiles or ~/.claude.json.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${E2E_BASE:-/tmp/pr-e2e-$$}"  # per-run dir: parallel runs never share or delete each other's files
TIMEOUT="${E2E_TIMEOUT:-900}"
APP="$ROOT/target/debug/bundle/macos/Patchroom.app/Contents/MacOS/patchroom"
SCRIPT="$ROOT/ui/src/e2e/both.script.js"
REPORT="$BASE/report"
export PATH="$HOME/.cargo/bin:$PATH"

[[ "$(uname)" == "Darwin" ]] || { echo "e2e-live: macOS only" >&2; exit 2; }
command -v claude >/dev/null || { echo "e2e-live: claude is not on PATH" >&2; exit 2; }

# ---- temp dirs ------------------------------------------------------------------------------------
case "$BASE" in /tmp/*) ;; *) echo "e2e-live: E2E_BASE must be under /tmp" >&2; exit 2 ;; esac
rm -rf "$BASE"
mkdir -p "$BASE/alpha" "$BASE/beta" "$BASE/data" "$REPORT"

# ---- build ------------------------------------------------------------------------------------------
if [[ "${E2E_SKIP_BUILD:-0}" != "1" ]]; then
  echo "e2e-live: building the debug app with the e2e runner"
  (cd "$ROOT" && VITE_PR_E2E=1 pnpm tauri build --debug --bundles app) >"$BASE/build.log" 2>&1 \
    || { tail -30 "$BASE/build.log"; echo "e2e-live: build failed" >&2; exit 2; }
fi
[[ -x "$APP" ]] || { echo "e2e-live: no app at $APP" >&2; exit 2; }

# ---- before snapshots ---------------------------------------------------------------------------------
claude_json_view() {
  python3 -I - "$BASE" <<'PY'
import json, os, sys
base = sys.argv[1]
p = os.path.expanduser("~/.claude.json")
try:
    d = json.load(open(p))
except Exception:
    d = {}
projects = d.pop("projects", {}) or {}
# Any e2e-live run's folders count as "mine" (a parallel run adds its own entries meanwhile).
mine = {k: v for k, v in projects.items() if k.startswith(base) or k.startswith("/private" + base) or k.startswith("/tmp/pr-e2e") or k.startswith("/private/tmp/pr-e2e")}
other = {k: v for k, v in projects.items() if k not in mine}
print(json.dumps({"top": d, "other_projects": sorted(other), "mine": sorted(mine)}, sort_keys=True))
PY
}
patchroom_refs() {
  grep -ciE 'patchroom|bridge\.sock' "$HOME/.claude.json" 2>/dev/null || true
}
sums() {
  for f in "$HOME/.claude/settings.json" "$HOME/.bash_profile" "$HOME/.zshrc"; do
    if [[ -e "$f" ]]; then shasum -a 256 "$f"; else echo "absent  $f"; fi
  done
}
sums >"$BASE/sums.before"
claude_json_view >"$BASE/claude-json.before"
patchroom_refs >"$BASE/refs.before"

# Processes of THIS run only: claude or a hook whose cwd is under $BASE, or whose command
# line names this run's data dir ($BASE/data, through --socket or --settings). Another run's
# processes (a second e2e-live, the live_chat tests) match neither.
ours() {
  local pid cwd cmd
  while read -r pid cmd; do
    [[ -n "$pid" ]] || continue
    cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    case "$cwd" in
      "$BASE"/*|"/private$BASE"/*) echo "$pid"; continue ;;
    esac
    case "$cmd" in *"$BASE/data/"*|*"/private$BASE/data/"*) echo "$pid" ;; esac
  done < <(ps -axww -o pid=,command= | grep -E '(^|[ /])claude( |$)|patchroom-hook' | grep -v grep)
}

# ---- run ----------------------------------------------------------------------------------------------------
echo "e2e-live: running the scenario (up to ${TIMEOUT}s)"
PATCHROOM_DATA_DIR="$BASE/data" \
PATCHROOM_E2E_DIR_A="$BASE/alpha" \
PATCHROOM_E2E_DIR_B="$BASE/beta" \
ANTHROPIC_MODEL=haiku \
  "$APP" --e2e-script "$SCRIPT" --e2e-report "$REPORT" \
    --open-dm "$BASE/alpha" --open-dm-arg --model --open-dm-arg haiku \
    --open-dm-arg --permission-mode --open-dm-arg default \
  >"$BASE/app.log" 2>&1 &
APP_PID=$!

start=$SECONDS
timed_out=0
while kill -0 "$APP_PID" 2>/dev/null; do
  if (( SECONDS - start > TIMEOUT )); then
    timed_out=1
    echo "e2e-live: timed out, stopping the app"
    kill "$APP_PID" 2>/dev/null
    break
  fi
  sleep 2
done
wait "$APP_PID" 2>/dev/null
app_status=$?
sleep 2  # let hook and claude processes notice the exit

# ---- after snapshots -----------------------------------------------------------------------------------------
left="$(ours | tr '\n' ' ')"
sums >"$BASE/sums.after"
claude_json_view >"$BASE/claude-json.after"
patchroom_refs >"$BASE/refs.after"
# Clean up anything that survived, after it has been counted.
for pid in $left; do kill "$pid" 2>/dev/null; done

# ---- table ---------------------------------------------------------------------------------------------------------------
python3 -I - "$REPORT/report.json" "$BASE" "$left" "$timed_out" "$app_status" <<'PY'
import json, os, sys

report_path, base, left, timed_out, app_status = sys.argv[1:6]

def read(p):
    try:
        return open(p).read()
    except OSError:
        return ""

rows = []
try:
    rep = json.load(open(report_path))
except Exception as e:
    rep = {"steps": [], "done": False, "facts": {}}
    rows.append(("report written", False, f"no readable report: {e}"))

for s in rep["steps"]:
    rows.append((s["name"], s["ok"], s["detail"]))
if rep.get("steps") and not rep.get("done"):
    rows.append(("scenario finished", False, "the report is not marked done"))
if timed_out == "1":
    rows.append(("finished before timeout", False, "killed after the timeout"))

rows.append(("quit leaves no claude or hook process", left.strip() == "", f"left: {left.strip() or 'none'}"))

before, after = read(f"{base}/sums.before"), read(f"{base}/sums.after")
rows.append(("settings.json, .bash_profile, .zshrc unchanged", before == after and before != "", "checksums identical" if before == after else "CHECKSUM CHANGED"))

cb = json.loads(read(f"{base}/claude-json.before") or "{}")
ca = json.loads(read(f"{base}/claude-json.after") or "{}")
refs_b, refs_a = read(f"{base}/refs.before").strip(), read(f"{base}/refs.after").strip()
rows.append((".claude.json has no Patchroom references", refs_a == refs_b, f"matches before={refs_b} after={refs_a}"))
changed = sorted(k for k in set(cb.get("top", {})) | set(ca.get("top", {})) if cb.get("top", {}).get(k) != ca.get("top", {}).get(k))
extra_projects = sorted(set(ca.get("other_projects", [])) ^ set(cb.get("other_projects", [])))
rows.append((".claude.json: only the DM folders' entries are new", not extra_projects,
             f"mine={len(ca.get('mine', []))} folders; other new/removed projects={extra_projects or 'none'}; other top-level keys claude itself touched={changed or 'none'}"))

w = max(len(r[0]) for r in rows) if rows else 10
print()
print(f"{'CHECK'.ljust(w)}  RESULT  DETAIL")
for name, ok, detail in rows:
    print(f"{name.ljust(w)}  {'PASS  ' if ok else 'FAIL  '}  {detail[:160]}")
passed = sum(1 for r in rows if r[1])
print()
print(f"{passed}/{len(rows)} passed")
facts = rep.get("facts", {})
if facts.get("probe") or facts.get("visibilityStateReal"):
    print(f"webview while the screen state was in effect: visibilityState={facts.get('visibilityStateReal')} hasFocus={facts.get('hasFocus')} probe={json.dumps(facts.get('probe'))}")
print(f"report:   {report_path}")
print(f"app log:  {base}/app.log")
print(f"DOM snapshots: {os.path.dirname(report_path)}/dom-*.html")
sys.exit(0 if passed == len(rows) else 1)
PY
