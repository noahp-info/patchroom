#!/usr/bin/env bash
# Live "both" script for Patchroom P2: the real claude CLI (haiku) behind the real UI.
#
# Builds a debug app with the in-app e2e runner, runs ui/src/e2e/both.script.js inside the app
# (DOM events on the real controls; works with the screen locked), then checks what only the
# shell can see: leftover claude and hook processes after quit, and config file checksums.
# Prints a pass/fail table and the report path. Exit 0 only when every row passes.
#
# Two scenarios run, one after the other, each in its own app launch with its own data dir:
#   1. ui/src/e2e/both.script.js     the UI scenario (P1, P1b, P2, P3 Slack layer, folder rows)
#   2. scripts/e2e-backend.script.js the backend scenario: sound-hook detection on the real
#      settings (read only), an unfocused needs-you notification, a folder section over a git
#      repo with live haiku sessions (names, /rename, older-than-X fixture, resume with history,
#      a session started outside Patchroom, a dragged-in DM keeping its pid) and a restart.
# Afterwards a read-only listing of the real gamerNetworking folder runs and the config
# checksums are compared.
#
# Usage: scripts/e2e-live.sh            build, run, report
#        E2E_SKIP_BUILD=1 scripts/e2e-live.sh   reuse the last e2e build
#        E2E_TIMEOUT=900 ...            seconds before each scenario is killed
#        E2E_SCRIPT=/path/to/x.script.js ...   run only this scenario
#        E2E_MAX_RESTARTS=3 ...         how many mid-script restarts are honored per scenario
#
# Restart mid-script: the scenario calls the `e2e_restart` command with a phase name. The app
# quits through its normal quit path, this script relaunches it on the SAME data dir with
# PATCHROOM_E2E_PHASE=<phase> (read it with `e2e_param("phase")`), and the scenario runs again
# from the top, so one run proves what survives a restart (sections, drafts, pins, prefs, the
# search index). Each phase writes its own report (report/, report-2/, ...); the table merges
# them, and the run only passes when the last phase finished. `--open-dm` applies to the first
# phase only. The notification decision log (data/notify-decisions.log) is copied next to the
# report at the end, so it can be read after the screen was locked.
#
# Everything runs in temp dirs under $E2E_BASE (default /tmp/pr-e2e-<pid>) with PATCHROOM_DATA_DIR
# there too. Only `--model haiku` is used. The only network use is claude's own API traffic.
# This script never writes the user's claude settings, shell profiles or ~/.claude.json.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${E2E_BASE:-/tmp/pr-e2e-$$}"  # per-run dir: parallel runs never share or delete each other's files
TIMEOUT="${E2E_TIMEOUT:-900}"
APP="$ROOT/target/debug/bundle/macos/Patchroom.app/Contents/MacOS/patchroom"
if [[ -n "${E2E_SCRIPT:-}" ]]; then
  SCRIPTS=("$E2E_SCRIPT")
else
  SCRIPTS=("$ROOT/ui/src/e2e/both.script.js" "$ROOT/scripts/e2e-backend.script.js")
fi
MAX_RESTARTS="${E2E_MAX_RESTARTS:-3}"
export PATH="$HOME/.cargo/bin:$PATH"

[[ "$(uname)" == "Darwin" ]] || { echo "e2e-live: macOS only" >&2; exit 2; }
command -v claude >/dev/null || { echo "e2e-live: claude is not on PATH" >&2; exit 2; }

