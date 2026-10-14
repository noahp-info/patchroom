import { base64ToBytes, utf8ToBase64 } from '../lib/base64';
import type {
  Ipc,
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
  let counter = 0;

  const emit = <K extends keyof IpcEvents>(event: K, payload: IpcEvents[K]) => {
    for (const h of handlers.get(event) ?? []) h(payload as never);
  };

  const control: MockControl = {
    writes: {},
    resizes: [],
    texts: [],
    resumes: [],
    pickResult: null,
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
    async sessionSendText(id, text) {
      control.texts.push({ id, text });
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
