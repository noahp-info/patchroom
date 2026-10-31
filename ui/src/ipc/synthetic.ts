import type { ChatItem, PromptPendingEvent } from './types';

/**
 * Synthetic chat data for the mock IPC and the tests. Every ChatItem kind and every tool state
 * appears at least once. Nothing here comes from a real transcript.
 */

const T0 = Date.UTC(2026, 9, 13, 14, 40, 0);
const min = (n: number) => T0 + n * 60_000;

const MARKDOWN = `Here is the plan for the **bridge** change.

## What changed

1. \`patchroom-hook\` now forwards the \`PreToolUse\` payload to \`bridge.sock\`.
2. The reply waits up to 30s, then falls through to the TUI dialog.
   - nested bullet with _emphasis_ and a [link](https://example.com/docs)
   - another bullet with ~~strike~~ text
3. Snake_case_names stay intact, and so do file paths like src/lib/a_b_c.ts.

| File | Change | Lines |
| --- | :---: | ---: |
| \`socket.rs\` | timeout | 38 |
| \`hook.rs\` | forward payload | 12 |

> Quoted note: the hook never writes to the user's settings.

\`\`\`rust
async fn serve(&self, mut stream: UnixStream) {
    let req = HookRequest::read(&mut stream).await?; // read one request
    let reply = match timeout(ASK_TIMEOUT, self.route(req)).await {
        Ok(r) => r?,
        Err(_) => Reply::none(),
    };
}
\`\`\`

---

- [x] tests pass
- [ ] docs updated
`;

const EDIT_DIFF = `--- a/src/socket.rs
+++ b/src/socket.rs
@@ -41,4 +41,6 @@ impl Bridge {
     async fn serve(&self) {
-        let reply = self.route(req).await?;
+        let reply = match timeout(ASK_TIMEOUT, self.route(req)).await {
+            Ok(r) => r?,
+        };
         stream.write(reply).await
     }`;

export function syntheticChat(): ChatItem[] {
  return [
    {
      key: 's-sys-1',
      ts: min(0),
      kind: 'system',
      subtype: 'compact_boundary',
      text: 'Conversation compacted',
    },
    {
      key: 's-user-1',
      ts: min(1),
      kind: 'user',
      text: 'Wire the AskUserQuestion hook through the bridge.\nIf no client is attached, return no decision.',
      images: [{ ref: 'img-1', mediaType: 'image/png' }],
    },
    {
      key: 's-think-1',
      ts: min(2),
      kind: 'thinking',
      text: 'The hook must exit 0 with an empty body when no client is attached.',
    },
    { key: 's-asst-1', ts: min(2), kind: 'assistant', text: MARKDOWN },
    {
      key: 's-tool-read',
      ts: min(3),
      kind: 'tool',
      toolUseId: 'tu-read',
      name: 'Read',
      input: { file_path: '/work/crates/bridge/src/socket.rs' },
      state: 'ok',
      result: { text: 'fn main() {}\n', isError: false, truncated: false },
    },
    {
      key: 's-tool-edit',
      ts: min(3),
      kind: 'tool',
      toolUseId: 'tu-edit',
      name: 'Edit',
      input: { file_path: '/work/crates/bridge/src/socket.rs', old_string: 'a', new_string: 'b' },
      state: 'ok',
      result: { text: 'The file has been updated.', isError: false, truncated: false },
      diff: EDIT_DIFF,
    },
    {
      key: 's-tool-write',
      ts: min(4),
      kind: 'tool',
      toolUseId: 'tu-write',
      name: 'Write',
      input: { file_path: '/work/NOTES.md', content: '# Notes\nline two\nline three\n' },
      state: 'ok',
      result: { text: 'File created.', isError: false, truncated: false },
    },
    {
      key: 's-tool-bash',
      ts: min(4),
      kind: 'tool',
      toolUseId: 'tu-bash',
      name: 'Bash',
      input: { command: 'pnpm test --filter bridge', description: 'Run the bridge tests' },
      state: 'ok',
      result: { text: 'PASS  42 tests\n'.repeat(3), isError: false, truncated: true },
    },
    {
      key: 's-tool-err',
      ts: min(5),
      kind: 'tool',
      toolUseId: 'tu-err',
      name: 'Bash',
      input: { command: 'cargo build --release' },
      state: 'error',
      result: { text: 'error[E0432]: unresolved import `foo`', isError: true, truncated: false },
    },
    {
      key: 's-tool-denied',
      ts: min(5),
      kind: 'tool',
      toolUseId: 'tu-denied',
      name: 'Bash',
      input: { command: 'rm -rf build' },
      state: 'denied',
    },
    {
      key: 's-tool-int',
      ts: min(5),
      kind: 'tool',
      toolUseId: 'tu-int',
      name: 'Grep',
      input: { pattern: 'ASK_TIMEOUT', path: 'crates' },
      state: 'interrupted',
    },
    {
      key: 's-tool-run',
      ts: min(6),
      kind: 'tool',
      toolUseId: 'tu-run',
      name: 'mcp__github__list_issues',
      input: { repo: 'acme/patchroom', state: 'open' },
      state: 'running',
    },
    {
      key: 's-tool-pend',
      ts: min(6),
      kind: 'tool',
      toolUseId: 'tu-pend',
      name: 'WebFetch',
      input: { url: 'https://example.com/spec' },
      state: 'pending',
    },
    {
      key: 's-sub-1',
      ts: min(7),
      kind: 'subagent',
      toolUseId: 'tu-sub',
      description: 'race-check',
      agentType: 'Explore',
      itemCount: 3,
      state: 'ok',
    },
    {
      key: 's-q-1',
      ts: min(8),
      kind: 'question',
      toolUseId: 'tu-q-done',
      questions: [
        {
          question: 'Which timeout should the hook use?',
          header: 'Timeout',
          multiSelect: false,
          options: [
            { label: '10 seconds', description: 'Matches the old default.' },
            { label: '30 seconds', description: 'Matches the TUI prompt wait.' },
          ],
        },
      ],
      answers: { 'Which timeout should the hook use?': '30 seconds' },
    },
    {
      key: 's-plan-1',
      ts: min(9),
      kind: 'plan',
      toolUseId: 'tu-plan-done',
      plan: '## Plan\n\n1. Add the timeout\n2. Add a test\n',
      state: 'approved',
    },
    {
      key: 's-sys-2',
      ts: min(10),
      kind: 'system',
      subtype: 'turn_duration',
      text: 'Worked for 2m 14s',
    },
    {
      key: 's-sys-3',
      ts: min(10),
      kind: 'system',
      subtype: 'api_error',
      text: 'API error 529: overloaded. Retrying.',
    },
    {
      key: 's-fb-1',
      ts: min(11),
      kind: 'fallback',
      lineType: 'worktree-state',
      summary: 'worktree-state line with an unrecognized shape',
    },
    {
      key: 's-asst-2',
      ts: min(12),
      kind: 'assistant',
      text: 'Done. The tests pass and the hook falls through cleanly.',
    },
  ];
}

