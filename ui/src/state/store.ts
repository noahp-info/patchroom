import { useSyncExternalStore } from 'react';
import type { Ipc, SectionInfo, SessionInfo, SessionStatus } from '../ipc';
import { SessionTerminal, type SessionTerminalOptions } from '../lib/sessionTerminal';

export interface AppState {
  ready: boolean;
  sessions: SessionInfo[];
  /** Stored sidebar sections, in position order. DMs with no section sit in the default group. */
  sections: SectionInfo[];
  activeId: string | null;
  lastCwd: string;
  error: string | null;
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
  };
  private readonly listeners = new Set<() => void>();
  private readonly terminals = new Map<string, SessionTerminal>();
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
    ]);
    try {
      const [sessions, sections] = await Promise.all([
        this.ipc.sessionList(),
        this.ipc.sectionList(),
      ]);
      const activeId = this.state.activeId ?? firstActive(sessions);
      this.set({
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
    this.started = false;
  }

  select(id: string): void {
    this.set({ activeId: id });
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
