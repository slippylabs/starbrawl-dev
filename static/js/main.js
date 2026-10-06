import { CHARACTERS, getCharacter } from './characters.js';
import { STAGES, getStage } from './stages.js';
import { createMatch, tick, checksum as engineChecksum } from './engine.js';
import { render, pushHitFx, drawFighterPortrait } from './renderer.js';
import { InputPlayer, listGamepads } from './input.js';
import { SIM_DT, KEYBOARD_SCHEMES } from './constants.js';
import { makeInterp, capture, drawAt } from './interp.js';
import { NetClient, createNetSim } from './netplay.js?v=ws1';

const $ = (id) => document.getElementById(id);
const canvas = $('game-canvas');
const ctx = canvas.getContext('2d');

const S = {
  online: false,
  net: null,
  netsim: null,          // RollbackSim (or LockstepSim) while an online match is running
  localIndex: 0,          // which fighter slot the local player controls (0 for local-P1/host, 0 or 1 online)
  localPlayers: [],        // InputPlayer instances — length 2 for local play, length 1 for online
  activePicker: 0,          // for local play: which slot mouse clicks currently assign to
  picks: [null, null],
  charLocked: [false, false],
  stageId: STAGES[0].id,
  mode: 'stock',
  stockCount: 3,
  timeMinutes: 3,
  match: null,
  running: false,
  frozen: false,           // test hook: holds the rAF loop still so __sbNet can step exact frame counts
  navPrev: [{ l: false, r: false }, { l: false, r: false }],
  localSourceInfo: [],     // parallel to localPlayers — {type:'keyboard', scheme} | {type:'gamepad'}, drives the on-screen controls HUD
  controlsHudVisible: true,
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  $(id).classList.add('active');
  S.currentScreen = id;
}

// ---------------------------------------------------------------- title ---

function updateGamepadStatus() {
  const pads = listGamepads();
  const el = $('gamepad-status');
  if (pads.length === 0) {
    el.textContent = 'No controllers detected — keyboard works for both players.';
    el.classList.remove('has-pads');
  } else {
    el.textContent = `${pads.length} controller${pads.length > 1 ? 's' : ''} connected.`;
    el.classList.add('has-pads');
  }
}
window.addEventListener('gamepadconnected', updateGamepadStatus);
window.addEventListener('gamepaddisconnected', updateGamepadStatus);

$('btn-local').addEventListener('click', () => {
  S.online = false;
  S.net = null;
  S.netsim = null;
  S.localPlayers = buildLocalTwoPlayers();
  resetPicks();
  enterCharSelect();
});

$('btn-online').addEventListener('click', () => {
  showScreen('screen-online');
  $('room-code-display').textContent = '';
  $('online-status').textContent = '';
});
$('btn-online-back').addEventListener('click', () => showScreen('screen-title'));

// ---------------------------------------------------------------- online ---

$('btn-create-room').addEventListener('click', async () => {
  S.net = new NetClient();
  wireNetHandlers();
  const code = await S.net.createRoom();
  $('room-code-display').textContent = code;
  $('online-status').textContent = 'Waiting for an opponent to join…';
});

$('btn-join-room').addEventListener('click', async () => {
  const code = $('input-join-code').value.trim().toUpperCase();
  if (code.length !== 4) { $('online-status').textContent = 'Enter the 4-character room code.'; return; }
  S.net = new NetClient();
  wireNetHandlers();
  try {
    await S.net.joinRoom(code);
  } catch (e) {
    $('online-status').textContent = e.message;
  }
});