/** Children of the `tu-sub` subagent, as `chat_thread` returns them. */
export function syntheticThread(): ChatItem[] {
  return [
    {
      key: 'c-1',
      ts: min(7),
      kind: 'assistant',
      text: 'Checking the late-reply path.',
      parentToolUseId: 'tu-sub',
    },
    {
      key: 'c-2',
      ts: min(7),
      kind: 'tool',
      toolUseId: 'tu-child',
      name: 'Grep',
      input: { pattern: 'late reply' },
      state: 'ok',
      result: { text: 'socket.rs:88', isError: false, truncated: false },
      parentToolUseId: 'tu-sub',
    },
    {
      key: 'c-3',
      ts: min(8),
      kind: 'assistant',
      text: 'No race: the hook drops the late bridge reply.',
      parentToolUseId: 'tu-sub',
    },
  ];
}

export function syntheticPrompts(): PromptPendingEvent[] {
  return [
    {
      id: '',
      promptId: 'p-perm',
      kind: 'permission',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build && cargo build', description: 'Clean build' },
      toolUseId: 'tu-new',
    },
    {
      id: '',
      promptId: 'p-q',
      kind: 'question',
      toolName: 'AskUserQuestion',
      toolInput: {},
      toolUseId: 'tu-q-new',
      questions: [
        {
          question: 'When the bridge times out, what should the hook do?',
          header: 'Timeout',
          multiSelect: false,
          options: [
            {
              label: 'Fall through to the TUI',
              description: 'Return no decision; the terminal dialog shows.',
            },
            { label: 'Deny the tool call', description: 'Safer when unattended.' },
          ],
        },
        {
          question: 'Which checks should run?',
          header: 'Checks',
          multiSelect: true,
          options: [{ label: 'Unit' }, { label: 'Lint' }, { label: 'E2E' }],
        },
      ],
    },
    {
      id: '',
      promptId: 'p-plan',
      kind: 'plan',
      toolName: 'ExitPlanMode',
      toolInput: { plan: '## Plan\n\n1. Add the timeout\n2. Add a test\n' },
      toolUseId: 'tu-plan-new',
    },
  ];
}

/** A long transcript for the virtualization tests: `n` items of mixed kinds. */
export function bigChat(n: number): ChatItem[] {
  const out: ChatItem[] = [];
  for (let i = 0; i < n; i++) {
    const ts = T0 + i * 15_000;
    const m = i % 5;
    if (m === 0) {
      out.push({
        key: `b-${i}`,
        ts,
        kind: 'user',
        text: `Question number ${i}: what does module ${i % 37} do?`,
        images: [],
      });
    } else if (m === 1) {
      out.push({
        key: `b-${i}`,
        ts,
        kind: 'assistant',
        text: `Answer ${i}. Module ${i % 37} parses input and returns a **result**.\n\n- point one\n- point two with \`code\`\n\n\`\`\`ts\nconst n = ${i};\n\`\`\``,
      });
    } else if (m === 2) {
      out.push({
        key: `b-${i}`,
        ts,
        kind: 'tool',
        toolUseId: `bt-${i}`,
        name: 'Read',
        input: { file_path: `/work/src/mod${i % 37}.ts` },
        state: 'ok',
        result: { text: `export const x${i} = ${i};\n`, isError: false, truncated: false },
      });
    } else if (m === 3) {
      out.push({ key: `b-${i}`, ts, kind: 'thinking', text: `Thinking about item ${i}.` });
    } else {
      out.push({ key: `b-${i}`, ts, kind: 'assistant', text: `Item ${i} is done.` });
    }
  }
  return out;
}
