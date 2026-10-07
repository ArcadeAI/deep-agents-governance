"""Where the Arcade user identity comes from.

Arcade authorizes tools *per user*, so nearly every call needs to know whose
account it is acting on. There are two very different shapes of application and
they want opposite things:

* A CLI or a single-user script has one identity for the whole process. Passing
  it once at construction is right.
* A server has one agent serving many people, and the identity is a property of
  the *request*, not the process. Construction time is far too early.

So identity resolves per invocation, highest priority first:

1. `runtime.context.arcade_user_id` — the recommended place for a server. Pass
   `ArcadeContext` (or your own context object carrying the same attribute) as
   `create_deep_agent(context_schema=...)` and supply it per `invoke`.
2. `config["configurable"]["arcade_user_id"]` — for hosts that already thread a
   config dict per request and would rather not add a context schema.
3. `ArcadeMiddleware(user_id=...)` — one identity for this agent instance.
4. `EngineProvider(user_id=...)`, or `$ARCADE_USER_ID` — transport default.

Anything earlier in that list wins, so a server can set a process-wide fallback
and still override it per request.

Example, single user:

    ArcadeMiddleware(provider=EngineProvider(), user_id="sam@example.com")

Example, many users:

    agent = create_deep_agent(
        middleware=[ArcadeMiddleware(provider=EngineProvider())],
        context_schema=ArcadeContext,
    )
    agent.invoke(payload, context=ArcadeContext(arcade_user_id=request.user.email))
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

USER_ID_CONFIG_KEY = "arcade_user_id"
"""Key read from `config["configurable"]`."""

USER_ID_CONTEXT_ATTR = "arcade_user_id"
"""Attribute read off the runtime context object."""

USER_ID_ENV_VAR = "ARCADE_USER_ID"
"""Environment variable used as the last resort."""

NO_IDENTITY_ERROR = (
    "No Arcade user identity is available, so this tool cannot run. Arcade "
    "authorizes tools per user. This is a setup problem in the host application, "
    "not something the user can answer — do not ask them for an email address "
    "and do not retry. Set one of: context ArcadeContext(arcade_user_id=...), "
    'config["configurable"]["arcade_user_id"], ArcadeMiddleware(user_id=...), '
    "or the ARCADE_USER_ID environment variable."
)
"""Returned to the model when no identity resolves.

Written at the model, because the model is who reads it. The explicit "do not
ask them for an email address" earns its place: a real session without it had the
model asking for an address, passing it as a tool argument, failing the same way,
and then re-selecting — four turns spent trying to repair configuration in
conversation.
"""

NO_TRUSTED_IDENTITY_ERROR = (
    "No Arcade user identity is available for this run, so this tool cannot "
    "run. The host resolves identity itself and found none for this caller. "
    "This is a setup problem in the host application, not something the user "
    "can answer. Do not ask them for an email address or user id, and do not "
    "retry."
)
"""Returned when a host-supplied trusted resolver yields no identity.

Kept apart from `NO_IDENTITY_ERROR` because that one lists run context and
config as fixes, and with a trusted resolver those are exactly the sources that
are ignored. Telling an operator to set them would send them the wrong way.
"""


@dataclass
class ArcadeContext:
    """Per-invocation Arcade identity.

    Pass as `create_deep_agent(context_schema=ArcadeContext)` and supply an
    instance per `invoke`. Any object exposing an `arcade_user_id` attribute
    works just as well — this class exists so there is an obvious typed default,
    not to force a schema on hosts that already have one.

    Attributes:
        arcade_user_id: Identity Arcade should execute and scope discovery as.
    """

    arcade_user_id: str | None = None


def _from_context(context: Any) -> str | None:
    """Read the identity attribute off a runtime context object, if present."""
    value = getattr(context, USER_ID_CONTEXT_ATTR, None)
    if value is None and isinstance(context, dict):
        value = context.get(USER_ID_CONTEXT_ATTR)
    return value if isinstance(value, str) and value else None


def _from_config(config: Any) -> str | None:
    """Read the identity from `config["configurable"]`, if present."""
    if not isinstance(config, dict):
        return None
    configurable = config.get("configurable")
    if not isinstance(configurable, dict):
        return None
    value = configurable.get(USER_ID_CONFIG_KEY)
    return value if isinstance(value, str) and value else None


def resolve_user_id(
    *,
    runtime: Any = None,
    fallback: str | None = None,
) -> str | None:
    """Resolve the Arcade identity for one call.

    Args:
        runtime: The `ToolRuntime` or LangGraph `Runtime` for this call, if any.
            Its `context` and `config` are consulted in that order.
        fallback: Identity configured on the middleware, used when the request
            carries none.

    Returns:
        The resolved identity, or `None` when nothing supplies one. The provider
        supplies the final environment-variable fallback, so `None` here does not
        necessarily mean the call will fail.

    Example:
        ```python
        resolve_user_id(runtime=request.runtime, fallback="svc@example.com")
        ```
    """
    if runtime is not None:
        from_context = _from_context(getattr(runtime, "context", None))
        if from_context:
            return from_context
        from_config = _from_config(getattr(runtime, "config", None))
        if from_config:
            return from_config
    return fallback


def describe_sources(
    *,
    runtime: Any = None,
    middleware_user_id: str | None = None,
    provider_user_id: str | None = None,
) -> Mapping[str, str | None]:
    """Report what each identity source currently yields.

    Intended for a `doctor`-style command or a debug log — "identity is not
    resolving" is otherwise an opaque failure with four possible causes.

    Args:
        runtime: The runtime for a call, if available.
        middleware_user_id: What the middleware was constructed with.
        provider_user_id: What the provider was constructed with or read from
            the environment.

    Returns:
        Source name to its value, in resolution order.
    """
    return {
        "context": _from_context(getattr(runtime, "context", None))
        if runtime
        else None,
        "config": _from_config(getattr(runtime, "config", None)) if runtime else None,
        "middleware": middleware_user_id,
        "provider_or_env": provider_user_id,
    }


__all__ = [
    "NO_IDENTITY_ERROR",
    "NO_TRUSTED_IDENTITY_ERROR",
    "USER_ID_CONFIG_KEY",
    "USER_ID_CONTEXT_ATTR",
    "USER_ID_ENV_VAR",
    "ArcadeContext",
    "describe_sources",
    "resolve_user_id",
]
