import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract test: every command the real Tauri ipc module sends must exist in
// src-tauri/src/commands.rs with the argument names it declares. The Rust file is parsed, not
// mirrored, so a rename or a new required argument on the backend fails here.

const here = dirname(fileURLToPath(import.meta.url));
const RUST = join(here, '..', '..', 'src-tauri', 'src');

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
      const pm = /^\s*(\w+)\s*:\s*([\s\S]+?)\s*$/.exec(p);
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
  void listens;
  return calls;
}

test.describe('ipc contract with src-tauri/src/commands.rs', () => {
  test('commands.rs declares the commands the UI relies on', () => {
    expect([...declaredCommands().keys()].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  test('every invoke names a declared command with declared argument keys', async () => {
    const declared = declaredCommands();
    const calls = await recordTauriCalls();
    expect(calls.map((c) => c.cmd).sort()).toEqual([...declared.keys()].sort());
    for (const { cmd, args } of calls) {
      const d = declared.get(cmd);
      expect(d, `${cmd} is declared in commands.rs`).toBeTruthy();
      for (const key of Object.keys(args)) {
        expect(
          d!.args.has(key),
          `${cmd}: sends "${key}", Rust declares ${[...d!.args.keys()]}`,
        ).toBe(true);
      }
      for (const [key, meta] of d!.args) {
        if (!meta.optional) expect(args, `${cmd}: required "${key}" is sent`).toHaveProperty(key);
      }
    }
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
    // Nothing goes through the ungranted dialog plugin.
    expect(Object.keys(byCmd).some((c) => c.startsWith('plugin:'))).toBe(false);
  });

  test('the store listens to the event names events.rs emits', () => {
    const events = declaredEvents().sort();
    expect(events).toEqual(['pty:exit', 'pty:output', 'session:status', 'session:title']);
    const store = readFileSync(join(here, '..', 'src', 'state', 'store.ts'), 'utf8');
    for (const e of events) expect(store, `store.ts subscribes to ${e}`).toContain(`'${e}'`);
  });
});
