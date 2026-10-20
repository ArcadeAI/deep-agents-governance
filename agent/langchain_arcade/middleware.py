"""Arcade tool discovery middleware.

The model sees a small, fixed set of meta-tools instead of a large catalog. The
select tool maps a plain-English task onto real tools, and those tools then
appear as first-class tool definitions on the next model call — the *promotion*
step.

Promotion is the whole point. A discovery tool that returned a JSON schema in
its result would make the model read a schema out of prose. Instead the schema
is delivered through the tool-definition channel, where models are trained to
read schemas, and the model calls the tool directly. No execution envelope, no
query-id threading, no version-string handling in the model's head.

This module contains no model-facing text. Tool names, descriptions, argument
schemas, the system prompt, and every runtime message come from a
`DiscoveryProfile`; the code binds to *roles* (`select`, `search`, `schema`,
`execute`) so a profile can rename or reword anything without a code change.
See `profile.py`.

Both meta-tools and promoted tools execute through `wrap_tool_call`. For
promoted tools that is a requirement — they are not registered with the agent's
`ToolNode`, and this is the pattern LangChain documents for middleware-supplied
dynamic tools. For meta-tools it is a choice: routing both through one path is
what lets their definitions be pure data rather than decorated functions.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Annotated, Any, Literal, NotRequired

from langchain.agents.middleware.types import AgentMiddleware, AgentState
from langchain_core.messages import SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.types import Command, interrupt

from langchain_arcade._names import find_candidates
from langchain_arcade._schema import SelectedTool, SelectedToolDict
from langchain_arcade.identity import (
    NO_IDENTITY_ERROR,
    NO_TRUSTED_IDENTITY_ERROR,
    resolve_user_id,
)
from langchain_arcade.profile import (
    TOOL_ROLES,
    DiscoveryProfile,
    MetaTool,
    ToolRole,
    load_profile,
)

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Mapping, Sequence

    from langchain.agents.middleware.types import (
        ModelRequest,
        ModelResponse,
        ToolCallRequest,
    )
    from langchain_core.tools import BaseTool

    from langchain_arcade.provider import ArcadeProvider, ToolExecution

from langchain_arcade.provider import DiscoveryUnavailableError

_log = logging.getLogger(__name__)

REQUIRED_TEMPLATES = (
    "auth_caveat",
    "auth_required",
    "did_you_mean",
    "digest_auth_flag",
    "digest_line",
    "digest_params",
    "discovery_unavailable",
    "empty_output",
    "no_match",
    "promotion_result",
    "search_no_match",
    "search_result",
    "tool_error",
    "unknown_tool",
)
"""Templates the middleware renders. `missing_templates` checks a profile."""

AuthMode = Literal["message", "interrupt"]
"""How an authorization requirement is surfaced.

