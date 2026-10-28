import { useSyncExternalStore } from 'react';
import type {
  ChatItem,
  ActivityRow,
  BundleEntry,
  EmojiFlavor,
  ModelCatalog,
  ModelPrefs,
  UpdateInfo,
  FolderSession,
  Ipc,
  MarkInfo,
  MarkKind,
  NotifyFireEvent,
  Prefs,
  SectionInfo,
  SendOutcome,
  SessionInfo,
  SessionStatus,
  StatusBarPrefs,
} from '../ipc';
import { isInteractiveSlash, slashName, SLASH_QUIET_MS } from '../lib/slashCommands';
import { visibleOrder } from '../lib/groups';
import { isCheckFailed } from '../ipc/types';
import { bindTerminalStyle, type PrefsTabId } from '../lib/prefsModule';
import { toMillis } from '../lib/time';
import { noteArtifacts } from '../lib/artifacts';
import { bytesToBase64, utf8ToBase64 } from '../lib/base64';
import { shellQuotePath } from '../lib/keys';
import { SessionTerminal, type SessionTerminalOptions } from '../lib/sessionTerminal';
import { ChatModel } from './chat';
import { overlayCount, subscribeOverlays } from './overlays';
import { bindAccountActions, setClaudeAccount } from '../lib/accounts';
import { cleanQuote, textFragmentLink } from '../lib/comments';
import { HINTS, type HintDef, type HintId } from '../lib/hints';
import { adapterOf, modelTook } from '../lib/models/adapters';
import { activeBundle, launchArgsFor, modelsOf, type BundleScope } from '../lib/models/bundles';
import {
  mergeCatalogs,
  modelName,
  newerThan,
  resolveModel,
  SHIPPED_CATALOG,
} from '../lib/models/catalog';

/** How long a `/model` switch gets to show up in the CLI's statusline before it counts as failed. */
export const MODEL_SWITCH_WAIT_MS = 8000;

/** A model switch in progress or the reason it failed, per DM. */
export interface ModelSwitch {
  target: string;
  state: 'pending' | 'error';
  message?: string;
}

/** Restart Patchroom: the DMs to reopen, and the busy ones the user chose to interrupt. */
export interface RestartState {
  ids: string[];
  interrupt: string[];
  /** Waiting for every DM to go idle before relaunching. */
  waiting: boolean;
}

export type ViewMode = 'chat' | 'terminal';

export interface Badges {
  unread: number;
  needsYou: number;
}

/** The subagent thread open in the right pane. */
export interface OpenThread {
  sessionId: string;
  toolUseId: string;
  title: string;
}

/** The overlay views over the conversation. */
export interface PrefsTarget {
  tab: PrefsTabId;
  dmId?: string;
  /** A row to scroll to and flash (a Settings registry id). */
  setting?: string;
}

export type Panel = null | 'activity' | 'saved' | 'search' | 'switcher' | 'prefs';

/** Where a dragged DM lands. */
export type DropDest =
  | { kind: 'starred' }
  | { kind: 'archived' }
  | { kind: 'default' }
  | { kind: 'section'; sectionId: string };

/** The open that `check_failed` stopped, kept so "Open anyway" can repeat it. */
export interface PendingCheck {
  name: string;
  reason: string;
  target: { kind: 'resume'; id: string } | { kind: 'folder'; sectionId: string; sessionId: string };
}

/** What `folder_sessions` last returned for one folder section. */
export interface FolderListing {
  sessions: FolderSession[];
  hiddenCount: number;
  /** True until the first answer arrives. */
  loading: boolean;
  /** Set when the last read failed; the previous rows stay. */
  error: string | null;
}

/** The in-app link viewer. `req` bumps on every open, so the pane navigates once per click. */
export interface ViewerState {
  url: string;
  title: string;
  loading: boolean;
  req: number;
  /** The page is claude.ai's sign-in screen (or an artifact asking to sign in). */
  signIn?: boolean;
}

/** A screenshot in progress: the frozen window picture the box is drawn on. */
export interface ShotState {
  /** Empty in a browser (no capture): the overlay draws over the live page. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface AppState {
  ready: boolean;
  /** The in-app link viewer, or null when closed. */
  viewer: ViewerState | null;
  /** Open overlays (Settings, Cmd+K, menus, pickers, dialogs): the native viewer steps aside. */
  overlays: number;
  /** The first-time hint on screen, at most one. */
  hint: HintId | null;
  /** Values for the hint's `{slot}`s. */
  hintVars: Record<string, string> | null;
  /** The model catalog: shipped, merged with a signed one fetched on opt-in. */
  catalog: ModelCatalog;
  /** Model switches per DM. */
  modelSwitch: Record<string, ModelSwitch>;
  /** Restart Patchroom in progress (the dialog), or null. */
  restart: RestartState | null;
  /** The last app update check, when the user turned it on. */
  update: UpdateInfo | null;
  /** Screenshot-to-steer in progress. */
  shot: ShotState | null;
  sessions: SessionInfo[];
  /** Stored sidebar sections, in position order. DMs with no section sit in the default group. */
  sections: SectionInfo[];
  activeId: string | null;
  lastCwd: string;
  error: string | null;
  /** An open or resume the live check could not clear. The user may open anyway. */
  checkFailed: PendingCheck | null;
  /** Chat or terminal per DM. A DM opens as chat. */
  views: Record<string, ViewMode>;
  badges: Record<string, Badges>;
  thread: OpenThread | null;
  /** Pins, saved items and reactions across every DM. */
  marks: MarkInfo[];
  /** Everything waiting on the user, oldest first. */
  activity: ActivityRow[];
  prefs: Prefs | null;
  panel: Panel;
  /** Where Preferences opens: a tab, and a DM whose terminal look to show. */
  prefsTarget: PrefsTarget | null;
  /** Search scope when the search panel opens: the active DM or every DM. */
  searchScope: 'dm' | 'all';
  /** Text the search panel opens with ("Search" on a highlight). */
  searchSeed: string;
  /** DM ids, most recently opened first. */
  recent: string[];
  /** Folder section id to the sessions found under its home folder. */
  folders: Record<string, FolderListing>;
  /** Terminal background per DM from its palette, for the stage behind the terminal. */
  termBg: Record<string, string>;
  /**
   * DMs whose terminal view is a fallback (a TUI panel or dialog), with the note shown over it.
   * Esc or Cmd+J on such a terminal returns to chat.
   */
  termNotes: Record<string, string>;
  /** A short note above the terminal of session `id` (the draft moved there). */
  termToast: { id: string; text: string } | null;
}

/** What `sendText` resolved to. `error` means the call itself failed. */
export type SendResultKind = SendOutcome | 'error';

/** A DM's claude waits on a dialog only the terminal can show. */
export function inTerminalDialog(s: Pick<SessionInfo, 'terminalWait'> | undefined): boolean {
  return !!s?.terminalWait;
}

/** How long a sent message gets to show up as a user item before the chat says why not. */
export const ECHO_WAIT_MS = 3000;
/**
 * How long a queued message may wait once Claude is idle (or after Stop) before chat says it
 * was not sent. At a turn's end Claude Code reads its queue at once, so a message still waiting
 * after this went back to the prompt (an interrupt).
 */
export const QUEUE_RETURN_MS = 2500;

const LAST_CWD_KEY = 'patchroom.lastCwd';
/** The DM on screen when Restart Patchroom ran, shown again after the relaunch. */
const RESTART_ACTIVE_KEY = 'patchroom.restartActive';
const RECENT_KEY = 'patchroom.recentDms';
const DRAFT_DEBOUNCE_MS = 400;

function readRecent(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeRecent(ids: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    // Recents are a convenience.
  }
}

function readLastCwd(): string {
  try {
    return window.localStorage.getItem(LAST_CWD_KEY) ?? '';
  } catch {
    return '';
  }
}
function writeLastCwd(cwd: string): void {
  try {
    window.localStorage.setItem(LAST_CWD_KEY, cwd);
  } catch {
    // Storage can be blocked; the default folder just will not be remembered.
  }
}

const VIEWS_KEY = 'patchroom.views';
/** Each DM's last view (chat or terminal), so switching DMs or restarting keeps it. */
function readViews(): Record<string, ViewMode> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(VIEWS_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    const out: Record<string, ViewMode> = {};
    for (const [k, v] of Object.entries(raw)) if (v === 'terminal') out[k] = v;
    return out;
  } catch {
    return {};
  }
}
function writeViews(views: Record<string, ViewMode>): void {
  // Only terminal is stored: chat is the default.
  const keep = Object.fromEntries(Object.entries(views).filter(([, v]) => v === 'terminal'));
  try {
    window.localStorage.setItem(VIEWS_KEY, JSON.stringify(keep));
  } catch {
    // Storage can be blocked; the view then lasts until the app quits.
  }
}

/** Last path segment, for a default DM name. */
export function folderName(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}

/**
 * Session list, active DM and the per-session terminals. Backend events update it live;
 * `session_list` seeds it, so a relaunch shows the persisted DMs.
 */