function wireNetHandlers() {
  // Nothing reached the server yet: say so instead of waiting forever.
  S.net.socket.on('connect_error', () => {
    if (!S.net || S.net.socket.connected) return;
    $('online-status').textContent = 'Cannot reach the game server -- retrying...';
  });
  S.net.onOpponentJoined(({ playerIndex }) => {
    S.online = true;
    S.localIndex = playerIndex;
    S.localPlayers = [new InputPlayer(pickLocalSource())];
    $('online-status').textContent = 'Opponent connected!';
    resetPicks();
    setTimeout(enterCharSelect, 400);
  });
  S.net.onPeerPick((data) => {
    if (data.kind === 'char') { S.picks[1 - S.localIndex] = data.charId; S.charLocked[1 - S.localIndex] = true; refreshCharPanels(); maybeAdvanceFromCharSelect(); }
    if (data.kind === 'stage') { S.stageId = data.stageId; refreshStageGrid(); }
    if (data.kind === 'mode') { S.mode = data.mode; refreshModeUI(); }
    if (data.kind === 'count') { if (S.mode === 'stock') S.stockCount = data.count; else S.timeMinutes = data.count; refreshModeUI(); }
  });
  S.net.onMatchStart((payload) => startMatch(payload));
  S.net.onPeerLeft(() => {
    alert('Your opponent disconnected.');
    goToMainMenu();
  });
}

function pickLocalSource() {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  if (pads.length > 0) {
    S.localSourceInfo = [{ type: 'gamepad' }];
    return { poll: gamepadPoll(pads[0].index) };
  }
  S.localSourceInfo = [{ type: 'keyboard', scheme: KEYBOARD_SCHEMES.p1 }];
  return { poll: keyboardPoll(KEYBOARD_SCHEMES.p1) };
}

// ------------------------------------------------------------ char select --

function resetPicks() {
  S.picks = [null, null];
  S.charLocked = [false, false];
  S.activePicker = 0;
  S.navPrev = [{ l: false, r: false }, { l: false, r: false }];
}

function buildCharGrid() {
  const grid = $('cs-grid');
  grid.innerHTML = '';
  CHARACTERS.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'cs-card';
    card.dataset.idx = String(idx);
    card.innerHTML = `<canvas class="cs-card-swatch" width="80" height="80"></canvas><div class="cs-card-name">${c.name}</div>`;
    drawFighterPortrait(card.querySelector('canvas'), c, 0);
    card.addEventListener('click', () => {
      if (S.online) {
        assignPick(S.localIndex, c.id);
      } else {
        assignPick(S.activePicker, c.id);
        if (S.activePicker === 0 && !S.charLocked[1]) S.activePicker = 1;
      }
    });
    grid.appendChild(card);
  });
}

function assignPick(slot, charId) {
  if (S.charLocked[slot]) return;
  S.picks[slot] = charId;
  S.charLocked[slot] = true;
  refreshCharPanels();
  if (S.online && slot === S.localIndex) S.net.sendPick({ kind: 'char', charId });
  maybeAdvanceFromCharSelect();
}

function refreshCharPanels() {
  for (let i = 0; i < 2; i += 1) {
    const c = S.picks[i] ? getCharacter(S.picks[i]) : null;
    $(`cs-name-${i}`).textContent = c ? c.name : '—';
    $(`cs-tagline-${i}`).textContent = c ? c.tagline : '';
    const portraitCanvas = $(`cs-portrait-${i}`);
    const pctx = portraitCanvas.getContext('2d');
    pctx.clearRect(0, 0, portraitCanvas.width, portraitCanvas.height);
    if (c) drawFighterPortrait(portraitCanvas, c, 0);
    const readyEl = $(`cs-ready-${i}`);
    readyEl.textContent = S.charLocked[i] ? 'LOCKED IN' : (S.online && i !== S.localIndex ? 'Waiting…' : 'Choosing…');
    readyEl.classList.toggle('on', S.charLocked[i]);
  }
  document.querySelectorAll('.cs-card').forEach((card) => {
    card.classList.remove('picked-0', 'picked-1');
    const idx = Number(card.dataset.idx);
    if (S.picks[0] && CHARACTERS[idx].id === S.picks[0]) card.classList.add('picked-0');
    if (S.picks[1] && CHARACTERS[idx].id === S.picks[1]) card.classList.add('picked-1');
  });
}

function maybeAdvanceFromCharSelect() {
  if (S.charLocked[0] && S.charLocked[1]) {
    setTimeout(() => enterStageSelect(), 300);
  }
}

