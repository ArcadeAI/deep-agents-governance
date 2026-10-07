"""Transport layer: how tool schemas and executions reach Arcade.

`ArcadeProvider` is the seam the middleware talks to. Two implementations ship
here:

* `EngineProvider` — talks to an Arcade Engine (cloud or self-hosted). Semantic
  selection goes to `POST /v1/tools/select`, which is Condex-backed and is the
  same path the `Arcade.SelectTools` builtin uses.
* `StaticProvider` — an in-memory catalog with keyword scoring. Runs the whole
  discovery loop with no network, which is what the tests and the offline
  example use.

A hub-backed provider (`hub.arcade.dev/mcp` over MCP, reusing the OAuth and
session machinery in `deepagents-code`) is the natural third implementation and
slots in behind the same protocol.
"""

from __future__ import annotations

import copy
import os
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from arcadepy import Arcade

from langchain_arcade._schema import SelectedTool, parse_tools
from langchain_arcade.identity import NO_IDENTITY_ERROR, NO_TRUSTED_IDENTITY_ERROR
from langchain_arcade.profile import TOOL_ROLES, ToolRole

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

_AUTH_REQUIRED_MARKERS = ("tool_authorization_required",)
"""Substrings that mean "this user has not granted this toolkit yet".

The Engine signals this as a bare `403 tool_authorization_required` carrying no
sign-in URL, so recognizing it is only half the job — see `_authorize`.

Only the Engine's own error name counts. Any `PermissionDeniedError` and any
mention of "authorization required" used to count too, which made every 403 a
sign-in request. A 403 is also how a refusal arrives: a contextual-access
`/pre` hook that denies a call, for one. Reading that as "please sign in" hands
the user a link that cannot help, and hides the refusal from the model.
"""


class DiscoveryUnavailableError(RuntimeError):
    """Discovery could not run, as distinct from running and matching nothing.

    The protocol's `select`/`search` return `list[SelectedTool]`, so an empty
    list is the only thing a provider can say — and it has to mean both "the
    catalog holds nothing for this" and "the call never happened". Those need
    opposite responses from a model: reword the task, versus stop and report an
    outage. Conflating them is how a transient Condex failure becomes an agent
    telling a user that Slack integration does not exist.

    Providers raise this for the second case. `ArcadeMiddleware` catches it and
    renders `discovery_unavailable` rather than `no_match`.
    """


class DiscoveryNotSupportedError(DiscoveryUnavailableError):
    """The deployment does not expose this capability at all.

    Distinct from `DiscoveryUnavailableError` in duration, which is what a
    caller needs to know: an outage is worth retrying later, a missing
    capability never is. Arcade Cloud is the live example — it advertises five
    meta-tools (`Arcade_Apps`, `Arcade_Project`, `Arcade_RetrieveResult`,
    `Arcade_SelectTools`, `Arcade_UseTool`) and no keyword-search tool, so
    `ArcadeCloudProvider.search` cannot work there however healthy the service is.

    Subclasses `DiscoveryUnavailableError` so existing handling still catches
    it; catch this first when the two need different wording.
    """


MIN_SELECT_TOP_K = 10
"""Floor for the `top_k` sent to the Engine, regardless of how many we return.

`top_k` is not a cutoff — it changes the ranking. Measured against a live
staging Engine, "search the web for house cleaning services in San Francisco"
puts `GoogleSearch_Search` at rank 1 with `top_k=10` and omits it entirely with
`top_k=4`, returning CRM search tools instead. The same holds for unrelated
tasks: at `top_k=3` a Slack request returns `SlackApi_SendSlackMessage` where
`top_k=10` correctly prefers `Slack_SendMessage`.

So a caller asking for few tools must not ask the Engine for few candidates.
Over-fetch to this floor and trim locally: the model still sees a small set, but
it is the top of a well-ranked list rather than the whole of a badly ranked one.
"""

DISCOVERY_MAX_RETRIES = 1
"""Retries the Engine client makes before giving up. See the client construction."""

DISCOVERY_TIMEOUT_SECONDS = 15.0
"""Per-attempt deadline for an Engine discovery call.

The binding constraint on how long a failing call can block an agent turn is
this, not the retry count: total wall clock is roughly
`(DISCOVERY_MAX_RETRIES + 1) x DISCOVERY_TIMEOUT_SECONDS`.

`arcadepy` defaults to a 60s read timeout, so the default pairing costs 120s
before the caller learns anything. Measured on a healthy production Engine, a
select or search returns in 1.0-2.0s, so 15s is roughly ten times the observed
latency and still fails fast enough that a model gets an error rather than a
hang. Raise it for a cold self-hosted Engine; do not raise it to 60."""

