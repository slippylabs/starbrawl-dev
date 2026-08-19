// Two real browser clients against a local StarBrawl instance, playing one
// online match through the rollback netcode with injected latency.
//
// What the headless netplay test (rollback_netplay_test.mjs) cannot cover: the
// real Socket.IO relay, real event ordering, and the actual main.js wiring. It
// asserts the same property — both clients agree on every confirmed frame —
// but end to end.
//
// Physics is advanced through the __sbNet debug hooks rather than
// requestAnimationFrame, because headless Chromium throttles rAF hard enough
// to make wall-clock frame counts meaningless here (this project has been
// bitten by that before).
//
// playwright-core is not vendored into this repo -- point SB_PLAYWRIGHT at an
// install, e.g. SB_PLAYWRIGHT=/path/to/node_modules/playwright-core/index.mjs
const { chromium } = await import(process.env.SB_PLAYWRIGHT || 'playwright-core');

const URL = process.env.SB_URL || 'http://127.0.0.1:8111/';
const LATENCY_MS = Number(process.env.SB_LATENCY || 60);

const failures = [];
function check(label, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? `  ${detail}` : ''));
  if (!cond) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll rather than sleep a fixed amount when waiting on something that has to
// round-trip through the server. A flat sleep that is long enough on an idle
// box quietly becomes too short once two browser contexts are competing.
async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

const browser = await chromium.launch({
  executablePath: process.env.SB_CHROME
    || '/home/slippy/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--ignore-certificate-errors'],
});

const onScreen = (p, id) => p.evaluate((i) => document.getElementById(i).classList.contains('active'), id);

