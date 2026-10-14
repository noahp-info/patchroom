import { useSyncExternalStore } from 'react';
import type { Ipc, SectionInfo, SessionInfo, SessionStatus } from '../ipc';
import { utf8ToBase64 } from '../lib/base64';
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
}

const LAST_CWD_KEY = 'patchroom.lastCwd';

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
  };
  private readonly listeners = new Set<() => void>();
  private readonly terminals = new Map<string, SessionTerminal>();
  private readonly chats = new Map<string, ChatModel>();
  private unlisten: (() => void)[] = [];

  constructor(
    private readonly ipc: Ipc,
    private readonly termOpts: SessionTerminalOptions = {},
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private patchSession(id: string, patch: Partial<SessionInfo>): void {
    this.set({
      sessions: this.state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }

  terminal(id: string): SessionTerminal {
    let t = this.terminals.get(id);
    if (!t) {
      t = new SessionTerminal(id, this.ipc, this.termOpts);
      this.terminals.set(id, t);
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
    if (this.viewOf(id) === view) return;
    this.set({ views: { ...this.state.views, [id]: view } });
    this.hintView(id, view);
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

  /** Send composer text to claude exactly as typed. */
  async sendText(id: string, text: string): Promise<void> {
    try {
      await this.ipc.sessionSendText(id, text);
    } catch (err) {
      this.set({ error: `Could not send the message: ${String(err)}` });
    }
  }

  /** Ctrl+V to the PTY: claude reads a clipboard image itself. */
  pasteClipboardImage(id: string): void {
    void this.ipc.sessionWrite(id, utf8ToBase64('\x16')).catch(() => undefined);
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
      this.ipc.on('pty:output', (e) => this.terminal(e.id).writeBase64(e.data)),
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
      this.ipc.on('chat:items', (e) => this.chat(e.id).apply(e.items)),
      this.ipc.on('prompt:pending', (e) => this.chat(e.id).addPrompt(e)),
      this.ipc.on('prompt:resolved', (e) => this.chat(e.id).resolvePrompt(e.promptId, e.by)),
      this.ipc.on('session:badges', (e) =>
        this.setBadges(e.id, { unread: e.unread, needsYou: asCount(e.needsYou) }),
      ),
      this.ipc.on('statusline:update', (e) => this.chat(e.id).setStatusline(e)),
    ]);
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
    } catch (err) {
      this.set({ ready: true, error: `Could not load DMs: ${String(err)}` });
    }
  }

  stop(): void {
    for (const off of this.unlisten) off();
    this.unlisten = [];
    for (const t of this.terminals.values()) t.dispose();
    this.terminals.clear();
    this.chats.clear();
    this.started = false;
  }

  select(id: string): void {
    const prev = this.state.activeId;
    if (prev === id) return;
    this.set({ activeId: id });
    // The terminal view only counts as shown for the DM that is open.
    if (prev && this.viewOf(prev) === 'terminal') this.hintView(prev, 'chat');
    if (this.viewOf(id) === 'terminal') this.hintView(id, 'terminal');
  }

  async create(cwd: string, name?: string): Promise<void> {
    try {
      const { id } = await this.ipc.sessionCreate({ cwd, name: name || folderName(cwd) });
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
              sectionId: null,
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
    const [fresh, sections] = await Promise.all([this.ipc.sessionList(), this.ipc.sectionList()]);
    this.set({
      badges: seedBadges(fresh, this.state.badges),
      sessions: mergeSessions(fresh, this.state.sessions),
      sections: sortSections(sections),
    });
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
    this.patchSession(id, { sectionId });
    try {
      await this.ipc.sessionSetSection(id, sectionId);
    } catch (err) {
      this.set({ sessions: prev, error: `Could not move the DM: ${String(err)}` });
    }
  }

  async deleteSession(id: string): Promise<void> {
    try {
      await this.ipc.sessionDelete(id);
      const sessions = this.state.sessions.filter((s) => s.id !== id);
      this.terminals.get(id)?.dispose();
      this.terminals.delete(id);
      this.chats.delete(id);
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
