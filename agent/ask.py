"""Sign in through the loan desk, then ask the Deep Agent as that person.

    uv run --env-file .env python ask.py "Which loan applications are pending?"
    uv run --env-file .env python ask.py --agent https://<deployment> "Approve LN-2291 at $95K"

Authorization code with PKCE against the loan desk's identity provider (`IDP_ISSUER`, Okta),
as the Okta app, caught on loopback (`127.0.0.1:8765`, which `okta-setup` allowlists; the port
is fixed by that allowlist, and a run that is not signed in within five minutes frees it). The
endpoints are the ones the issuer's discovery document names (`oidc.py`). The ID token
goes straight into the run as `Authorization: Bearer` and is never printed. MDA verifies it
(`identity.py`), and the agent makes every loan desk call as the email inside it.

`--as <your email>` (or `CONNECTED_APPS_USER` in `.env`) names the address the agent uses
for Gmail and Slack instead. Sign in as the shared Alice, pass your own address, and Alice's
loan clearance is shared while the mailbox the agent sends from is yours. Arcade's verifier
binds that grant to the Arcade account that opens the link, so the address must be the one
your Arcade account uses, invited to the project.

The sign-in is kept, as the ID token, in `~/.cache/loan-desk-ask/` until it expires (an
hour, at Okta's default), so the browser opens once per hour, not once per question. The
file is this user's only (mode 0600) and still never printed. `--sign-in` throws it away and
signs in again, which is how you become Bob and then Alice again.

`--agent` defaults to `mda dev`'s local server. Standard library only.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime
from pathlib import Path

from oidc import discover, issuer as configured_issuer

CALLBACK = ("127.0.0.1", 8765)
REDIRECT = f"http://{CALLBACK[0]}:{CALLBACK[1]}/callback"
ASSISTANT = "loan-desk"


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def authorize_url(endpoint: str, client_id: str, challenge: str, state: str) -> str:
    return f"{endpoint}?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "scope": "openid email",
        # The sign-in is the person asking, every time: never a session left in the browser.
        "prompt": "login",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })


SIGN_IN_WAIT = 300  # seconds a sign-in may take before this run gives up and frees the port


def listen() -> http.server.HTTPServer:
    """Bind the loopback callback before the browser opens, so a taken port is a message, not a traceback.

    The port cannot move: the identity provider sends the sign-in back only to the address
    its app allows, and that is this one. What usually holds it is an earlier `ask.py` whose
    sign-in was never finished, which `SIGN_IN_WAIT` now bounds.
    """
    try:
        return http.server.HTTPServer(CALLBACK, _Callback)
    except OSError as exc:
        host, port = CALLBACK
        sys.exit(
            f"{host}:{port} is in use ({exc.strerror}). The identity provider sends the sign-in back only to this "
            f"port, so ask.py cannot pick another. Usually an earlier ask.py is still waiting for a sign-in: "
            f"free the port with `lsof -ti :{port} | xargs kill`, then ask again."
        )


class _Callback(http.server.BaseHTTPRequestHandler):
    """Placeholder; `catch_code` installs the handler that knows this run's `state`."""


def catch_code(server: http.server.HTTPServer, state: str) -> str:
    """Serve one request on loopback and return its `code`, refusing a foreign `state`."""
    caught: dict[str, str] = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if query.get("state", [""])[0] == state and "code" in query:
                caught["code"] = query["code"][0]
                body = b"Signed in. You can close this tab and go back to the terminal."
            else:
                body = b"This sign-in was not the one ask.py started."
            self.send_response(200)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_: object) -> None:
            pass

    with server:
        server.RequestHandlerClass = Callback
        server.timeout = SIGN_IN_WAIT
        server.handle_request()
    if "code" not in caught:
        sys.exit(f"No sign-in came back within {SIGN_IN_WAIT // 60} minutes. Run ask.py again to retry.")
    return caught["code"]


