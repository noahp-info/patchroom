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
  /** Persisted unread count, when the backend includes it in `session_list`. */
  unread?: number;
  /** A prompt waits on the user. The backend sends a boolean; a count is accepted too. */
  needsYou?: number | boolean;
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

/** Event name to payload: the P1b events plus the P2 chat events. */
export interface IpcEvents {
  'pty:output': PtyOutputEvent;
  'pty:exit': PtyExitEvent;
  'session:title': SessionTitleEvent;
  'session:status': SessionStatusEvent;
  'chat:items': ChatItemsEvent;
  'prompt:pending': PromptPendingEvent;
  'prompt:resolved': PromptResolvedEvent;
  'session:badges': SessionBadgesEvent;
  'statusline:update': StatuslineUpdateEvent;
}

export type Unlisten = () => void;

/** The whole frontend/backend surface. Tauri and the mock both implement it. */
export interface Ipc {
  sessionCreate(args: SessionCreateArgs): Promise<{ id: string }>;
  /** `data` is base64. */
  sessionWrite(id: string, data: string): Promise<void>;
  sessionSendText(id: string, text: string): Promise<void>;
  /** Save pasted image bytes (`data` is base64) to a private file and return its absolute path. */
  pasteImage(id: string, data: string, mediaType: string): Promise<{ path: string }>;
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
  /** Newest page first (`before` is the key of the oldest item already held), oldest-first within it. */
  chatHistory(id: string, before?: string, limit?: number): Promise<ChatHistory>;
  /** A subagent's items. */
  chatThread(id: string, toolUseId: string): Promise<{ items: ChatItem[] }>;
  /** Image bytes are fetched on demand, never inlined in items. */
  chatImage(id: string, ref: string): Promise<{ dataUrl: string }>;
  promptAnswer(id: string, promptId: string, answer: PromptAnswer): Promise<void>;
  /** Announced, unresolved prompts as `prompt:pending` payloads (catch-up after a reload). */
  promptList(id: string): Promise<PromptPendingEvent[]>;
  /** Clears the unread count. Never clears needs-you. */
  sessionMarkRead(id: string): Promise<void>;
  /** Writes Shift+Tab to the PTY. */
  statuslineCycleMode(id: string): Promise<void>;
  /** Hint which view is showing, so a hidden picker can be handed to the TUI at once. */
  sessionView(id: string, view: 'chat' | 'terminal'): Promise<void>;
  on<K extends keyof IpcEvents>(
    event: K,
    handler: (payload: IpcEvents[K]) => void,
  ): Promise<Unlisten>;
}

// ---------------------------------------------------------------------------------------------
// P2 chat layer. JSON fields are camelCase; `kind` values are exactly the lowercase names below.
// ---------------------------------------------------------------------------------------------

/** Milliseconds since the epoch, or an ISO-8601 string (transcript timestamps). */
export type Timestamp = number | string;

export interface ChatItemBase {
  /** Stable. A later item with the same key replaces the earlier one. */
  key: string;
  ts: Timestamp;
  /** Set on a subagent's own items. They show in the thread pane, never in the main log. */
  parentToolUseId?: string;
}

export interface ChatImageRef {
  ref: string;
  mediaType: string;
}

export interface UserItem extends ChatItemBase {
  kind: 'user';
  text: string;
  images: ChatImageRef[];
}
export interface AssistantItem extends ChatItemBase {
  kind: 'assistant';
  text: string;
}
export interface ThinkingItem extends ChatItemBase {
  kind: 'thinking';
  text: string;
}

export type ToolState = 'pending' | 'running' | 'ok' | 'error' | 'denied' | 'interrupted';

export interface ToolResult {
  text: string;
  isError: boolean;
  truncated: boolean;
  /** Images in the result, fetched with `chat_image`. */
  images?: ChatImageRef[];
}

export interface ToolItem extends ChatItemBase {
  kind: 'tool';
  toolUseId: string;
  name: string;
  input: unknown;
  /** Long strings in `input` were cut by the backend. */
  inputTruncated?: boolean;
  state: ToolState;
  result?: ToolResult;
  /**
   * Edit and Write diff. The wire shape is not fixed by the contract, so the reader in
   * `lib/diff.ts` accepts a unified-diff string, `{unified}`, `{hunks}` or `{oldString, newString}`,
   * and falls back to the tool input.
   */
  diff?: unknown;
}

export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionDef {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

export interface QuestionItem extends ChatItemBase {
  kind: 'question';
  toolUseId: string;
  questions: QuestionDef[];
  /** Question text to the chosen label (labels joined with ", " for multi-select). */
  answers?: Record<string, string>;
  state?: 'pending' | 'answered' | 'declined' | 'interrupted' | (string & {});
}
export interface PlanItem extends ChatItemBase {
  kind: 'plan';
  toolUseId: string;
  plan: string;
  state: string;
}

export type SubagentState = 'running' | 'ok' | 'error' | 'interrupted' | (string & {});
export interface SubagentItem extends ChatItemBase {
  kind: 'subagent';
  toolUseId: string;
  description: string;
  agentType: string;
  itemCount: number;
  state: SubagentState;
}
export interface SystemItem extends ChatItemBase {
  kind: 'system';
  subtype: string;
  text: string;
}
export interface FallbackItem extends ChatItemBase {
  kind: 'fallback';
  lineType: string;
  summary: string;
}

export type ChatItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | QuestionItem
  | PlanItem
  | SubagentItem
  | SystemItem
  | FallbackItem;

export type ChatItemKind = ChatItem['kind'];

export interface ChatHistory {
  items: ChatItem[];
  hasMore: boolean;
}

export type PromptKind = 'permission' | 'question' | 'plan';

export type PromptAnswer =
  | { kind: 'allow' }
  | { kind: 'allow_always' }
  | { kind: 'deny'; message?: string }
  | { kind: 'questions'; answers: Record<string, string> }
  /** Hand the prompt to the TUI: the hook lets go and the terminal dialog is the answerer. */
  | { kind: 'terminal' };

export type ResolvedBy = 'chat' | 'terminal' | 'timeout' | 'interrupt';

export interface ChatItemsEvent {
  id: string;
  items: ChatItem[];
}
export interface PromptPendingEvent {
  id: string;
  promptId: string;
  kind: PromptKind;
  toolName: string;
  toolInput: unknown;
  toolUseId?: string;
  questions?: QuestionDef[];
  /** The CLI offered its own permission suggestions, so "Always allow" has a rule to apply. */
  canAlways?: boolean;
}
export interface PromptResolvedEvent {
  id: string;
  promptId: string;
  by: ResolvedBy;
}
export interface SessionBadgesEvent {
  id: string;
  unread: number;
  /** A prompt waits on the user (boolean on the wire; a count is accepted too). */
  needsYou: number | boolean;
}
export interface StatusChips {
  model?: string;
  contextPct?: number;
  cost?: number | string;
  mode?: string;
  worktree?: string;
  prUrl?: string;
}
export interface StatuslineUpdateEvent {
  id: string;
  /** The user's own statusLine output, as ANSI. */
  text: string;
  chips: StatusChips;
}
