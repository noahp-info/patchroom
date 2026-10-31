#!/usr/bin/env python3
"""Reference emulator for the fidelity test: replay a fixture through pyte, dump screens.

Usage: pyte_ref.py FIXTURE.jsonl > screens.json
Output: {"<mark name>": {"cols":C,"rows":R,"cells":[[ [ch,fg,bg,flags], ... ], ... ]}}
Colors are normalised: "default", "p<0-15>" for the 16 ANSI slots, or "x<rrggbb>".
flags is a string of: b bold, i italic, u underline, r reverse, s strikethrough.
"""
import base64, json, re, sys

import pyte

ANSI = ["black", "red", "green", "brown", "blue", "magenta", "cyan", "white"]


def norm(c: str) -> str:
    if c == "default":
        return c
    if c in ANSI:
        return f"p{ANSI.index(c)}"
    if c == "yellow":  # some pyte versions name slot 3 "brown", others "yellow"
        return "p3"
    if c.startswith("bright"):
        name = c[6:]
        if name == "yellow":
            return "p11"
        if name in ANSI:
            return f"p{8 + ANSI.index(name)}"
    return "x" + c.lower().lstrip("#")


def dump(screen: pyte.Screen) -> dict:
    rows = []
    for y in range(screen.lines):
        row = []
        for x in range(screen.columns):
            ch = screen.buffer[y][x]
            flags = (
                ("b" if ch.bold else "")
                + ("i" if ch.italics else "")
                + ("u" if ch.underscore else "")
                + ("r" if ch.reverse else "")
                + ("s" if ch.strikethrough else "")
            )
            row.append([ch.data, norm(ch.fg), norm(ch.bg), flags])
        rows.append(row)
    return {"cols": screen.columns, "rows": screen.lines, "cells": rows}


# pyte ignores the private-marker byte of these and mis-applies them (`CSI > 4 ; 2 m` becomes
# underline+dim, `CSI < u` prints a literal "u"). They only negotiate keyboard reporting and XTVERSION
# and never change a cell, so strip them from the reference input. xterm.js sees them untouched.
NON_DISPLAY = re.compile(rb"\x1b\[(?:[<>=][0-9;]*[um]|[<>=][0-9;]*q|\?u)")


def main() -> None:
    events = [json.loads(line) for line in open(sys.argv[1])]
    first = events[0]
    screen = pyte.Screen(first["cols"], first["rows"])
    stream = pyte.ByteStream(screen)
    out = {}
    pending = b""

    def flush() -> None:
        nonlocal pending
        if pending:
            stream.feed(NON_DISPLAY.sub(b"", pending))
            pending = b""

    for e in events:
        if e["k"] == "out":
            pending += base64.b64decode(e["d"])
            continue
        flush()
        if e["k"] == "resize":
            screen.resize(e["rows"], e["cols"])
        elif e["k"] == "mark":
            out[e["name"]] = dump(screen)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
