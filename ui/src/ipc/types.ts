import type {
  ClaudeProfile,
  DmSoundPref,
  ImportedFile,
  MixChoice,
  PackInfo,
  SoundFileData,
} from '../components/prefs/ipc.ts';
import type { Theme } from '../theme/types.ts';
import type { ImportEntry, ImportSource } from '../theme/themeImport.ts';
import type { FontOption, FontPrefs } from '../theme/typeface.ts';
import type { DictationPrefs, SettingsPane } from '../lib/dictation.ts';

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
  /** P3: pinned to the Starred group. */
  starred?: boolean;
  /** P3: hidden from the main list; archived DMs never badge. */
  archived?: boolean;
  /** P3: an unsent composer draft is stored for this DM. */
  hasDraft?: boolean;
  /** P3 folder sections: set when the DM's cwd is outside its section's folder (e.g. "knowfirst"). */
  folderChip?: string | null;
  /**
   * Session parity: the session runs in another terminal. The DM is a read-only mirror of its
   * transcript and no process of Patchroom's own exists. Cleared once it takes over.
   */
  mirror?: MirrorInfo | null;
  /**
   * Claude waits on something only the terminal can show (no chat prompt). Set by
   * `session:terminal_wait`, cleared by `session:terminal_wait_clear`.
   */
  terminalWait?: TerminalWait | null;
  /** When the session last turned busy, epoch ms (UI only). */
  busySince?: number;
  /** The CLI's live working line while a turn runs (`session:working`). */
  working?: WorkingLine | null;
  /** Leading emoji of the session row, drawn in `emojiFlavor`. */
  emoji?: string | null;
  emojiFlavor?: EmojiFlavor | null;
  /** The `--model` the DM launches and resumes with (set by a confirmed switch). */
  launchModel?: string | null;
}

/** How an emoji is drawn: the system's Apple Color Emoji or the bundled Noto Color Emoji. */
export type EmojiFlavor = 'apple' | 'noto';

/** An emoji someone chose for a name: the character and how it is drawn. */
export interface EmojiChoice {
  char: string;
  flavor: EmojiFlavor;
}

/** "Slithering…" and "1m 31s · ↓ 409 tokens · deep in thought", read off the CLI's screen. */
export interface WorkingLine {
  verb: string;
  detail: string;
}

/** Where a mirrored session really runs. */
export interface MirrorInfo {
  /** `iTerm`, `Terminal`, `tmux`, `Ghostty`, ... or `another terminal`. */
  where?: string;
  pid?: number;
  /** "Take over when it closes" is on: the backend resumes the session when that process exits. */
  takeoverWhenClosed?: boolean;
}

export interface TerminalWait {
  /** The CLI's `waitingFor`, else `dialog open`. */
  reason: string;
  /** Epoch milliseconds. */
  since: number;
}

/** Reason a `waiting` session needs the user. */
export type Needs = 'permission' | 'question' | 'other';

/** One row of `section_list`. */
export interface SectionInfo {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
  /** P3: the home folder of a folder section; null for a plain section. */
  folder?: string | null;
  /** P3: folder sections fold sessions idle this many days into "Older than X days". */
  archiveDays?: number;
  /** `divider` rows hold no DMs: a rule with an optional label. Absent means `section`. */
  kind?: SectionKind;
  /** Leading emoji of the header; null for none. */
  emoji?: string | null;
  /** How the header emoji is drawn. Absent: apple. */
  emojiFlavor?: EmojiFlavor | null;
}