DEFAULT_SELECT_LIMIT = 5
DEFAULT_SEARCH_LIMIT = 10


@dataclass(frozen=True)
class ToolExecution:
    """Outcome of executing one Arcade tool.

    Attributes:
        success: Whether the tool ran and returned a value.
        value: The tool's output when `success` is `True`.
        error: Error text when `success` is `False`.
        auth_required: `True` when the call needs user authorization first.
        auth_url: Sign-in URL to visit when `auth_required` is `True`.
    """

    success: bool
    value: Any = None
    error: str = ""
    auth_required: bool = False
    auth_url: str = ""


@runtime_checkable
class ArcadeProvider(Protocol):
    """Transport for Arcade tool discovery and execution."""

    @property
    def requires_user_id(self) -> bool:
        """Whether execution needs an Arcade user identity.

        `True` for the Engine, which authorizes per user and rejects a call with
        no `user_id`. `False` for a session-scoped transport like the hub, and
        for in-memory test doubles. The middleware refuses to execute without an
        identity only when this is `True` — it cannot infer the answer.
        """
        ...

    @property
    def supported_roles(self) -> frozenset[ToolRole]:
        """Meta-tool roles this transport can actually serve.

        Advertising a role the transport cannot serve costs tokens on every
        call and hands the model a capability that fails when used — which it
        can only find out by trying. Arcade Cloud exposes no keyword search,
        so `ArcadeCloudProvider` omits `search` here and the middleware never
        puts it in front of the model.

        A provider written before this property existed reads as supporting
        every role, which is the previous behaviour.
        """
        ...

    def select(
        self,
        tasks: Sequence[str],
        limit: int = DEFAULT_SELECT_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Select tools semantically for one or more plain-English tasks.

        Args:
            tasks: Plain-English task descriptions, one per workflow.
            limit: Maximum tools to return per task.
            user_id: Identity to scope the catalog to. Arcade filters discovery
                per user, so a multi-user host varies this per request.

        Returns:
            Selected tools in rank order, each carrying a full input schema. An
            empty list means the catalog held nothing for these tasks.

        Raises:
            DiscoveryUnavailableError: Discovery could not run. Distinct from an
                empty result, which means it ran and matched nothing.
        """
        ...

    def search(
        self,
        query: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Keyword-search the catalog for browsing a domain.

        Args:
            query: Free-form query.
            limit: Maximum tools to return.
            user_id: Identity to scope the catalog to.

        Returns:
            Matching tools in rank order.
        """
        ...

    def execute(
        self,
        fqn: str,
        inputs: dict[str, Any],
        *,
        user_id: str | None = None,
        query_id: str = "",
    ) -> ToolExecution:
        """Execute a tool by fully-qualified name.

        Args:
            fqn: Fully-qualified Arcade tool name, version included.
            inputs: Tool inputs matching the tool's input schema.
            user_id: Arcade user identity to execute as.
            query_id: Selection that surfaced this tool. Promotion keeps this
                out of the model's hands, but passing it through preserves the
                discovery-to-execution correlation Condex logs.

        Returns:
            The execution outcome, including any authorization prompt.
        """
        ...


class EngineProvider:
    """Provider backed by an Arcade Engine over REST.

    Selection uses `POST /v1/tools/select`, which `arcadepy` does not expose as
    a typed method, so it goes out through the client's raw `post`. Execution
    and authorization use the typed `tools.execute` / `tools.authorize`
    resources.

    Example:
        ```python
        provider = EngineProvider()  # reads ARCADE_API_KEY / ARCADE_BASE_URL
        tools = provider.select(["post a status update in the #eng channel"])
        ```
    """

    def __init__(  # noqa: PLR0913  # keyword-only configuration surface
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        user_id: str | None = None,
        gateway_id: str | None = None,
        timeout: float | None = None,
        client: Any = None,
        user_id_resolver: Callable[[Any], str | None] | None = None,
    ) -> None:
        """Initialize the provider.

        Args:
            api_key: Arcade API key. Defaults to `$ARCADE_API_KEY`.
            base_url: Engine base URL. Defaults to `$ARCADE_BASE_URL`, then to
                the `arcadepy` default (`https://api.arcade.dev`).
            user_id: Default Arcade user identity for execution. Defaults to
                `$ARCADE_USER_ID`.
            gateway_id: Restrict selection to one gateway's tool set. Defaults
                to `$ARCADE_GATEWAY_ID`.
            timeout: Per-attempt deadline in seconds. Defaults to
                `DISCOVERY_TIMEOUT_SECONDS`; raise it for a cold self-hosted
                Engine, at the cost of how long a failure blocks a turn.
            client: Pre-built `arcadepy.Arcade` client. Supplying this ignores
                `api_key` and `base_url` and is the injection point for tests.
            user_id_resolver: A *trusted* source of identity, supplied by the
                host. Takes the run's runtime (or `None` outside a run) and
                returns the Arcade user id, or `None`. When set, it is the only
                source: the per-call `user_id` (which the middleware reads
                from run context and config, both caller-controlled) is
                ignored, and so are `user_id` and `$ARCADE_USER_ID`. A `None`
                answer refuses execution rather than falling back. Use it for a
                deployment-baked seat (`lambda _: "dana-001"`) or a principal
                the platform authenticated, such as Managed Deep Agents'
                `runtime.server_info.principal.id`. Unset, behaviour is
                unchanged.

        """
        if client is None:
            kwargs: dict[str, Any] = {}
            resolved_key = api_key or os.environ.get("ARCADE_API_KEY")
            if resolved_key:
                kwargs["api_key"] = resolved_key
            resolved_url = base_url or os.environ.get("ARCADE_BASE_URL")
            if resolved_url:
                kwargs["base_url"] = resolved_url
            # Bound how long a failing discovery call can block a turn. The
            # Engine's 503 for an unavailable selector carries no `Retry-After`,
            # and `arcadepy` pairs a 60s read timeout with 2 retries, so a
            # refusal returned in 0.19s costs the caller three minutes. Measured
            # during a 2026-09-14 incident: this package's six integration tests
            # took 554s against a normal 6s. Of the two knobs the timeout is the
            # binding one — see DISCOVERY_TIMEOUT_SECONDS.
            kwargs.setdefault("max_retries", DISCOVERY_MAX_RETRIES)
            kwargs.setdefault("timeout", timeout or DISCOVERY_TIMEOUT_SECONDS)
            client = Arcade(**kwargs)
        self._client = client
        self._user_id = user_id or os.environ.get("ARCADE_USER_ID") or None
        self._gateway_id = gateway_id or os.environ.get("ARCADE_GATEWAY_ID") or None
        self._resolver = user_id_resolver
        self._trusted_user_id: str | None = None
        self._bound = False

    @property
    def user_id(self) -> str | None:
        """Identity this provider acts as by default.

        With a `user_id_resolver`, this is what the resolver returned for the
        bound run, and nothing else. Without one, it is the constructor value
        or `$ARCADE_USER_ID`.
        """
        if self._resolver is not None:
            return self._trusted()
        return self._user_id

    @property
    def requires_user_id(self) -> bool:
        """The Engine authorizes per user, so execution always needs one."""
        return True

    @property
    def identity_is_trusted(self) -> bool:
        """Whether identity comes only from a host-supplied resolver.

        `ArcadeMiddleware` reads this to stop offering run context and config
        as identity sources, since the provider will ignore them anyway.
        """
        return self._resolver is not None

    def bind(self, runtime: Any) -> EngineProvider:
        """Return this provider as it should act for one run.

        `ArcadeMiddleware` calls this per tool call with that call's runtime.
        Without a `user_id_resolver` there is nothing run-specific, so this is
        `self`. With one, it returns a copy whose identity is the resolver's
        answer for `runtime`. The copy shares the HTTP client.

        Args:
            runtime: The run's `ToolRuntime`, or `None`.

        Returns:
            A provider for that run.
        """
        if self._resolver is None:
            return self
        bound = copy.copy(self)
        bound._trusted_user_id = _clean_id(self._resolver(runtime))  # noqa: SLF001
        bound._bound = True  # noqa: SLF001
        return bound

    async def abind(self, runtime: Any) -> EngineProvider:
        """Async form of `bind`. The resolver is synchronous, so this is too.

        Args:
            runtime: The run's `ToolRuntime`, or `None`.

        Returns:
            A provider for that run.
        """
        return self.bind(runtime)

    def _trusted(self) -> str | None:
        """The resolver's identity: for the bound run, or with no run."""
        if self._bound:
            return self._trusted_user_id
        resolver = self._resolver
        return _clean_id(resolver(None)) if resolver is not None else None

    def _effective_user(self, user_id: str | None) -> str | None:
        """Pick the identity for one call.

        A resolver, when set, is the only source. Otherwise the per-call value
        wins over the default, which is the behaviour this provider always had.
        """
        if self._resolver is not None:
            return self._trusted()
        return user_id or self._user_id

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        """POST to the Engine, converting transport failures into a typed one.

        Anything that is not a well-formed response means discovery did not run.
        Raising `DiscoveryUnavailableError` keeps that distinguishable from an empty
        result all the way up to the model.

        Raises:
            DiscoveryUnavailableError: The Engine could not be reached or refused.
        """
        try:
            return self._client.post(path, body=body, cast_to=object)
        except Exception as exc:
            msg = f"{path}: {exc}"
            raise DiscoveryUnavailableError(msg) from exc

    @staticmethod
    def _tools_or_unavailable(payload: Any, path: str) -> list[SelectedTool]:
        """Parse a discovery payload, distinguishing failure from zero-match.

        The Engine sets `query_id` only from a task that actually reached
        Condex, and the field is `omitempty`. So an empty result carrying a
        `query_id` means Condex ran and matched nothing, while an empty result
        with no `query_id` means the call failed — the response shape a
        health-gated Engine returns on the MCP path, and the one that otherwise
        reaches the model as "no tools matched".

        Raises:
            DiscoveryUnavailableError: Empty result with no correlation id.
        """
        tools, query_id = parse_tools(payload)
        if not tools and not query_id:
            msg = f"{path} returned no results and no query_id"
            raise DiscoveryUnavailableError(msg)
        return tools

    @property
    def supported_roles(self) -> frozenset[ToolRole]:
        """Every role: this transport serves all four."""
        return frozenset(TOOL_ROLES)

    def select(
        self,
        tasks: Sequence[str],
        limit: int = DEFAULT_SELECT_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Select tools for `tasks` via the Engine's Condex-backed selector.

        Args:
            tasks: Plain-English task descriptions.
            limit: Maximum tools per task (`top_k`).
            user_id: Override the provider's default identity for this call.

        Returns:
            Selected tools in rank order.
        """
        task_list = list(tasks)
        # Ask for at least MIN_SELECT_TOP_K, then trim. See that constant: a
        # small top_k degrades the ranking rather than merely shortening it.
        body: dict[str, Any] = {
            "tasks": task_list,
            "top_k": max(limit, MIN_SELECT_TOP_K),
        }
        effective_user = self._effective_user(user_id)
        if effective_user:
            body["user_id"] = effective_user
        if self._gateway_id:
            body["gateway_id"] = self._gateway_id
        tools = self._tools_or_unavailable(
            self._post("/v1/tools/select", body), "/v1/tools/select"
        )
        # The caller asked for `limit` per task, so the cap scales with tasks.
        return tools[: max(1, limit) * max(1, len(task_list))]

    def search(
        self,
        query: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Keyword-search the Engine catalog.

        Args:
            query: Free-form query.
            limit: Maximum tools to return (`top_k`).
            user_id: Override the provider's default identity for this call.

        Returns:
            Matching tools in rank order.
        """
        body: dict[str, Any] = {"query": query, "top_k": limit}
        effective_user = self._effective_user(user_id)
        if effective_user:
            body["user_id"] = effective_user
        if self._gateway_id:
            body["gateway_id"] = self._gateway_id
        return self._tools_or_unavailable(
            self._post("/v1/tools/search", body), "/v1/tools/search"
        )

    def execute(
        self,
        fqn: str,
        inputs: dict[str, Any],
        *,
        user_id: str | None = None,
        query_id: str = "",
    ) -> ToolExecution:
        """Execute a tool, surfacing an authorization prompt when required.

        Args:
            fqn: Fully-qualified tool name, version included.
            inputs: Tool inputs.
            user_id: Override the provider's default user identity. Ignored
                when the provider has a `user_id_resolver`.
            query_id: Ignored — `tools.execute` has no correlation field. The
                Engine correlates by tool name and user instead.

        Returns:
            The execution outcome.
        """
        del query_id
        effective_user = self._effective_user(user_id)
        if not effective_user:
            # Arcade tools are authorized per user, so execute without an
            # identity always fails with `user_required`. Saying so beats
            # sending a doomed request and handing the model a raw 400 — it
            # will otherwise start guessing at calendar ids and re-selecting.
            error = (
                NO_TRUSTED_IDENTITY_ERROR
                if self._resolver is not None
                else NO_IDENTITY_ERROR
            )
            return ToolExecution(success=False, error=error)
        kwargs: dict[str, Any] = {"tool_name": fqn, "input": inputs}
        kwargs["user_id"] = effective_user
        try:
            response = self._client.tools.execute(**kwargs)
        except Exception as exc:  # noqa: BLE001 - surface transport errors to the model
            detail = f"{type(exc).__name__}: {exc}"
            auth_url = _auth_url_from_exception(exc) or (
                self._authorize(fqn, effective_user) if _needs_auth(detail) else ""
            )
            if auth_url:
                return ToolExecution(
                    success=False,
                    auth_required=True,
                    auth_url=auth_url,
                    error="Authorization required.",
                )
            return ToolExecution(success=False, error=_explain(detail))

        outcome = _execution_from_response(response)
        # The response shape can also report the need for a grant without a URL.
        if not outcome.success and not outcome.auth_url and _needs_auth(outcome.error):
            url = self._authorize(fqn, effective_user)
            if url:
                return ToolExecution(
                    success=False,
                    auth_required=True,
                    auth_url=url,
                    error="Authorization required.",
                )
        return outcome

    def _authorize(self, fqn: str, user_id: str) -> str:
        """Ask the Engine for a sign-in URL for `fqn`.

        `execute` reports a missing grant as a bare `403
        tool_authorization_required` with no URL attached, which leaves a model
        with nothing actionable to hand the user. `tools.authorize` is the call
        that produces the URL, so it runs here rather than being left to the
        caller.

        Args:
            fqn: Fully-qualified tool name.
            user_id: Identity the grant belongs to.

        Returns:
            The sign-in URL, or `""` when the Engine offers none.
        """
        try:
            response = self._client.tools.authorize(tool_name=fqn, user_id=user_id)
        except Exception:  # noqa: BLE001 - fall back to the plain error
            return ""
        status = _get(response, "status")
        if status == "completed":
            return ""
        url = _get(response, "url") or _get(response, "authorization_url")
        return url if isinstance(url, str) else ""


def _clean_id(value: Any) -> str | None:
    """Accept a non-empty string identity; anything else is no identity."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _needs_auth(message: str) -> bool:
    """Detect an Engine error that means the user has not granted the toolkit."""
    lowered = message.lower()
    return any(marker in lowered for marker in _AUTH_REQUIRED_MARKERS)


def _explain(message: str) -> str:
    """Replace an opaque Engine error with actionable guidance where we can.

    `user_required` is the one worth intercepting: it reads like something the
    user could answer, so a model will try to answer it.
    """
    if "user_required" in message or "a user ID must be provided" in message:
        return NO_IDENTITY_ERROR
    return message


def _get(source: Any, key: str) -> Any:
    """Read `key` from a mapping or an attribute-style response object."""
    if isinstance(source, dict):
        return source.get(key)
    return getattr(source, key, None)


def _auth_url_from_exception(exc: Exception) -> str:
    """Extract an authorization URL from an SDK exception, if it carries one."""
    body = getattr(exc, "body", None)
    if body is None:
        return ""
    url = _get(body, "authorization_url") or _get(body, "auth_url")
    return url if isinstance(url, str) else ""


def _execution_from_response(response: Any) -> ToolExecution:
    """Normalize an `ExecuteToolResponse` into a `ToolExecution`."""
    output = _get(response, "output")
    error = _get(output, "error") if output is not None else None
    authorization = _get(response, "authorization")

    if authorization is not None:
        status = _get(authorization, "status")
        url = _get(authorization, "url") or _get(authorization, "authorization_url")
        # `completed` means the user already authorized; anything else is a
        # prompt the model has to surface before the call can succeed.
        if status != "completed" and isinstance(url, str) and url:
            return ToolExecution(
                success=False,
                auth_required=True,
                auth_url=url,
                error="Authorization required.",
            )

    if error is not None:
        message = _get(error, "message") or str(error)
        return ToolExecution(success=False, error=_explain(str(message)))

    if _get(response, "success") is False:
        return ToolExecution(success=False, error="Tool execution failed.")

    value = _get(output, "value") if output is not None else None
    return ToolExecution(success=True, value=value)


class StaticProvider:
    """Provider over an in-memory catalog, with keyword scoring for selection.

    Runs the full discovery → promotion → execution loop with no network. Used
    by the unit tests and by the offline example.

    Example:
        ```python
        provider = StaticProvider(
            tools=[
                SelectedTool(
                    fqn="Slack.SendMessage@2.3.0",
                    name="Slack_SendMessage",
                    description="Post a message to a Slack channel.",
                    input_schema={
                        "type": "object",
                        "properties": {"channel": {"type": "string"}},
                        "required": ["channel"],
                    },
                    toolkit="Slack",
                )
            ],
            handlers={"Slack.SendMessage@2.3.0": lambda inputs: {"ok": True}},
        )
        ```
    """

    def __init__(
        self,
        tools: Sequence[SelectedTool],
        handlers: dict[str, Any] | None = None,
        *,
        query_id: str = "static-query",
    ) -> None:
        """Initialize the provider.

        Args:
            tools: The catalog to select and search over.
            handlers: Maps FQN to a callable taking the input dict and
                returning the tool's output. Unmapped tools return an error.
            query_id: Query id stamped onto every selected tool.
        """
        self._tools = [replace(tool, query_id=query_id) for tool in tools]
        self._handlers = handlers or {}

    @property
    def user_id(self) -> str | None:
        """No identity; handlers are local."""
        return None

    @property
    def requires_user_id(self) -> bool:
        """In-memory handlers have no notion of a user."""
        return False

    def _rank(self, text: str, limit: int) -> list[SelectedTool]:
        """Score the catalog against whitespace-split terms in `text`."""
        terms = [t for t in text.lower().split() if len(t) > 2]  # noqa: PLR2004
        scored: list[tuple[int, int, SelectedTool]] = []
        for index, tool in enumerate(self._tools):
            haystack = f"{tool.name} {tool.toolkit} {tool.description}".lower()
            score = sum(1 for term in terms if term in haystack)
            if score:
                # Index breaks ties so ordering stays deterministic.
                scored.append((-score, index, tool))
        scored.sort()
        return [tool for _, _, tool in scored[:limit]]

    @property
    def supported_roles(self) -> frozenset[ToolRole]:
        """Every role: this transport serves all four."""
        return frozenset(TOOL_ROLES)

    def select(
        self,
        tasks: Sequence[str],
        limit: int = DEFAULT_SELECT_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Select tools for `tasks` by keyword overlap.

        Args:
            tasks: Plain-English task descriptions.
            limit: Maximum tools per task.
            user_id: Ignored; present for protocol conformance.

        Returns:
            Selected tools, de-duplicated across tasks.
        """
        del user_id
        seen: dict[str, SelectedTool] = {}
        for task in tasks:
            for tool in self._rank(task, limit):
                seen.setdefault(tool.name, tool)
        return list(seen.values())

    def search(
        self,
        query: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        *,
        user_id: str | None = None,
    ) -> list[SelectedTool]:
        """Keyword-search the catalog.

        Args:
            query: Free-form query.
            limit: Maximum tools to return.
            user_id: Ignored; present for protocol conformance.

        Returns:
            Matching tools in rank order.
        """
        del user_id
        return self._rank(query, limit)

    def execute(
        self,
        fqn: str,
        inputs: dict[str, Any],
        *,
        user_id: str | None = None,
        query_id: str = "",
    ) -> ToolExecution:
        """Execute via the configured handler for `fqn`.

        Args:
            fqn: Fully-qualified tool name.
            inputs: Tool inputs.
            user_id: Ignored; present for protocol conformance.
            query_id: Ignored; present for protocol conformance.

        Returns:
            The handler's result, or an error when no handler is registered.
        """
        del user_id, query_id
        handler = self._handlers.get(fqn)
        if handler is None:
            return ToolExecution(
                success=False, error=f"No handler registered for {fqn!r}."
            )
        try:
            return ToolExecution(success=True, value=handler(inputs))
        except Exception as exc:  # noqa: BLE001 - mirror EngineProvider behavior
            return ToolExecution(success=False, error=f"{type(exc).__name__}: {exc}")


__all__ = [
    "ArcadeProvider",
    "EngineProvider",
    "StaticProvider",
    "ToolExecution",
]
