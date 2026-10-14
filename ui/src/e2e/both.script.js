/* global window, document */
// The bar's live "both" script: the real claude CLI (haiku) behind the real Patchroom UI.
// Loaded by `patchroom --e2e-script` in a debug build (scripts/e2e-live.sh). `t` is the runner in
// ui/src/e2e/runner.ts. Every action is a DOM event on a real control. Directories come from the
// environment as PATCHROOM_E2E_DIR_A and PATCHROOM_E2E_DIR_B.

window.__PR_E2E_SCENARIO__ = async function scenario(t) {
  const A = await t.requireParam('DIR_A');
  const B = await t.requireParam('DIR_B');
  const NAME_A = A.split('/').pop();
  const NAME_B = 'beta';
  const TURN_MS = 120_000;
  // An 8x8 solid PNG.
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

  const strip = (s) =>
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .split('\u00a0')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const hooks = async () => (await t.pgrep('patchroom-hook')).length;
  const lastDone = (kind) => {
    const all = [
      ...document.querySelectorAll(
        `[data-testid="chat"]:not(.chat--hidden) .ask[data-kind="${kind}"][data-state="resolved"] .ask-done`,
      ),
    ];
    return all.length ? (all[all.length - 1].textContent || '').trim() : '';
  };
  const countDone = (kind) =>
    document.querySelectorAll(
      `[data-testid="chat"]:not(.chat--hidden) .ask[data-kind="${kind}"][data-state="resolved"]`,
    ).length;

  const trustShown = (name) => /Yes, I trust this folder/.test(t.termText(t.dm(name).id));
  const tuiUp = (name) =>
    /\? for shortcuts|mode on|bypass permissions|accept edits|plan mode|shift\+tab/i.test(
      t
        .termLines(t.dm(name).id)
        .filter((l) => l.trim())
        .slice(-6)
        .join('\n'),
    );

  /** Accept the folder trust dialog through the terminal view: move to "Yes", press Enter. */
  async function clearTrust(name) {
    if (!trustShown(name)) return false;
    await t.showView('Terminal');
    for (let i = 0; i < 3; i++) {
      const lines = t.termLines(t.dm(name).id);
      const cur = lines.filter((l) => l.includes('\u276f')).pop() || '';
      if (/Yes, I trust/.test(cur)) break;
      t.termKeys(['ArrowDown']);
      await t.sleep(300);
    }
    t.termKeys(['Enter']);
    await t.sleep(1500);
    await t.showView('Chat');
    return true;
  }

  /** Wait until the DM's TUI is up and idle, accepting the trust dialog if claude shows it. */
  async function ready(name) {
    await t.waitFor(
      `${name} TUI up`,
      async () => {
        if (await clearTrust(name)) return false;
        const d = t.dm(name);
        return d.status === 'idle' && t.chat(d.id).loaded && tuiUp(name) && !trustShown(name);
      },
      120_000,
    );
    t.fact(
      `tuiTail:${name}`,
      t
        .termLines(t.dm(name).id)
        .filter((l) => l.trim())
        .slice(-8),
    );
  }

  /** Wait for the turn to finish, allowing any permission asked on the way. */
  async function settle(label) {
    await t.waitFor(
      `${label}: turn done`,
      () => {
        const w = t.widget('permission');
        if (w) t.clickButton(w, 'Allow');
        return t.dm(t.activeName).status === 'idle';
      },
      TURN_MS,
    );
  }

  async function turnIdle(name) {
    await t.waitFor(`${name} idle`, () => t.dm(name).status === 'idle', TURN_MS);
  }

  t.startLogTrace();

  // ---- 0. the DM from --open-dm ---------------------------------------------------------------
  await t.step('first DM opens as chat', async () => {
    await t.waitFor('one DM', () => t.sessionCount() >= 1, 30_000);
    await t.waitFor('chat view', () => t.view() === 'Chat', 10_000);
    t.activeName = NAME_A;
    await ready(NAME_A);
    const sel = '[data-testid="chat"]:not(.chat--hidden) [data-testid="composer-input"]';
    if (!document.querySelector(sel)) throw new Error('no composer');
    return `DM ${NAME_A} idle`;
  });

  // ---- 1. composer send ---------------------------------------------------------------------
  await t.step('composer send appears once', async () => {
    const text = 'Reply with exactly the single word PONG and nothing else.';
    await t.sendFromComposer(text);
    await t.waitFor(
      'user message',
      () => t.userTexts().some((x) => x.includes('single word PONG')),
      15_000,
    );
    await t.waitFor(
      'assistant PONG',
      () => t.assistantTexts().some((x) => /PONG/.test(x)),
      TURN_MS,
    );
    await turnIdle(NAME_A);
    await t.sleep(2000);
    const n = t.userTexts().filter((x) => x.includes('single word PONG')).length;
    const dom = [
      ...document.querySelectorAll('[data-testid="chat"]:not(.chat--hidden) .msg.user'),
    ].filter((e) => (e.textContent || '').includes('single word PONG')).length;
    if (n !== 1) throw new Error(`user message count in the chat model is ${n}`);
    if (dom !== 1) throw new Error(`user message count in the DOM is ${dom}`);
    return 'one user message, one reply';
  });

  // ---- 1b. image paste ------------------------------------------------------------------------
  await t.step('pasted image becomes a path and the sent message carries an image', async () => {
    const before = t.userImageCounts().length;
    t.pasteImageIntoComposer(PNG_B64);
    await t.waitFor(
      'path in the composer',
      () => {
        const v = document.querySelector(
          '[data-testid="chat"]:not(.chat--hidden) [data-testid="composer-input"]',
        ).value;
        return /\/pastes\/\S+\.png/.test(v) ? v : null;
      },
      10_000,
    );
    t.pressEnterInComposer();
    await t.waitFor(
      'user message with an image',
      () => {
        const c = t.userImageCounts();
        return c.length > before && c[c.length - 1] > 0;
      },
      30_000,
    );
    // claude may ask to Read the pasted file after the image attached: allow it and let the turn end.
    const end = Date.now() + TURN_MS;
    while (t.dm(NAME_A).status !== 'idle' && Date.now() < end) {
      const ask = document.querySelector(
        '[data-testid="chat"]:not(.chat--hidden) .ask[data-state="pending"]',
      );
      if (ask) t.clickButton(ask, 'Allow');
      await t.sleep(500);
    }
    await turnIdle(NAME_A);
    return 'user message carries an image';
  });

  // ---- 2. second DM (used for badges) -------------------------------------------------------
  await t.step('second DM starts through the New DM dialog', async () => {
    await t.newDm(B, NAME_B);
    await t.waitFor('second DM', () => t.sessionCount() >= 2, 20_000);
    await ready(NAME_B);
    t.selectDm(NAME_A);
    await t.waitFor('back on first DM', () => t.badge(NAME_A).active, 5000);
    t.activeName = NAME_A;
    await t.showView('Chat');
  });

  // ---- 3. permission allowed from chat ---------------------------------------------------------
  await t.step('permission: allow from chat, no hook left within 2s', async () => {
    await t.sendFromComposer(
      `Use the Bash tool to run exactly this command and nothing else: touch ${A}/allowed.txt`,
    );
    const w = await t.awaitWidget('permission', TURN_MS);
    if (!/touch/.test(w.textContent || '')) throw new Error('widget does not show the command');
    if (t.badge(NAME_A).needs < 1)
      throw new Error('needs-you badge missing while the prompt waits');
    const before = countDone('permission');
    const t0 = Date.now();
    t.clickButton(w, 'Allow');
    await t.waitFor('widget resolved', () => countDone('permission') > before, 10_000);
    if (!/Allowed in chat/.test(lastDone('permission')))
      throw new Error(`widget says "${lastDone('permission')}"`);
    await t.waitFor(
      'no patchroom-hook within 2s of the click',
      async () => (await hooks()) === 0,
      2000 - (Date.now() - t0) + 100,
    );
    const ms = Date.now() - t0;
    await t.waitFor(
      'Bash ran ok',
      () =>
        t
          .chat()
          .items.some(
            (i) =>
              i.kind === 'tool' &&
              i.name === 'Bash' &&
              i.state === 'ok' &&
              JSON.stringify(i.input).includes('allowed.txt'),
          ),
      60_000,
    );
    await turnIdle(NAME_A);
    if (t.badge(NAME_A).needs !== 0) throw new Error('needs-you badge stayed after the answer');
    return `hook gone ${ms} ms after Allow`;
  });

  // ---- 4. permission answered in the terminal ----------------------------------------------------
  await t.step(
    'permission: answered in terminal shows "Answered in terminal", no hook left',
    async () => {
      await t.sendFromComposer(
        `Use the Bash tool to run exactly this command and nothing else: touch ${A}/terminal.txt`,
      );
      await t.awaitWidget('permission', TURN_MS);
      const before = countDone('permission');
      await t.showView('Terminal');
      await t.waitFor(
        'TUI dialog',
        () => /Do you want to proceed|1\. Yes/.test(t.termText()),
        15_000,
      );
      t.termKeys(['1']);
      const t0 = Date.now();
      await t.showView('Chat');
      await t.waitFor('widget resolved', () => countDone('permission') > before, 15_000);
      if (!/Answered in terminal/.test(lastDone('permission')))
        throw new Error(`widget says "${lastDone('permission')}"`);
      await t.waitFor(
        'no patchroom-hook within 2s',
        async () => (await hooks()) === 0,
        Math.max(500, 2100 - (Date.now() - t0)),
      );
      await turnIdle(NAME_A);
      return `resolved and hook gone ${Date.now() - t0} ms after the keystroke`;
    },
  );

  // ---- 5. AskUserQuestion from chat, with Other text --------------------------------------------------
  await t.step('question: answered from chat with Other text', async () => {
    await t.sendFromComposer(
      'Use the AskUserQuestion tool once. Ask the single-select question "Which fruit?" with the options "Apple" and "Banana". When I answer, reply with only the answer I gave.',
    );
    const w = await t.awaitWidget('question', TURN_MS);
    const block = w.querySelector('.qblock');
    t.fillOther(block, 'Dragonfruit');
    const before = countDone('question');
    t.clickButton(w, 'Send answer');
    await t.waitFor('widget resolved', () => countDone('question') > before, 15_000);
    if (!/Answered in chat/.test(lastDone('question')))
      throw new Error(`widget says "${lastDone('question')}"`);
    await t.waitFor(
      'claude saw Dragonfruit',
      () => t.assistantTexts().some((x) => /Dragonfruit/i.test(x)),
      TURN_MS,
    );
    await turnIdle(NAME_A);
    if (t.badge(NAME_A).needs !== 0) throw new Error('needs-you badge stayed');
  });

  // ---- 6. AskUserQuestion from the terminal -------------------------------------------------------------
  await t.step('question: answered in the terminal', async () => {
    await t.sendFromComposer(
      'Use the AskUserQuestion tool once. Ask the single-select question "Which colour?" with the options "Red" and "Blue". When I answer, reply with only the answer I gave.',
    );
    await t.awaitWidget('question', TURN_MS);
    const before = countDone('question');
    await t.showView('Terminal');
    await t.waitFor(
      'TUI picker',
      () =>
        /Red/.test(t.termLines().slice(-40).join('\n')) &&
        /Blue/.test(t.termLines().slice(-40).join('\n')),
      15_000,
    );
    t.termKeys(['1']);
    await t.showView('Chat');
    await t.waitFor('widget resolved', () => countDone('question') > before, 20_000);
    if (!/Answered in terminal/.test(lastDone('question')))
      throw new Error(`widget says "${lastDone('question')}"`);
    await t.waitFor(
      'claude saw Red',
      () => t.assistantTexts().some((x) => /\bRed\b/.test(x)),
      TURN_MS,
    );
    await turnIdle(NAME_A);
    if ((await hooks()) !== 0) throw new Error('a hook is still running');
  });

  // ---- 7. plan approval from chat ----------------------------------------------------------------------------
  await t.step('plan: approved from chat', async () => {
    // Shift+Tab through the status strip mode chip until the CLI is in plan mode.
    const chip = () =>
      document.querySelector('[data-testid="chat"]:not(.chat--hidden) [data-chip="mode"]');
    await t.waitFor('mode chip', () => chip(), 30_000);
    for (let i = 0; i < 5 && !/plan/i.test(chip()?.textContent || ''); i++) {
      const before = chip()?.textContent;
      t.clickButton(chip().parentElement, before.trim());
      await t
        .waitFor('mode chip changes', () => chip()?.textContent !== before, 8000)
        .catch(() => undefined);
    }
    if (!/plan/i.test(chip()?.textContent || ''))
      throw new Error(`mode chip says "${chip()?.textContent}"`);
    await t.sendFromComposer(
      `Plan only: write a two step plan to create a file ${A}/plan-out.txt that contains the word hi, then present it for approval.`,
    );
    const w = await t.awaitWidget('plan', TURN_MS);
    const before = countDone('plan');
    t.clickButton(w, 'Approve plan');
    await t.waitFor('widget resolved', () => countDone('plan') > before, 30_000);
    if (!/approved in chat/i.test(lastDone('plan')))
      throw new Error(`widget says "${lastDone('plan')}"`);
    await settle('plan');
    if ((await hooks()) !== 0) throw new Error('a hook is still running');
  });

  // ---- 8. needs-you persists across a DM switch --------------------------------------------------------------------
  await t.step('needs-you badge persists across DM switches until answered', async () => {
    await t.sendFromComposer(
      `Use the Bash tool to run exactly this command and nothing else: touch ${A}/persist.txt`,
    );
    await t.awaitWidget('permission', TURN_MS);
    t.selectDm(NAME_B);
    await t.waitFor('on beta', () => t.badge(NAME_B).active, 5000);
    await t.sleep(1500);
    if (t.badge(NAME_A).needs < 1) throw new Error('needs-you badge gone after switching away');
    t.selectDm(NAME_A);
    await t.waitFor('on first DM', () => t.badge(NAME_A).active, 5000);
    await t.showView('Chat');
    await t.sleep(1500);
    if (t.badge(NAME_A).needs < 1) throw new Error('needs-you badge gone after viewing the DM');
    const w = await t.awaitWidget('permission', 5000);
    t.clickButton(w, 'Allow');
    await t.waitFor('badge cleared by the answer', () => t.badge(NAME_A).needs === 0, 15_000);
    await turnIdle(NAME_A);
  });

  // ---- 9. background unread ----------------------------------------------------------------------------------------------
  await t.step('background DM unread badge clears on view', async () => {
    t.selectDm(NAME_B);
    await t.waitFor('on beta', () => t.badge(NAME_B).active, 5000);
    t.activeName = NAME_B;
    await t.showView('Chat');
    await t.sendFromComposer('Reply with exactly the single word PING and nothing else.');
    await t.waitFor(
      'user message in beta',
      () => t.userTexts().some((x) => x.includes('word PING')),
      15_000,
    );
    t.selectDm(NAME_A);
    await t.waitFor('on first DM', () => t.badge(NAME_A).active, 5000);
    t.activeName = NAME_A;
    await t.waitFor('unread badge on beta', () => t.badgesOf(NAME_B).unread > 0, TURN_MS);
    if (t.badge(NAME_B).unread < 1) throw new Error('sidebar shows no unread badge on beta');
    t.selectDm(NAME_B);
    t.activeName = NAME_B;
    await t.waitFor('unread cleared on view', () => t.badgesOf(NAME_B).unread === 0, 10_000);
    await turnIdle(NAME_B);
    await t.sleep(1000);
    if (t.badgesOf(NAME_B).unread !== 0) throw new Error('unread came back while viewing');
    t.selectDm(NAME_A);
    t.activeName = NAME_A;
  });

  // ---- 10. status strip ----------------------------------------------------------------------------------------------------------
  await t.step('status strip text equals the TUI status line', async () => {
    await t.showView('Chat');
    const stripText = await t.waitFor(
      'status strip text',
      () => strip(t.statusStripText()),
      30_000,
    );
    await t.showView('Terminal');
    await t.sleep(500);
    const rows = t.termLines().map(strip).filter(Boolean);
    t.fact('statusStrip', stripText);
    t.fact('terminalTail', rows.slice(-8));
    await t.showView('Chat');
    if (
      !rows.some(
        (r) => r === stripText || r.includes(stripText) || (stripText.includes(r) && r.length > 8),
      )
    ) {
      throw new Error(`strip "${stripText}" is not in the terminal tail`);
    }
    return stripText;
  });

  // ---- 11. quit ----------------------------------------------------------------------------------------------------------------------
  await t.step('quit path', async () => {
    t.fact('hooksBeforeQuit', await hooks());
  });
  await t.finish(true);
};
