import { base64ToBytes, utf8ToBase64 } from '../lib/base64';
import { syntheticChat, syntheticThread, bigChat } from './synthetic';
import type {
  ChatItem,
  Ipc,
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
export function createMockIpc(opts: { banner?: boolean } = {}): { ipc: Ipc; control: MockControl } {
  const sessions = new Map<string, SessionInfo>();
  const sections = new Map<string, SectionInfo>();
  const handlers = new Map<string, Set<Handler>>();
  const chats = new Map<string, ChatItem[]>();
  const badges = new Map<string, { unread: number; needsYou: boolean }>();
  const pending = new Map<string, Set<string>>();
  let counter = 0;

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
      if (fresh > 0) control.setBadges(id, b.unread + fresh, b.needsYou);
    },
    emitPrompt(id, prompt) {
      const set = pending.get(id) ?? new Set<string>();
      set.add(prompt.promptId);
      pending.set(id, set);
      emit('prompt:pending', { id, ...prompt });
      const b = badges.get(id) ?? { unread: 0, needsYou: false };
      control.setBadges(id, b.unread, set.size > 0);
      return prompt.promptId;
    },
    resolvePrompt(id, promptId, by) {
      const set = pending.get(id);
      set?.delete(promptId);
      emit('prompt:resolved', { id, promptId, by });
      const b = badges.get(id) ?? { unread: 0, needsYou: false };
      control.setBadges(id, b.unread, (set?.size ?? 0) > 0);
    },
    setBadges(id, unread, needsYou) {
      badges.set(id, { unread, needsYou });
      emit('session:badges', { id, unread, needsYou });
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
      };
      sessions.set(s.id, s);
      control.writes[s.id] = [];
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
      };
      sections.set(sec.id, sec);
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
      return control.sessions().map((s) => ({ ...s }));
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
    },
    async sessionDelete(id) {
      sessions.delete(id);
    },
    async sessionSetSection(id, sectionId) {
      const s = sessions.get(id);
      if (s) s.sectionId = sectionId;
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
