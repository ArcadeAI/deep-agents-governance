"""The eval target: the loan desk agent in this process, as a named person.

`agent.py` stays as it is. This builds the same graph, `create_deep_agent` with the vendored
`ArcadeMiddleware`, `agent.py`'s own provider class (so the six loan desk tools are pinned ahead
of Tool Rec, as in production) and the same `instructions.md`, with two differences, both on
purpose:

- The person is asserted, not verified. MDA hands `agent.py` the email from an ID token it
  checked; here it comes from `.env` (`EVAL_LOAN_OFFICER`: you, by the email the workshop
  identity provider knows). Every tool call still reaches Arcade as that person, so the
  hooks decide as they do for the deployment.
- Two tools are answered here instead of by Arcade: `LoanDesk.RequestApproval`, which would
  DM the approver on Slack and post in the approvals channel, and `Gmail.SendEmail`. The
  canned results have the shape the real tools return and say they are canned. The other
  loan desk tools run for real: the search, the reads, the approval attempt and its refusal,
  the redaction, the injection strip. Every other tool Tool Rec may offer (the rest of Gmail,
  Slack, the catalog) is withheld with an error that says so, so nothing acts as the person
  outside the loan desk.

Two smaller differences: the deployment prepends MDA's platform instructions to
`instructions.md`, and mounts `skills/` at `/skills/`; this does neither.

A run's result is what `checks.py` reads: the answer, the Arcade tool calls in order, and
each one's result as the model saw it. `deployment_target` gives the same shape from a
deployed agent over `/runs/wait`, for the optional step on the page.
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from langchain.chat_models import init_chat_model
from langchain_core.messages import HumanMessage

from langchain_arcade import ArcadeMiddleware
from langchain_arcade.provider import ToolExecution

from agent import SplitIdentityProvider
from scripted import ScriptedModel

INSTRUCTIONS = Path(__file__).resolve().parent.parent / "instructions.md"
#: Module 01's skills, mounted at /skills/ when the directory exists, as the deployment mounts them.
SKILLS = INSTRUCTIONS.parent / "skills"
#: Arcade names a tool `Toolkit_Tool`. The agent's own tools (`arcade_select_tools`,
#: `write_todos`, `read_file`, …) are lowercase, and none of them is a decision about a loan.
ARCADE_TOOL = re.compile(r"^[A-Z][A-Za-z0-9]*_")
#: The toolkits that reach Arcade. Everything else is withheld.
LIVE_TOOLKITS = frozenset({"LoanDesk"})

#: The dataset's roles and the `.env` variable that names who plays each. One role: the loan
#: officer is you, by the email the workshop identity provider knows.
ROLE_ENV = {"loan_officer": "EVAL_LOAN_OFFICER"}
#: The loan desk tool that lists the book.
SEARCH_LOANS = "LoanDesk.SearchLoans"


def person(role: str) -> str:
    """The email `.env` names for a dataset role."""
    try:
        variable = ROLE_ENV[role]
    except KeyError:
        raise ValueError(f"unknown role {role!r}; one of {', '.join(ROLE_ENV)}") from None
    email = os.environ.get(variable, "").strip()
    if "@" not in email:
        raise RuntimeError(
            f"{variable} is not set in agent/.env. It is the email the eval runs as: your own, the one the workshop "
            "identity provider knows you by."
        )
    return email


def canned_request_approval(inputs: dict[str, Any]) -> dict[str, Any]:
    """What `LoanDesk_RequestApproval` returns, minus the Slack message."""
    request_id = f"eval-{uuid.uuid4().hex[:12]}"
    return {
        "request_id": request_id,
        "status": "pending",
        "approver": "vp.credit@example.com",
        "approver_display_name": "Charlie (VP Credit)",
        "candidate_approvers": ["vp.credit@example.com", "chief.credit@example.com"],
        "approval_url": f"https://loan-desk.example/approvals/{request_id}",
        "slack_message_ts": "0",
        "note": "Recorded by the evaluation target. No Slack message was sent.",
    }


def canned_send_email(inputs: dict[str, Any]) -> dict[str, Any]:
    """What `Gmail_SendEmail` returns, minus the email."""
    return {
        "id": f"eval-{uuid.uuid4().hex[:12]}",
        "threadId": f"eval-{uuid.uuid4().hex[:12]}",
        "labelIds": ["SENT"],
        "note": "Recorded by the evaluation target. No email was sent.",
    }


#: Tools answered locally, by their fully qualified name without the version.
STUBS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "LoanDesk.RequestApproval": canned_request_approval,
    "Gmail.SendEmail": canned_send_email,
}


class EvalProvider(SplitIdentityProvider):
    """`agent.py`'s provider as one fixed person: the loan desk tools live and pinned, two answered locally, the rest withheld."""

    def __init__(
        self,
        *,
        api_key: str | None,
        user_id: str,
        stubs: dict[str, Callable[[dict[str, Any]], Any]] | None = None,
        live_toolkits: frozenset[str] = LIVE_TOOLKITS,
        **kwargs: Any,
    ) -> None:
        super().__init__(api_key=api_key, user_id=user_id, **kwargs)
        self._stubs = dict(STUBS if stubs is None else stubs)
        self._live_toolkits = live_toolkits
        #: Every call answered locally and every call withheld, `(fqn, inputs)`, for the record.
        self.stubbed: list[tuple[str, dict[str, Any]]] = []
        self.withheld: list[tuple[str, dict[str, Any]]] = []

    def execute(self, fqn: str, inputs: dict[str, Any], *, user_id: str | None = None, query_id: str = "") -> ToolExecution:
        name = fqn.split("@", 1)[0]
        stub = self._stubs.get(name)
        if stub is not None:
            self.stubbed.append((fqn, dict(inputs)))
            return ToolExecution(success=True, value=stub(inputs))
        if name.split(".", 1)[0] in self._live_toolkits:
            return super().execute(fqn, inputs, user_id=user_id, query_id=query_id)
        self.withheld.append((fqn, dict(inputs)))
        return ToolExecution(success=False, error=f"{name} is not available in this evaluation. Only the loan desk tools run here.")


