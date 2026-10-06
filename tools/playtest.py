#!/usr/bin/env python
"""PLAY starbrawl and measure what the eye sees.

    ~/projects/medievalmmo-dev/venv/bin/python tools/playtest.py


The panel is SIMULATED inside the real browser. This box renders these games
fast enough, but the real rAF cadence still cannot show a 60 Hz beat on demand,
and two of the eight have a worker clock whose beat is not the display's at
all. So the clocks are scheduled here: the simulation is stepped the number of
times each frame owes, the frame is drawn with redraw() at the alpha that panel
would be at, and the entity positions it actually drew are read back out.

Real keyboard input through the real handlers, the real engine, the real
renderer, the real draw path.

Two arms every run:
  shipped -- the frame spends the accumulator (and the worker tick too, where
             the game has one), and draws at the alpha it is at.
  old     -- for the six rAF games, the frame spends it and draws at alpha 1;
             for the two worker games, ONLY the worker spends it. Both are
             what those games actually did before the fix.

The statistic is the one the 3D play test arrived at after four tries: drawn
distance per frame compared against the median of its own CONTIGUOUS
neighbours. Judging a frame against an absolute speed counts honest
acceleration as unevenness; stutter is a high-frequency alternation and
acceleration is a slow drift. Frames the game's OWN snap rule fired on are
excluded -- a respawn or a round reset is a discontinuity by design.
"""
import json
import statistics
import sys
import functools
import http.server
import socketserver
import threading

from playwright.sync_api import sync_playwright

RUN = """(({ hz, frames, script, seed, mode, workerMs, ipJs, stepJs, dt }) => {
  const IP = eval(ipJs), STEP = eval(stepJs);
  const shipped = mode === 'shipped';
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };

  const presses = new Map();
  for (const [code, atS, lenS] of script) {
    presses.set(Math.round(atS * hz), [code, Math.max(1, Math.round(lenS * hz))]);
  }
  const upAt = new Map();
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));

  let acc = 0;
  const pump = () => { let n = 0; while (acc >= dt && n < 8) { acc -= dt; n += 1; } if (n) STEP(n); return n; };

  const rows = [];
  let tMs = 0, nextFrame = 0, nextWorker = workerMs || Infinity, frame = 0, lastT = 0;
  while (frame < frames) {
    const t = Math.min(nextFrame, nextWorker);
    acc += (t - tMs) / 1000;
    tMs = t;
    if (workerMs && t === nextWorker) { pump(); nextWorker += workerMs; }
    if (t === nextFrame) {
      if (presses.has(frame)) {
        const [code, len] = presses.get(frame);
        key('keydown', code);
        upAt.set(frame + len, code);
      }
      if (upAt.has(frame)) { key('keyup', upAt.get(frame)); upAt.delete(frame); }

      // The shipped loop spends the accumulator at the top of the frame. The
      // 'old' arm of a worker-clock game does not -- that is the whole point.
      let n = 0;
      if (shipped || !workerMs) n = pump();
      const alpha = shipped ? Math.min(1, Math.max(0, acc / dt)) : 1;
      const r = IP.redraw(alpha);
      rows.push({ dt: (tMs - lastT) / 1000, n, alpha, snapped: r.snapped, drawn: r.drawn });
      lastT = tMs;
      frame += 1;
      nextFrame += (1000 / hz) * (1 + (rnd() - 0.5) * 0.04);
    }
  }
  for (const code of upAt.values()) key('keyup', code);
  return rows;
})"""


def bad_fields(rows):
    """Entities whose declared fields are not finite numbers.

    Such an entity is snapped on EVERY frame -- the distance comes out NaN and
    the guard is deliberately NaN-safe -- so it goes on stuttering exactly as
    before while everything else looks fine. Bubble Trouble's ropes were listed
    with fields x,y when the end that moves is `tipY`; there is no `y` on a rope
    at all. It surfaced as a crash in this analysis rather than as a finding,
    which is the wrong way round, so it is a check now.
    """
    bad = 0
    for r in rows:
        for d in r.get("drawn") or []:
            for k, v in d.items():
                if not isinstance(v, (int, float)):
                    bad += 1
                    break
    return bad


