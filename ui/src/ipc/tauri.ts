import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ActivityRow,
  Ipc,
  Prefs,
  MarkInfo,
  SearchHit,
  FolderSession,
  FolderSessions,
  SearchResult,
  SectionInfo,
  MirrorInfo,
  SendOutcome,
  SendResult,
  SessionInfo,
} from './types';

/** `session_list` row exactly as the backend serializes it (snake_case). */
interface WireSession extends Omit<SessionInfo, 'sectionId'> {
  section_id?: string | null;
  needs_you?: number | boolean;
  has_draft?: boolean;
  folder_chip?: string | null;
}

/** Backend rows may spell fields camelCase (the contract) or snake_case (serde default). */
type Loose = Record<string, unknown>;
const pick = <T>(o: Loose, camel: string, snake: string): T | undefined =>
  (o[camel] ?? o[snake]) as T | undefined;

function mark(r: Loose): MarkInfo {
  return {
    id: String(r.id),
    conversationId: String(pick(r, 'conversationId', 'conversation_id') ?? ''),
    itemKey: String(pick(r, 'itemKey', 'item_key') ?? ''),
    kind: r.kind as MarkInfo['kind'],
    emoji: (r.emoji as string | null | undefined) ?? null,
    snapshot: String(r.snapshot ?? ''),
    createdAt: pick(r, 'createdAt', 'created_at'),
  };
}
function section(r: Loose): SectionInfo {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    position: Number(r.position ?? 0),
    collapsed: Boolean(r.collapsed),
    folder: (r.folder as string | null | undefined) ?? null,
    archiveDays: Number(pick(r, 'archiveDays', 'archive_days') ?? 14),
  };
}
function folderSession(r: Loose): FolderSession {
  return {
    sessionId: String(pick(r, 'sessionId', 'session_id') ?? ''),
    name: String(r.name ?? ''),
    nameSource: String(pick(r, 'nameSource', 'name_source') ?? 'prompt'),
    launchCwd: String(pick(r, 'launchCwd', 'launch_cwd') ?? ''),
    relPath: String(pick(r, 'relPath', 'rel_path') ?? ''),
    branch: (r.branch as string | null | undefined) ?? null,
    lastActivity: pick(r, 'lastActivity', 'last_activity') as FolderSession['lastActivity'],
    firstPrompt: String(pick(r, 'firstPrompt', 'first_prompt') ?? ''),
    lastPrompt: String(pick(r, 'lastPrompt', 'last_prompt') ?? ''),
    userTurns: Number(pick(r, 'userTurns', 'user_turns') ?? 0),
    liveElsewhere: Boolean(pick(r, 'liveElsewhere', 'live_elsewhere')),
    liveState: pick<FolderSession['liveState']>(r, 'liveState', 'live_state'),
    hidden: Boolean(r.hidden),
    dmId: pick<string | null>(r, 'dmId', 'dm_id') ?? null,
  };
}
const OUTCOMES: SendOutcome[] = ['sent', 'queued', 'blocked_dialog', 'mirror_readonly'];
function sendResult(r: Loose): SendResult {
  const o = String(r.outcome) as SendOutcome;
  return {
    outcome: OUTCOMES.includes(o) ? o : 'sent',
    reason: r.reason as string | undefined,
    where: r.where as string | undefined,
    pid: r.pid as number | undefined,
  };
}
function mirror(v: unknown): MirrorInfo | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Loose;
  return {
    where: r.where as string | undefined,
    pid: r.pid as number | undefined,
    takeoverWhenClosed: Boolean(pick(r, 'takeoverWhenClosed', 'takeover_when_closed')),
  };
}

/** A `session_list` or `folder_session_open` row, camelCase. */
function wireSession(r: WireSession): SessionInfo {
  const { section_id, needs_you, has_draft, folder_chip, ...rest } = r;
  return {
    ...rest,
    sectionId: section_id ?? null,
    needsYou: rest.needsYou ?? needs_you,
    hasDraft: rest.hasDraft ?? has_draft,
    folderChip: rest.folderChip ?? folder_chip ?? null,
    mirror: mirror(rest.mirror),
    terminalWait: rest.terminalWait ?? null,
  };
}
function hit(r: Loose): SearchHit {
  return {
    id: String(r.id),
    itemKey: String(pick(r, 'itemKey', 'item_key') ?? ''),
    ts: r.ts as SearchHit['ts'],
    kind: String(r.kind ?? ''),
    snippet: String(r.snippet ?? ''),
    ranges: (r.ranges as [number, number][] | undefined) ?? [],
  };
}
function activity(r: Loose): ActivityRow {
  return {
    id: String(r.id),
    kind: r.kind as ActivityRow['kind'],
    ts: r.ts as ActivityRow['ts'],
    promptId: pick(r, 'promptId', 'prompt_id'),
    itemKey: pick(r, 'itemKey', 'item_key'),
    summary: String(r.summary ?? ''),
  };
}

/**
 * Real backend. Command names are the Rust function names in `src-tauri/src/commands.rs`.
 * Argument keys are the Rust parameter names in camelCase, which Tauri maps back to snake_case.
 * `tests/ipc-contract.spec.ts` checks every call here against what commands.rs declares.
 */