function enterCharSelect() {
  buildCharGrid();
  refreshCharPanels();
  showScreen('screen-charselect');
}

function pollCharSelectNav() {
  if (S.currentScreen !== 'screen-charselect') return;
  const slots = S.online ? [S.localIndex] : [0, 1];
  for (const slot of slots) {
    if (S.charLocked[slot]) continue;
    const player = S.online ? S.localPlayers[0] : S.localPlayers[slot];
    if (!player) continue;
    const raw = player.source.poll();
    const prev = S.navPrev[slot];
    let cursor = CHARACTERS.findIndex((c) => c.id === S.picks[slot]);
    if (cursor < 0) cursor = 0;
    if (raw.right && !prev.r) cursor = (cursor + 1) % CHARACTERS.length;
    if (raw.left && !prev.l) cursor = (cursor - 1 + CHARACTERS.length) % CHARACTERS.length;
    prev.l = raw.left; prev.r = raw.right;
    S.picks[slot] = CHARACTERS[cursor].id;
    if (raw.jump) assignPick(slot, CHARACTERS[cursor].id);
    else refreshCharPanels();
  }
}

// ----------------------------------------------------------- stage select --

function buildStageGrid() {
  const grid = $('stage-grid');
  grid.innerHTML = '';
  STAGES.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'stage-card';
    card.dataset.id = s.id;
    card.innerHTML = `<canvas width="200" height="90"></canvas><div class="stage-name">${s.name}</div><div class="stage-tagline">${s.tagline}</div>`;
    drawStageThumb(card.querySelector('canvas'), s);
    card.addEventListener('click', () => {
      if (S.online && S.localIndex !== 0) return; // only host picks stage
      S.stageId = s.id;
      refreshStageGrid();
      if (S.online) S.net.sendPick({ kind: 'stage', stageId: s.id });
    });
    grid.appendChild(card);
  });
  refreshStageGrid();
}

function drawStageThumb(cv, stage) {
  const c = cv.getContext('2d');
  const sx = cv.width / 1280, sy = cv.height / 720;
  c.fillStyle = stage.bg; c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = '#39ff8f';
  const g = stage.ground;
  c.fillRect(g.x * sx, g.y * sy, g.w * sx, g.h * sy);
  c.globalAlpha = 0.6;
  for (const p of stage.platforms) c.fillRect(p.x * sx, p.y * sy, p.w * sx, p.h * sy);
  c.globalAlpha = 1;
}

function refreshStageGrid() {
  document.querySelectorAll('.stage-card').forEach((card) => {
    card.classList.toggle('picked', card.dataset.id === S.stageId);
  });
}

function refreshModeUI() {
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
  $('stock-count-group').style.display = S.mode === 'stock' ? '' : 'none';
  $('time-count-group').style.display = S.mode === 'timed' ? '' : 'none';
  document.querySelectorAll('.count-btn').forEach((b) => {
    if (b.dataset.count) b.classList.toggle('active', S.mode === 'stock' && Number(b.dataset.count) === S.stockCount);
    if (b.dataset.time) b.classList.toggle('active', S.mode === 'timed' && Number(b.dataset.time) === S.timeMinutes);
  });
}

document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => {
  if (S.online && S.localIndex !== 0) return;
  S.mode = b.dataset.mode;
  refreshModeUI();
  if (S.online) S.net.sendPick({ kind: 'mode', mode: S.mode });
}));
document.querySelectorAll('.count-btn').forEach((b) => b.addEventListener('click', () => {
  if (S.online && S.localIndex !== 0) return;
  if (b.dataset.count) S.stockCount = Number(b.dataset.count);
  if (b.dataset.time) S.timeMinutes = Number(b.dataset.time);
  refreshModeUI();
  if (S.online) S.net.sendPick({ kind: 'count', count: b.dataset.count ? S.stockCount : S.timeMinutes });
}));