def analyse(rows, pin=None):
    """Local unevenness of the drawn path of the busiest entity."""
    # The entity set changes as things spawn and die; work on the modal length
    # so an index means the same entity across the frames being compared.
    lens = [len(r["drawn"]) for r in rows if r["drawn"]]
    if not lens:
        return None
    modal = statistics.mode(lens)
    usable = [(i, r) for i, r in enumerate(rows) if len(r["drawn"]) == modal and not r["snapped"]]
    if len(usable) < 50:
        return None
    # Busiest index = most total path length.
    paths = [0.0] * modal
    for (ia, a), (ib, b) in zip(usable, usable[1:]):
        if ib != ia + 1:
            continue
        for k in range(modal):
            pa, pb = a["drawn"][k], b["drawn"][k]
            try:
                paths[k] += ((pb["x"] - pa["x"]) ** 2 + (pb.get("y", 0) - pa.get("y", 0)) ** 2) ** 0.5
            except TypeError:
                pass
    k = pin if (pin is not None and pin < modal) else max(range(modal), key=lambda j: paths[j])
    if paths[k] <= 0:
        return None

    samples = []
    for (ia, a), (ib, b) in zip(usable, usable[1:]):
        if ib != ia + 1 or b["dt"] <= 0:
            continue
        pa, pb = a["drawn"][k], b["drawn"][k]
        try:
            gap = ((pb["x"] - pa["x"]) ** 2 + (pb.get("y", 0) - pa.get("y", 0)) ** 2) ** 0.5
        except TypeError:
            continue          # a non-numeric field; bad_fields() reports it
        samples.append({"rate": gap / b["dt"], "i": ib})
    if len(samples) < 50:
        return None

    W = 4
    local, dupes, stops = [], 0, 0
    for i in range(len(samples)):
        nb = []
        for j in range(i - 1, max(-1, i - 1 - W), -1):
            if samples[j]["i"] != samples[j + 1]["i"] - 1:
                break
            nb.append(samples[j]["rate"])
        for j in range(i + 1, min(len(samples), i + 1 + W)):
            if samples[j]["i"] != samples[j - 1]["i"] + 1:
                break
            nb.append(samples[j]["rate"])
        if len(nb) < 4:
            continue
        med = statistics.median(nb)
        if med <= 1e-9:
            continue
        local.append(abs(samples[i]["rate"] - med) / med)
        if samples[i]["rate"] >= med * 0.1:
            continue
        # A STOP IS NOT A STUTTER. A fighter walking into a wall, a pod against
        # rock, a ball coming to rest: the drawn motion really is zero and
        # stays zero. The stutter signature is an ISOLATED zero between two
        # frames that moved -- that is the alternation, and nothing else makes
        # one. Counting every zero blamed the renderer for the game stopping.
        prev_moving = i > 0 and samples[i - 1]["i"] == samples[i]["i"] - 1 \
            and samples[i - 1]["rate"] > med * 0.5
        next_moving = i + 1 < len(samples) and samples[i + 1]["i"] == samples[i]["i"] + 1 \
            and samples[i + 1]["rate"] > med * 0.5
        if prev_moving and next_moving:
            dupes += 1
        else:
            stops += 1
    # 50, not a round 100: Gumball Slugger's pitch cadence is a wall-clock
    # setTimeout that a synchronous probe cannot let fire, so a run there is one
    # ball's flight -- about 60 frames at 60 Hz. A median over 50 samples is a
    # perfectly good median; what would not be good is quietly dropping the
    # requirement that the neighbours be contiguous.
    if len(local) < 50:
        return None
    local_sorted = sorted(local)
    return {
        "entity": k,
        "n": len(local),
        "local_med": statistics.median(local),
        "local_p95": local_sorted[int(len(local_sorted) * 0.95)],
        "inband": sum(1 for v in local if v < 0.25) / len(local),
        "dupes": dupes,
        "stops": stops,
    }