export class AppStore {
  private state: AppState = {
    ready: false,
    sessions: [],
    sections: [],
    activeId: null,
    lastCwd: readLastCwd(),
    error: null,
    checkFailed: null,
    views: readViews(),
    badges: {},
    thread: null,
    marks: [],
    activity: [],
    prefs: null,
    panel: null,
    viewer: null,
    overlays: 0,
    hint: null,
    hintVars: null,
    catalog: SHIPPED_CATALOG,
    modelSwitch: {},
    restart: null,
    update: null,
    shot: null,
    prefsTarget: null,
    searchScope: 'all',
    searchSeed: '',
    recent: readRecent(),
    folders: {},
    termBg: {},
    termNotes: {},
    termToast: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly terminals = new Map<string, SessionTerminal>();
  private readonly unbindTerms = new Map<string, () => void>();
  private readonly chats = new Map<string, ChatModel>();
  private unlisten: (() => void)[] = [];

  constructor(
    readonly ipc: Ipc,
    private readonly termOpts: SessionTerminalOptions = {},
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.reportFocus();
    for (const fn of this.listeners) fn();
  }

  private focusSent: string | null | undefined = undefined;
  /** Tell the backend which DM is on screen, so that DM does not notify while the window is focused. */
  private reportFocus(): void {
    const id = this.state.ready ? this.state.activeId : null;
    if (id === this.focusSent || !this.state.ready) return;
    this.focusSent = id;
    void this.ipc.sessionFocus(id).catch(() => undefined);
  }

  private patchSession(id: string, patch: Partial<SessionInfo>): void {
    this.set({
      sessions: this.state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }

  terminal(id: string): SessionTerminal {
    let t = this.terminals.get(id);
    if (!t) {
      const made = new SessionTerminal(id, this.ipc, this.termOpts);
      t = made;
      this.terminals.set(id, made);
      this.unbindTerms.set(
        id,
        bindTerminalStyle(made.term, id, (bg) => {
          made.refit();
          // Runs inside a render the first time: publish the stage color afterwards.
          queueMicrotask(() => {
            if (bg && this.state.termBg[id] !== bg) {
              this.set({ termBg: { ...this.state.termBg, [id]: bg } });
            }
          });
        }),
      );
      // Test hook: lets Playwright read the buffer. Harmless in production.
      const w = window as unknown as { __PR_TERMS__?: Record<string, SessionTerminal> };
      (w.__PR_TERMS__ ??= {})[id] = t;
    }
    return t;
  }

  /** The chat model of one DM, created on first use. */
  chat(id: string): ChatModel {
    let c = this.chats.get(id);
    if (!c) {
      c = new ChatModel(id, this.ipc);
      c.draftHook = (text) => this.draftChanged(id, text);
      c.itemsHook = (items) => this.noteArtifacts(id, items);
      this.chats.set(id, c);
      const w = window as unknown as { __PR_CHATS__?: Record<string, ChatModel> };
      (w.__PR_CHATS__ ??= {})[id] = c;
    }
    return c;
  }

  viewOf(id: string): ViewMode {
    return this.state.views[id] ?? 'chat';
  }

  setView(id: string, view: ViewMode): void {
    // A mirror has no process of its own: there is no terminal to show.
    if (view === 'terminal' && this.state.sessions.find((s) => s.id === id)?.mirror) return;
    if (view === 'chat' && this.state.termNotes[id] !== undefined) {
      const rest = { ...this.state.termNotes };
      delete rest[id];
      this.set({ termNotes: rest });
    }
    if (this.viewOf(id) === view) return;
    const views = { ...this.state.views, [id]: view };
    this.set({ views });
    writeViews(views);
    this.hintView(id, view);
  }

  /** Show the terminal because the chat cannot render what claude is doing. Esc or Cmd+J returns. */
  openFallback(id: string, note: string): void {
    if (this.state.sessions.find((s) => s.id === id)?.mirror) return;
    this.set({ termNotes: { ...this.state.termNotes, [id]: note } });
    this.setView(id, 'terminal');
  }

  /** Tell the backend which view shows, so a hidden picker goes to the TUI while it is on screen. */
  private hintView(id: string, view: ViewMode): void {
    void this.ipc.sessionView(id, view).catch(() => undefined);
  }

  toggleView(id: string): void {
    this.switchView(id, this.viewOf(id) === 'chat' ? 'terminal' : 'chat');
  }

  /**
   * The person switches the view (Cmd+J, the header toggle). Going to the terminal may carry
   * the chat draft there first. Automatic switches (a fallback, a hand-off) use `setView`.
   */
  switchView(id: string, view: ViewMode): void {
    if (view === 'terminal' && this.viewOf(id) === 'chat') this.carryDraft(id);
    this.setView(id, view);
  }

  /**
   * Chat to terminal with a draft: with "Carry chat draft to the terminal" on, type the text
   * into claude's input as one bracketed paste (no Enter: multi-line stays one input), clear it
   * in chat and say so. Pasted images and comments stay in chat. Nothing moves while a dialog
   * only the terminal answers is up (the same check that blocks a send), or while a chat prompt
   * waits (the terminal draws its picker as the view switches). Off: a one-time hint.
   */
  private carryDraft(id: string): void {
    const s = this.state.sessions.find((x) => x.id === id);
    const chat = this.chats.get(id);
    if (!s || !chat || s.mirror || s.status === 'exited') return;
    const kept: string[] = [];
    let text = chat.draft;
    for (const token of chat.pastedImages) {
      if (!text.includes(token)) continue;
      kept.push(token);
      text = text.split(token).join('');
    }
    text = text.replace(/[ \t]+\n/g, '\n').trim();
    if (!text) return;
    if (this.state.prefs?.chat?.carryDraft !== true) {
      this.showHint('draft.carry');
      return;
    }
    const snap = chat.getSnapshot();
    if (inTerminalDialog(s) || snap.prompts.some((p) => !p.resolved)) {
      this.showTermToast(id, 'Your draft stayed in chat: a dialog is open in the terminal.');
      return;
    }
    // Bracketed paste never carries its own end marker inside.
    const body = text.split('\x1b[201~').join('');
    void this.ipc
      .sessionWrite(id, utf8ToBase64(`\x1b[200~${body}\x1b[201~`))
      .catch(() => undefined);
    chat.replaceDraft(kept.length ? kept.join(' ') + ' ' : '');
    const stayed = kept.length > 0 || snap.comments.length > 0;
    this.showTermToast(
      id,
      stayed
        ? 'Draft moved to the terminal. Images and comments stayed in chat.'
        : 'Draft moved to the terminal.',
    );
  }

  private termToastTimer = 0;

  /** A short note above the terminal, gone after a few seconds. */
  private showTermToast(id: string, text: string): void {
    window.clearTimeout(this.termToastTimer);
    this.set({ termToast: { id, text } });
    this.termToastTimer = window.setTimeout(() => this.set({ termToast: null }), 5000);
  }

  openThread(thread: OpenThread | null): void {
    this.set({ thread });
  }

  private setBadges(id: string, b: Badges): void {
    const cur = this.state.badges[id];
    if (cur && cur.unread === b.unread && cur.needsYou === b.needsYou) return;
    this.set({ badges: { ...this.state.badges, [id]: b } });
  }

  /** The DM is on screen: its unread count clears. Needs-you never clears here. */
  markRead(id: string): void {
    const cur = this.state.badges[id];
    if (cur && cur.unread === 0) return;
    this.setBadges(id, { unread: 0, needsYou: cur?.needsYou ?? 0 });
    void this.ipc.sessionMarkRead(id).catch(() => undefined);
  }

  private readonly images = new Map<string, Promise<string>>();

  /** Image bytes for a user message, fetched once per ref. */
  chatImage(id: string, ref: string): Promise<string> {
    const key = `${id}:${ref}`;
    let p = this.images.get(key);
    if (!p) {
      p = this.ipc.chatImage(id, ref).then((r) => r.dataUrl);
      p.catch(() => this.images.delete(key));
      this.images.set(key, p);
    }
    return p;
  }

  cycleMode(id: string): void {
    void this.ipc.statuslineCycleMode(id).catch((err: unknown) => {
      this.set({ error: `Could not change the mode: ${String(err)}` });
    });
  }

  /** PTY bytes seen per DM: a slash command that repaints the terminal moves this. */
  private readonly ptyBytes = new Map<string, number>();

  /**
   * Send composer text to claude exactly as typed. Every outcome is visible: a send that did
   * not go through leaves a notice under the log and the caller keeps the draft.
   */
  async sendText(id: string, text: string): Promise<SendResultKind> {
    const chat = this.chat(id);
    const before = chat.userItemKeys();
    const items0 = chat.itemCount();
    const pty0 = this.ptyBytes.get(id) ?? 0;
    let outcome: SendOutcome;
    try {
      const r = await this.ipc.sessionSendText(id, text);
      outcome = r ? r.outcome : 'sent';
    } catch (err) {
      this.set({ error: `Could not send the message: ${String(err)}` });
      return 'error';
    }
    if (outcome === 'blocked_dialog') {
      chat.setNotice({
        kind: 'blocked',
        text: 'Claude is showing something in the terminal. Your message was not sent. It stays in the box.',
      });
    } else if (outcome === 'mirror_readonly') {
      chat.setNotice({
        kind: 'mirror',
        text: 'This session is open in another terminal. Your message was not sent. It stays in the box.',
      });
    } else if (outcome === 'queued' && !slashName(text)) {
      // Claude Code holds it as queued input and writes no transcript entry until it reads it:
      // show it now, below the live turn, until that entry replaces it.
      chat.clearNotice();
      chat.addQueued(text);
    } else if (outcome === 'queued') {
      chat.setNotice({ kind: 'queued', text: 'Queued. Claude reads it after this turn.' }, 4000);
    } else {
      chat.clearNotice();
      const name = slashName(text);
      if (name && isInteractiveSlash(text)) {
        this.openFallback(id, `/${name} opens in the terminal. Esc or \u2318J returns to chat.`);
      } else if (name) {
        this.watchSlash(id, name, items0, pty0);
      } else {
        this.watchEcho(id, before);
      }
    }
    return outcome;
  }

  /** A plain message must show up as a user item soon; if not, say so. */
  private watchEcho(id: string, before: Set<string>): void {
    window.setTimeout(() => {
      const chat = this.chat(id);
      for (const k of chat.userItemKeys()) if (!before.has(k)) return;
      if (chat.getSnapshot().notice) return;
      chat.setNotice({
        kind: 'no-echo',
        text: 'Claude has not shown your message yet. It may be busy or waiting in the terminal.',
      });
    }, ECHO_WAIT_MS);
  }

  /**
   * An unknown slash command: if no transcript item follows while the PTY repaints, claude opened
   * a panel the chat cannot show. Flip to the terminal with a note.
   */
  private watchSlash(id: string, name: string, items0: number, pty0: number): void {
    window.setTimeout(() => {
      if (this.viewOf(id) !== 'chat') return;
      if (this.chat(id).itemCount() !== items0) return;
      if ((this.ptyBytes.get(id) ?? 0) === pty0) return;
      this.openFallback(
        id,
        `Claude did not answer /${name} in chat, so the terminal shows it. Esc or \u2318J returns to chat.`,
      );
    }, SLASH_QUIET_MS);
  }

  /** Save a pasted image and insert its absolute path into the draft. Nothing reaches the PTY. */
  async pasteImage(id: string, file: Blob): Promise<void> {
    try {
      const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      const { path } = await this.ipc.pasteImage(id, data, file.type || 'image/png');
      const token = shellQuotePath(path);
      this.chat(id).pastedImages.add(token);
      this.chat(id).insertIntoDraft(token + ' ');
    } catch (err) {
      this.set({ error: `Could not paste the image: ${String(err)}` });
    }
  }

  /** Arm or disarm "Take over when it closes". */
  async takeoverWhenClosed(id: string, enabled: boolean): Promise<void> {
    try {
      await this.ipc.sessionMirrorTakeoverWhenClosed(id, enabled);
    } catch (err) {
      this.set({ error: `Could not change take over: ${String(err)}` });
    }
  }

  /** Bring the other terminal to the front. Resolves to the failure text, or null. */
  async revealMirror(id: string): Promise<string | null> {
    try {
      await this.ipc.sessionMirrorReveal(id);
      return null;
    } catch (err) {
      return String(err).replace(/^Error: /, '');
    }
  }

  /**
   * Stop the idle copy in the other terminal and resume here (the user confirmed). Resolves to
   * the refusal text, or null once the session is ours.
   */
  async endMirror(id: string): Promise<string | null> {
    try {
      const { cols, rows } = this.terminal(id).term;
      const info = await this.ipc.sessionMirrorEnd(id, cols, rows);
      this.patchSession(id, { ...info, mirror: null });
      await this.refresh();
      return null;
    } catch (err) {
      return String(err).replace(/^Error: /, '');
    }
  }

  /**
   * Save a status strip layout: for one DM, or as the global default when `dmId` is omitted.
   * `null` removes the override (or resets the default to the built-in layout).
   */
  async setStatusBar(dmId: string | null, list: string[] | null): Promise<void> {
    const cur = this.state.prefs?.statusBar ?? { default: null, perDm: {} };
    let next: StatusBarPrefs;
    if (dmId) {
      const perDm = { ...cur.perDm };
      if (list) perDm[dmId] = list;
      else delete perDm[dmId];
      next = { ...cur, perDm };
    } else {
      next = { ...cur, default: list };
    }
    if (this.state.prefs) this.set({ prefs: { ...this.state.prefs, statusBar: next } });
    await this.setPrefs({ statusBar: next });
  }

  /** Esc to the PTY: interrupts the running turn. */
  stopTurn(id: string): void {
    void this.ipc.sessionWrite(id, utf8ToBase64('\x1b')).catch(() => undefined);
    // Esc puts Claude Code's queued input back in its prompt.
    if (this.chat(id).pendingQueued().length) this.armQueueReturn(id, true);
  }

  // ---- queued messages --------------------------------------------------------------------

  private readonly queueTimers = new Map<string, number>();

  /**
   * After a quiet spell, messages still queued did not go: Claude went idle without reading
   * them, or Stop interrupted the turn. `force` checks even if the status still says busy.
   */
  private armQueueReturn(id: string, force = false): void {
    window.clearTimeout(this.queueTimers.get(id));
    this.queueTimers.set(
      id,
      window.setTimeout(() => {
        this.queueTimers.delete(id);
        const status = this.state.sessions.find((s) => s.id === id)?.status;
        if (!force && status === 'busy') return;
        this.chat(id).markQueued('returned');
      }, QUEUE_RETURN_MS),
    );
  }

  /** "Send now" on a queued message: Claude Code's Ctrl+X Ctrl+S sends its queue at once. */
  sendQueuedNow(id: string): void {
    void this.ipc.sessionWrite(id, utf8ToBase64('\x18\x13')).catch(() => undefined);
  }

  /**
   * Retry a message that was not sent. After an interrupt the text sits in Claude's prompt, so
   * Enter sends it. After the session ended, it goes back to the composer instead.
   */
  retryQueued(id: string, qid: string): void {
    const chat = this.chat(id);
    const q = chat.getSnapshot().queued.find((x) => x.id === qid);
    if (!q) return;
    const s = this.state.sessions.find((x) => x.id === id);
    if (q.state === 'returned' && s && s.status !== 'exited') {
      chat.requeue(qid);
      void this.ipc.sessionWrite(id, utf8ToBase64('\r')).catch(() => undefined);
      return;
    }
    chat.removeQueued(qid);
    chat.insertIntoDraft(q.text);
  }

  removeQueued(id: string, qid: string): void {
    this.chat(id).removeQueued(qid);
  }

  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unlisten = await Promise.all([
      this.ipc.on('pty:output', (e) => {
        this.ptyBytes.set(e.id, (this.ptyBytes.get(e.id) ?? 0) + e.data.length);
        this.terminal(e.id).writeBase64(e.data);
      }),
      this.ipc.on('pty:exit', (e) => {
        this.patchSession(e.id, { status: 'exited', exitCode: e.code });
        this.chat(e.id).clearNotice('queued');
        // The session ended before Claude read its queue: those messages were not sent.
        window.clearTimeout(this.queueTimers.get(e.id));
        this.chat(e.id).markQueued('ended');
      }),
      this.ipc.on('session:title', (e) => this.patchSession(e.id, { title: e.title })),
      this.ipc.on('session:status', (e) => {
        const was = this.state.sessions.find((s) => s.id === e.id)?.status;
        if (this.state.restart?.waiting) queueMicrotask(() => this.checkRestart());
        this.patchSession(e.id, {
          status: e.status,
          needs: e.status === 'waiting' ? e.needs : undefined,
          // When the turn began, for the working line's clock.
          ...(e.status === 'busy' && was !== 'busy' ? { busySince: Date.now() } : {}),
        });
        if (e.status === 'busy') window.clearTimeout(this.queueTimers.get(e.id));
        else if (e.status === 'idle' && this.chat(e.id).pendingQueued().length)
          this.armQueueReturn(e.id);
      }),
      this.ipc.on('session:terminal_wait', (e) =>
        this.patchSession(e.id, { terminalWait: { reason: e.reason, since: e.since } }),
      ),
      this.ipc.on('session:terminal_wait_clear', (e) => {
        this.patchSession(e.id, { terminalWait: null });
        // The dialog is gone: its "not sent" notice no longer applies.
        this.chat(e.id).clearNotice('blocked');
      }),
      // The CLI opened a URL (BROWSER points at patchroom-hook): the Links preference decides.
      this.ipc.on('link:open', (e) => this.openLink(e.url)),
      // The app menu owns Cmd+, in the real app, so the keydown never reaches the page.
      this.ipc.on('menu:settings', () => this.setPanel('prefs')),
      this.ipc.on('viewer:changed', (e) => {
        const v = this.state.viewer;
        if (!v) return;
        // A new page clears the sign-in note until that page says otherwise.
        const signIn = e.url === v.url ? v.signIn : false;
        this.set({ viewer: { ...v, url: e.url, loading: e.loading, signIn } });
      }),
      this.ipc.on('viewer:title', (e) => {
        const v = this.state.viewer;
        if (v) this.set({ viewer: { ...v, title: e.title } });
      }),
      this.ipc.on('viewer:selection', (e) => this.addViewerComment(e.text, e.url)),
      this.ipc.on('viewer:account', (e) => this.noteAccount(e.signedIn, e.url)),
      this.ipc.on('menu:comment', () => this.commentOnSelection()),
      this.ipc.on('menu:screenshot', () => void this.startShot()),
      this.ipc.on('menu:restart', () => this.requestRestart()),
      this.ipc.on('session:working', (e) =>
        this.patchSession(e.id, {
          working: e.verb ? { verb: e.verb, detail: e.detail ?? '' } : null,
        }),
      ),
      this.ipc.on('session:mirror', (e) => {
        this.patchSession(e.id, { mirror: e.mirror });
        if (!e.mirror) this.chat(e.id).clearNotice('mirror');
      }),
      this.ipc.on('chat:items', (e) => this.chat(e.id).apply(e.items)),
      this.ipc.on('prompt:pending', (e) => this.chat(e.id).addPrompt(e)),
      this.ipc.on('prompt:resolved', (e) => this.chat(e.id).resolvePrompt(e.promptId, e.by)),
      this.ipc.on('session:badges', (e) =>
        this.setBadges(e.id, { unread: e.unread, needsYou: asCount(e.needsYou) }),
      ),
      this.ipc.on('statusline:update', (e) => this.chat(e.id).setStatusline(e)),
      this.ipc.on('notify:fire', (e) => {
        for (const fn of this.notifyListeners) fn(e);
      }),
      this.ipc.on('prefs:changed', (e) => this.set({ prefs: e.prefs })),
      // The user clicked a native notification: show that DM.
      this.ipc.on('notify:open', (e) => this.openDm(e.id)),
      this.ipc.on('activity:changed', () => this.scheduleActivity()),
      this.ipc.on('folder:changed', (e) => this.scheduleFolder(e.sectionId)),
    ]);
    window.addEventListener('pagehide', this.flushAllDrafts);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.onWindowFocus);
    this.unlisten.push(
      subscribeOverlays(() => {
        if (this.state.overlays !== overlayCount()) this.set({ overlays: overlayCount() });
      }),
    );
    bindAccountActions({
      signIn: () => this.signInClaude(),
      signOut: () => this.signOutClaude(),
    });
    try {
      const [sessions, sections] = await Promise.all([
        this.ipc.sessionList(),
        this.ipc.sectionList(),
      ]);
      const activeId = this.state.activeId ?? firstActive(sessions);
      this.set({
        badges: seedBadges(sessions, this.state.badges),
        sessions: mergeSessions(sessions, this.state.sessions),
        sections: sortSections(sections),
        activeId,
        ready: true,
      });
      if (activeId) this.touchRecent(activeId);
      this.syncFolders();
      void this.loadP3();
    } catch (err) {
      this.set({ ready: true, error: `Could not load sessions: ${String(err)}` });
    }
  }

  /** Marks, prefs and the activity list. Each is optional: an older backend may lack them. */
  private async loadP3(): Promise<void> {
    const [marks, prefs] = await Promise.all([
      this.ipc.markList().catch(() => null),
      this.ipc.prefsGet().catch(() => null),
    ]);
    this.set({ ...(marks ? { marks } : {}), ...(prefs ? { prefs } : {}) });
    void this.loadCatalog();
    void this.reopenAfterRestart();
    if (prefs?.updates?.checkApp) void this.checkForUpdate();
    await this.loadActivity();
  }

  stop(): void {
    for (const t of this.folderTimers.values()) window.clearTimeout(t);
    this.folderTimers.clear();
    this.flushAllDrafts();
    window.removeEventListener('pagehide', this.flushAllDrafts);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('focus', this.onWindowFocus);
    for (const off of this.unlisten) off();
    this.unlisten = [];
    for (const off of this.unbindTerms.values()) off();
    this.unbindTerms.clear();
    for (const t of this.terminals.values()) t.dispose();
    this.terminals.clear();
    this.chats.clear();
    this.started = false;
  }

  select(id: string): void {
    const prev = this.state.activeId;
    this.touchRecent(id);
    if (prev === id) return;
    if (prev) this.flushDraft(prev);
    this.set({ activeId: id });
    // The terminal view only counts as shown for the DM that is open.
    if (prev && this.viewOf(prev) === 'terminal') this.hintView(prev, 'chat');
    if (this.viewOf(id) === 'terminal') this.hintView(id, 'terminal');
  }

  async create(
    cwd: string,
    name?: string,
    sectionId?: string | null,
    emoji?: { char: string; flavor: EmojiFlavor },
  ): Promise<void> {
    try {
      // A bundle that applies here launches the session on its default model.
      const args = launchArgsFor(this.state.prefs, this.state.catalog, { sectionId, cwd });
      const { id } = await this.ipc.sessionCreate({
        cwd,
        name: name || folderName(cwd),
        ...(args ? { args } : {}),
      });
      if (sectionId) await this.ipc.sessionSetSection(id, sectionId);
      if (emoji) await this.ipc.sessionSetEmoji(id, emoji.char, emoji.flavor);
      writeLastCwd(cwd);
      const known = this.state.sessions.find((s) => s.id === id);
      const sessions = known
        ? this.state.sessions
        : [
            ...this.state.sessions,
            {
              id,
              name: name || folderName(cwd),
              cwd,
              title: 'Starting',
              status: 'busy' as SessionStatus,
              sectionId: sectionId ?? null,
            },
          ];
      this.set({ sessions, activeId: id, lastCwd: cwd, error: null });
      // Reconcile with the backend row (it owns the name and title).
      await this.refresh();
    } catch (err) {
      this.set({ error: `Could not start the session: ${String(err)}` });
    }
  }

  /**
   * Restart an exited DM through the backend's `session_resume`. The DM keeps its id, so the
   * sidebar row, terminal and stored history stay the same. Never creates a second DM.
   */
  async resume(session: SessionInfo, openAnyway = false): Promise<void> {
    try {
      const { cols, rows } = this.terminal(session.id).term;
      const r = await this.ipc.sessionResume(session.id, cols, rows, { openAnyway });
      if (isCheckFailed(r)) {
        this.set({
          checkFailed: {
            name: session.name,
            reason: r.reason,
            target: { kind: 'resume', id: session.id },
          },
        });
        return;
      }
      this.set({ checkFailed: null });
      this.patchSession(session.id, { status: 'busy', needs: undefined, exitCode: undefined });
      this.set({ activeId: session.id, error: null });
      await this.refresh();
    } catch (err) {
      this.set({ error: `Could not resume: ${String(err)}` });
    }
  }

  /** Repeat the stopped open without the live check. The dialog warns about two processes. */
  async openAnyway(): Promise<void> {
    const p = this.state.checkFailed;
    if (!p) return;
    if (p.target.kind === 'folder') {
      await this.openFolderSession(p.target.sectionId, p.target.sessionId, true);
    } else {
      const s = this.state.sessions.find((x) => x.id === (p.target as { id: string }).id);
      if (s) await this.resume(s, true);
      else this.set({ checkFailed: null });
    }
  }

  dismissCheckFailed(): void {
    if (this.state.checkFailed) this.set({ checkFailed: null });
  }

  /** Re-read DMs and sections from the backend, which owns names, titles and sections. */
  async refresh(): Promise<void> {
    const [rows, sections] = await Promise.all([this.ipc.sessionList(), this.ipc.sectionList()]);
    // A draft still waiting for its debounced write is newer than the backend's flag.
    const fresh = rows.map((s) =>
      this.dirtyDrafts.has(s.id) ? { ...s, hasDraft: this.chat(s.id).draft !== '' } : s,
    );
    this.set({
      badges: seedBadges(fresh, this.state.badges),
      sessions: mergeSessions(fresh, this.state.sessions),
      sections: sortSections(sections),
    });
    this.syncFolders();
  }

  async createSection(
    name: string,
    emoji?: string | null,
    flavor: EmojiFlavor = 'apple',
  ): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const { id } = await this.ipc.sectionCreate(trimmed, emoji ? { emoji } : undefined);
      // The flavor is half of the `{char, flavor}` pair: store it with the emoji.
      if (emoji && flavor !== 'apple') await this.ipc.sectionSetEmoji(id, emoji, flavor);
      await this.refresh();
    } catch (err) {
      this.set({ error: `Could not add the section: ${String(err)}` });
    }
  }

  /**
   * Add a divider: at the end, or directly above `beforeId`. The label is optional (no label is a
   * plain rule).
   */
  async createDivider(label = '', beforeId?: string): Promise<string | null> {
    try {
      const { id } = await this.ipc.sectionCreate(label.trim(), { kind: 'divider' });
      await this.refresh();
      if (beforeId) {
        const ids = this.state.sections.map((s) => s.id).filter((x) => x !== id);
        const at = ids.indexOf(beforeId);
        if (at >= 0) {
          ids.splice(at, 0, id);
          await this.reorderSections(ids);
        }
      }
      return id;
    } catch (err) {
      this.set({ error: `Could not add the divider: ${String(err)}` });
      return null;
    }
  }

  /** Set or clear the leading emoji of a section or divider, with its flavor. */
  async setSectionEmoji(
    id: string,
    emoji: string | null,
    flavor: EmojiFlavor = 'apple',
  ): Promise<void> {
    const prev = this.state.sections;
    const emojiFlavor = emoji ? flavor : null;
    this.set({ sections: prev.map((s) => (s.id === id ? { ...s, emoji, emojiFlavor } : s)) });
    try {
      await this.ipc.sectionSetEmoji(id, emoji, flavor);
      if (emoji) this.showHint('emoji.flavor');
    } catch (err) {
      this.set({ sections: prev, error: `Could not save the emoji: ${String(err)}` });
    }
  }

  /** Rename a session row. Blank names are ignored. */
  async renameSession(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    const prev = this.state.sessions.find((s) => s.id === id);
    if (!trimmed || !prev || prev.name === trimmed) return;
    this.patchSession(id, { name: trimmed });
    try {
      await this.ipc.sessionRename(id, trimmed);
    } catch (err) {
      this.patchSession(id, { name: prev.name });
      this.set({ error: `Could not rename the session: ${String(err)}` });
    }
  }

  /** Set or clear a session row's emoji, with its flavor. */
  async setSessionEmoji(
    id: string,
    emoji: string | null,
    flavor: EmojiFlavor = 'apple',
  ): Promise<void> {
    const prev = this.state.sessions.find((s) => s.id === id);
    this.patchSession(id, { emoji, emojiFlavor: emoji ? flavor : null });
    try {
      await this.ipc.sessionSetEmoji(id, emoji, flavor);
      if (emoji) this.showHint('emoji.flavor');
    } catch (err) {
      if (prev) this.patchSession(id, { emoji: prev.emoji, emojiFlavor: prev.emojiFlavor });
      this.set({ error: `Could not save the emoji: ${String(err)}` });
    }
  }

  /** Collapse or expand several stored sections at once (Option+click on a header). */
  async setSectionsCollapsed(ids: string[], collapsed: boolean): Promise<void> {
    const prev = this.state.sections;
    const hit = new Set(ids);
    const changing = prev.filter((s) => hit.has(s.id) && s.collapsed !== collapsed);
    if (changing.length === 0) return;
    this.set({ sections: prev.map((s) => (hit.has(s.id) ? { ...s, collapsed } : s)) });
    try {
      await Promise.all(changing.map((s) => this.ipc.sectionSetCollapsed(s.id, collapsed)));
    } catch (err) {
      this.set({ sections: prev, error: `Could not save the sections: ${String(err)}` });
    }
  }

  async setSectionCollapsed(id: string, collapsed: boolean): Promise<void> {
    const prev = this.state.sections;
    this.set({ sections: prev.map((s) => (s.id === id ? { ...s, collapsed } : s)) });
    try {
      await this.ipc.sectionSetCollapsed(id, collapsed);
    } catch (err) {
      this.set({ sections: prev, error: `Could not save the section: ${String(err)}` });
    }
  }

  /** Move a DM to a stored section, or to the default group with null. */
  async moveSession(id: string, sectionId: string | null): Promise<void> {
    const prev = this.state.sessions;
    const from = prev.find((s) => s.id === id)?.sectionId ?? null;
    // The folder chip belongs to a folder section; the backend re-derives it after the move.
    this.patchSession(
      id,
      this.isFolderSection(sectionId) ? { sectionId } : { sectionId, folderChip: null },
    );
    try {
      await this.ipc.sessionSetSection(id, sectionId);
      if (this.isFolderSection(sectionId) || this.isFolderSection(from)) await this.refresh();
    } catch (err) {
      this.set({ sessions: prev, error: `Could not move the session: ${String(err)}` });
    }
  }

  // ---- P3: sections --------------------------------------------------------------------

  async renameSection(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    const prev = this.state.sections;
    const cur = prev.find((s) => s.id === id);
    // A divider may lose its label; a section may not.
    if ((!trimmed && cur?.kind !== 'divider') || cur?.name === trimmed) return;
    this.set({ sections: prev.map((s) => (s.id === id ? { ...s, name: trimmed } : s)) });
    try {
      await this.ipc.sectionRename(id, trimmed);
    } catch (err) {
      this.set({ sections: prev, error: `Could not rename the section: ${String(err)}` });
    }
  }

  /** The section's DMs fall back to Direct messages. */
  async deleteSection(id: string): Promise<void> {
    const { sections, sessions } = this.state;
    this.set({
      sections: sections.filter((s) => s.id !== id),
      sessions: sessions.map((s) => (s.sectionId === id ? { ...s, sectionId: null } : s)),
    });
    try {
      await this.ipc.sectionDelete(id);
    } catch (err) {
      this.set({ sections, sessions, error: `Could not delete the section: ${String(err)}` });
    }
  }

  async reorderSections(ids: string[]): Promise<void> {
    const prev = this.state.sections;
    const by = new Map(prev.map((s) => [s.id, s]));
    const next = ids.flatMap((id, position) => {
      const s = by.get(id);
      return s ? [{ ...s, position }] : [];
    });
    this.set({ sections: next });
    try {
      await this.ipc.sectionReorder(ids);
    } catch (err) {
      this.set({ sections: prev, error: `Could not reorder the sections: ${String(err)}` });
    }
  }

  async setFlags(id: string, flags: { starred?: boolean; archived?: boolean }): Promise<void> {
    const prev = this.state.sessions;
    this.patchSession(id, flags);
    try {
      await this.ipc.sessionSetFlags(id, flags);
    } catch (err) {
      this.set({ sessions: prev, error: `Could not update the session: ${String(err)}` });
    }
  }

  /**
   * Drop a DM on a sidebar group. `ids` is the destination group's order with the DM in place,
   * used for sections and Direct messages. Starred and Archived are flags and keep no order.
   */
  async dropSession(id: string, dest: DropDest, ids: string[]): Promise<void> {
    const prev = this.state.sessions;
    const flags: { starred?: boolean; archived?: boolean } = {};
    if (dest.kind === 'starred') {
      flags.starred = true;
      flags.archived = false;
    } else if (dest.kind === 'archived') flags.archived = true;
    else {
      flags.starred = false;
      flags.archived = false;
    }
    const sectionId = dest.kind === 'section' ? dest.sectionId : null;
    const ordered = dest.kind === 'section' || dest.kind === 'default';
    // Optimistic: flags first, then the destination group's order.
    let next = prev.map((s) => (s.id === id ? { ...s, ...flags } : s));
    if (ordered) {
      const moved = ids.flatMap((x) => {
        const s = next.find((y) => y.id === x);
        return s
          ? [{ ...s, sectionId, ...(this.isFolderSection(sectionId) ? {} : { folderChip: null }) }]
          : [];
      });
      next = [...next.filter((s) => !ids.includes(s.id)), ...moved];
    }
    this.set({ sessions: next });
    try {
      const cur = prev.find((s) => s.id === id);
      const changed = Object.entries(flags).filter(
        ([k, v]) => Boolean(cur?.[k as 'starred' | 'archived']) !== v,
      );
      if (changed.length > 0) await this.ipc.sessionSetFlags(id, Object.fromEntries(changed));
      if (ordered) await this.ipc.sessionReorder(sectionId, ids);
      // The backend owns the folder chip: re-read after a DM lands in a folder section.
      const was = prev.find((s) => s.id === id)?.sectionId ?? null;
      if (this.isFolderSection(sectionId) || this.isFolderSection(was)) await this.refresh();
    } catch (err) {
      this.set({ sessions: prev, error: `Could not move the session: ${String(err)}` });
    }
  }

  // ---- P3: folder sections -------------------------------------------------------------

  isFolderSection(id: string | null): boolean {
    return id !== null && !!this.state.sections.find((s) => s.id === id)?.folder;
  }

  /** Read the listing of every folder section that has none yet, and drop stale ones. */
  private syncFolders(): void {
    const ids = new Set(this.state.sections.filter((s) => s.folder).map((s) => s.id));
    const have = this.state.folders;
    if (Object.keys(have).some((k) => !ids.has(k))) {
      this.set({ folders: Object.fromEntries(Object.entries(have).filter(([k]) => ids.has(k))) });
    }
    for (const id of ids) if (!have[id]) void this.loadFolder(id);
  }

  private readonly folderTimers = new Map<string, number>();
  /** `folder:changed` can fire in bursts while a session writes: one read per 60 ms window. */
  private scheduleFolder(sectionId: string): void {
    if (this.folderTimers.has(sectionId)) return;
    this.folderTimers.set(
      sectionId,
      window.setTimeout(() => {
        this.folderTimers.delete(sectionId);
        void this.loadFolder(sectionId);
      }, 60),
    );
  }

  async loadFolder(sectionId: string): Promise<void> {
    const cur = this.state.folders[sectionId];
    if (!cur) {
      this.set({
        folders: {
          ...this.state.folders,
          [sectionId]: { sessions: [], hiddenCount: 0, loading: true, error: null },
        },
      });
    }
    try {
      const r = await this.ipc.folderSessions(sectionId);
      this.set({
        folders: {
          ...this.state.folders,
          [sectionId]: {
            sessions: r.sessions,
            hiddenCount: r.hiddenCount,
            loading: false,
            error: null,
          },
        },
      });
    } catch (err) {
      const prev = this.state.folders[sectionId];
      this.set({
        folders: {
          ...this.state.folders,
          [sectionId]: {
            sessions: prev?.sessions ?? [],
            hiddenCount: prev?.hiddenCount ?? 0,
            loading: false,
            error: String(err),
          },
        },
      });
    }
  }

  /** Pick a folder and make a section from it. Resolves the new section id (null: cancelled). */
  async createFolderSection(path?: string): Promise<string | null> {
    try {
      const picked = path ?? (await this.ipc.pickFolder(this.state.lastCwd || undefined));
      if (!picked) return null;
      const { id } = await this.ipc.sectionCreateFromFolder(picked);
      await this.refresh();
      return id;
    } catch (err) {
      this.set({ error: `Could not add the folder section: ${String(err)}` });
      return null;
    }
  }

  async setArchiveDays(id: string, days: number): Promise<void> {
    const n = Math.max(1, Math.min(3650, Math.round(days)));
    const prev = this.state.sections;
    this.set({ sections: prev.map((s) => (s.id === id ? { ...s, archiveDays: n } : s)) });
    try {
      await this.ipc.sectionSetArchiveDays(id, n);
    } catch (err) {
      this.set({ sections: prev, error: `Could not save the setting: ${String(err)}` });
    }
  }

  async hideFolderSession(sectionId: string, sessionId: string, hidden: boolean): Promise<void> {
    try {
      await this.ipc.folderSessionHide(sectionId, sessionId, hidden);
      await this.loadFolder(sectionId);
    } catch (err) {
      this.set({ error: `Could not ${hidden ? 'hide' : 'unhide'} the session: ${String(err)}` });
    }
  }

  /** Turn a listed session into a normal DM in its section (spawns `claude --resume`). */
  async openFolderSession(sectionId: string, sessionId: string, openAnyway = false): Promise<void> {
    try {
      const info = await this.ipc.folderSessionOpen(sectionId, sessionId, { openAnyway });
      if (isCheckFailed(info)) {
        const row = this.state.folders[sectionId]?.sessions.find((s) => s.sessionId === sessionId);
        this.set({
          checkFailed: {
            name: row?.name || 'this session',
            reason: info.reason,
            target: { kind: 'folder', sectionId, sessionId },
          },
        });
        return;
      }
      this.set({ checkFailed: null });
      const known = this.state.sessions.some((s) => s.id === info.id);
      this.set({
        sessions: known
          ? this.state.sessions.map((s) => (s.id === info.id ? { ...s, ...info } : s))
          : [...this.state.sessions, info],
        error: null,
      });
      this.openDm(info.id);
      await Promise.all([this.refresh(), this.loadFolder(sectionId)]);
    } catch (err) {
      this.set({ error: `Could not open the session: ${String(err)}` });
    }
  }

  // ---- P3: opening a DM at a message ---------------------------------------------------

  private touchRecent(id: string): void {
    const recent = [id, ...this.state.recent.filter((x) => x !== id)].slice(0, 12);
    writeRecent(recent);
    this.state = { ...this.state, recent };
  }

  /**
   * Open an http(s) link where the Links preference says: the in-app viewer or the browser.
   * `invert` (Cmd-click) picks the other one; `target` forces one.
   */
  openLink(url: string, opts: { invert?: boolean; target?: 'patchroom' | 'browser' } = {}): void {
    if (!/^https?:\/\//i.test(url)) return;
    let where = opts.target ?? this.state.prefs?.links?.open ?? 'patchroom';
    if (opts.invert && !opts.target) where = where === 'patchroom' ? 'browser' : 'patchroom';
    if (where === 'browser') {
      void this.ipc
        .linkOpenExternal(url)
        .catch((err: unknown) => this.set({ error: `Could not open the link: ${String(err)}` }));
      return;
    }
    const req = (this.state.viewer?.req ?? 0) + 1;
    this.set({ viewer: { url, title: '', loading: true, req } });
  }

  /** Show an error in the app's error line. */
  reportError(message: string): void {
    this.set({ error: message });
  }

  /** The viewer's page, in the system browser. The first time, a hint waits for the return. */
  viewerToBrowser(): void {
    if (!this.state.viewer) return;
    this.openLink(this.state.viewer.url, { target: 'browser' });
    this.pendingHint = 'links.browser';
  }

  // ---- first-time hints ----------------------------------------------------------------

  /** A hint waiting for the window to get focus back (the person went to another app). */
  private pendingHint: HintId | null = null;

  private onWindowFocus = (): void => {
    const id = this.pendingHint;
    this.pendingHint = null;
    if (id) this.showHint(id);
  };

  /**
   * Show a first-time hint unless it was seen before or another hint is up. `once` overrides the
   * id that marks it seen (the per-model hints are once per model, tracked in model prefs).
   */
  showHint(id: HintId, vars: Record<string, string> | null = null, once = true): boolean {
    if (this.state.hint || !this.state.prefs) return false;
    const seen = this.state.prefs.hints?.seen ?? [];
    if (once && seen.includes(id)) return false;
    this.set({ hint: id, hintVars: vars });
    // Shown counts as seen: a hint never comes back, even if the app quits now.
    if (once) void this.setPrefs({ hints: { seen: [...seen, id] } });
    return true;
  }

  dismissHint(): void {
    if (this.state.hint) this.set({ hint: null, hintVars: null });
  }

  /** The hint's button: open the setting it names. */
  hintAction(): void {
    const id = this.state.hint;
    if (!id) return;
    this.set({ hint: null, hintVars: null });
    const { tab, setting } = HINTS[id].action as HintDef['action'];
    this.openPrefs({ tab, setting });
  }

  /** One of a hint's extra answers (Swap or Keep on "newer model available"). */
  hintChoice(choice: string): void {
    const id = this.state.hint;
    const vars = this.state.hintVars ?? {};
    this.set({ hint: null, hintVars: null });
    if (id === 'draft.carry' && choice === 'carry-on') {
      const chat = { autoScroll: true, ...this.state.prefs?.chat, carryDraft: true };
      if (this.state.prefs) this.set({ prefs: { ...this.state.prefs, chat } });
      void this.setPrefs({ chat });
    }
    if (id === 'models.newer' && choice === 'swap' && vars.bundle && vars.entry && vars.newerId) {
      void this.swapEntryModel(vars.bundle, vars.entry, vars.newerId);
    }
  }

  // ---- models: bundles, switching, the catalog ---------------------------------------------

  private get models(): ModelPrefs {
    return modelsOf(this.state.prefs);
  }

  private async saveModels(next: ModelPrefs): Promise<void> {
    if (this.state.prefs) this.set({ prefs: { ...this.state.prefs, models: next } });
    await this.setPrefs({ models: next });
  }

  /** The catalog: the shipped one, a signed one fetched earlier, and a fresh fetch on opt-in. */
  async loadCatalog(): Promise<void> {
    const cached = await this.ipc.catalogGet().catch(() => null);
    if (cached) this.set({ catalog: mergeCatalogs(SHIPPED_CATALOG, cached) });
    if (!this.state.prefs?.updates?.checkModels) return;
    await this.refreshCatalog();
  }

  /** Fetch the signed catalog now. Only runs when "Check for newer models" is on. */
  async refreshCatalog(): Promise<string | null> {
    if (!this.state.prefs?.updates?.checkModels) return 'Check for newer models is off.';
    try {
      const fresh = await this.ipc.catalogRefresh();
      this.set({ catalog: mergeCatalogs(SHIPPED_CATALOG, fresh) });
      return null;
    } catch (err) {
      return String(err).replace(/^Error: /, '');
    }
  }

  /** Ask GitHub Releases for a newer Patchroom. Only runs when "Check for app updates" is on. */
  async checkForUpdate(): Promise<string | null> {
    if (!this.state.prefs?.updates?.checkApp) return 'Check for app updates is off.';
    try {
      this.set({ update: await this.ipc.updateCheck() });
      return null;
    } catch (err) {
      return String(err).replace(/^Error: /, '');
    }
  }

  /** Answer "Want to check for newer models?": Turn on (and fetch now) or Not now. */
  async answerModelChecks(on: boolean): Promise<void> {
    const cur = this.state.prefs?.updates ?? {
      checkApp: false,
      checkModels: false,
      askedModels: false,
    };
    await this.setPrefs({
      updates: { ...cur, checkModels: on || cur.checkModels, askedModels: true },
    });
    if (on) void this.refreshCatalog();
  }

  /** Where a DM sits, for its bundle. */
  scopeOf(sessionId: string): BundleScope {
    const s = this.state.sessions.find((x) => x.id === sessionId);
    return { sessionId, sectionId: s?.sectionId ?? null, cwd: s?.cwd ?? null };
  }

  /** Use `bundleId` for one DM (null: follow its section, folder or the default again). */
  async setSessionBundle(sessionId: string, bundleId: string | null): Promise<void> {
    const m = this.models;
    const perSession = { ...m.perSession };
    if (bundleId) perSession[sessionId] = bundleId;
    else delete perSession[sessionId];
    await this.saveModels({ ...m, perSession });
  }

  /**
   * Switch an idle DM to a bundle entry's model: type the tool's switch command, then wait for the
   * CLI to report it. Never while busy. Success remembers it for resume; a miss shows why.
   */
  async switchModel(sessionId: string, entry: BundleEntry): Promise<void> {
    const s = this.state.sessions.find((x) => x.id === sessionId);
    const model = resolveModel(this.state.catalog, entry.tool, entry.model);
    const fail = (message: string) =>
      this.set({
        modelSwitch: {
          ...this.state.modelSwitch,
          [sessionId]: { target: model, state: 'error', message },
        },
      });
    if (!s) return;
    if (s.status !== 'idle') {
      fail('Claude is working. Switch models when it is idle.');
      return;
    }
    const adapter = adapterOf(entry.tool);
    const cmd = adapter?.switchCommand(model);
    if (!adapter?.ready || !cmd) {
      fail(`${adapter?.name ?? entry.tool} cannot switch models from Patchroom yet.`);
      return;
    }
    const chat = this.chat(sessionId);
    if (modelTook(model, chat.getSnapshot().statusline?.chips)) return;
    this.set({
      modelSwitch: { ...this.state.modelSwitch, [sessionId]: { target: model, state: 'pending' } },
    });
    try {
      const r = await this.ipc.sessionSendText(sessionId, cmd);
      const outcome = r ? r.outcome : 'sent';
      if (outcome !== 'sent') {
        fail(
          outcome === 'queued'
            ? 'Claude is working. Switch models when it is idle.'
            : 'Claude is showing something in the terminal. Nothing was typed.',
        );
        return;
      }
    } catch (err) {
      fail(`Could not switch: ${String(err).replace(/^Error: /, '')}`);
      return;
    }
    const took = await new Promise<boolean>((resolve) => {
      const check = () => modelTook(model, chat.getSnapshot().statusline?.chips);
      if (check()) return resolve(true);
      const off = chat.subscribe(() => {
        if (check()) {
          off();
          window.clearTimeout(timer);
          resolve(true);
        }
      });
      const timer = window.setTimeout(() => {
        off();
        resolve(check());
      }, MODEL_SWITCH_WAIT_MS);
    });
    if (!took) {
      const now = chat.getSnapshot().statusline?.chips;
      const reported = now?.modelId ?? now?.model;
      fail(
        `Claude did not switch to ${modelName(this.state.catalog, model)}.${
          reported ? ` It still reports ${reported}.` : ''
        }`,
      );
      return;
    }
    const rest = { ...this.state.modelSwitch };
    delete rest[sessionId];
    this.set({ modelSwitch: rest });
    void this.ipc.sessionSetModel(sessionId, model).catch(() => undefined);
  }

  clearModelSwitch(sessionId: string): void {
    if (!this.state.modelSwitch[sessionId]) return;
    const rest = { ...this.state.modelSwitch };
    delete rest[sessionId];
    this.set({ modelSwitch: rest });
  }

  /** Replace one bundle entry's model (the Swap answer). The entry stays where it is. */
  async swapEntryModel(bundleId: string, entryId: string, model: string): Promise<void> {
    const m = this.models;
    const bundles = m.bundles.map((b) =>
      b.id !== bundleId
        ? b
        : { ...b, entries: b.entries.map((e) => (e.id === entryId ? { ...e, model } : e)) },
    );
    await this.saveModels({ ...m, bundles });
  }

  /**
   * The model chip showed `modelId` in a DM. Once per model: offer a newer one in the same
   * family (for a pinned entry; `latest:` entries follow by themselves), else offer a label.
   */
  noteChipModel(sessionId: string, modelId: string | undefined): void {
    if (!modelId || !this.state.prefs || this.state.hint) return;
    const m = this.models;
    const found = activeBundle(m, this.scopeOf(sessionId));
    if (!found && m.bundles.length === 0) {
      this.showHint('models.bundles');
      return;
    }
    if (found) {
      for (const e of found.bundle.entries) {
        if (e.model.startsWith('latest:')) continue;
        const nw = newerThan(this.state.catalog, e.model, e.tool);
        if (!nw || m.offered.includes(nw.id)) continue;
        const vars = {
          model: modelName(this.state.catalog, e.model, e.tool),
          newer: nw.name,
          newerId: nw.id,
          bundle: found.bundle.id,
          entry: e.id,
        };
        if (this.showHint('models.newer', vars, false)) {
          void this.saveModels({ ...m, offered: [...m.offered, nw.id] });
        }
        return;
      }
    }
    if (m.seen.includes(modelId)) return;
    const name = modelName(this.state.catalog, modelId);
    // The first model ever seen just joins the list; each one after it gets the label offer.
    const first = m.seen.length === 0;
    const shown =
      !first && !m.labels[modelId] && this.showHint('models.label', { model: name }, false);
    if (first || shown || m.labels[modelId])
      void this.saveModels({ ...m, seen: [...m.seen, modelId] });
  }

  // ---- restart and resume --------------------------------------------------------------------

  /** DMs that run here now: what a restart reopens. */
  private liveIds(): string[] {
    return this.state.sessions.filter((s) => s.status !== 'exited' && !s.mirror).map((s) => s.id);
  }

  /** The app menu's Restart Patchroom: relaunch now if all is idle, else ask. */
  requestRestart(): void {
    const ids = this.liveIds();
    const busy = this.busyIds(ids);
    if (busy.length === 0) {
      void this.restartNow(ids);
      return;
    }
    this.set({ restart: { ids, interrupt: [], waiting: false } });
  }

  busyIds(ids: string[] = this.state.restart?.ids ?? []): string[] {
    return ids.filter((id) => {
      const s = this.state.sessions.find((x) => x.id === id);
      return s && (s.status === 'busy' || s.status === 'waiting');
    });
  }

  setRestartInterrupt(id: string, on: boolean): void {
    const r = this.state.restart;
    if (!r) return;
    const interrupt = on ? [...new Set([...r.interrupt, id])] : r.interrupt.filter((x) => x !== id);
    this.set({ restart: { ...r, interrupt } });
  }

  /** Interrupt the chosen DMs, then relaunch once every DM is idle. */
  confirmRestart(): void {
    const r = this.state.restart;
    if (!r) return;
    for (const id of r.interrupt) this.stopTurn(id);
    this.set({ restart: { ...r, waiting: true } });
    this.checkRestart();
  }

  cancelRestart(): void {
    if (this.state.restart) this.set({ restart: null });
  }

  private checkRestart(): void {
    const r = this.state.restart;
    if (!r?.waiting) return;
    if (this.busyIds(r.ids).length === 0) void this.restartNow(r.ids);
  }

  private restarting = false;

  /** Save drafts and the open DM, then relaunch and reopen `ids`. */
  async restartNow(ids: string[]): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    for (const id of [...this.dirtyDrafts]) {
      window.clearTimeout(this.draftTimers.get(id));
      this.dirtyDrafts.delete(id);
      const chat = this.chats.get(id);
      if (chat) await this.ipc.draftSet(id, chat.draft).catch(() => undefined);
    }
    try {
      window.localStorage.setItem(RESTART_ACTIVE_KEY, this.state.activeId ?? '');
    } catch {
      // The open DM is a convenience.
    }
    try {
      await this.ipc.appRestart(ids);
    } catch (err) {
      this.restarting = false;
      this.set({ restart: null, error: `Could not restart: ${String(err)}` });
    }
  }

  /** After a restart: resume every DM it reopens with `--resume`, and show the one that was open. */
  private async reopenAfterRestart(): Promise<void> {
    const ids = await this.ipc.appRestartPending().catch(() => [] as string[]);
    if (ids.length === 0) return;
    let active = '';
    try {
      active = window.localStorage.getItem(RESTART_ACTIVE_KEY) ?? '';
      window.localStorage.removeItem(RESTART_ACTIVE_KEY);
    } catch {
      // Keep the default.
    }
    let n = 0;
    for (const id of ids) {
      const s = this.state.sessions.find((x) => x.id === id);
      if (!s || s.status !== 'exited') continue;
      await this.resume(s);
      n += 1;
    }
    const keep = this.state.sessions.some((s) => s.id === active) ? active : null;
    if (keep) this.select(keep);
    this.showHint('restart', { count: n === 1 ? '1 session' : `${n} sessions` });
  }

  // ---- steering: the side-pane selection, screenshots ----------------------------------

  /**
   * Edit > Comment on Selection (Cmd+Shift+M). A selection in Patchroom's own page comments
   * at once; otherwise the side-pane page is asked for its selection.
   */
  commentOnSelection(): void {
    const id = this.state.activeId;
    if (!id) {
      this.set({ error: 'Open a session first: comments go into its message box.' });
      return;
    }
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : '';
    if (text.trim()) {
      this.chat(id).addComment(null, cleanQuote(text));
      sel?.removeAllRanges();
      return;
    }
    if (!this.state.viewer) return;
    void this.ipc.viewerSelection().catch((err: unknown) => {
      this.set({ error: `Could not read the selection: ${String(err)}` });
    });
  }

  /** The side-pane page handed back its selection: a draft comment line, never a send. */
  addViewerComment(text: string, url: string): void {
    const id = this.state.activeId;
    const quote = cleanQuote(text);
    if (!id || !quote) return;
    this.chat(id).addLinkedComment(quote, textFragmentLink(url, quote));
  }

  /** A comment line's jump back: show the page in the pane, scrolled to the quote. */
  revealComment(link: string, quote: string): void {
    const v = this.state.viewer;
    const page = link.split('#')[0];
    if (v && v.url.split('#')[0] === page) {
      void this.ipc.viewerFind(quote.split('\n')[0].replace(/…$/, '')).catch(() => undefined);
      return;
    }
    this.openLink(link, { target: 'patchroom' });
  }

  /** Cmd+Shift+2 or the toolbar button: freeze the window and let the person drag a box. */
  private shotStarting = false;

  async startShot(): Promise<void> {
    // The menu accelerator and the page's own key handler can both fire: start once.
    if (this.state.shot || this.shotStarting) return;
    if (!this.state.activeId) {
      this.set({ error: 'Open a session first: the screenshot goes into its message box.' });
      return;
    }
    this.shotStarting = true;
    try {
      const shot = await this.ipc.shotBegin();
      this.set({ shot });
    } catch (err) {
      this.set({ error: `Could not take the screenshot: ${String(err)}` });
    } finally {
      this.shotStarting = false;
    }
  }

  cancelShot(): void {
    if (!this.state.shot) return;
    this.set({ shot: null });
    void this.ipc.shotCancel().catch(() => undefined);
  }

  /** Check: save the crop and add it with its note as one composer line. Nothing sends. */
  async commitShot(
    rect: { x: number; y: number; width: number; height: number },
    note: string,
  ): Promise<void> {
    const id = this.state.activeId;
    this.set({ shot: null });
    if (!id) return;
    const t0 = performance.now();
    try {
      const { path, dataUrl } = await this.ipc.shotCommit(id, rect);
      this.chat(id).addShot({ path, src: dataUrl }, note.trim());
      (window as unknown as { __PR_SHOT_MS__?: number }).__PR_SHOT_MS__ = performance.now() - t0;
    } catch (err) {
      this.set({ error: `Could not save the screenshot: ${String(err)}` });
    }
  }

  // ---- claude.ai in the side pane --------------------------------------------------------

  /** Where to go back to after signing in from an artifact's sign-in screen. */
  private returnAfterSignIn: string | null = null;

  private noteAccount(signedIn: boolean, url: string): void {
    setClaudeAccount(signedIn);
    const v = this.state.viewer;
    if (v && v.url.split('#')[0] === url.split('#')[0]) {
      this.set({ viewer: { ...v, signIn: !signedIn } });
    }
    if (signedIn && this.returnAfterSignIn) {
      const back = this.returnAfterSignIn;
      this.returnAfterSignIn = null;
      this.openLink(back, { target: 'patchroom' });
    }
  }

  /** Sign in to claude.ai in the side pane. From an artifact, come back to it afterwards. */
  signInClaude(): void {
    const v = this.state.viewer;
    if (v && !/^https:\/\/claude\.ai\/login/.test(v.url)) this.returnAfterSignIn = v.url;
    this.closePanel();
    this.openLink('https://claude.ai/login', { target: 'patchroom' });
  }

  async signOutClaude(): Promise<string> {
    const how = await this.ipc.viewerSignOut();
    setClaudeAccount(false);
    return how === 'cleared'
      ? 'Signed out. The side pane forgot every sign-in it held, claude.ai included.'
      : 'Signed out of claude.ai.';
  }

  closeViewer(): void {
    if (!this.state.viewer) return;
    this.set({ viewer: null });
    void this.ipc.viewerHide().catch(() => undefined);
  }

  setPanel(panel: Panel, searchScope?: 'dm' | 'all'): void {
    this.set({ panel, prefsTarget: null, searchSeed: '', ...(searchScope ? { searchScope } : {}) });
  }

  /** Open search across every DM with `text` already typed. */
  searchFor(text: string): void {
    this.set({ panel: 'search', prefsTarget: null, searchScope: 'all', searchSeed: text });
  }

  closePanel(): void {
    if (this.state.panel) this.set({ panel: null, prefsTarget: null });
  }

  /** Open Preferences, optionally on the Terminal tab at one DM's row. */
  openPrefs(target: PrefsTarget | null = null): void {
    this.set({ panel: 'prefs', prefsTarget: target });
  }

  /**
   * Open a DM in the view it was left in. A target (an item or a pending prompt) opens the chat,
   * scrolled to it.
   */
  openDm(id: string, target: { itemKey?: string; promptId?: string } = {}): void {
    this.set({ panel: null });
    this.select(id);
    if (target.itemKey || target.promptId) this.setView(id, 'chat');
    const chat = this.chat(id);
    if (target.itemKey) void chat.openAt(target.itemKey);
    else if (target.promptId) chat.focusKey(`prompt:${target.promptId}`);
  }

  /** Cmd+Shift+A: the DM that has waited longest on the user. */
  async jumpOldestNeeds(): Promise<void> {
    await this.loadActivity();
    const row = this.state.activity.find((r) => r.kind === 'prompt');
    if (row) {
      this.openDm(row.id, { itemKey: row.itemKey, promptId: row.promptId });
      return;
    }
    const waiting = this.state.sessions.find(
      (s) =>
        !s.archived && (s.status === 'waiting' || (this.state.badges[s.id]?.needsYou ?? 0) > 0),
    );
    if (waiting) this.openDm(waiting.id);
  }

  /** Option+Shift+Down / Up: the next or previous DM with unread or needs-you, wrapping. */
  jumpUnread(dir: 1 | -1): void {
    const order = visibleOrder(this.state.sections, this.state.sessions);
    if (order.length === 0) return;
    const hot = (id: string) =>
      (this.state.badges[id]?.unread ?? 0) > 0 || (this.state.badges[id]?.needsYou ?? 0) > 0;
    const n = order.length;
    const at = order.findIndex((s) => s.id === this.state.activeId);
    for (let step = 1; step <= n; step++) {
      const i = at < 0 ? (dir === 1 ? step - 1 : n - step) : (((at + dir * step) % n) + n) % n;
      const s = order[i];
      if (s.id !== this.state.activeId && hot(s.id)) {
        this.openDm(s.id);
        return;
      }
    }
  }

  // ---- P3: activity --------------------------------------------------------------------

  private activityTimer = 0;
  private scheduleActivity(): void {
    if (this.activityTimer) return;
    this.activityTimer = window.setTimeout(() => {
      this.activityTimer = 0;
      void this.loadActivity();
    }, 30);
  }

  async loadActivity(): Promise<void> {
    try {
      const rows = await this.ipc.activityList();
      this.set({ activity: [...rows].sort((a, b) => toMillis(a.ts) - toMillis(b.ts)) });
    } catch {
      // Keep the last list.
    }
  }

  // ---- P3: drafts ----------------------------------------------------------------------

  private readonly draftTimers = new Map<string, number>();
  private readonly dirtyDrafts = new Set<string>();

  private draftChanged(id: string, text: string): void {
    const has = text !== '';
    const cur = this.state.sessions.find((s) => s.id === id);
    if (cur && Boolean(cur.hasDraft) !== has) this.patchSession(id, { hasDraft: has });
    this.dirtyDrafts.add(id);
    window.clearTimeout(this.draftTimers.get(id));
    if (!has) this.flushDraft(id);
    else
      this.draftTimers.set(
        id,
        window.setTimeout(() => this.flushDraft(id), DRAFT_DEBOUNCE_MS),
      );
  }

  /** Write a pending draft now. Called on a DM switch, hide and close. */
  flushDraft(id: string): void {
    window.clearTimeout(this.draftTimers.get(id));
    this.draftTimers.delete(id);
    if (!this.dirtyDrafts.delete(id)) return;
    const chat = this.chats.get(id);
    if (!chat) return;
    void this.ipc.draftSet(id, chat.draft).catch(() => undefined);
  }

  private readonly flushAllDrafts = (): void => {
    for (const id of [...this.dirtyDrafts]) this.flushDraft(id);
  };
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.flushAllDrafts();
  };

  // ---- P3: pins, saved items, reactions ------------------------------------------------

  hasMark(id: string, itemKey: string, kind: MarkKind, emoji?: string): boolean {
    return this.state.marks.some(
      (m) =>
        m.conversationId === id &&
        m.itemKey === itemKey &&
        m.kind === kind &&
        (m.emoji ?? null) === (emoji ?? null),
    );
  }

  /** Add the mark, or remove it when it exists. A reaction is a label only: nothing reaches the PTY. */
  /** Artifacts in new items are pinned once (Links preference `artifacts.autoPin`). */
  private noteArtifacts(id: string, items: ChatItem[]): void {
    const autoPin = this.state.prefs?.artifacts?.autoPin ?? true;
    for (const key of noteArtifacts(id, items, autoPin)) {
      if (!this.hasMark(id, key, 'pin')) void this.toggleMark(id, key, 'pin');
    }
  }

  async toggleMark(id: string, itemKey: string, kind: MarkKind, emoji?: string): Promise<void> {
    const prev = this.state.marks;
    try {
      if (this.hasMark(id, itemKey, kind, emoji)) {
        this.set({
          marks: prev.filter(
            (m) =>
              !(
                m.conversationId === id &&
                m.itemKey === itemKey &&
                m.kind === kind &&
                (m.emoji ?? null) === (emoji ?? null)
              ),
          ),
        });
        await this.ipc.markRemove(id, itemKey, kind, emoji);
      } else {
        const m = await this.ipc.markAdd(id, itemKey, kind, emoji);
        if (!this.hasMark(id, itemKey, kind, emoji)) this.set({ marks: [...this.state.marks, m] });
      }
    } catch (err) {
      this.set({ marks: prev, error: `Could not update the ${kind}: ${String(err)}` });
    }
  }

  // ---- P3: search, prefs, sounds -------------------------------------------------------

  search(query: string, scopeId?: string) {
    return this.ipc.search({ query, scope: scopeId ? { id: scopeId } : undefined, limit: 50 });
  }

  async setPrefs(patch: Partial<Prefs>): Promise<void> {
    try {
      const prefs = await this.ipc.prefsSet(patch);
      this.set({ prefs });
    } catch (err) {
      this.set({ error: `Could not save the preferences: ${String(err)}` });
    }
  }

  private readonly notifyListeners = new Set<(e: NotifyFireEvent) => void>();
  /** `notify:fire` is the backend's decision to alert; the UI only plays the sound. */
  onNotify(fn: (e: NotifyFireEvent) => void): () => void {
    this.notifyListeners.add(fn);
    return () => this.notifyListeners.delete(fn);
  }

  async deleteSession(id: string): Promise<void> {
    try {
      await this.ipc.sessionDelete(id);
      const sessions = this.state.sessions.filter((s) => s.id !== id);
      this.unbindTerms.get(id)?.();
      this.unbindTerms.delete(id);
      this.terminals.get(id)?.dispose();
      this.terminals.delete(id);
      this.chats.delete(id);
      this.set({ marks: this.state.marks.filter((m) => m.conversationId !== id) });
      const activeId = this.state.activeId === id ? firstActive(sessions) : this.state.activeId;
      this.set({ sessions, activeId });
    } catch (err) {
      this.set({ error: `Could not delete the session: ${String(err)}` });
    }
  }

  async kill(id: string): Promise<void> {
    try {
      await this.ipc.sessionKill(id);
    } catch (err) {
      this.set({ error: `Could not end the session: ${String(err)}` });
    }
  }

  pickFolder(defaultPath?: string): Promise<string | null> {
    return this.ipc.pickFolder(defaultPath);
  }

  dismissError(): void {
    this.set({ error: null });
  }
}

