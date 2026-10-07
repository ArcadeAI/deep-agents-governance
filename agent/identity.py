"""Who may call the agent: whoever the loan desk's own identity provider signed in.

The app at the repo root runs Better Auth as its IdP and signs ID tokens with RS256
(`auth/provider/auth.ts`). Callers send that ID token as `Authorization: Bearer`. MDA
checks it against the app's published keys at `/jwks` and the web client's id, and the
verified email becomes the caller, which `agent.py` reads as the Arcade user id.

The issuer is `APP_PUBLIC_HOST` with its scheme, the same value the app uses
(`issuerOf` in `auth/provider/config.ts`). The audience is the app's `IDP_CLIENT_ID`.
Both come from this directory's `.env`; neither is a secret. The issuer has to be the
public host, because MDA fetches `/jwks` from wherever the agent runs.

An agent that cannot verify its callers does not start: a missing value stops the import
with the name of the variable, rather than falling back to anything.
"""

import os

from managed_deepagents import define_identity


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set. Copy agent/.env.example to agent/.env and fill it in.")
    return value


ISSUER = required("LOAN_DESK_ISSUER").rstrip("/")

identity = define_identity(
    auth={
        "id": "loan-desk-idp",
        "issuer": ISSUER,
        "jwks": f"{ISSUER}/jwks",
        "audience": required("IDP_CLIENT_ID"),
        "algorithms": ["RS256"],
        "claims": {"user": "email", "email": "email"},
    }
)
