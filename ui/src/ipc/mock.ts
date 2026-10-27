import { base64ToBytes, utf8ToBase64 } from '../lib/base64';
import { toMillis } from '../lib/time';
import { FIXTURE_HOME, makeFolderFixture, makeSmallFixture } from './folderFixture';
import { syntheticChat, syntheticThread, bigChat } from './synthetic';
import type {
  ActivityRow,
  ChatItem,
  DetectedHook,
  FolderSession,
  Ipc,
  MarkInfo,
  NotifyFireEvent,
  Prefs,
  SearchHit,
  PromptAnswer,
  PromptPendingEvent,
  ResolvedBy,
  StatusChips,
  IpcEvents,
  MirrorInfo,
  Needs,
  SectionInfo,
  SessionInfo,
  SendOutcome,
  SessionStatus,
  Unlisten,
} from './types';
import { createMockSoundBackend, type MockSoundControl } from './mockSounds';
import { MOCK_IMPORT_FILE, MOCK_IMPORT_SOURCES } from '../theme/themeImport.ts';
import { MOCK_SYSTEM_FONTS } from '../theme/typeface.ts';

/** A 1x1 PNG, for the mock's snapshots and screenshots. */
const MOCK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN49PTJfwAJAwOr4dAuwQAAAABJRU5ErkJggg==';

/** Test and browser-dev handle, exposed as `window.__PR_MOCK__`. */

export interface MockControl {
  /** Every byte the UI wrote to a session, in order, per session id. */
  writes: Record<string, number[]>;
  /** Every resize the UI asked for. */
  resizes: { id: string; cols: number; rows: number }[];
  /** Every `session_send_text` payload. */
  texts: { id: string; text: string }[];
  /** Every `paste_image` call (bytes as base64). */
  pastes: { id: string; data: string; mediaType: string }[];
  /** Every `session_send_text` call with the outcome the mock returned. */
  sends: { id: string; text: string; outcome: string }[];
  /** Every `session_takeover` call. */
  takeovers: string[];
  /** Every `session_mirror_takeover_when_closed` call. */
  takeoverArms: { id: string; enabled: boolean }[];
  /** Every `session_mirror_reveal` call. */
  reveals: string[];
  /** Every `link_open_external` URL. */
  external: string[];
  /**
   * Every viewer call, in order: `show <url>`, `place`, `hide`, `go <action>`, `snapshot`,
   * `reveal`, `selection`, `find <text>`, `signout`.
   */
  viewer: string[];
  /** What the viewer page has selected, handed back on `viewer_selection`. */
  viewerPicked: string;
  /** Edit > Comment on Selection and Edit > Screenshot to Steer, as the app menu sends them. */
  menuComment(): void;
  menuScreenshot(): void;
  /** A claude.ai page in the viewer showed the user signed in or out. */
  viewerAccount(signedIn: boolean, url?: string): void;
  /** Every `shot_commit` rect. */
  shots: { id: string; rect: { x: number; y: number; width: number; height: number } }[];
  /** Every `session_mirror_end` call that signaled the other copy. */
  mirrorEnds: string[];
  /** Processes the mock "spawned": session_create, session_resume, and non-mirror folder opens. */
  spawns: string[];
  /** Put a DM into mirror mode (or out of it with null) and emit `session:mirror`. */
  setMirror(id: string, mirror: MirrorInfo | null): void;
  /** The other terminal's process exits. An armed mirror is taken over at once. */
  closeMirror(id: string): void;
  /** Raise or clear a terminal-only dialog (`session:terminal_wait` and its clear). */
  setTerminalDialog(id: string, on: boolean, reason?: string): void;
  /** Emit PTY bytes for a slash command, as a TUI panel repaint. Default true. */
  repaintOnSlash: boolean;
  /** Feed bytes (base64) to a session's terminal as if the pty produced them. */
  emitOutput(id: string, base64: string): void;
  emitText(id: string, text: string): void;
  setStatus(id: string, status: SessionStatus, needs?: Needs): void;
  setTitle(id: string, title: string): void;
  exit(id: string, code: number): void;
  /** Seed a session without going through the UI. */
  addSession(info: Partial<SessionInfo> & { cwd: string }): SessionInfo;
  sessions(): SessionInfo[];
  /** Every `session_resume` the UI asked for. */
  resumes: { id: string; cols?: number; rows?: number }[];
  /** What the next `pick_folder` resolves to (null means the user cancelled). */
  pickResult: string | null;
  /** Seed a stored section. */
  addSection(info: Partial<SectionInfo> & { name: string }): SectionInfo;
  sections(): SectionInfo[];

  // ---- P2 chat ----------------------------------------------------------------------------
  /** Replace a session's chat without emitting anything. Call `__PR_CHATS__[id].reload()` after. */
  seedChat(id: string, items: ChatItem[]): void;
  /** Append or replace items and emit `chat:items`. Counts new assistant items as unread. */
  pushItems(id: string, items: ChatItem[]): void;
  /** Emit `prompt:pending`; the session's needs-you count goes up. Returns the prompt id. */
  emitPrompt(id: string, prompt: Omit<PromptPendingEvent, 'id'>): string;
  /** Hold a prompt without emitting it: an announcement this view missed (`prompt_list` has it). */
  seedPrompt(id: string, prompt: Omit<PromptPendingEvent, 'id'>): void;
  /** Emit `prompt:resolved`, as the arbiter does when the terminal answers first or a timeout hits. */
  resolvePrompt(id: string, promptId: string, by: ResolvedBy): void;
  /** `needsYou` is a boolean on the wire, as the backend sends it. */
  setBadges(id: string, unread: number, needsYou: boolean): void;
  /** The CLI's working line shows (or, with a null verb, goes away): `session:working`. */
  setWorking(id: string, verb: string | null, detail?: string): void;
  /** A session's CLI opened a URL (`$BROWSER` is patchroom-hook): `link:open`. */
  cliOpenUrl(url: string, id?: string | null): void;
  /** The app menu's Settings item was chosen. */
  menuSettings(): void;
  badges(id: string): { unread: number; needsYou: boolean };
  setStatusline(id: string, text: string, chips?: StatusChips): void;
  /** Every `prompt_answer` the UI sent. */
  answers: { id: string; promptId: string; answer: PromptAnswer }[];
  /** Every `session_mark_read`. */
  marks: string[];
  /** Every `statusline_cycle_mode`. */
  modeCycles: string[];
  /** Every `chat_history` call. */
  historyCalls: { id: string; before?: string; limit?: number }[];
  /** Every `session_view` hint. */
  views: { id: string; view: 'chat' | 'terminal' }[];
  /** Every `chat_thread` call. */
  threadCalls: { id: string; toolUseId: string }[];
  /** Echo `session_send_text` back as a user item, like the transcript tail would. Default on. */
  autoEcho: boolean;
  /**
   * Text sent while busy, held the way Claude Code holds queued input: no transcript entry
   * until `dequeue` (or Ctrl+X Ctrl+S written to the PTY). Esc written while some is held
   * interrupts: the session goes idle and the text returns to the prompt (`returned`).
   */
  queuedInput: Record<string, string[]>;
  /** Claude reads the queued input: one user entry with every held message, in order. */
  dequeue(id: string): void;
  /** Esc during a turn with queued input: idle, nothing written, text back in the prompt. */
  interrupt(id: string): void;
  /** Text that went back to Claude's prompt after an interrupt, per session. */
  returned: Record<string, string[]>;
  /** Children returned by `chat_thread`, per tool use id. */
  threads: Record<string, ChatItem[]>;
  /** Synthetic data helpers. */
  synthetic(): ChatItem[];
  bigChat(n: number): ChatItem[];