def loan_book(user: str, *, provider: Any = None) -> list[dict[str, Any]]:
    """The loan book as `user` sees it: `LoanDesk.SearchLoans` with no filters, through the hooks, as the agent calls it.

    Returns the summaries the tool returns (`loan_id`, `borrower_name`, `amount`, `status`, …), for
    `examples.ids_in`. The tool is taken from the project's own list, the way `agent.py` pins it.
    A missing grant surfaces as the sign-in link, the same as the agent's first call; a refusal
    or an unreadable list as a `RuntimeError` in the tool's words.
    """
    if provider is None:
        provider = EvalProvider(api_key=os.environ.get("ARCADE_API_KEY"), user_id=user)
    tool = next((t for t in provider.loan_desk_tools() if t.fqn.split("@", 1)[0] == SEARCH_LOANS), None)
    if tool is None:
        raise RuntimeError(f"{SEARCH_LOANS} is not in this project's tool list. Is the Loan Desk server deployed in the project ARCADE_API_KEY belongs to?")
    outcome = provider.execute(tool.fqn, {})
    if outcome.auth_required:
        raise RuntimeError(f"Arcade needs your permission first, as {user}. Open this link, allow it, and run the cell again: {outcome.auth_url}")
    if not outcome.success:
        raise RuntimeError(f"{SEARCH_LOANS} as {user}: {outcome.error}")
    value = outcome.value
    if isinstance(value, str):
        import json

        value = json.loads(value)
    loans = value.get("loans") if isinstance(value, dict) else value
    return [loan for loan in (loans or []) if isinstance(loan, dict)]


def model_from_env() -> Any:
    """`MODEL_ID`'s model, or the scripted one `agent.py` falls back to."""
    model_id = os.environ.get("MODEL_ID", "").strip()
    return init_chat_model(model_id) if model_id else ScriptedModel()


def build(user: str, *, model: Any = None, system_prompt: str | None = None, provider: Any = None):
    """The loan desk agent, in this process, as `user`. Pass `system_prompt` to try a different one.

    The instructions and the skills come from disk, not from Context Hub: `agent/skills/` is
    mounted at `/skills/` when it exists, the way the deployment mounts it.
    """
    # The provider falls back to `$ARCADE_GATEWAY_ID`; `agent.py` drops it for the same reason.
    os.environ.pop("ARCADE_GATEWAY_ID", None)
    if provider is None:
        provider = EvalProvider(api_key=os.environ.get("ARCADE_API_KEY"), user_id=user)
    mounts: dict[str, Any] = {}
    if SKILLS.is_dir():
        mounts = {
            "backend": CompositeBackend(default=StateBackend(), routes={"/skills/": FilesystemBackend(root_dir=SKILLS)}),
            "skills": ["/skills/"],
        }
    return create_deep_agent(
        model=model if model is not None else model_from_env(),
        system_prompt=INSTRUCTIONS.read_text() if system_prompt is None else system_prompt,
        middleware=[ArcadeMiddleware(provider=provider)],
        **mounts,
    )


