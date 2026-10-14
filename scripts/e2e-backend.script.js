/* global window, document */
// The backend half of the live e2e: the real claude CLI (haiku) behind the real Patchroom UI.
// Loaded by `patchroom --e2e-script` in a debug build (scripts/e2e-live.sh runs it after the UI
// scenario, on its own data dir). `t` is the runner in ui/src/e2e/runner.ts.
//
// What it shows that only the backend can: sound-hook detection on the machine's real settings
// and the resulting "Keep yours" suppression, a needs-you notification for an unfocused DM, a
// folder section over a git repo with live haiku sessions (names, /rename, an older-than-X
// fixture, resume with history, a session started outside Patchroom, a dragged-in DM keeping
// its process), session parity (an outside session opened from the folder section is a read
// only mirror with no second process, and is taken over once it closes; a terminal-only dialog
// raises session:terminal_wait, refuses composer text and clears when answered) and a restart in
// the middle. Folders and fixtures come from the environment:
// PATCHROOM_E2E_DIR_A (alpha, the --open-dm folder), _B (beta), _FOLD (a git repo for the
// folder section), PATCHROOM_E2E_EXPECT_HOOKS (audio hook events the real settings should
// report, comma separated).

window.__PR_E2E_SCENARIO__ = async function scenario(t) {
  const A = await t.requireParam('DIR_A');
  const B = await t.requireParam('DIR_B');
  const FOLD = await t.requireParam('DIR_FOLD');
  const EXPECT = ((await t.param('expect_hooks')) || '').split(',').filter(Boolean);
  const NAME_A = A.split('/').pop();
  const NAME_B = 'beta';
  const TURN_MS = 120_000;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const store = () => window.__PR_STORE__;
  const snap = () => store().getSnapshot();
  // `session_list` rows keep the backend's snake_case claude_session_id.
  const sidOf = (s) => s.claude_session_id || s.claudeSessionId;

  // ---- helpers shared in spirit with ui/src/e2e/both.script.js -------------------------------
  const trustShown = (name) => /Yes, I trust this folder/.test(t.termText(t.dm(name).id));
  const tuiUp = (name) =>
    /\? for shortcuts|mode on|bypass permissions|accept edits|plan mode|shift\+tab/i.test(
      t
        .termLines(t.dm(name).id)
        .filter((l) => l.trim())
        .slice(-6)
        .join('\n'),
    );
  async function clearTrust(name) {
    if (!trustShown(name)) return false;
    await t.showView('Terminal');
    for (let i = 0; i < 3; i++) {
      const lines = t.termLines(t.dm(name).id);
      const cur = lines.filter((l) => l.includes('❯')).pop() || '';
      if (/Yes, I trust/.test(cur)) break;
      t.termKeys(['ArrowDown']);
      await t.sleep(300);
    }
    t.termKeys(['Enter']);
    await t.sleep(1500);
    await t.showView('Chat');
    return true;
  }
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
  }
  const turnIdle = (name) =>
    t.waitFor(`${name} idle`, () => t.dm(name).status === 'idle', TURN_MS);
  const decisions = async () => (await invoke('e2e_decision_log')).split('\n').filter(Boolean);
  const hasDecision = async (dm, event, decision, reason) =>
    (await decisions()).some(
      (l) =>
        l.includes(`event=${event} `) &&
        l.includes(`dm=${dm} `) &&
        l.includes(`decision=${decision}`) &&
        (!reason || l.includes(`reason=${reason}`)),
    );

  // notify:fire events as the UI receives them (the UI plays the sound from this event).
  const fires = [];
  const onFire = window.__TAURI_INTERNALS__.transformCallback((e) => fires.push(e.payload));
  await invoke('plugin:event|listen', { event: 'notify:fire', target: { kind: 'Any' }, handler: onFire });

  // Terminal-only dialog signals and mirror changes, as the UI receives them.
  const waitEvents = [];
  const clearEvents = [];
  const mirrorEvents = [];
  for (const [name, sink] of [
    ['session:terminal_wait', waitEvents],
    ['session:terminal_wait_clear', clearEvents],
    ['session:mirror', mirrorEvents],
  ]) {
    const cb = window.__TAURI_INTERNALS__.transformCallback((e) => sink.push(e.payload));
    await invoke('plugin:event|listen', { event: name, target: { kind: 'Any' }, handler: cb });
  }

  t.startLogTrace();
  const phase = await t.param('phase');

  // ---- after the restart ----------------------------------------------------------------------
  if (phase === 'persist2') {
    await t.step('restart: the folder section keeps its folder and archive days', async () => {
      await t.waitFor('store ready', () => snap().ready && snap().sessions.length >= 2, 30_000);
      const sec = snap().sections.find((s) => s.folder && s.folder.endsWith('/fold'));
      if (!sec) throw new Error('the folder section is gone');
      if (sec.archiveDays !== 30) throw new Error(`archiveDays is ${sec.archiveDays}`);
      return `${sec.name}: ${sec.folder}, ${sec.archiveDays} days`;
    });
    await t.step('restart: the opened session is still a DM in the section', async () => {
      const sec = snap().sections.find((s) => s.folder && s.folder.endsWith('/fold'));
      await t.waitFor(
        'listing',
        () => (snap().folders[sec.id]?.sessions.length ?? 0) >= 3,
        20_000,
      );
      // The folder-opened DM is the one archived before the restart. Other linked DMs (the
      // "dialog" DM filed under Direct messages) are not it.
      const archived = new Set(
        (await invoke('session_list', {})).filter((r) => r.archived).map((r) => r.id),
      );
      const linked = snap().folders[sec.id].sessions.filter((x) => x.dmId && archived.has(x.dmId));
      if (linked.length < 1) throw new Error('the folder-opened DM is not linked to its row');
      const dm = snap().sessions.find((s) => s.id === linked[0].dmId);
      if (!dm || dm.sectionId !== sec.id) throw new Error('the DM left its section');
    });
    await t.step('restart: the dragged-in DM keeps its chip and its filing', async () => {
      const a = snap().sessions.find((s) => s.name === NAME_A);
      await t.waitFor('chip', () =>
        document.querySelector(`.side .row[data-dm="${a.id}"] [data-testid="folder-chip"]`),
      );
    });
    await t.step('restart: the older fixture still sits in the Older dropdown', async () => {
      const btn = await t.waitFor('older toggle', () => document.querySelector('.fs-older'));
      if (!/Older than 30 days \(1\)/.test(btn.textContent || ''))
        throw new Error(`toggle says "${btn.textContent}"`);
    });
    await t.step('restart: the starred and archived flags survived', async () => {
      const rows = await invoke('session_list', {});
      const beta = rows.find((r) => r.name === NAME_B);
      if (!beta || !beta.starred) throw new Error('beta lost its star');
      const sec = snap().sections.find((s) => s.folder && s.folder.endsWith('/fold'));
      const arch = rows.filter((r) => r.archived);
      if (arch.length !== 1) throw new Error(`${arch.length} archived DMs, expected 1`);
      if (arch[0].sectionId !== sec.id && arch[0].section_id !== sec.id)
        throw new Error('the archived DM left the folder section');
      if (rows.some((r) => r.starred && r.name !== NAME_B)) throw new Error('an extra DM is starred');
      await t.waitFor('store shows the flags', () => {
        const s = snap().sessions;
        return s.find((x) => x.name === NAME_B)?.starred && s.some((x) => x.archived);
      });
      return `${NAME_B} starred, ${arch[0].name} archived`;
    });
    await t.step('restart: preferences survived', async () => {
      const prefs = await invoke('prefs_get', {});
      if (prefs.mode !== 'dark') throw new Error(`mode is ${prefs.mode}`);
      await t.waitFor('store has the prefs', () => snap().prefs?.mode === 'dark');
      return 'mode dark';
    });
    await t.step('restart: the window probe works after a relaunch', async () => {
      const st = await invoke('e2e_window_state', {});
      if (st.forced !== null) throw new Error('a probe pin survived the restart');
      t.fact('windowStateAfterRestart', st);
      return `active=${st.active} native=${st.nativeFocused} webview=${st.webviewFocused}`;
    });
    await t.step('restart: earlier notification decisions are still on record', async () => {
      const log = await decisions();
      if (!log.some((l) => l.includes('event=needs') && l.includes('decision=fire')))
        throw new Error('the needs-you fire line is gone');
    });
    await t.finish(true);
    return;
  }

  // ---- 1. the --open-dm DM ----------------------------------------------------------------------
  await t.step('first DM opens as chat', async () => {
    await t.waitFor('one DM', () => t.sessionCount() >= 1, 30_000);
    await t.waitFor('chat view', () => t.view() === 'Chat', 10_000);
    t.activeName = NAME_A;
    await ready(NAME_A);
  });

  await t.step('second DM starts through the New DM dialog', async () => {
    await t.newDm(B, NAME_B);
    await t.waitFor('second DM', () => t.sessionCount() >= 2, 20_000);
    await ready(NAME_B);
    t.selectDm(NAME_A);
    await t.waitFor('back on first DM', () => t.badge(NAME_A).active, 5000);
    t.activeName = NAME_A;
    await t.showView('Chat');
  });

  // ---- 2. sound hooks on the real settings ----------------------------------------------------------
  await t.step('sound hooks: the real settings report their audio hooks (read only)', async () => {
    const found = await invoke('sound_hooks_detect', {});
    const events = [...new Set(found.map((h) => h.event))].sort();
    t.fact('detectedHookEvents', events);
    if (EXPECT.length === 0) return `none expected; detected ${JSON.stringify(events)}`;
    const missing = EXPECT.filter((e) => !events.includes(e));
    if (missing.length) throw new Error(`missed ${missing.join(', ')}; detected ${events}`);
    return `detected ${events.join(', ')}`;
  });

  await t.step('sound hooks: a background turn-complete is kept silent (hook_keep)', async () => {
    t.selectDm(NAME_B);
    await t.waitFor('on beta', () => t.badge(NAME_B).active, 5000);
    t.activeName = NAME_B;
    await t.showView('Chat');
    await t.sendFromComposer('Reply with exactly the single word PING and nothing else.');
    await t.waitFor('user message', () => t.userTexts().some((x) => x.includes('word PING')), 15_000);
    t.selectDm(NAME_A);
    await t.waitFor('on first DM', () => t.badge(NAME_A).active, 5000);
    t.activeName = NAME_A;
    const beta = t.dm(NAME_B).id;
    const covered = EXPECT.includes('Stop') || EXPECT.includes('TaskCompleted');
    const want = covered ? ['suppress', 'hook_keep'] : ['fire', 'ok'];
    await t.waitFor(
      `done decision ${want.join(' ')}`,
      () => hasDecision(beta, 'done', want[0], want[1]),
      TURN_MS,
    );
    const fired = fires.filter((f) => f.id === beta && f.event === 'done').length;
    if (covered && fired !== 0) throw new Error(`notify:fire reached the UI ${fired} time(s)`);
    t.selectDm(NAME_B);
    t.activeName = NAME_B;
    await t.waitFor('unread cleared', () => t.badgesOf(NAME_B).unread === 0, 10_000);
    await turnIdle(NAME_B);
    t.selectDm(NAME_A);
    t.activeName = NAME_A;
    return covered ? 'decision=suppress reason=hook_keep, no notify:fire' : 'fired (no audio hook)';
  });

  // ---- 3. needs-you: focused DM stays silent, unfocused DM notifies ----------------------------------
  // Alpha runs with --permission-mode default (from --open-dm), so a Bash command asks.
  const needsLines = async (dm) =>
    (await decisions()).filter((l) => l.includes('event=needs ') && l.includes(`dm=${dm} `));
  const needsFires = (dm) => fires.filter((f) => f.id === dm && f.event === 'needs').length;
  // Ask alpha for a Bash command, wait for the next needs-you decision about it, return that line.
  async function askNeeds(file, beforeLines) {
    await t.sendFromComposer(
      `Use the Bash tool to run exactly this command and nothing else: touch ${A}/${file}`,
    );
    await t.waitFor('user message', () => t.userTexts().some((x) => x.includes(file)), 15_000);
    const alpha = t.dm(NAME_A).id;
    return t.waitFor(
      `a new needs-you decision for alpha (${file})`,
      async () => {
        const lines = await needsLines(alpha);
        return lines.length > beforeLines ? lines[lines.length - 1] : null;
      },
      TURN_MS,
    );
  }
  async function allowFromChat() {
    t.selectDm(NAME_A);
    await t.waitFor('on alpha', () => t.badge(NAME_A).active, 5000);
    t.activeName = NAME_A;
    await t.showView('Chat');
    const w = await t.awaitWidget('permission', TURN_MS);
    t.clickButton(w, 'Allow');
    await turnIdle(NAME_A);
  }
  const showAlpha = async () => {
    t.selectDm(NAME_A);
    await t.waitFor('on alpha', () => t.badge(NAME_A).active, 5000);
    t.activeName = NAME_A;
    await t.showView('Chat');
  };

  await t.step('notifications: needs-you on the on-screen DM is suppressed as focused', async () => {
    await showAlpha();
    const alpha = t.dm(NAME_A).id;
    // Attempt 0 relies on the real window and webview focus. A locked or occluded screen gives
    // the window no stable focus, so attempt 1 pins the probe active (focus hint plus probe are
    // still exercised) and the detail says which one proved it.
    for (const pinned of [false, true]) {
      await invoke('e2e_focus_window', {}).catch(() => undefined);
      if (pinned) await invoke('e2e_force_active', { active: true });
      else {
        // The probe must stay active for 2 s in a row before the prompt is sent.
        let since = 0;
        const stable = await t
          .waitFor(
            'probe stays active',
            async () => {
              const on = (await invoke('e2e_window_state', {})).active;
              since = on ? since || Date.now() : 0;
              return on && Date.now() - since > 2000;
            },
            8000,
          )
          .then(() => true, () => false);
        if (!stable) continue;
      }
      const state = await invoke('e2e_window_state', {});
      t.fact('windowStateFocused', { ...state, hasFocus: document.hasFocus(), pinned });
      const beforeLines = (await needsLines(alpha)).length;
      const beforeFires = needsFires(alpha);
      const line = await askNeeds(pinned ? 'needs-focused-pinned.txt' : 'needs-focused.txt', beforeLines);
      await invoke('e2e_force_active', { active: null });
      if (line.includes('decision=suppress') && line.includes('reason=focused')) {
        await t.sleep(1500);
        if (needsFires(alpha) !== beforeFires)
          throw new Error('notify:fire reached the UI for the focused DM');
        if (t.badge(NAME_A).needs < 1) throw new Error('alpha shows no needs-you badge');
        await allowFromChat();
        return `${pinned ? 'probe pinned active (window not stably focused)' : 'real focus'}: native=${state.nativeFocused} webview=${state.webviewFocused}; ${line.split(' ').slice(2).join(' ')}; no notify:fire`;
      }
      if (pinned) throw new Error(`expected decision=suppress reason=focused, got: ${line}`);
      // The window lost focus while the turn ran: answer the prompt and retry pinned.
      await allowFromChat();
      await showAlpha();
    }
    throw new Error('unreachable');
  });

  await t.step('notifications: an unfocused needs-you prompt fires notify:fire', async () => {
    await showAlpha();
    const alpha = t.dm(NAME_A).id;
    const beforeLines = (await needsLines(alpha)).length;
    const beforeFires = needsFires(alpha);
    await t.sendFromComposer(
      `Use the Bash tool to run exactly this command and nothing else: touch ${A}/needs.txt`,
    );
    await t.waitFor('user message', () => t.userTexts().some((x) => x.includes('needs.txt')), 15_000);
    // Look at beta while alpha works: alpha is no longer the DM on screen.
    t.selectDm(NAME_B);
    await t.waitFor('on beta', () => t.badge(NAME_B).active, 5000);
    t.activeName = NAME_B;
    const line = await t.waitFor(
      'a new needs-you decision for alpha',
      async () => {
        const lines = await needsLines(alpha);
        return lines.length > beforeLines ? lines[lines.length - 1] : null;
      },
      TURN_MS,
    );
    if (!line.includes('decision=fire') || !line.includes('reason=ok'))
      throw new Error(`expected decision=fire reason=ok, got: ${line}`);
    await t.waitFor('notify:fire reached the UI', () => needsFires(alpha) > beforeFires, 10_000);
    if (t.badge(NAME_A).needs < 1) throw new Error('alpha shows no needs-you badge');
    const fire = fires.filter((f) => f.id === alpha && f.event === 'needs').pop();
    t.fact('needsFire', { title: fire.title, event: fire.event });
    await allowFromChat();
    return `notify:fire needs for "${fire.title}" (${line.split(' ').slice(2).join(' ')})`;
  });

  await t.step('notifications: a blurred window fires even for the DM on screen', async () => {
    await showAlpha();
    const alpha = t.dm(NAME_A).id;
    await invoke('e2e_force_active', { active: false });
    try {
      const st = await invoke('e2e_window_state', {});
      if (st.active) throw new Error('the probe still says active while pinned inactive');
      const beforeLines = (await needsLines(alpha)).length;
      const beforeFires = needsFires(alpha);
      const line = await askNeeds('needs-blurred.txt', beforeLines);
      if (!line.includes('decision=fire') || !line.includes('reason=ok'))
        throw new Error(`expected decision=fire reason=ok, got: ${line}`);
      await t.waitFor('notify:fire reached the UI', () => needsFires(alpha) > beforeFires, 10_000);
    } finally {
      await invoke('e2e_force_active', { active: null });
    }
    await allowFromChat();
    const st = await invoke('e2e_window_state', {});
    if (st.forced !== null) throw new Error('the probe pin was not released');
    return 'blurred window: decision=fire reason=ok, then the pin was released';
  });

  // ---- 4. folder section over a git repo --------------------------------------------------------------
  const sessionIds = {};
  await t.step('folder: two haiku sessions, one renamed with /rename, become rows', async () => {
    for (const [name, word] of [
      ['one', 'ONE'],
      ['two', 'TWO'],
    ]) {
      await t.newDm(FOLD, name);
      t.activeName = name;
      await ready(name);
      await t.sendFromComposer(`Reply with exactly the single word ${word} and nothing else.`);
      await t.waitFor(`assistant ${word}`, () => t.assistantTexts().some((x) => x.includes(word)), TURN_MS);
      await turnIdle(name);
      if (name === 'two') {
        await t.sendFromComposer('/rename live-renamed');
        await t.sleep(4000);
        await turnIdle(name);
      }
      const row = snap().sessions.find((s) => s.name === name);
      sessionIds[name] = row && sidOf(row);
    }
    if (!sessionIds.one || !sessionIds.two) throw new Error('the DMs have no session id');
    // Forget the DMs: their processes end, their transcripts stay.
    for (const name of ['one', 'two']) await store().deleteSession(t.dm(name).id);
    t.selectDm(NAME_A);
    t.activeName = NAME_A;
  });

  let sec = '';
  await t.step('folder: names follow the precedence; the old fixture is in the dropdown', async () => {
    sec = await store().createFolderSection(FOLD);
    if (!sec) throw new Error('the folder section was not created');
    await store().setArchiveDays(sec, 30);
    const raw = await t.waitFor(
      'three sessions listed',
      async () => {
        const r = await invoke('folder_sessions', { sectionId: sec });
        return r.sessions.length >= 3 ? r : null;
      },
      30_000,
    );
    const by = (id) => raw.sessions.find((s) => s.sessionId === id);
    const one = by(sessionIds.one);
    const two = by(sessionIds.two);
    const old = raw.sessions.find((s) => s.name === 'Fixture old session');
    if (!one || !two || !old) throw new Error(`missing rows: ${JSON.stringify(raw.sessions.map((s) => s.name))}`);
    if (two.name !== 'live-renamed' || two.nameSource !== 'custom-title')
      throw new Error(`renamed session is "${two.name}" from ${two.nameSource}`);
    if (!['ai-title', 'prompt'].includes(one.nameSource))
      throw new Error(`first session named from ${one.nameSource}`);
    if (old.nameSource !== 'ai-title') throw new Error(`fixture named from ${old.nameSource}`);
    if (one.userTurns < 1 || two.userTurns < 1) throw new Error('userTurns is 0');
    if (!/single word ONE/.test(one.firstPrompt)) throw new Error(`firstPrompt "${one.firstPrompt}"`);
    if (!one.launchCwd.endsWith('/fold') || one.relPath !== '') throw new Error('bad launch folder');
    const ageDays = (Date.now() - old.lastActivity) / 86_400_000;
    if (ageDays < 39 || ageDays > 41) throw new Error(`fixture age is ${ageDays} days`);
    // The UI folds it into the dropdown.
    const btn = await t.waitFor('older toggle', () => document.querySelector('.fs-older'), 15_000);
    if (!/Older than 30 days \(1\)/.test(btn.textContent || ''))
      throw new Error(`toggle says "${btn.textContent}"`);
    if (document.querySelector('[data-fs-session="' + old.sessionId + '"]'))
      throw new Error('the old session is listed above the dropdown');
    btn.click();
    await t.waitFor('old row in the dropdown', () =>
      document.querySelector(`.fs-older-list [data-fs-session="${old.sessionId}"]`),
    );
    return `names: "${one.name}" (${one.nameSource}), "${two.name}" (${two.nameSource}), "${old.name}" (${old.nameSource})`;
  });

  await t.step('folder: opening a row resumes it from its folder with the history in chat', async () => {
    t.clickSel(`.side [data-folder-body="${sec}"] [data-fs-session="${sessionIds.one}"]`);
    const dm = await t.waitFor('resumed DM in the section', () =>
      snap().sessions.find((s) => s.sectionId === sec && sidOf(s) === sessionIds.one),
    );
    if (!dm.cwd.endsWith('/fold')) throw new Error(`DM cwd is ${dm.cwd}`);
    t.activeName = dm.name;
    await t.waitFor('history in chat', () => t.userTexts().some((x) => /single word ONE/.test(x)), 60_000);
    const pids = await t.pgrep(`resume ${sessionIds.one}`);
    if (pids.length < 1) throw new Error('no claude --resume process for the session');
    await ready(dm.name);
    await t.waitFor('row left the list', () => !document.querySelector(`[data-fs-session="${sessionIds.one}"]`));
    t.selectDm(NAME_A);
    t.activeName = NAME_A;
    return `claude --resume ${sessionIds.one.slice(0, 8)} in ${dm.cwd}`;
  });

  await t.step('folder: a session started outside Patchroom appears within seconds', async () => {
    const known = new Set(snap().folders[sec].sessions.map((s) => s.sessionId));
    const sentAt = await invoke('e2e_outside_session', { dir: FOLD });
    let seenAt = 0;
    let row = null;
    await t.waitFor(
      'the outside session in the listing',
      () => {
        row = snap().folders[sec].sessions.find((s) => !known.has(s.sessionId));
        if (row) seenAt = Date.now();
        return row;
      },
      30_000,
    );
    // Latency from the newest transcript line the first listing carried to that listing.
    const lag = seenAt - row.lastActivity;
    t.fact('outsideSessionLagMs', lag);
    t.fact('outsideSessionAfterPromptMs', seenAt - sentAt);
    if (lag > 2500) throw new Error(`seen ${lag} ms after its newest transcript line`);
    return `seen ${lag} ms after its newest transcript line, ${seenAt - sentAt} ms after Enter`;
  });

  await t.step('folder: a DM from another folder keeps its process and wears a chip', async () => {
    const before = await t.pgrep('bridge.sock.d');
    const a = t.dm(NAME_A).id;
    const inSection = snap().sessions.filter((x) => x.sectionId === sec).map((x) => x.id);
    await store().dropSession(a, { kind: 'section', sectionId: sec }, [...inSection, a]);
    const chip = await t.waitFor('folder chip', () =>
      document.querySelector(`.side .row[data-dm="${a}"] [data-testid="folder-chip"]`),
    );
    if (chip.textContent.trim() !== NAME_A) throw new Error(`chip says "${chip.textContent}"`);
    await t.sleep(1500);
    const after = await t.pgrep('bridge.sock.d');
    if (before.length < 2) throw new Error(`expected live claude processes, saw ${before.length}`);
    const gone = before.filter((p) => !after.includes(p));
    if (gone.length) throw new Error(`processes ended by the drop: ${gone}`);
    if (t.dm(NAME_A).status === 'exited') throw new Error('alpha ended');
    return `same ${after.length} processes before and after the drop`;
  });

  await t.step('folder: the outside session ends before the app quits', async () => {
    await t.waitFor('outside session exited', () => invoke('e2e_outside_done', {}), 120_000);
  });

  // ---- 4b. session parity: never two processes, mirrors, terminal-only dialogs ----------------------
  // A second outside session that stays open (E2E hold) so the folder section can meet it live.
  const outside = { sid: '', dm: '' };
  const listRow = async (sid) =>
    (await invoke('folder_sessions', { sectionId: sec })).sessions.find((x) => x.sessionId === sid);

  await t.step('parity: a session started outside is opened as a read-only mirror, with no second process', async () => {
    const known = new Set((await invoke('folder_sessions', { sectionId: sec })).sessions.map((x) => x.sessionId));
    await invoke('e2e_outside_session', { dir: FOLD, holdSecs: 40 });
    const row = await t.waitFor(
      'the outside session is listed as live',
      async () => {
        const r = (await invoke('folder_sessions', { sectionId: sec })).sessions.find(
          (x) => !known.has(x.sessionId) && x.liveState === 'live',
        );
        return r || null;
      },
      60_000,
    );
    outside.sid = row.sessionId;
    if (!row.liveElsewhere) throw new Error('liveState is live but liveElsewhere is false');
    const before = await t.pgrep(`resume ${outside.sid}`);
    const dm = await invoke('folder_session_open', { sectionId: sec, sessionId: outside.sid });
    outside.dm = dm.id;
    if (!dm.mirror) throw new Error(`no mirror on the opened DM: ${JSON.stringify(dm)}`);
    if (!dm.mirror.pid || typeof dm.mirror.where !== 'string') throw new Error(`bad mirror ${JSON.stringify(dm.mirror)}`);
    await t.sleep(3000);
    const after = await t.pgrep(`resume ${outside.sid}`);
    if (after.length > before.length) throw new Error(`a claude --resume ${outside.sid} process started (${after})`);
    if (!mirrorEvents.some((e) => e.id === dm.id && e.mirror)) throw new Error('no session:mirror event');
    const sent = await invoke('session_send_text', { id: dm.id, text: 'must not reach the other terminal' });
    if (sent.outcome !== 'mirror_readonly') throw new Error(`send outcome ${JSON.stringify(sent)}`);
    t.fact('mirror', dm.mirror);
    return `mirror of pid ${dm.mirror.pid} in ${dm.mirror.where}; no resume process; send refused`;
  });

  await t.step('parity: take over when it closes resumes the session once the other terminal exits', async () => {
    await invoke('session_mirror_takeover_when_closed', { id: outside.dm, enabled: true });
    const mid = (await invoke('session_list', {})).find((r) => r.id === outside.dm);
    if (!mid.mirror || !mid.mirror.takeoverWhenClosed) throw new Error('takeover flag not set');
    await t.waitFor('outside session exited', () => invoke('e2e_outside_done', {}), 150_000);
    await t.waitFor(
      'the DM resumed the session',
      async () => (await t.pgrep(`resume ${outside.sid}`)).length >= 1,
      60_000,
    );
    await t.sleep(3000);
    const procs = await t.pgrep(`resume ${outside.sid}`);
    if (procs.length !== 1) throw new Error(`${procs.length} processes run the session`);
    const row = (await invoke('session_list', {})).find((r) => r.id === outside.dm);
    if (row.mirror) throw new Error('the DM is still a mirror');
    return `one process (${procs[0]}) after the other terminal closed`;
  });

  await t.step('parity: a terminal-only dialog raises terminal_wait, refuses composer text and clears', async () => {
    await t.newDm(FOLD, 'dialog');
    t.activeName = 'dialog';
    await ready('dialog');
    const id = t.dm('dialog').id;
    const waitsBefore = waitEvents.filter((e) => e.id === id).length;
    // /model opens a picker only the terminal can answer.
    const first = await invoke('session_send_text', { id, text: '/model' });
    if (first.outcome !== 'sent' && first.outcome !== 'queued') throw new Error(`first send ${JSON.stringify(first)}`);
    const w = await t.waitFor(
      'session:terminal_wait',
      () => waitEvents.filter((e) => e.id === id).length > waitsBefore && waitEvents.filter((e) => e.id === id).pop(),
      15_000,
    );
    t.fact('terminalWait', w);
    const listed = (await invoke('session_list', {})).find((r) => r.id === id);
    if (!listed.terminalWait) throw new Error('SessionInfo.terminalWait is empty');
    if (!listed.needsYou && !listed.needs_you) throw new Error('needs-you was not raised');
    const act = await invoke('activity_list', {});
    if (!act.some((r) => r.id === id)) throw new Error('activity_list has no row for the dialog');
    const blocked = await invoke('session_send_text', { id, text: 'COMPOSER-TEXT-MUST-NOT-LAND' });
    if (blocked.outcome !== 'blocked_dialog') throw new Error(`send during the dialog: ${JSON.stringify(blocked)}`);
    // Esc closes the picker, as the user would in the terminal.
    await invoke('session_write', { id, data: 'Gw==' });
    await t.waitFor('session:terminal_wait_clear', () => clearEvents.some((e) => e.id === id), 15_000);
    const hist = await invoke('chat_history', { id, limit: 200 });
    if (JSON.stringify(hist).includes('COMPOSER-TEXT-MUST-NOT-LAND')) throw new Error('the refused text reached the transcript');
    const after = await invoke('session_send_text', { id, text: 'Reply with exactly the single word OK and nothing else.' });
    if (after.outcome !== 'sent') throw new Error(`send after the dialog: ${JSON.stringify(after)}`);
    await turnIdle('dialog');
    t.selectDm(NAME_A);
    t.activeName = NAME_A;
    return `terminal_wait "${w.reason}", send blocked, cleared by Esc, next send ${after.outcome}`;
  });

  // ---- 5. restart in the middle -------------------------------------------------------------------------
  await t.step('before the restart: star a DM, archive another, change a preference', async () => {
    const beta = t.dm(NAME_B).id;
    // The DM opened from a folder row (by its claude session id), not whichever DM is first.
    const inFold = snap().sessions.find((x) => x.sectionId === sec && sidOf(x) === sessionIds.one);
    if (!inFold) throw new Error('no DM in the folder section to archive');
    await store().setFlags(beta, { starred: true });
    await store().setFlags(inFold.id, { archived: true });
    await invoke('prefs_set', { patch: { mode: 'dark' } });
    const rows = await invoke('session_list', {});
    const b = rows.find((r) => r.id === beta);
    const f = rows.find((r) => r.id === inFold.id);
    if (!b || !b.starred) throw new Error('beta is not starred in the backend');
    if (!f || !f.archived) throw new Error('the folder DM is not archived in the backend');
    if ((await invoke('prefs_get', {})).mode !== 'dark') throw new Error('mode was not saved');
    t.fact('archivedFolderDm', inFold.name);
    return `starred ${NAME_B}, archived ${inFold.name}, mode dark`;
  });

  await t.step('quit path', async () => {
    t.fact('hooksBeforeQuit', (await t.pgrep('patchroom-hook')).length);
  });
  await t.restart('persist2');
};
