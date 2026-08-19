// Shared simulation constants. Every number here is a "world unit" (px in a
// fixed 1280x720 logical space that the renderer scales to fit the canvas).
// Sim runs at a fixed 60Hz timestep regardless of display refresh rate.

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

export const GRAVITY = 0.62;
export const MAX_FALL_SPEED = 12.5;
export const FASTFALL_SPEED = 20;
export const GROUND_FRICTION = 0.62;
export const AIR_FRICTION = 0.02;

export const JUMPSQUAT_FRAMES = 4;
export const AIR_JUMP_COUNT_DEFAULT = 1;

export const SHIELD_MAX = 60;
export const SHIELD_DRAIN = 0.6;
export const SHIELD_REGEN = 0.45;
export const SHIELD_STUN_FRAMES = 90;

export const SPOTDODGE_FRAMES = 24;
export const SPOTDODGE_INTANGIBLE = [3, 15];
export const ROLL_FRAMES = 28;
export const ROLL_INTANGIBLE = [3, 16];
export const ROLL_SPEED = 9;

export const AIRDODGE_FRAMES = 32;
export const AIRDODGE_INTANGIBLE = [1, 20];
export const AIRDODGE_SPEED = 9.5;

export const HITSTUN_FACTOR = 0.42;
export const LAUNCH_KB_THRESHOLD = 90; // below this a grounded hit just staggers instead of launching

export const LEDGE_GRAB_RANGE_X = 34;
export const LEDGE_GRAB_RANGE_Y = 60;
export const LEDGE_INVINCIBLE_FRAMES = 30;
export const LEDGE_REGRAB_COOLDOWN = 24;

export const RESPAWN_INVINCIBLE_FRAMES = 120;
export const RESPAWN_DELAY_FRAMES = 70;

export const GRAB_RANGE = 58;
export const GRAB_STARTUP = 6;
export const GRAB_ENDLAG = 20;
export const THROW_ENDLAG = 26;
export const THROW_HITSTOP_FRAMES = 14; // deliberate freeze-frame beat on release, Smash-style throw weight

export const STAGE_W = 1280;
export const STAGE_H = 720;

// Controller/keyboard -> logical action mapping. Two independent keyboard
// layouts so 2 players can share one keyboard for local testing/offline play.
export const KEYBOARD_SCHEMES = {
  p1: {
    left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS',
    jump: 'KeyW', attack: 'KeyJ', special: 'KeyK', shield: 'KeyL', grab: 'KeyI',
  },
  p2: {
    left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
    jump: 'ArrowUp', attack: 'Numpad1', special: 'Numpad2', shield: 'Numpad3', grab: 'Numpad5',
  },
};

// Standard Gamepad API mapping (button indices per the "standard" gamepad layout).
export const GAMEPAD_BUTTONS = {
  jump: 0,       // A / Cross
  attack: 2,     // X / Square
  special: 3,    // Y / Triangle
  grab: 1,       // B / Circle
  shield: 6,     // Left trigger
  shieldAlt: 7,  // Right trigger
};
export const GAMEPAD_STICK_DEADZONE = 0.28;

// Netplay tuning. See netplay.js.
//
// Input delay is now 2 rather than 4: rollback covers the latency that the
// delay used to hide, and 2 frames still absorbs LAN-range jitter without a
// single rewind. Every frame here is ~16.7ms of lag on every button press.
export const NETPLAY_INPUT_DELAY = 2;
// How far ahead of confirmed remote input the sim will predict before it
// stops and waits. Past ~10 frames the replay is mostly guesswork about what
// the opponent did, and a client is better off plainly being behind than
// being confidently wrong.
export const MAX_ROLLBACK_FRAMES = 10;
// Frames between checksum exchanges for desync detection.
export const DESYNC_CHECK_EVERY = 60;
// Use rollback (true) or the original input-delay lockstep (false). Kept as a
// switch rather than deleting LockstepSim so a bad rollback in the wild is one
// constant away from the known-good behaviour.
export const NETPLAY_ROLLBACK = true;
