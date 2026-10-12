# Building and deploying agents with Deep Agents and LangSmith

**9:15 to 9:45. Owner: LangChain.** The agent development lifecycle: build, test, deploy.

You leave with a Deep Agent running on your laptop under `mda dev`, calling Arcade's Engine
directly for the loan desk's six tools plus Gmail and Slack, having asked it one real question
as yourself and read the tool calls it made, and a copy of it deployed on Managed Deep Agents.

## What you build

1. Set up the agent: `cd agent`, `cp .env.example .env`, fill it in from the root `.env` and
   your LangSmith key, then `uv sync`.
2. Serve it locally: `uv run mda dev .`.
3. Ask it, from a second terminal in `agent`:

       uv run --env-file .env python ask.py "Which loan applications are pending?"

   Sign in as Alice in the browser it opens. The scripted model selects the search tool and
   calls `LoanDesk_SearchLoans`. The first time, the result is a link to authorize the app's
   own provider: open it, allow it, ask again, and the eight requests come back.
4. Give it a real model: set `MODEL_ID` and the room's model key in `agent/.env`
   (`agent/README.md`), restart `mda dev`, and ask the same question again.
5. Deploy it: `uv run mda deploy .`. Point `ask.py` at the deployment with
   `--agent <deployment URL>` and ask once more. The trace is in LangSmith; you come back to it
   in [`04-observe.md`](./04-observe.md).

## What to look at

- `agent/agent.py`: the whole agent is `define_deep_agent` plus one middleware. No tools are
  listed in code; Tool Rec finds them in the project's catalog, which is not scoped to the
  loan desk, so it may offer an unrelated tool too. The hooks govern every call either way.
- `agent/identity.py`: MDA accepts only ID tokens your Okta org issued for the app, and the
  `email` claim is who every tool call runs as.
- `agent/instructions.md`: what the agent is told. It describes the tools and carries no
  limits; read [`docs/agent.md`](../agent.md) for why.
- `agent/ask.py`: the sign-in, the one request to the agent, and the transcript.

## Checkpoint

You can name the six loan desk tools on the wire (`LoanDesk_SearchLoans`, `LoanDesk_GetLoan`,
`LoanDesk_ApproveLoan`, `LoanDesk_DenyLoan`, `LoanDesk_RequestApproval`,
`LoanDesk_Decide`), and you have seen one of them called as you, in `ask.py`'s transcript and
on `/panel`.

## If you are behind

Nothing in this module changes the code. The work is `agent/.env`; `mda dev` reads it fresh on
each start.
