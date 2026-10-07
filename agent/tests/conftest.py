"""Offline settings for the agent's tests.

`agent.py` and `identity.py` read their settings at import, the way MDA loads them. These
placeholders let both import with no `.env` and no network: nothing here is a key, and no
test reaches Arcade, LangSmith or a model.
"""

import os

os.environ.setdefault("ARCADE_API_KEY", "placeholder-not-a-key")
os.environ.setdefault("ARCADE_GATEWAY_ID", "gw-test")
os.environ.setdefault("LOAN_DESK_ISSUER", "https://bank.example/")
os.environ.setdefault("IDP_CLIENT_ID", "web-client-test")
os.environ.pop("MODEL_ID", None)
