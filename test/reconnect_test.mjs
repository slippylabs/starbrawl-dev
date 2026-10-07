// Reconnect probe for StarBrawl: drop one client's socket (engine.close()) in
// the lobby (character select) and mid-match, for the room creator (A) and
// the joiner (B). Invariant: afterwards no client may sit on an online game
// screen unless its opponent is still in the same live session with it.
const { chromium } = await import(process.env.SB_PLAYWRIGHT || 'playwright-core');
const URL = process.env.SB_URL || 'http://127.0.0.1:8111/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (label, cond, d = '') => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (d ? '  ' + d : '')); if (!cond) fails.push(label); };
async function waitFor(fn, ms = 8000) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(100); } return false; }

const browser = await chromium.launch({
  executablePath: process.env.SB_CHROME || '/home/slippy/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const screen = (p) => p.evaluate(() => (document.querySelector('.screen.active') || {}).id);

async function setup(toMatch) {
  const ctxA = await browser.newContext(); const ctxB = await browser.newContext();
  const A = await ctxA.newPage(); const B = await ctxB.newPage();
  for (const [n, p] of [['A', A], ['B', B]]) {
    p.dialogs = [];
    p.on('dialog', (d) => { p.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    p.on('pageerror', (e) => console.log(`  [${n} pageerror] ${e.message}`));
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    // Record the socket so the page can force a transport drop.
    await p.evaluate(() => { const orig = window.io; window.io = (...a) => { const s = orig(...a); window.__sock = s; return s; }; });
  }
  await A.click('#btn-online'); await A.click('#btn-create-room');
  await waitFor(async () => (await A.textContent('#room-code-display')).trim().length === 4);
  const code = (await A.textContent('#room-code-display')).trim();
  await B.click('#btn-online'); await B.fill('#input-join-code', code); await B.click('#btn-join-room');
  await waitFor(async () => (await screen(A)) === 'screen-charselect' && (await screen(B)) === 'screen-charselect');
  if (toMatch) {
    await A.click('.cs-card:nth-child(1)'); await B.click('.cs-card:nth-child(2)');
    await waitFor(async () => (await screen(A)) === 'screen-stageselect' && (await screen(B)) === 'screen-stageselect');
    await A.click('#btn-start-match');
    await waitFor(async () => (await screen(A)) === 'screen-match' && (await screen(B)) === 'screen-match');
    for (const p of [A, B]) await p.evaluate(() => window.__sbNet.freeze(true));
    for (let i = 0; i < 40; i++) { await Promise.all([A.evaluate(() => window.__sbNet.pump(1)), B.evaluate(() => window.__sbNet.pump(1))]); await sleep(16); }
  }
  return { A, B, ctxs: [ctxA, ctxB] };
}

const ONLINE = new Set(['screen-charselect', 'screen-stageselect', 'screen-match']);
for (const toMatch of [false, true]) {
  for (const who of ['A', 'B']) {
    const label = `${toMatch ? 'mid-match' : 'lobby'} drop of ${who === 'A' ? 'creator' : 'joiner'}`;
    console.log(`\n== ${label}`);
    const { A, B, ctxs } = await setup(toMatch);
    const pages = { A, B };
    const dropped = pages[who];
    const before = await Promise.all([screen(A), screen(B)]);
    await dropped.evaluate(() => window.__sock.io.engine.close());
    // Wait for the reconnect, then keep both sims ticking for a while.
    await sleep(3000);
    if (toMatch) {
      for (let i = 0; i < 60; i++) {
        await Promise.all([A, B].map((p) => p.evaluate(() => (window.__sbNet && window.__sbNet.pump(1)) || 0).catch(() => 0)));
        await sleep(16);
      }
    }
    const after = await Promise.all([screen(A), screen(B)]);
    const sock = await dropped.evaluate(() => ({ connected: !!(window.__sock && window.__sock.connected) }));
    console.log(`  screens before ${before} -> after ${after}; dropped socket connected=${sock.connected}; dialogs A=${JSON.stringify(A.dialogs)} B=${JSON.stringify(B.dialogs)}`);
    const aOn = ONLINE.has(after[0]); const bOn = ONLINE.has(after[1]);
    // Either both are still in a live session together, or neither shows one.
    check(`${label}: no client shows an online session its opponent has left`, aOn === bOn, `A=${after[0]} B=${after[1]}`);
    if (aOn && bOn && toMatch) {
      const fa = await A.evaluate(() => window.__sbNet.frame()); const fb = await B.evaluate(() => window.__sbNet.frame());
      check(`${label}: match still advancing on both`, fa > 60 && fb > 60, `${fa}/${fb}`);
    }
    check(`${label}: the dropped player is still in the session or was told`, (aOn && bOn) || dropped.dialogs.length > 0, JSON.stringify(dropped.dialogs));
    check(`${label}: the dropped player's reconnect loop is not left running in no room`, (aOn && bOn) || !sock.connected);
    for (const c of ctxs) await c.close();
  }
}
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