# ---- temp dirs ------------------------------------------------------------------------------------
case "$BASE" in /tmp/*) ;; *) echo "e2e-live: E2E_BASE must be under /tmp" >&2; exit 2 ;; esac
rm -rf "$BASE"
mkdir -p "$BASE"

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
# line names one of this run's data dirs ($BASE/s*/data, through --socket or --settings). Another run's
# processes (a second e2e-live, the live_chat tests) match neither.
ours() {
  local pid cwd cmd
  while read -r pid cmd; do
    [[ -n "$pid" ]] || continue
    cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    case "$cwd" in
      "$BASE"/*|"/private$BASE"/*) echo "$pid"; continue ;;
    esac
    case "$cmd" in *"$BASE"/s*/data/*|*"/private$BASE"/s*/data/*) echo "$pid" ;; esac
    # The outside-session helper (python driver) carries the folder it works in.
    case "$cmd" in *e2e-outside-session*"$BASE"/s*|*e2e-outside-session*"/private$BASE"/s*) echo "$pid" ;; esac
  done < <(ps -axww -o pid=,command= | grep -E '(^|[ /])claude( |$)|patchroom-hook|e2e-outside-session' | grep -v grep)
}

# ---- run ----------------------------------------------------------------------------------------------------
timed_out=0
listeners_file="$BASE/listeners.txt"
: >"$listeners_file"
: >"$BASE/manifest.txt"

# The audio hooks the machine's real settings are expected to report: the events whose command
# calls a sound wrapper script or plays audio directly. Read only; the backend scenario compares
# `sound_hooks_detect` with it.
expect_hooks() {
  python3 -I - "$HOME/.claude/settings.json" <<'PY'
import json, re, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
if d.get("disableAllHooks"):
    d = {}
events = []
for ev, groups in (d.get("hooks") or {}).items():
    for g in groups if isinstance(groups, list) else []:
        for h in g.get("hooks", [g]) if isinstance(g, dict) else []:
            c = h.get("command", "") if isinstance(h, dict) else ""
            if re.search(r"sounds/play\.sh|\bafplay\b|\bpaplay\b", c):
                events.append(ev)
print(",".join(sorted(set(events))))
PY
}
EXPECT_HOOKS="$(expect_hooks)"

# A transcript fixture for the folder scenario, kept OUTSIDE ~/.claude: one old session that the
# app reads through PATCHROOM_E2E_EXTRA_PROJECTS (debug builds only).
make_old_fixture() {
  local sb="$1" real enc dir ts
  real="$(cd "$sb/fold" && pwd -P)"
  enc="$(printf '%s' "$real" | sed 's/[^A-Za-z0-9]/-/g')"
  dir="$sb/extra-projects/$enc"
  mkdir -p "$dir"
  ts="$(date -u -v-40d +%Y-%m-%dT%H:%M:%S.000Z)"
  printf '{"type":"user","isSidechain":false,"cwd":"%s","gitBranch":"main","entrypoint":"cli","timestamp":"%s","origin":{"kind":"human"},"message":{"role":"user","content":"An old fixture session about the billing export"}}\n{"type":"ai-title","aiTitle":"Fixture old session","sessionId":"f1x7u4e0-0000-4000-8000-0000000000aa"}\n' "$real" "$ts" >"$dir/f1x7u4e0-0000-4000-8000-0000000000aa.jsonl"
}

# run_scenario <index> <script>: launch the app on a fresh data dir with the script; honor the
# script's restart requests (same data dir, next phase). Appends "<index> <script> <phases>" to
# the manifest. Folders: s<i>/alpha, s<i>/beta, s<i>/fold (a git repo), s<i>/data.
run_scenario() {
  local idx="$1" script="$2"
  local sb="$BASE/s$idx" phase="" phase_n=1 rdir open_dm start="$SECONDS" app_pid
  mkdir -p "$sb/alpha" "$sb/beta" "$sb/fold" "$sb/data" "$sb/extra-projects"
  git -C "$sb/fold" init -q -b main && git -C "$sb/fold" -c user.name=e2e -c user.email=e2e@example.com commit -q --allow-empty -m init
  make_old_fixture "$sb"
  echo "e2e-live: scenario $idx: $(basename "$script") (up to ${TIMEOUT}s)"
  while :; do
    rdir="$sb/report"; [[ "$phase_n" -gt 1 ]] && rdir="$sb/report-$phase_n"
    mkdir -p "$rdir"
    rm -f "$rdir/restart-request"
    open_dm=()
    if [[ "$phase_n" -eq 1 ]]; then
      open_dm=(--open-dm "$sb/alpha" --open-dm-arg --model --open-dm-arg haiku --open-dm-arg --permission-mode --open-dm-arg default)
    fi
    PATCHROOM_DATA_DIR="$sb/data" \
    PATCHROOM_E2E_DIR_A="$sb/alpha" \
    PATCHROOM_E2E_DIR_B="$sb/beta" \
    PATCHROOM_E2E_DIR_FOLD="$sb/fold" \
    PATCHROOM_E2E_EXTRA_PROJECTS="$sb/extra-projects" \
    PATCHROOM_E2E_OUTSIDE_DRIVER="$ROOT/scripts/e2e-outside-session.py" \
    PATCHROOM_E2E_EXPECT_HOOKS="$EXPECT_HOOKS" \
    PATCHROOM_E2E_PHASE="$phase" \
    ANTHROPIC_MODEL=haiku \
      "$APP" --e2e-script "$script" --e2e-report "$rdir" ${open_dm[@]+"${open_dm[@]}"} \
      >"$sb/app-$phase_n.log" 2>&1 &
    app_pid=$!
    while kill -0 "$app_pid" 2>/dev/null; do
      if (( SECONDS - start > TIMEOUT )); then
        timed_out=1
        echo "e2e-live: scenario $idx timed out, stopping the app"
        kill "$app_pid" 2>/dev/null
        break
      fi
      # No network listener, ever: sample this app's TCP listeners while it runs.
      lsof -a -p "$app_pid" -iTCP -sTCP:LISTEN -n -P 2>/dev/null | tail -n +2 >>"$listeners_file"
      sleep 2
    done
    wait "$app_pid" 2>/dev/null
    if [[ "$timed_out" -eq 0 && -f "$rdir/restart-request" && "$phase_n" -le "$MAX_RESTARTS" ]]; then
      phase="$(tr -cd 'A-Za-z0-9_-' <"$rdir/restart-request")"
      phase_n=$((phase_n + 1))
      echo "e2e-live: restarting the app on the same data dir (phase '$phase')"
      sleep 2  # the quit path killed the children; let the socket and db settle
      continue
    fi
    break
  done
  cat "$sb"/app-*.log >"$sb/app-all.log" 2>/dev/null
  cp "$sb/data/notify-decisions.log" "$sb/notify-decisions.log" 2>/dev/null
  echo "$idx $(basename "$script") $phase_n" >>"$BASE/manifest.txt"
  sleep 2  # let hook and claude processes notice the exit
}

idx=0
for script in "${SCRIPTS[@]}"; do
  idx=$((idx + 1))
  [[ -f "$script" ]] || { echo "e2e-live: no scenario at $script" >&2; exit 2; }
  run_scenario "$idx" "$script"
  [[ "$timed_out" -eq 0 ]] || break
done

# Read-only look at the real gamerNetworking folder section (lists; opens and writes nothing).
real_line="$(cd "$ROOT" && cargo test -q -p patchroom-folders --test real -- --ignored --nocapture 2>&1 | grep -m1 '^REAL' || true)"
echo "$real_line" >"$BASE/real.txt"

# ---- after snapshots -----------------------------------------------------------------------------------------
left="$(ours | tr '\n' ' ')"
sums >"$BASE/sums.after"
claude_json_view >"$BASE/claude-json.after"
patchroom_refs >"$BASE/refs.after"
# Say what survived, then clean it up, after it has been counted.
if [[ -n "${left// /}" ]]; then
  # shellcheck disable=SC2086
  ps -ww -o pid=,ppid=,etime=,command= -p ${left// /,} >"$BASE/left.txt" 2>/dev/null
fi
for pid in $left; do kill "$pid" 2>/dev/null; done

# ---- table ---------------------------------------------------------------------------------------------------------------
python3 -I - "$BASE" "$left" "$timed_out" <<'PY'
import json, os, sys

base, left, timed_out = sys.argv[1:4]

def read(p):
    try:
        return open(p).read()
    except OSError:
        return ""

rows = []
facts_all = {}
manifest = [l.split() for l in read(f"{base}/manifest.txt").splitlines() if l.strip()]
for idx, script, phases in manifest:
    phases = int(phases)
    tag = f"[{script.replace('.script.js', '')}] "
    rep = {"steps": [], "done": False, "facts": {}}
    for n in range(1, phases + 1):
        rdir = f"{base}/s{idx}/report" + ("" if n == 1 else f"-{n}")
        try:
            part = json.load(open(f"{rdir}/report.json"))
        except Exception as e:
            rows.append((f"{tag}report written (phase {n})", False, f"no readable report: {e}"))
            continue
        prefix = tag + ("" if phases == 1 else f"[phase {n}] ")
        for s in part["steps"]:
            rows.append((prefix + s["name"], s["ok"], s["detail"]))
        if n == phases:
            rep = part
    if rep.get("steps") and not rep.get("done"):
        rows.append((f"{tag}scenario finished", False, "the report is not marked done"))
    facts_all[script] = rep.get("facts", {})
if not manifest:
    rows.append(("a scenario ran", False, "no scenario reached the manifest"))

listeners = read(f"{base}/listeners.txt").strip()
rows.append(("no TCP listener while the app ran", listeners == "", listeners.replace("\n", " | ") or "none"))

# Decision logs: only event, dm, decision, reason (and a hook policy reason), never a body.
for idx, script, _ in manifest:
    decisions = read(f"{base}/s{idx}/notify-decisions.log")
    bad = [l for l in decisions.splitlines() if [kv.split("=")[0] for kv in l.split(" ")[1:]] != ["event", "dm", "decision", "reason"]]
    rows.append((f"[{script.replace('.script.js', '')}] decision log has only event, dm, decision, reason", not bad,
                 f"{len(decisions.splitlines())} lines" if not bad else f"odd line: {bad[0][:120]}"))
if timed_out == "1":
    rows.append(("finished before timeout", False, "killed after the timeout"))

rows.append(("quit leaves no claude or hook process", left.strip() == "",
             f"left: {left.strip() or 'none'} {read(f'{base}/left.txt').strip()[:120]}"))

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

real = read(f"{base}/real.txt").strip()
rows.append(("real data: the gamerNetworking folder lists read only", real.startswith("REAL"),
             real[:150] or "no REAL line (the read-only listing did not run)"))

w = max(len(r[0]) for r in rows) if rows else 10
print()
print(f"{'CHECK'.ljust(w)}  RESULT  DETAIL")
for name, ok, detail in rows:
    print(f"{name.ljust(w)}  {'PASS  ' if ok else 'FAIL  '}  {detail[:160]}")
passed = sum(1 for r in rows if r[1])
print()
print(f"{passed}/{len(rows)} passed")
for script, facts in facts_all.items():
    if facts.get("probe") or facts.get("visibilityStateReal"):
        print(f"{script}: visibilityState={facts.get('visibilityStateReal')} hasFocus={facts.get('hasFocus')} probe={json.dumps(facts.get('probe'))}")
for idx, script, phases in manifest:
    print(f"scenario {idx} ({script}): {base}/s{idx}/report/report.json  app log: {base}/s{idx}/app-all.log  decisions: {base}/s{idx}/notify-decisions.log")
sys.exit(0 if passed == len(rows) else 1)
PY