function enterStageSelect() {
  buildStageGrid();
  refreshModeUI();
  const isGuest = S.online && S.localIndex !== 0;
  $('mode-row').style.display = isGuest ? 'none' : '';
  $('btn-start-match').style.display = isGuest ? 'none' : '';
  $('stage-waiting-note').style.display = isGuest ? '' : 'none';
  showScreen('screen-stageselect');
}

$('btn-start-match').addEventListener('click', () => {
  if (S.online && S.localIndex !== 0) return;
  const payload = {
    stageId: S.stageId, mode: S.mode, stockCount: S.stockCount, timeMinutes: S.timeMinutes,
    charIds: S.online ? [S.picks[0], S.picks[1]] : [S.picks[0], S.picks[1]],
  };
  if (S.online) S.net.sendMatchStart(payload);
  startMatch(payload);
});

// ------------------------------------------------------------------ match --

function startMatch(payload) {
  S.stageId = payload.stageId; S.mode = payload.mode; S.stockCount = payload.stockCount; S.timeMinutes = payload.timeMinutes;
  S.match = createMatch({
    stageId: payload.stageId,
    charIds: payload.charIds,
    mode: payload.mode,
    stockCount: payload.stockCount,
    timeLimitSeconds: payload.timeMinutes * 60,
  });
  if (S.online) {
    S.netsim = createNetSim(S.match, S.localIndex, S.net);
  } else if (S.localPlayers.length < 2) {
    S.localPlayers = buildLocalTwoPlayers();
  }
  renderControlsHud();
  showScreen('screen-match');
}

// ------------------------------------------------------------ controls HUD --

function codeToLabel(code) {
  if (!code) return '?';
  if (code.startsWith('Key')) return code.slice(3);
  if (code === 'ArrowLeft') return '<';
  if (code === 'ArrowRight') return '>';
  if (code === 'ArrowUp') return '^';
  if (code === 'ArrowDown') return 'v';
  if (code.startsWith('Numpad')) return 'N' + code.slice(6);
  return code;
}

function gamepadColHtml(label) {
  return `<div class="ctrl-hud-col">
    <div class="ctrl-hud-name">${label} &middot; Gamepad</div>
    <div class="ctrl-hud-row"><span>Move</span><kbd>Stick/D-Pad</kbd></div>
    <div class="ctrl-hud-row"><span>Jump</span><kbd>A</kbd></div>
    <div class="ctrl-hud-row"><span>Attack</span><kbd>X</kbd></div>
    <div class="ctrl-hud-row"><span>Special</span><kbd>Y</kbd></div>
    <div class="ctrl-hud-row"><span>Shield</span><kbd>LT/RT</kbd></div>
    <div class="ctrl-hud-row"><span>Grab</span><kbd>B</kbd></div>
  </div>`;
}

function controlsHudColHtml(label, info) {
  if (!info) return '';
  if (info.type === 'gamepad') return gamepadColHtml(label);
  const s = info.scheme;
  return `<div class="ctrl-hud-col">
    <div class="ctrl-hud-name">${label} &middot; Keyboard</div>
    <div class="ctrl-hud-row"><span>Move</span><kbd>${codeToLabel(s.left)}</kbd><kbd>${codeToLabel(s.right)}</kbd></div>
    <div class="ctrl-hud-row"><span>Jump</span><kbd>${codeToLabel(s.jump)}</kbd></div>
    <div class="ctrl-hud-row"><span>Attack</span><kbd>${codeToLabel(s.attack)}</kbd></div>
    <div class="ctrl-hud-row"><span>Special</span><kbd>${codeToLabel(s.special)}</kbd></div>
    <div class="ctrl-hud-row"><span>Shield</span><kbd>${codeToLabel(s.shield)}</kbd></div>
    <div class="ctrl-hud-row"><span>Grab</span><kbd>${codeToLabel(s.grab)}</kbd></div>
  </div>`;
}

