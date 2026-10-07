"""Sign in through the loan desk, then ask the Deep Agent as that person.

    uv run --env-file .env python ask.py "Which loan applications are pending?"
    uv run --env-file .env python ask.py --agent https://<deployment> "Approve LN-2291 at $95K"

Authorization code with PKCE against the app's own identity provider, as the app's web
client, caught on loopback (`127.0.0.1:8765`, which `setup-arcade` allowlists). The ID token
goes straight into the run as `Authorization: Bearer` and is never printed. MDA verifies it
(`identity.py`), and the agent makes every Arcade call as the email inside it.

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

CALLBACK = ("127.0.0.1", 8765)
REDIRECT = f"http://{CALLBACK[0]}:{CALLBACK[1]}/callback"
ASSISTANT = "loan-desk"


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def authorize_url(issuer: str, client_id: str, challenge: str, state: str) -> str:
    return f"{issuer}/oauth2/authorize?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "scope": "openid email",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })


def catch_code(state: str) -> str:
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

    with http.server.HTTPServer(CALLBACK, Callback) as server:
        server.handle_request()
    if "code" not in caught:
        sys.exit("Sign-in did not come back with a code for this request.")
    return caught["code"]


def id_token(issuer: str, client_id: str, client_secret: str, code: str, verifier: str) -> str:
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    request = urllib.request.Request(
        f"{issuer}/oauth2/token",
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


def ask(agent: str, token: str, prompt: str) -> dict:
    body = {"assistant_id": ASSISTANT, "input": {"messages": [{"role": "user", "content": prompt}]}}
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
    args = parser.parse_args()

    missing = [name for name in ("LOAN_DESK_ISSUER", "IDP_CLIENT_ID", "IDP_CLIENT_SECRET") if not os.environ.get(name)]
    if missing:
        sys.exit(f"Not set: {', '.join(missing)}. See agent/.env.example.")
    issuer = os.environ["LOAN_DESK_ISSUER"].rstrip("/")

    verifier, challenge = pkce()
    state = secrets.token_urlsafe(16)
    url = authorize_url(issuer, os.environ["IDP_CLIENT_ID"], challenge, state)
    print(f"Sign in as the person asking: {url}", file=sys.stderr)
    webbrowser.open(url)
    code = catch_code(state)
    token = id_token(issuer, os.environ["IDP_CLIENT_ID"], os.environ["IDP_CLIENT_SECRET"], code, verifier)

    print("\n".join(transcript(ask(args.agent.rstrip("/"), token, args.prompt))))


if __name__ == "__main__":
    main()
