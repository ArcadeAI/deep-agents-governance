"""The control plane's audit log, read over HTTP, to set beside a trace.

`GET /hooks/audit` answers with the rows `governance.db` holds, behind the hook signing
secret (`gate/service/audit-api.ts`). The secret lives in the root `.env`, next to the app,
so this reads it from there when the environment does not carry it.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import requests

ROOT_ENV = Path(__file__).resolve().parent.parent.parent / ".env"
#: The reference a refusal ends with, the audit row's id (`gate/service/correlation.ts`).
REFERENCE = re.compile(r"\[ref (evt_[0-9a-hj-km-np-tv-z]{10})\]")


def file_value(name: str, path: Path) -> str:
    """`name`'s value from one env file alone, else empty. The shell is not consulted: this is
    for telling the file's key from one the shell exported."""
    if not path.exists():
        return ""
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip("\"'")
    return ""


def env_value(name: str, path: Path = ROOT_ENV) -> str:
    """`name`'s value from the environment, else from the root `.env`, else empty."""
    return os.environ.get(name, "").strip() or file_value(name, path)


#: The clearance a refusal states: the tenant's "more than $100,000 is above your clearance",
#: the repo's "exceeds your approval authority of 50000".
CLEARANCE = re.compile(r"more than \$?(\d[\d,]*)|authority of \$?(\d[\d,]*)")


def clearance_in(text: str) -> int | None:
    """The clearance a refusal states, as a number, or None when it states none."""
    match = CLEARANCE.search(text)
    return int((match.group(1) or match.group(2)).replace(",", "")) if match else None


def app_url() -> str:
    return (env_value("APP_URL") or "http://localhost:3000").rstrip("/")


DENIED = "denied by an extension policy"


def is_refusal(text: str) -> bool:
    """Whether a tool result is a pre-hook refusal: the repo's app ends one in a `[ref evt_…]`
    reference, the workshop's tenant says it was denied by an extension policy."""
    return reference_in(text) is not None or DENIED in text


def reference_in(text: str) -> str | None:
    """The `evt_…` reference in a refusal, or None."""
    match = REFERENCE.search(text)
    return match.group(1) if match else None


def rows(**filters: Any) -> list[dict[str, Any]]:
    """Audit rows, newest first. Filters are the endpoint's own: user_id, tool, hook, decision, since, limit."""
    secret = env_value("ARCADE_HOOK_SIGNING_SECRET")
    if not secret:
        raise RuntimeError("ARCADE_HOOK_SIGNING_SECRET is not set and the root .env does not hold it.")
    response = requests.get(
        f"{app_url()}/hooks/audit",
        params={k: v for k, v in filters.items() if v is not None},
        headers={"Authorization": f"Bearer {secret}"},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()["rows"]


def row_for(reference: str, **filters: Any) -> dict[str, Any] | None:
    """The audit row a refusal's reference points at, among the filtered rows."""
    return next((row for row in rows(**filters) if row.get("id") == reference), None)
