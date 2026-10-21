# The loan desk agent

A LangChain Deep Agent that runs on Managed Deep Agents (MDA) and calls the Arcade Engine
directly with the project key, as the signed-in person. There is no gateway. It is a
directory, the way MDA wants it:

| File | What it is |
| --- | --- |
| `agent.py` | The agent: `define_deep_agent` with Arcade's middleware, nothing else. |
| `identity.py` | Who may call it: an ID token from the loan desk's identity provider (Okta). |
| `oidc.py` | The identity provider's endpoints, read from its discovery document. |
| `instructions.md` | The system prompt. It describes the tools and carries no limits. |
| `scripted.py` | A model that needs no key, for a first run and for the tests. |
| `ask.py` | Signs you in to the app and asks the agent a question from a terminal. |
| `langchain_arcade/` | Arcade's LangChain middleware, vendored (MIT, see its `LICENSE`). |
| `tests/` | `uv run --group dev pytest`, offline, no keys. CI runs them. |
| `evals/` | Module 04: the dataset, the evaluators, the in-process target and the notebook. [`docs/modules/04-observe.md`](../docs/modules/04-observe.md). |
| `skills/` | Skills the agent reads at `/skills/`, one directory with a `SKILL.md` each. Module 01 adds the first. |

## Run it

```sh
cp .env.example .env    # then fill it in; the file says where each value comes from
uv sync
uv run mda dev . --no-browser   # Studio cannot sign in with the workshop identity provider, so don't open it
```

In another terminal, from this directory:

```sh
uv run --env-file .env python ask.py "Which loan applications are pending?"
```

`ask.py` opens Okta's sign-in page, catches the redirect on
`http://127.0.0.1:8765/callback` (which `bun run okta-setup` allowlists on the Okta app),
trades the code for an ID token and sends the question with it. It prints each tool
call, each tool result and the answer. `--agent <url>` sends it somewhere other than the local
server; `AGENT_URL` in `.env` does the same.

```sh
uv run --env-file .env python ask.py --as you@example.com "Email me the summary of LN-2291"
```

`--as` (or `CONNECTED_APPS_USER` in `.env`) is for a room where everyone signs in to Okta
as the same Alice: the loan desk still runs as Alice, and Gmail and Slack run as you.

## Who the caller is

`identity.py` tells MDA to accept only an ID token Okta signed for the loan desk: issuer
`IDP_ISSUER`, keys at the `jwks_uri` its discovery document names, audience `IDP_CLIENT_ID`,
RS256. (`LOAN_DESK_ISSUER`, the name before Okta, is still read when `IDP_ISSUER` is blank.) The
token's `email` claim becomes the caller, the **persona**. The middleware reads it from the run
and passes it to Arcade as the user id on every loan desk call and on discovery, so the hooks
see the person, never the agent. No token, or a token from anywhere else, and MDA answers 401
before the agent runs.

## Two identities when the sign-in is shared

`agent.py`'s `SplitIdentityProvider` runs the `LoanDesk` tools as the persona and every other
tool, Gmail and Slack, as the address the run names in
`config.configurable.connected_apps_user`, which `ask.py --as` sets. With no such address,
everything is the persona. The loan desk cannot be split this way: Arcade's grant for the loan
API is confirmed by the app's custom verifier as whoever is signed in to the app, and a
different address answers `user_mismatch`. Gmail and Slack go through Arcade's own verifier,
which binds the grant to the Arcade account that opens the link, so the `--as` address must be
that account's email, invited to the project, and a registered subject (`bun run users add
<email> ... --no-identity`) so the hooks know it. An address with no verified sign-in behind it
is never used: the run is refused first.

## Which model

With `MODEL_ID` unset the agent runs `ScriptedModel`: it selects the loan desk's search tool,
calls `LoanDesk_SearchLoans` for pending requests and answers with what came back. That is
enough to prove the sign-in and the hooks with no model key.

## Tool Rec is unscoped, the loan desk is pinned

With no gateway, Tool Rec searches the whole catalog, not just the loan desk. It may offer
catalog tools such as Ashby or ClickUp alongside Gmail and Slack. The project's hooks still
govern every call the agent makes, so nothing here relies on search to hide a tool: a tool
the hooks refuse is refused when it is called, whoever found it.

The six LoanDesk tools never depend on Tool Rec. Arcade indexes a newly deployed server's
tools in the background, and until then a loan question would get payment or hiring tools
instead; so every selection starts with the loan desk toolkit as the project lists it
(`GET /v1/tools?toolkit=LoanDesk`), and Tool Rec adds the rest. `ARCADE_TOOLKIT` renames the
pinned toolkit.

For a real model:

```sh
uv sync --extra anthropic
```

then set `MODEL_ID=anthropic:claude-sonnet-5-5` and `ANTHROPIC_API_KEY` in `.env`. Any
provider `init_chat_model` knows works the same way, with that provider's package and key.
With no provider key, set `LANGSMITH_GATEWAY=true` and `LANGSMITH_GATEWAY_API_KEY` to a
LangSmith key whose workspace holds the provider key as a secret: the call goes through the
LangSmith LLM Gateway, and the spend lands on that workspace (`.env.example`).

## When a tool needs authorizing

The first loan desk call, and the first Gmail or Slack call, need the caller to authorize
that provider in Arcade. The middleware returns the authorization link as the tool's result,
the model passes it on, and `ask.py` prints it. Open it, allow it, and ask again. The loan
desk link is confirmed as whoever is signed in to the app in that browser; the Gmail and Slack
links as the Arcade account signed in there, which must be the `--as` address.

## Deploy it

```sh
uv run mda deploy .
```

It reads the same `.env`. Point `ask.py` at the deployment with `--agent <deployment URL>`.
MDA is in beta and runs on LangSmith's US cloud only.