/** What a stored sidebar row is. */
export type SectionKind = 'section' | 'divider';

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
  'notify:fire': NotifyFireEvent;
  'notify:open': { id: string };
  'prefs:changed': PrefsChangedEvent;
  'activity:changed': Record<string, never>;
  'folder:changed': FolderChangedEvent;
  'session:mirror': SessionMirrorEvent;
  'session:terminal_wait': TerminalWaitEvent;
  'session:terminal_wait_clear': { id: string };
  'session:working': { id: string; verb: string | null; detail: string | null };
  'viewer:changed': { url: string; loading: boolean };
  'link:open': { id: string | null; url: string };
  /** The app menu's Settings item (Cmd+,). */
  'menu:settings': Record<string, never>;
  'viewer:title': { title: string };
  /** The viewer page's selection, handed back after `viewerSelection` (never unasked). */
  'viewer:selection': { text: string; url: string };
  /** A claude.ai page in the viewer showed the user signed in or out. Never from cookies. */
  'viewer:account': { service: 'claude.ai'; signedIn: boolean; url: string };
  /** Edit > Comment on Selection (Cmd+Shift+M). Fires even while the viewer has focus. */
  'menu:comment': Record<string, never> | null;
  /** Edit > Screenshot to Steer (Cmd+Shift+2). */
  'menu:screenshot': Record<string, never> | null;
  /** The app menu's Restart Patchroom item. */
  'menu:restart': Record<string, never> | null;
  /** A line from the on-device dictation helper, or `ended` last. */
  'dictation:event': DictationEvent;
}

/** `dictation:event`: one helper line of run `sid`, or `ended` once at the end. */
export interface DictationEvent {
  sid: number;
  type: 'ready' | 'partial' | 'final' | 'error' | 'end' | 'ended';
  text?: string;
  code?: string;
  message?: string;
  locale?: string;
  /** The locale's display name, for "isn't available for <language>". */
  language?: string;
  reason?: 'stopped' | 'silence' | 'error' | 'killed' | 'exited';
}

export type DictationPermission =
  'authorized' | 'denied' | 'restricted' | 'not_determined' | 'unknown';

/** `dictation_locales`: languages and permission states, read without asking. */
export interface DictationLocales {
  locales: { id: string; name: string; onDevice: boolean }[];
  current: string;
  speech: DictationPermission;
  mic: DictationPermission;
  /** False when this build has no helper (the browser, a non-macOS build). */
  available: boolean;
}

export interface TerminalWaitEvent extends TerminalWait {
  id: string;
}

/** A DM entered or left mirror mode (`mirror: null` once the session is its own process). */
export interface SessionMirrorEvent {
  id: string;
  mirror: MirrorInfo | null;
}

/**
 * What `session_send_text` did with the text.
 * - `sent`: written to claude's input.
 * - `queued`: claude is busy; the text waits its turn.
 * - `blocked_dialog`: a terminal-only dialog is up; nothing was written and the draft stays.
 * - `mirror_readonly`: the session runs in another terminal; nothing was written.
 */
/**
 * The re-check of `claude agents --json` could not finish, so the backend spawned nothing (a
 * guess could start a second process). `reason` says why. An older backend rejects the call with
 * a message starting `could not check`; the tauri layer turns that into this shape.
 */
export interface CheckFailed {
  outcome: 'check_failed';
  reason: string;
}

/** `openAnyway`: skip the live check and spawn. The user accepted that two processes may run. */
export interface OpenOptions {
  openAnyway?: boolean;
}

export function isCheckFailed(r: unknown): r is CheckFailed {
  return !!r && typeof r === 'object' && (r as CheckFailed).outcome === 'check_failed';
}

export type SendOutcome = 'sent' | 'queued' | 'blocked_dialog' | 'mirror_readonly';
export interface SendResult {
  outcome: SendOutcome;
  /** `blocked_dialog`: what claude waits for. */
  reason?: string;
  /** `mirror_readonly`: where the session runs, and the other process. */
  where?: string;
  pid?: number;
}

export type Unlisten = () => void;

