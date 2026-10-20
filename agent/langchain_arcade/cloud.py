"""Provider for **Arcade Cloud**, over MCP.

Pick this when Arcade is the hosted multi-tenant service. Pick `EngineProvider`
when you are pointing at one specific Engine over REST — Arcade Cloud's own API,
or an Engine you run yourself inside your VPC. The split is which *deployment*
you are talking to, and the transport follows from it:

| | `ArcadeCloudProvider` | `EngineProvider` |
|---|---|---|
| Deployment | Arcade Cloud | one Engine: Cloud's API, or self-hosted |
| Transport | MCP | REST |
| OAuth / consent | handled server-side | yours, via `auth_mode` |
| Identity | the authenticated MCP session | `user_id` per call |
| Traffic leaves your network | yes | not if the Engine is yours |

A customer running Arcade in their own VPC — the deployment `devops/arcade-helm`
produces — wants `EngineProvider` pointed at that Engine. Sending their traffic
to `hub.arcade.dev` would defeat the reason they self-hosted.

Arcade Cloud exposes its meta-tools as ordinary MCP tools, with OAuth, gateway
scoping and per-user authorization handled server-side. `ArcadeCloudProvider`
adapts them to `ArcadeProvider`.

Two things follow from identity living in the session rather than in an
argument:

* **No `user_id` is ever sent.** The hub derives identity from the
  authenticated session. Forwarding a caller-named id would at best be ignored
  and at worst be honoured, which lets one user act as another by setting a
  key in run context or config. Every method accepts `user_id` for protocol
  conformance and drops it.
* **One session per user, not per process.** A server serving many people
  needs a different session for each of them, so a single `caller` bound at
  construction is the wrong shape there. Pass `caller_factory` instead: the
  middleware calls `bind(runtime)` / `abind(runtime)` per tool call, and the
  factory returns the caller for *that run's* user. It may be async, and so may
  the caller it returns; `aselect`, `asearch` and `aexecute` await both.

    async def caller_for(runtime):
        token = await host_token_for(runtime)  # the run's own user
        return sessions.for_token(token).call_tool  # cache per user

    provider = ArcadeCloudProvider(caller_factory=caller_for)

Verified against `hub.arcade.dev/mcp` on 2026-09-14, `tools/list` returns five:
`Arcade_Apps`, `Arcade_Project`, `Arcade_RetrieveResult`, `Arcade_SelectTools`
and `Arcade_UseTool`. **There is no keyword-search tool**, so `search()` raises
`DiscoveryNotSupportedError` here — a permanent property of the deployment, not
an outage. Use `select()`, which is semantic and is what the hub is built
around.

It deliberately does **not** open the MCP connection itself. Session lifecycle,
reconnection, and the OAuth handshake are solved in `deepagents-code`
(`MCPSessionManager`, `mcp_auth`, `mcp_providers/`); duplicating them here would
be a second implementation to keep correct. Instead `ArcadeCloudProvider` takes a
`ToolCaller` — anything that can invoke a named MCP tool and hand back the
decoded result — so the host supplies whichever client it already runs.

    from langchain_arcade import ArcadeMiddleware, ArcadeCloudProvider

    provider = ArcadeCloudProvider(caller=my_session.call_tool)
    ArcadeMiddleware(provider=provider)

Because the hub speaks the envelope model, `execute` sends `query_id` — which
promotion keeps out of the model's hands but the client still carries, so
Tool Recommendation's selection logs correlate discovery with execution.
"""

from __future__ import annotations

