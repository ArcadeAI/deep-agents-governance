"""The agent's wiring, its caller identity, and one scripted run, all offline."""

from types import SimpleNamespace
from typing import Any

import pytest
from deepagents import create_deep_agent
from langchain_core.messages import HumanMessage, ToolMessage

import agent as loan_desk
import identity as loan_desk_identity
from langchain_arcade import ArcadeMiddleware, SelectedTool, StaticProvider
from scripted import SELECT, TOOL, ScriptedModel

SEARCH_LOANS = SelectedTool(
    fqn="LoanDesk.SearchLoans@1.0.0",
    name="LoanDesk_SearchLoans",
    description="Search loan applications on the loan desk by status and amount.",
    input_schema={"type": "object", "properties": {"status": {"type": "string"}}},
    toolkit="LoanDesk",
)


def runtime_for(user: Any) -> SimpleNamespace:
    """A runtime shaped like MDA's: the verified caller is `server_info.principal.id`."""
    return SimpleNamespace(server_info=SimpleNamespace(principal=SimpleNamespace(id=user)))


class TestCaller:
    def test_the_verified_email_is_the_arcade_user(self) -> None:
        assert loan_desk.signed_in_user(runtime_for("bob@megaforce.tech")) == "bob@megaforce.tech"

    @pytest.mark.parametrize("runtime", [None, SimpleNamespace(), runtime_for(None), runtime_for(""), runtime_for("service-key")])
    def test_no_verified_email_means_no_user(self, runtime: Any) -> None:
        # No user id, so the engine refuses every call: fail closed, never a default seat.
        assert loan_desk.signed_in_user(runtime) is None


class TestWiring:
    def test_the_agent_is_named_and_carries_the_arcade_middleware(self) -> None:
        config = loan_desk.agent.config
        assert config["name"] == "loan-desk"
        assert [type(m) for m in config["middleware"]] == [ArcadeMiddleware]

    def test_selection_is_scoped_to_the_gateway(self) -> None:
        assert loan_desk.provider._gateway_id == "gw-test"

    def test_the_model_is_scripted_without_model_id(self) -> None:
        assert isinstance(loan_desk.agent.config["model"], ScriptedModel)


class TestIdentity:
    def test_callers_are_verified_against_the_apps_own_keys(self) -> None:
        (provider,) = loan_desk_identity.identity.config["ingress"]["http"]["providers"]
        assert provider["issuer"] == "https://bank.example"
        assert provider["jwks"] == "https://bank.example/jwks"
        assert provider["audience"] == "web-client-test"
        # The IdP pins RS256 (auth/provider/auth.ts); EdDSA would fail at verification.
        assert provider["algorithms"] == ["RS256"]
        assert provider["claims"]["user"] == "email"

    def test_a_missing_value_stops_the_import_by_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("IDP_CLIENT_ID")
        with pytest.raises(RuntimeError, match="IDP_CLIENT_ID is not set"):
            loan_desk_identity.required("IDP_CLIENT_ID")


class TestScriptedRun:
    def test_select_then_search_then_answer(self) -> None:
        seen: list[dict[str, Any]] = []

        def search(inputs: dict[str, Any]) -> dict[str, Any]:
            seen.append(inputs)
            return {"loans": [{"id": "LN-2291", "loan": 95000, "status": "pending"}]}

        provider = StaticProvider([SEARCH_LOANS], {SEARCH_LOANS.fqn: search})
        graph = create_deep_agent(model=ScriptedModel(), middleware=[ArcadeMiddleware(provider=provider)])

        result = graph.invoke({"messages": [HumanMessage("which loan applications are pending?")]})
        tool_messages = [m for m in result["messages"] if isinstance(m, ToolMessage)]

        assert [m.name for m in tool_messages] == [SELECT, TOOL]
        assert seen == [{"status": "pending"}]
        assert "LN-2291" in result["messages"][-1].content


class TestAsk:
    """`ask.py`'s offline halves: the sign-in it asks for and the transcript it prints."""

    def test_sign_in_is_pkce_on_loopback_for_an_email(self) -> None:
        import urllib.parse

        import ask

        url = ask.authorize_url("https://bank.example", "web-client-test", "challenge", "state-1")
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        assert url.startswith("https://bank.example/oauth2/authorize?")
        assert query["redirect_uri"] == ["http://127.0.0.1:8765/callback"]
        assert query["code_challenge_method"] == ["S256"]
        # identity.py reads the caller from the `email` claim, so the scope has to ask for it.
        assert query["scope"] == ["openid email"]

    def test_the_transcript_shows_calls_results_and_the_answer(self) -> None:
        import ask

        result = {"messages": [
            {"type": "human", "content": "pending?"},
            {"type": "ai", "content": "", "tool_calls": [{"name": "LoanDesk_SearchLoans", "args": {"status": "pending"}}]},
            {"type": "tool", "name": "LoanDesk_SearchLoans", "content": "LN-2291"},
            {"type": "ai", "content": "One pending: LN-2291."},
        ]}
        assert ask.transcript(result) == [
            '→ LoanDesk_SearchLoans {"status": "pending"}',
            "← LoanDesk_SearchLoans: LN-2291",
            "One pending: LN-2291.",
        ]