def serve(root):
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)

    class S(socketserver.TCPServer):
        allow_reuse_address = True

        def handle_error(self, *a):
            pass

    httpd = S(("127.0.0.1", 0), h)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main(cfg_path):
    cfg = json.load(open(cfg_path))
    fails = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        for g in cfg:
            httpd, port = serve(g["root"])
            page = b.new_page(viewport={"width": 560, "height": 360})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            print(f"\n{g['name']}")
            try:
                page.goto(f"http://127.0.0.1:{port}{g.get('url', '/')}", wait_until="load", timeout=120000)
                page.wait_for_function(g["ready"], timeout=120000)
                page.evaluate(g["play"])
                page.wait_for_timeout(1000)
                bad = {}
                for hz in (60, 144):
                    res = {}
                    bad[hz] = 0
                    for mode in ("shipped", "old"):
                        page.evaluate(g["play"])          # a fresh round per arm
                        page.wait_for_timeout(400)
                        rows = page.evaluate(RUN + "(" + json.dumps({
                            "hz": hz, "frames": int(g.get("seconds", 10) * hz),
                            "script": g["script"], "seed": 9, "mode": mode,
                            "workerMs": g.get("workerMs", 0), "ipJs": g["ip"],
                            "stepJs": g["step"], "dt": g.get("dt", 1 / 60),
                        }) + ")")
                        res[mode] = analyse(rows, g.get("pin"))
                        bad[hz] += bad_fields(rows)
                    on, off = res["shipped"], res["old"]
                    if bad[hz]:
                        fails.append(f"{g['name']} {hz}Hz: {bad[hz]} drawn entities have a "
                                     "non-numeric declared field -- they are NaN-snapped every frame")
                    if not on:
                        fails.append(f"{g['name']} {hz}Hz: too little steady motion to judge")
                        print(f"  {hz:3d} Hz  NOT ENOUGH STEADY MOTION")
                        continue
                    for lbl, m in (("shipped", on), ("old", off)):
                        if not m:
                            print(f"          {lbl:8s} too little steady motion -- arm inconclusive")
                            continue
                        print(f"          {lbl:8s} entity {m['entity']}  {m['n']:4d} frames  "
                              f"local: med {m['local_med']*100:5.1f}% p95 {m['local_p95']*100:6.1f}%  "
                              f"in-band {m['inband']*100:5.1f}%  "
                              f"dupes {m['dupes']:4d}  (stops {m['stops']})")
                    if on["local_med"] > 0.02:
                        fails.append(f"{g['name']} {hz}Hz: the median frame deviates "
                                     f"{on['local_med']*100:.1f}% from its neighbours")
                    if on["dupes"] > 0:
                        fails.append(f"{g['name']} {hz}Hz: {on['dupes']} duplicate frames in the shipped loop")
                    if hz == 144 and off and not (off["dupes"] > on["dupes"] + 5
                                                  or off["local_p95"] > on["local_p95"] * 3):
                        fails.append(f"{g['name']} 144Hz: the OLD loop is not measurably worse "
                                     f"(p95 {off['local_p95']*100:.1f}% vs {on['local_p95']*100:.1f}%, "
                                     f"{off['dupes']} dupes vs {on['dupes']}) -- cannot discriminate")
                if errors:
                    fails.append(f"{g['name']}: page errors {errors[:2]}")
                print(f"  errors: {errors[:2] if errors else 'none'}")
            except Exception as e:
                fails.append(f"{g['name']}: {type(e).__name__}: {str(e)[:140]}")
                print(f"  FAILED: {type(e).__name__}: {str(e)[:140]}")
            page.close()
            httpd.shutdown()
        b.close()
    print()
    for f in fails:
        print("FAIL " + f)
    print("play test: every game well paced" if not fails else f"play test: {len(fails)} problems")
    return 1 if fails else 0


# This game's own configuration. PIN tracks a specific entity index instead of
# the busiest one; None picks the busiest.
PIN = None
GAME = {
    "name": "starbrawl",
    "ready": "window.__ip",
    "play": "window.__ip.quickMatch()",
    "ip": "window.__ip",
    "step": "(n)=>window.__ip.step(n)",
    "script": [
        [
            "KeyD",
            0.0,
            1.2
        ],
        [
            "KeyA",
            1.5,
            1.0
        ],
        [
            "KeyJ",
            2.6,
            0.1
        ],
        [
            "KeyD",
            3.0,
            1.5
        ],
        [
            "KeyW",
            4.6,
            0.2
        ],
        [
            "KeyA",
            5.0,
            1.2
        ],
        [
            "KeyK",
            6.3,
            0.1
        ],
        [
            "KeyD",
            6.6,
            1.6
        ],
        [
            "KeyA",
            8.4,
            1.4
        ]
    ]
}

if __name__ == "__main__":
    import os
    GAME["root"] = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    GAME['root'] = os.path.join(GAME['root'], 'static')
    if PIN is not None:
        GAME["pin"] = PIN
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".playtest.json")
    json.dump([GAME], open(cfg_path, "w"))
    try:
        sys.exit(main(cfg_path))
    finally:
        os.unlink(cfg_path)
