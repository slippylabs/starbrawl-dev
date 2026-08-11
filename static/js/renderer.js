import { STAGE_W, STAGE_H } from './constants.js';

// Canvas is always drawn in a fixed 1280x720 logical space; main.js scales
// the canvas element to fit the viewport while preserving aspect ratio, so
// this module never has to think about screen size.

let particles = [];

export function pushHitFx(events) {
  for (const e of events) {
    if (e.type === 'hit') {
      for (let i = 0; i < 6; i += 1) {
        particles.push({ x: e.x, y: e.y, vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 6 - 1, life: 16, max: 16 });
      }
    } else if (e.type === 'ko') {
      for (let i = 0; i < 14; i += 1) {
        particles.push({ x: e.x, y: e.y, vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10, life: 26, max: 26 });
      }
    }
  }
}

function stepParticles() {
  for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vy += 0.2; p.life -= 1; }
  particles = particles.filter((p) => p.life > 0);
}

function drawBackground(ctx, stage) {
  ctx.fillStyle = stage.bg;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  ctx.save();
  ctx.strokeStyle = 'rgba(57,255,143,0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < STAGE_W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, STAGE_H); ctx.stroke(); }
  for (let y = 0; y < STAGE_H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(STAGE_W, y); ctx.stroke(); }
  ctx.restore();
}