import asyncio
import inspect
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from langchain_arcade._schema import SelectedTool, parse_tools
from langchain_arcade.profile import TOOL_ROLES, ToolRole
from langchain_arcade.provider import (
    DEFAULT_SEARCH_LIMIT,
    DEFAULT_SELECT_LIMIT,
    MIN_SELECT_TOP_K,
    DiscoveryNotSupportedError,
    DiscoveryUnavailableError,
    ToolExecution,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from langchain_arcade._schema import SelectedTool

_AUTH_URL_KEYS = ("authorization_url", "auth_url")
"""Top-level keys that hold a sign-in URL when an explicit marker is set.

Deliberately not `url`. A tool result is free to carry a `url`, and reading one
as a sign-in link turned ordinary results into sign-in prompts.
"""

_AUTH_MARKERS = ("authorization_required", "auth_required", "requires_authorization")

NEEDS_AUTH_STATUS = "needs_auth"
"""`status` the hub sets when a call is waiting on the user's sign-in.

The link is at `pause.authorization_url`. This is the shape the hub documents
to MCP clients: a sign-in request, not a result.
"""

ASYNC_CALLER_ERROR = (
    "This ArcadeCloudProvider has an async caller, so it can only run on the "
    "async path. Run the agent with `ainvoke` / `astream`, or pass a synchronous "
    "caller."
)
"""Raised when a sync method meets an async caller.

The old behaviour was to hand the unawaited coroutine on as the tool's result,
which reached the model as `<coroutine object ...>`. Failing loudly is the fix:
this is a host setup error, not something the model can act on.
"""

UNBOUND_FACTORY_ERROR = (
    "This ArcadeCloudProvider was built with `caller_factory`, so it needs a run "
    "to know whose session to use. Call `bind(runtime)` or `await "
    "abind(runtime)` first. ArcadeMiddleware does this for every tool call."
)


@runtime_checkable
class ToolCaller(Protocol):
    """Invokes a named MCP tool and returns its decoded result."""

    def __call__(self, name: str, arguments: dict[str, Any]) -> Any:
        """Call `name` with `arguments`.

        Args:
            name: MCP tool name as advertised by the server.
            arguments: JSON-serializable arguments.

        Returns:
            The decoded tool result: a mapping, a list, or text.
        """
        ...


@runtime_checkable
class AsyncToolCaller(Protocol):
    """The async form of `ToolCaller`, for MCP clients that are async.

    Most are: the MCP Python SDK's `ClientSession.call_tool` is a coroutine.
    Use the provider's `aselect` / `aexecute` (the middleware's async path) with
    one of these; the sync methods refuse it rather than leak a coroutine.
    """

    async def __call__(self, name: str, arguments: dict[str, Any]) -> Any:
        """Call `name` with `arguments`.

        Args:
            name: MCP tool name as advertised by the server.
            arguments: JSON-serializable arguments.

        Returns:
            The decoded tool result: a mapping, a list, or text.
        """
        ...


class _HostSetupError(TypeError):
    """A host wiring mistake: async caller on the sync path, or an unbound factory.

    Raised rather than wrapped, because it is not an outage and not something
    the model can act on.
    """


@dataclass(frozen=True)
class ArcadeCloudToolNames:
    """The hub's meta-tool names.

    Separate from `DiscoveryProfile.tools` — those are what *this* agent
    advertises to its model; these are what the *hub* advertises to us. The two
    are independent and both renameable.
    """

    select: str = "Arcade_SelectTools"
    search: str = "Arcade_SearchTools"
    """Not exposed by Arcade Cloud.

    Verified 2026-09-14 against `hub.arcade.dev/mcp`, whose `tools/list` returns
    exactly `Arcade_Apps`, `Arcade_Project`, `Arcade_RetrieveResult`,
    `Arcade_SelectTools` and `Arcade_UseTool`. Calling this name raises
    `DiscoveryNotSupportedError`; use `select` instead, which is semantic rather
    than keyword-based and is what the hub is built around. The default stays
    here for a deployment that does expose it.
    """

    execute: str = "Arcade_UseTool"


class ArcadeCloudProvider:
    """Discovery and execution through Arcade Cloud's MCP meta-tools.

    For the hosted multi-tenant service. For a specific Engine — including one
    self-hosted in your own VPC — use `EngineProvider` instead; see this
    module's docstring for the full comparison.

    Example:
        ```python
        # `call_tool` is whatever your MCP client exposes.
        provider = ArcadeCloudProvider(caller=session.call_tool)
        tools = provider.select(["post a status update in #eng"])
        ```

        One session per user, for a server:

        ```python
        provider = ArcadeCloudProvider(caller_factory=caller_for_run)
        ```
    """

    def __init__(
        self,
        *,
        caller: ToolCaller | AsyncToolCaller | None = None,
        names: ArcadeCloudToolNames | None = None,
        user_id: str | None = None,
        caller_factory: Callable[[Any], Any] | None = None,
    ) -> None:
        """Initialize the provider.

        Args:
            caller: Invokes a hub MCP tool and returns the decoded result. Sync
                or async. One caller means one session for every run, which
                suits a CLI or a single-user script.
            names: Override the hub's meta-tool names if the server renames them.
            user_id: Ignored, and never sent. Kept so existing call sites still
                construct. The hub derives identity from the authenticated
                session, and forwarding a named id is how one caller could act
                as another.
            caller_factory: Returns the caller for one run, given its runtime.
                Sync or async, and it may return a sync or async caller. Use it
                instead of `caller` when one process serves many users. The
                middleware binds per tool call, so cache sessions per user
                inside the factory.

        Raises:
            ValueError: Neither or both of `caller` and `caller_factory` given.
        """
        if (caller is None) == (caller_factory is None):
            msg = "pass exactly one of caller= or caller_factory="
            raise ValueError(msg)
        self._call = caller
        self._factory = caller_factory
        self._names = names or ArcadeCloudToolNames()
        self._user_id = user_id

    @property
    def user_id(self) -> str | None:
        """Whatever `user_id` this provider was built with. It is never sent."""
        return self._user_id

    @property
    def requires_user_id(self) -> bool:
        """The hub derives identity from the authenticated MCP session."""
        return False

    @property
    def supported_roles(self) -> frozenset[ToolRole]:
        """Everything but `search`.

        `tools/list` on `hub.arcade.dev` returns no keyword-search tool, so
        `search()` raises `DiscoveryNotSupportedError` here. Omitting the role
        keeps that permanent property out of the model's tool list rather than
        charging for it on every call and letting the model find out by
        calling it.
        """
        return frozenset(TOOL_ROLES) - {"search"}

    def bind(self, runtime: Any) -> ArcadeCloudProvider:
        """Return the provider to use for one run.

        With a fixed `caller` there is nothing run-specific, so this is `self`.
        With a `caller_factory`, it returns a provider on that run's caller.

        Args:
            runtime: The run's `ToolRuntime`, or `None`.

        Returns:
            A provider for that run.

        Raises:
            TypeError: The factory is async; use `abind`.
        """
        if self._factory is None:
            return self
        caller = self._factory(runtime)
        if inspect.isawaitable(caller):
            _close(caller)
            raise _HostSetupError(ASYNC_CALLER_ERROR)
        return self._with_caller(caller)

    async def abind(self, runtime: Any) -> ArcadeCloudProvider:
        """Async form of `bind`. Awaits an async `caller_factory`.

        Args:
            runtime: The run's `ToolRuntime`, or `None`.

        Returns:
            A provider for that run.
        """
        if self._factory is None:
            return self
        caller = self._factory(runtime)
        if inspect.isawaitable(caller):
            caller = await caller
        return self._with_caller(caller)

    def _with_caller(self, caller: Any) -> ArcadeCloudProvider:
        """A provider with this one's settings, on `caller`."""
        return ArcadeCloudProvider(
            caller=caller, names=self._names, user_id=self._user_id
        )

    def _caller(self) -> Any:
        """The bound caller, or a setup error when only a factory exists."""
        if self._call is None:
            raise _HostSetupError(UNBOUND_FACTORY_ERROR)
        return self._call

    def _sync_call(self, name: str, arguments: dict[str, Any]) -> Any:
        """Call the hub from a sync method, refusing an async caller."""
        result = self._caller()(name, arguments)
        if inspect.isawaitable(result):
            _close(result)
            raise _HostSetupError(ASYNC_CALLER_ERROR)
        return result

    async def _async_call(self, name: str, arguments: dict[str, Any]) -> Any:
        """Call the hub from an async method.

        An async caller is awaited on the loop. A sync one runs in a worker
        thread, so a blocking client cannot stall the loop and serialize
        parallel tool calls.
        """
        caller = self._caller()
        if _is_async_callable(caller):
            return await caller(name, arguments)
        result = await asyncio.to_thread(caller, name, arguments)
        if inspect.isawaitable(result):
            result = await result
        return result

    @staticmethod
    def _select_arguments(task_list: list[str], limit: int) -> dict[str, Any]:
        # `top_k`, not `limit`: the hub reads top_k and ignores an unknown
        # `limit`, so the caller's cap was silently dropped. Verified against
        # production — limit=2 returned the same count as no argument at all.
        #
        # Over-fetch then trim, as EngineProvider does. top_k reaches the
        # Engine's ranking rather than acting as a pure cutoff, so a small
        # value returns a worse set and not merely a shorter one.
        #
        # No user_id, here or in any other hub call. See the module docstring.
        return {"tasks": task_list, "top_k": max(limit, MIN_SELECT_TOP_K)}

    @staticmethod
    def _execute_arguments(
        fqn: str, inputs: dict[str, Any], query_id: str
    ) -> dict[str, Any]:
        arguments: dict[str, Any] = {"tool_name": fqn, "inputs": inputs}
        if query_id:
            arguments["query_id"] = query_id
        return arguments

    def select(
        self,
        tasks: Sequence[str],
        limit: int = DEFAULT_SELECT_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Select tools for `tasks` via the hub's semantic selector.

        Args:
            tasks: Plain-English task descriptions.
            limit: Maximum tools per task.
            user_id: Ignored, and never sent. The hub scopes by the
                authenticated session.

        Returns:
            Selected tools in rank order. An empty list means the catalog held
            nothing for these tasks.

        Raises:
            DiscoveryUnavailableError: The hub call failed, or returned an empty
                result with no correlation id.
        """
        del user_id
        task_list = list(tasks)
        arguments = self._select_arguments(task_list, limit)
        payload = self._discovery_call(self._names.select, arguments)
        tools = self._tools_or_unavailable(payload, self._names.select)
        # The caller asked for `limit` per task, so the cap scales with tasks.
        return tools[: max(1, limit) * max(1, len(task_list))]

    def search(
        self,
        query: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Keyword-search the hub catalog.

        Args:
            query: Free-form query.
            limit: Maximum results.
            user_id: Ignored, and never sent, as with `select`.

        Returns:
            Matching tools in rank order.

        Raises:
            DiscoveryNotSupportedError: The deployment exposes no search tool,
                which is the case for Arcade Cloud. Never worth retrying.
            DiscoveryUnavailableError: The call failed, or returned an empty
                result with no correlation id.
        """
        del user_id
        arguments: dict[str, Any] = {"query": query, "top_k": limit}
        payload = self._discovery_call(self._names.search, arguments)
        return self._tools_or_unavailable(payload, self._names.search)

    def execute(
        self,
        fqn: str,
        inputs: dict[str, Any],
        *,
        user_id: str | None = None,
        query_id: str = "",
    ) -> ToolExecution:
        """Execute a tool through the hub's envelope tool.

        Args:
            fqn: Fully-qualified Arcade tool name, version included.
            inputs: Tool inputs.
            user_id: Ignored, and never sent. The hub runs the call as the
                session's user.
            query_id: Selection correlation id, passed through when present.

        Returns:
            The execution outcome, including any authorization prompt.

        Raises:
            TypeError: The caller is async; use `aexecute`.
        """
        del user_id
        arguments = self._execute_arguments(fqn, inputs, query_id)
        try:
            payload = self._sync_call(self._names.execute, arguments)
        except _HostSetupError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface transport errors to the model
            return ToolExecution(success=False, error=f"{type(exc).__name__}: {exc}")
        return _to_execution(payload)

    async def aselect(
        self,
        tasks: Sequence[str],
        limit: int = DEFAULT_SELECT_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Async form of `select`. Awaits an async caller.

        Args:
            tasks: Plain-English task descriptions.
            limit: Maximum tools per task.
            user_id: Ignored, and never sent.

        Returns:
            Selected tools in rank order.
        """
        del user_id
        task_list = list(tasks)
        arguments = self._select_arguments(task_list, limit)
        payload = await self._adiscovery_call(self._names.select, arguments)
        tools = self._tools_or_unavailable(payload, self._names.select)
        return tools[: max(1, limit) * max(1, len(task_list))]

    async def asearch(
        self,
        query: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Async form of `search`.

        Args:
            query: Free-form query.
            limit: Maximum results.
            user_id: Ignored, and never sent.

        Returns:
            Matching tools in rank order.
        """
        del user_id
        arguments: dict[str, Any] = {"query": query, "top_k": limit}
        payload = await self._adiscovery_call(self._names.search, arguments)
        return self._tools_or_unavailable(payload, self._names.search)

    async def aexecute(
        self,
        fqn: str,
        inputs: dict[str, Any],
        *,
        user_id: str | None = None,
        query_id: str = "",
    ) -> ToolExecution:
        """Async form of `execute`. Awaits an async caller.

        Args:
            fqn: Fully-qualified Arcade tool name, version included.
            inputs: Tool inputs.
            user_id: Ignored, and never sent.
            query_id: Selection correlation id, passed through when present.

        Returns:
            The execution outcome, including any authorization prompt.
        """
        del user_id
        arguments = self._execute_arguments(fqn, inputs, query_id)
        try:
            payload = await self._async_call(self._names.execute, arguments)
        except _HostSetupError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface transport errors to the model
            return ToolExecution(success=False, error=f"{type(exc).__name__}: {exc}")
        return _to_execution(payload)

    def _discovery_call(self, name: str, arguments: dict[str, Any]) -> Any:
        """Call a discovery tool, raising `DiscoveryUnavailableError` on failure.

        This previously returned `None` on any exception, on the reasoning that
        a failed discovery call should degrade to "found nothing" because a
        model can act on that. That reasoning was wrong, and in the same way the
        Engine's own MCP path is wrong: a model acts on "found nothing" by
        telling the user the capability does not exist. An outage becomes a
        confident false statement instead of a retryable error.

        Decoding happens here so both discovery paths hand `parse_tools` plain
        data rather than an MCP content block or a JSON string.

        Raises:
            DiscoveryUnavailableError: The hub call failed.
        """
        try:
            return _decode(self._sync_call(name, arguments))
        except _HostSetupError:
            # A setup error, not an outage. Reporting it as one would tell the
            # model to wait for a service that is fine.
            raise
        except Exception as exc:
            raise _discovery_error(name, exc) from exc

    async def _adiscovery_call(self, name: str, arguments: dict[str, Any]) -> Any:
        """Async form of `_discovery_call`.

        Raises:
            DiscoveryUnavailableError: The hub call failed.
        """
        try:
            return _decode(await self._async_call(name, arguments))
        except _HostSetupError:
            raise
        except Exception as exc:
            raise _discovery_error(name, exc) from exc

    @staticmethod
    def _tools_or_unavailable(payload: Any, name: str) -> list[SelectedTool]:
        """Parse a hub discovery payload, distinguishing failure from zero-match.

        The hub proxies the Engine's selection response, which sets `query_id`
        only from a task that reached Tool Recommendation. An empty result with no
        correlation id therefore means the call did not run, which is what a
        health-gated Engine returns on this path.

        Raises:
            DiscoveryUnavailableError: Empty result with no correlation id.
        """
        tools, query_id = parse_tools(payload)
        if not tools and not query_id:
            msg = f"{name} returned no results and no query_id"
            raise DiscoveryUnavailableError(msg)
        return tools


def _discovery_error(name: str, exc: Exception) -> DiscoveryUnavailableError:
    """Classify a failed discovery call as an outage or a missing capability."""
    # Don't re-prefix a message that already names the tool — MCP servers
    # usually do, and doubling it reads as a bug to whoever sees the traceback.
    detail = str(exc)
    msg = detail if name in detail else f"{name}: {detail}"
    # A deployment that does not expose the tool is a permanent condition, not
    # an outage, and the two deserve opposite advice: never retry, versus retry
    # later. Arcade Cloud has no keyword search tool, so this is the live case
    # rather than a hypothetical.
    if "not found" in detail.lower():
        return DiscoveryNotSupportedError(msg)
    return DiscoveryUnavailableError(msg)


def _is_async_callable(caller: Any) -> bool:
    """Whether calling `caller` returns a coroutine, judged without calling it."""
    if inspect.iscoroutinefunction(caller):
        return True
    return inspect.iscoroutinefunction(getattr(caller, "__call__", None))  # noqa: B004


def _close(awaitable: Any) -> None:
    """Close an awaitable we will not await, so it warns of nothing later."""
    close = getattr(awaitable, "close", None)
    if callable(close):
        close()


def _texts_from_blocks(blocks: list[Any]) -> str:
    """Join the text of any MCP content blocks in `blocks`."""
    return "\n".join(
        block["text"]
        for block in blocks
        if isinstance(block, dict)
        and isinstance(block.get("text"), str)
        and block["text"]
    )


def _decode(payload: Any) -> Any:
    """Unwrap the MCP content shapes into plain data.

    Servers return a mapping, a list of content blocks, a bare string of JSON,
    or `{"content": [{"type": "text", "text": "<json>"}]}`. All of them have to
    reach `parse_tools` as the same thing.
    """
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except (TypeError, ValueError):
            return payload
    if isinstance(payload, dict):
        content = payload.get("content")
        joined = _texts_from_blocks(content) if isinstance(content, list) else ""
        return _decode(joined) if joined else payload
    if isinstance(payload, list):
        joined = _texts_from_blocks(payload)
        return _decode(joined) if joined else payload
    return payload


def _auth_url_in(data: dict[str, Any], keys: tuple[str, ...] = _AUTH_URL_KEYS) -> str:
    """Return a sign-in URL held directly under one of `keys`, if any."""
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return value
    return ""


def _needs_auth(data: Any) -> bool:
    """Whether a decoded payload is the hub asking for the user's sign-in.

    Only the shapes the hub uses count. Anything else is a result, however
    many URLs it carries or however often it says "author".
    """
    if not isinstance(data, dict):
        return False
    status = data.get("status")
    if isinstance(status, str) and status.lower() == NEEDS_AUTH_STATUS:
        return True
    if any(data.get(marker) for marker in _AUTH_MARKERS):
        return True
    if isinstance(status, str) and status.lower() in {"pending", "requires_auth"}:
        # Older builds: a pending status counts only with an `authorization`
        # block beside it. A tool's own "pending" (a ticket, a job) does not.
        return isinstance(data.get("authorization"), dict)
    return False


def _auth_url_for(data: Any) -> str:
    """Return the sign-in URL when the payload is a sign-in request.

    The hub's shape is `{"status": "needs_auth", "pause": {"authorization_url":
    ...}}`. Two older shapes also count: an explicit boolean marker with a
    top-level URL, and a pending status with an `authorization` block.

    This used to search the whole payload for any `url`, and fall back to "a
    URL plus any mention of authorization". A tool result that was a link to a
    document by its author read as a sign-in request, so the user was asked to
    sign in instead of getting their result.
    """
    if not _needs_auth(data):
        return ""
    for holder in (data.get("pause"), data.get("authorization")):
        # Inside a block that exists only to describe the sign-in, a bare
        # `url` is the sign-in link. Anywhere else it is just a URL.
        if isinstance(holder, dict):
            url = _auth_url_in(holder, (*_AUTH_URL_KEYS, "url"))
            if url:
                return url
    return _auth_url_in(data)


def _sign_in(data: Any) -> ToolExecution:
    """The outcome for a payload `_needs_auth` accepted."""
    auth_url = _auth_url_for(data)
    if auth_url:
        return ToolExecution(
            success=False,
            auth_required=True,
            auth_url=auth_url,
            error="Authorization required.",
        )
    # Asked for a sign-in but gave no link to follow. Not a result, and not
    # something the user can act on, so it reads as an error.
    return ToolExecution(
        success=False,
        error="Authorization required, but the hub sent no sign-in link.",
    )


def _to_execution(payload: Any) -> ToolExecution:
    """Normalize a hub `UseTool` result into a `ToolExecution`."""
    data = _decode(payload)

    if _needs_auth(data):
        return _sign_in(data)

    if isinstance(data, dict):
        if data.get("isError") or data.get("is_error"):
            return ToolExecution(success=False, error=_error_text(data))
        error = data.get("error")
        if error:
            return ToolExecution(success=False, error=_error_text(data))
        for key in ("value", "result", "output"):
            if key in data:
                inner = data[key]
                if isinstance(inner, dict) and "value" in inner:
                    return ToolExecution(success=True, value=inner["value"])
                return ToolExecution(success=True, value=inner)
    return ToolExecution(success=True, value=data)


def _error_text(data: dict[str, Any]) -> str:
    """Extract a readable error message from a hub error payload."""
    error = data.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message:
            return message
    if isinstance(error, str) and error:
        return error
    content = data.get("content")
    if isinstance(content, str) and content:
        return content
    return "Tool execution failed."


__all__ = [
    "ArcadeCloudProvider",
    "ArcadeCloudToolNames",
    "AsyncToolCaller",
    "ToolCaller",
]