export function createTauriIpc(): Ipc {
  return {
    sessionCreate: (args) => invoke('session_create', { ...args }),
    sessionWrite: (id, data) => invoke('session_write', { id, data }),
    sessionSendText: async (id, text) => {
      const r = await invoke<Loose | null>('session_send_text', { id, text });
      return r && typeof r.outcome === 'string' ? sendResult(r) : undefined;
    },
    sessionTakeover: async (id, cols, rows) =>
      wireSession(await invoke<WireSession>('session_takeover', { id, cols, rows })),
    sessionMirrorTakeoverWhenClosed: (id, enabled) =>
      invoke('session_mirror_takeover_when_closed', { id, enabled }),
    pasteImage: (id, data, mediaType) =>
      invoke<{ path: string }>('paste_image', { id, data, mediaType }),
    sessionResize: (id, cols, rows) => invoke('session_resize', { id, cols, rows }),
    sessionKill: (id) => invoke('session_kill', { id }),
    async sessionList() {
      const rows = await invoke<WireSession[]>('session_list');
      return rows.map(wireSession);
    },
    sessionResume: (id, cols, rows) => invoke('session_resume', { id, cols, rows }),
    sessionRename: (id, name) => invoke('session_rename', { id, name }),
    sessionDelete: (id) => invoke('session_delete', { id }),
    sessionSetSection: (id, sectionId) => invoke('session_set_section', { id, sectionId }),
    sectionList: async () => (await invoke<Loose[]>('section_list')).map(section),
    sectionCreate: (name) => invoke('section_create', { name }),
    sectionSetCollapsed: (id, collapsed) => invoke('section_set_collapsed', { id, collapsed }),
    pickFolder: (defaultPath) => invoke<string | null>('pick_folder', { defaultPath }),
    chatHistory: (id, before, limit) => invoke('chat_history', { id, before, limit }),
    chatThread: (id, toolUseId) => invoke('chat_thread', { id, toolUseId }),
    chatImage: (id, ref) => invoke('chat_image', { id, ref }),
    promptAnswer: (id, promptId, answer) => invoke('prompt_answer', { id, promptId, answer }),
    promptList: (id) => invoke('prompt_list', { id }),
    sessionMarkRead: (id) => invoke('session_mark_read', { id }),
    statuslineCycleMode: (id) => invoke('statusline_cycle_mode', { id }),
    sessionView: (id, view) => invoke('session_view', { id, view }),
    sectionRename: (id, name) => invoke('section_rename', { id, name }),
    sectionDelete: (id) => invoke('section_delete', { id }),
    sectionReorder: (ids) => invoke('section_reorder', { ids }),
    sessionReorder: (sectionId, ids) => invoke('session_reorder', { sectionId, ids }),
    sessionSetFlags: (id, flags) => invoke('session_set_flags', { id, ...flags }),
    draftGet: (id) => invoke('draft_get', { id }),
    draftSet: (id, body) => invoke('draft_set', { id, body }),
    markAdd: async (id, itemKey, kind, emoji) =>
      mark(await invoke<Loose>('mark_add', { id, itemKey, kind, emoji })),
    markRemove: (id, itemKey, kind, emoji) => invoke('mark_remove', { id, itemKey, kind, emoji }),
    markList: async (args = {}) =>
      (await invoke<Loose[]>('mark_list', { id: args.id, kind: args.kind })).map(mark),
    search: async ({ query, scope, limit }) => {
      const r = await invoke<Loose>('search', { query, scope, limit });
      return {
        hits: ((r.hits as Loose[] | undefined) ?? []).map(hit),
        tookMs: Number(pick(r, 'tookMs', 'took_ms') ?? 0),
      } satisfies SearchResult;
    },
    searchReindex: async () => {
      const r = await invoke<Loose>('search_reindex', {});
      return { docs: Number(r.docs ?? 0), tookMs: Number(pick(r, 'tookMs', 'took_ms') ?? 0) };
    },
    chatLocate: async (id, itemKey) => {
      const r = await invoke<{ before: string | null }>('chat_locate', { id, itemKey });
      return { before: r.before ?? null };
    },
    activityList: async () => (await invoke<Loose[]>('activity_list', {})).map(activity),
    prefsGet: () => invoke<Prefs>('prefs_get', {}),
    prefsSet: (patch) => invoke<Prefs>('prefs_set', { patch }),
    soundHooksDetect: () => invoke('sound_hooks_detect', {}),
    notifyTest: () => invoke('notify_test', {}),
    sessionFocus: (id) => invoke('session_focus', { id }),
    sectionCreateFromFolder: (path, name) =>
      invoke<{ id: string }>('section_create_from_folder', { path, name }),
    sectionSetArchiveDays: (id, days) => invoke('section_set_archive_days', { id, days }),
    folderSessions: async (sectionId) => {
      const r = await invoke<Loose>('folder_sessions', { sectionId });
      return {
        sessions: ((r.sessions as Loose[] | undefined) ?? []).map(folderSession),
        hiddenCount: Number(pick(r, 'hiddenCount', 'hidden_count') ?? 0),
      } satisfies FolderSessions;
    },
    folderSessionOpen: async (sectionId, sessionId) =>
      wireSession(await invoke<WireSession>('folder_session_open', { sectionId, sessionId })),
    folderSessionHide: (sectionId, sessionId, hidden) =>
      invoke('folder_session_hide', { sectionId, sessionId, hidden }),
    on: (event, handler) => listen(event, (e) => handler(e.payload as never)),
  };
}
