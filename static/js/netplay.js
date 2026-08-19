import { NETPLAY_INPUT_DELAY, MAX_ROLLBACK_FRAMES, DESYNC_CHECK_EVERY, NETPLAY_ROLLBACK } from './constants.js';
import { EMPTY_INPUT } from './input.js';
import { tick, saveState, restoreState, checksum } from './engine.js';

// Thin wrapper over Socket.IO for room matchmaking + input relay. The server
// (see ../../sockets.py) never runs the simulation — it only assigns room
// codes and relays 'input'/'pick_*'/'ready' messages between exactly two
// sockets, so gameplay logic lives entirely client-side and identically on
// both peers (see RollbackSim below).
export class NetClient {
  constructor() {
    this.socket = io({ transports: ['websocket', 'polling'] });
    this.playerIndex = -1;
    this.roomCode = null;
  }

  createRoom() {
    return new Promise((resolve) => {
      this.socket.emit('create_room');
      this.socket.once('room_created', ({ code }) => { this.roomCode = code; this.playerIndex = 0; resolve(code); });
    });
  }

  joinRoom(code) {
    return new Promise((resolve, reject) => {
      this.socket.emit('join_room', { code });
      this.socket.once('join_error', ({ reason }) => reject(new Error(reason)));
      this.socket.once('match_found', ({ playerIndex }) => { this.roomCode = code; this.playerIndex = playerIndex; resolve(playerIndex); });
    });
  }

  onOpponentJoined(cb) { this.socket.on('match_found', cb); }
  onPeerPick(cb) { this.socket.on('peer_pick', cb); }
  onPeerReady(cb) { this.socket.on('peer_ready', cb); }
  onMatchStart(cb) { this.socket.on('match_start', cb); }
  onPeerInput(cb) { this.socket.on('peer_input', cb); }
  onPeerLeft(cb) { this.socket.on('peer_left', cb); }

  sendPick(pick) { this.socket.emit('pick', pick); }
  sendReady() { this.socket.emit('ready'); }
  sendMatchStart(payload) { this.socket.emit('start_match', payload); }
  // `chk` is an optional {frame, value} checksum piggybacked onto the input
  // stream for desync detection. sockets.py relays this payload opaquely, so
  // riding along on an existing event costs no server change.
  sendInput(frame, input, chk) { this.socket.emit('input', chk ? { frame, input, chk } : { frame, input }); }

  disconnect() { this.socket.disconnect(); }
}

// Input-delay lockstep: local input captured "now" is tagged for a target
// frame `delay` steps in the future and sent immediately. Simulation only
// advances once BOTH sides' input for the next frame number has arrived, so
// the two clients' engine.js state stays identical without any state
// snapshotting or resimulation. Frames 1..delay are pre-seeded with neutral
// input so the match can start advancing immediately.
export class LockstepSim {
  constructor(match, localIndex, net, delay = NETPLAY_INPUT_DELAY) {
    this.match = match;
    this.localIndex = localIndex;
    this.remoteIndex = 1 - localIndex;
    this.net = net;
    this.delay = delay;
    this.captureSeq = 0;
    this.localBuf = new Map();
    this.remoteBuf = new Map();
    this.connected = true;
    this.fx = [];
    for (let i = 1; i <= delay; i += 1) { this.localBuf.set(i, EMPTY_INPUT); this.remoteBuf.set(i, EMPTY_INPUT); }
    net.onPeerInput(({ frame, input }) => { this.remoteBuf.set(frame, input); });
    net.onPeerLeft(() => { this.connected = false; });
  }

  // Call once per fixed 60Hz accumulator step. Captures local input for a
  // future target frame, sends it, then advances the sim as far as both
  // buffers allow (usually exactly one frame; zero if the peer is lagging).
  pump(localInputPlayer) {
    this.captureSeq += 1;
    const targetFrame = this.captureSeq + this.delay;
    const sampled = localInputPlayer.sample();
    this.localBuf.set(targetFrame, sampled);
    this.net.sendInput(targetFrame, sampled);

    let advanced = 0;
    while (this.localBuf.has(this.match.frame + 1) && this.remoteBuf.has(this.match.frame + 1)) {
      const nextFrame = this.match.frame + 1;
      const lf = this.localBuf.get(nextFrame);
      const rf = this.remoteBuf.get(nextFrame);
      const inputs = this.localIndex === 0 ? [lf, rf] : [rf, lf];
      tick(this.match, inputs);
      if (this.match.hitFx.length) this.fx.push(...this.match.hitFx);
      this.localBuf.delete(nextFrame);
      this.remoteBuf.delete(nextFrame);
      advanced += 1;
      if (this.match.over) break;
    }
    return advanced;
  }

  waitingOnPeer() {
    return !this.remoteBuf.has(this.match.frame + 1);
  }

