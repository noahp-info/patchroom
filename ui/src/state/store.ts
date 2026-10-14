import { useSyncExternalStore } from 'react';
import type {
  ActivityRow,
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
import { bindTerminalStyle } from '../lib/prefsModule';
import { toMillis } from '../lib/time';
import { bytesToBase64, utf8ToBase64 } from '../lib/base64';
import { shellQuotePath } from '../lib/keys';
import { SessionTerminal, type SessionTerminalOptions } from '../lib/sessionTerminal';
import { ChatModel } from './chat';

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
  tab: 'terminal';
  dmId?: string;
}

export type Panel = null | 'activity' | 'saved' | 'search' | 'switcher' | 'prefs';

/** Where a dragged DM lands. */
export type DropDest =
  | { kind: 'starred' }
  | { kind: 'archived' }
  | { kind: 'default' }
  | { kind: 'section'; sectionId: string };

/** What `folder_sessions` last returned for one folder section. */
export interface FolderListing {
  sessions: FolderSession[];
  hiddenCount: number;
  /** True until the first answer arrives. */
  loading: boolean;
  /** Set when the last read failed; the previous rows stay. */
  error: string | null;
}

export interface AppState {
  ready: boolean;
  sessions: SessionInfo[];
  /** Stored sidebar sections, in position order. DMs with no section sit in the default group. */
  sections: SectionInfo[];
  activeId: string | null;
  lastCwd: string;
  error: string | null;
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
}

/** What `sendText` resolved to. `error` means the call itself failed. */
export type SendResultKind = SendOutcome | 'error';

/** A DM's claude waits on a dialog only the terminal can show. */
export function inTerminalDialog(s: Pick<SessionInfo, 'terminalWait'> | undefined): boolean {
  return !!s?.terminalWait;
}

/** How long a sent message gets to show up as a user item before the chat says why not. */
export const ECHO_WAIT_MS = 3000;

const LAST_CWD_KEY = 'patchroom.lastCwd';
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
    views: {},
    badges: {},
    thread: null,
    marks: [],
    activity: [],
    prefs: null,
    panel: null,
    prefsTarget: null,
    searchScope: 'all',
    recent: readRecent(),
    folders: {},
    termBg: {},
    termNotes: {},
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
    this.set({ views: { ...this.state.views, [id]: view } });
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
    this.setView(id, this.viewOf(id) === 'chat' ? 'terminal' : 'chat');
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
        text: 'Claude is showing something in the terminal. Your message was not sent.',
      });
    } else if (outcome === 'mirror_readonly') {
      chat.setNotice({
        kind: 'mirror',
        text: 'This session is open in another terminal. Your message was not sent.',
      });
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
      this.chat(id).insertIntoDraft(shellQuotePath(path) + ' ');
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

  /** Resume a mirrored DM now. Resolves to the backend's refusal text, or null on success. */
  async takeoverNow(id: string): Promise<string | null> {
    try {
      const { cols, rows } = this.terminal(id).term;
      const info = await this.ipc.sessionTakeover(id, cols, rows);
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
      }),
      this.ipc.on('session:title', (e) => this.patchSession(e.id, { title: e.title })),
      this.ipc.on('session:status', (e) => {
        this.patchSession(e.id, {
          status: e.status,
          needs: e.status === 'waiting' ? e.needs : undefined,
        });
      }),
      this.ipc.on('session:terminal_wait', (e) =>
        this.patchSession(e.id, { terminalWait: { reason: e.reason, since: e.since } }),
      ),
      this.ipc.on('session:terminal_wait_clear', (e) => {
        this.patchSession(e.id, { terminalWait: null });
        // The dialog is gone: its "not sent" notice no longer applies.
        this.chat(e.id).clearNotice('blocked');
      }),
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
      this.set({ ready: true, error: `Could not load DMs: ${String(err)}` });
    }
  }

  /** Marks, prefs and the activity list. Each is optional: an older backend may lack them. */
  private async loadP3(): Promise<void> {
    const [marks, prefs] = await Promise.all([
      this.ipc.markList().catch(() => null),
      this.ipc.prefsGet().catch(() => null),
    ]);
    this.set({ ...(marks ? { marks } : {}), ...(prefs ? { prefs } : {}) });
    await this.loadActivity();
  }

  stop(): void {
    for (const t of this.folderTimers.values()) window.clearTimeout(t);
    this.folderTimers.clear();
    this.flushAllDrafts();
    window.removeEventListener('pagehide', this.flushAllDrafts);
    document.removeEventListener('visibilitychange', this.onVisibility);
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

  async create(cwd: string, name?: string, sectionId?: string | null): Promise<void> {
    try {
      const { id } = await this.ipc.sessionCreate({ cwd, name: name || folderName(cwd) });
      if (sectionId) await this.ipc.sessionSetSection(id, sectionId);
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
      this.set({ error: `Could not start the DM: ${String(err)}` });
    }
  }

  /**
   * Restart an exited DM through the backend's `session_resume`. The DM keeps its id, so the
   * sidebar row, terminal and stored history stay the same. Never creates a second DM.
   */
  async resume(session: SessionInfo): Promise<void> {
    try {
      const { cols, rows } = this.terminal(session.id).term;
      await this.ipc.sessionResume(session.id, cols, rows);
      this.patchSession(session.id, { status: 'busy', needs: undefined, exitCode: undefined });
      this.set({ activeId: session.id, error: null });
      await this.refresh();
    } catch (err) {
      this.set({ error: `Could not resume: ${String(err)}` });
    }
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

  async createSection(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await this.ipc.sectionCreate(trimmed);
      await this.refresh();
    } catch (err) {
      this.set({ error: `Could not add the section: ${String(err)}` });
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
      this.set({ sessions: prev, error: `Could not move the DM: ${String(err)}` });
    }
  }

  // ---- P3: sections --------------------------------------------------------------------

  async renameSection(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    const prev = this.state.sections;
    if (!trimmed || prev.find((s) => s.id === id)?.name === trimmed) return;
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
      this.set({ sessions: prev, error: `Could not update the DM: ${String(err)}` });
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
      this.set({ sessions: prev, error: `Could not move the DM: ${String(err)}` });
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
  async openFolderSession(sectionId: string, sessionId: string): Promise<void> {
    try {
      const info = await this.ipc.folderSessionOpen(sectionId, sessionId);
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

  setPanel(panel: Panel, searchScope?: 'dm' | 'all'): void {
    this.set({ panel, prefsTarget: null, ...(searchScope ? { searchScope } : {}) });
  }

  closePanel(): void {
    if (this.state.panel) this.set({ panel: null, prefsTarget: null });
  }

  /** Open Preferences, optionally on the Terminal tab at one DM's row. */
  openPrefs(target: PrefsTarget | null = null): void {
    this.set({ panel: 'prefs', prefsTarget: target });
  }

  /** Open a DM, on its chat, optionally scrolled to an item or a pending prompt. */
  openDm(id: string, target: { itemKey?: string; promptId?: string } = {}): void {
    this.set({ panel: null });
    this.select(id);
    this.setView(id, 'chat');
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
      this.set({ error: `Could not delete the DM: ${String(err)}` });
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
