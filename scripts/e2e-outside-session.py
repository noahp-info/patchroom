#!/usr/bin/env python3
"""Start an interactive `claude --model haiku` in a pty, as a terminal outside Patchroom would.

Used by the live e2e only (src-tauri/src/e2e.rs `e2e_outside_session`). It answers the folder
trust dialog, sends one prompt, prints `SENT <epoch ms>` the moment it presses Enter, waits for
the reply, then quits the session. Usage: e2e-outside-session.py <folder>

With E2E_OUTSIDE_HOLD_SECS=<n> it keeps the session open n seconds after the reply (still
draining its output), so Patchroom can meet a session that is live in another terminal.

It only runs claude with `--model haiku`, in the folder it is given. It writes nothing itself.
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

PROMPT = "Reply with exactly the single word OUTSIDE and nothing else."


CHILD = 0


def stop_child(*_args) -> None:
    """On TERM (the app stopping its helper) end the claude child, then exit."""
    if CHILD:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(CHILD, sig)
            except OSError:
                break
            if reaped(CHILD, 3):
                break
    os._exit(0)


def main() -> int:
    global CHILD
    folder = sys.argv[1]
    shell = os.environ.get("SHELL") or "/bin/zsh"
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(folder)
        env = dict(os.environ, TERM="xterm-256color")
        for k in list(env):
            if k.startswith("CLAUDE") or k == "ANTHROPIC_MODEL":
                env.pop(k)
        os.execvpe(shell, [shell, "-l", "-c", "exec claude --model haiku"], env)
    CHILD = pid
    signal.signal(signal.SIGTERM, stop_child)
    signal.signal(signal.SIGHUP, stop_child)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    buf = ""
    sent = False
    sent_at = 0.0
    trust_answered = 0
    deadline = time.time() + float(os.environ.get("E2E_OUTSIDE_DEADLINE", "150"))
    ansi = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.25)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            buf = (buf + ansi.sub("", data.decode("utf-8", "replace")))[-20000:]
        # The TUI paints spaces as cursor moves, so match on the text without whitespace.
        compact = re.sub(r"\s+", "", buf)
        if not sent and "Itrustthisfolder" in compact and trust_answered < 3:
            time.sleep(0.8)  # let the dialog finish painting and start reading keys
            if "\u276fNo,exit" in compact:
                os.write(fd, b"\x1b[B")  # the cursor starts on "No, exit"
                time.sleep(0.6)
            os.write(fd, b"\r")
            trust_answered += 1
            buf = ""
            time.sleep(1.5)
        elif not sent and re.search(r"forshortcuts|shift\+tab", compact):
            time.sleep(0.5)
            os.write(fd, PROMPT.encode())
            time.sleep(0.3)
            os.write(fd, b"\r")
            sent = True
            sent_at = time.time()
            print(f"SENT {int(sent_at * 1000)}", flush=True)
            buf = ""
        elif sent and re.search("\u23fa\\s*OUTSIDE", buf) and time.time() - sent_at > 2:
            break
        elif sent and time.time() - sent_at > 90:
            break
    # Stay open for a while when asked, so Patchroom can meet the live session.
    hold = float(os.environ.get("E2E_OUTSIDE_HOLD_SECS", "0") or 0)
    if sent and hold > 0:
        end = time.time() + hold
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.25)
            if not ready:
                continue
            try:
                if not os.read(fd, 65536):
                    break
            except OSError:
                break
    if not sent:
        print("NOT_SENT", flush=True)
        if os.environ.get("E2E_OUTSIDE_DEBUG"):
            print(buf[-1500:], file=sys.stderr)
    time.sleep(2.0)
    # Leave the way a user does: the /exit command. Ctrl-C only interrupts a running turn.
    for chunk in (b"\x1b", b"/exit", b"\r"):
        try:
            os.write(fd, chunk)
        except OSError:
            pass
        time.sleep(0.4)
    if not reaped(pid, 12):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except OSError:
                break
            if reaped(pid, 4):
                break
    return 0


def reaped(pid: int, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True
        if done:
            return True
        time.sleep(0.2)
    return False


if __name__ == "__main__":
    sys.exit(main())
