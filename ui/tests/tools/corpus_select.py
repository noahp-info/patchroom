#!/usr/bin/env python3
"""Pick the corpus transcripts: the N most recent over 2 KB, then older ones until every
type below that exists anywhere in the corpus is covered.

Usage: corpus_select.py <projects-root> [count]   (prints one transcript path per line)
Local only. This script prints paths and type names, never transcript content.
"""
import json
import os
import sys

MIN_BYTES = 2048

WANT_LINE = {
    "assistant", "user", "attachment", "system", "last-prompt", "mode", "ai-title", "pr-link",
    "queue-operation", "permission-mode", "agent-name", "file-history-snapshot",
    "file-history-delta", "worktree-state", "cost-state",
}
WANT_BLOCK = {"text", "thinking", "tool_use", "tool_result", "image", "string"}
WANT_SYSTEM = {
    "stop_hook_summary", "turn_duration", "away_summary", "compact_boundary", "local_command",
    "informational",
}
WANT_TOOL = {"Bash", "Read", "Edit", "Write", "Agent", "AskUserQuestion", "ExitPlanMode", "mcp"}


# Project dirs of sessions started under the temp dirs (claude encodes / as -).
TEST_DIRS = ("-private-tmp", "-tmp-", "-private-var-folders", "-var-folders")


def features(path):
    """The set of coverage tags in one transcript, as 'line:x', 'block:x', 'system:x', 'tool:x'."""
    tags = set()
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(obj, dict):
                    continue
                ty = obj.get("type")
                if isinstance(ty, str):
                    tags.add("line:" + ty)
                if ty == "system" and isinstance(obj.get("subtype"), str):
                    tags.add("system:" + obj["subtype"])
                msg = obj.get("message")
                content = msg.get("content") if isinstance(msg, dict) else None
                if isinstance(content, str):
                    tags.add("block:string")
                elif isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        bt = b.get("type")
                        if isinstance(bt, str):
                            tags.add("block:" + bt)
                        if bt == "tool_use" and isinstance(b.get("name"), str):
                            name = b["name"]
                            tags.add("tool:" + ("mcp" if name.startswith("mcp__") else name))
    except OSError:
        pass
    return tags


def main():
    root = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Subagent transcripts are not DM transcripts. Test runs (live tests and the e2e
        # runner work in /tmp) are not real usage.
        dirnames[:] = [d for d in dirnames if d != "subagents" and not d.startswith(TEST_DIRS)]
        for f in filenames:
            if not f.endswith(".jsonl"):
                continue
            p = os.path.join(dirpath, f)
            try:
                st = os.stat(p)
            except OSError:
                continue
            if st.st_size > MIN_BYTES:
                files.append((st.st_mtime, p))
    files.sort(reverse=True)
    chosen = [p for _, p in files[:count]]
    older = [p for _, p in files[count:]]

    want = (
        {"line:" + x for x in WANT_LINE}
        | {"block:" + x for x in WANT_BLOCK}
        | {"system:" + x for x in WANT_SYSTEM}
        | {"tool:" + x for x in WANT_TOOL}
    )
    covered = set()
    for p in chosen:
        covered |= features(p)
    missing = want - covered
    extra = []
    for p in older:
        if not missing:
            break
        got = features(p) & missing
        if got:
            extra.append(p)
            missing -= got
    for p in chosen + extra:
        print(p)
    # Tags no transcript has are reported on stderr, so a thin corpus is visible.
    if missing:
        print("not present in any transcript: " + ", ".join(sorted(missing)), file=sys.stderr)


if __name__ == "__main__":
    main()
