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
/** Declared by the backend beyond the fixed contract; the UI uses them when present. */
const P2_OPTIONAL = ['session_view'];
const P1B_EVENTS = ['pty:exit', 'pty:output', 'session:status', 'session:title'];
const P2_EVENTS = [
  'chat:items',
  'prompt:pending',
  'prompt:resolved',
  'session:badges',
  'statusline:update',
];

/**
 * Backend and frontend build in parallel against this contract. Once the backend declares any P2
 * command or event, all of them must be there. CI and PR_REQUIRE_P2=1 always demand them.
 */
const requireP2 = (declared: string[], p2: string[]) =>
  !!process.env.CI || process.env.PR_REQUIRE_P2 === '1' || p2.some((c) => declared.includes(c));

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
  return [...src.matchAll(/=>\s*"([a-z]+:[a-z]+)"/g)].map((m) => m[1]);
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
        if (cmd === 'chat_history') return { items: [], hasMore: false };
        if (cmd === 'chat_thread') return { items: [] };
        if (cmd === 'chat_image') return { dataUrl: 'data:,' };
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
  await ipc.sessionSendText('i', 't');
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
    const known = new Set([...P1B_COMMANDS, ...P2_COMMANDS, ...P2_OPTIONAL]);
    expect(declared.filter((c) => !known.has(c))).toEqual([]);
  });

  test('every invoke names a declared command with declared argument keys', async () => {
    const declared = declaredCommands();
    const calls = await recordTauriCalls();
    const names = [...declared.keys()];
    const mustExist = requireP2(names, P2_COMMANDS);
    for (const { cmd, args } of calls) {
      const d = declared.get(cmd);
      if (!d) {
        // Only a P2 command the backend has not landed yet may be missing.
        const mayBeMissing = (!mustExist && P2_COMMANDS.includes(cmd)) || P2_OPTIONAL.includes(cmd);
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
    // Nothing goes through the ungranted dialog plugin.
    expect(Object.keys(byCmd).some((c) => c.startsWith('plugin:'))).toBe(false);
  });

  test('the store listens to the event names events.rs emits', () => {
    const events = declaredEvents().sort();
    for (const e of P1B_EVENTS) expect(events, `P1b event ${e}`).toContain(e);
    if (requireP2(events, P2_EVENTS)) {
      for (const e of P2_EVENTS) expect(events, `P2 event ${e}`).toContain(e);
    }
    const store = readFileSync(join(here, '..', 'src', 'state', 'store.ts'), 'utf8');
    // The UI subscribes to every event of the contract, declared yet or not.
    for (const e of [...P1B_EVENTS, ...P2_EVENTS]) {
      expect(store, `store.ts subscribes to ${e}`).toContain(`'${e}'`);
    }
    for (const e of events) expect([...P1B_EVENTS, ...P2_EVENTS]).toContain(e);
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