  // The three methods main.js drives the sim through. Lockstep only ever
  // simulates confirmed input, so there is nothing to de-duplicate and nothing
  // predicted that could be taken back — but the interface has to match
  // RollbackSim or NETPLAY_ROLLBACK=false would not actually be a way back.
  drainFx() {
    if (!this.fx.length) return null;
    const out = this.fx;
    this.fx = [];
    return out;
  }

  isStalled() { return this.waitingOnPeer(); }
  isOverConfirmed() { return this.match.over; }
  settle() { return this.match.frame; } // nothing is ever predicted, so nothing to settle
}

// Carry a remote input forward as a prediction. The held fields (movement,
// jump-held, shield) repeat; the edge-triggered fields do NOT.
//
// sample() in input.js returns a mixed frame: levels (l/r/u/d/sx/sy/jh/sh)
// alongside press edges (jp/ap/spp/gp). Textbook rollback repeats the last
// remote input verbatim — do that here and one opponent jab is re-predicted as
// a *fresh* jab on every frame until the real packet lands, throwing phantom
// hitboxes and projectiles that then have to be rewound. It still converges
// (rollback corrects it), but it costs ~50% more rewinds — measured at 81 vs
// 54 over the 300-frame scripted match in test/rollback_netplay_test.mjs at 9
// frames of latency — and every extra rewind is a visible correction on
// screen. Slime Soccer hit the same wall and solved it the same way (its
// predictedInputs() applies a remote jump edge only on the first replayed
// tick).
//
// The residual: an opponent who holds a button through a state change has the
// re-trigger arrive with the packet rather than being predicted. One frame.
function predictRemote(prev) {
  if (!prev) return EMPTY_INPUT;
  return Object.assign({}, prev, { jp: 0, ap: 0, spp: 0, gp: 0 });
}

const INPUT_KEYS = ['l', 'r', 'u', 'd', 'sx', 'sy', 'jh', 'jp', 'ap', 'spp', 'sh', 'gp'];
function sameInput(a, b) {
  if (!a || !b) return false;
  for (const k of INPUT_KEYS) if (a[k] !== b[k]) return false;
  return true;
}

// Rollback netplay. Same peer-to-peer relay and same deterministic engine as
// LockstepSim below, but instead of waiting for the opponent's input before
// advancing, the sim predicts it, keeps a snapshot of every frame, and rewinds
// + resimulates when a packet contradicts what was predicted.
//
// The trade LockstepSim makes is uniform input delay for perfect agreement.
// This trades occasional visual correction on the opponent for input that
// comes out ~50ms sooner and a sim that keeps running when a packet is late.
export class RollbackSim {
  constructor(match, localIndex, net, delay = NETPLAY_INPUT_DELAY) {
    this.match = match;
    this.localIndex = localIndex;
    this.remoteIndex = 1 - localIndex;
    this.net = net;
    this.delay = delay;
    this.captureSeq = 0;
    this.localBuf = new Map();
    this.remoteBuf = new Map();
    // What was actually fed to the remote fighter on each simulated frame,
    // predicted or confirmed. Comparing an arriving packet against this is
    // what decides whether a rollback is needed at all.
    this.usedRemote = new Map();
    this.snapshots = new Map(); // frame -> state AFTER that frame was ticked
    this.confirmed = 0;         // highest frame with unbroken confirmed remote input
    this.rollbackTo = null;
    this.stalled = false;
    this.connected = true;
    this.fx = [];
    this.rollbackCount = 0;
    this.myChecks = new Map();
    this.peerChecks = new Map();
    this.pendingChk = null;
    this.desynced = false;

    // Frames 1..delay have no captured input on either side.
    for (let i = 1; i <= delay; i += 1) { this.localBuf.set(i, EMPTY_INPUT); this.remoteBuf.set(i, EMPTY_INPUT); }
    this.confirmed = delay;
    this.snapshots.set(0, saveState(match));

    net.onPeerInput((msg) => this.onPeerInput(msg));
    net.onPeerLeft(() => { this.connected = false; });
  }

  onPeerInput({ frame, input, chk }) {
    this.remoteBuf.set(frame, input);
    while (this.remoteBuf.has(this.confirmed + 1)) this.confirmed += 1;

    // Only a frame already simulated can need rewinding, and only if what we
    // guessed differs from what actually happened.
    if (frame <= this.match.frame) {
      const used = this.usedRemote.get(frame);
      if (used && !sameInput(used, input)) {
        this.rollbackTo = this.rollbackTo === null ? frame : Math.min(this.rollbackTo, frame);
      }
    }
    if (chk) { this.peerChecks.set(chk.frame, chk.value); this.compareChecks(chk.frame); }
  }

  // One frame of simulation. `collectFx` is false during resimulation: those
  // frames were already drawn once, and replaying their hit/KO events would
  // fire the particle burst again for a hit the player already saw.
  stepFrame(f, collectFx) {
    const lf = this.localBuf.get(f);
    let rf = this.remoteBuf.get(f);
    if (!rf) rf = predictRemote(this.remoteBuf.get(this.confirmed));
    this.usedRemote.set(f, rf);

    const inputs = this.localIndex === 0 ? [lf, rf] : [rf, lf];
    tick(this.match, inputs);
    if (collectFx && this.match.hitFx.length) this.fx.push(...this.match.hitFx);
    this.snapshots.set(f, saveState(this.match));
  }

