/** Session status as reported by the backend (`session:status` and `session_list`). */
export type SessionStatus = 'busy' | 'idle' | 'waiting' | 'exited';

/** One row of `session_list`. */
export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  title: string;
  status: SessionStatus;
  /** Why a `waiting` session needs the user. */
  needs?: Needs;
  /** Exit code of the last run, set client-side when the process exits (null: killed). */
  exitCode?: number | null;
  /** Stored section the DM sits in, or null for the default group. */
  sectionId: string | null;
}

/** Reason a `waiting` session needs the user. */
export type Needs = 'permission' | 'question' | 'other';

/** One row of `section_list`. */
export interface SectionInfo {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
}

export interface SessionCreateArgs {
  cwd: string;
  command?: string;
  args?: string[];
  name?: string;
}

export interface PtyOutputEvent {
  id: string;
  /** Base64 bytes. */
  data: string;
}
export interface PtyExitEvent {
  id: string;
  code: number | null;
}
export interface SessionTitleEvent {
  id: string;
  title: string;
}
export interface SessionStatusEvent {
  id: string;
  status: SessionStatus;
  needs?: Needs;
}

/** Event name to payload, exactly as in the P1b IPC contract. */
export interface IpcEvents {
  'pty:output': PtyOutputEvent;
  'pty:exit': PtyExitEvent;
  'session:title': SessionTitleEvent;
  'session:status': SessionStatusEvent;
}

export type Unlisten = () => void;

/** The whole frontend/backend surface. Tauri and the mock both implement it. */
export interface Ipc {
  sessionCreate(args: SessionCreateArgs): Promise<{ id: string }>;
  /** `data` is base64. */
  sessionWrite(id: string, data: string): Promise<void>;
  sessionSendText(id: string, text: string): Promise<void>;
  sessionResize(id: string, cols: number, rows: number): Promise<void>;
  sessionKill(id: string): Promise<void>;
  sessionList(): Promise<SessionInfo[]>;
  /** Restart an exited DM. Claude DMs run `claude --resume <stored session id>`. */
  sessionResume(id: string, cols?: number, rows?: number): Promise<void>;
  sessionRename(id: string, name: string): Promise<void>;
  /** Kill and forget the DM. */
  sessionDelete(id: string): Promise<void>;
  /** Move a DM to a stored section, or to the default group with null. */
  sessionSetSection(id: string, sectionId: string | null): Promise<void>;
  sectionList(): Promise<SectionInfo[]>;
  sectionCreate(name: string): Promise<{ id: string }>;
  sectionSetCollapsed(id: string, collapsed: boolean): Promise<void>;
  /** Native folder picker (`pick_folder`). Resolves null when cancelled. */
  pickFolder(defaultPath?: string): Promise<string | null>;
  on<K extends keyof IpcEvents>(
    event: K,
    handler: (payload: IpcEvents[K]) => void,
  ): Promise<Unlisten>;
}