function sortSections(sections: SectionInfo[]): SectionInfo[] {
  return [...sections].sort((a, b) => a.position - b.position);
}

/** Persisted counts from `session_list` fill in DMs that have had no `session:badges` event yet. */
function seedBadges(sessions: SessionInfo[], have: Record<string, Badges>): Record<string, Badges> {
  const out = { ...have };
  for (const s of sessions) {
    if (out[s.id]) continue;
    if (s.unread !== undefined || s.needsYou !== undefined) {
      out[s.id] = { unread: s.unread ?? 0, needsYou: asCount(s.needsYou) };
    }
  }
  return out;
}

/** `needsYou` is a boolean on the wire; the sidebar shows a count. */
function asCount(v: number | boolean | undefined): number {
  return typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? 0);
}

function firstActive(sessions: SessionInfo[]): string | null {
  return (sessions.find((s) => s.status !== 'exited') ?? sessions[0])?.id ?? null;
}

/** Backend rows win; sessions only the UI knows about (just created) are kept. */
function mergeSessions(fresh: SessionInfo[], local: SessionInfo[]): SessionInfo[] {
  const ids = new Set(fresh.map((s) => s.id));
  return [...fresh, ...local.filter((s) => !ids.has(s.id))];
}

export function useAppState(store: AppStore): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