/** The whole frontend/backend surface. Tauri and the mock both implement it. */
export interface Ipc {
  sessionCreate(args: SessionCreateArgs): Promise<{ id: string }>;
  /** `data` is base64. */
  sessionWrite(id: string, data: string): Promise<void>;
  /** An older backend returns nothing; the UI reads that as `sent`. */
  sessionSendText(id: string, text: string): Promise<SendResult | void>;
  /** Resume a mirrored DM now. Rejects while the other process lives (it is never killed). */
  sessionTakeover(id: string, cols?: number, rows?: number): Promise<SessionInfo>;
  /** Arm or disarm "Take over when it closes" on a mirrored DM. */
  sessionMirrorTakeoverWhenClosed(id: string, enabled: boolean): Promise<void>;
  /** Bring the terminal that runs a mirrored DM to the front, on its tab when possible. */
  sessionMirrorReveal(id: string): Promise<void>;
  /** Open an http(s) link in the system default browser. */
  linkOpenExternal(url: string): Promise<void>;
  /** Show an http(s) link in the in-app viewer, laid over `rect` (CSS px of the window). */
  viewerShow(url: string, rect: ViewerRect): Promise<void>;
  /** Move the viewer with its pane. */
  viewerPlace(rect: ViewerRect): Promise<void>;
  viewerHide(): Promise<void>;
  viewerGo(action: 'back' | 'forward' | 'reload'): Promise<void>;
  /** A PNG data URL of the viewer's pixels, so an overlay can hide the native view without a blank pane. */
  viewerSnapshot(rect: ViewerRect): Promise<string | null>;
  /** Show the viewer again over `rect`, on the page it had. */
  viewerReveal(rect: ViewerRect): Promise<void>;
  /** Ask the viewer page for its selection; it arrives as `viewer:selection`. False: no viewer. */
  viewerSelection(): Promise<boolean>;
  /** Scroll the viewer page to `text`. */
  viewerFind(text: string): Promise<void>;
  /** Sign out of claude.ai in the viewer: `cleared` its own storage, or ran claude.ai's `logout`. */
  viewerSignOut(): Promise<'cleared' | 'logout'>;
  /** Capture Patchroom's own window for screenshot-to-steer. `width`/`height` in CSS px. */
  shotBegin(): Promise<{ dataUrl: string; width: number; height: number }>;
  /** Crop the capture to `rect`, save it like a pasted image and return its path. */
  shotCommit(id: string, rect: ViewerRect): Promise<{ path: string; dataUrl: string }>;
  shotCancel(): Promise<void>;
  /**
   * The user confirmed "End it there": stop the other copy (only while it is idle) and resume
   * the session here. Rejects with the reason when it refuses or the copy does not close.
   */
  sessionMirrorEnd(id: string, cols?: number, rows?: number): Promise<SessionInfo>;
  /** Save pasted image bytes (`data` is base64) to a private file and return its absolute path. */
  pasteImage(id: string, data: string, mediaType: string): Promise<{ path: string }>;
  sessionResize(id: string, cols: number, rows: number): Promise<void>;
  sessionKill(id: string): Promise<void>;
  sessionList(): Promise<SessionInfo[]>;
  /** Restart an exited DM. Claude DMs run `claude --resume <stored session id>`. */
  sessionResume(
    id: string,
    cols?: number,
    rows?: number,
    opts?: OpenOptions,
  ): Promise<void | CheckFailed>;
  sessionRename(id: string, name: string): Promise<void>;
  /** Kill and forget the DM. */
  sessionDelete(id: string): Promise<void>;
  /** Move a DM to a stored section, or to the default group with null. */
  sessionSetSection(id: string, sectionId: string | null): Promise<void>;
  sectionList(): Promise<SectionInfo[]>;
  /** `kind` defaults to a section. A divider may have an empty name (a rule with no label). */
  sectionCreate(
    name: string,
    opts?: { kind?: SectionKind; emoji?: string | null },
  ): Promise<{ id: string }>;
  /** With `flavor` the pair is stored as one `{char, flavor}`. */
  sectionSetEmoji(id: string, emoji: string | null, flavor?: EmojiFlavor): Promise<void>;
  /** A session row's emoji as `{char, flavor}`; null clears it. */
  sessionSetEmoji(id: string, emoji: string | null, flavor?: EmojiFlavor): Promise<void>;
  /** After a confirmed `/model` switch: the DM resumes on this model. */
  sessionSetModel(id: string, model: string): Promise<void>;
  /** The signed catalog fetched earlier (verified again), or null. */
  catalogGet(): Promise<ModelCatalog | null>;
  /** Download and verify the signed catalog. Rejects while the setting is off. */
  catalogRefresh(): Promise<ModelCatalog>;
  /** Is a newer Patchroom published? Rejects while the setting is off. */
  updateCheck(): Promise<UpdateInfo>;
  /** Remember the DMs to reopen, then quit and relaunch. */
  appRestart(ids: string[]): Promise<void>;
  /** The DMs the last restart asked to reopen, once. */
  appRestartPending(): Promise<string[]>;
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

