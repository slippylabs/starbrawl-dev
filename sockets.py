"""Netplay relay: room matchmaking + input passthrough between exactly two
sockets. The server holds no gameplay state and never runs the simulation —
each client's engine.js is deterministic given an identical input stream, so
all this does is get that stream from one peer to the other with a room code
in between. See static/js/netplay.js for the client side of this contract.
"""
import random
import string

from flask_socketio import join_room as sio_join_room, leave_room, emit

CODE_CHARS = "".join(c for c in string.ascii_uppercase + string.digits if c not in "0O1I")

rooms = {}       # code -> {"sids": [sid, ...]}
sid_to_room = {}  # sid -> code


def _new_code():
    while True:
        code = "".join(random.choice(CODE_CHARS) for _ in range(4))
        if code not in rooms:
            return code


def register(socketio):
    @socketio.on("create_room")
    def on_create_room():
        code = _new_code()
        rooms[code] = {"sids": [request_sid()]}
        sid_to_room[request_sid()] = code
        sio_join_room(code)
        emit("room_created", {"code": code})

    @socketio.on("join_room")
    def on_join_room(data):
        code = (data or {}).get("code", "").strip().upper()
        room = rooms.get(code)
        if not room:
            emit("join_error", {"reason": "Room not found."})
            return
        if len(room["sids"]) >= 2:
            emit("join_error", {"reason": "Room is full."})
            return
        sid = request_sid()
        room["sids"].append(sid)
        sid_to_room[sid] = code
        sio_join_room(code)
        # Tell each participant their own player index individually.
        emit("match_found", {"playerIndex": 1}, room=sid)
        emit("match_found", {"playerIndex": 0}, room=room["sids"][0])

    @socketio.on("pick")
    def on_pick(data):
        _relay("peer_pick", data)

    @socketio.on("ready")
    def on_ready():
        _relay("peer_ready", {})

    @socketio.on("start_match")
    def on_start_match(data):
        _relay("match_start", data)

    @socketio.on("input")
    def on_input(data):
        _relay("peer_input", data)

    @socketio.on("disconnect")
    def on_disconnect():
        sid = request_sid()
        code = sid_to_room.pop(sid, None)
        if not code:
            return
        room = rooms.get(code)
        if not room:
            return
        if sid in room["sids"]:
            room["sids"].remove(sid)
        _relay_to_room(code, sid, "peer_left", {})
        if not room["sids"]:
            rooms.pop(code, None)


def _relay(event, data):
    from flask import request as flask_request
    sid = flask_request.sid
    code = sid_to_room.get(sid)
    if not code or code not in rooms:
        return
    for other in rooms[code]["sids"]:
        if other != sid:
            emit(event, data, room=other)


def _relay_to_room(code, sender_sid, event, data):
    room = rooms.get(code)
    if not room:
        return
    for other in room["sids"]:
        if other != sender_sid:
            emit(event, data, room=other)


def request_sid():
    from flask import request as flask_request
    return flask_request.sid