  // ---- P3 Slack layer ---------------------------------------------------------------------
  /** Stored drafts by DM id. */
  drafts: Record<string, string>;
  /** Every `draft_set` call, in order. */
  draftSets: { id: string; body: string }[];
  /** Every `search` call. */
  searchCalls: { query: string; scope?: { id?: string }; limit?: number }[];
  /** Every `chat_locate` call. */
  locateCalls: { id: string; itemKey: string }[];
  /** Every `session_set_flags` call. */
  flagCalls: { id: string; starred?: boolean; archived?: boolean }[];
  /** Every `session_reorder` call. */
  reorderCalls: { sectionId: string | null; ids: string[] }[];
  /** Every `session_focus` call, in order. */
  focusCalls: (string | null)[];
  /** Number of `notify_test` calls. */
  notifyTests: number;
  /** Stored pins, saved items and reactions. */
  storedMarks(): MarkInfo[];
  prefs(): Prefs;
  /** What `sound_hooks_detect` returns. */
  soundHooks: DetectedHook[];
  /** The sound-pack backend: next picked file, files on the "disk", Claude profiles, calls. */
  sound: MockSoundControl;
  /** Emit `notify:fire`, as the backend does after its own decision. */
  fireNotify(e: NotifyFireEvent): void;
  /** Emit `activity:changed`. */
  activityChanged(): void;
  /** Emit `notify:open`, as a click on a native notification does. */
  emitNotifyOpen(id: string): void;

  // ---- P3 folder sections -----------------------------------------------------------------
  /** Every `folder_sessions` call, by section id. */
  folderCalls: string[];
  /** Every `folder_session_open`, with the launch folder it would resume from. */
  folderOpens: { sectionId: string; sessionId: string; cwd: string }[];
  /** Every `folder_session_hide`. */
  folderHides: { sectionId: string; sessionId: string; hidden: boolean }[];
  /** Every `section_set_archive_days`. */
  archiveCalls: { id: string; days: number }[];
  /** Every `section_create_from_folder`. */
  folderCreates: { path: string; name?: string }[];
  /** Listing rows of one folder section, as a transcript scan would find them. */
  folderRows(sectionId: string): FolderSession[];
  /** Replace a folder section's listing wholesale and emit `folder:changed`. */
  setFolderRows(sectionId: string, rows: FolderSession[]): void;
  /** Add a session found outside Patchroom (an iTerm start) and emit `folder:changed`. */
  addFolderSession(
    sectionId: string,
    row: Partial<FolderSession> & { name: string },
  ): FolderSession;
  /** Change a listed session (live marker, name, activity) and emit `folder:changed`. */
  patchFolderSession(sectionId: string, sessionId: string, patch: Partial<FolderSession>): void;
  /** Emit `folder:changed`, as the filesystem watch does. */
  folderChanged(sectionId: string): void;
  /** Make the next `folder_sessions` call fail once. */
  failNextFolderRead: boolean;
  /** The next open or resume reports `check_failed` with this reason (once). */
  failNextCheck: string | null;
  /** Every open or resume that passed `openAnyway`. */
  openAnyways: string[];

  // ---- models, catalog, updates, restart, emoji ---------------------------------------------
  /** Every `session_create` call, as sent. */
  creates: import('./types').SessionCreateArgs[];
  /** Every `session_set_model` call. */
  modelSets: { id: string; model: string }[];
  /** A `/model <id>` sent while idle makes the CLI report that model. Default true. */
  modelSwitchWorks: boolean;
  /** What `catalog_get` returns: a catalog fetched earlier. */
  cachedCatalog: import('./types').ModelCatalog | null;
  /** What `catalog_refresh` downloads. */
  remoteCatalog: import('./types').ModelCatalog | null;
  /** Number of `catalog_refresh` and `update_check` calls that reached the network. */
  fetches: { catalog: number; update: number };
  /** What `update_check` finds. */
  updateInfo: import('./types').UpdateInfo;
  /** Every `app_restart` call, with the DM ids to reopen. */
  restarts: string[][];
  /** The app menu's Restart Patchroom item. */
  menuRestart(): void;
  /** Every `session_set_emoji` call. */
  sessionEmojis: { id: string; emoji: string | null; flavor?: string }[];
}

declare global {
  interface Window {
    __PR_MOCK__?: MockControl;
  }
}

type Handler = (payload: never) => void;

/**
 * In-memory backend for Playwright and browser dev. It records writes and lets a test push
 * output, status and title events. It does not run any process.
 */
const PERSIST_KEY = 'patchroom.mock.state';
/** The DMs a mock restart reopens: survives the page reload that stands in for the relaunch. */
const RESTART_KEY = 'patchroom.mock.restart';

const DEFAULT_MIX = Object.fromEntries(
  ['needs', 'done', 'message', 'error', 'bell', 'decision', 'due', 'session'].map((e) => [
    e,
    { pack: 'patchtones' },
  ]),
);

const DEFAULT_PREFS: Prefs = {
  themeId: 'homeroom',
  mode: 'system',
  customThemes: [],
  base: 'homeroom',
  cablePreset: 'theme',
  notify: { default: 'all', perDm: {} },
  sound: { enabled: true, volume: 0.6, perEvent: {}, mix: DEFAULT_MIX, perDm: {}, hookPolicy: {} },
  dnd: { manual: false, schedule: null },
  termPerDm: {},
  searchAllSessions: false,
  statusBar: { default: null, perDm: {} },
  sidebarWidth: 264,
};

