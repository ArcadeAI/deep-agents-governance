# Connecting agents to business systems with just-in-time authorization

**9:45 to 10:30. Owner: Arcade.** Who the agent is when it calls a tool, and how it gets
permission at the moment it needs it.

You leave knowing what the workshop facilitators' `setup-arcade` registered and why each piece is there,
having authorized a provider as yourself at the moment a tool first needed it, and having
watched Bob, who has no approval authority, never see the approval tool at all.

## What you build

1. Read the registration back. The facilitators show `bun run setup-arcade <APP_PUBLIC_HOST>
   --dry-run`, which prints every request it sent in the setup block: the `app-identity` auth
   provider that signs in through the room's Okta app, the tool secrets, the custom verifier,
   the hooks, and the one `arcade deploy`. `auth-config/` holds the same bodies as JSON, and
   you can read them in your clone.
2. Act as Alice. Ask the agent: *"Read LN-2291 and tell me the borrower."* No authorization
   link this time: Arcade already holds Alice's grant at the loan API from the first run in
   [`01-build.md`](./01-build.md), and because the room shares her sign-in, one grant covers
   everyone. The loan API saw Alice's own token and recorded Alice as the actor, not a
   service account. Running this yourself after the day, the first loan desk call is where
   that link appears.
3. Now as yourself, for Slack and Gmail. This is the authorization you see with your own eyes. In the room the Okta sign-in is shared: you
   are one of four Alices. Your Gmail and Slack are not. Run `ask.py` with your own address,

       uv run --env-file .env python ask.py --as <your email> "Email me the summary of LN-2291"

   and the loan desk call runs as Alice while the Gmail call runs as you. The first Gmail or
   Slack call returns an authorization link; it is Arcade's own verifier this time, so open it
   signed in to Arcade as that address. Each provider asks once, at the first call, and never
   again. Nothing in the agent's code names a token. Two things make this work, both done by
   the facilitators before the room: your address is a member of the room's Arcade project, and it is
   a subject in the control plane, `bun run users add <your email> --name <you> --role
   loan_officer --clearance 50000 --no-identity`, so the hooks know who is sending. With
   `CONNECTED_APPS_USER` in `agent/.env` from setup, `--as` is already implied.
4. Bring your own system. The loan desk is `mcp/loan_desk/`: `loans.py` is a stateless client
   of the loan REST API in `api/`, and `approvals.py` carries the escalation tools. The API
   knows nothing about Arcade. `arcade deploy` from `mcp` is what put the six `LoanDesk_*`
   tools in the room's project; swapping the API behind it is [`docs/DOMAIN-SWAP.md`](../DOMAIN-SWAP.md).
5. Be Bob. The facilitators added him, a credit analyst with no clearance, and handed out his
   sign-in with Alice's. Run `ask.py`, sign in as Bob and ask him to approve the loan.
   `LoanDesk_ApproveLoan` is not in his tool list. Nothing was refused; the tool was never
   offered. That is the access hook, the first of the four acts, and the rest are the next
   block. Every `ask.py` run asks for a sign-in, so being Alice again is the next run.

## What to look at

- `agent/agent.py`: the middleware passes the signed-in email to Arcade as `user_id` on every
  loan desk call, and the `--as` address on Gmail and Slack, so every authorization and every
  hook sees a person, never the agent. The loan desk cannot take the `--as` address: its grant
  is confirmed by the app's verifier as whoever is signed in to the app.
- `auth/oidc.ts` and `api/actor.ts`: the app and the loan API are ordinary OIDC clients of the
  room's Okta org. The actor comes from the token, never from a parameter.
- `mcp/loan_desk/app.py`: one MCP server, one toolkit, every tool the agent calls on the bank.
- `/panel`, Access lane: Bob's tool list, with `ApproveLoan` removed before his agent ran.

## Checkpoint

Gmail and Slack authorized as you, the loan desk running as Alice on the room's shared grant,
and Bob's agent with no approval tool.

## If you are behind

Still `git checkout start`. The authorizations are Arcade state and survive restarts. If a
sign-in page refuses you, check the password against the facilitators' handout, not your `.env`.
