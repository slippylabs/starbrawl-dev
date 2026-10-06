// Render interpolation: the bridge between a fixed-step simulation and a
// display that does not tick at the step rate.
//
// THE SIMULATION ADVANCES IN WHOLE FIXED STEPS and the renderer runs on
// requestAnimationFrame. Those two cadences do not divide into each other, so
// the number of steps that land between two drawn frames is not constant:
//
//   * On a 144 Hz panel a 60 Hz step owes a frame 0.4 steps, so most frames
//     advance the world ZERO times and the ones that do are 2.4 frames apart.
//     Modelled: 58% of frames are duplicates of the one before, and the frame
//     after one moves 2.4x as far.
//   * At 75 Hz it is 20% of frames and at 120 Hz it is 50%.
//   * A 60 Hz panel is the ONLY one that comes out even, and only when the
//     frame loop is itself what spends the accumulator -- then each frame owes
//     exactly one step. That is why this was invisible for so long: on the
//     machine it was written on, it was not there.
//
// Reading entity positions straight out of the simulation draws that: not a
// dropped frame, a frame that is a DUPLICATE of the one before it followed by
// one that moves several times as far.
//
// THE FIX IS SWAP-AND-RESTORE, not a parallel copy of the state. The drawn
// position of each entity is written into the entity itself, the existing
// renderer is called unchanged, and the simulation values are put back in a
// `finally`. That keeps object identity -- these games hold references between
// entities (an owner, a target, a held item) and a cloned state breaks them --
// and it means no renderer, HUD or camera needs to know this file exists.
//
// Imports nothing, touches no DOM, so a node oracle drives it directly.

/**
 * @param spec.entities (state) => iterable of entity objects to blend.
 *        Return only things that PERSIST across steps. A particle that is
 *        recreated every step has no previous self to blend from and is
 *        animated off its own age anyway.
 * @param spec.fields   numeric fields to blend linearly. Default ['x','y'].
 * @param spec.angles   fields to blend on the shortest arc (radians).
 * @param spec.snap     a step longer than this (in `fields` units) is a
 *        teleport -- a respawn, a wrap, a new round -- and is drawn snapped,
 *        because blending one slides the entity across the screen.
 * @param spec.angleSnap an angle step wider than this (radians) is a snap.
 *        Needed on its own because an entity can rotate about a FIXED pivot --
 *        a bat, a turret -- and then has no position for the distance bar to
 *        judge, so without this such a thing could never be snapped at all.
 */
export function makeInterp(spec) {
  const fields = spec.fields || ['x', 'y'];
  const angles = spec.angles || [];
  const snap2 = (spec.snap || Infinity) ** 2;
  const angleSnap = spec.angleSnap || Infinity;
  return {
    entities: spec.entities,
    fields,
    angles,
    snap2,
    angleSnap,
    prev: new WeakMap(),
    /** Scratch for the live values during a draw, so restoring allocates nothing. */
    live: new WeakMap(),
    alpha: 1,
    /** How many entities the last frame drew snapped rather than blended. */
    snapped: 0,
    blended: 0,
    /**
     * Set by a suite: record what was actually DRAWN, inside the swap window.
     *
     * Off by default because it allocates. There is no other way to see the
     * drawn position from outside -- the whole point of swap-and-restore is
     * that it is gone again by the time the frame returns.
     */
    record: false,
    drawn: [],
  };
}

/**
 * Remember where everything is, immediately BEFORE a fixed step.
 *
 * Call it inside the accumulator loop, not once per frame: a frame that steps
 * the world twice must leave behind the state from before the SECOND step, or
 * the next frame blends across two steps of motion.
 */
export function capture(it, state) {
  const ents = it.entities(state);
  if (!ents) return;
  for (const e of ents) {
    if (!e) continue;
    let p = it.prev.get(e);
    if (!p) { p = {}; it.prev.set(e, p); }
    for (const f of it.fields) p[f] = e[f];
    for (const a of it.angles) p[a] = e[a];
    p.had = true;
  }
}

/**
 * Draw `fn` with every entity moved to where it should appear at `alpha`.
 *
 * The simulation values are restored before this returns, including when `fn`
 * throws -- a renderer that threw half way through and left blended positions
 * behind would feed them back into the next step, which is the one way this
 * technique can corrupt a simulation.
 */
export function drawAt(it, state, alpha, fn) {
  const a = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha;
  it.alpha = a;
  it.snapped = 0;
  it.blended = 0;
  if (a >= 1) {
    // The end of a step: the live state IS what gets drawn, so there is
    // nothing to swap. It still has to be RECORDED when a suite is watching,
    // or `drawn` holds the previous call's values and a check comparing
    // against it silently measures the wrong frame -- which is exactly what
    // made StarBrawl's half-way assertion fail on a correct blend.
    record(it, state);
    return fn();
  }
  const touched = [];
  try {
    for (const e of it.entities(state) || []) {
      if (!e) continue;
      const p = it.prev.get(e);
      if (!p || !p.had) continue;       // new this step: no previous self
      let d2 = 0;
      for (const f of it.fields) { const d = e[f] - p[f]; d2 += d * d; }
      if (!(d2 <= it.snap2)) { it.snapped += 1; continue; }   // NaN-safe
      let spun = false;
      for (const g of it.angles) {
        const d = Math.abs(Math.atan2(Math.sin(e[g] - p[g]), Math.cos(e[g] - p[g])));
        if (!(d <= it.angleSnap)) { spun = true; break; }
      }
      if (spun) { it.snapped += 1; continue; }
      let saved = it.live.get(e);
      if (!saved) { saved = {}; it.live.set(e, saved); }
      for (const f of it.fields) { saved[f] = e[f]; e[f] = p[f] + (e[f] - p[f]) * a; }
      for (const g of it.angles) { saved[g] = e[g]; e[g] = shortestLerp(p[g], e[g], a); }
      touched.push(e);
      it.blended += 1;
    }
    record(it, state);
    return fn();
  } finally {
    for (const e of touched) {
      const saved = it.live.get(e);
      for (const f of it.fields) e[f] = saved[f];
      for (const g of it.angles) e[g] = saved[g];
    }
  }
}

/** Shortest-arc angle blend. */
function shortestLerp(from, to, t) {
  const d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + d * t;
}

/**
 * Record what is about to be drawn, for a suite. Called inside the swap window.
 *
 * EVERY entity that has a previous self, in the order `entities` returns them,
 * whether it was blended or snapped. Recording only the blended ones gave a
 * different-length list at alpha 1 than at alpha 0.5 -- 10 against 9 on a raft
 * with one body snapped -- so a check zipping the two compared different
 * entities to each other and reported nonsense.
 */
function record(it, state) {
  if (!it.record) return;
  it.drawn.length = 0;
  for (const e of it.entities(state) || []) {
    if (!e) continue;
    const p = it.prev.get(e);
    if (!p || !p.had) continue;
    const row = {};
    for (const f of it.fields) row[f] = e[f];
    for (const g of it.angles) row[g] = e[g];
    it.drawn.push(row);
  }
}
