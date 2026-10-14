import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract test: every command the real Tauri ipc module sends must exist in
// src-tauri/src/commands.rs with the argument names it declares. The Rust file is parsed, not
// mirrored, so a rename or a new required argument on the backend fails here.

const here = dirname(fileURLToPath(import.meta.url));
const RUST = join(here, '..', '..', 'src-tauri', 'src');
const CLAUDE_CRATE = join(here, '..', '..', 'crates', 'patchroom-claude', 'src');

const P1B_COMMANDS = [
  'pick_folder',
  'section_create',
  'section_list',
  'section_set_collapsed',
  'session_create',
  'session_delete',
  'session_kill',
  'session_list',
  'session_rename',
  'session_resize',
  'session_resume',
  'session_send_text',
  'session_set_section',
  'session_write',
];
/** The P2 additions to the fixed IPC contract (docs/gauntlet/P2-BAR.md). */
const P2_COMMANDS = [
  'chat_history',
  'chat_image',
  'chat_thread',
  'paste_image',
  'prompt_answer',
  'prompt_list',
  'session_mark_read',
  'statusline_cycle_mode',
];
/** The P3 additions to the fixed IPC contract (docs/gauntlet/P3-BAR.md). */
const P3_COMMANDS = [
  'activity_list',
  'chat_locate',
  'draft_get',
  'draft_set',
  'mark_add',
  'mark_list',
  'mark_remove',
  'notify_test',
  'prefs_get',
  'prefs_set',
  'search',
  'search_reindex',
  'section_delete',
  'section_rename',
  'section_reorder',
  'session_reorder',
  'session_set_flags',
  'sound_hooks_detect',
];
/** The folder-section additions (docs/gauntlet/P3-FOLDER-SECTIONS.md). */
const FOLDER_COMMANDS = [
  'folder_session_hide',
  'folder_session_open',
  'folder_sessions',
  'section_create_from_folder',
  'section_set_archive_days',
];
/** Session parity additions (docs/gauntlet/SESSION-PARITY-BAR.md, Contract: backend). */
const PARITY_COMMANDS = ['session_mirror_takeover_when_closed', 'session_takeover'];
/** Declared by the backend beyond the fixed contract; the UI uses them when present. */
const P2_OPTIONAL = ['session_view', 'session_focus'];
const P1B_EVENTS = ['pty:exit', 'pty:output', 'session:status', 'session:title'];
const P2_EVENTS = [
  'chat:items',
  'prompt:pending',
  'prompt:resolved',
  'session:badges',
  'statusline:update',
];
const P3_EVENTS = ['activity:changed', 'notify:fire', 'prefs:changed'];
/** Declared beyond the fixed contract: a click on a native notification opens its DM. */
const P3_OPTIONAL_EVENTS = ['notify:open'];
/** Folder sections: the filesystem watch tells the UI a section's listing changed. */
const FOLDER_EVENTS = ['folder:changed'];
/** Session parity: mirror state and terminal-only waits. */
const PARITY_EVENTS = ['session:mirror', 'session:terminal_wait', 'session:terminal_wait_clear'];

/**
 * Backend and frontend build in parallel against this contract. Once the backend declares any P2
 * command or event, all of them must be there. CI and PR_REQUIRE_P2=1 always demand them.
 */
const requireP2 = (declared: string[], p2: string[]) =>
  !!process.env.CI || process.env.PR_REQUIRE_P2 === '1' || p2.some((c) => declared.includes(c));
const requireFolder = (declared: string[], names: string[]) =>
  !!process.env.CI || process.env.PR_REQUIRE_P3 === '1' || names.some((c) => declared.includes(c));
const requireParity = (declared: string[], names: string[]) =>
  !!process.env.CI || process.env.PR_REQUIRE_P3 === '1' || names.some((c) => declared.includes(c));
const requireP3 = (declared: string[], p3: string[]) =>
  !!process.env.CI || process.env.PR_REQUIRE_P3 === '1' || p3.some((c) => declared.includes(c));