  resimulate() {
    const from = this.rollbackTo;
    this.rollbackTo = null;
    const base = this.snapshots.get(from - 1);
    // Snapshot aged out of the ring — nothing sound to rewind to, so keep
    // going from where we are rather than teleporting to a stale frame.
    if (!base) return;
    const target = this.match.frame;
    restoreState(this.match, base);
    this.rollbackCount += 1;
    for (let f = from; f <= target; f += 1) {
      this.stepFrame(f, false);
      if (this.match.over) break;
    }
  }

  // Call once per fixed 60Hz accumulator step. Returns frames advanced.
  pump(localInputPlayer) {
    this.captureSeq += 1;
    const targetFrame = this.captureSeq + this.delay;
    const sampled = localInputPlayer.sample();
    this.localBuf.set(targetFrame, sampled);
    this.net.sendInput(targetFrame, sampled, this.pendingChk);
    this.pendingChk = null;

    if (this.rollbackTo !== null) this.resimulate();

    if (this.match.over) { this.stalled = false; return 0; }

    const next = this.match.frame + 1;
    if (!this.localBuf.has(next)) { this.stalled = false; return 0; }
    // Predict only so far. Past MAX_ROLLBACK_FRAMES the guess is worth less
    // than the rollback it will cost, and the snapshot ring runs out.
    if (!this.remoteBuf.has(next) && next - this.confirmed > MAX_ROLLBACK_FRAMES) {
      this.stalled = true;
      return 0;
    }
    this.stalled = false;
    this.stepFrame(next, true);
    this.queueChecksum();
    this.prune();
    return 1;
  }

  // A frame's state is only final once its remote input is confirmed AND any
  // rollback that input triggered has been applied — `confirmed` advances the
  // instant a packet lands, but the rewind it causes happens on the next pump.
  // Checksumming in between would hash a snapshot that is about to be
  // rewritten and report a desync that isn't one.
  //
  // A snapshot is structurally the same shape as a match, which is what
  // checksum() reads, so it can be hashed directly.
  queueChecksum() {
    if (this.rollbackTo !== null) return;
    const f = this.confirmed - (this.confirmed % DESYNC_CHECK_EVERY);
    if (f <= 0 || this.myChecks.has(f)) return;
    const snap = this.snapshots.get(f);
    if (!snap) return;
    const value = checksum(snap);
    this.myChecks.set(f, value);
    this.pendingChk = { frame: f, value };
    this.compareChecks(f);
  }

  compareChecks(frame) {
    const mine = this.myChecks.get(frame);
    const theirs = this.peerChecks.get(frame);
    if (mine === undefined || theirs === undefined || mine === theirs) return;
    this.desynced = true;
    console.warn(`[starbrawl] netplay desync at frame ${frame}: local ${mine} vs peer ${theirs}`);
  }

  prune() {
    const keep = MAX_ROLLBACK_FRAMES + this.delay + 2;
    const cutoff = this.match.frame - keep;
    if (cutoff <= 0) return;
    for (const m of [this.snapshots, this.usedRemote, this.remoteBuf, this.localBuf]) {
      for (const k of m.keys()) if (k < cutoff) m.delete(k);
    }
    for (const m of [this.myChecks, this.peerChecks]) {
      for (const k of m.keys()) if (k < this.match.frame - DESYNC_CHECK_EVERY * 4) m.delete(k);
    }
  }

  // Apply any pending rollback without advancing the match. pump() does this
  // itself; this exists for callers that need the state at a confirmed frame
  // to be settled while the sim is paused — a test reading checksums, or a
  // paused match. Without it, `confirmed` can be ahead of the last frame that
  // has actually been corrected.
  settle() {
    if (this.rollbackTo !== null) this.resimulate();
    return this.match.frame;
  }

  // Hit/KO events from newly advanced frames only. Drained rather than read so
  // a frame's events are consumed exactly once.
  drainFx() {
    if (!this.fx.length) return null;
    const out = this.fx;
    this.fx = [];
    return out;
  }

  // The match is over only when the frame it ended on was simulated with the
  // opponent's real input. A predicted KO can still be rolled back.
  isOverConfirmed() { return this.match.over && this.confirmed >= this.match.frame; }
  isStalled() { return this.stalled; }
  waitingOnPeer() { return this.stalled; }
}

// Picks the netcode. NETPLAY_ROLLBACK=false restores the original input-delay
// lockstep without touching any other file.
export function createNetSim(match, localIndex, net) {
  return NETPLAY_ROLLBACK
    ? new RollbackSim(match, localIndex, net)
    : new LockstepSim(match, localIndex, net);
}
