"""The loan desk's Deep Agent, on Managed Deep Agents.

One middleware does the Arcade work: Sam Partee's `ArcadeMiddleware` (vendored in
`langchain_arcade/`) finds tools with `arcade_select_tools` and calls them through the
Arcade engine directly, with the project key. There is no gateway, so Tool Rec is not
scoped to the loan desk: it may also offer catalog tools such as Ashby or ClickUp. That is
fine because nothing relies on search to hide a tool. The project's hooks govern every call,
whichever tool the model picked.

Every call is made as the signed-in person. MDA verifies the caller's ID token from the
app's identity provider (`identity.py`) and hands the verified email to the middleware as
`server_info.principal.id`. A run without one gets no user id, so every tool call fails
closed. Whether that person may approve a $95K loan is not decided here: the gate's
contextual access hooks decide it on every call, the same way for this agent as for any
other client.

The model is scripted unless `MODEL_ID` names a real one, so `mda dev` and the tests run
without a model key.
"""

import os

from langchain_arcade import ArcadeMiddleware
from langchain_arcade.provider import EngineProvider
from managed_deepagents import define_deep_agent

from scripted import ScriptedModel


def signed_in_user(runtime) -> str | None:
    """The verified caller's email, or None when MDA verified nobody."""
    principal = getattr(getattr(runtime, "server_info", None), "principal", None)
    user = getattr(principal, "id", None)
    return user if isinstance(user, str) and "@" in user else None


# The provider falls back to `$ARCADE_GATEWAY_ID` when no gateway is passed. An older .env
# or deployment may still set it, and a gateway that has since been deleted would break
# selection, so it is dropped here rather than left to chance.
os.environ.pop("ARCADE_GATEWAY_ID", None)

provider = EngineProvider(
    api_key=os.environ.get("ARCADE_API_KEY"),
    user_id_resolver=signed_in_user,
)

agent = define_deep_agent(
    name="loan-desk",
    model=os.environ.get("MODEL_ID") or ScriptedModel(),
    middleware=[ArcadeMiddleware(provider=provider)],
)