def _text(content: Any) -> str:
    """A message's text, whether it is a string or content blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(block.get("text", "") if isinstance(block, dict) else str(block) for block in content)
    return str(content)


def question_of(run: Any) -> str:
    """The question that started a traced run: the first message of its input, trimmed."""
    messages = (getattr(run, "inputs", None) or {}).get("messages") or []
    first = messages[0] if messages else {}
    content = first.get("content") if isinstance(first, dict) else getattr(first, "content", "")
    return str(content or "")[:60]


def summarize(messages: list[Any]) -> dict[str, Any]:
    """A run's messages, as the evaluators read them.

    Takes message objects, `/runs/wait`'s dicts, or a LangSmith root run's `outputs["messages"]`.
    Keeps the Arcade tool calls and results; the agent's own tools are dropped.
    """
    trajectory: list[str] = []
    tool_results: list[dict[str, str]] = []
    answer = ""
    for message in messages:
        if isinstance(message, dict):
            kind, name, content = message.get("type"), message.get("name"), message.get("content")
            calls = message.get("tool_calls") or []
        else:
            kind, name, content = message.type, getattr(message, "name", None), message.content
            calls = getattr(message, "tool_calls", None) or []
        if kind == "ai":
            trajectory.extend(call["name"] for call in calls if ARCADE_TOOL.match(call["name"]))
            if _text(content).strip():
                answer = _text(content)
        elif kind == "tool" and name and ARCADE_TOOL.match(name):
            tool_results.append({"name": name, "content": _text(content)})
    return {"answer": answer, "trajectory": trajectory, "tool_results": tool_results}


def transcript(outputs: dict[str, Any], width: int = 600) -> list[str]:
    """The run as lines: the calls, then the results, then the answer."""
    lines = [f"→ {name}" for name in outputs["trajectory"]]
    lines += [f"← {r['name']}: {r['content'][:width]}" for r in outputs["tool_results"]]
    return [*lines, outputs["answer"]]


class Target:
    """The target `client.evaluate` calls: one agent per role, built on first use.

    `inputs` is a dataset row: `user` (a role) and `prompt`.
    """

    def __init__(self, *, model: Any = None, system_prompt: str | None = None, build: Callable[..., Any] = build) -> None:
        self._model = model
        self._system_prompt = system_prompt
        self._build = build
        self._agents: dict[str, Any] = {}

    def agent_for(self, role: str) -> Any:
        if role not in self._agents:
            self._agents[role] = self._build(person(role), model=self._model, system_prompt=self._system_prompt)
        return self._agents[role]

    def __call__(self, inputs: dict[str, Any]) -> dict[str, Any]:
        result = self.agent_for(inputs["user"]).invoke({"messages": [HumanMessage(content=inputs["prompt"])]})
        return summarize(result["messages"])


def sign_in() -> str:
    """One browser sign-in, the way `ask.py` does it. The ID token lasts about an hour."""
    import secrets
    import sys
    import webbrowser

    import ask

    endpoints = ask.discover(ask.configured_issuer())
    verifier, challenge = ask.pkce()
    state = secrets.token_urlsafe(16)
    url = ask.authorize_url(endpoints["authorization_endpoint"], os.environ["IDP_CLIENT_ID"], challenge, state)
    server = ask.listen()  # bound before the browser opens, as ask.py does, so a taken port is a message
    print(f"Sign in as the person asking: {url}", file=sys.stderr)
    webbrowser.open(url)
    code = ask.catch_code(server, state)
    return ask.id_token(endpoints["token_endpoint"], os.environ["IDP_CLIENT_ID"], os.environ["IDP_CLIENT_SECRET"], code, verifier)


def token_for_asking() -> str:
    """The sign-in `ask.py` kept, while it lasts; otherwise one browser sign-in, kept the same way."""
    import time

    import ask

    path = ask.session_path(ask.configured_issuer(), os.environ["IDP_CLIENT_ID"])
    token = ask.saved_session(path, time.time())
    if token is None:
        token = sign_in()
        ask.keep_session(path, token)
    return token


def deployment_target(agent_url: str, token: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """The deployed agent over `/runs/wait`, as the person the token names, in the same output shape.

    Every call runs as that one person, whatever the row's `user` says, and nothing is
    stubbed: an escalation DMs the approver for real.
    """
    import ask

    def call(inputs: dict[str, Any]) -> dict[str, Any]:
        return summarize(ask.ask(agent_url.rstrip("/"), token, inputs["prompt"])["messages"])

    return call
