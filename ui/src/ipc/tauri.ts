import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Ipc, SectionInfo, SessionInfo } from './types';

/** `session_list` row exactly as the backend serializes it (snake_case). */
interface WireSession extends Omit<SessionInfo, 'sectionId'> {
  section_id?: string | null;
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
    sessionResize: (id, cols, rows) => invoke('session_resize', { id, cols, rows }),
    sessionKill: (id) => invoke('session_kill', { id }),
    async sessionList() {
      const rows = await invoke<WireSession[]>('session_list');
      return rows.map(({ section_id, ...rest }) => ({ ...rest, sectionId: section_id ?? null }));
    },
    sessionResume: (id, cols, rows) => invoke('session_resume', { id, cols, rows }),
    sessionRename: (id, name) => invoke('session_rename', { id, name }),
    sessionDelete: (id) => invoke('session_delete', { id }),
    sessionSetSection: (id, sectionId) => invoke('session_set_section', { id, sectionId }),
    sectionList: () => invoke<SectionInfo[]>('section_list'),
    sectionCreate: (name) => invoke('section_create', { name }),
    sectionSetCollapsed: (id, collapsed) => invoke('section_set_collapsed', { id, collapsed }),
    pickFolder: (defaultPath) => invoke<string | null>('pick_folder', { defaultPath }),
    on: (event, handler) => listen(event, (e) => handler(e.payload as never)),
  };
}