function renderControlsHud() {
  const hud = $('controls-hud');
  const info = S.online ? [S.localSourceInfo[0]] : [S.localSourceInfo[0], S.localSourceInfo[1]];
  let html = S.online
    ? controlsHudColHtml('You', info[0])
    : controlsHudColHtml('P1', info[0]) + controlsHudColHtml('P2', info[1]);
  // Always keep a gamepad reference on screen — a controller can be plugged
  // in mid-session (the game auto-detects it), so the mapping should be
  // visible even before one is actually connected. Skip it only if a local
  // slot is already shown as a gamepad, to avoid a redundant duplicate.
  const alreadyShowsGamepad = info.some((i) => i && i.type === 'gamepad');
  if (!alreadyShowsGamepad) html += gamepadColHtml('Either Slot');
  hud.innerHTML = html;
  hud.classList.toggle('hidden', !S.controlsHudVisible);
}

$('btn-toggle-controls').addEventListener('click', () => {
  S.controlsHudVisible = !S.controlsHudVisible;
  $('controls-hud').classList.toggle('hidden', !S.controlsHudVisible);
  $('btn-toggle-controls').textContent = S.controlsHudVisible ? 'Hide Controls' : 'Show Controls';
});

function buildLocalTwoPlayers() {
  // Gamepads (in connection order) fill slots first; keyboard schemes fill
  // whatever's left, so plugging in one controller for local play still
  // leaves the other player on a keyboard scheme automatically.
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  const sources = [];
  const info = [];
  for (const gp of pads) { sources.push({ poll: gamepadPoll(gp.index) }); info.push({ type: 'gamepad' }); }
  if (sources.length < 1) { sources.push({ poll: keyboardPoll(KEYBOARD_SCHEMES.p1) }); info.push({ type: 'keyboard', scheme: KEYBOARD_SCHEMES.p1 }); }
  if (sources.length < 2) {
    const scheme = sources.length === 0 ? KEYBOARD_SCHEMES.p1 : KEYBOARD_SCHEMES.p2;
    sources.push({ poll: keyboardPoll(scheme) });
    info.push({ type: 'keyboard', scheme });
  }
  S.localSourceInfo = info.slice(0, 2);
  return sources.slice(0, 2).map((s) => new InputPlayer(s));
}

// Minimal poll-fn factories reused for both local-vs-local slot building and
// the online single-local-player case in wireNetHandlers().
const heldKeys = new Set();
window.addEventListener('keydown', (e) => heldKeys.add(e.code));
window.addEventListener('keyup', (e) => heldKeys.delete(e.code));
function keyboardPoll(scheme) {
  return () => {
    const left = heldKeys.has(scheme.left), right = heldKeys.has(scheme.right);
    const up = heldKeys.has(scheme.up), down = heldKeys.has(scheme.down);
    return {
      left, right, up, down,
      jump: heldKeys.has(scheme.jump), attack: heldKeys.has(scheme.attack), special: heldKeys.has(scheme.special),
      shield: heldKeys.has(scheme.shield), grab: heldKeys.has(scheme.grab),
      stickX: (right ? 1 : 0) - (left ? 1 : 0), stickY: (down ? 1 : 0) - (up ? 1 : 0),
    };
  };
}
function gamepadPoll(index) {
  return () => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[index];
    if (!gp) return { left: false, right: false, up: false, down: false, jump: false, attack: false, special: false, shield: false, grab: false, stickX: 0, stickY: 0 };
    const dz = 0.28;
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    const stickX = Math.abs(ax) > dz ? ax : 0, stickY = Math.abs(ay) > dz ? ay : 0;
    const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    return {
      left: stickX < -dz || btn(14), right: stickX > dz || btn(15), up: stickY < -dz || btn(12), down: stickY > dz || btn(13),
      jump: btn(0), attack: btn(2), special: btn(3), shield: btn(6) || btn(7), grab: btn(1),
      stickX, stickY,
    };
  };
}

$('btn-quit-match').addEventListener('click', goToMainMenu);

function goToMainMenu() {
  if (S.net) { S.net.disconnect(); S.net = null; }
  S.online = false; S.netsim = null; S.match = null;
  showScreen('screen-title');
}

