import sys

from flask import Flask, request, send_from_directory
from engineio.payload import Payload
from flask_socketio import SocketIO

import sockets

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["SECRET_KEY"] = "starbrawl-dev-secret"

# A client whose network blocks WebSockets falls back to long-polling and
# batches a poll interval of messages into one POST; engineio's default cap of
# 16 packets rejected it ("Too many packets in payload"). The real limit is
# max_http_buffer_size; the count only has to outlast a stalled poll.
Payload.max_decode_packets = 5000
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="gevent")


@socketio.on("connect")
def _log_connect(*args, **kwargs):
    """One journal line per socket, with the transport it arrived on: a player
    who never reached the server otherwise left no trace anywhere."""
    print(f"socket connect transport={request.args.get('transport')}", file=sys.stderr, flush=True)


sockets.register(socketio)


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    socketio.run(app, host="127.0.0.1", port=8011, debug=True)