/** What the CLI's statusline calls a model id: `claude-opus-5-5` reads "Opus 5.5". */
function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return id;
  const fam = m[1][0].toUpperCase() + m[1].slice(1);
  return `${fam} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** Text a search or a snapshot can see for one chat item. */
function searchText(it: ChatItem): string {
  switch (it.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
      return it.text;
    case 'plan':
      return it.plan;
    case 'question':
      return it.questions.map((q) => q.question).join(' ');
    case 'tool':
      return `${it.name} ${it.result?.text ?? ''}`.trim();
    case 'subagent':
      return it.description;
    case 'fallback':
      return it.summary;
  }
}

/** Highlighted window of `text` around the first term, with the match ranges inside it. */
function snippetOf(text: string, terms: string[]): { snippet: string; ranges: [number, number][] } {
  const flat = text.replace(/\s/g, ' ');
  const low = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0));
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, at + 90);
  const lead = start > 0 ? '\u2026' : '';
  const body = flat.slice(start, end);
  const out = `${lead}${body}${end < flat.length ? '\u2026' : ''}`;
  const lowBody = body.toLowerCase();
  const ranges: [number, number][] = [];
  for (const t of terms) {
    for (let i = lowBody.indexOf(t); i >= 0; i = lowBody.indexOf(t, i + t.length)) {
      ranges.push([lead.length + i, lead.length + i + t.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return { snippet: out, ranges };
}

export function createMockIpc(opts: { banner?: boolean; persist?: boolean } = {}): {
  ipc: Ipc;
  control: MockControl;
} {
  const sessions = new Map<string, SessionInfo>();
  const sections = new Map<string, SectionInfo>();
  const handlers = new Map<string, Set<Handler>>();
  const chats = new Map<string, ChatItem[]>();
  const badges = new Map<string, { unread: number; needsYou: boolean }>();
  const pending = new Map<string, Set<string>>();
  /** Announced payloads by promptId, for `prompt_list`. */
  const promptPayloads = new Map<string, PromptPendingEvent>();
  const promptAt = new Map<string, number>();
  const drafts = new Map<string, string>();
  /** Folder section id to its listing rows, and the user's hide/unhide overrides by row. */
  const folderRows = new Map<string, FolderSession[]>();
  const hideOverride = new Map<string, boolean>();
  /** Mirrored DMs whose other process has exited. */
  const closedMirrors = new Set<string>();
  let marks: MarkInfo[] = [];
  let prefs: Prefs = structuredClone(DEFAULT_PREFS);
  const soundBackend = createMockSoundBackend();
  let counter = 0;

  // ---- persistence: `?persist` keeps the backend across page reloads, like a restart ----
  const save = () => {
    if (!opts.persist) return;
    try {
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          counter,
          sessions: [...sessions.values()],
          sections: [...sections.values()],
          chats: [...chats.entries()],
          badges: [...badges.entries()],
          drafts: [...drafts.entries()],
          marks,
          prefs,
          folderRows: [...folderRows.entries()],
          hideOverride: [...hideOverride.entries()],
        }),
      );
    } catch {
      // Storage can be blocked; the mock then forgets on reload.
    }
  };
  if (opts.persist) {
    try {
      const raw = window.localStorage.getItem(PERSIST_KEY);
      if (raw) {
        const d = JSON.parse(raw) as {
          counter: number;
          sessions: SessionInfo[];
          sections: SectionInfo[];
          chats: [string, ChatItem[]][];
          badges: [string, { unread: number; needsYou: boolean }][];
          drafts: [string, string][];
          marks: MarkInfo[];
          prefs: Prefs;
          folderRows?: [string, FolderSession[]][];
          hideOverride?: [string, boolean][];
        };
        counter = d.counter;
        // A restarted backend lists its DMs as ended until they are resumed.
        for (const x of d.sessions)
          sessions.set(x.id, { ...x, status: 'exited', needs: undefined });
        for (const x of d.sections) sections.set(x.id, x);
        for (const [k, v] of d.chats) chats.set(k, v);
        for (const [k, v] of d.badges) badges.set(k, { unread: v.unread, needsYou: false });
        for (const [k, v] of d.drafts) drafts.set(k, v);
        marks = d.marks;
        // Prefs saved before `base` and `cablePreset` existed load with the defaults.
        prefs = { ...structuredClone(DEFAULT_PREFS), ...d.prefs };
        for (const [k, v] of d.folderRows ?? []) folderRows.set(k, v);
        for (const [k, v] of d.hideOverride ?? []) hideOverride.set(k, v);
      }
    } catch {
      // A corrupt snapshot starts empty.
    }
  }

  const activity = (): ActivityRow[] => {
    const rows: ActivityRow[] = [];
    for (const [sid, set] of pending) {
      for (const pid of set) {
        const p = promptPayloads.get(pid);
        if (!p) continue;
        const item = p.toolUseId
          ? chats.get(sid)?.find((i) => 'toolUseId' in i && i.toolUseId === p.toolUseId)
          : undefined;
        rows.push({
          id: sid,
          kind: 'prompt',
          ts: promptAt.get(pid) ?? Date.now(),
          promptId: pid,
          itemKey: item?.key,
          summary: `${p.toolName} wants permission`,
        });
      }
    }
    for (const [sid, b] of badges) {
      const s = sessions.get(sid);
      if (!s || s.archived || b.unread <= 0) continue;
      const mine = (chats.get(sid) ?? []).filter(
        (i) => i.kind === 'assistant' && !i.parentToolUseId,
      );
      const first = mine[Math.max(0, mine.length - b.unread)];
      rows.push({
        id: sid,
        kind: 'unread',
        ts: first ? toMillis(first.ts) : Date.now(),
        itemKey: first?.key,
        summary: first ? searchText(first).slice(0, 120) : `${b.unread} new`,
      });
    }
    return rows.sort((a, b) => toMillis(a.ts) - toMillis(b.ts));
  };

  const inFolder = (cwd: string, folder: string) => cwd === folder || cwd.startsWith(`${folder}/`);
  /** The chip a DM wears when its cwd is outside its section's folder. */
  const chipOf = (s: SessionInfo): string | null => {
    const folder = s.sectionId ? sections.get(s.sectionId)?.folder : null;
    if (!folder || inFolder(s.cwd, folder)) return null;
    return s.cwd.split('/').filter(Boolean).pop() ?? null;
  };
  const rowKey = (sectionId: string, sessionId: string) => `${sectionId}:${sessionId}`;
  /** A row as `folder_sessions` returns it: hide overrides applied, DM link dropped if gone. */
  const viewRow = (sectionId: string, r: FolderSession): FolderSession => ({
    ...r,
    liveState: r.liveState ?? (r.liveElsewhere ? 'live' : 'free'),
    hidden: hideOverride.get(rowKey(sectionId, r.sessionId)) ?? r.hidden,
    dmId: r.dmId && sessions.has(r.dmId) ? r.dmId : null,
  });

  const emit = <K extends keyof IpcEvents>(event: K, payload: IpcEvents[K]) => {
    for (const h of handlers.get(event) ?? []) h(payload as never);
  };

  const control: MockControl = {
    writes: {},
    resizes: [],
    texts: [],
    sends: [],
    takeovers: [],
    takeoverArms: [],
    reveals: [],
    external: [],
    viewer: [],
    viewerPicked: '',
    shots: [],
    menuComment() {
      emit('menu:comment', {});
    },
    menuScreenshot() {
      emit('menu:screenshot', {});
    },
    viewerAccount(signedIn, url = 'https://claude.ai/new') {
      emit('viewer:account', { service: 'claude.ai', signedIn, url });
    },
    mirrorEnds: [],
    spawns: [],
    repaintOnSlash: true,
    setMirror(id, m) {
      const s = sessions.get(id);
      if (!s) return;
      s.mirror = m;
      emit('session:mirror', { id, mirror: m });
      save();
    },
    cliOpenUrl(url, id = null) {
      emit('link:open', { id, url });
    },
    menuSettings() {
      emit('menu:settings', {});
    },
    setWorking(id, verb, detail = '') {
      const s = sessions.get(id);
      if (s) s.working = verb ? { verb, detail } : null;
      emit('session:working', { id, verb, detail: verb ? detail : null });
    },
    closeMirror(id) {
      const s = sessions.get(id);
      if (!s?.mirror) return;
      // The other process is gone. Armed: the backend resumes the session by itself.
      closedMirrors.add(id);
      if (s.mirror.takeoverWhenClosed) {
        closedMirrors.delete(id);
        control.spawns.push(id);
        control.setMirror(id, null);
        control.setStatus(id, 'idle');
      }
    },
    setTerminalDialog(id, on, reason = 'dialog open') {
      const s = sessions.get(id);
      if (!s) return;
      if (on) {
        s.terminalWait = { reason, since: Date.now() };
        emit('session:terminal_wait', { id, ...s.terminalWait });
        control.setBadges(id, badges.get(id)?.unread ?? 0, true);
      } else {
        s.terminalWait = null;
        emit('session:terminal_wait_clear', { id });
        control.setBadges(id, badges.get(id)?.unread ?? 0, false);
      }
    },
    pastes: [],
    resumes: [],
    pickResult: null,
    answers: [],
    marks: [],
    modeCycles: [],
    historyCalls: [],
    threadCalls: [],
    views: [],
    autoEcho: true,
    queuedInput: {},
    returned: {},
    dequeue(id) {
      const held = control.queuedInput[id] ?? [];
      if (!held.length) return;
      control.queuedInput[id] = [];
      const n = control.texts.length;
      control.pushItems(id, [
        {
          key: `dq-${id}-${n}-${Date.now()}`,
          ts: Date.now(),
          kind: 'user',
          text: held.join('\n'),
          images: [],
        },
      ]);
    },
    interrupt(id) {
      const held = control.queuedInput[id] ?? [];
      control.queuedInput[id] = [];
      control.returned[id] = [...(control.returned[id] ?? []), ...held];
      control.setStatus(id, 'idle');
    },
    threads: { 'tu-sub': syntheticThread() },
    synthetic: syntheticChat,
    bigChat,
    drafts: new Proxy({} as Record<string, string>, {
      get: (_t, k) => drafts.get(String(k)),
      ownKeys: () => [...drafts.keys()],
      getOwnPropertyDescriptor: (_t, k) =>
        drafts.has(String(k))
          ? { enumerable: true, configurable: true, value: drafts.get(String(k)) }
          : undefined,
    }),
    draftSets: [],
    searchCalls: [],
    locateCalls: [],
    flagCalls: [],
    reorderCalls: [],
    focusCalls: [],
    notifyTests: 0,
    soundHooks: [],
    sound: soundBackend.control,
    storedMarks: () => marks.map((m) => ({ ...m })),
    prefs: () => structuredClone(prefs),
    fireNotify: (e) => emit('notify:fire', e),
    activityChanged: () => emit('activity:changed', {}),
    emitNotifyOpen: (id) => emit('notify:open', { id }),
    folderCalls: [],
    folderOpens: [],
    folderHides: [],
    archiveCalls: [],
    folderCreates: [],
    failNextFolderRead: false,
    failNextCheck: null,
    openAnyways: [],
    modelSets: [],
    creates: [],
    modelSwitchWorks: true,
    cachedCatalog: null,
    remoteCatalog: null,
    fetches: { catalog: 0, update: 0 },
    updateInfo: { current: '0.0.1', latest: '0.0.1', url: null, newer: false },
    restarts: [],
    menuRestart() {
      emit('menu:restart', {});
    },
    sessionEmojis: [],
    folderRows: (sectionId) => (folderRows.get(sectionId) ?? []).map((r) => viewRow(sectionId, r)),
    setFolderRows(sectionId, rows) {
      folderRows.set(sectionId, rows);
      save();
      emit('folder:changed', { sectionId });
    },
    addFolderSession(sectionId, row) {
      counter += 1;
      const home = sections.get(sectionId)?.folder ?? '/tmp';
      const r: FolderSession = {
        sessionId: `ext-${counter}`,
        nameSource: 'prompt',
        launchCwd: home,
        relPath: '',
        branch: null,
        folderBranch: folderRows.get(sectionId)?.[0]?.folderBranch ?? null,
        lastActivity: Date.now(),
        firstPrompt: row.name,
        lastPrompt: row.name,
        userTurns: 1,
        liveElsewhere: false,
        hidden: false,
        dmId: null,
        ...row,
      };
      folderRows.set(sectionId, [...(folderRows.get(sectionId) ?? []), r]);
      save();
      emit('folder:changed', { sectionId });
      return viewRow(sectionId, r);
    },
    patchFolderSession(sectionId, sessionId, patch) {
      folderRows.set(
        sectionId,
        (folderRows.get(sectionId) ?? []).map((r) =>
          r.sessionId === sessionId ? { ...r, ...patch } : r,
        ),
      );
      save();
      emit('folder:changed', { sectionId });
    },
    folderChanged: (sectionId) => emit('folder:changed', { sectionId }),
    seedChat(id, items) {
      chats.set(id, [...items]);
    },
    pushItems(id, items) {
      const list = chats.get(id) ?? [];
      const b = badges.get(id) ?? { unread: 0, needsYou: false };
      let fresh = 0;
      for (const it of items) {
        const i = list.findIndex((x) => x.key === it.key);
        if (i >= 0) list[i] = it;
        else {
          list.push(it);
          if (it.kind === 'assistant' && !it.parentToolUseId) fresh += 1;
        }
        if (it.parentToolUseId) {
          const kids = (control.threads[it.parentToolUseId] ??= []);
          const j = kids.findIndex((x) => x.key === it.key);
          if (j >= 0) kids[j] = it;
          else kids.push(it);
        }
      }
      chats.set(id, list);
      emit('chat:items', { id, items });
      save();
      if (fresh > 0) control.setBadges(id, b.unread + fresh, b.needsYou);
    },
    emitPrompt(id, prompt) {
      const set = pending.get(id) ?? new Set<string>();
      set.add(prompt.promptId);
      pending.set(id, set);
      promptPayloads.set(prompt.promptId, { id, ...prompt });
      promptAt.set(prompt.promptId, Date.now());
      emit('prompt:pending', { id, ...prompt });
      const b = badges.get(id) ?? { unread: 0, needsYou: false };
      control.setBadges(id, b.unread, set.size > 0);
      return prompt.promptId;
    },
    seedPrompt(id, prompt) {
      const set = pending.get(id) ?? new Set<string>();
      set.add(prompt.promptId);
      pending.set(id, set);
      promptAt.set(prompt.promptId, Date.now());
      promptPayloads.set(prompt.promptId, { id, ...prompt });
    },
    resolvePrompt(id, promptId, by) {
      const set = pending.get(id);
      set?.delete(promptId);
      promptPayloads.delete(promptId);
      emit('prompt:resolved', { id, promptId, by });
      const b = badges.get(id) ?? { unread: 0, needsYou: false };
      control.setBadges(id, b.unread, (set?.size ?? 0) > 0);
    },
    setBadges(id, unread, needsYou) {
      badges.set(id, { unread, needsYou });
      emit('session:badges', { id, unread, needsYou });
      emit('activity:changed', {});
      save();
    },
    badges: (id) => badges.get(id) ?? { unread: 0, needsYou: false },
    setStatusline(id, text, chips = {}) {
      emit('statusline:update', { id, text, chips });
    },
    emitOutput: (id, base64) => emit('pty:output', { id, data: base64 }),
    emitText: (id, text) => emit('pty:output', { id, data: utf8ToBase64(text) }),
    setStatus(id, status, needs) {
      const s = sessions.get(id);
      if (s) {
        s.status = status;
        s.needs = status === 'waiting' ? needs : undefined;
      }
      emit('session:status', { id, status, needs });
    },
    setTitle(id, title) {
      const s = sessions.get(id);
      if (s) s.title = title;
      emit('session:title', { id, title });
    },
    exit(id, code) {
      const s = sessions.get(id);
      if (s) s.status = 'exited';
      emit('pty:exit', { id, code });
      emit('session:status', { id, status: 'exited' });
    },
    addSession(info) {
      counter += 1;
      const s: SessionInfo = {
        id: info.id ?? `mock-${counter}`,
        name: info.name ?? info.cwd.split('/').filter(Boolean).pop() ?? 'session',
        cwd: info.cwd,
        title: info.title ?? 'Claude Code',
        status: info.status ?? 'idle',
        sectionId: info.sectionId ?? null,
        starred: info.starred ?? false,
        archived: info.archived ?? false,
        hasDraft: false,
        mirror: info.mirror ?? null,
        terminalWait: null,
      };
      sessions.set(s.id, s);
      control.writes[s.id] = [];
      save();
      return s;
    },
    sessions: () => [...sessions.values()],
    addSection(info) {
      counter += 1;
      const sec: SectionInfo = {
        id: info.id ?? `sec-${counter}`,
        name: info.name,
        position: info.position ?? sections.size,
        collapsed: info.collapsed ?? false,
        folder: info.folder ?? null,
        archiveDays: info.archiveDays ?? 14,
        kind: info.kind ?? 'section',
        emoji: info.emoji ?? null,
      };
      sections.set(sec.id, sec);
      if (sec.folder && !folderRows.has(sec.id)) {
        folderRows.set(
          sec.id,
          sec.folder === FIXTURE_HOME
            ? makeFolderFixture(sec.folder)
            : makeSmallFixture(sec.folder),
        );
      }
      save();
      return sec;
    },
    sections: () => [...sections.values()].sort((a, b) => a.position - b.position),
  };

  const ipc: Ipc = {
    async sessionCreate(args) {
      control.creates.push(structuredClone(args));
      const at = args.args?.indexOf('--model') ?? -1;
      const launch = at >= 0 ? args.args?.[at + 1] : undefined;
      const s = control.addSession({ cwd: args.cwd, name: args.name, launchModel: launch ?? null });
      control.spawns.push(s.id);
      // The CLI's first statusline names the model it launched on.
      if (launch) {
        setTimeout(
          () => control.setStatusline(s.id, '', { model: modelName(launch), modelId: launch }),
          30,
        );
      }
      if (opts.banner) {
        queueMicrotask(() =>
          control.emitText(
            s.id,
            `\x1b[1mPatchroom mock session\x1b[0m\r\n${args.command ?? 'claude'} in ${args.cwd}\r\n`,
          ),
        );
      }
      return { id: s.id };
    },
    async sessionWrite(id, data) {
      const arr = (control.writes[id] ??= []);
      const bytes = base64ToBytes(data);
      for (const b of bytes) arr.push(b);
      // Claude Code's queued input: Ctrl+X Ctrl+S sends it now, Esc interrupts the turn.
      const held = control.queuedInput[id]?.length ?? 0;
      const str = String.fromCharCode(...bytes);
      if (held && str === '\x18\x13') setTimeout(() => control.dequeue(id), 20);
      else if (held && str === '\x1b') setTimeout(() => control.interrupt(id), 20);
      else if (str === '\r' && control.returned[id]?.length) {
        // Enter on text an interrupt put back in the prompt sends it.
        const text = control.returned[id].join('\n');
        control.returned[id] = [];
        setTimeout(
          () =>
            control.pushItems(id, [
              { key: `rt-${id}-${Date.now()}`, ts: Date.now(), kind: 'user', text, images: [] },
            ]),
          20,
        );
      }
    },
    async pasteImage(id, data, mediaType) {
      control.pastes.push({ id, data, mediaType });
      const ext = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
      return { path: `/tmp/patchroom-mock/pastes/${id}-${control.pastes.length}.${ext}` };
    },
    async sessionSendText(id, text) {
      const sess = sessions.get(id);
      const outcome: SendOutcome = sess?.mirror
        ? 'mirror_readonly'
        : sess?.terminalWait
          ? 'blocked_dialog'
          : sess?.status === 'busy'
            ? 'queued'
            : 'sent';
      control.sends.push({ id, text, outcome });
      if (outcome === 'mirror_readonly') {
        return {
          outcome,
          where: sess?.mirror?.where ?? 'another terminal',
          pid: sess?.mirror?.pid,
        };
      }
      if (outcome === 'blocked_dialog') return { outcome, reason: sess?.terminalWait?.reason };
      control.texts.push({ id, text });
      // `/model <id>` switches the CLI's model: its statusline reports the new one.
      const switched = /^\/model\s+(\S+)\s*$/.exec(text);
      if (switched && control.modelSwitchWorks) {
        const modelId = switched[1];
        setTimeout(() => control.setStatusline(id, '', { model: modelName(modelId), modelId }), 60);
        return { outcome };
      }
      if (switched) return { outcome };
      // A slash command that opens a TUI panel repaints the PTY and adds no transcript item.
      if (text.startsWith('/')) {
        if (control.repaintOnSlash)
          control.emitText(id, `\x1b[2J\x1b[H\x1b[1m${text}\x1b[0m panel\r\n`);
        return { outcome };
      }
      if (outcome === 'queued' && control.autoEcho) {
        (control.queuedInput[id] ??= []).push(text);
        return { outcome };
      }
      if (control.autoEcho) {
        const n = control.texts.length;
        setTimeout(
          () =>
            control.pushItems(id, [
              { key: `echo-${id}-${n}`, ts: Date.now(), kind: 'user', text, images: [] },
            ]),
          40,
        );
      }
      return { outcome };
    },
    async sessionTakeover(id) {
      control.takeovers.push(id);
      const s = sessions.get(id);
      if (!s?.mirror) throw new Error(`not a mirror: ${id}`);
      if (!closedMirrors.has(id)) {
        throw new Error(
          `still running in ${s.mirror.where ?? 'another terminal'} (pid ${s.mirror.pid ?? 0})`,
        );
      }
      closedMirrors.delete(id);
      control.spawns.push(id);
      control.setMirror(id, null);
      control.setStatus(id, 'idle');
      return { ...s };
    },
    async sessionMirrorTakeoverWhenClosed(id, enabled) {
      control.takeoverArms.push({ id, enabled });
      const s = sessions.get(id);
      if (!s?.mirror) return;
      control.setMirror(id, { ...s.mirror, takeoverWhenClosed: enabled });
    },
    async linkOpenExternal(url) {
      if (!/^https?:\/\//.test(url)) throw new Error('only http and https links open');
      control.external.push(url);
    },
    async viewerShow(url) {
      if (!/^https?:\/\//.test(url)) throw new Error('only http and https links open');
      control.viewer.push(`show ${url}`);
      window.setTimeout(() => {
        emit('viewer:changed', { url, loading: false });
        emit('viewer:title', { title: `Page at ${new URL(url).host}` });
      }, 10);
    },
    async viewerPlace() {
      if (control.viewer.at(-1) !== 'place') control.viewer.push('place');
    },
    async viewerHide() {
      control.viewer.push('hide');
    },
    async viewerGo(action) {
      control.viewer.push(`go ${action}`);
    },
    async viewerSnapshot() {
      control.viewer.push('snapshot');
      // A flat grey 1x1 picture: the pane shows a still, which is all a test can check.
      return MOCK_PNG;
    },
    async viewerReveal() {
      control.viewer.push('reveal');
    },
    async viewerSelection() {
      control.viewer.push('selection');
      const text = control.viewerPicked;
      const shown = [...control.viewer].reverse().find((v) => v.startsWith('show '));
      if (text && shown) {
        window.setTimeout(
          () => emit('viewer:selection', { text, url: shown.slice(5).split('#')[0] }),
          5,
        );
      }
      return !!shown;
    },
    async viewerFind(text) {
      control.viewer.push(`find ${text}`);
    },
    async viewerSignOut() {
      control.viewer.push('signout');
      return 'cleared';
    },
    async shotBegin() {
      // No capture in a browser: the overlay draws over the live page instead.
      return { dataUrl: '', width: window.innerWidth, height: window.innerHeight };
    },
    async shotCommit(id, rect) {
      control.shots.push({ id, rect });
      control.pastes.push({ id, data: '', mediaType: 'image/png' });
      return {
        path: `/tmp/patchroom-mock/pastes/${id}-shot-${control.shots.length}.png`,
        dataUrl: MOCK_PNG,
      };
    },
    async shotCancel() {},
    async sessionMirrorReveal(id) {
      const s = sessions.get(id);
      if (!s?.mirror) throw new Error('this session is not a read-only mirror');
      control.reveals.push(id);
    },
    async sessionMirrorEnd(id) {
      const s = sessions.get(id);
      if (!s?.mirror) throw new Error('this session is not a read-only mirror');
      const where = s.mirror.where ?? 'another terminal';
      if (s.status !== 'idle') {
        throw new Error(`it's not idle in ${where}; wait until it finishes, or close it there`);
      }
      control.mirrorEnds.push(id);
      control.setMirror(id, { ...s.mirror, takeoverWhenClosed: true });
      control.closeMirror(id);
      return { ...sessions.get(id)! };
    },
    async sessionResize(id, cols, rows) {
      control.resizes.push({ id, cols, rows });
    },
    async sessionKill(id) {
      control.exit(id, 0);
    },
    async sessionList() {
      return control
        .sessions()
        .map((s) => ({ ...s, hasDraft: drafts.has(s.id), folderChip: chipOf(s) }));
    },
    async sessionResume(id, cols, rows, openOpts) {
      if (openOpts?.openAnyway) control.openAnyways.push(id);
      else if (control.failNextCheck !== null) {
        const reason = control.failNextCheck;
        control.failNextCheck = null;
        return { outcome: 'check_failed', reason };
      }
      control.resumes.push({ id, cols, rows });
      control.spawns.push(id);
      const s = sessions.get(id);
      if (!s) throw new Error(`no such session: ${id}`);
      s.status = 'busy';
      emit('session:status', { id, status: 'busy' });
      if (opts.banner) control.emitText(id, `\r\n\x1b[1mResumed ${s.name}\x1b[0m\r\n`);
    },
    async sessionRename(id, name) {
      const s = sessions.get(id);
      if (s) s.name = name;
      save();
    },
    async sessionDelete(id) {
      sessions.delete(id);
      drafts.delete(id);
      marks = marks.filter((m) => m.conversationId !== id);
      save();
    },
    async sessionSetSection(id, sectionId) {
      if (sectionId && sections.get(sectionId)?.kind === 'divider') {
        throw new Error('a divider cannot hold conversations');
      }
      const s = sessions.get(id);
      if (s) s.sectionId = sectionId;
      save();
    },
    async sectionList() {
      return control.sections().map((x) => ({ ...x }));
    },
    async sectionCreate(name, opts) {
      const kind = opts?.kind ?? 'section';
      if (kind === 'section' && !name.trim()) throw new Error('section name must not be empty');
      return { id: control.addSection({ name: name.trim(), kind, emoji: opts?.emoji ?? null }).id };
    },
    async sectionSetEmoji(id, emoji, flavor) {
      const sec = sections.get(id);
      if (!sec) throw new Error(`no such section: ${id}`);
      sec.emoji = emoji?.trim() || null;
      if (flavor !== undefined) sec.emojiFlavor = sec.emoji ? flavor : null;
      save();
    },
    async sectionSetCollapsed(id, collapsed) {
      const sec = sections.get(id);
      if (sec) sec.collapsed = collapsed;
      save();
    },
    async pickFolder() {
      return control.pickResult;
    },
    async chatHistory(id, before, limit = 200) {
      control.historyCalls.push({ id, before, limit });
      const list = chats.get(id) ?? [];
      const main = list.filter((i) => !i.parentToolUseId);
      const end = before === undefined ? main.length : main.findIndex((i) => i.key === before);
      const stop = end < 0 ? main.length : end;
      const start = Math.max(0, stop - limit);
      return { items: main.slice(start, stop), hasMore: start > 0 };
    },
    async chatThread(id, toolUseId) {
      control.threadCalls.push({ id, toolUseId });
      return { items: [...(control.threads[toolUseId] ?? [])] };
    },
    async chatImage(_id, ref) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#cc4a2f"/><text x="12" y="56" font-size="16" fill="#fff">${ref}</text></svg>`;
      return { dataUrl: `data:image/svg+xml;base64,${btoa(svg)}` };
    },
    async promptAnswer(id, promptId, answer) {
      control.answers.push({ id, promptId, answer });
      // Handing a prompt to the terminal does not resolve it: the TUI dialog answers later.
      if (answer.kind !== 'terminal') control.resolvePrompt(id, promptId, 'chat');
    },
    async promptList(id) {
      return [...(pending.get(id) ?? [])].flatMap((pid) => {
        const p = promptPayloads.get(pid);
        return p ? [p] : [];
      });
    },
    async sessionMarkRead(id) {
      control.marks.push(id);
      const b = badges.get(id);
      if (b && b.unread !== 0) control.setBadges(id, 0, b.needsYou);
    },
    async statuslineCycleMode(id) {
      control.modeCycles.push(id);
    },
    async sessionView(id, view) {
      control.views.push({ id, view });
    },
    async sectionRename(id, name) {
      const sec = sections.get(id);
      if (!sec) throw new Error(`no such section: ${id}`);
      // A divider may lose its label; a section keeps its name when the new one is blank.
      sec.name = sec.kind === 'divider' ? name.trim() : name.trim() || sec.name;
      save();
    },
    async sectionDelete(id) {
      sections.delete(id);
      folderRows.delete(id);
      for (const s of sessions.values()) if (s.sectionId === id) s.sectionId = null;
      save();
    },
    async sectionReorder(ids) {
      ids.forEach((sid, i) => {
        const sec = sections.get(sid);
        if (sec) sec.position = i;
      });
      save();
    },
    async sessionReorder(sectionId, ids) {
      control.reorderCalls.push({ sectionId, ids });
      const moved = ids.flatMap((sid) => {
        const s = sessions.get(sid);
        return s ? [s] : [];
      });
      for (const s of moved) {
        sessions.delete(s.id);
        s.sectionId = sectionId;
      }
      for (const s of moved) sessions.set(s.id, s);
      save();
    },
    async sessionSetFlags(id, flags) {
      control.flagCalls.push({ id, ...flags });
      const s = sessions.get(id);
      if (!s) throw new Error(`no such session: ${id}`);
      if (flags.starred !== undefined) s.starred = flags.starred;
      if (flags.archived !== undefined) s.archived = flags.archived;
      save();
      emit('activity:changed', {});
    },
    async draftGet(id) {
      return { body: drafts.get(id) ?? '' };
    },
    async draftSet(id, body) {
      control.draftSets.push({ id, body });
      if (body === '') drafts.delete(id);
      else drafts.set(id, body);
      save();
    },
    async markAdd(id, itemKey, kind, emoji) {
      const have = marks.find(
        (m) =>
          m.conversationId === id &&
          m.itemKey === itemKey &&
          m.kind === kind &&
          (m.emoji ?? null) === (emoji ?? null),
      );
      if (have) return { ...have };
      counter += 1;
      const item = (chats.get(id) ?? []).find((i) => i.key === itemKey);
      const m: MarkInfo = {
        id: `mark-${counter}`,
        conversationId: id,
        itemKey,
        kind,
        emoji: emoji ?? null,
        snapshot: (item ? searchText(item) : '').slice(0, 280),
        createdAt: Date.now(),
      };
      marks.push(m);
      save();
      return { ...m };
    },
    async markRemove(id, itemKey, kind, emoji) {
      marks = marks.filter(
        (m) =>
          !(
            m.conversationId === id &&
            m.itemKey === itemKey &&
            m.kind === kind &&
            (m.emoji ?? null) === (emoji ?? null)
          ),
      );
      save();
    },
    async markList(args = {}) {
      return marks
        .filter(
          (m) => (!args.id || m.conversationId === args.id) && (!args.kind || m.kind === args.kind),
        )
        .map((m) => ({ ...m }));
    },
    async search({ query, scope, limit = 50 }) {
      control.searchCalls.push({ query, scope, limit });
      const t0 = performance.now();
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: SearchHit[] = [];
      if (terms.length > 0) {
        for (const [sid, list] of chats) {
          if (scope?.id && scope.id !== sid) continue;
          if (!sessions.has(sid)) continue;
          for (const it of list) {
            const text = searchText(it);
            const low = text.toLowerCase();
            if (!terms.every((t) => low.includes(t))) continue;
            const { snippet, ranges } = snippetOf(text, terms);
            hits.push({ id: sid, itemKey: it.key, ts: it.ts, kind: it.kind, snippet, ranges });
          }
        }
      }
      hits.sort((a, b) => toMillis(b.ts) - toMillis(a.ts));
      return { hits: hits.slice(0, limit), tookMs: Math.round(performance.now() - t0) };
    },
    async searchReindex() {
      let docs = 0;
      for (const list of chats.values()) docs += list.length;
      return { docs, tookMs: 1 };
    },
    async chatLocate(id, itemKey) {
      control.locateCalls.push({ id, itemKey });
      const main = (chats.get(id) ?? []).filter((i) => !i.parentToolUseId);
      const at = main.findIndex((i) => i.key === itemKey);
      if (at < 0) throw new Error(`no such item: ${itemKey}`);
      // Cursor for a 300-item page that holds the item with room to spare below it.
      const end = Math.min(main.length, at + 100);
      return { before: end >= main.length ? null : main[end].key };
    },
    async activityList() {
      return activity();
    },
    async prefsGet() {
      return structuredClone(prefs);
    },
    async sessionSetEmoji(id, emoji, flavor) {
      control.sessionEmojis.push({ id, emoji, flavor });
      const s = sessions.get(id);
      if (!s) throw new Error(`no such session: ${id}`);
      s.emoji = emoji?.trim() || null;
      s.emojiFlavor = s.emoji ? (flavor ?? 'apple') : null;
      save();
    },
    async sessionSetModel(id, model) {
      if (!/^[A-Za-z0-9._:/@[\]-]{1,128}$/.test(model) || model.startsWith('-')) {
        throw new Error(`not a model name: ${model}`);
      }
      control.modelSets.push({ id, model });
      const s = sessions.get(id);
      if (s) s.launchModel = model;
      save();
    },
    async catalogGet() {
      return control.cachedCatalog ? structuredClone(control.cachedCatalog) : null;
    },
    async catalogRefresh() {
      if (!prefs.updates?.checkModels) throw new Error('Check for newer models is off in Settings');
      control.fetches.catalog += 1;
      if (!control.remoteCatalog) throw new Error('could not download the model catalog');
      control.cachedCatalog = structuredClone(control.remoteCatalog);
      return structuredClone(control.remoteCatalog);
    },
    async updateCheck() {
      if (!prefs.updates?.checkApp) throw new Error('Check for app updates is off in Settings');
      control.fetches.update += 1;
      return { ...control.updateInfo };
    },
    async appRestart(ids) {
      control.restarts.push([...ids]);
      try {
        window.localStorage.setItem(RESTART_KEY, JSON.stringify(ids));
      } catch {
        // Without storage the relaunch reopens nothing.
      }
      save();
      // The page reload stands in for the relaunch (with `?persist` the backend survives it).
      if (opts.persist) setTimeout(() => window.location.reload(), 30);
    },
    async appRestartPending() {
      try {
        const raw = window.localStorage.getItem(RESTART_KEY);
        window.localStorage.removeItem(RESTART_KEY);
        const ids = raw ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(ids) ? ids.filter((x): x is string => sessions.has(String(x))) : [];
      } catch {
        return [];
      }
    },
    async prefsSet(patch) {
      prefs = { ...prefs, ...structuredClone(patch) };
      save();
      emit('prefs:changed', { prefs: structuredClone(prefs) });
      return structuredClone(prefs);
    },
    soundPacks: soundBackend.soundPacks,
    soundFile: soundBackend.soundFile,
    soundCustomList: soundBackend.soundCustomList,
    soundCustomFile: soundBackend.soundCustomFile,
    soundPickFile: soundBackend.soundPickFile,
    soundImportFile: soundBackend.soundImportFile,
    soundCustomRemove: soundBackend.soundCustomRemove,
    soundClaudeProfiles: soundBackend.soundClaudeProfiles,
    soundImportClaudeProfile: soundBackend.soundImportClaudeProfile,
    themeImportDetect: () => Promise.resolve(structuredClone(MOCK_IMPORT_SOURCES)),
    themeImportFile: () => Promise.resolve(structuredClone(MOCK_IMPORT_FILE)),
    fontsList: () => Promise.resolve(structuredClone(MOCK_SYSTEM_FONTS)),
    async soundHooksDetect() {
      return control.soundHooks.map((h) => ({ ...h }));
    },
    async notifyTest() {
      control.notifyTests += 1;
      control.fireNotify({
        id: '',
        event: 'message',
        title: 'Patchroom',
        body: 'Test notification',
      });
    },
    async sessionFocus(id) {
      control.focusCalls.push(id);
    },
    async sectionCreateFromFolder(path, name) {
      control.folderCreates.push({ path, name });
      const trimmed = path.replace(/\/+$/, '');
      const sec = control.addSection({
        name: name?.trim() || trimmed.split('/').filter(Boolean).pop() || 'Folder',
        folder: trimmed,
      });
      return { id: sec.id };
    },
    async sectionSetArchiveDays(id, days) {
      control.archiveCalls.push({ id, days });
      const sec = sections.get(id);
      if (!sec) throw new Error(`no such section: ${id}`);
      sec.archiveDays = days;
      save();
    },
    async folderSessions(sectionId) {
      control.folderCalls.push(sectionId);
      if (control.failNextFolderRead) {
        control.failNextFolderRead = false;
        throw new Error('could not read the project folders');
      }
      if (!sections.get(sectionId)?.folder) throw new Error(`not a folder section: ${sectionId}`);
      const rows = control.folderRows(sectionId);
      return { sessions: rows, hiddenCount: rows.filter((r) => r.hidden).length };
    },
    async folderSessionOpen(sectionId, sessionId, openOpts) {
      const row = (folderRows.get(sectionId) ?? []).find((r) => r.sessionId === sessionId);
      if (!row) throw new Error(`no such session: ${sessionId}`);
      if (openOpts?.openAnyway) control.openAnyways.push(sessionId);
      else if (control.failNextCheck !== null) {
        // No DM row is left behind and nothing spawns.
        const reason = control.failNextCheck;
        control.failNextCheck = null;
        return { outcome: 'check_failed', reason };
      }
      control.folderOpens.push({ sectionId, sessionId, cwd: row.launchCwd });
      const have = row.dmId ? sessions.get(row.dmId) : undefined;
      if (have) return { ...have, folderChip: chipOf(have) };
      // Live in another terminal: a read-only mirror, never a second process.
      const live = row.liveElsewhere;
      const s = control.addSession({
        cwd: row.launchCwd,
        name: row.name,
        sectionId,
        status: live ? 'idle' : 'busy',
        mirror: live ? { where: 'iTerm', pid: 4242, takeoverWhenClosed: false } : null,
      });
      if (!live) control.spawns.push(s.id);
      row.dmId = s.id;
      // The resumed session replays its history into the chat.
      const t = Date.now();
      chats.set(s.id, [
        { key: `${s.id}-u1`, ts: t - 60_000, kind: 'user', text: row.firstPrompt, images: [] },
        {
          key: `${s.id}-a1`,
          ts: t - 30_000,
          kind: 'assistant',
          text: `Picking up where we left off: ${row.lastPrompt}`,
        },
      ]);
      if (opts.banner && !live) control.emitText(s.id, `\x1b[1mResumed ${row.name}\x1b[0m\r\n`);
      save();
      emit('folder:changed', { sectionId });
      return { ...s, folderChip: chipOf(s) };
    },
    async folderSessionHide(sectionId, sessionId, hidden) {
      control.folderHides.push({ sectionId, sessionId, hidden });
      hideOverride.set(rowKey(sectionId, sessionId), hidden);
      save();
      emit('folder:changed', { sectionId });
    },
    async on(event, handler) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(handler as Handler);
      const off: Unlisten = () => set.delete(handler as Handler);
      return off;
    },
  };

  return { ipc, control };
}
