"""The loan desk's Deep Agent, on Managed Deep Agents.

One middleware does the Arcade work: Sam Partee's `ArcadeMiddleware` (vendored in
`langchain_arcade/`) finds tools with `arcade_select_tools` and calls them through the
Arcade engine directly, with the project key. There is no gateway, so Tool Rec is not
scoped to the loan desk: it may also offer catalog tools such as Ashby or ClickUp. That is
fine because nothing relies on search to hide a tool. The project's hooks govern every call,
whichever tool the model picked.

Two identities, one run. MDA verifies the caller's ID token from the app's identity
provider (`identity.py`) and hands the verified email to the middleware as
`server_info.principal.id`: the **persona**, the person signed in at Okta. The loan desk
tools run as the persona, and so does discovery, because that is who the app's custom
verifier confirms a loan-API grant for and who the hooks hold to a clearance. A run without
one gets no user id, so every tool call fails closed.

Connected apps, Gmail and Slack, run as the caller's **own** address when the run names one
in `config.configurable.connected_apps_user` (`ask.py --as`). In a room where several
people sign in to Okta as the same Alice, that is what keeps Alice's loan clearance shared
and everybody's Gmail their own. Without one, every call is the persona, as before. The
value is caller-asserted: Arcade's own verifier binds the grant to the Arcade account that
opens the link, so a wrong address gets a `user_mismatch`, not somebody else's mailbox.

Whether that person may approve a $95K loan is not decided here: the gate's contextual
access hooks decide it on every call, the same way for this agent as for any other client.

The model is scripted unless `MODEL_ID` names a real one, so `mda dev` and the tests run
without a model key.
"""

import copy
import os
from typing import Any

from langchain_arcade import ArcadeMiddleware
from langchain_arcade.provider import EngineProvider
from managed_deepagents import define_deep_agent

from scripted import ScriptedModel

LOAN_DESK_TOOLKIT = os.environ.get("ARCADE_TOOLKIT", "").strip() or "LoanDesk"
"""The toolkit whose tools always run as the persona: the one `arcade deploy` filed."""

CONNECTED_APPS_USER_KEY = "connected_apps_user"
"""The `config.configurable` key a run names its own Gmail and Slack identity under."""


def signed_in_user(runtime) -> str | None:
    """The verified caller's email, or None when MDA verified nobody."""
    principal = getattr(getattr(runtime, "server_info", None), "principal", None)
    user = getattr(principal, "id", None)
    return user if isinstance(user, str) and "@" in user else None


def connected_apps_user(runtime) -> str | None:
    """The address the run asked to use for connected apps, lowercase, or None.

    Read from `runtime.config["configurable"]["connected_apps_user"]`, which `ask.py --as`
    sets. Anything that is not an email is ignored rather than passed to Arcade.
    """
    config = getattr(runtime, "config", None)
    configurable = config.get("configurable") if isinstance(config, dict) else None
    value = configurable.get(CONNECTED_APPS_USER_KEY) if isinstance(configurable, dict) else None
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    return value if "@" in value else None


def toolkit_of(fqn: str) -> str:
    """`LoanDesk` from `LoanDesk.SearchLoans@1.0.0` or `LoanDesk_SearchLoans`."""
    name = fqn.split("@", 1)[0]
    for separator in (".", "_"):
        if separator in name:
            return name.split(separator, 1)[0]
    return name


class SplitIdentityProvider(EngineProvider):
    """`EngineProvider` with the persona for the loan desk and the caller's own address for the rest.

    `bind` keeps the resolver's answer as the trusted identity, as the base class does, and
    remembers the run's connected-apps address beside it, only when there is a verified
    persona: an unverified run gets no identity at all. `execute` then picks per tool:
    loan desk tools as the persona, anything else as the caller's own address when the run
    named one. Discovery (`select`, `search`) stays the persona, so `/hooks/access` filters
    the list by the role the persona holds.
    """

    _connected_apps_user: str | None = None

    def bind(self, runtime: Any) -> EngineProvider:
        bound = super().bind(runtime)
        persona = bound._trusted_user_id  # noqa: SLF001 - the base class's own field
        bound._connected_apps_user = connected_apps_user(runtime) if persona else None  # noqa: SLF001
        return bound

    def identity_for(self, fqn: str) -> str | None:
        """The identity one tool call runs as, as `execute` will pick it."""
        own = self._connected_apps_user
        if own and toolkit_of(fqn) != LOAN_DESK_TOOLKIT:
            return own
        return self._trusted()

    def execute(self, fqn: str, inputs: dict[str, Any], *, user_id: str | None = None, query_id: str = ""):
        own = self.identity_for(fqn)
        if own == self._trusted():
            return super().execute(fqn, inputs, user_id=user_id, query_id=query_id)
        as_self = copy.copy(self)
        as_self._trusted_user_id = own  # noqa: SLF001
        return EngineProvider.execute(as_self, fqn, inputs, user_id=user_id, query_id=query_id)


# The provider falls back to `$ARCADE_GATEWAY_ID` when no gateway is passed. An older .env
# or deployment may still set it, and a gateway that has since been deleted would break
# selection, so it is dropped here rather than left to chance.
os.environ.pop("ARCADE_GATEWAY_ID", None)

provider = SplitIdentityProvider(
    api_key=os.environ.get("ARCADE_API_KEY"),
    user_id_resolver=signed_in_user,
)

agent = define_deep_agent(
    name="loan-desk",
    model=os.environ.get("MODEL_ID") or ScriptedModel(),
    middleware=[ArcadeMiddleware(provider=provider)],
)
