"""The agent's wiring, its caller identity, and one scripted run, all offline."""

from types import SimpleNamespace
from typing import Any

import pytest
from deepagents import create_deep_agent
from langchain_core.messages import HumanMessage, ToolMessage

import agent as loan_desk
import identity as loan_desk_identity
import oidc
from conftest import DISCOVERY, ISSUER, discovery_requests
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


def runtime_with_config(user: Any, configurable: dict[str, Any] | None) -> SimpleNamespace:
    """A tool runtime: the verified caller, and the run's `config.configurable`."""
    runtime = runtime_for(user)
    runtime.config = {"configurable": configurable} if configurable is not None else {}
    return runtime


class FakeTools:
    """Records every `tools.execute` the provider sends, and answers each with a value."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def execute(self, **kwargs: Any) -> SimpleNamespace:
        self.calls.append(kwargs)
        return SimpleNamespace(success=True, output=SimpleNamespace(value={"ok": True}), status="success")


def split_provider() -> tuple[loan_desk.SplitIdentityProvider, FakeTools]:
    tools = FakeTools()
    client = SimpleNamespace(tools=tools)
    return loan_desk.SplitIdentityProvider(client=client, user_id_resolver=loan_desk.signed_in_user), tools


class TestConnectedAppsUser:
    """Gmail and Slack as the caller's own address; the loan desk as the persona."""

    def test_the_address_comes_from_the_runs_configurable_lowercased(self) -> None:
        runtime = runtime_with_config("alice@bank.example", {"connected_apps_user": " Dana@Example.com "})
        assert loan_desk.connected_apps_user(runtime) == "dana@example.com"

    @pytest.mark.parametrize("configurable", [None, {}, {"connected_apps_user": ""}, {"connected_apps_user": "dana"}, {"connected_apps_user": 7}])
    def test_anything_but_an_email_is_ignored(self, configurable: dict[str, Any] | None) -> None:
        assert loan_desk.connected_apps_user(runtime_with_config("alice@bank.example", configurable)) is None

    def test_the_toolkit_is_read_off_either_spelling(self) -> None:
        assert loan_desk.toolkit_of("LoanDesk.SearchLoans@1.0.0") == "LoanDesk"
        assert loan_desk.toolkit_of("LoanDesk_SearchLoans") == "LoanDesk"
        assert loan_desk.toolkit_of("Gmail.SendEmail@3.0.0") == "Gmail"

    def test_loan_desk_runs_as_the_persona_and_gmail_as_the_caller(self) -> None:
        provider, tools = split_provider()
        bound = provider.bind(runtime_with_config("alice@bank.example", {"connected_apps_user": "dana@example.com"}))

        bound.execute("LoanDesk.SearchLoans@1.0.0", {"status": "pending"})
        bound.execute("Gmail.SendEmail@3.0.0", {"to": "x@example.com"})
        bound.execute("Slack.SendMessage@1.0.0", {"text": "hi"})

        assert [call["user_id"] for call in tools.calls] == ["alice@bank.example", "dana@example.com", "dana@example.com"]
        # The bound provider itself still answers as the persona: discovery is hers.
        assert bound.user_id == "alice@bank.example"

    def test_without_an_own_address_everything_is_the_persona(self) -> None:
        provider, tools = split_provider()
        bound = provider.bind(runtime_with_config("alice@bank.example", None))
        bound.execute("Gmail.SendEmail@3.0.0", {})
        assert [call["user_id"] for call in tools.calls] == ["alice@bank.example"]

    def test_an_own_address_never_substitutes_for_a_missing_sign_in(self) -> None:
        # No verified persona: the run is refused, whatever it asserts about itself.
        provider, tools = split_provider()
        bound = provider.bind(runtime_with_config(None, {"connected_apps_user": "dana@example.com"}))
        outcome = bound.execute("Gmail.SendEmail@3.0.0", {})
        assert outcome.success is False
        assert tools.calls == []

    def test_the_loan_desk_toolkit_follows_arcade_toolkit(self) -> None:
        assert loan_desk.LOAN_DESK_TOOLKIT == "LoanDesk"


class TestWiring:
    def test_the_agent_is_named_and_carries_the_arcade_middleware(self) -> None:
        config = loan_desk.agent.config
        assert config["name"] == "loan-desk"
        assert [type(m) for m in config["middleware"]] == [ArcadeMiddleware]

    def test_selection_is_not_scoped_to_a_gateway_even_when_one_is_left_in_the_env(self) -> None:
        # conftest sets ARCADE_GATEWAY_ID the way an older .env would; the provider ignores it.
        assert loan_desk.provider._gateway_id is None

    def test_the_model_is_scripted_without_model_id(self) -> None:
        assert isinstance(loan_desk.agent.config["model"], ScriptedModel)