  // ---- P3 Slack layer --------------------------------------------------------------------
  sectionRename(id: string, name: string): Promise<void>;
  /** The section's DMs fall back to the default Direct messages group. */
  sectionDelete(id: string): Promise<void>;
  sectionReorder(ids: string[]): Promise<void>;
  /** Move a DM into `sectionId` (null: Direct messages) and set the group's order, in one call. */
  sessionReorder(sectionId: string | null, ids: string[]): Promise<void>;
  sessionSetFlags(id: string, flags: { starred?: boolean; archived?: boolean }): Promise<void>;
  draftGet(id: string): Promise<{ body: string }>;
  /** An empty body deletes the draft. */
  draftSet(id: string, body: string): Promise<void>;
  markAdd(id: string, itemKey: string, kind: MarkKind, emoji?: string): Promise<MarkInfo>;
  markRemove(id: string, itemKey: string, kind: MarkKind, emoji?: string): Promise<void>;
  /** No `id`: marks across every DM. */
  markList(args?: { id?: string; kind?: MarkKind }): Promise<MarkInfo[]>;
  search(args: { query: string; scope?: { id?: string }; limit?: number }): Promise<SearchResult>;
  searchReindex(): Promise<{ docs: number; tookMs: number }>;
  /** A `chat_history` cursor whose page holds the item. `before: null` means the newest page. */
  chatLocate(id: string, itemKey: string): Promise<{ before: string | null }>;
  activityList(): Promise<ActivityRow[]>;
  prefsGet(): Promise<Prefs>;
  prefsSet(patch: Partial<Prefs>): Promise<Prefs>;
  soundHooksDetect(): Promise<DetectedHook[]>;
  notifyTest(): Promise<void>;
  /** Sound packs (the SOUND-PACKS build bar). */
  soundPacks(): Promise<PackInfo[]>;
  soundFile(packId: string, event: string): Promise<SoundFileData>;
  soundCustomList(): Promise<ImportedFile[]>;
  soundCustomFile(id: string): Promise<SoundFileData>;
  /** Native file picker for the user's own sound. Resolves null when cancelled. */
  soundPickFile(): Promise<string | null>;
  soundImportFile(path: string): Promise<ImportedFile>;
  soundCustomRemove(id: string): Promise<void>;
  soundClaudeProfiles(): Promise<ClaudeProfile[]>;
  soundImportClaudeProfile(id: string): Promise<{ packId: string }>;
  /** Theme import: the looks the user's installed tools offer. Read only. */
  themeImportDetect(): Promise<ImportSource[]>;
  /** Theme import: pick an `.itermcolors` file and read it. Null when cancelled. */
  themeImportFile(): Promise<ImportEntry | null>;
  /** Installed font families from Core Text, read only. */
  fontsList(): Promise<FontOption[]>;
  /** The DM the user is looking at (null: none), so it does not notify while focused. */
  sessionFocus(id: string | null): Promise<void>;
  /** P3 folder sections. */
  sectionCreateFromFolder(path: string, name?: string): Promise<{ id: string }>;
  sectionSetArchiveDays(id: string, days: number): Promise<void>;
  folderSessions(sectionId: string): Promise<FolderSessions>;
  /** Creates the DM row and spawns `claude --resume` from the session's launch folder. */
  folderSessionOpen(
    sectionId: string,
    sessionId: string,
    opts?: OpenOptions,
  ): Promise<SessionInfo | CheckFailed>;
  /** Hides or unhides a row in the list only; the transcript is never touched. */
  folderSessionHide(sectionId: string, sessionId: string, hidden: boolean): Promise<void>;
  /** Start one on-device dictation run; events arrive as `dictation:event`. */
  dictationStart(locale: string, silenceSecs: number): Promise<{ sid: number }>;
  /** Ask run `sid` for its final text and end it. */
  dictationStop(sid: number): Promise<void>;
  dictationLocales(): Promise<DictationLocales>;
  /** Open the System Settings pane that fixes a dictation problem. */
  dictationOpenSettings(pane: SettingsPane): Promise<void>;
  /** Every resumable session across all folders. Read only. */
  historySessions(): Promise<HistorySessions>;
  /** Open a History row: the open DM, or a new one resumed (or mirrored) in its folder. */
  historySessionOpen(sessionId: string, opts?: OpenOptions): Promise<SessionInfo | CheckFailed>;
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
  /** Cancelled (Esc) before Claude replied or used a tool. Omitted when false. */
  cancelled?: boolean;
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
  /** The model id the CLI reports (`claude-opus-5-5`), for confirming a switch. */
  modelId?: string;
  /** The CLI talks to a local API (its base URL is localhost or 127.0.0.1). */
  apiLocal?: boolean;
  branch?: string;
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

// ---------------------------------------------------------------------------------------------
// P3 Slack layer (the P3 build bar). camelCase JSON.
// ---------------------------------------------------------------------------------------------

export type MarkKind = 'pin' | 'saved' | 'reaction';

/** A pin, saved item or reaction on one chat item, anchored by `(conversationId, itemKey)`. */
export interface MarkInfo {
  id: string;
  conversationId: string;
  itemKey: string;
  kind: MarkKind;
  emoji?: string | null;
  /** Up to 280 chars of the item's text, for lists. */
  snapshot: string;
  createdAt?: Timestamp;
}

export interface SearchHit {
  id: string;
  itemKey: string;
  ts: Timestamp;
  kind: string;
  snippet: string;
  /** `[start, end)` offsets into `snippet`. */
  ranges: [number, number][];
}
export interface SearchResult {
  hits: SearchHit[];
  tookMs: number;
}

export interface ActivityRow {
  id: string;
  kind: 'prompt' | 'unread';
  ts: Timestamp;
  promptId?: string;
  itemKey?: string;
  summary: string;
}

export type NotifyLevel = 'all' | 'needs' | 'mute';
export type NotifyEventName = 'needs' | 'done' | 'message' | 'error' | 'bell' | 'session';
export type SoundEventName = 'needs' | 'done' | 'message' | 'error';

export type {
  ClaudeProfile,
  DmSoundPref,
  ImportedFile,
  MixChoice,
  PackInfo,
  SoundFileData,
} from '../components/prefs/ipc.ts';

export interface Prefs {
  themeId: string;
  mode: 'light' | 'dark' | 'system';
  customThemes: Theme[];
  /** Layout base: `homeroom` or `patchbay`. */
  base: 'homeroom' | 'patchbay' | 'scrollback' | 'bluepencil';
  /** Patch Bay cable and plug preset id, or `theme` for the theme's own tokens. */
  cablePreset: string;
  notify: { default: NotifyLevel; perDm: Record<string, NotifyLevel> };
  sound: {
    enabled: boolean;
    volume: number;
    perEvent: Record<string, { on: boolean; sound: string }>;
    /** Per event: a pack's sound, the user's own file or off. */
    mix: Record<string, MixChoice>;
    perDm: Record<string, DmSoundPref>;
    hookPolicy: Record<string, 'keep' | 'both'>;
  };
  dnd: {
    manual: boolean;
    schedule: { days: number[]; start: string; end: string } | null;
  };
  termPerDm: Record<string, { themeId?: string; font?: string; fontSize?: number }>;
  searchAllSessions: boolean;
  /** Sidebar width in px, 220 to 420. Missing in older blobs: 264. */
  sidebarWidth: number;
  /** Status strip layout. Absent: the built-in default with duplicates hidden. */
  statusBar?: StatusBarPrefs;
  /** Where a plain click opens a link. Absent in older blobs: the in-app viewer. */
  links?: { open: 'patchroom' | 'browser' };
  /** Pin claude.ai artifacts automatically (once each; an unpin sticks). Absent: on. */
  artifacts?: { autoPin: boolean };
  /** First-time hints already shown. Absent: none. */
  hints?: { seen: string[] };
  /** Terminal palettes imported from other tools. Absent in older blobs: none. */
  termPalettes?: unknown[];
  /** Model bundles, overrides and labels. Absent in older blobs: none. */
  models?: ModelPrefs;
  /** Opt-in network checks. Absent: both off. */
  updates?: UpdatePrefs;
  /** How emoji in chat are drawn. Absent: apple. */
  emoji?: { chat: EmojiFlavor };
  /**
   * Chat view. Absent: logs follow new messages, and the draft stays in chat on a switch to the
   * terminal (`carryDraft` on: it is typed into claude's input, unsent).
   */
  chat?: { autoScroll: boolean; carryDraft?: boolean; upHistory?: boolean };
  /** Fonts per area, and the chat font per section or session. Absent: base defaults. */
  fonts?: FontPrefs;
  /** On-device dictation in the composer. Absent: on, system language, Cmd+Shift+D, 8s. */
  dictation?: DictationPrefs;
  /** The History panel's grouping, remembered from its header toggle. Absent: folder. */
  history?: { groupBy: HistoryGroup };
}

/** Tools a bundle entry can name. */
export type ToolId = 'claude-code' | 'codex' | 'cursor' | 'gemini' | 'opencode';

export interface BundleEntry {
  id: string;
  tool: ToolId;
  /** A catalog id, free text, or `latest:<family>`. */
  model: string;
}

export interface ModelBundle {
  id: string;
  name: string;
  emoji?: string | null;
  entries: BundleEntry[];
  defaultEntry: string;
}

export type ModelPlace = 'cloud' | 'local';

export interface ModelLabel {
  text?: string;
  emoji?: string;
  place?: ModelPlace;
}

export interface ModelPrefs {
  bundles: ModelBundle[];
  defaultBundle?: string | null;
  perFolder: Record<string, string>;
  perSection: Record<string, string>;
  perSession: Record<string, string>;
  labels: Record<string, ModelLabel>;
  groupLabels: { cloud: string; local: string };
  /** Model ids the chip has shown (the label hint asks once per model). */
  seen: string[];
  /** Newer model ids already offered with Swap or Keep. */
  offered: string[];
}

export interface UpdatePrefs {
  checkApp: boolean;
  checkModels: boolean;
  /** "Want to check for newer models?" was answered. */
  askedModels: boolean;
}

export interface CatalogModel {
  id: string;
  tool: ToolId | (string & {});
  name: string;
  family: string;
  /** Dotted version within the family ("5.5"); higher is newer. */
  version?: string;
  released?: string;
  where?: ModelPlace;
}

export interface ModelCatalog {
  schema: 1;
  generated: string;
  tools: { id: string; name: string; providers?: string[] }[];
  models: CatalogModel[];
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  url: string | null;
  newer: boolean;
}

/** Ids of the status strip modules, in the order the built-in default shows them. */
export type StatusModuleId =
  'model' | 'folder' | 'worktree' | 'context' | 'cost' | 'mode' | 'branch' | 'pr' | 'statusline';

/**
 * Enabled modules in display order. A module missing from the list is removed (it sits in the
 * tray). `default` is null until the user customizes it; `perDm` overrides it for one DM.
 */
export interface StatusBarPrefs {
  default: string[] | null;
  perDm: Record<string, string[]>;
  /** The user's label per module: text plus an emoji. */
  labels?: Record<string, ModuleLabel>;
  /** Options of the built-in modules: module id to option to value (`statusBar.ts`). */
  options?: Record<string, Record<string, string>>;
}

export interface ModuleLabel {
  text?: string;
  emoji?: string;
}

export interface DetectedHook {
  event: string;
  command: string;
  source: string;
  path?: string;
  /** The wrapper script that plays the sound, as the command names it. Absent: inline. */
  script?: string | null;
  /** The hook already tests `PATCHROOM_SESSION`, so it is quiet in Patchroom sessions. */
  guarded?: boolean;
}

export interface NotifyFireEvent {
  id: string;
  event: NotifyEventName;
  title: string;
  body: string;
}
export interface PrefsChangedEvent {
  prefs: Prefs;
}

// ---------------------------------------------------------------------------------------------
// P3 folder sections (the P3-FOLDER-SECTIONS build bar). camelCase JSON.
// ---------------------------------------------------------------------------------------------

/** Where a session's name came from, first match wins in this order. */
export type NameSource = 'user' | 'registry' | 'custom-title' | 'ai-title' | 'prompt';

/** One resumable Claude Code session found under a folder section's home folder. */
export interface FolderSession {
  sessionId: string;
  name: string;
  nameSource: NameSource | (string & {});
  /** The folder the session was launched from (where its transcript is filed). */
  launchCwd: string;
  /** Path of `launchCwd` inside the home folder; empty for the home folder itself. */
  relPath: string;
  branch?: string | null;
  /** The branch currently checked out in the section's home folder (read only). */
  folderBranch?: string | null;
  /** Newest transcript timestamp. */
  lastActivity: Timestamp;
  firstPrompt: string;
  lastPrompt: string;
  userTurns: number;
  /** `claude agents --json` shows it running in another terminal. */
  liveElsewhere: boolean;
  /** `checking` until the first live answer, and again when it is stale. Never "free" from a guess. */
  liveState?: 'checking' | 'live' | 'free';
  /** Noise (no real user prompt, sidechain) or hidden by the user. */
  hidden: boolean;
  /** The Patchroom DM this session was opened as, once opened. */
  dmId?: string | null;
}

export interface FolderSessions {
  sessions: FolderSession[];
  hiddenCount: number;
}

// ---------------------------------------------------------------------------------------------
// History panel: every Claude Code session across all folders (read only). camelCase JSON.
// ---------------------------------------------------------------------------------------------

/** Where a History title came from: Claude's own title, else the first prompt. */
export type TitleSource = 'custom-title' | 'ai-title' | 'prompt';

/** One session in the History panel. Only the title and the first prompt leave the backend. */
export interface HistorySession {
  sessionId: string;
  title: string;
  titleSource: TitleSource | (string & {});
  firstPrompt: string;
  /** Where `--resume` runs. */
  launchCwd: string;
  /** The project folder it groups under (a Claude worktree groups under its project). */
  folder: string;
  branch?: string | null;
  /** Newest model id the transcript reports. */
  model?: string | null;
  lastActivity: Timestamp;
  userTurns: number;
  /** The Patchroom DM this session was opened as. */
  dmId?: string | null;
  liveState: 'checking' | 'live' | 'free';
}

export interface HistorySessions {
  sessions: HistorySession[];
  /** Transcripts left out: subagent runs, `-p` runs and sessions with no prompt. */
  skipped: number;
}

/** How the History panel groups sessions. Stored in prefs (`history.groupBy`). */
export type HistoryGroup = 'folder' | 'date' | 'model' | 'branch';

export interface FolderChangedEvent {
  sectionId: string;
}

/** Where the in-app viewer sits, in CSS pixels of the main window. */
export interface ViewerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