interface Declared {
  /** camelCase argument names Tauri expects, as written by the frontend. */
  args: Map<string, { optional: boolean }>;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** `#[tauri::command] pub async fn name(params...)` blocks from commands.rs. */
function declaredCommands(): Map<string, Declared> {
  const src = readFileSync(join(RUST, 'commands.rs'), 'utf8');
  const out = new Map<string, Declared>();
  const rx = /#\[tauri::command\]\s*pub\s+async\s+fn\s+(\w+)\s*\(([\s\S]*?)\)\s*->/g;
  for (const m of src.matchAll(rx)) {
    const args = new Map<string, { optional: boolean }>();
    // Split on commas that are not inside <...> generics.
    const params: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of m[2]) {
      if (ch === '<') depth++;
      if (ch === '>') depth--;
      if (ch === ',' && depth === 0) {
        params.push(cur);
        cur = '';
      } else cur += ch;
    }
    params.push(cur);
    for (const p of params) {
      // `r#ref` is how Rust spells a parameter named `ref`.
      const pm = /^\s*(?:r#)?(\w+)\s*:\s*([\s\S]+?)\s*$/.exec(p);
      if (!pm) continue;
      // Injected by Tauri, not sent by the frontend.
      if (/^(State|AppHandle|Window|WebviewWindow)\b/.test(pm[2])) continue;
      args.set(camel(pm[1]), { optional: pm[2].startsWith('Option<') });
    }
    out.set(m[1], { args });
  }
  return out;
}

/** Event names `UiEvent::name` returns in events.rs. */
function declaredEvents(): string[] {
  const src = readFileSync(join(RUST, 'events.rs'), 'utf8');
  return [...src.matchAll(/=>\s*"([a-z]+:[a-z_]+)"/g)].map((m) => m[1]);
}

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

async function recordTauriCalls(): Promise<Call[]> {
  const calls: Call[] = [];
  const listens: string[] = [];
  const g = globalThis as unknown as { window?: unknown };
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        if (cmd === 'session_create' || cmd === 'section_create') return { id: 'x' };
        if (cmd === 'session_list' || cmd === 'section_list') return [];
        if (cmd === 'section_create_from_folder') return { id: 'x' };
        if (cmd === 'folder_sessions')
          return {
            sessions: [
              {
                sessionId: 's1',
                name: 'n',
                nameSource: 'ai-title',
                launchCwd: '/w',
                relPath: '',
                lastActivity: 1,
                firstPrompt: 'p',
                lastPrompt: 'q',
                userTurns: 2,
                liveElsewhere: false,
                hidden: false,
              },
            ],
            hiddenCount: 0,
          };
        if (cmd === 'folder_session_open')
          return { id: 'd', name: 'n', cwd: '/w', title: '', status: 'busy', section_id: 's' };
        if (cmd === 'session_send_text')
          return { outcome: 'blocked_dialog', reason: 'dialog open' };
        if (cmd === 'session_takeover')
          return { id: 'd', name: 'n', cwd: '/w', title: '', status: 'busy', section_id: null };
        if (cmd === 'chat_history') return { items: [], hasMore: false };
        if (cmd === 'chat_thread') return { items: [] };
        if (cmd === 'chat_image') return { dataUrl: 'data:,' };
        if (cmd === 'draft_get') return { body: '' };
        if (cmd === 'mark_add') return { id: 'm', conversationId: 'i', itemKey: 'k', kind: 'pin' };
        if (cmd === 'mark_list' || cmd === 'activity_list' || cmd === 'sound_hooks_detect')
          return [];
        if (cmd === 'search') return { hits: [], tookMs: 0 };
        if (cmd === 'search_reindex') return { docs: 0, tookMs: 0 };
        if (cmd === 'chat_locate') return { before: null };
        return null;
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
  };
  const { createTauriIpc } = await import('../src/ipc/tauri');
  const ipc = createTauriIpc();
  await ipc.sessionCreate({ cwd: '/w', command: 'claude', args: ['--model', 'haiku'], name: 'n' });
  await ipc.sessionWrite('i', 'AA==');
  const sent = await ipc.sessionSendText('i', 't');
  expect(sent).toMatchObject({ outcome: 'blocked_dialog', reason: 'dialog open' });
  await ipc.pasteImage('i', 'AA==', 'image/png');
  await ipc.sessionResize('i', 80, 24);
  await ipc.sessionKill('i');
  await ipc.sessionList();
  await ipc.sessionResume('i', 80, 24);
  await ipc.sessionRename('i', 'n');
  await ipc.sessionDelete('i');
  await ipc.sessionSetSection('i', 's');
  await ipc.sectionList();
  await ipc.sectionCreate('n');
  await ipc.sectionSetCollapsed('s', true);
  await ipc.pickFolder('/w');
  await ipc.chatHistory('i', 'k', 300);
  await ipc.chatThread('i', 'tu');
  await ipc.chatImage('i', 'r');
  await ipc.promptAnswer('i', 'p', { kind: 'questions', answers: { Q: 'a, b' } });
  await ipc.promptList('i');
  await ipc.sessionMarkRead('i');
  await ipc.statuslineCycleMode('i');
  await ipc.sessionView('i', 'terminal');
  await ipc.sectionRename('s', 'Work');
  await ipc.sectionDelete('s');
  await ipc.sectionReorder(['s', 't']);
  await ipc.sessionReorder('s', ['a', 'b']);
  await ipc.sessionSetFlags('i', { starred: true, archived: false });
  await ipc.draftGet('i');
  await ipc.draftSet('i', 'hello');
  await ipc.markAdd('i', 'k', 'reaction', '\u2705');
  await ipc.markRemove('i', 'k', 'reaction', '\u2705');
  await ipc.markList({ id: 'i', kind: 'pin' });
  await ipc.search({ query: 'bridge', scope: { id: 'i' }, limit: 20 });
  await ipc.searchReindex();
  await ipc.chatLocate('i', 'k');
  await ipc.activityList();
  await ipc.prefsGet();
  await ipc.prefsSet({ themeId: 'patch-bay' });
  await ipc.soundHooksDetect();
  await ipc.notifyTest();
  await ipc.sessionFocus('i');
  await ipc.sectionCreateFromFolder('/w', 'atlas');
  await ipc.sectionSetArchiveDays('s', 30);
  const listing = await ipc.folderSessions('s');
  expect(listing.sessions[0]).toMatchObject({
    sessionId: 's1',
    nameSource: 'ai-title',
    dmId: null,
  });
  const opened = await ipc.folderSessionOpen('s', 'sid');
  expect(opened).toMatchObject({ id: 'd', sectionId: 's', folderChip: null });
  await ipc.folderSessionHide('s', 'sid', true);
  const taken = await ipc.sessionTakeover('i', 80, 24);
  expect(taken).toMatchObject({ id: 'd', mirror: null });
  await ipc.sessionMirrorTakeoverWhenClosed('i', true);
  void listens;
  return calls;
}

