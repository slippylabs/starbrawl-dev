import { NETPLAY_INPUT_DELAY } from './constants.js';
import { EMPTY_INPUT } from './input.js';
import { tick } from './engine.js';

// Thin wrapper over Socket.IO for room matchmaking + input relay. The server
// (see ../../sockets.py) never runs the simulation — it only assigns room
// codes and relays 'input'/'pick_*'/'ready' messages between exactly two
// sockets, so gameplay logic lives entirely client-side and identically on
// both peers (see LockstepSim below).
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
  sendInput(frame, input) { this.socket.emit('input', { frame, input }); }

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
}