`message` returns the sign-in URL to the model as a tool error and relies on it
to relay the URL and wait. `interrupt` raises a LangGraph `interrupt` so the
*host* owns the pause and resume, which is what a CLI or UI wants — but it
requires a checkpointer, so it is not the default.
"""

AUTH_INTERRUPT_TYPE = "arcade_authorization_required"
"""`type` field on the interrupt payload, for hosts dispatching on it."""


def _merge_catalog(
    left: dict[str, SelectedToolDict] | None,
    right: dict[str, SelectedToolDict] | None,
) -> dict[str, SelectedToolDict]:
    """Merge catalog updates, newer entries winning.

    A reducer rather than plain replacement so two selections issued in the same
    turn accumulate instead of clobbering each other.

    Args:
        left: Existing catalog, if any.
        right: Incoming catalog fragment, if any.

    Returns:
        The merged catalog.
    """
    return {**(left or {}), **(right or {})}


def _append_promoted(left: list[str] | None, right: list[str] | None) -> list[str]:
    """Append promotions, de-duplicating on most-recent position.

    Recency decides which tools survive the promotion budget, so a re-selected
    tool must move to the end of the list rather than keep its old position.

    Args:
        left: Existing promotion order, if any.
        right: Names to promote, if any.

    Returns:
        The updated promotion order, oldest first.
    """
    combined = [*(left or []), *(right or [])]
    seen: set[str] = set()
    out: list[str] = []
    for name in reversed(combined):
        if name not in seen:
            seen.add(name)
            out.append(name)
    out.reverse()
    return out


class ArcadeState(AgentState):
    """Agent state added by `ArcadeMiddleware`.

    Held in agent state rather than an external cache so it checkpoints with
    the thread and is visible to `wrap_model_call` without scanning message
    history for prior discovery results.
    """

    arcade_catalog: NotRequired[Annotated[dict[str, SelectedToolDict], _merge_catalog]]
    """Discovered tool schemas, keyed by advertised name."""

    arcade_promoted: NotRequired[Annotated[list[str], _append_promoted]]
    """Advertised names to expose as real tools, oldest first."""


def _unreachable(name: str) -> Callable[..., str]:
    """Build the placeholder body for a declaration-only tool.

    Meta-tools are advertised from profile data and executed in
    `wrap_tool_call`, so `StructuredTool` never needs a real callable. Failing
    loudly beats returning something plausible if that ever stops being true.
    """

    def _raise(**_: Any) -> str:
        msg = (
            f"{name} should have been handled by ArcadeMiddleware.wrap_tool_call. "
            f"Reaching its body means the middleware was bypassed."
        )
        raise RuntimeError(msg)

    return _raise


class ArcadeMiddleware(AgentMiddleware[ArcadeState, Any, Any]):
    """Give an agent semantic access to the Arcade tool catalog.

    Injects four meta-tools whose names and descriptions come from the active
    `DiscoveryProfile`. Selection writes schemas into agent state and promotes
    them, so the following model call sees the concrete tools directly.

    Example:
        ```python
        from deepagents import create_deep_agent
        from langchain_arcade import ArcadeMiddleware, EngineProvider

        agent = create_deep_agent(
            model="claude-sonnet-5",
            middleware=[ArcadeMiddleware(provider=EngineProvider())],
        )
        ```

        Reword the prompt without touching code:

        ```python
        from langchain_arcade import load_profile

        ArcadeMiddleware(
            provider=EngineProvider(),
            profile=load_profile({"system_prompt": "Find tools with $select_tool."}),
        )
        ```
    """

    state_schema = ArcadeState

    def __init__(  # noqa: PLR0913  # keyword-only configuration surface
        self,
        *,
        provider: ArcadeProvider,
        profile: DiscoveryProfile | None = None,
        max_promoted: int | None = None,
        select_limit: int | None = None,
        search_limit: int | None = None,
        user_id: str | None = None,
        include_system_prompt: bool = True,
        auth_mode: AuthMode = "message",
    ) -> None:
        """Initialize the middleware.

        Args:
            provider: Transport for discovery and execution.
            profile: Content to use. Defaults to `load_profile()`, which layers
                the bundled profile with any user-config and environment
                overrides.
            max_promoted: How many discovered tools stay advertised at full
                fidelity. Beyond this the oldest drop out of the tool list but
                stay in the catalog. Defaults to the profile's value.
            select_limit: Default `top_k` for selection. Defaults to the
                profile's value.
            search_limit: Default limit for search. Defaults to the profile's
                value.
            user_id: Fallback Arcade identity for this agent instance. A
                per-request identity from `runtime.context.arcade_user_id` or
                `config["configurable"]["arcade_user_id"]` takes precedence, so a
                server can set a default here and still vary it per user. When
                every source is empty the provider's own default (or
                `$ARCADE_USER_ID`) applies. See `identity.py`.
            include_system_prompt: Append the profile's guidance to the system
                message. Discovery still works without it, less reliably.
            auth_mode: `"message"` hands the sign-in URL to the model as a tool
                error. `"interrupt"` raises a LangGraph `interrupt` so the host
                renders sign-in and resumes; it requires the graph to be
                compiled with a checkpointer.

        Raises:
            ValueError: If `max_promoted` is not positive.
        """
        self._profile = profile if profile is not None else load_profile()
        defaults = self._profile.defaults

        resolved_max = defaults.max_promoted if max_promoted is None else max_promoted
        if resolved_max < 1:
            msg = f"max_promoted must be >= 1, got {resolved_max}"
            raise ValueError(msg)

        self._provider = provider
        self._max_promoted = resolved_max
        self._select_limit = (
            defaults.select_limit if select_limit is None else select_limit
        )
        self._search_limit = (
            defaults.search_limit if search_limit is None else search_limit
        )
        self._user_id = user_id
        self._include_system_prompt = include_system_prompt
        self._auth_mode = auth_mode
        self.tools = self._build_tools()

    @property
    def profile(self) -> DiscoveryProfile:
        """The active profile. Useful for diagnostics and tests."""
        return self._profile

    # ------------------------------------------------------------------
    # Tool definitions, built from profile data
    # ------------------------------------------------------------------

    def _advertised_roles(self) -> tuple[ToolRole, ...]:
        """Roles to advertise: defined by the profile and served by the provider.

        A provider predating `supported_roles` is read as serving everything,
        so third-party transports keep their previous behaviour.
        """
        supported = getattr(self._provider, "supported_roles", None)
        if supported is None:
            supported = frozenset(TOOL_ROLES)
        return tuple(
            r for r in TOOL_ROLES if r in self._profile.roles and r in supported
        )

    def _build_tools(self) -> list[BaseTool]:
        """Advertise one tool per advertised role, straight from the profile."""
        return [_as_tool(self._profile.tool(role)) for role in self._advertised_roles()]

    def _promoted_tools(self, state: Mapping[str, Any]) -> list[StructuredTool]:
        """Build tool definitions for the current promotion window."""
        catalog = _catalog(state)
        promoted = state.get("arcade_promoted") or []
        out: list[StructuredTool] = []
        for name in promoted[-self._max_promoted :]:
            entry = catalog.get(name)
            if entry is None:
                continue
            selected = SelectedTool.from_dict(entry)
            description = selected.description or selected.fqn
            if selected.requires_auth:
                description += self._profile.render("auth_caveat")
            out.append(
                StructuredTool(
                    name=selected.name,
                    description=description,
                    args_schema=selected.input_schema
                    or {"type": "object", "properties": {}},
                    func=_unreachable(selected.name),
                )
            )
        return out

    # ------------------------------------------------------------------
    # Model call
    # ------------------------------------------------------------------

    def wrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        """Advertise promoted Arcade tools and append discovery guidance.

        Args:
            request: The outgoing model request.
            handler: Downstream handler.

        Returns:
            The model response.
        """
        return handler(self._augment(request))

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        """Async variant of `wrap_model_call`.

        Args:
            request: The outgoing model request.
            handler: Downstream async handler.

        Returns:
            The model response.
        """
        return await handler(self._augment(request))

    def _augment(self, request: ModelRequest[Any]) -> ModelRequest[Any]:
        """Apply promotion and prompt guidance to a model request."""
        overrides: dict[str, Any] = {}
        promoted = self._promoted_tools(request.state)
        if promoted:
            # Append rather than insert: a stable prefix keeps the cacheable
            # portion of the tool list intact as the window grows.
            overrides["tools"] = [*request.tools, *promoted]
        prompt = self._profile.system_prompt
        if self._include_system_prompt and prompt:
            overrides["system_message"] = _append_system_text(request, prompt)
        return request.override(**overrides) if overrides else request

    # ------------------------------------------------------------------
    # Tool call
    # ------------------------------------------------------------------

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        """Execute meta-tools and promoted tools.

        Args:
            request: The tool call to run.
            handler: Downstream handler for everyone else's tools.

        Returns:
            The tool result.
        """
        intercepted = self._intercept(request)
        return intercepted if intercepted is not None else handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        """Async variant of `wrap_tool_call`.

        The interception runs in a worker thread. `ArcadeProvider` is a
        synchronous protocol, so calling it directly from the event loop blocks
        it, and LangGraph's concurrent tool calls then complete one at a time.
        Measured: eight parallel calls of 0.5s each took 0.55s under `invoke`
        and 4.09s under `ainvoke` before this — a server, which is exactly the
        host that would use `ainvoke`, got the serial path.

        A provider with async methods (`aselect`, `asearch`, `aexecute`) has
        them awaited on this event loop, not run in the thread. An async MCP
        session belongs to the loop that opened it, and the old path handed
        its unawaited coroutine to the model as the tool result. The provider
        is bound to this run first, with `abind` when it has one.

        Args:
            request: The tool call to run.
            handler: Downstream async handler.

        Returns:
            The tool result.
        """
        provider: Any = None
        if self._uses_provider(request):
            provider = _OnLoop(await self._abind(request), asyncio.get_running_loop())
        intercepted = await asyncio.to_thread(self._intercept, request, provider)
        return intercepted if intercepted is not None else await handler(request)

    def _uses_provider(self, request: ToolCallRequest) -> bool:
        """Whether this call reaches the provider, so it needs binding.

        Binding can be costly (a host may fetch a credential), so a call that
        passes through, or only re-reads the catalog, does not pay for it.
        """
        name = request.tool_call.get("name", "")
        role = self._profile.role_of(name)
        if role is not None:
            return role != "schema"
        if request.tool is not None:
            return False
        return self._resolve(name, _catalog(request.state)) is not None

    def _bind(self, request: ToolCallRequest) -> Any:
        """The provider for this call's run, via its `bind` when it has one."""
        bind = getattr(self._provider, "bind", None)
        if callable(bind):
            return bind(getattr(request, "runtime", None))
        return self._provider

    async def _abind(self, request: ToolCallRequest) -> Any:
        """Async form of `_bind`, preferring the provider's `abind`."""
        abind = getattr(self._provider, "abind", None)
        if callable(abind):
            return await abind(getattr(request, "runtime", None))
        return self._bind(request)

    def _intercept(
        self, request: ToolCallRequest, provider: Any = None
    ) -> ToolMessage | Command | None:
        """Return a result for an Arcade tool call, or `None` to pass through.

        Args:
            request: The tool call.
            provider: The provider already bound for this run. The sync path
                leaves it unset and binds here, only when the call needs it.
        """
        call = request.tool_call
        name = call.get("name", "")
        call_id = call.get("id") or ""
        args = call.get("args")
        args = args if isinstance(args, dict) else {}

        # Meta-tools are registered, so this must come before the resolved-tool
        # check below — otherwise the ToolNode would invoke their placeholder
        # bodies instead of the handlers here.
        role = self._profile.role_of(name)
        if role is not None:
            if provider is None and role != "schema":
                provider = self._bind(request)
            return self._handle_meta(
                role, args, request.state, call_id, self._identity(request), provider
            )

        # A resolved tool belongs to someone else.
        if request.tool is not None:
            return None

        catalog = _catalog(request.state)
        resolved = self._resolve(name, catalog)
        if resolved is None:
            if not catalog:
                return None
            return self._not_found(name, catalog, call_id, name)
        if provider is None:
            provider = self._bind(request)
        return self._executed(
            resolved, args, call_id, name, self._identity(request), provider
        )

    def _identity(self, request: ToolCallRequest) -> str | None:
        """Resolve the Arcade identity for this call."""
        return resolve_user_id(
            runtime=getattr(request, "runtime", None), fallback=self._user_id
        )

    def _handle_meta(  # noqa: PLR0913  # one call's full context
        self,
        role: ToolRole,
        args: dict[str, Any],
        state: Mapping[str, Any],
        call_id: str,
        user_id: str | None,
        provider: Any,
    ) -> ToolMessage | Command:
        """Dispatch a meta-tool call by role."""
        if role == "select":
            return self._do_select(args, call_id, user_id, provider)
        if role == "search":
            return self._do_search(args, call_id, user_id, provider)
        if role == "schema":
            return self._do_schema(args, state, call_id)
        return self._do_execute(args, state, call_id, user_id, provider)

    # ------------------------------------------------------------------
    # Role handlers
    # ------------------------------------------------------------------

    def _unavailable(self, call_id: str, name: str, reason: str) -> ToolMessage:
        """Report that discovery could not run, distinctly from finding nothing.

        The wording matters as much as the status. A model told "nothing
        matched" reasonably concludes the capability does not exist and says so
        to the user; a model told the service is down waits. Both are empty
        results — only the text separates them.

        The reason (the Engine's status and body, as the provider raised it) goes
        two places: the server log, where whoever runs the agent looks first, and
        the end of the tool message, so the model can pass it on when asked. A
        bare "temporarily unavailable" leaves a stale extension on the project, or
        a dead hook URL, indistinguishable from an Arcade outage.

        Args:
            call_id: Tool call to answer.
            name: Advertised name of the meta-tool that was called.
            reason: Why discovery did not run, from the raised error.

        Returns:
            An error `ToolMessage` carrying the profile's `discovery_unavailable`
            text and the reason.
        """
        _log.warning("Tool discovery unavailable: %s", reason)
        return ToolMessage(
            content=f"{self._profile.render('discovery_unavailable')}\n\nReason, for whoever runs this agent: {reason}",
            name=name,
            tool_call_id=call_id,
            status="error",
        )

    def _do_select(
        self, args: dict[str, Any], call_id: str, user_id: str | None, provider: Any
    ) -> Command | ToolMessage:
        """Select tools for the given tasks and promote them.

        Returns a `Command` on success, because promotion writes to state. An
        outage has nothing to write, so it returns a bare `ToolMessage`.
        """
        raw_tasks = args.get("tasks") or []
        tasks = (
            [str(t) for t in raw_tasks]
            if isinstance(raw_tasks, list)
            else [str(raw_tasks)]
        )
        limit = _int_or(args.get("limit"), self._select_limit)
        try:
            found = provider.select(tasks, limit, user_id=user_id)
        except DiscoveryUnavailableError as exc:
            return self._unavailable(call_id, self._profile.name_of("select"), str(exc))
        return self._promote(
            found,
            call_id,
            empty_note=self._profile.render("no_match", tasks="; ".join(tasks)),
        )

    def _do_search(
        self, args: dict[str, Any], call_id: str, user_id: str | None, provider: Any
    ) -> ToolMessage:
        """Search the catalog without promoting anything."""
        query = str(args.get("query", ""))
        limit = _int_or(args.get("limit"), self._search_limit)
        name = self._profile.name_of("search")
        try:
            found = provider.search(query, limit, user_id=user_id)
        except DiscoveryUnavailableError as exc:
            return self._unavailable(call_id, name, str(exc))
        if not found:
            content = self._profile.render("search_no_match", query=repr(query))
        else:
            content = self._profile.render(
                "search_result",
                count=len(found),
                query=repr(query),
                digest=self._digest(found),
            )
        return ToolMessage(content=content, name=name, tool_call_id=call_id)

    def _do_schema(
        self, args: dict[str, Any], state: Mapping[str, Any], call_id: str
    ) -> Command:
        """Re-promote catalog entries that fell out of the window."""
        raw = args.get("names") or []
        names = [str(n) for n in raw] if isinstance(raw, list) else [str(raw)]
        catalog = _catalog(state)
        found = [SelectedTool.from_dict(catalog[n]) for n in names if n in catalog]
        missing = [n for n in names if n not in catalog]
        # A partial hit should still say which names were unknown, so this
        # note applies in both branches.
        note = self._missing_note(missing, catalog) if missing else ""
        return self._promote(found, call_id, empty_note=note, found_note=note)

    def _do_execute(
        self,
        args: dict[str, Any],
        state: Mapping[str, Any],
        call_id: str,
        user_id: str | None,
        provider: Any,
    ) -> ToolMessage:
        """Execute a discovered tool named explicitly by the model."""
        tool_name = str(args.get("tool_name", ""))
        raw_inputs = args.get("inputs")
        inputs = raw_inputs if isinstance(raw_inputs, dict) else {}
        catalog = _catalog(state)
        name = self._profile.name_of("execute")
        resolved = self._resolve(tool_name, catalog)
        if resolved is None:
            return self._not_found(tool_name, catalog, call_id, name)
        return self._executed(resolved, inputs, call_id, name, user_id, provider)

    # ------------------------------------------------------------------
    # Shared behavior
    # ------------------------------------------------------------------

    def _promote(
        self,
        found: Sequence[SelectedTool],
        call_id: str,
        *,
        empty_note: str,
        found_note: str = "",
    ) -> Command:
        """Write schemas to the catalog and mark them for promotion.

        The two notes are deliberately separate. `empty_note` explains a miss
        and must never trail a successful result — telling the model "no tools
        matched" directly beneath a list of tools it just received is worse
        than saying nothing.

        Args:
            found: Newly discovered tools.
            call_id: Tool-call id to answer.
            empty_note: Sole message when `found` is empty.
            found_note: Extra guidance appended only when `found` is non-empty,
                e.g. naming which requested tools were not in the catalog.

        Returns:
            A `Command` carrying both the tool result and the state update.
        """
        name = self._profile.name_of("select")
        if not found:
            return Command(
                update={
                    "messages": [
                        ToolMessage(content=empty_note, name=name, tool_call_id=call_id)
                    ]
                }
            )
        content = self._profile.render(
            "promotion_result",
            count=len(found),
            digest=self._digest(found),
            trailer=f"\n\n{found_note}" if found_note else "",
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(content=content, name=name, tool_call_id=call_id)
                ],
                "arcade_catalog": {t.name: t.to_dict() for t in found},
                "arcade_promoted": [t.name for t in found],
            }
        )

    def _digest(self, tools: Sequence[SelectedTool]) -> str:
        """Render one line per tool, per the profile's digest templates."""
        limit = self._profile.defaults.digest_description_limit
        lines = []
        for tool in tools:
            required = tool.input_schema.get("required")
            params = ""
            if isinstance(required, list) and required:
                params = self._profile.render(
                    "digest_params", required=", ".join(str(r) for r in required)
                )
            summary = " ".join(tool.description.split())
            if len(summary) > limit:
                summary = summary[: limit - 1].rstrip() + "…"
            lines.append(
                self._profile.render(
                    "digest_line",
                    name=tool.name,
                    params=params,
                    description=summary,
                    auth_flag=(
                        self._profile.render("digest_auth_flag")
                        if tool.requires_auth
                        else ""
                    ),
                )
            )
        return "\n".join(lines)

    def _resolve(
        self, name: str, catalog: dict[str, SelectedToolDict]
    ) -> SelectedTool | None:
        """Resolve a model-supplied name, repairing an unambiguous near-miss."""
        entry = catalog.get(name)
        if entry is not None:
            return SelectedTool.from_dict(entry)
        # Models routinely drop the toolkit prefix or swap the separator. One
        # unambiguous candidate is a safe repair; several is not.
        candidates = find_candidates(list(catalog), name, limit=2)
        if len(candidates) == 1:
            return SelectedTool.from_dict(catalog[candidates[0]])
        return None

    def _missing_note(self, missing: Sequence[str], catalog: Mapping[str, Any]) -> str:
        """Build a corrective message naming close matches from the catalog."""
        names = ", ".join(repr(m) for m in missing)
        suggestions: list[str] = []
        for name in missing:
            suggestions.extend(
                find_candidates(
                    list(catalog),
                    name,
                    limit=self._profile.defaults.max_candidate_hints,
                )
            )
        if suggestions:
            unique = list(dict.fromkeys(suggestions))[
                : self._profile.defaults.max_candidate_hints
            ]
            return self._profile.render(
                "did_you_mean", names=names, candidates=", ".join(unique)
            )
        return self._profile.render("unknown_tool", names=names)

    def _not_found(
        self,
        tool_name: str,
        catalog: dict[str, SelectedToolDict],
        call_id: str,
        message_name: str,
    ) -> ToolMessage:
        """Answer a call for something not in the catalog."""
        return ToolMessage(
            content=self._missing_note([tool_name], catalog),
            name=message_name,
            tool_call_id=call_id,
            status="error",
        )

    def _executed(  # noqa: PLR0913  # one call's full context
        self,
        selected: SelectedTool,
        inputs: dict[str, Any],
        call_id: str,
        message_name: str,
        user_id: str | None,
        provider: Any,
    ) -> ToolMessage:
        """Run one tool and render its outcome for the model."""
        trusted = getattr(provider, "identity_is_trusted", False)
        if trusted:
            # The host resolves identity. Run context and config are what a
            # caller controls, so they are not offered, and an empty answer is
            # a refusal rather than a cue to fall back.
            user_id = None
        needs_identity = getattr(provider, "requires_user_id", False)
        if needs_identity and not (user_id or getattr(provider, "user_id", None)):
            # Stop before a call that cannot succeed. The middleware knows every
            # place identity can come from, so it gives the better message; the
            # provider keeps its own guard for direct use.
            return ToolMessage(
                content=NO_TRUSTED_IDENTITY_ERROR if trusted else NO_IDENTITY_ERROR,
                name=message_name,
                tool_call_id=call_id,
                status="error",
            )
        result = self._run(selected, inputs, user_id, provider)

        if result.auth_required and self._auth_mode == "interrupt":
            # Hand the pause to the host. LangGraph re-executes this whole node
            # on resume, so `self._run` above has already retried by the time we
            # get here a second time — no explicit retry belongs in this branch.
            # On that second pass `interrupt` returns the resume value instead of
            # raising, so a still-unauthorized tool falls through to the message
            # path below rather than pausing again forever.
            interrupt(
                {
                    "type": AUTH_INTERRUPT_TYPE,
                    "tool": selected.name,
                    "toolkit": selected.toolkit,
                    "auth_url": result.auth_url,
                    "message": self._auth_text(selected, result.auth_url),
                }
            )

        if result.auth_required:
            return ToolMessage(
                content=self._auth_text(selected, result.auth_url),
                name=message_name,
                tool_call_id=call_id,
                status="error",
            )
        if not result.success:
            return ToolMessage(
                content=self._profile.render(
                    "tool_error", name=selected.name, error=result.error
                ),
                name=message_name,
                tool_call_id=call_id,
                status="error",
            )
        return ToolMessage(
            content=self._render_value(result.value),
            name=message_name,
            tool_call_id=call_id,
            status="success",
        )

    def _run(
        self,
        selected: SelectedTool,
        inputs: dict[str, Any],
        user_id: str | None,
        provider: Any,
    ) -> ToolExecution:
        """Execute one tool through the provider."""
        return provider.execute(
            selected.fqn,
            inputs,
            user_id=user_id,
            query_id=selected.query_id,
        )

    def _auth_text(self, selected: SelectedTool, auth_url: str) -> str:
        """Render the authorization prompt for a tool."""
        return self._profile.render(
            "auth_required",
            toolkit=selected.toolkit or selected.name,
            auth_url=auth_url,
        )

    def _render_value(self, value: Any) -> str:
        """Render a tool result as text the model can read."""
        if value is None:
            return self._profile.render("empty_output")
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, indent=2, default=str)
        except (TypeError, ValueError):
            return str(value)


