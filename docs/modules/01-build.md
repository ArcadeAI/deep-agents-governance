# Module 1 — Build the agent (LangChain Deep Agents)

**Start from:** `git checkout start`. **Owner:** LangChain. **45 minutes.**

You leave this module with a Deep Agent running on your laptop under `mda dev`, reaching
an Arcade gateway that carries the loan desk's six tools plus Gmail and Slack, having
asked it one real question as yourself and read the tool calls it made.

## Before the workshop

Four things, each one signup, all with the **same email**:

- An [Arcade](https://api.arcade.dev/dashboard) account and one project in it, with an API key. The project is yours; everything the
  workshop registers lands there.
- The Slack invite the host sent, to the workshop workspace. Accept it with the same email. The escalation in
  module 2 is sent from your own Slack account, so you have to be in the workspace.
- An [ngrok](https://ngrok.com) account and its free static domain. Arcade reaches your laptop through it.
- A LangSmith workspace with Managed Deep Agents beta access, and its API key.

No model key is needed to start: the agent runs a scripted model until you give it one. The
host shares a model key in the room for module 2.

## What you build

1. Install and configure: the README's Quickstart steps 1 to 3. Two values in `.env`:
   `ARCADE_API_KEY` and `APP_PUBLIC_HOST`. A third for the room:
   `SLACK_APPROVALS_CHANNEL=C0C83CW2CDN`, the workspace's `#deal-desk-approvals`, so every approval
   request you raise in module 2 is posted where everyone sees it.
2. Register with Arcade: `bun run setup-arcade <APP_PUBLIC_HOST>`. It runs one `arcade deploy`
   (`mcp`: the Loans and Approvals tools together), mints the OAuth clients, registers the identity provider and the hooks, and
   creates the gateway with the six loan desk tools and Arcade's Gmail and Slack. Read what it prints; every name it reports is a name a rule is
   keyed on later.
3. Add yourself: `bun run users add <your-email> --name Alice --role loan_officer --clearance 50000`.
4. Set up the agent: `cd agent`, `cp .env.example .env`, fill it in from the root `.env` and
   your LangSmith key, `uv sync`, then `uv run mda dev .`.
5. Ask it, from a second terminal in `agent`:

       uv run --env-file .env python ask.py "Which loan applications are pending?"

   Sign in as Alice in the browser it opens. The scripted model selects the search tool and
   calls `LoanDesk_SearchLoans`. The first time, the result is a link to authorize the app's
   own provider: open it, allow it, ask again, and the eight requests come back.

## What to look at

- `agent/agent.py`: the whole agent is `define_deep_agent` plus one middleware. No tools are
  listed in code; they come from the gateway.
- `agent/identity.py`: MDA accepts only the app's own ID tokens, and the `email` claim is who
  every tool call runs as.
- `agent/instructions.md`: what the agent is told. It describes the tools and carries no
  limits; read [`docs/agent.md`](../agent.md) for why.
- `agent/ask.py`: the sign-in, the one request to the agent, and the transcript.

## Checkpoint

You can name the six loan desk tools on the wire (`LoanDesk_SearchLoans`, `LoanDesk_GetLoan`,
`LoanDesk_ApproveLoan`, `LoanDesk_DenyLoan`, `LoanDesk_RequestApproval`,
`LoanDesk_Decide`), and you have seen one of them called as you, in `ask.py`'s transcript and
on `/panel`.

## If you are behind

Nothing in this module changes the code. `git checkout start` is the whole state; the work
is the Arcade registration and the agent's `.env`, and `bun run setup-arcade` is idempotent,
so run it again.
