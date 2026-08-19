// RollbackSim against itself, headless and server-free: two peers, a fake
// transport with configurable latency, and a reference simulation that had
// perfect information all along.
//
// The assertion that matters: after rollback, both peers' confirmed state must
// equal the reference exactly. A prediction bug (a phantom repeated attack, a
// missed rewind, fx double-counting) shows up here as divergence from that
// reference, not just as the two peers agreeing with each other on something
// wrong.
//
//   node test/rollback_netplay_test.mjs
import { createMatch, tick, checksum } from '../static/js/engine.js';
import { EMPTY_INPUT } from '../static/js/input.js';
import { RollbackSim } from '../static/js/netplay.js';
import { NETPLAY_INPUT_DELAY, MAX_ROLLBACK_FRAMES } from '../static/js/constants.js';

const failures = [];
function check(label, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? `  ${detail}` : ''));
  if (!cond) failures.push(label);
}

const inp = (o) => Object.assign({}, EMPTY_INPUT, o);
const newMatch = () => createMatch({
  stageId: 'three-tier', charIds: ['rook', 'vex'], mode: 'stock', stockCount: 3, timeLimitSeconds: 180,
});

// Deliberately press-heavy: the edge fields (jp/ap/spp/gp) are what a naive
// "repeat the last remote input" predictor gets catastrophically wrong.
function scriptFor(index) {
  return (seq) => {
    const o = {};
    if (index === 0) {
      if (seq % 30 < 10) { o.r = 1; o.sx = 1; }
      if (seq % 17 === 0) { o.ap = 1; }              // jab, one frame of edge
      if (seq % 41 === 0) { o.jh = 1; o.jp = 1; }
    } else {
      if (seq % 26 >= 13) { o.l = 1; o.sx = -1; }
      if (seq % 19 === 0) { o.spp = 1; }             // special: projectile
      if (seq % 23 === 0) { o.ap = 1; }
      if (seq % 47 === 0) { o.gp = 1; }
    }
    return inp(o);
  };
}

// Fake transport. Messages are delivered `latency` steps after they are sent,
// in order (the real path is Socket.IO over TCP, which is ordered).
function makeLink(latency) {
  const inbox = [[], []];   // queued for peer 0, peer 1
  const handlers = [null, null];
  let step = 0;
  const nets = [0, 1].map((i) => ({
    sendInput(frame, input, chk) { inbox[1 - i].push({ due: step + latency, msg: { frame, input, chk } }); },
    onPeerInput(cb) { handlers[i] = cb; },
    onPeerLeft() {},
  }));
  return {
    nets,
    advance() {
      step += 1;
      for (let i = 0; i < 2; i += 1) {
        const ready = inbox[i].filter((m) => m.due <= step);
        inbox[i] = inbox[i].filter((m) => m.due > step);
        for (const m of ready) handlers[i](m.msg);
      }
    },
    flush() { for (let i = 0; i < 40; i += 1) this.advance(); },
  };
}

function run({ latency, steps }) {
  const link = makeLink(latency);
  const matches = [newMatch(), newMatch()];
  const sims = [0, 1].map((i) => new RollbackSim(matches[i], i, link.nets[i]));
  const scripts = [scriptFor(0), scriptFor(1)];
  // Each peer samples only its OWN fighter's script.
  const players = [0, 1].map((i) => { let seq = 0; return { sample() { seq += 1; return scripts[i](seq); } }; });

  for (let s = 0; s < steps; s += 1) {
    sims[0].pump(players[0]);
    sims[1].pump(players[1]);
    link.advance();
  }
  // Let every in-flight packet land and any final rollback resolve.
  link.flush();
  sims[0].pump(players[0]);
  sims[1].pump(players[1]);
  link.flush();

  // Reference: the same input streams with no network at all. Frames 1..delay
  // are neutral on both sides, exactly as the sims seed them.
  const ref = newMatch();
  const refSums = [checksum(ref)];
  const s0 = scriptFor(0); const s1 = scriptFor(1);
  for (let f = 1; f <= sims[0].match.frame + 5; f += 1) {
    const a = f <= NETPLAY_INPUT_DELAY ? EMPTY_INPUT : s0(f - NETPLAY_INPUT_DELAY);
    const b = f <= NETPLAY_INPUT_DELAY ? EMPTY_INPUT : s1(f - NETPLAY_INPUT_DELAY);
    tick(ref, [a, b]);
    refSums[f] = checksum(ref);
  }
  return { sims, refSums };
}

for (const latency of [0, 2, 5, 9]) {
  console.log(`\n-- ${latency} frames of one-way latency --`);
  const { sims, refSums } = run({ latency, steps: 300 });
  const [a, b] = sims;
  const f = Math.min(a.confirmed, b.confirmed, a.match.frame, b.match.frame);

  const sa = a.snapshots.get(f);
  const sb = b.snapshots.get(f);
  check('both peers still hold the confirmed frame', !!sa && !!sb, `frame ${f}`);
  if (sa && sb) {
    check('peers agree', checksum(sa) === checksum(sb), `${checksum(sa)} vs ${checksum(sb)}`);
    check('peers match the perfect-information reference', checksum(sa) === refSums[f],
          `${checksum(sa)} vs ${refSums[f]}`);
  }
  check('no desync reported', !a.desynced && !b.desynced);
  check('the match actually progressed', f > 200, `confirmed frame ${f}`);
  check('damage was dealt', a.match.fighters[0].percent + a.match.fighters[1].percent > 0,
        `${a.match.fighters[0].percent} / ${a.match.fighters[1].percent}`);
  // Latency inside the input-delay budget arrives in time to be used, so it
  // costs nothing at all -- that is what the 2 frames of delay are buying.
  if (latency > NETPLAY_INPUT_DELAY) {
    check('rollbacks happened', a.rollbackCount > 0, `${a.rollbackCount} rollbacks`);
  } else {
    check('latency within the delay budget needs no rollbacks', a.rollbackCount === 0, `${a.rollbackCount}`);
  }
}

// Latency past the prediction window must stall rather than run away.
{
  console.log('\n-- latency beyond MAX_ROLLBACK_FRAMES --');
  const { sims } = run({ latency: MAX_ROLLBACK_FRAMES + 8, steps: 120 });
  const [a] = sims;
  check('sim did not outrun its confirmed frame', a.match.frame - a.confirmed <= MAX_ROLLBACK_FRAMES + 1,
        `frame ${a.match.frame}, confirmed ${a.confirmed}`);
  check('snapshot ring never overflowed', a.snapshots.size <= MAX_ROLLBACK_FRAMES + NETPLAY_INPUT_DELAY + 4,
        `${a.snapshots.size} snapshots`);
}

// Hit/KO events must be reported once per frame, not once per resimulation.
{
  console.log('\n-- fx are not double-counted --');
  const clean = run({ latency: 0, steps: 300 });
  const laggy = run({ latency: 6, steps: 300 });
  const count = (s) => { let n = 0; const drain = s.fx.length; n += drain; return n; };
  check('lagging peer did not accumulate extra fx despite rollbacks',
        laggy.sims[0].fx.length <= clean.sims[0].fx.length,
        `${laggy.sims[0].fx.length} with ${laggy.sims[0].rollbackCount} rollbacks vs ${clean.sims[0].fx.length} clean`);
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
