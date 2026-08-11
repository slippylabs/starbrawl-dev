import { KEYBOARD_SCHEMES, GAMEPAD_BUTTONS, GAMEPAD_STICK_DEADZONE } from './constants.js';

// Every source (keyboard scheme or a gamepad index) exposes poll() -> raw
// booleans/analog for "this instant". InputPlayer wraps a source and turns
// raw state into a compact per-tick InputFrame with edge-triggered presses,
// which is what both the local sim and netplay wire format consume.

class KeyboardSource {
  constructor(scheme) {
    this.scheme = scheme;
    this.keys = new Set();
    window.addEventListener('keydown', (e) => { this.keys.add(e.code); });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
  }
  poll() {
    const k = this.scheme;
    const left = this.keys.has(k.left);
    const right = this.keys.has(k.right);
    const up = this.keys.has(k.up);
    const down = this.keys.has(k.down);
    return {
      left, right, up, down,
      jump: this.keys.has(k.jump),
      attack: this.keys.has(k.attack),
      special: this.keys.has(k.special),
      shield: this.keys.has(k.shield),
      grab: this.keys.has(k.grab),
      stickX: (right ? 1 : 0) - (left ? 1 : 0),
      stickY: (down ? 1 : 0) - (up ? 1 : 0),
    };
  }
}

class GamepadSource {
  constructor(index) { this.index = index; }
  connected() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return !!pads[this.index];
  }
  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[this.index];
    if (!gp) {
      return { left: false, right: false, up: false, down: false, jump: false, attack: false, special: false, shield: false, grab: false, stickX: 0, stickY: 0 };
    }
    const dz = GAMEPAD_STICK_DEADZONE;
    const ax = gp.axes[0] || 0;
    const ay = gp.axes[1] || 0;
    const stickX = Math.abs(ax) > dz ? ax : 0;
    const stickY = Math.abs(ay) > dz ? ay : 0;
    const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const left = stickX < -dz || btn(14);
    const right = stickX > dz || btn(15);
    const up = stickY < -dz || btn(12);
    const down = stickY > dz || btn(13);
    return {
      left, right, up, down,
      jump: btn(GAMEPAD_BUTTONS.jump),
      attack: btn(GAMEPAD_BUTTONS.attack),
      special: btn(GAMEPAD_BUTTONS.special),
      shield: btn(GAMEPAD_BUTTONS.shield) || btn(GAMEPAD_BUTTONS.shieldAlt),
      grab: btn(GAMEPAD_BUTTONS.grab),
      stickX, stickY,
    };
  }
}

export class InputPlayer {
  constructor(source) {
    this.source = source;
    this.prev = { jump: false, attack: false, special: false, grab: false };
  }
  // Called once per fixed sim tick. Returns a small plain object safe to
  // JSON-serialize and replay identically on a remote peer.
  sample() {
    const raw = this.source.poll();
    const frame = {
      l: raw.left ? 1 : 0,
      r: raw.right ? 1 : 0,
      u: raw.up ? 1 : 0,
      d: raw.down ? 1 : 0,
      sx: Math.round(raw.stickX * 100) / 100,
      sy: Math.round(raw.stickY * 100) / 100,
      jh: raw.jump ? 1 : 0,
      jp: raw.jump && !this.prev.jump ? 1 : 0,
      ap: raw.attack && !this.prev.attack ? 1 : 0,
      spp: raw.special && !this.prev.special ? 1 : 0,
      sh: raw.shield ? 1 : 0,
      gp: raw.grab && !this.prev.grab ? 1 : 0,
    };
    this.prev = { jump: raw.jump, attack: raw.attack, special: raw.special, grab: raw.grab };
    return frame;
  }
}

export const EMPTY_INPUT = Object.freeze({ l: 0, r: 0, u: 0, d: 0, sx: 0, sy: 0, jh: 0, jp: 0, ap: 0, spp: 0, sh: 0, gp: 0 });

// Builds the two local InputPlayer instances for a match. Slot assignment:
// gamepads (in connection order) fill player slots first, keyboard schemes
// fill whatever's left — so plugging in a controller "just works" without
// menu config, matching the couch-fighting-game expectation.
export function detectLocalSources() {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  const sources = [];
  for (const gp of pads) sources.push(new GamepadSource(gp.index));
  const usedKeyboard = sources.length;
  if (sources.length < 2) sources.push(new KeyboardSource(KEYBOARD_SCHEMES.p1));
  if (sources.length < 2) sources.push(new KeyboardSource(KEYBOARD_SCHEMES.p2));
  return sources.slice(0, 2).map((s) => new InputPlayer(s));
}

export function listGamepads() {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  return pads.map((p) => ({ index: p.index, id: p.id }));
}
