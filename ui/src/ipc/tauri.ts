import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Ipc, SectionInfo, SessionInfo } from './types';

/** `session_list` row exactly as the backend serializes it (snake_case). */
interface WireSession extends Omit<SessionInfo, 'sectionId'> {
  section_id?: string | null;
  needs_you?: number | boolean;
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
    sessionSendText: (id, text) => invoke('session_send_text', { id, text }),
    pasteImage: (id, data, mediaType) =>
      invoke<{ path: string }>('paste_image', { id, data, mediaType }),
    sessionResize: (id, cols, rows) => invoke('session_resize', { id, cols, rows }),
    sessionKill: (id) => invoke('session_kill', { id }),
    async sessionList() {
      const rows = await invoke<WireSession[]>('session_list');
      return rows.map(({ section_id, needs_you, ...rest }) => ({
        ...rest,
        sectionId: section_id ?? null,
        needsYou: rest.needsYou ?? needs_you,
      }));
    },
    sessionResume: (id, cols, rows) => invoke('session_resume', { id, cols, rows }),
    sessionRename: (id, name) => invoke('session_rename', { id, name }),
    sessionDelete: (id) => invoke('session_delete', { id }),
    sessionSetSection: (id, sectionId) => invoke('session_set_section', { id, sectionId }),
    sectionList: () => invoke<SectionInfo[]>('section_list'),
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
    on: (event, handler) => listen(event, (e) => handler(e.payload as never)),
  };
}
