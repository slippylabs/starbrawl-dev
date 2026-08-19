// Rollback state serialization, headless and server-free.
//
// The property rollback depends on: rewinding to a snapshot and replaying the
// same inputs must land on byte-identical state. If this ever fails, netplay
// desyncs in the wild and no amount of network tuning will help.
//
//   node test/rollback_state_test.mjs
import { createMatch, tick, saveState, restoreState, checksum } from '../static/js/engine.js';
import { EMPTY_INPUT } from '../static/js/input.js';
import { MAX_ROLLBACK_FRAMES } from '../static/js/constants.js';

const failures = [];
function check(label, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? `  ${detail}` : ''));
  if (!cond) failures.push(label);
}

const inp = (o) => Object.assign({}, EMPTY_INPUT, o);

// A scripted 240-frame match that exercises the awkward parts of the state:
// movement, jumps (edge fields), attacks (currentMove + its hitKeys Set),
// specials (movementOverride, projectiles), shielding and grabs.
function inputsAt(frame) {
  const p0 = {};
  const p1 = {};
  if (frame % 40 < 12) { p0.r = 1; p0.sx = 1; }
  if (frame % 40 >= 20) { p1.l = 1; p1.sx = -1; }
  if (frame % 37 === 0) { p0.jh = 1; p0.jp = 1; }
  if (frame % 23 === 0) { p0.ap = 1; }
  if (frame % 31 === 0) { p1.spp = 1; }        // specials: projectiles + movementOverride
  if (frame % 53 === 0) { p1.gp = 1; }         // grabs
  if (frame % 67 < 6) { p1.sh = 1; }           // shield drain
  if (frame % 71 === 0) { p0.spp = 1; p0.sy = 1; } // down-special
  return [inp(p0), inp(p1)];
}

function newMatch(mode = 'stock') {
  return createMatch({
    stageId: 'three-tier',
    charIds: ['rook', 'vex'],
    mode,
    stockCount: 3,
    timeLimitSeconds: 180,
  });
}

// --- 1. straight determinism (the pre-existing contract) -------------------
{
  const a = newMatch();
  const b = newMatch();
  for (let f = 1; f <= 240; f += 1) { tick(a, inputsAt(f)); tick(b, inputsAt(f)); }
  check('same inputs -> same state', checksum(a) === checksum(b), `${checksum(a)}`);
  check('the script actually does something', a.fighters[0].percent + a.fighters[1].percent > 0,
        `damage dealt: ${a.fighters[0].percent} / ${a.fighters[1].percent}`);
}

// --- 2. rewind + replay == never having rewound ----------------------------
{
  const ref = newMatch();
  const refSums = [0];
  for (let f = 1; f <= 240; f += 1) { tick(ref, inputsAt(f)); refSums[f] = checksum(ref); }

  const m = newMatch();
  const snaps = new Map([[0, saveState(m)]]);
  let mismatches = 0;
  for (let f = 1; f <= 240; f += 1) {
    tick(m, inputsAt(f));
    snaps.set(f, saveState(m));
    // Every 10th frame, rewind the full rollback window and replay it.
    if (f % 10 === 0 && f > MAX_ROLLBACK_FRAMES) {
      const from = f - MAX_ROLLBACK_FRAMES;
      restoreState(m, snaps.get(from - 1));
      if (checksum(m) !== refSums[from - 1]) mismatches += 1;
      for (let r = from; r <= f; r += 1) {
        tick(m, inputsAt(r));
        snaps.set(r, saveState(m));
      }
    }
    if (checksum(m) !== refSums[f]) mismatches += 1;
  }
  check('rewind + replay is identical to no rewind', mismatches === 0, `${mismatches} mismatched frames`);
}

// --- 3. restoring the SAME snapshot twice -----------------------------------
// A snapshot is not consumed by restoring it: two packets arriving late can
// rewind to the same frame twice.
{
  const m = newMatch();
  for (let f = 1; f <= 60; f += 1) tick(m, inputsAt(f));
  const snap = saveState(m);
  const want = checksum(m);
  for (let f = 61; f <= 70; f += 1) tick(m, inputsAt(f));
  restoreState(m, snap);
  const first = checksum(m);
  for (let f = 61; f <= 70; f += 1) tick(m, inputsAt(f));
  restoreState(m, snap);
  check('a snapshot survives being restored twice', first === want && checksum(m) === want);
}

// --- 4. the four fields a naive clone gets wrong ----------------------------
{
  // hitKeys is a Set. Alias it and a replayed move re-hits (or never hits).
  const m = newMatch();
  let sawMove = false;
  for (let f = 1; f <= 60 && !sawMove; f += 1) {
    tick(m, inputsAt(f));
    if (m.fighters[0].currentMove) sawMove = true;
  }
  check('test reached a live currentMove', sawMove);
  const snap = saveState(m);
  const src = m.fighters[0].currentMove;
  if (src) {
    const copy = snap.fighters[0].currentMove;
    check('currentMove.hitKeys is a real copy', copy.hitKeys instanceof Set && copy.hitKeys !== src.hitKeys);
    check('currentMove.data stays by reference', copy.data === src.data);
    src.hitKeys.add('__probe');
    check('mutating the live Set does not touch the snapshot', !copy.hitKeys.has('__probe'));
    src.hitKeys.delete('__probe');
  }
  check('fighter.char stays by reference', snap.fighters[0].char === m.fighters[0].char);
  check('match.stage stays by reference', snap.stage === m.stage);
}

// --- 5. Infinity survives (no JSON round-trip anywhere) ---------------------
{
  const m = newMatch('stock');
  check('stock match has an infinite time limit', m.timeLimitFrames === Infinity);
  const snap = saveState(m);
  check('snapshot keeps Infinity', snap.timeLimitFrames === Infinity);
  for (let f = 1; f <= 30; f += 1) tick(m, inputsAt(f));
  restoreState(m, snap);
  check('restore keeps Infinity', m.timeLimitFrames === Infinity);
  tick(m, inputsAt(1));
  check('restored stock match is not instantly over', m.over === false);
}

// --- 6. movementOverride is copied, not aliased ------------------------------
{
  const m = newMatch();
  let f = 1;
  while (f <= 120 && !m.fighters[1].movementOverride) { tick(m, inputsAt(f)); f += 1; }
  if (m.fighters[1].movementOverride) {
    const snap = saveState(m);
    const before = snap.fighters[1].movementOverride.framesLeft;
    tick(m, inputsAt(f));
    check('movementOverride.framesLeft is not aliased into the snapshot',
          snap.fighters[1].movementOverride.framesLeft === before, `${before}`);
  } else {
    check('test reached a live movementOverride', false);
  }
}

// --- 7. restore drops fields added after the snapshot ------------------------
{
  const m = newMatch();
  const snap = saveState(m);              // frame 0: no _diSx yet
  check('pre-tick fighter has no _diSx', !('_diSx' in m.fighters[0]));
  tick(m, inputsAt(1));
  check('tick adds _diSx', '_diSx' in m.fighters[0]);
  restoreState(m, snap);
  check('restore removes it again', !('_diSx' in m.fighters[0]));
}

// --- 8. restore mutates in place ---------------------------------------------
{
  const m = newMatch();
  const fighterRef = m.fighters[0];
  const snap = saveState(m);
  for (let f = 1; f <= 30; f += 1) tick(m, inputsAt(f));
  restoreState(m, snap);
  check('fighter object identity is preserved across restore', m.fighters[0] === fighterRef);
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
