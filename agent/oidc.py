"""The identity provider's endpoints, read from its OIDC discovery document.

`IDP_ISSUER` is an Okta custom authorization server (`https://<org>.okta.com/oauth2/default`),
or any OIDC issuer. Nothing here knows Okta's paths: the authorize, token and key-set
endpoints are the ones `<issuer>/.well-known/openid-configuration` names, read once per
process. `LOAN_DESK_ISSUER` is the name this value had before Okta, still read when
`IDP_ISSUER` is blank. Standard library only, so `ask.py` can import it too.
"""

from __future__ import annotations

import functools
import json
import os
import urllib.request


def issuer() -> str:
    """`IDP_ISSUER`, or the older `LOAN_DESK_ISSUER`, without a trailing slash."""
    for name in ("IDP_ISSUER", "LOAN_DESK_ISSUER"):
        value = os.environ.get(name, "").strip()
        if value:
            return value.rstrip("/")
    raise RuntimeError("IDP_ISSUER is not set. Copy agent/.env.example to agent/.env and fill it in.")


@functools.cache
def discover(issuer: str) -> dict:
    """The issuer's discovery document, checked to name this issuer and the endpoints used here."""
    url = f"{issuer}/.well-known/openid-configuration"
    with urllib.request.urlopen(url, timeout=30) as response:
        document = json.load(response)
    if document.get("issuer") != issuer:
        raise RuntimeError(f"{url} names the issuer {document.get('issuer')!r}, not {issuer!r}.")
    missing = [key for key in ("authorization_endpoint", "token_endpoint", "jwks_uri") if not document.get(key)]
    if missing:
        raise RuntimeError(f"{url} has no {', '.join(missing)}.")
    return document
