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
  Needs,
  SectionInfo,
  SessionInfo,
  SessionStatus,
  Unlisten,
} from './types';

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

const DEFAULT_PREFS: Prefs = {
  themeId: 'homeroom',
  mode: 'system',
  customThemes: [],
  base: 'homeroom',
  cablePreset: 'theme',
  notify: { default: 'all', perDm: {} },
  sound: { enabled: true, volume: 0.6, perEvent: {}, perDm: {}, hookPolicy: {} },
  dnd: { manual: false, schedule: null },
  termPerDm: {},
  searchAllSessions: false,
};

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
  let marks: MarkInfo[] = [];
  let prefs: Prefs = structuredClone(DEFAULT_PREFS);
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
      const s = control.addSession({ cwd: args.cwd, name: args.name });
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
      for (const b of base64ToBytes(data)) arr.push(b);
    },
    async pasteImage(id, data, mediaType) {
      control.pastes.push({ id, data, mediaType });
      const ext = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
      return { path: `/tmp/patchroom-mock/pastes/${id}-${control.pastes.length}.${ext}` };
    },
    async sessionSendText(id, text) {
      control.texts.push({ id, text });
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
    async sessionResume(id, cols, rows) {
      control.resumes.push({ id, cols, rows });
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
      const s = sessions.get(id);
      if (s) s.sectionId = sectionId;
      save();
    },
    async sectionList() {
      return control.sections().map((x) => ({ ...x }));
    },
    async sectionCreate(name) {
      return { id: control.addSection({ name }).id };
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
      sec.name = name.trim() || sec.name;
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
    async prefsSet(patch) {
      prefs = { ...prefs, ...structuredClone(patch) };
      save();
      emit('prefs:changed', { prefs: structuredClone(prefs) });
      return structuredClone(prefs);
    },
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
    async folderSessionOpen(sectionId, sessionId) {
      const row = (folderRows.get(sectionId) ?? []).find((r) => r.sessionId === sessionId);
      if (!row) throw new Error(`no such session: ${sessionId}`);
      control.folderOpens.push({ sectionId, sessionId, cwd: row.launchCwd });
      const have = row.dmId ? sessions.get(row.dmId) : undefined;
      if (have) return { ...have, folderChip: chipOf(have) };
      const s = control.addSession({
        cwd: row.launchCwd,
        name: row.name,
        sectionId,
        status: 'busy',
      });
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
      if (opts.banner) control.emitText(s.id, `\x1b[1mResumed ${row.name}\x1b[0m\r\n`);
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