// ---------------------------------------------------------------- results --

function showResults() {
  const [p0, p1] = S.match.fighters;
  let text;
  if (S.match.winnerIndex === -1) text = 'Draw!';
  else text = `${getCharacter(S.match.fighters[S.match.winnerIndex].charId).name} wins!`;
  $('results-title').textContent = 'Match Result';
  $('results-body').innerHTML = `
    <div class="results-winner">${text}</div>
    <div class="results-stats mono-digits">
      <div>${getCharacter(p0.charId).name}<br><b>${S.match.mode === 'stock' ? `${p0.stocks} stocks left` : `${p0.kos}K / ${p0.deaths}D`}</b></div>
      <div>${getCharacter(p1.charId).name}<br><b>${S.match.mode === 'stock' ? `${p1.stocks} stocks left` : `${p1.kos}K / ${p1.deaths}D`}</b></div>
    </div>`;
  showScreen('screen-results');
}

$('btn-rematch').addEventListener('click', () => {
  resetPicks();
  if (S.online) { refreshCharPanels(); enterCharSelect(); }
  else enterCharSelect();
});
$('btn-main-menu').addEventListener('click', goToMainMenu);

// --------------------------------------------------------------- game loop --

function stepMatchLocal() {
  const inputs = [S.localPlayers[0].sample(), S.localPlayers[1].sample()];
  tick(S.match, inputs);
  if (S.match.hitFx.length) pushHitFx(S.match.hitFx);
}

function stepMatchOnline() {
  S.netsim.pump(S.localPlayers[0]);
  // Only when prediction is actually exhausted — under rollback a late packet
  // is routine and flashing the badge on every one of them would strobe.
  $('net-waiting-badge').style.display = S.netsim.isStalled() ? '' : 'none';
  // Not S.match.hitFx: a rolled-back frame is simulated more than once, and
  // the sim hands back only the events from frames that are newly advanced.
  const fx = S.netsim.drainFx();
  if (fx) pushHitFx(fx);
}

// A predicted KO can be rolled back, so online play waits for the opponent's
// real input on the deciding frame before the match is allowed to end.
function matchIsOver() {
  return S.online ? S.netsim.isOverConfirmed() : S.match.over;
}

let acc = 0;
let last = performance.now();

// Drawn between simulation steps -- see js/interp.js for why reading a
// fighter's x straight out of the match stutters on anything but a 60 Hz
// panel. Fighters and projectiles only: the renderer's own particles are
// advanced in render() off their own life counter, and hitFx is transient.
const interp = makeInterp({
  entities: (m) => (m ? [...m.fighters, ...m.projectiles] : null),
  fields: ['x', 'y'],
  // A blast-off and a respawn put a fighter across the stage in one step.
  snap: 120,
});

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  if (S.currentScreen === 'screen-charselect') pollCharSelectNav();

  if (S.currentScreen === 'screen-match' && S.match && !matchIsOver() && !S.frozen) {
    acc += dt;
    let guard = 0;
    while (acc >= SIM_DT && guard < 6) {
      // BEFORE the step, inside the loop: a frame that steps twice must leave
      // behind the state from before the SECOND step.
      capture(interp, S.match);
      if (S.online) stepMatchOnline(); else stepMatchLocal();
      acc -= SIM_DT;
      guard += 1;
      if (matchIsOver()) break;
    }
    drawAt(interp, S.match, acc / SIM_DT, () => render(ctx, S.match));
    if (matchIsOver()) setTimeout(showResults, 900);
  } else if (S.currentScreen === 'screen-match' && S.match && matchIsOver()) {
    render(ctx, S.match);
  }
}
requestAnimationFrame(loop);
updateGamepadStatus();
refreshModeUI();