def id_token(endpoint: str, client_id: str, client_secret: str, code: str, verifier: str) -> str:
    basic = base64.b64encode(f"{urllib.parse.quote_plus(client_id)}:{urllib.parse.quote_plus(client_secret)}".encode()).decode()
    request = urllib.request.Request(
        endpoint,
        data=urllib.parse.urlencode({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
            "code_verifier": verifier,
        }).encode(),
        headers={"authorization": f"Basic {basic}", "content-type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["id_token"]


def claims(token: str) -> dict:
    """The ID token's payload, read and not verified: enough to know who and until when."""
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def session_path(issuer: str, client_id: str) -> Path:
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "loan-desk-ask"
    return base / (hashlib.sha256(f"{issuer}\n{client_id}".encode()).hexdigest()[:16] + ".json")


def saved_session(path: Path, now: float, margin: int = 60) -> str | None:
    """The kept ID token when it is still good for `margin` seconds, else None."""
    try:
        token = json.loads(path.read_text())["id_token"]
        return token if claims(token).get("exp", 0) - now > margin else None
    except (OSError, ValueError, KeyError, IndexError):
        return None


def keep_session(path: Path, token: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_text(json.dumps({"id_token": token}))


CONNECTED_APPS_USER_KEY = "connected_apps_user"


def run_body(prompt: str, connected_apps_user: str | None = None) -> dict:
    """The `/runs/wait` body: the question, and the connected-apps address when there is one."""
    body: dict = {"assistant_id": ASSISTANT, "input": {"messages": [{"role": "user", "content": prompt}]}}
    if connected_apps_user:
        body["config"] = {"configurable": {CONNECTED_APPS_USER_KEY: connected_apps_user}}
    return body


def ask(agent: str, token: str, prompt: str, connected_apps_user: str | None = None) -> dict:
    body = run_body(prompt, connected_apps_user)
    request = urllib.request.Request(
        f"{agent}/runs/wait",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.load(response)


def transcript(result: dict) -> list[str]:
    """One line per tool call, tool result and answer, in order."""
    lines = []
    for message in result.get("messages", []):
        kind = message.get("type")
        if kind == "ai":
            for call in message.get("tool_calls") or []:
                lines.append(f"→ {call['name']} {json.dumps(call.get('args', {}))}")
            if message.get("content"):
                lines.append(str(message["content"]))
        elif kind == "tool":
            lines.append(f"← {message.get('name')}: {str(message.get('content'))[:600]}")
    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("prompt")
    parser.add_argument("--agent", default=os.environ.get("AGENT_URL") or "http://127.0.0.1:2024")
    parser.add_argument(
        "--as",
        dest="connected_apps_user",
        metavar="EMAIL",
        default=os.environ.get("CONNECTED_APPS_USER") or None,
        help="your own address for Gmail and Slack, when the Okta sign-in is a shared persona",
    )
    parser.add_argument(
        "--sign-in",
        action="store_true",
        help="forget the kept sign-in and sign in again, as somebody else or the same person",
    )
    args = parser.parse_args()
    if args.connected_apps_user and "@" not in args.connected_apps_user:
        sys.exit(f"--as takes an email address, not {args.connected_apps_user!r}.")

    missing = [name for name in ("IDP_CLIENT_ID", "IDP_CLIENT_SECRET") if not os.environ.get(name)]
    if not (os.environ.get("IDP_ISSUER") or os.environ.get("LOAN_DESK_ISSUER")):
        missing.insert(0, "IDP_ISSUER")
    if missing:
        sys.exit(f"Not set: {', '.join(missing)}. See agent/.env.example.")
    issuer = configured_issuer()
    kept = session_path(issuer, os.environ["IDP_CLIENT_ID"])
    token = None if args.sign_in else saved_session(kept, datetime.now().timestamp())
    if token is None:
        endpoints = discover(issuer)
        verifier, challenge = pkce()
        state = secrets.token_urlsafe(16)
        url = authorize_url(endpoints["authorization_endpoint"], os.environ["IDP_CLIENT_ID"], challenge, state)
        server = listen()
        print(f"Sign in as the person asking: {url}", file=sys.stderr)
        webbrowser.open(url)
        code = catch_code(server, state)
        token = id_token(endpoints["token_endpoint"], os.environ["IDP_CLIENT_ID"], os.environ["IDP_CLIENT_SECRET"], code, verifier)
        keep_session(kept, token)
    who = claims(token)
    until = datetime.fromtimestamp(who.get("exp", 0)).strftime("%H:%M")
    print(f"Asking as {who.get('email', '?')}, signed in until {until}. --sign-in to be somebody else.", file=sys.stderr)

    print("\n".join(transcript(ask(args.agent.rstrip("/"), token, args.prompt, args.connected_apps_user))))


if __name__ == "__main__":
    main()
