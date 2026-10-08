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

## `halfopen_test.mjs` + `halfopen_proto_test.py` — a half-open drop (v1.4.2)

A half-open drop is a Wi-Fi handoff or a sleeping phone. The old WebSocket
stops delivering in both directions without closing, so the server keeps the
seat until its ping timeout, and a fresh socket from the same player can arrive
while the stale one still holds it.

    venv-with-websocket-client/bin/python test/halfopen_proto_test.py http://127.0.0.1:8111
    node test/halfopen_test.mjs        # same env vars as rollback_test.mjs

The protocol probe uses raw socket.io clients. It checks that a new socket
joining the old room code gets "Room is full." rather than a second seat, that
its input is not relayed, that the live old socket's input is relayed exactly
once, and that the old socket's late disconnect sends exactly one `peer_left`
and leaves the new socket alone. This venv's python-socketio lacks
websocket-client. Any venv that has it will do (e.g. duskwatch-dev's).

The browser probe freezes the dropped page's WebSocket in 8 cases: creator and
joiner, lobby and mid-match. In the "notice" cases the page also sees the
transport close and tries the same code again at once. In the "silent" cases
nobody notices anything until the server's timeout.

Don't judge this with a single look at 55 s. engine.io's worst case is
ping_interval 25 + ping_timeout 20, plus one service-task sweep that can add
another ping_timeout, so roughly 65 s. On the live box the cases cleared
between 33 and 58 s, and a fixed 55 s check failed once on that alone. The
probe polls to 120 s and prints when each case cleared. Both probes pass on
v1.4.1 unchanged.
