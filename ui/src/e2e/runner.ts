// Debug-only in-app e2e runner. It exists in a bundle only when the UI is built with
// VITE_PR_E2E=1 (scripts/e2e-live.sh does that) and runs only inside the Tauri webview started
// with `--e2e-script <path.js>`. The scenario script (a JS file the backend injects) receives a
// `Runner` and drives the real UI through DOM events: composer typing, widget buttons, Cmd+J,
// sidebar clicks and keystrokes into the xterm textarea. It never calls store or IPC methods to
// act. Reads go through the same window test hooks the Playwright suite uses.
//
// There is no network listener. The report leaves through the `e2e_report` Tauri command.

import { invoke } from '@tauri-apps/api/core';
import type { ChatModel, ChatSnapshot } from '../state/chat';
import type { AppStore } from '../state/store';
import type { SessionTerminal } from '../lib/sessionTerminal';
import { click, describe, press, setValue, textOf, typeInto } from './dom';

declare global {
  interface Window {
    __PR_E2E__?: { start(scenario: (t: Runner) => Promise<void>): void };
    __PR_E2E_SCENARIO__?: (t: Runner) => Promise<void>;
    __PR_STORE__?: AppStore;
    __PR_CHATS__?: Record<string, ChatModel>;
    __PR_TERMS__?: Record<string, SessionTerminal>;
  }
}

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface Badge {
  unread: number;
  needs: number;
  active: boolean;
  name: string;
  id: string;
}

const sleepNative = (ms: number): Promise<void> => invoke<void>('e2e_sleep', { ms });

/**
 * A locked screen occludes the window. WKWebView may then pause requestAnimationFrame and slow
 * timers. Make both fire anyway: the first of rAF, a timer and a native (IPC) timer runs the
 * callback. The callbacks still run on the page's own main thread.
 */
function installFrameFallback(): void {
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const pending = new Map<number, { cancelled: boolean }>();
  let next = 1_000_000_000;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = next++;
    const slot = { cancelled: false };
    pending.set(id, slot);
    let done = false;
    const run = (ts: number) => {
      if (done) return;
      done = true;
      pending.delete(id);
      if (!slot.cancelled) cb(ts);
    };
    const h = raf(run);
    window.setTimeout(() => run(performance.now()), 50);
    void sleepNative(50).then(() => run(performance.now()));
    void h;
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    const slot = pending.get(id);
    if (slot) slot.cancelled = true;
    else caf(id);
  };
}

/** A hidden or occluded page reports visibilityState "hidden"; the unread logic needs "visible". */
function forceVisible(): { real: string } {
  const real = document.visibilityState;
  try {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  } catch {
    // Leave the real value.
  }
  return { real };
}

export class Runner {
  readonly steps: StepResult[] = [];
  readonly facts: Record<string, unknown> = {};
  private readonly started = Date.now();
  private seq = 0;

  // ---- plumbing -------------------------------------------------------------------------

  param(name: string): Promise<string | null> {
    return invoke<string | null>('e2e_param', { name });
  }

  async requireParam(name: string): Promise<string> {
    const v = await this.param(name);
    if (!v) throw new Error(`missing scenario parameter ${name}`);
    return v;
  }

  sleep(ms: number): Promise<void> {
    return sleepNative(ms);
  }

  async pgrep(pattern: string): Promise<number[]> {
    return invoke<number[]>('e2e_pgrep', { pattern });
  }

