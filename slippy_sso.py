"""Read-only Slippy Labs identity for a game backend.

admin.slippylabs.com issues a session cookie scoped to `.slippylabs.com`, so a
signed-in player's browser already sends it to every game subdomain. This
resolves it by forwarding that Cookie header to admin-console over loopback --
no shared secret, no database access, no change to admin-console.

Deliberately NOT done by adopting admin-console's SHARED_SESSION_SECRET as this
app's own `app.secret_key` with a `.slippylabs.com` cookie domain (the approach
games-portal and cloud-media use). That would make every game a writer of the
one domain-wide session: a single `session.clear()` anywhere would sign the
player out of the whole site. A game only ever needs to *read* who this is.

Fails closed. If admin-console is slow, down, or answers oddly, the player is
simply a guest -- a username is never taken on the client's word, because the
client is exactly who would lie about it.

Usage in an HTTP route or a Flask-SocketIO handler (both run in a request
context, so `flask.g` is available in either):

    import slippy_sso
    name = slippy_sso.current_username() or client_supplied_name
"""
import json
import os
import urllib.error
import urllib.request

from flask import g, request

ADMIN_WHOAMI_URL = os.environ.get("ADMIN_WHOAMI_URL", "http://127.0.0.1:8004/whoami")
TIMEOUT_S = 4


def whoami():
    """The raw /whoami answer for this request as a dict, {} when signed out.

    Cached on flask.g: a handler that wants both the name and the admin flag
    still makes one loopback call, and a socket connect handler that consults it
    twice does not pay twice."""
    # A dev/scratch convenience only, never set on a production unit. Mirrors
    # the casino's CASINO_TEST_USER.
    test_user = os.environ.get("SLIPPY_SSO_TEST_USER")
    if test_user:
        return {"authenticated": True, "username": test_user, "is_admin": False}

    cached = getattr(g, "_slippy_whoami", None)
    if cached is not None:
        return cached

    data = {}
    cookie_header = request.headers.get("Cookie", "")
    if cookie_header:
        req = urllib.request.Request(ADMIN_WHOAMI_URL, headers={"Cookie": cookie_header})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                payload = json.loads(resp.read())
            if payload.get("authenticated"):
                data = payload
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError):
            data = {}
    try:
        g._slippy_whoami = data
    except RuntimeError:
        pass
    return data


def current_username():
    """The signed-in slippylabs.com username, or None."""
    return whoami().get("username")


def is_admin():
    return bool(whoami().get("is_admin"))


def resolve_name(claimed, fallback="", max_len=20):
    """The name a player should actually appear under.

    The account wins outright when there is one -- that is the whole point: a
    signed-in player cannot be impersonated and cannot impersonate. Only a guest
    gets to pick, and only within the same limits the game already applied."""
    account = current_username()
    if account:
        return account[:max_len]
    claimed = (claimed or "").strip()
    return claimed[:max_len] if claimed else fallback
