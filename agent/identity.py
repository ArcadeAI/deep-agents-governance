"""Who may call the agent: whoever the loan desk's identity provider signed in.

The loan desk signs people in through Okta (`IDP_ISSUER`), which signs ID tokens with
RS256. Callers send that ID token as `Authorization: Bearer`. MDA checks it against the
key set the issuer's discovery document names (`jwks_uri`) and the Okta app's client id,
and the verified email becomes the caller, which `agent.py` reads as the Arcade user id.

The issuer is `IDP_ISSUER`, the same value the app uses (`LOAN_DESK_ISSUER` still works,
the name it had before Okta). The audience is `IDP_CLIENT_ID`. Both come from this
directory's `.env`; neither is a secret.

An agent that cannot verify its callers does not start: a missing value, or an issuer
whose discovery does not answer, stops the import rather than falling back to anything.
"""

import os

from managed_deepagents import define_identity

from oidc import discover, issuer


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set. Copy agent/.env.example to agent/.env and fill it in.")
    return value


ISSUER = issuer()

identity = define_identity(
    auth={
        "id": "loan-desk-idp",
        "issuer": ISSUER,
        "jwks": discover(ISSUER)["jwks_uri"],
        "audience": required("IDP_CLIENT_ID"),
        "algorithms": ["RS256"],
        "claims": {"user": "email", "email": "email"},
    }
)
