"""Offline settings for the agent's tests.

`agent.py` and `identity.py` read their settings at import, the way MDA loads them. These
placeholders let both import with no `.env` and no network: nothing here is a key, and no
test reaches Arcade, LangSmith, Okta or a model. The issuer's discovery document is
answered here, in the shape Okta's custom authorization servers publish.
"""

import io
import json
import os
import urllib.request

ISSUER = "https://bank.example/oauth2/default"
DISCOVERY = {
    "issuer": ISSUER,
    "authorization_endpoint": f"{ISSUER}/v1/authorize",
    "token_endpoint": f"{ISSUER}/v1/token",
    "userinfo_endpoint": f"{ISSUER}/v1/userinfo",
    "jwks_uri": f"{ISSUER}/v1/keys",
}
discovery_requests: list[str] = []

_real_urlopen = urllib.request.urlopen


def _urlopen(request, *args, **kwargs):
    url = request if isinstance(request, str) else request.full_url
    if url.startswith("https://bank.example/"):
        discovery_requests.append(url)
        if url == f"{ISSUER}/.well-known/openid-configuration":
            return io.BytesIO(json.dumps(DISCOVERY).encode())
        raise AssertionError(f"the tests answer only the discovery document, not {url}")
    return _real_urlopen(request, *args, **kwargs)


urllib.request.urlopen = _urlopen

os.environ.setdefault("ARCADE_API_KEY", "placeholder-not-a-key")
# Left over from when the agent was scoped to a gateway: `agent.py` must ignore it.
os.environ["ARCADE_GATEWAY_ID"] = "gw-left-over"
os.environ["IDP_ISSUER"] = f"{ISSUER}/"
os.environ.pop("LOAN_DESK_ISSUER", None)
os.environ["IDP_CLIENT_ID"] = "0oa-okta-app-test"
os.environ.pop("MODEL_ID", None)
