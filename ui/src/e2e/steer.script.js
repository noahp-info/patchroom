/* global window, document, Image, performance, localStorage */
// The live steering scenario: window capture, the frozen viewer under an overlay, comment on the
// viewer selection, and claude.ai sign-in detection, in the real app. Run it alone with
//   E2E_SCRIPT=ui/src/e2e/steer.script.js scripts/e2e-live.sh
// Pictures land next to the report as data-URL text files (shot-*.txt), for a person to look at.
// It loads https://example.com and https://claude.ai/login in the side pane; it never signs in.

window.__PR_E2E_SCENARIO__ = async function scenario(t) {
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const store = () => window.__PR_STORE__;
  const snap = () => store().getSnapshot();
  const save = (name, body) => invoke('e2e_report', { name, body }).catch(() => undefined);
  const pngSize = async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight, img };
  };
  // How many distinct colors a picture has: a blank or failed capture has one or two.
  const colors = (img) => {
    const c = document.createElement('canvas');
    c.width = Math.min(img.naturalWidth, 400);
    c.height = Math.min(img.naturalHeight, 300);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 16) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return seen.size;
  };

  await t.waitFor('a DM to open', () => snap().activeId, 60_000);
  const id = snap().activeId;

  await t.step('shot_begin captures our own window, fast, at device resolution', async () => {
    const t0 = performance.now();
    const r = await invoke('shot_begin');
    const ms = Math.round(performance.now() - t0);
    if (!r.dataUrl.startsWith('data:image/png;base64,')) throw new Error('not a PNG data URL');
    // A window larger than its screen is cut at the screen edge, so allow a smaller picture.
    if (r.width > window.innerWidth + 2 || r.width < window.innerWidth * 0.9)
      throw new Error(`width ${r.width} vs window ${window.innerWidth}`);
    const { w, img } = await pngSize(r.dataUrl);
    const n = colors(img);
    if (n < 20) throw new Error(`only ${n} colors: the capture looks blank`);
    await save('shot-full.txt', r.dataUrl);
    t.fact('shotBeginMs', ms);
    return `${ms} ms, ${w}px wide, ${n} colors`;
  });

  await t.step('shot_commit crops the box and saves it through the paste path', async () => {
    const t0 = performance.now();
    const r = await invoke('shot_commit', { id, rect: { x: 0, y: 0, width: 320, height: 160 } });
    const ms = Math.round(performance.now() - t0);
    if (!/\/pastes\/[0-9A-Z]{26}\.png$/.test(r.path)) throw new Error(`path ${r.path}`);
    const { w, h } = await pngSize(r.dataUrl);
    const scale = window.devicePixelRatio || 1;
    if (Math.abs(w - 320 * scale) > 2 || Math.abs(h - 160 * scale) > 2)
      throw new Error(`crop ${w}x${h} at scale ${scale}`);
    await save('shot-crop.txt', r.dataUrl);
    t.fact('shotCommitMs', ms);
    if (ms > 2000) throw new Error(`${ms} ms, over the 2 s target`);
    return `${ms} ms to a saved file`;
  });

  await t.step('the viewer opens a page', async () => {
    store().openLink('https://example.com/', { target: 'patchroom' });
    await t.waitFor(
      'the page title',
      () => /Example Domain/.test(snap().viewer?.title ?? ''),
      30_000,
    );
  });

  await t.step('viewer_snapshot returns the page pixels', async () => {
    await t.sleep(800);
    const page = document.querySelector('.viewer__page').getBoundingClientRect();
    const rect = { x: page.left, y: page.top, width: page.width, height: page.height };
    const url = await invoke('viewer_snapshot', { rect });
    if (!url) throw new Error('no snapshot');
    const { img } = await pngSize(url);
    const n = colors(img);
    await save('shot-viewer.txt', url);
    if (n < 3) throw new Error(`only ${n} colors`);
    return `${n} colors`;
  });

  await t.step(
    'Comment on selection reads the viewer selection into a linked draft line',
    async () => {
      await invoke('viewer_find', { text: 'Example Domain' });
      await t.sleep(300);
      store().commentOnSelection();
      const line = await t.waitFor(
        'a comment line from the page',
        () =>
          store()
            .chat(id)
            .getSnapshot()
            .comments.find((c) => c.link),
        10_000,
      );
      if (!/Example Domain/.test(line.quote)) throw new Error(`quote ${line.quote}`);
      if (!line.link.startsWith('https://example.com/#:~:text=Example%20Domain'))
        throw new Error(`link ${line.link}`);
      // Nothing was sent.
      if (t.userTexts(id).length) throw new Error('a message was sent');
      return line.link;
    },
  );

  await t.step('Settings freezes the viewer, closing it brings the page back', async () => {
    store().setPanel('prefs');
    await t.waitFor('the frozen picture', () =>
      document.querySelector('[data-testid="viewer-still"]'),
    );
    await t.sleep(400);
    const still = document.querySelector('[data-testid="viewer-still"]');
    await save('shot-still.txt', still.getAttribute('src') || '');
    t.fact('stillColors', colors(still));
    // The whole window now: Settings must be on top, with the frozen page under it.
    const full = await invoke('shot_begin');
    await invoke('shot_cancel');
    await save('shot-settings-over-pane.txt', full.dataUrl);
    store().closePanel();
    await t.waitFor('the live page', () => !document.querySelector('[data-testid="viewer-still"]'));
  });

  await t.step('claude.ai/login reads as signed out, without cookies', async () => {
    store().openLink('https://claude.ai/login', { target: 'patchroom' });
    await t.waitFor(
      'the account state',
      () =>
        JSON.parse(localStorage.getItem('patchroom.account.claude') || 'null')?.signedIn === false,
      30_000,
    );
  });

  await t.step('Sign out clears the pane storage', async () => {
    const r = await invoke('viewer_sign_out');
    if (r !== 'cleared') throw new Error(`got ${r}`);
  });

  await t.finish();
};