try {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const [name, page] of [['A', A], ['B', B]]) {
    page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`  [${name} console] ${m.text()}`); });
  }
  await A.goto(URL, { waitUntil: 'domcontentloaded' });
  await B.goto(URL, { waitUntil: 'domcontentloaded' });

  // --- lobby ---------------------------------------------------------------
  await A.click('#btn-online');
  await A.click('#btn-create-room');
  const gotCode = await waitFor(async () => (await A.textContent('#room-code-display')).trim().length === 4);
  check('room code issued', gotCode);
  const code = (await A.textContent('#room-code-display')).trim();

  await B.click('#btn-online');
  await B.fill('#input-join-code', code);
  await B.click('#btn-join-room');
  check('both reached character select',
        await waitFor(async () => (await onScreen(A, 'screen-charselect')) && (await onScreen(B, 'screen-charselect'))));

  // --- picks + start -------------------------------------------------------
  await A.click('.cs-card:nth-child(1)');
  await B.click('.cs-card:nth-child(2)');
  check('both reached stage select',
        await waitFor(async () => (await onScreen(A, 'screen-stageselect')) && (await onScreen(B, 'screen-stageselect'))));
  await A.click('#btn-start-match');
  check('both reached the match',
        await waitFor(async () => (await onScreen(A, 'screen-match')) && (await onScreen(B, 'screen-match'))));

  // --- drive the match ------------------------------------------------------
  // Freeze the rAF loop so the only thing advancing the sim is __sbNet.pump,
  // then add latency so prediction and rollback actually engage.
  for (const p of [A, B]) {
    await p.evaluate((ms) => { window.__sbNet.freeze(true); window.__sbNet.setLatency(ms); }, LATENCY_MS);
  }
  const spawnX = await A.evaluate(() => window.__sbNet.state().map((f) => f.x));
  // Online play puts BOTH clients on the p1 keyboard scheme (each player is on
  // their own machine), so B drives with KeyA/KeyJ too — not the p2 layout.
  await A.keyboard.down('KeyD');  // player 0 walks right
  await B.keyboard.down('KeyA');  // player 1 walks left — they meet in the middle

  // One frame per iteration at roughly real time. Pumping in bursts instead
  // lets the network get ahead of the simulation, and then nothing is ever
  // predicted and rollback is never exercised — which is exactly what an
  // earlier version of this test measured, and why it looked green while
  // testing nothing.
  let stalls = 0;
  for (let i = 0; i < 260; i += 1) {
    await Promise.all([A.evaluate(() => window.__sbNet.pump(1)), B.evaluate(() => window.__sbNet.pump(1))]);
    // Attacks are held for several frames: sample() only sees a key that is
    // down at the instant a frame is pumped, so an instantaneous press falls
    // between frames and never registers.
    if (i % 24 === 0) { await A.keyboard.down('KeyJ'); await B.keyboard.down('KeyJ'); }
    if (i % 24 === 3) { await A.keyboard.up('KeyJ'); await B.keyboard.up('KeyJ'); }
    if (i % 10 === 0 && await A.evaluate(() => window.__sbNet.stalled())) stalls += 1;
    await sleep(14);
  }
  await A.keyboard.up('KeyD');
  await B.keyboard.up('KeyA');

  // Let every in-flight packet arrive, then settle. settle() matters: a packet
  // that lands while the sim is paused only marks a rollback as pending — the
  // rewind itself happens on the next pump. Reading checksums without settling
  // compares two clients' un-rewound predictions and reports a desync that
  // isn't one.
  await sleep(800);
  await Promise.all([A.evaluate(() => window.__sbNet.pump(2)), B.evaluate(() => window.__sbNet.pump(2))]);
  await sleep(800);
  await Promise.all([A.evaluate(() => window.__sbNet.settle()), B.evaluate(() => window.__sbNet.settle())]);

  const sa = await A.evaluate(() => ({ frame: window.__sbNet.frame(), confirmed: window.__sbNet.confirmed(), rollbacks: window.__sbNet.rollbacks(), desynced: window.__sbNet.desynced(), state: window.__sbNet.state() }));
  const sb = await B.evaluate(() => ({ frame: window.__sbNet.frame(), confirmed: window.__sbNet.confirmed(), rollbacks: window.__sbNet.rollbacks(), desynced: window.__sbNet.desynced(), state: window.__sbNet.state() }));
  console.log(`  A: frame ${sa.frame} confirmed ${sa.confirmed} rollbacks ${sa.rollbacks}`);
  console.log(`  B: frame ${sb.frame} confirmed ${sb.confirmed} rollbacks ${sb.rollbacks}`);

  const mode = await A.evaluate(() => window.__sbNet.mode());
  console.log(`  netcode mode: ${mode}`);
  check('the match actually ran', sa.frame > 150 && sb.frame > 150);
  if (mode === 'rollback') {
    check('rollbacks engaged under latency', sa.rollbacks > 0 || sb.rollbacks > 0);
  }
  check('neither client reported a desync', !sa.desynced && !sb.desynced);
  // Net displacement only — knockback fights the walk, so the fighter taking
  // the beating can end up back near its spawn. That both moved at all is what
  // proves each client's input reached both simulations.
  check('both fighters moved', Math.abs(sa.state[0].x - spawnX[0]) > 5 && Math.abs(sa.state[1].x - spawnX[1]) > 5,
        `x ${spawnX.map(Math.round)} -> ${sa.state.map((f) => Math.round(f.x))}`);
  check('hits landed', sa.state[0].percent + sa.state[1].percent > 0,
        `percents ${sa.state[0].percent}/${sa.state[1].percent}`);

  // The real assertion: agreement on frames both sides have confirmed.
  // Only rollback keeps a snapshot ring to read an earlier frame out of.
  // Lockstep needs no such check: it advances only on confirmed input, so the
  // two sims are identical at every frame by construction.
  if (mode === 'rollback') {
    const frame = Math.min(sa.confirmed, sb.confirmed, sa.frame, sb.frame);
    const ca = await A.evaluate((f) => window.__sbNet.checksumAt(f), frame);
    const cb = await B.evaluate((f) => window.__sbNet.checksumAt(f), frame);
    check('both clients still hold that frame', ca !== null && cb !== null, `frame ${frame}`);
    check('clients agree on the confirmed frame', ca === cb, `${ca} vs ${cb}`);
  } else {
    check('lockstep clients reached the same frame', sa.frame === sb.frame, `${sa.frame} vs ${sb.frame}`);
  }

  console.log(`  (${stalls} stalled pumps out of 40 at ${LATENCY_MS}ms injected latency)`);
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