// --------------------------------------------------------- test hooks --
//
// Headless Chromium throttles requestAnimationFrame hard enough that
// wall-clock timing is meaningless for netcode assertions (documented the
// hard way in this project already, and the reason Slime Soccer's netcode
// test drives its sim through equivalent __ssPump* hooks). These let a test
// freeze the render loop and step an exact number of fixed frames instead.
// What the blend drew, for tools/interp_test.py. redraw() is the real draw
// path at a chosen alpha -- there is no other way to see a blended position
// from outside, because swap-and-restore has put it back by the time the frame
// returns.
window.__ip = {
  it: interp,
  /**
   * Advance a LOCAL match by fixed steps, captured the way the loop drives it.
   *
   * __sbNet.pump is online-only, so a play test of a local match had no way to
   * own the clock -- and the simulation cannot advance on its own inside one
   * synchronous evaluate, so without this it measured a still frame.
   */
  step(n = 1) {
    for (let i = 0; i < n; i++) {
      if (!S.match || matchIsOver()) break;
      capture(interp, S.match);
      stepMatchLocal();
    }
    return S.match ? S.match.frame : -1;
  },
  /** Start a local match without clicking through the menus. */
  quickMatch(stageId) {
    startMatch({
      stageId: stageId || STAGES[0].id,
      charIds: [CHARACTERS[0].id, CHARACTERS[1].id],
      mode: 'stock',
      stockCount: 3,
      timeMinutes: 2,
    });
    return !!S.match;
  },
  checksum() { return S.match ? engineChecksum(S.match) : 0; },
  redraw(alpha) {
    interp.record = true;
    try {
      drawAt(interp, S.match, alpha, () => render(ctx, S.match));
      return { alpha: interp.alpha, blended: interp.blended, snapped: interp.snapped, drawn: interp.drawn.slice() };
    } finally { interp.record = false; }
  },
};

window.__sbNet = {
  freeze(on = true) { S.frozen = on; },
  // Advance the online sim by `n` fixed steps. Returns frames actually
  // simulated, which is lower than n whenever prediction stalls.
  pump(n = 1) {
    if (!S.netsim) return 0;
    const before = S.match.frame;
    for (let i = 0; i < n; i += 1) stepMatchOnline();
    return S.match.frame - before;
  },
  frame() { return S.match ? S.match.frame : -1; },
  settle() { return S.netsim ? S.netsim.settle() : -1; },
  confirmed() { return S.netsim && S.netsim.confirmed !== undefined ? S.netsim.confirmed : S.match.frame; },
  rollbacks() { return S.netsim && S.netsim.rollbackCount !== undefined ? S.netsim.rollbackCount : 0; },
  desynced() { return !!(S.netsim && S.netsim.desynced); },
  stalled() { return S.netsim ? S.netsim.isStalled() : false; },
  checksum() { return S.match ? engineChecksum(S.match) : 0; },
  // Checksum of a *confirmed* frame, read out of the snapshot ring. Comparing
  // live state across two clients is meaningless — at any instant each is
  // predicting a different distance ahead — so agreement is only ever checked
  // on a frame both sides have the opponent's real input for.
  checksumAt(frame) {
    const snap = S.netsim && S.netsim.snapshots && S.netsim.snapshots.get(frame);
    return snap ? engineChecksum(snap) : null;
  },
  // 'rollback' or 'lockstep' — only rollback keeps a snapshot ring, so only it
  // can be asked for the state at an earlier frame.
  mode() { return S.netsim && S.netsim.snapshots ? 'rollback' : 'lockstep'; },
  state() {
    if (!S.match) return null;
    return S.match.fighters.map((f) => ({ x: f.x, y: f.y, percent: f.percent, state: f.state, stocks: f.stocks }));
  },
  // Hold outgoing input packets back by `ms` to stand in for real latency.
  setLatency(ms) {
    if (!S.net) return;
    if (!S.net._realSendInput) S.net._realSendInput = S.net.sendInput.bind(S.net);
    S.net.sendInput = ms > 0
      ? (frame, input, chk) => setTimeout(() => S.net._realSendInput(frame, input, chk), ms)
      : S.net._realSendInput;
  },
  roomCode() { return S.net ? S.net.roomCode : null; },
};