function drawPlatform(ctx, plat, solid) {
  ctx.fillStyle = solid ? '#0c1a16' : 'rgba(57,255,143,0.10)';
  ctx.strokeStyle = '#39ff8f';
  ctx.lineWidth = solid ? 3 : 2;
  ctx.globalAlpha = solid ? 1 : 0.85;
  if (solid) {
    ctx.fillRect(plat.x, plat.y, plat.w, plat.h);
    ctx.strokeRect(plat.x, plat.y, plat.w, plat.h);
  } else {
    ctx.beginPath();
    ctx.moveTo(plat.x, plat.y);
    ctx.lineTo(plat.x + plat.w, plat.y);
    ctx.stroke();
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(plat.x, plat.y, plat.w, plat.h);
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

function drawStage(ctx, stage) {
  drawBackground(ctx, stage);
  drawPlatform(ctx, stage.ground, true);
  for (const p of stage.platforms) drawPlatform(ctx, p, false);
}

// ---------------------------------------------------------------------------
// Articulated fighter rendering. Every fighter is built from the same rig
// (head / torso / two 2-segment arms / two 2-segment legs) sized off the
// character's stat block, then dressed with one of three archetype "kits"
// (brute / blade / wisp) so the three current characters read as distinct
// silhouettes at a glance rather than recolored stick figures. A character
// with no matching archetype still renders — just without the bespoke
// flourishes — so adding a roster entry never requires touching this file.
// ---------------------------------------------------------------------------

// Smooth single-stroke limb: the "joint" (kx,ky) is a quadratic-curve
// control point rather than a hard vertex, so the limb reads as one fluid
// curved line instead of two straight segments meeting at a visible kink.
function limb(ctx, x0, y0, kx, ky, x1, y1, thick, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = thick;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(kx, ky, x1, y1);
  ctx.stroke();
}

// Computes a rig geometry description shared by every state-specific pose.
function rigMetrics(w, h, squash) {
  const legLen = h * 0.40;
  const torsoLen = h * 0.36 * squash;
  const hipY = -legLen;
  const shoulderY = hipY - torsoLen;
  const headR = Math.max(9, Math.min(17, w * 0.24));
  const headY = shoulderY - headR - 2;
  const thick = Math.max(5, w * 0.12);
  return { legLen, torsoLen, hipY, shoulderY, headR, headY, thick };
}

// Move-key -> attack-telegraph visual descriptor (arc sweep, ring, or a
// pulsing burst for specials, so specials read as visually distinct from
// normal attacks, not just mechanically distinct).
const TELEGRAPH = {
  jab: { shape: 'arc', dir: 'fwd', span: 0.5, r: 0.62 },
  ftilt: { shape: 'arc', dir: 'fwd', span: 0.65, r: 0.85 },
  dtilt: { shape: 'arc', dir: 'down', span: 0.6, r: 0.7 },
  utilt: { shape: 'arc', dir: 'up', span: 0.6, r: 0.85 },
  dashAttack: { shape: 'arc', dir: 'fwd', span: 0.55, r: 0.9 },
  fsmash: { shape: 'arc', dir: 'fwd', span: 0.95, r: 1.15, big: true },
  usmash: { shape: 'arc', dir: 'up', span: 0.9, r: 1.15, big: true },
  dsmash: { shape: 'arc', dir: 'both', span: 0.7, r: 0.95, big: true },
  nair: { shape: 'ring', r: 0.75 },
  fair: { shape: 'arc', dir: 'fwd', span: 0.7, r: 0.9 },
  bair: { shape: 'arc', dir: 'back', span: 0.7, r: 0.9 },
  uair: { shape: 'arc', dir: 'up', span: 0.7, r: 0.9 },
  dair: { shape: 'arc', dir: 'down', span: 0.7, r: 0.9 },
  neutralSpecial: { shape: 'burst' },
  sideSpecial: { shape: 'burst' },
  upSpecial: { shape: 'burst' },
  downSpecial: { shape: 'burst' },
};

function drawTelegraph(ctx, f, w, h, m, color) {
  const move = f.currentMove;
  if (!move) return;
  const spec = TELEGRAPH[move.key];
  if (!spec) return;
  const data = move.data;
  const startup = data.startup || 1, active = data.active || 1, endlag = data.endlag || 1;
  const frame = move.frame;
  if (frame > startup + active + Math.min(6, endlag)) return;

  const chargeMult = move.chargeMult || 1;
  const inActive = frame >= startup && frame < startup + active;
  const startupProg = Math.min(1, frame / Math.max(1, startup));
  const fadeProg = frame >= startup + active ? 1 - (frame - startup - active) / Math.max(1, Math.min(6, endlag)) : 1;
  const originX = 0, originY = m.shoulderY + m.torsoLen * 0.15;

  ctx.save();
  if (spec.shape === 'burst') {
    const alpha = (inActive ? 0.85 : 0.35 * startupProg) * fadeProg;
    const radius = (spec.big ? 0.5 : 0.4) * w * (inActive ? 1.15 : 0.6 + startupProg * 0.4);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(originX, originY, radius, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = Math.max(0, alpha * 0.5);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(originX, originY, radius * 1.25, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    return;
  }
  if (!inActive) { ctx.restore(); return; }

  const alpha = 0.7 * fadeProg;
  const radius = spec.r * w * (chargeMult > 1 ? 1 + (chargeMult - 1) * 0.4 : 1);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = spec.big ? '#ffffff' : color;
  ctx.lineWidth = spec.big ? 6 : 4;
  ctx.lineCap = 'round';

  if (spec.shape === 'ring') {
    ctx.beginPath(); ctx.arc(originX, originY, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    return;
  }

  const dirs = spec.dir === 'both' ? ['fwd', 'back'] : [spec.dir];
  for (const dir of dirs) {
    let baseAngle;
    if (dir === 'fwd') baseAngle = 0;
    else if (dir === 'back') baseAngle = Math.PI;
    else if (dir === 'up') baseAngle = -Math.PI / 2;
    else baseAngle = Math.PI / 2; // down
    const a0 = baseAngle - spec.span, a1 = baseAngle + spec.span;
    ctx.beginPath();
    ctx.arc(originX, originY, radius, a0, a1);
    ctx.stroke();
  }
  ctx.restore();
}

// Pose the rig for the fighter's current state. Returns leg/arm endpoints
// (relative to the fighter's ground-contact origin) plus a torso skew and
// head tilt, all consumed by the shared drawing pass below.
function computePose(f, w, h, m, frameCount) {
  const grounded = f.grounded;
  const state = f.state;
  const bob = Math.sin(frameCount * 0.07) * 1.6;
  let legs = { backFoot: { x: -8, y: 0 }, frontFoot: { x: 8, y: 0 }, bend: 6 };
  let arms = { backHand: { x: -w * 0.3, y: m.shoulderY + m.torsoLen * 0.5 }, frontHand: { x: w * 0.32, y: m.shoulderY + m.torsoLen * 0.55 }, bend: 6 };
  let torsoSkew = 0;
  let headTilt = 0;

  if (state === 'run' || state === 'walk') {
    const speed = state === 'run' ? 0.55 : 0.4;
    const phase = f.stateFrame * speed;
    const strideAmt = state === 'run' ? 16 : 10;
    legs = {
      backFoot: { x: -8 - Math.sin(phase) * strideAmt, y: 0 },
      frontFoot: { x: 8 + Math.sin(phase) * strideAmt, y: 0 },
      bend: 10,
    };
    arms = {
      backHand: { x: -w * 0.28 + Math.sin(phase) * 10, y: m.shoulderY + m.torsoLen * 0.6 },
      frontHand: { x: w * 0.3 - Math.sin(phase) * 10, y: m.shoulderY + m.torsoLen * 0.6 },
      bend: 8,
    };
    torsoSkew = Math.max(-0.12, Math.min(0.12, f.vx * 0.02));
  } else if (!grounded && (state === 'airborne' || state === 'jumpsquat' || state === 'ledge-hang')) {
    legs = { backFoot: { x: -6, y: -m.legLen * 0.45 }, frontFoot: { x: 10, y: -m.legLen * 0.3 }, bend: -10 };
    arms = { backHand: { x: -w * 0.22, y: m.shoulderY + 4 }, frontHand: { x: w * 0.26, y: m.shoulderY + 2 }, bend: 4 };
    if (state === 'jumpsquat') {
      const c = Math.min(1, f.stateFrame / 4);
      legs = { backFoot: { x: -10, y: -m.legLen * 0.15 * (1 - c) }, frontFoot: { x: 10, y: -m.legLen * 0.15 * (1 - c) }, bend: 14 };
    }
  } else if (state === 'attack') {
    const move = f.currentMove;
    const key = move ? move.key : 'jab';
    const startup = move ? (move.data.startup || 1) : 1;
    const active = move ? (move.data.active || 1) : 1;
    const prog = move ? Math.min(1, move.frame / (startup + active)) : 0;
    const swing = Math.min(1, prog * 1.4);
    let hx = w * 0.32 + swing * w * 0.5, hy = m.shoulderY + m.torsoLen * 0.5;
    if (key === 'utilt' || key === 'usmash' || key === 'uair' || key === 'upSpecial') { hy = m.shoulderY - swing * h * 0.3; hx = w * 0.12; }
    else if (key === 'dtilt' || key === 'dsmash' || key === 'dair' || key === 'downSpecial') { hy = m.shoulderY + m.torsoLen * 0.8 + swing * h * 0.18; hx = w * 0.28; }
    else if (key === 'bair') { hx = -w * 0.32 - swing * w * 0.5; }
    // A real strike starts cocked (bent) and straightens through extension,
    // so bend shrinks as swing progresses rather than growing with it.
    arms = { backHand: { x: -w * 0.2, y: m.shoulderY + m.torsoLen * 0.5 }, frontHand: { x: hx, y: hy }, bend: Math.max(2, 14 - swing * 11) };
    legs = { backFoot: { x: -8, y: 0 }, frontFoot: { x: 14, y: 0 }, bend: 8 };
    torsoSkew = 0.08 + swing * 0.06;
  } else if (state === 'shield') {
    arms = { backHand: { x: w * 0.14, y: m.shoulderY - 4 }, frontHand: { x: w * 0.22, y: m.shoulderY + 6 }, bend: 4 };
    legs = { backFoot: { x: -12, y: 0 }, frontFoot: { x: 12, y: 0 }, bend: 14 };
  } else if (state === 'spotdodge' || state === 'roll' || state === 'airdodge') {
    const tuck = 10;
    legs = { backFoot: { x: -4, y: -tuck }, frontFoot: { x: 4, y: -tuck }, bend: -12 };
    arms = { backHand: { x: -w * 0.12, y: m.shoulderY + 6 }, frontHand: { x: w * 0.12, y: m.shoulderY + 6 }, bend: 2 };
  } else if (state === 'hitstun') {
    const flail = Math.sin(f.stateFrame * 0.8) * 10;
    arms = { backHand: { x: -w * 0.4 - flail, y: m.shoulderY - 6 }, frontHand: { x: w * 0.4 + flail, y: m.shoulderY + 10 }, bend: 14 };
    legs = { backFoot: { x: -14, y: -6 }, frontFoot: { x: 14, y: 4 }, bend: -6 };
    torsoSkew = Math.max(-0.3, Math.min(0.3, f.vx * 0.04));
    headTilt = torsoSkew * 1.4;
  } else if (state === 'grabbing' || state === 'grabbing-hold') {
    arms = { backHand: { x: -w * 0.2, y: m.shoulderY + m.torsoLen * 0.5 }, frontHand: { x: w * 0.55, y: m.shoulderY + m.torsoLen * 0.55 }, bend: 4 };
    legs = { backFoot: { x: -8, y: 0 }, frontFoot: { x: 16, y: 0 }, bend: 8 };
  } else if (state === 'grabbed') {
    arms = { backHand: { x: w * 0.3, y: m.shoulderY + 8 }, frontHand: { x: w * 0.42, y: m.shoulderY + 16 }, bend: 6 };
    legs = { backFoot: { x: -6, y: -4 }, frontFoot: { x: 6, y: -4 }, bend: 4 };
  } else {
    // idle
    legs = { backFoot: { x: -9, y: 0 }, frontFoot: { x: 9, y: 0 }, bend: 6 };
    arms = {
      backHand: { x: -w * 0.3, y: m.shoulderY + m.torsoLen * 0.55 + bob * 0.3 },
      frontHand: { x: w * 0.3, y: m.shoulderY + m.torsoLen * 0.55 - bob * 0.3 },
      bend: 6,
    };
    torsoSkew = 0;
  }

  return { legs, arms, torsoSkew, headTilt, bob: grounded ? 0 : bob };
}

// Bespoke archetype flourishes layered on top of the shared rig. Each takes
// the already-drawn base figure's key landmarks and adds a few extra shapes.
function decorateBrute(ctx, w, h, m, color, dimColor) {
  ctx.fillStyle = dimColor;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  // pauldrons
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * w * 0.28, m.shoulderY - 2);
    ctx.lineTo(side * w * 0.5, m.shoulderY + 6);
    ctx.lineTo(side * w * 0.4, m.shoulderY + 20);
    ctx.lineTo(side * w * 0.18, m.shoulderY + 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // chest emblem
  ctx.fillStyle = color;
  ctx.save();
  ctx.translate(0, m.shoulderY + m.torsoLen * 0.5);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-5, -5, 10, 10);
  ctx.restore();
  // visor bar
  ctx.fillStyle = '#0a1512';
  ctx.fillRect(-m.headR * 0.7, m.headY - 2, m.headR * 1.4, 4);
}

function decorateBlade(ctx, w, h, m, color, dimColor, frameCount, vx) {
  // trailing cape, wafts opposite of travel direction
  const wave = Math.sin(frameCount * 0.1) * 8;
  const drag = Math.max(-14, Math.min(14, -vx * 1.5));
  ctx.fillStyle = dimColor;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(-w * 0.2, m.shoulderY + 4);
  ctx.quadraticCurveTo(-w * 0.55 + drag, m.shoulderY + m.torsoLen * 0.6 + wave, -w * 0.35 + drag * 1.4, m.hipY + 6 + wave * 0.6);
  ctx.quadraticCurveTo(-w * 0.15, m.hipY - 6, -w * 0.05, m.shoulderY + m.torsoLen * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  // ear fins on head
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * m.headR * 0.6, m.headY - m.headR * 0.6);
    ctx.lineTo(side * m.headR * 1.6, m.headY - m.headR * 1.3);
    ctx.stroke();
  }
  // eye slits
  ctx.fillStyle = color;
  ctx.fillRect(-m.headR * 0.55, m.headY - 2, m.headR * 0.4, 3);
  ctx.fillRect(m.headR * 0.15, m.headY - 2, m.headR * 0.4, 3);
}

function decorateWisp(ctx, w, h, m, color, dimColor, frameCount) {
  // halo
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, m.headY - m.headR - 6, m.headR * 0.9, m.headR * 0.32, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // orbiting motes
  for (let i = 0; i < 2; i += 1) {
    const ang = frameCount * 0.06 + i * Math.PI;
    const rx = w * 0.55, ry = h * 0.22;
    const ox = Math.cos(ang) * rx, oy = m.shoulderY + m.torsoLen * 0.5 + Math.sin(ang) * ry * 0.4;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.arc(ox, oy, 3.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // cloak tail instead of visible legs
  const wob = Math.sin(frameCount * 0.08) * 6;
  ctx.fillStyle = dimColor;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(-w * 0.26, m.hipY);
  ctx.quadraticCurveTo(-w * 0.18 + wob, -6, 0, 2);
  ctx.quadraticCurveTo(w * 0.18 - wob, -6, w * 0.26, m.hipY);
  ctx.quadraticCurveTo(0, m.hipY - 14, -w * 0.26, m.hipY);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

// Core figure draw shared by both the live match renderer and the character
// select portraits. Operates purely in the caller's already-translated
// local space (origin = ground-contact point), so it has no idea whether
// it's drawing a 92px-tall match fighter or a 40px-tall menu portrait.
function drawFighterBody(ctx, f, frameCount) {
  const w = f.char.size.w, h = f.char.size.h;
  const flashing = f.hitstopFrames > 0;
  const squash = f.state === 'jumpsquat' ? 1 - f.stateFrame * 0.05 : 1;
  const m = rigMetrics(w, h, squash);
  const pose = computePose(f, w, h, m, frameCount);
  const bodyColor = flashing ? '#ffffff' : f.char.color;
  const dimColor = f.char.colorDim;
  const archetype = f.char.archetype;
  const isWisp = archetype === 'wisp';

  ctx.save();
  if (!f.grounded && f.state === 'hitstun') ctx.rotate(Math.max(-0.6, Math.min(0.6, f.vx * 0.03)));
  else ctx.rotate(pose.torsoSkew * 0.3);
  ctx.translate(0, pose.bob);

  // back leg (skip for wisp archetype — it gets a cloak tail instead)
  if (!isWisp) {
    limb(ctx,
      -6, m.hipY,
      pose.legs.backFoot.x * 0.6 - pose.legs.bend, (m.hipY + 0) / 2 - 6,
      pose.legs.backFoot.x, pose.legs.backFoot.y,
      m.thick * 0.85, dimColor);
  }

  // back arm
  limb(ctx,
    -w * 0.16, m.shoulderY + 4,
    (pose.arms.backHand.x - w * 0.16) / 2, m.shoulderY + m.torsoLen * 0.3 - pose.arms.bend,
    pose.arms.backHand.x, pose.arms.backHand.y,
    m.thick * 0.7, dimColor);

  // torso
  ctx.save();
  ctx.transform(1, 0, pose.torsoSkew, 1, 0, 0);
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.roundRect(-w * 0.32, m.shoulderY, w * 0.64, m.torsoLen, 8);
  ctx.fill();
  // shading seam
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = dimColor;
  ctx.fillRect(-w * 0.32, m.shoulderY + m.torsoLen * 0.55, w * 0.64, m.torsoLen * 0.45);
  ctx.globalAlpha = 1;
  ctx.restore();

  if (archetype === 'brute') decorateBrute(ctx, w, h, m, bodyColor, dimColor);
  if (archetype === 'blade') decorateBlade(ctx, w, h, m, bodyColor, dimColor, frameCount, f.vx || 0);
  if (archetype === 'wisp') decorateWisp(ctx, w, h, m, bodyColor, dimColor, frameCount);

  // front leg
  if (!isWisp) {
    limb(ctx,
      6, m.hipY,
      pose.legs.frontFoot.x * 0.6 + pose.legs.bend, (m.hipY + 0) / 2 - 6,
      pose.legs.frontFoot.x, pose.legs.frontFoot.y,
      m.thick * 0.95, bodyColor);
  }

  // head
  ctx.save();
  ctx.translate(0, m.headY);
  ctx.rotate(pose.headTilt);
  ctx.fillStyle = bodyColor;
  ctx.beginPath(); ctx.arc(0, 0, m.headR, 0, Math.PI * 2); ctx.fill();
  if (archetype !== 'brute') {
    // simple eye dot pair (brute uses a visor bar drawn in decorateBrute instead)
    ctx.fillStyle = '#0a1512';
    ctx.beginPath(); ctx.arc(m.headR * 0.32, -1, 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  // front arm (drawn last so it reads on top, plus a weapon-trail on hit)
  limb(ctx,
    w * 0.16, m.shoulderY + 6,
    (pose.arms.frontHand.x + w * 0.16) / 2, m.shoulderY + m.torsoLen * 0.35 - pose.arms.bend,
    pose.arms.frontHand.x, pose.arms.frontHand.y,
    m.thick, bodyColor);
  if (archetype === 'blade' && f.state === 'attack') {
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(pose.arms.frontHand.x, pose.arms.frontHand.y);
    ctx.lineTo(pose.arms.frontHand.x + (pose.arms.frontHand.x > 0 ? 22 : -22), pose.arms.frontHand.y - 6);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawTelegraph(ctx, f, w, h, m, bodyColor);

  // shield bubble
  if (f.state === 'shield') {
    ctx.globalAlpha = 0.25 + 0.35 * (f.shieldHP / 60);
    ctx.fillStyle = '#7fd7ff';
    ctx.beginPath();
    ctx.arc(0, m.shoulderY + m.torsoLen * 0.5, 12 + 26 * (f.shieldHP / 60), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

function drawFighter(ctx, f, frameCount) {
  if (f.state === 'dead') return;
  const intangible = f.invincibleFrames > 0 || f.intangibleFrames > 0;
  if (intangible && Math.floor(f.invincibleFrames / 4) % 2 === 0 && f.invincibleFrames > 0) { return; }

  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(f.facing, 1);
  drawFighterBody(ctx, f, frameCount);
  ctx.restore();

  if (f.percent > 100) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.3, (f.percent - 100) / 400);
    ctx.strokeStyle = '#ff4655';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(f.x, f.y - f.char.size.h / 2, f.char.size.w, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

// Static-ish portrait for menus (character select cards/panels). Draws the
// same rig in an idle pose onto a small standalone canvas.
export function drawFighterPortrait(cv, char, frameCount) {
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const fake = {
    char, x: 0, y: 0, vx: 0, vy: 0, facing: 1, percent: 0,
    state: 'idle', stateFrame: Math.floor((frameCount || 0) * 0.7), grounded: true,
    currentMove: null, hitstopFrames: 0, invincibleFrames: 0, intangibleFrames: 0, shieldHP: 60,
  };
  const scale = Math.min(cv.width / (char.size.w * 2.6), cv.height / (char.size.h * 1.5));
  ctx.save();
  ctx.translate(cv.width / 2, cv.height * 0.88);
  ctx.scale(scale, scale);
  drawFighterBody(ctx, fake, frameCount || 0);
  ctx.restore();
}

function drawProjectiles(ctx, match) {
  for (const p of match.projectiles) {
    ctx.fillStyle = match.fighters[p.owner].char.color;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawParticles(ctx) {
  for (const p of particles) {
    ctx.globalAlpha = p.life / p.max;
    ctx.fillStyle = '#ffe27a';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function fmtPercent(f) {
  return `${Math.floor(f.percent)}%`;
}

function drawHUD(ctx, match) {
  const p0 = match.fighters[0], p1 = match.fighters[1];
  ctx.save();
  ctx.font = '700 34px Consolas, "SFMono-Regular", Menlo, monospace';
  ctx.textBaseline = 'alphabetic';

  drawPercentBadge(ctx, p0, 60, STAGE_H - 46, 'left');
  drawPercentBadge(ctx, p1, STAGE_W - 60, STAGE_H - 46, 'right');

  if (match.mode === 'stock') {
    drawStocks(ctx, p0, 60, STAGE_H - 90, 1);
    drawStocks(ctx, p1, STAGE_W - 60, STAGE_H - 90, -1);
  } else {
    ctx.font = '700 20px Consolas, monospace';
    ctx.fillStyle = '#d9fbe8';
    ctx.textAlign = 'left';
    ctx.fillText(`K ${p0.kos}  D ${p0.deaths}`, 20, STAGE_H - 96);
    ctx.textAlign = 'right';
    ctx.fillText(`K ${p1.kos}  D ${p1.deaths}`, STAGE_W - 20, STAGE_H - 96);
    const remain = Math.max(0, Math.ceil((match.timeLimitFrames - match.frame) / 60));
    const mm = String(Math.floor(remain / 60)).padStart(2, '0');
    const ss = String(remain % 60).padStart(2, '0');
    ctx.textAlign = 'center';
    ctx.font = '700 30px Consolas, monospace';
    ctx.fillText(`${mm}:${ss}`, STAGE_W / 2, 40);
  }
  ctx.restore();
}

function drawPercentBadge(ctx, f, x, y, align) {
  ctx.textAlign = align === 'left' ? 'left' : 'right';
  const risk = Math.min(1, f.percent / 150);
  const r = Math.round(217 + risk * (255 - 217));
  const g = Math.round(251 - risk * (251 - 70));
  ctx.fillStyle = `rgb(${r},${g},70)`;
  ctx.fillText(fmtPercent(f), x, y);
  ctx.font = '700 13px Consolas, monospace';
  ctx.fillStyle = f.char.color;
  ctx.fillText(f.char.name.toUpperCase(), x, y + 18);
  ctx.font = '700 34px Consolas, monospace';
}

function drawStocks(ctx, f, x, y, dir) {
  ctx.fillStyle = f.char.color;
  for (let i = 0; i < f.stocks; i += 1) {
    const cx = x + dir * i * 16;
    ctx.beginPath();
    ctx.arc(cx, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function render(ctx, match) {
  stepParticles();
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);
  drawStage(ctx, match.stage);
  for (const f of match.fighters) drawFighter(ctx, f, match.frame);
  drawProjectiles(ctx, match);
  drawParticles(ctx);
  drawHUD(ctx, match);
}
