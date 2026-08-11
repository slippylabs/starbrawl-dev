import * as C from './constants.js';
import { getCharacter } from './characters.js';
import { getStage } from './stages.js';

// ---------------------------------------------------------------------------
// Pure, deterministic fixed-timestep simulation. tick(match, inputs) advances
// exactly one 1/60s frame given the current match state and this frame's two
// InputFrames. Given identical starting state + identical input streams, two
// independent calls to tick() must produce identical results — this is the
// property netplay.js's lockstep sync depends on. No Math.random, no
// wall-clock reads, no non-deterministic iteration order anywhere below.
// ---------------------------------------------------------------------------

const AUTO_ANGLE = 361;

export function createFighter(charId, index, spawn, facing) {
  const char = getCharacter(charId);
  return {
    id: index,
    charId,
    char,
    x: spawn.x, y: spawn.y,
    vx: 0, vy: 0,
    facing,
    percent: 0,
    stocks: 3,
    kos: 0, deaths: 0,
    state: 'idle',
    stateFrame: 0,
    grounded: true,
    airJumpsLeft: char.airJumps,
    fastFalling: false,
    shieldHP: C.SHIELD_MAX,
    currentMove: null,
    hitstunFrames: 0,
    hitstopFrames: 0,
    invincibleFrames: 0,
    intangibleFrames: 0,
    movementOverride: null,
    ledgeCooldown: 0,
    grabTarget: -1,
    grabbedBy: -1,
    grabTimer: 0,
    dead: false,
    respawnTimer: 0,
    lastAttacker: -1,
    diApplied: false,
  };
}

export function createMatch({ stageId, charIds, mode, stockCount, timeLimitSeconds }) {
  const stage = getStage(stageId);
  const fighters = [
    createFighter(charIds[0], 0, stage.spawns[0], 1),
    createFighter(charIds[1], 1, stage.spawns[1], -1),
  ];
  if (mode === 'stock') {
    fighters.forEach((f) => { f.stocks = stockCount; });
  }
  return {
    stage,
    fighters,
    projectiles: [],
    frame: 0,
    mode, // 'stock' | 'timed'
    stockCount,
    timeLimitFrames: mode === 'timed' ? timeLimitSeconds * C.SIM_HZ : Infinity,
    over: false,
    winnerIndex: -1,
    hitFx: [], // transient visual events for the renderer, cleared each frame after render reads them
  };
}

function opponentOf(match, fighter) { return match.fighters[1 - fighter.id]; }

function mag(sx, sy) { return Math.hypot(sx, sy); }

function hurtRect(f) {
  const w = f.char.size.w, h = f.char.size.h;
  return { x: f.x - w / 2, y: f.y - h, w, h };
}