test.describe('ipc contract with src-tauri/src/commands.rs', () => {
  test('commands.rs declares the commands the UI relies on', () => {
    const declared = [...declaredCommands().keys()];
    for (const c of P1B_COMMANDS) expect(declared, `P1b command ${c}`).toContain(c);
    if (requireP2(declared, P2_COMMANDS)) {
      for (const c of P2_COMMANDS) expect(declared, `P2 command ${c}`).toContain(c);
    }
    // Nothing the UI does not know about.
    if (requireP3(declared, P3_COMMANDS)) {
      for (const c of P3_COMMANDS) expect(declared, `P3 command ${c}`).toContain(c);
    }
    if (requireFolder(declared, FOLDER_COMMANDS)) {
      for (const c of FOLDER_COMMANDS) expect(declared, `folder command ${c}`).toContain(c);
    }
    if (requireParity(declared, PARITY_COMMANDS)) {
      for (const c of PARITY_COMMANDS) expect(declared, `parity command ${c}`).toContain(c);
    }
    const known = new Set([
      ...P1B_COMMANDS,
      ...P2_COMMANDS,
      ...P3_COMMANDS,
      ...FOLDER_COMMANDS,
      ...PARITY_COMMANDS,
      ...P2_OPTIONAL,
    ]);
    expect(declared.filter((c) => !known.has(c))).toEqual([]);
  });

  test('every invoke names a declared command with declared argument keys', async () => {
    const declared = declaredCommands();
    const calls = await recordTauriCalls();
    const names = [...declared.keys()];
    const mustExist = requireP2(names, P2_COMMANDS);
    const mustExist3 = requireP3(names, P3_COMMANDS);
    const mustExistF = requireFolder(names, FOLDER_COMMANDS);
    const mustExistS = requireParity(names, PARITY_COMMANDS);
    for (const { cmd, args } of calls) {
      const d = declared.get(cmd);
      if (!d) {
        // Only a P2 command the backend has not landed yet may be missing.
        const mayBeMissing =
          (!mustExist && P2_COMMANDS.includes(cmd)) ||
          (!mustExist3 && P3_COMMANDS.includes(cmd)) ||
          (!mustExistF && FOLDER_COMMANDS.includes(cmd)) ||
          (!mustExistS && PARITY_COMMANDS.includes(cmd)) ||
          P2_OPTIONAL.includes(cmd);
        expect(mayBeMissing, `${cmd} is declared in commands.rs`).toBe(true);
        continue;
      }
      for (const key of Object.keys(args)) {
        expect(d.args.has(key), `${cmd}: sends "${key}", Rust declares ${[...d.args.keys()]}`).toBe(
          true,
        );
      }
      for (const [key, meta] of d.args) {
        if (!meta.optional) expect(args, `${cmd}: required "${key}" is sent`).toHaveProperty(key);
      }
    }
    // Every declared command is called by the UI.
    for (const c of names)
      expect(
        calls.map((x) => x.cmd),
        `UI calls ${c}`,
      ).toContain(c);
  });

  test('argument shapes the UI sends match the Rust types', async () => {
    const byCmd = Object.fromEntries((await recordTauriCalls()).map((c) => [c.cmd, c.args]));
    expect(byCmd.session_create).toEqual({
      cwd: '/w',
      command: 'claude',
      args: ['--model', 'haiku'],
      name: 'n',
    });
    expect(byCmd.session_write).toEqual({ id: 'i', data: 'AA==' }); // base64 string
    expect(byCmd.session_resize).toEqual({ id: 'i', cols: 80, rows: 24 }); // u16 numbers
    expect(byCmd.session_resume).toEqual({ id: 'i', cols: 80, rows: 24 });
    expect(byCmd.session_set_section).toEqual({ id: 'i', sectionId: 's' });
    expect(byCmd.section_set_collapsed).toEqual({ id: 's', collapsed: true });
    expect(byCmd.pick_folder).toEqual({ defaultPath: '/w' });
    expect(byCmd.chat_history).toEqual({ id: 'i', before: 'k', limit: 300 });
    expect(byCmd.chat_thread).toEqual({ id: 'i', toolUseId: 'tu' });
    expect(byCmd.chat_image).toEqual({ id: 'i', ref: 'r' });
    expect(byCmd.prompt_answer).toEqual({
      id: 'i',
      promptId: 'p',
      answer: { kind: 'questions', answers: { Q: 'a, b' } },
    });
    expect(byCmd.prompt_list).toEqual({ id: 'i' });
    expect(byCmd.session_mark_read).toEqual({ id: 'i' });
    expect(byCmd.statusline_cycle_mode).toEqual({ id: 'i' });
    // P3: arguments are camelCase keys, one per Rust parameter.
    expect(byCmd.section_rename).toEqual({ id: 's', name: 'Work' });
    expect(byCmd.section_delete).toEqual({ id: 's' });
    expect(byCmd.section_reorder).toEqual({ ids: ['s', 't'] });
    expect(byCmd.session_reorder).toEqual({ sectionId: 's', ids: ['a', 'b'] });
    expect(byCmd.session_set_flags).toEqual({ id: 'i', starred: true, archived: false });
    expect(byCmd.draft_get).toEqual({ id: 'i' });
    expect(byCmd.draft_set).toEqual({ id: 'i', body: 'hello' });
    expect(byCmd.mark_add).toEqual({ id: 'i', itemKey: 'k', kind: 'reaction', emoji: '\u2705' });
    expect(byCmd.mark_remove).toEqual({ id: 'i', itemKey: 'k', kind: 'reaction', emoji: '\u2705' });
    expect(byCmd.mark_list).toEqual({ id: 'i', kind: 'pin' });
    expect(byCmd.search).toEqual({ query: 'bridge', scope: { id: 'i' }, limit: 20 });
    expect(byCmd.chat_locate).toEqual({ id: 'i', itemKey: 'k' });
    expect(byCmd.prefs_set).toEqual({ patch: { themeId: 'patch-bay' } });
    expect(byCmd.session_focus).toEqual({ id: 'i' });
    // Folder sections: camelCase keys, `name` optional.
    expect(byCmd.section_create_from_folder).toEqual({ path: '/w', name: 'atlas' });
    expect(byCmd.section_set_archive_days).toEqual({ id: 's', days: 30 });
    expect(byCmd.folder_sessions).toEqual({ sectionId: 's' });
    expect(byCmd.folder_session_open).toEqual({ sectionId: 's', sessionId: 'sid' });
    expect(byCmd.folder_session_hide).toEqual({ sectionId: 's', sessionId: 'sid', hidden: true });
    // Session parity: a mirror is taken over with the terminal grid, or armed with a flag.
    expect(byCmd.session_takeover).toEqual({ id: 'i', cols: 80, rows: 24 });
    expect(byCmd.session_mirror_takeover_when_closed).toEqual({ id: 'i', enabled: true });
    // Nothing goes through the ungranted dialog plugin.
    expect(Object.keys(byCmd).some((c) => c.startsWith('plugin:'))).toBe(false);
  });

  test('the store listens to the event names events.rs emits', () => {
    const events = declaredEvents().sort();
    for (const e of P1B_EVENTS) expect(events, `P1b event ${e}`).toContain(e);
    if (requireP2(events, P2_EVENTS)) {
      for (const e of P2_EVENTS) expect(events, `P2 event ${e}`).toContain(e);
    }
    if (requireFolder(events, FOLDER_EVENTS)) {
      for (const e of FOLDER_EVENTS) expect(events, `folder event ${e}`).toContain(e);
    }
    if (requireP3(events, P3_EVENTS)) {
      for (const e of P3_EVENTS) expect(events, `P3 event ${e}`).toContain(e);
    }
    if (requireParity(events, PARITY_EVENTS)) {
      for (const e of PARITY_EVENTS) expect(events, `parity event ${e}`).toContain(e);
    }
    const store = readFileSync(join(here, '..', 'src', 'state', 'store.ts'), 'utf8');
    // The UI subscribes to every event of the contract, declared yet or not.
    for (const e of [
      ...P1B_EVENTS,
      ...P2_EVENTS,
      ...P3_EVENTS,
      ...P3_OPTIONAL_EVENTS,
      ...FOLDER_EVENTS,
      ...PARITY_EVENTS,
    ]) {
      expect(store, `store.ts subscribes to ${e}`).toContain(`'${e}'`);
    }
    const all = [
      ...P1B_EVENTS,
      ...P2_EVENTS,
      ...P3_EVENTS,
      ...P3_OPTIONAL_EVENTS,
      ...FOLDER_EVENTS,
      ...PARITY_EVENTS,
    ];
    for (const e of events) expect(all).toContain(e);
  });

  test('the TS ChatItem kinds, the synthetic data and the Rust wire format agree', () => {
    const kinds = [
      'assistant',
      'fallback',
      'plan',
      'question',
      'subagent',
      'system',
      'thinking',
      'tool',
      'user',
    ];
    const types = readFileSync(join(here, '..', 'src', 'ipc', 'types.ts'), 'utf8');
    for (const k of kinds) expect(types, `types.ts has kind ${k}`).toContain(`kind: '${k}'`);
    const synthetic = readFileSync(join(here, '..', 'src', 'ipc', 'synthetic.ts'), 'utf8');
    for (const k of kinds)
      expect(synthetic, `synthetic data covers ${k}`).toContain(`kind: '${k}'`);
    const itemRs = join(CLAUDE_CRATE, 'item.rs');
    if (!existsSync(itemRs)) return; // backend not landed in this checkout
    const rust = readFileSync(itemRs, 'utf8');
    const rustKinds = [...rust.matchAll(/=>\s*"(\w+)",/g)]
      .map((m) => m[1])
      .filter((k) => kinds.includes(k));
    expect([...new Set(rustKinds)].sort()).toEqual(kinds);
    // Fields the UI reads, as the backend names them.
    for (const field of [
      'tool_use_id',
      'agent_type',
      'item_count',
      'parent_tool_use_id',
      'is_error',
      'line_type',
      'multi_select',
    ]) {
      expect(rust, `item.rs has ${field}`).toContain(field);
    }
  });
});
