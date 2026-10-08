import time, socketio, sys
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8111"
FAILS = []
def check(l, c, d=""):
    print(("PASS " if c else "FAIL ") + l + (("  " + str(d)) if d else ""))
    if not c: FAILS.append(l)
class C:
    def __init__(s):
        s.ev = []; s.sio = socketio.Client()
        s.sio.on("*", lambda e, d=None: s.ev.append((e, d)))
        s.sio.connect(URL, transports=["websocket"])
    def wait(s, name, t=3):
        end = time.time() + t
        while time.time() < end:
            for e, d in s.ev:
                if e == name: return d
            time.sleep(0.03)
    def count(s, name): return sum(1 for e, _ in s.ev if e == name)
for dropped in ("creator", "joiner"):
    print("==", dropped)
    a, b = C(), C()
    a.sio.emit("create_room"); code = a.wait("room_created")["code"]
    b.sio.emit("join_room", {"code": code}); b.wait("match_found"); a.wait("match_found")
    old = a if dropped == "creator" else b
    other = b if dropped == "creator" else a
    # The same browser opens a new socket while the old one is still live.
    new = C()
    new.sio.emit("join_room", {"code": code})
    time.sleep(0.5)
    check("new socket does not take a second seat", new.count("match_found") == 0 and new.wait("join_error") is not None, new.ev)
    check("opponent saw no second match_found", other.count("match_found") == 1)
    new.sio.emit("input", {"frame": 5, "input": {}})
    time.sleep(0.3)
    check("new socket's input is not relayed into the room", other.count("peer_input") == 0)
    old.sio.emit("input", {"frame": 5, "input": {}}); time.sleep(0.3)
    check("old live socket still relays exactly once", other.count("peer_input") == 1)
    # Old socket's late disconnect.
    old.sio.disconnect(); time.sleep(0.5)
    check("late disconnect tells the opponent exactly once", other.count("peer_left") == 1)
    check("late disconnect does not touch the new socket", new.sio.connected and new.count("peer_left") == 0)
    for c in (other, new): c.sio.disconnect()
print("all passed" if not FAILS else f"{len(FAILS)} FAILED")
