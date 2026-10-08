// Half-open drop: the dropped page's WebSocket stops delivering in BOTH
// directions without closing, so the server only finds out at its ping timeout.
// Variant 'notice': the page then notices (transport onClose) and the player
// tries the same room code again on a fresh socket while the stale one is live.
// Variant 'silent': nobody notices anything until the timeouts.
const { chromium } = await import(process.env.SB_PLAYWRIGHT || 'playwright-core');
const URL = process.env.SB_URL || 'http://127.0.0.1:8111/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (l, c, d = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (d ? '  ' + d : '')); if (!c) fails.push(l); };
async function waitFor(fn, ms = 10000) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(150); } return false; }
const browser = await chromium.launch({
  executablePath: process.env.SB_CHROME || '/home/slippy/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const screen = (p) => p.evaluate(() => (document.querySelector('.screen.active') || {}).id);
const ONLINE = new Set(['screen-charselect', 'screen-stageselect', 'screen-match']);
async function pair(toMatch) {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const ctx = await browser.newContext(); const p = await ctx.newPage(); p.dialogs = [];
    p.on('dialog', (d) => { p.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    p.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => { const o = window.io; window.__socks = []; window.io = (...a) => { const s = o(...a); window.__socks.push(s); return s; }; });
    pages.push(p);
  }
  const [A, B] = pages;
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
    await sleep(1500);
  }
  return { A, B, code };
}
const cases = [];
for (const variant of ['notice', 'silent']) for (const toMatch of [false, true]) for (const who of ['A', 'B'])
  cases.push({ variant, toMatch, who, label: `${variant} ${toMatch ? 'mid-match' : 'lobby'} ${who === 'A' ? 'creator' : 'joiner'}` });
for (const c of cases) { Object.assign(c, await pair(c.toMatch)); c.d = c[c.who]; c.o = c.who === 'A' ? c.B : c.A; }
const t0 = Date.now();
for (const c of cases) {
  await c.d.evaluate((notice) => {
    const s = window.__socks[0]; const t = s.io.engine.transport; const ws = t.ws;
    ws.onmessage = () => {}; ws.send = () => {}; ws.close = () => {};   // frozen, never closed
    if (notice) t.onClose({ description: 'half-open probe' });
  }, c.variant === 'notice');
}
await sleep(4000);
for (const c of cases) {
  c.early = [await screen(c.A), await screen(c.B)];
  if (c.variant === 'notice') {
    // A fresh socket from the same browser tries the old room while the stale one still holds the seat.
    c.preRejoin = { screen: await screen(c.d), dialogs: c.d.dialogs.slice() };
    console.log(`  [${c.label}] before rejoin: early ${c.early}, dropped page on ${c.preRejoin.screen}, dialogs ${JSON.stringify(c.preRejoin.dialogs)}`);
    try {
      await c.d.click('#btn-online', { timeout: 3000 });
      await c.d.fill('#input-join-code', c.code, { timeout: 3000 }); await c.d.click('#btn-join-room', { timeout: 3000 });
      await sleep(1500);
      c.rejoin = { screen: await screen(c.d), status: await c.d.textContent('#online-status'), sockets: await c.d.evaluate(() => window.__socks.length) };
    } catch (e) {
      c.rejoin = { unreachable: true, screen: await screen(c.d), error: e.message.split('\n')[0] };
    }
    c.oppAfterRejoin = await screen(c.o);
    c.oppMatchFound = c.o.dialogs.slice();
  }
}
// engine.io's worst case for noticing a frozen socket is ping_interval (25) +
// ping_timeout (20) + one service-task sweep (up to ping_timeout again), ~65 s,
// so a single look at 55 s can land before the server has acted. Poll to 120 s
// and record when each case cleared.
const LIMIT = 120000;
while (Date.now() - t0 < LIMIT) {
  for (const c of cases) if (c.clearedAt == null) {
    const sc = [await screen(c.A), await screen(c.B)];
    if (!ONLINE.has(sc[0]) && !ONLINE.has(sc[1])) c.clearedAt = Math.round((Date.now() - t0) / 1000);
  }
  if (cases.every((c) => c.clearedAt != null)) break;
  await sleep(1000);
}
for (const c of cases) {
  c.late = [await screen(c.A), await screen(c.B)];
  console.log(`  [${c.label}] cleared at ${c.clearedAt == null ? 'NEVER (120 s)' : c.clearedAt + ' s'}`);
  console.log(`\n== ${c.label}: early ${c.early} -> late ${c.late}; dropped dialogs ${JSON.stringify(c.d.dialogs)} opp dialogs ${JSON.stringify(c.o.dialogs)}${c.rejoin ? '; rejoin ' + JSON.stringify(c.rejoin) + ' opp ' + c.oppAfterRejoin : ''}`);
  if (c.rejoin && c.rejoin.unreachable) {
    check(`${c.label}: rejoin UI reachable after the drop`, false, `stuck on ${c.rejoin.screen}: ${c.rejoin.error}`);
  } else if (c.rejoin) {
    check(`${c.label}: second socket did not take a second seat`, c.rejoin.screen !== 'screen-charselect' && /full|not found/i.test(c.rejoin.status), c.rejoin.status);
    check(`${c.label}: opponent did not see a duplicate join`, c.oppAfterRejoin === c.early[c.who === 'A' ? 1 : 0]);
  }
  check(`${c.label}: within 120 s nobody is left in a dead session`, !ONLINE.has(c.late[0]) && !ONLINE.has(c.late[1]), `${c.late}`);
  if (c.variant === 'notice') check(`${c.label}: dropped player told at once`, !ONLINE.has(c.early[c.who === 'A' ? 0 : 1]) && c.d.dialogs.length > 0);
}
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