class _OnLoop:
    """A sync view of a provider whose async methods run on the event loop.

    The interception code is synchronous and runs in a worker thread. When the
    provider has `aselect` / `asearch` / `aexecute`, this submits them to the
    agent's loop and waits, so an async MCP session is awaited on the loop it
    belongs to. A provider without them is called directly, in the thread, as
    before. Everything else (`user_id`, `requires_user_id`, ...) reads through.
    """

    def __init__(self, provider: Any, loop: asyncio.AbstractEventLoop) -> None:
        self._inner = provider
        self._loop = loop

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def _call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        method = getattr(self._inner, f"a{name}", None)
        if method is None:
            return getattr(self._inner, name)(*args, **kwargs)
        future = asyncio.run_coroutine_threadsafe(method(*args, **kwargs), self._loop)
        return future.result()

    def select(self, *args: Any, **kwargs: Any) -> Any:
        return self._call("select", *args, **kwargs)

    def search(self, *args: Any, **kwargs: Any) -> Any:
        return self._call("search", *args, **kwargs)

    def execute(self, *args: Any, **kwargs: Any) -> Any:
        return self._call("execute", *args, **kwargs)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _as_tool(meta: MetaTool) -> StructuredTool:
    """Turn a profile tool definition into an advertisable tool."""
    return StructuredTool(
        name=meta.name,
        description=meta.description,
        args_schema=meta.input_schema or {"type": "object", "properties": {}},
        func=_unreachable(meta.name),
    )


def _int_or(value: Any, fallback: int) -> int:
    """Coerce a model-supplied limit, falling back when it is unusable."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _catalog(state: Mapping[str, Any]) -> dict[str, SelectedToolDict]:
    """Read the catalog out of agent state, tolerating absence."""
    value = state.get("arcade_catalog")
    return value if isinstance(value, dict) else {}


def _append_system_text(request: ModelRequest[Any], text: str) -> Any:
    """Return a system message with `text` appended."""
    existing = request.system_message
    if existing is None:
        return SystemMessage(content=text)
    content = existing.content
    if isinstance(content, str):
        return existing.model_copy(update={"content": f"{content}\n\n{text}"})
    # Structured content (content blocks): append a trailing text block so
    # prompt-cache breakpoints earlier in the list stay put.
    if isinstance(content, list):
        return existing.model_copy(
            update={"content": [*content, {"type": "text", "text": text}]}
        )
    return existing


__all__ = [
    "AUTH_INTERRUPT_TYPE",
    "REQUIRED_TEMPLATES",
    "ArcadeMiddleware",
    "ArcadeState",
    "AuthMode",
]