function hitboxWorldRect(f, hb) {
  const ox = f.facing >= 0 ? hb.x : -(hb.x + hb.w);
  return { x: f.x + ox, y: f.y + hb.y, w: hb.w, h: hb.h };
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function setState(f, state) { f.state = state; f.stateFrame = 0; }

// --- physics -----------------------------------------------------------

// Picks the surface (main ground or a floater platform) the fighter's feet
// actually crossed this frame: a candidate qualifies only if its x-range
// contains the fighter AND its y lies between where the fighter's feet were
// before this frame's vertical move and where they are now (prevY <= p.y <=
// f.y) — i.e. falling down onto it. That inequality is one-directional by
// design: rising up through a platform (f.y < p.y <= prevY) never qualifies,
// which is what gives platforms their pass-through-from-below behavior for
// free. Ground is just another candidate here, not a priority short-circuit,
// so a platform hovering entirely inside the ground's x-footprint (the
// common case) is no longer shadowed by the ground underneath it. When
// multiple surfaces qualify (rare — stacked platforms), the topmost (lowest
// y) one wins, matching "you land on what you hit first while falling."
function groundBeneath(stage, f, prevY) {
  const candidates = [stage.ground, ...stage.platforms];
  let best = null;
  for (const p of candidates) {
    if (f.x < p.x || f.x > p.x + p.w) continue;
    if (prevY <= p.y + 0.01 && f.y >= p.y - 0.01) {
      if (!best || p.y < best.y) best = p;
    }
  }
  return best;
}

function applyPhysics(f, stage) {
  const prevY = f.y;
  if (f.movementOverride) {
    const m = f.movementOverride;
    if (m.vx !== undefined) f.vx = m.decay ? f.vx + (m.vx * f.facing - f.vx) * 0.4 : m.vx * f.facing;
    if (m.vy !== undefined && m.framesLeft === m.totalFrames) f.vy = m.vy;
    if (!m.cancelGravity) f.vy += (m.floaty ? C.GRAVITY * 0.35 : C.GRAVITY);
    m.framesLeft -= 1;
    if (m.framesLeft <= 0) f.movementOverride = null;
  } else if (!f.grounded) {
    f.vy += C.GRAVITY;
    const cap = f.fastFalling ? C.FASTFALL_SPEED : C.MAX_FALL_SPEED;
    if (f.vy > cap) f.vy = cap;
  }

  f.x += f.vx;
  f.y += f.vy;

  // Ground collision: only from above, only while moving downward.
  const plat = groundBeneath(stage, f, prevY);
  if (plat && f.vy >= 0 && f.y >= plat.y) {
    f.y = plat.y;
    f.vy = 0;
    f.grounded = true;
    f.fastFalling = false;
    f.airJumpsLeft = f.char.airJumps;
  } else {
    f.grounded = false;
  }

  if (f.grounded && f.movementOverride === null) {
    f.vx *= (1 - C.GROUND_FRICTION * 0.3);
  } else if (!f.grounded) {
    f.vx *= (1 - C.AIR_FRICTION);
  }
}

function ledgeCheck(f, stage) {
  if (f.grounded || f.vy <= 0 || f.ledgeCooldown > 0 || f.movementOverride) return;
  const g = stage.ground;
  const edges = [{ x: g.x, y: g.y }, { x: g.x + g.w, y: g.y }];
  for (const e of edges) {
    if (Math.abs(f.x - e.x) < C.LEDGE_GRAB_RANGE_X && Math.abs(f.y - e.y) < C.LEDGE_GRAB_RANGE_Y) {
      f.x = e.x + (e.x === g.x ? -14 : 14);
      f.y = e.y;
      f.vx = 0; f.vy = 0;
      f.grounded = false;
      f.intangibleFrames = C.LEDGE_INVINCIBLE_FRAMES;
      setState(f, 'ledge-hang');
      return;
    }
  }
}

function blastCheck(match, f) {
  const b = match.stage.blast;
  if (f.x < b.left || f.x > b.right || f.y < b.top || f.y > b.bottom) {
    killFighter(match, f);
  }
}

function killFighter(match, f) {
  if (f.state === 'dead') return;
  f.deaths += 1;
  const attacker = f.lastAttacker >= 0 ? match.fighters[f.lastAttacker] : null;
  if (attacker) attacker.kos += 1;
  if (match.mode === 'stock') {
    f.stocks = Math.max(0, f.stocks - 1);
  }
  f.percent = 0;
  f.vx = 0; f.vy = 0;
  f.movementOverride = null;
  f.currentMove = null;
  setState(f, 'dead');
  f.respawnTimer = C.RESPAWN_DELAY_FRAMES;
  match.hitFx.push({ type: 'ko', x: f.x, y: f.y, owner: f.id });
}

function respawnFighter(f, match) {
  const spawn = match.stage.spawns[f.id];
  f.x = spawn.x; f.y = spawn.y;
  f.vx = 0; f.vy = 0;
  f.grounded = false;
  f.airJumpsLeft = f.char.airJumps;
  f.shieldHP = C.SHIELD_MAX;
  f.invincibleFrames = C.RESPAWN_INVINCIBLE_FRAMES;
  f.lastAttacker = -1;
  setState(f, 'airborne');
}

// --- knockback / hits ---------------------------------------------------

function resolveAngle(hb, attacker, defender, kb) {
  let deg;
  if (hb.angle === AUTO_ANGLE) {
    deg = defender.grounded && kb < C.LAUNCH_KB_THRESHOLD ? 22 : 42;
  } else {
    deg = hb.angle;
  }
  // Mirror horizontal-ish angles by attacker facing (angles are authored
  // assuming the attacker faces right).
  if (attacker.facing < 0 && deg !== 90 && deg !== 270) {
    deg = (180 - deg + 360) % 360;
  }
  return deg;
}

function applyDI(deg, defender) {
  // Simple one-shot DI: bias the launch angle toward the held stick at the
  // instant of the hit, clamped to a modest cone so it influences survival
  // without letting the defender fully invert a hit.
  const sx = defender._diSx || 0, sy = defender._diSy || 0;
  if (Math.abs(sx) < 0.2 && Math.abs(sy) < 0.2) return deg;
  const rad = (deg * Math.PI) / 180;
  const trajX = Math.cos(rad), trajY = -Math.sin(rad);
  const cross = trajX * (-sy) - trajY * sx; // stick component perpendicular to trajectory
  const shift = Math.max(-16, Math.min(16, cross * 16));
  return deg + shift;
}

function applyHit(match, attacker, defender, hb, dmgMult) {
  const damage = hb.damage * (dmgMult || 1);
  const newPercent = Math.round((defender.percent + damage) * 10) / 10;
  const weightTerm = 200 / (defender.char.weight + 100);
  const kb = ((newPercent / 10 + (newPercent * damage) / 20) * weightTerm * 1.4 + 18) * (hb.kbGrowth / 100) + hb.kbBase;

  let deg = resolveAngle(hb, attacker, defender, kb);
  deg = applyDI(deg, defender);
  const rad = (deg * Math.PI) / 180;
  const velocity = kb * 0.105;

  defender.percent = newPercent;
  defender.vx = Math.cos(rad) * velocity;
  defender.vy = -Math.sin(rad) * velocity;
  defender.grounded = false;
  defender.movementOverride = null;
  defender.currentMove = null;
  defender.lastAttacker = attacker.id;
  defender.hitstunFrames = Math.max(4, Math.round(kb * C.HITSTUN_FACTOR));
  setState(defender, 'hitstun');

  const hitstop = Math.min(16, Math.round(damage * 0.6) + 2);
  attacker.hitstopFrames = Math.max(attacker.hitstopFrames, hitstop);
  defender.hitstopFrames = Math.max(defender.hitstopFrames, hitstop);

  match.hitFx.push({ type: 'hit', x: defender.x, y: defender.y - defender.char.size.h / 2, owner: attacker.id, damage });
}

function fighterIsIntangible(f) {
  return f.invincibleFrames > 0 || f.intangibleFrames > 0;
}

function processMoveHitboxes(match, attacker) {
  const move = attacker.currentMove;
  if (!move) return;
  const defender = opponentOf(match, attacker);
  const data = move.data;
  const relFrame = move.frame;
  for (const hb of data.hitboxes || []) {
    const activeStart = hb.frame;
    const activeEnd = hb.frame + (data.active || 1);
    if (relFrame < activeStart || relFrame >= activeEnd) continue;
    const key = hb.multihit ? `${data.name || 'm'}-${Math.floor((relFrame - activeStart) / (hb.hitInterval || 6))}` : (data.name || 'move');
    if (move.hitKeys.has(key)) continue;
    if (fighterIsIntangible(defender)) continue;
    const world = hitboxWorldRect(attacker, hb);
    const hurt = hurtRect(defender);
    if (overlaps(world, hurt)) {
      move.hitKeys.add(key);
      defender._diSx = 0; defender._diSy = 0; // set by caller with fresh input each frame before this runs
      applyHit(match, attacker, defender, hb, move.chargeMult);
    }
  }
}

// --- move selection ------------------------------------------------------

function pickGroundedAttack(f, input) {
  const m = f.char.moves;
  const sx = input.sx, sy = input.sy, magni = mag(sx, sy);
  if (f.state === 'run' && magni < 0.3) return { key: 'dashAttack', data: m.dashAttack };
  if (magni < 0.3) return { key: 'jab', data: m.jab };
  if (Math.abs(sy) > Math.abs(sx)) {
    if (sy < 0) return magni >= 0.85 ? { key: 'usmash', data: m.usmash } : { key: 'utilt', data: m.utilt };
    return magni >= 0.85 ? { key: 'dsmash', data: m.dsmash } : { key: 'dtilt', data: m.dtilt };
  }
  if (Math.abs(sx) > 0.3) f.facing = sx > 0 ? 1 : -1;
  return magni >= 0.85 ? { key: 'fsmash', data: m.fsmash } : { key: 'ftilt', data: m.ftilt };
}

function pickAerialAttack(f, input) {
  const m = f.char.moves;
  const sx = input.sx, sy = input.sy;
  if (mag(sx, sy) < 0.3) return { key: 'nair', data: m.nair };
  if (Math.abs(sy) > Math.abs(sx)) return sy < 0 ? { key: 'uair', data: m.uair } : { key: 'dair', data: m.dair };
  const towardFacing = (sx > 0 ? 1 : -1) === f.facing;
  return towardFacing ? { key: 'fair', data: m.fair } : { key: 'bair', data: m.bair };
}

function pickSpecial(f, input) {
  const m = f.char.moves;
  const sx = input.sx, sy = input.sy;
  if (sy < -0.5 && Math.abs(sy) > Math.abs(sx)) return { key: 'upSpecial', data: m.upSpecial };
  if (sy > 0.5 && Math.abs(sy) > Math.abs(sx) && m.downSpecial) return { key: 'downSpecial', data: m.downSpecial };
  if (Math.abs(sx) > 0.5) return { key: 'sideSpecial', data: m.sideSpecial };
  return { key: 'neutralSpecial', data: m.neutralSpecial };
}

function beginMove(f, picked, chargeMult) {
  if (!picked || !picked.data) return false;
  f.currentMove = { key: picked.key, data: picked.data, frame: 0, hitKeys: new Set(), chargeMult: chargeMult || 1 };
  if (picked.data.movement) {
    f.movementOverride = Object.assign({ framesLeft: picked.data.movement.frames, totalFrames: picked.data.movement.frames }, picked.data.movement);
  }
  setState(f, 'attack');
  return true;
}

// --- per-state handlers ---------------------------------------------------

function handleGrounded(f, input, match) {
  f.stateFrame += 1;
  const speed = f.state === 'run' ? f.char.runSpeed : f.char.walkSpeed;
  const target = input.sx * speed;
  f.vx += (target - f.vx) * 0.4;
  if (Math.abs(input.sx) > 0.15) f.facing = input.sx > 0 ? 1 : -1;

  if (Math.abs(f.vx) > f.char.walkSpeed * 0.7 && Math.abs(input.sx) > 0.85) { if (f.state !== 'run') setState(f, 'run'); }
  else if (f.state === 'run' && Math.abs(input.sx) < 0.2) { if (f.state !== 'idle') setState(f, 'idle'); }
  else if (Math.abs(input.sx) > 0.15) { if (f.state !== 'walk') setState(f, 'walk'); }
  else { if (f.state !== 'idle') setState(f, 'idle'); }

  if (input.jp) { setState(f, 'jumpsquat'); return; }
  if (input.gp) { attemptGrab(f, match); return; }
  if (input.spp) { if (beginMove(f, pickSpecial(f, input), 1)) return; }
  if (input.ap) { if (beginMove(f, pickGroundedAttack(f, input), 1)) return; }
  if (input.sh) { setState(f, 'shield'); return; }
}

function handleJumpsquat(f, input) {
  f.stateFrame += 1;
  if (f.stateFrame >= C.JUMPSQUAT_FRAMES) {
    f.vy = -f.char.jumpVelocity;
    f.grounded = false;
    setState(f, 'airborne');
  }
}

function handleAirborne(f, input, match) {
  const target = input.sx * f.char.airSpeed;
  f.vx += (target - f.vx) * 0.12;
  if (Math.abs(input.sx) > 0.15) f.facing = input.sx > 0 ? 1 : -1;

  if (input.jp && f.airJumpsLeft > 0) {
    f.airJumpsLeft -= 1;
    f.vy = -f.char.doubleJumpVelocity;
  }
  if (input.d && f.vy > 0 && !f.fastFalling) f.fastFalling = true;
  if (input.sh) { setState(f, 'airdodge'); f.airdodgeDir = { x: input.sx, y: input.sy }; return; }
  if (input.spp) { if (beginMove(f, pickSpecial(f, input), 1)) return; }
  if (input.ap) { if (beginMove(f, pickAerialAttack(f, input), 1)) return; }
  ledgeCheck(f, match.stage);
}

function handleAttack(f, input, match) {
  const move = f.currentMove;
  if (!move) { setState(f, f.grounded ? 'idle' : 'airborne'); return; }
  move.frame += 1;
  f._diSx = input.sx; f._diSy = input.sy;
  processMoveHitboxes(match, f);
  const data = move.data;
  const total = (data.startup || 1) + (data.active || 1) + (data.endlag || 1);
  if (move.frame >= total) {
    f.currentMove = null;
    f.movementOverride = null;
    setState(f, f.grounded ? 'idle' : 'airborne');
  }
}

function handleShield(f, input, match) {
  if (!input.sh) { setState(f, 'idle'); return; }
  f.shieldHP -= C.SHIELD_DRAIN;
  if (f.shieldHP <= 0) {
    f.shieldHP = 0;
    setState(f, 'shieldstun');
    return;
  }
  if (Math.abs(input.sx) > 0.7 && f.stateFrame > 2) {
    f.vx = C.ROLL_SPEED * (input.sx > 0 ? 1 : -1);
    setState(f, 'roll');
    return;
  }
  if (input.d && f.stateFrame > 2) { setState(f, 'spotdodge'); return; }
}

function handleShieldstun(f) {
  f.stateFrame += 1;
  f.shieldHP = Math.min(C.SHIELD_MAX, f.shieldHP + C.SHIELD_REGEN);
  if (f.stateFrame >= C.SHIELD_STUN_FRAMES) setState(f, 'idle');
}

function handleSpotdodge(f) {
  f.stateFrame += 1;
  f.intangibleFrames = (f.stateFrame >= C.SPOTDODGE_INTANGIBLE[0] && f.stateFrame <= C.SPOTDODGE_INTANGIBLE[1]) ? 1 : 0;
  if (f.stateFrame >= C.SPOTDODGE_FRAMES) setState(f, 'idle');
}

function handleRoll(f) {
  f.stateFrame += 1;
  f.vx *= 0.9;
  f.intangibleFrames = (f.stateFrame >= C.ROLL_INTANGIBLE[0] && f.stateFrame <= C.ROLL_INTANGIBLE[1]) ? 1 : 0;
  if (f.stateFrame >= C.ROLL_FRAMES) setState(f, 'idle');
}

function handleAirdodge(f) {
  f.stateFrame += 1;
  if (f.stateFrame === 1) {
    const d = f.airdodgeDir || { x: 0, y: 0 };
    const m = mag(d.x, d.y);
    if (m > 0.2) { f.vx = (d.x / m) * C.AIRDODGE_SPEED; f.vy = (d.y / m) * C.AIRDODGE_SPEED; }
    else { f.vx = 0; f.vy = 0; }
  }
  f.vx *= 0.94; f.vy *= 0.94;
  f.intangibleFrames = (f.stateFrame >= C.AIRDODGE_INTANGIBLE[0] && f.stateFrame <= C.AIRDODGE_INTANGIBLE[1]) ? 1 : 0;
  if (f.stateFrame >= C.AIRDODGE_FRAMES) setState(f, f.grounded ? 'idle' : 'airborne');
}

function handleHitstun(f) {
  f.hitstunFrames -= 1;
  if (f.hitstunFrames <= 0) setState(f, f.grounded ? 'idle' : 'airborne');
}

function handleLedgeHang(f, input) {
  f.stateFrame += 1;
  if (f.intangibleFrames > 0) f.intangibleFrames -= 1;
  if (input.jp) {
    f.vy = -f.char.jumpVelocity * 0.9;
    f.grounded = false;
    f.ledgeCooldown = C.LEDGE_REGRAB_COOLDOWN;
    setState(f, 'airborne');
  } else if (input.ap || input.u) {
    f.x += f.facing * 30;
    f.y -= 4;
    f.grounded = true;
    f.vx = 0; f.vy = 0;
    f.invincibleFrames = 12;
    f.ledgeCooldown = C.LEDGE_REGRAB_COOLDOWN;
    setState(f, 'idle');
  } else if (input.d) {
    f.grounded = false;
    f.ledgeCooldown = C.LEDGE_REGRAB_COOLDOWN;
    setState(f, 'airborne');
  }
}

function attemptGrab(f, match) {
  f.currentMove = { key: 'grab', data: { startup: C.GRAB_STARTUP, active: 3, endlag: C.GRAB_ENDLAG, hitboxes: [] }, frame: 0, hitKeys: new Set() };
  f.vx = 0; f.vy = 0;
  setState(f, 'grabbing');
}

function handleGrabbing(f, input, match) {
  f.stateFrame += 1;
  f.vx = 0; f.vy = 0;
  const defender = opponentOf(match, f);
  if (f.stateFrame === C.GRAB_STARTUP) {
    const reach = { x: f.facing >= 0 ? f.x : f.x - C.GRAB_RANGE, y: f.y - f.char.size.h, w: C.GRAB_RANGE, h: f.char.size.h };
    if (!fighterIsIntangible(defender) && overlaps(reach, hurtRect(defender)) && defender.state !== 'grabbed') {
      f.grabTarget = defender.id;
      defender.grabbedBy = f.id;
      defender.vx = 0; defender.vy = 0; defender.movementOverride = null; defender.currentMove = null;
      setState(defender, 'grabbed');
      setState(f, 'grabbing-hold');
      f.grabTimer = 0;
      return;
    }
  }
  if (f.stateFrame >= C.GRAB_STARTUP + C.GRAB_ENDLAG) setState(f, f.grounded ? 'idle' : 'airborne');
}

function handleGrabbingHold(f, input, match) {
  f.grabTimer += 1;
  f.vx = 0; f.vy = 0;
  const defender = match.fighters[f.grabTarget];
  if (!defender || defender.state !== 'grabbed') { setState(f, f.grounded ? 'idle' : 'airborne'); return; }
  defender.x = f.x + f.facing * 30;
  const wantThrow = Math.abs(input.sx) > 0.5 || Math.abs(input.sy) > 0.5 || f.grabTimer > 40;
  if (wantThrow) {
    const t = f.char.moves.throw;
    let angle, damage, kbBase, kbGrowth;
    if (input.sy < -0.5) { ({ damage, kbBase, kbGrowth } = t.fwd); angle = 85; }
    else if (input.sy > 0.5) { ({ damage, kbBase, kbGrowth } = t.fwd); angle = 270; }
    else if (input.sx < -0.5 * f.facing) { ({ damage, kbBase, kbGrowth } = t.back); angle = 165; }
    else { ({ damage, kbBase, kbGrowth } = t.fwd); angle = 20; }
    applyHit(match, f, defender, { damage, kbBase, kbGrowth, angle }, 1);
    // applyHit already set a damage-scaled hitstop on both fighters, but a
    // throw's release deserves a more deliberate, fixed freeze beat than a
    // grazing jab would get — this is the "stuck in place for a moment"
    // pause before the thrown fighter actually flies off.
    f.hitstopFrames = Math.max(f.hitstopFrames, C.THROW_HITSTOP_FRAMES);
    defender.hitstopFrames = Math.max(defender.hitstopFrames, C.THROW_HITSTOP_FRAMES);
    defender.grabbedBy = -1;
    f.grabTarget = -1;
    setState(f, f.grounded ? 'idle' : 'airborne');
  }
}

function handleGrabbed(f) {
  f.vx = 0;
  if (f.grabbedBy < 0) setState(f, f.grounded ? 'idle' : 'airborne');
}

function handleDead(f, input, match) {
  f.respawnTimer -= 1;
  if (f.respawnTimer <= 0) respawnFighter(f, match);
}

const HANDLERS = {
  idle: handleGrounded, walk: handleGrounded, run: handleGrounded,
  jumpsquat: handleJumpsquat,
  airborne: handleAirborne,
  attack: handleAttack,
  shield: handleShield,
  shieldstun: handleShieldstun,
  spotdodge: handleSpotdodge,
  roll: handleRoll,
  airdodge: handleAirdodge,
  hitstun: handleHitstun,
  'ledge-hang': handleLedgeHang,
  grabbing: handleGrabbing,
  'grabbing-hold': handleGrabbingHold,
  grabbed: handleGrabbed,
  dead: handleDead,
};

function tickProjectiles(match) {
  for (const p of match.projectiles) {
    p.x += p.vx;
    p.life -= 1;
    const defender = match.fighters[1 - p.owner];
    if (!fighterIsIntangible(defender) && overlaps({ x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h }, hurtRect(defender))) {
      applyHit(match, match.fighters[p.owner], defender, { damage: p.damage, kbBase: p.kbBase, kbGrowth: p.kbGrowth, angle: p.angle }, 1);
      p.life = 0;
    }
    if (p.x < match.stage.blast.left || p.x > match.stage.blast.right) p.life = 0;
  }
  match.projectiles = match.projectiles.filter((p) => p.life > 0);
}

function spawnProjectileIfNeeded(f, match) {
  const move = f.currentMove;
  if (!move || !move.data.projectile || move.launchedProjectile) return;
  if (move.frame !== move.data.hitboxes[0].frame) return;
  const pr = move.data.projectile;
  const hb = move.data.hitboxes[0];
  move.launchedProjectile = true;
  match.projectiles.push({
    x: f.x + (f.facing >= 0 ? hb.x : -hb.x), y: f.y + hb.y,
    vx: pr.speed * f.facing, life: pr.life, w: pr.w, h: pr.h,
    damage: hb.damage, kbBase: hb.kbBase, kbGrowth: hb.kbGrowth, angle: hb.angle, owner: f.id,
  });
  move.hitKeys.add('move'); // the melee hitbox on a projectile move only fires the projectile, not a direct-contact hit
}

export function tick(match, inputs) {
  if (match.over) return;
  match.frame += 1;
  match.hitFx = [];

  for (let i = 0; i < 2; i += 1) {
    const f = match.fighters[i];
    const input = inputs[i];
    f._diSx = input.sx; f._diSy = input.sy;

    if (f.hitstopFrames > 0) { f.hitstopFrames -= 1; continue; }
    if (f.invincibleFrames > 0) f.invincibleFrames -= 1;
    if (f.ledgeCooldown > 0) f.ledgeCooldown -= 1;
    if (f.state !== 'spotdodge' && f.state !== 'roll' && f.state !== 'airdodge' && f.state !== 'ledge-hang') f.intangibleFrames = 0;

    const handler = HANDLERS[f.state] || handleGrounded;
    handler(f, input, match);
    if (f.currentMove && f.currentMove.data.projectile) spawnProjectileIfNeeded(f, match);

    if (f.state !== 'dead' && f.state !== 'ledge-hang') {
      applyPhysics(f, match.stage);
      blastCheck(match, f);
    }
  }

  tickProjectiles(match);

  if (match.mode === 'timed' && match.frame >= match.timeLimitFrames) {
    match.over = true;
    const [a, b] = match.fighters;
    match.winnerIndex = a.kos - a.deaths === b.kos - b.deaths ? -1 : (a.kos - a.deaths > b.kos - b.deaths ? 0 : 1);
  } else if (match.mode === 'stock') {
    const loser = match.fighters.find((f) => f.stocks <= 0 && f.state === 'dead');
    if (loser) { match.over = true; match.winnerIndex = 1 - loser.id; }
  }
}