  /** Poll `fn` every 100 ms on the native timer until it returns a truthy value. */
  async waitFor<T>(
    what: string,
    fn: () => T | Promise<T>,
    timeoutMs = 20_000,
  ): Promise<NonNullable<T>> {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    let beat = 0;
    for (;;) {
      if (Date.now() - beat > 2000) {
        beat = Date.now();
        void this.progress(what);
      }
      try {
        const v = await fn();
        if (v) return v as NonNullable<T>;
        last = undefined;
      } catch (e) {
        last = e;
      }
      if (Date.now() > end) {
        throw new Error(
          `timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${String(last)}` : ''}`,
        );
      }
      await sleepNative(100);
    }
  }

  /** A small file the shell can watch to see the page is alive and what it waits for. */
  private progress(what: string): Promise<unknown> {
    const body = JSON.stringify({
      at: new Date().toISOString(),
      waitingFor: what,
      visibility: document.visibilityState,
    });
    return invoke('e2e_report', { name: 'progress.json', body }).catch(() => undefined);
  }

  async snapshot(name: string): Promise<void> {
    const html = `<!doctype html><meta charset="utf-8"><title>${name}</title>\n${document.documentElement.outerHTML}`;
    await invoke('e2e_report', {
      name: `dom-${String(this.seq).padStart(2, '0')}-${slug(name)}.html`,
      body: html,
    });
  }

  /** Run one named check. A failure is recorded, not thrown, so later steps still run. */
  async step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
    this.seq += 1;
    const t0 = Date.now();
    let ok = true;
    let detail = '';
    try {
      const r = await fn();
      if (typeof r === 'string') detail = r;
    } catch (e) {
      ok = false;
      detail = e instanceof Error ? e.message : String(e);
    }
    this.steps.push({ name, ok, ms: Date.now() - t0, detail });
    if (!ok) {
      this.captureTerminal(name);
      this.captureLog(name);
    }
    try {
      await this.snapshot(`${ok ? 'ok' : 'FAIL'}-${name}`);
    } catch {
      // A snapshot problem must not hide the step result.
    }
    await this.writeReport(false);
    return ok;
  }

  /** On a failure, keep the tail of the active terminal: the TUI often says why. */
  private captureTerminal(name: string): void {
    try {
      const lines = this.termLines().filter((l) => l.trim() !== '');
      this.facts[`terminalTail:${name}`] = lines.slice(-30);
    } catch {
      // No terminal to read.
    }
  }

  /** On a failure, keep the log geometry and the prompts the chat model holds. */
  private captureLog(name: string): void {
    try {
      const log = document.querySelector<HTMLElement>(
        '[data-testid="chat"]:not(.chat--hidden) [data-testid="chat-log"]',
      );
      const snap = this.chat();
      this.facts[`log:${name}`] = {
        scrollTop: log?.scrollTop,
        scrollHeight: log?.scrollHeight,
        clientHeight: log?.clientHeight,
        vrows: log?.querySelectorAll('.vrow').length,
        items: snap.items.length,
        prompts: snap.prompts.map((p) => ({
          id: p.promptId,
          kind: p.kind,
          tool: p.toolName,
          resolved: p.resolved?.by ?? null,
          sending: p.sending ?? false,
          handedOff: p.handedOff ?? false,
        })),
      };
    } catch {
      // No chat to read.
    }
  }

  private trace: string[] = [];
  private tracing = false;

  /** Sample the visible log's geometry every 250 ms and keep only the changes. */
  startLogTrace(): void {
    if (this.tracing) return;
    this.tracing = true;
    this.facts.logTrace = this.trace;
    let prev = '';
    void (async () => {
      for (;;) {
        await sleepNative(250);
        const log = document.querySelector<HTMLElement>(
          '[data-testid="chat"]:not(.chat--hidden) [data-testid="chat-log"]',
        );
        const cur = log
          ? `top=${Math.round(log.scrollTop)} h=${log.scrollHeight} c=${log.clientHeight}`
          : 'no visible log';
        const line = `${this.view()}|${cur}`;
        if (line !== prev && this.trace.length < 600) {
          prev = line;
          this.trace.push(
            `${((Date.now() - this.started) / 1000).toFixed(1)}s ${this.steps.length} ${line}`,
          );
        }
      }
    })();
  }

  fact(key: string, value: unknown): void {
    this.facts[key] = value;
  }

  async writeReport(done: boolean): Promise<void> {
    const body = JSON.stringify(
      {
        done,
        elapsedMs: Date.now() - this.started,
        passed: this.steps.filter((s) => s.ok).length,
        failed: this.steps.filter((s) => !s.ok).length,
        steps: this.steps,
        facts: this.facts,
      },
      null,
      2,
    );
    await invoke('e2e_report', { name: 'report.json', body });
  }

  /**
   * Mid-script restart: write this phase's report (not final), ask the driving script for a
   * relaunch on the same data dir with `PATCHROOM_E2E_PHASE=<phase>`, and quit. Never returns.
   */
  async restart(phase: string): Promise<never> {
    await this.writeReport(false);
    await invoke('e2e_restart', { phase });
    for (;;) await sleepNative(1000);
  }

  /** Write the final report, then quit through the normal quit path. */
  async finish(quit = true): Promise<void> {
    await this.writeReport(true);
    if (quit) await invoke('e2e_quit');
  }

  // ---- reads (window test hooks and DOM) -----------------------------------------------------

  private get store(): AppStore {
    const s = window.__PR_STORE__;
    if (!s) throw new Error('no store hook');
    return s;
  }

  /** A DM by its sidebar name: id and current status. */
  dm(name: string): { id: string; status: string } {
    const s = this.store.getSnapshot().sessions.find((x) => x.name === name);
    if (!s) throw new Error(`no DM named ${name}`);
    return { id: s.id, status: s.status };
  }

  /** Badge counts the store holds for a DM, active or not. */
  badgesOf(name: string): { unread: number; needsYou: number } {
    const b = this.store.getSnapshot().badges[this.dm(name).id];
    return { unread: b?.unread ?? 0, needsYou: b?.needsYou ?? 0 };
  }

  activeId(): string | null {
    return this.store.getSnapshot().activeId;
  }

  sessionCount(): number {
    return this.store.getSnapshot().sessions.length;
  }

  chat(id: string | null = this.activeId()): ChatSnapshot {
    const m = id ? window.__PR_CHATS__?.[id] : undefined;
    if (!m) throw new Error(`no chat model for ${String(id)}`);
    return m.getSnapshot();
  }

  /** Text of the active chat's user messages as rendered items. */
  userTexts(id: string | null = this.activeId()): string[] {
    return this.chat(id).items.flatMap((i) => (i.kind === 'user' ? [i.text] : []));
  }

  /** Image count of each user message, in order. */
  userImageCounts(id: string | null = this.activeId()): number[] {
    return this.chat(id).items.flatMap((i) => (i.kind === 'user' ? [i.images.length] : []));
  }

  /** Paste a real image through a ClipboardEvent on the composer, as the webview delivers it. */
  pasteImageIntoComposer(base64: string, mediaType = 'image/png'): void {
    const el = this.composer();
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: mediaType }));
    el.focus();
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }

  assistantTexts(id: string | null = this.activeId()): string[] {
    return this.chat(id).items.flatMap((i) => (i.kind === 'assistant' ? [i.text] : []));
  }

  view(): string {
    return textOf(document.querySelector('[data-testid="view-label"]'));
  }

  sidebar(): Badge[] {
    return [...document.querySelectorAll<HTMLButtonElement>('aside.side button.row')].map((r) => ({
      id: '',
      name: textOf(r.querySelector('.nm')),
      unread: Number(r.dataset.unread ?? 0),
      needs: Number(r.dataset.needs ?? 0),
      active: r.getAttribute('aria-current') === 'true',
    }));
  }

  badge(name: string): Badge {
    const b = this.sidebar().find((x) => x.name === name);
    if (!b) throw new Error(`no sidebar row named ${name}`);
    return b;
  }

  /** The pending ask widget of one kind in the visible chat, if any. */
  widget(kind: 'permission' | 'question' | 'plan', state = 'pending'): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      `[data-testid="chat"]:not(.chat--hidden) .ask[data-kind="${kind}"][data-state="${state}"]`,
    );
  }

  /**
   * Wait for a pending ask widget of one kind. With the window occluded, WebKit pauses rendering,
   * so scroll and resize events arrive late and the log can lose its pin to the bottom while a
   * widget lands below the fold. The UI then offers "Needs you below"; click it, as a user would.
   */
  async awaitWidget(
    kind: 'permission' | 'question' | 'plan',
    timeoutMs = 120_000,
  ): Promise<HTMLElement> {
    return this.waitFor(
      `${kind} widget`,
      () => {
        const w = this.widget(kind);
        if (w) return w;
        const jump = document.querySelector<HTMLButtonElement>(
          '[data-testid="chat"]:not(.chat--hidden) [data-testid="jump-latest"]',
        );
        if (jump) {
          this.facts.jumpLatestClicks = Number(this.facts.jumpLatestClicks ?? 0) + 1;
          click(jump);
        }
        return null;
      },
      timeoutMs,
    );
  }

  widgetDone(kind: 'permission' | 'question' | 'plan'): string {
    const el = document.querySelector(
      `[data-testid="chat"]:not(.chat--hidden) .ask[data-kind="${kind}"][data-state="resolved"] .ask-done`,
    );
    return textOf(el);
  }

  statusStripText(): string {
    const lines = [
      ...document.querySelectorAll(
        '[data-testid="chat"]:not(.chat--hidden) [data-testid="statusline"] .sl-line',
      ),
    ];
    return lines.map((l) => (l.textContent ?? '').split('\u00a0').join(' ').trimEnd()).join('\n');
  }

  /** Every line of the active terminal's buffer (scrollback and screen), trimmed. */
  termLines(id: string | null = this.activeId()): string[] {
    const t = id ? window.__PR_TERMS__?.[id] : undefined;
    if (!t) throw new Error(`no terminal for ${String(id)}`);
    const buf = t.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '');
    return out;
  }

  termText(id: string | null = this.activeId()): string {
    return this.termLines(id).join('\n');
  }

  // ---- actions (real DOM events only) -----------------------------------------------------------

  /** Cmd+J on the window, as the keyboard sends it. */
  toggleTerminal(): void {
    const target = document.activeElement ?? document.body;
    press(target, 'j', { meta: true });
  }

  async showView(want: 'Chat' | 'Terminal'): Promise<void> {
    if (this.view() !== want) this.toggleTerminal();
    await this.waitFor(`${want} view`, () => this.view() === want, 5000);
  }

  /** Click a sidebar DM row by name. */
  selectDm(name: string): void {
    const row = [...document.querySelectorAll<HTMLButtonElement>('aside.side button.row')].find(
      (r) => textOf(r.querySelector('.nm')) === name,
    );
    if (!row) throw new Error(`no sidebar row named ${name}`);
    click(row);
  }

  /** Open the New DM dialog and start a DM in `cwd`, through the real form. */
  async newDm(cwd: string, name: string): Promise<void> {
    const btn = document.querySelector<HTMLButtonElement>('aside.side button[aria-label="New DM"]');
    if (!btn) throw new Error('no New DM button');
    click(btn);
    const dlg = await this.waitFor(
      'New DM dialog',
      () => document.querySelector<HTMLDialogElement>('dialog.newdm[open]'),
      5000,
    );
    const inputs = dlg.querySelectorAll<HTMLInputElement>('input');
    const folder = inputs[0];
    const nm = inputs[1];
    if (!folder || !nm) throw new Error('New DM dialog inputs missing');
    folder.focus({ preventScroll: true });
    setValue(folder, cwd);
    folder.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: cwd }),
    );
    setValue(nm, name);
    nm.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: name }),
    );
    const submit = [...dlg.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => textOf(b) === 'Start DM',
    );
    if (!submit) throw new Error('no Start DM button');
    await this.waitFor('Start DM enabled', () => !submit.disabled, 3000);
    click(submit);
  }

  private composer(): HTMLTextAreaElement {
    const el = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat"]:not(.chat--hidden) [data-testid="composer-input"]',
    );
    if (!el) throw new Error('no visible composer');
    return el;
  }

  /** Type into the visible composer and press Enter. */
  async sendFromComposer(text: string, keep = ''): Promise<void> {
    const el = this.composer();
    if (el.disabled) throw new Error('composer is disabled');
    typeInto(el, text);
    await this.sleep(50);
    if (el.value !== keep + text) throw new Error(`composer holds ${JSON.stringify(el.value)}`);
    press(el, 'Enter');
  }

  /** Press Enter in the composer as it stands. */
  pressEnterInComposer(): void {
    press(this.composer(), 'Enter');
  }

  // ---- P3 helpers: real key and pointer events on real controls -----------------------------

  /** A chord as the keyboard raises it: on the focused element, bubbling up to window. */
  chord(key: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean } = {}): void {
    press(document.activeElement ?? document.body, key, mods);
  }

  /** Click an element found by CSS selector. */
  clickSel(selector: string): void {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no element ${selector}`);
    click(el);
  }

  /** Right-click (contextmenu) on an element found by CSS selector. */
  contextMenuOn(selector: string): void {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no element ${selector}`);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 8,
        clientY: r.top + 8,
        button: 2,
      }),
    );
  }

  /** Type into the focused input or textarea. */
  typeFocused(text: string): void {
    const el = document.activeElement;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      throw new Error('no focused field');
    }
    typeInto(el, text);
  }

  /** Re-read the DM list from the backend (what a restarted view would show). */
  async reread(): Promise<void> {
    await window.__PR_STORE__?.refresh();
  }

  /** Click a button by its visible text inside `scope`. */
  clickButton(scope: ParentNode, label: string): void {
    const b = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (x) => textOf(x) === label,
    );
    if (!b)
      throw new Error(
        `no button "${label}" in ${scope instanceof Element ? describe(scope) : 'scope'}`,
      );
    click(b);
  }

  /** Click an option of an AskUserQuestion block (0 based) by its label. */
  pickOption(block: Element, label: string): void {
    const opt = [...block.querySelectorAll<HTMLLabelElement>('label.opt')].find((l) =>
      textOf(l.querySelector('.ol')).startsWith(label),
    );
    const input = opt?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error(`no option "${label}"`);
    click(input);
  }

  /** Tick Other and type free text into its field. */
  fillOther(block: Element, text: string): void {
    const pick = block.querySelector<HTMLInputElement>('.other-pick input');
    const field = block.querySelector<HTMLInputElement>('.other input.f');
    if (!pick || !field) throw new Error('no Other control');
    if (!pick.checked) click(pick);
    typeInto(field, text);
  }

  /** Keystrokes into the active DM's xterm textarea, as the focused terminal receives them. */
  termKeys(keys: string[]): void {
    const id = this.activeId();
    const ta = document.querySelector<HTMLTextAreaElement>(`.term--active .xterm-helper-textarea`);
    if (!ta || !id) throw new Error('no active terminal textarea');
    ta.focus({ preventScroll: true });
    for (const k of keys) press(ta, k);
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'step'
  );
}

/** What the page can do while occluded: native rAF, timers and visibility, measured at load. */
const probe: Record<string, unknown> = {};

function measureThrottling(): void {
  const t0 = performance.now();
  const nativeRaf = window.requestAnimationFrame.bind(window);
  nativeRaf(() => {
    probe.nativeRafFirstMs = Math.round(performance.now() - t0);
  });
  window.setTimeout(() => {
    probe.timer50Ms = Math.round(performance.now() - t0);
  }, 50);
  let ticks = 0;
  const iv = window.setInterval(() => {
    ticks += 1;
    if (ticks === 10) {
      probe.interval100x10Ms = Math.round(performance.now() - t0);
      window.clearInterval(iv);
    }
  }, 100);
  window.setTimeout(() => {
    probe.nativeRafFiredWithin1s = 'nativeRafFirstMs' in probe;
  }, 1000);
}

/** Runs before the first render: throttling probe, frame fallback and the visibility shim. */
export function install(): void {
  const vis = forceVisible();
  measureThrottling();
  installFrameFallback();
  let started = false;
  window.__PR_E2E__ = {
    start(scenario) {
      if (started) return;
      started = true;
      const t = new Runner();
      void (async () => {
        t.fact('visibilityStateReal', vis.real);
        t.fact('hasFocus', document.hasFocus());
        t.fact('probe', probe);
        try {
          await scenario(t);
        } catch (e) {
          t.steps.push({
            name: 'scenario',
            ok: false,
            ms: 0,
            detail: e instanceof Error ? (e.stack ?? e.message) : String(e),
          });
          await t.finish(true);
        }
      })();
    },
  };
}