class TestIdentity:
    def test_callers_are_verified_against_the_keys_the_issuers_discovery_names(self) -> None:
        (provider,) = loan_desk_identity.identity.config["ingress"]["http"]["providers"]
        # IDP_ISSUER, its trailing slash dropped, and the key set from its discovery document.
        assert provider["issuer"] == ISSUER
        assert provider["jwks"] == f"{ISSUER}/v1/keys"
        assert provider["audience"] == "0oa-okta-app-test"
        # Okta signs ID tokens with RS256; EdDSA would fail at verification.
        assert provider["algorithms"] == ["RS256"]
        assert provider["claims"]["user"] == "email"

    def test_loan_desk_issuer_is_still_read_when_idp_issuer_is_blank(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IDP_ISSUER", "")
        monkeypatch.setenv("LOAN_DESK_ISSUER", "https://older.example/")
        assert oidc.issuer() == "https://older.example"
        monkeypatch.setenv("IDP_ISSUER", f"{ISSUER}/")
        assert oidc.issuer() == ISSUER

    def test_no_issuer_stops_by_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IDP_ISSUER", "")
        monkeypatch.delenv("LOAN_DESK_ISSUER", raising=False)
        with pytest.raises(RuntimeError, match="IDP_ISSUER is not set"):
            oidc.issuer()

    def test_discovery_is_read_once_and_must_name_its_own_issuer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        oidc.discover.cache_clear()
        before = len(discovery_requests)
        oidc.discover(ISSUER)
        oidc.discover(ISSUER)
        assert len(discovery_requests) - before == 1
        oidc.discover.cache_clear()
        monkeypatch.setitem(DISCOVERY, "issuer", "https://somebody-else.example")
        with pytest.raises(RuntimeError, match="names the issuer 'https://somebody-else.example'"):
            oidc.discover(ISSUER)
        oidc.discover.cache_clear()

    def test_a_missing_value_stops_the_import_by_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("IDP_CLIENT_ID")
        with pytest.raises(RuntimeError, match="IDP_CLIENT_ID is not set"):
            loan_desk_identity.required("IDP_CLIENT_ID")


LISTED_LOAN_DESK = {
    "items": [
        {
            "fully_qualified_name": "LoanDesk.SearchLoans@1.0.0",
            "qualified_name": "LoanDesk.SearchLoans",
            "name": "SearchLoans",
            "description": "Loan applications by status.",
            "toolkit": {"name": "LoanDesk", "version": "1.0.0"},
            "input": {"parameters": [{"name": "status", "required": False, "value_schema": {"val_type": "string"}}]},
            "requirements": {"authorization": {"provider_id": "loan-desk"}},
        },
        {
            "fully_qualified_name": "LoanDesk.ApproveLoan@1.0.0",
            "qualified_name": "LoanDesk.ApproveLoan",
            "name": "ApproveLoan",
            "description": "Approve one.",
            "toolkit": {"name": "LoanDesk", "version": "1.0.0"},
            "input": {"parameters": []},
        },
    ]
}
RECOMMENDED = {
    "query_id": "q1",
    "results": [
        {
            "task": "pending loans",
            "suggestions": [
                {"tool_name": "Ashby.ListApplications", "version": "1.0.0", "description": "Hiring."},
                {"tool_name": "LoanDesk.SearchLoans", "version": "1.0.0", "description": "Loan applications by status."},
            ],
        }
    ],
}


class ListingClient:
    """A client whose tool list is the loan desk and whose selector answers as told."""

    def __init__(self, listed: Any = LISTED_LOAN_DESK, selected: Any = RECOMMENDED) -> None:
        self.listed, self.selected, self.tools = listed, selected, FakeTools()
        self.gets: list[dict[str, Any]] = []

    def get(self, path: str, *, options: dict[str, Any], cast_to: Any) -> Any:
        self.gets.append({"path": path, **options})
        if isinstance(self.listed, Exception):
            raise self.listed
        return self.listed

    def post(self, path: str, *, body: dict[str, Any], cast_to: Any) -> Any:
        if isinstance(self.selected, Exception):
            raise self.selected
        return self.selected


class TestLoanDeskIsPinned:
    """Selection starts with the loan desk as the project lists it, whatever Tool Rec says."""

    def test_the_loan_desk_comes_first_and_is_not_repeated(self) -> None:
        client = ListingClient()
        provider = loan_desk.SplitIdentityProvider(client=client, user_id_resolver=loan_desk.signed_in_user)
        names = [t.name for t in provider.select(["pending loans"])]
        assert names == ["LoanDesk_SearchLoans", "LoanDesk_ApproveLoan", "Ashby_ListApplications"]
        assert client.gets == [{"path": "/v1/tools", "params": {"toolkit": "LoanDesk", "limit": 100}}]

    def test_the_listed_schema_is_translated(self) -> None:
        provider = loan_desk.SplitIdentityProvider(client=ListingClient(), user_id_resolver=loan_desk.signed_in_user)
        search = provider.loan_desk_tools()[0]
        assert search.fqn == "LoanDesk.SearchLoans@1.0.0"
        assert search.input_schema["properties"]["status"]["type"] == "string"
        assert search.requires_auth is True

    def test_a_selector_outage_still_leaves_the_loan_desk(self) -> None:
        client = ListingClient(selected=RuntimeError("503"))
        provider = loan_desk.SplitIdentityProvider(client=client, user_id_resolver=loan_desk.signed_in_user)
        assert [t.name for t in provider.select(["pending loans"])] == ["LoanDesk_SearchLoans", "LoanDesk_ApproveLoan"]

    def test_with_nothing_listed_the_selector_decides_and_its_outage_is_still_one(self) -> None:
        from langchain_arcade.provider import DiscoveryUnavailableError

        quiet = loan_desk.SplitIdentityProvider(client=ListingClient(listed={"items": []}), user_id_resolver=loan_desk.signed_in_user)
        assert [t.name for t in quiet.select(["pending loans"])] == ["Ashby_ListApplications", "LoanDesk_SearchLoans"]
        down = loan_desk.SplitIdentityProvider(client=ListingClient(listed=RuntimeError("no"), selected=RuntimeError("503")), user_id_resolver=loan_desk.signed_in_user)
        with pytest.raises(DiscoveryUnavailableError):
            down.select(["pending loans"])


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

        url = ask.authorize_url(DISCOVERY["authorization_endpoint"], "0oa-okta-app-test", "challenge", "state-1")
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        assert url.startswith(f"{ISSUER}/v1/authorize?")
        assert query["redirect_uri"] == ["http://127.0.0.1:8765/callback"]
        assert query["code_challenge_method"] == ["S256"]
        assert query["prompt"] == ["login"]
        # identity.py reads the caller from the `email` claim, so the scope has to ask for it.
        assert query["scope"] == ["openid email"]

    def test_a_kept_sign_in_is_reused_until_it_expires_and_only_by_its_owner(self, tmp_path) -> None:
        import base64
        import json
        import stat

        import ask

        def jwt(exp: int) -> str:
            payload = base64.urlsafe_b64encode(json.dumps({"email": "alice@acme.com", "exp": exp}).encode()).rstrip(b"=")
            return "eyJhbGciOiJub25lIn0." + payload.decode() + ".sig"

        path = tmp_path / "session.json"
        assert ask.saved_session(path, now=1000.0) is None  # nothing kept yet
        ask.keep_session(path, jwt(exp=5000))
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert ask.claims(ask.saved_session(path, now=1000.0))["email"] == "alice@acme.com"
        assert ask.saved_session(path, now=4970.0) is None  # inside the minute before expiry
        path.write_text("not json")
        assert ask.saved_session(path, now=1000.0) is None  # a damaged file means sign in again

    def test_the_session_file_is_one_per_issuer_and_app(self, tmp_path, monkeypatch) -> None:
        import ask

        monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
        one = ask.session_path("https://a.okta.com/oauth2/default", "0oa-one")
        assert one.parent == tmp_path / "loan-desk-ask"
        assert one != ask.session_path("https://a.okta.com/oauth2/default", "0oa-two")
        assert one == ask.session_path("https://a.okta.com/oauth2/default", "0oa-one")

    def test_the_run_carries_the_own_address_only_when_given(self) -> None:
        import ask

        plain = ask.run_body("pending?")
        assert "config" not in plain
        assert plain["input"]["messages"] == [{"role": "user", "content": "pending?"}]
        own = ask.run_body("pending?", "dana@example.com")
        assert own["config"] == {"configurable": {"connected_apps_user": "dana@example.com"}}

    def test_a_failed_run_is_named_not_silent(self) -> None:
        """`/runs/wait` answers a crashed run with `__error__` and no messages; the user must hear why."""
        import ask

        failed = {"__error__": {"error": "ValueError", "message": "MODEL_ID names no provider"}}
        assert ask.failure(failed) == "ValueError: MODEL_ID names no provider"
        assert ask.transcript(failed) == []
        assert ask.failure({"messages": []}) is None

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
