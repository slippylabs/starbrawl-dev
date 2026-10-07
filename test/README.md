# StarBrawl tests

Three suites, cheapest first. The first two need nothing but Node; the third
needs a running server and a browser.

## `rollback_state_test.mjs` — state serialization

    node test/rollback_state_test.mjs

Proves the property rollback stands on: rewinding to a snapshot and replaying
the same inputs lands on identical state. Also pins the four fields a naive
clone gets wrong (`currentMove.hitKeys` is a Set, `char`/`stage`/`move.data`
must stay by reference, `movementOverride` must not be aliased) and the
`Infinity` in `timeLimitFrames` that a JSON round-trip would destroy.

## `rollback_netplay_test.mjs` — the netcode, headless

    node test/rollback_netplay_test.mjs

Two `RollbackSim` peers over a fake transport at 0/2/5/9 frames of latency,
plus a reference simulation that had perfect information. Both peers must
equal the reference exactly — agreeing with each other is not enough, since
two peers can agree on something wrong.

## `rollback_test.mjs` — two real browsers

    SB_PLAYWRIGHT=/path/to/playwright-core/index.mjs \
    SB_CHROME=/path/to/chrome \
    SB_URL=http://127.0.0.1:8111/ \
    node test/rollback_test.mjs

Drives two browser contexts through a real room match over the real Socket.IO
relay with injected latency (`SB_LATENCY`, default 60ms). Start a server first:

    venv/bin/python -c "import app; app.socketio.run(app.app, host='127.0.0.1', port=8111)"

playwright-core is not vendored here. On this box:
`SB_PLAYWRIGHT=/home/slippy/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs`
and `SB_CHROME=/home/slippy/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`.

Two things this test learned the hard way:

- **Pump one frame at a time.** Pumping in bursts lets the network get ahead of
  the simulation, so nothing is ever predicted and rollback is never exercised
  — the test goes green while testing nothing.
- **`settle()` before reading checksums.** A packet arriving while the sim is
  paused only marks a rollback *pending*; the rewind happens on the next pump.
  Comparing checksums in between compares two un-rewound predictions and
  reports a desync that isn't one.

It also runs against the lockstep fallback (`NETPLAY_ROLLBACK = false` in
`constants.js`) and adapts its assertions. That comparison is worth running
after any netcode change: at 60ms injected latency lockstep stalled on 17 of 40
sampled pumps, rollback on 0.

## `reconnect_test.mjs` — a dropped socket (v1.4.1)

Same environment variables and server as `rollback_test.mjs`. Forces a
transport drop (`socket.io.engine.close()`) on the room creator and on the
joiner, in character select and mid-match, and asserts no client is left on an
online screen its opponent has left. socket.io reconnects on its own as a new
socket in no room, so before v1.4.1 the dropped player sat in a lobby nobody
else was in, or a match frozen on SYNCING, while the opponent had already been
sent to the menu. All four cases failed on v1.4.0.
