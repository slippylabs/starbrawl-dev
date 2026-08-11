from flask import Flask, send_from_directory
from flask_socketio import SocketIO

import sockets

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["SECRET_KEY"] = "starbrawl-dev-secret"

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="gevent")
sockets.register(socketio)


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    socketio.run(app, host="127.0.0.1", port=8011, debug=True)
