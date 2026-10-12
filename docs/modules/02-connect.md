# Connecting agents to business systems with just-in-time authorization

**9:45 to 10:30. Owner: Arcade.** Who the agent is when it calls a tool, and how it gets
permission at the moment it needs it.

You leave knowing what `setup-arcade` registered and why each piece is there, having
authorized a provider as yourself at the moment a tool first needed it, and having watched
Bob, who has no approval authority, never see the approval tool at all.

## What you build

1. Read the registration back. `bun run setup-arcade <APP_PUBLIC_HOST> --dry-run` prints every
   request it sent in the setup block: the `app-identity` auth provider that signs in through
   your Okta app, the tool secrets, the custom verifier, the hooks, and the one
   `arcade deploy`. `auth-config/` holds the same bodies as JSON.
2. Act as you. Ask the agent, as Alice: *"Read LN-2291 and tell me the borrower."* The first
   loan desk call returns an authorization link instead of a result: Arcade has no token for
   you at the loan API yet. Open it, sign in at your Okta org, allow it, ask again. The loan
   API saw Alice's own token and recorded Alice as the actor, not a service account.
3. Do it again for Slack and Gmail. Ask the agent to DM you the summary, then to email it to
   you. Each is Arcade's built-in provider; each asks you once, at the first call, and never
   again. Nothing in the agent's code names a token.
4. Bring your own system. The loan desk is `mcp/loan_desk/`: `loans.py` is a stateless client
   of the loan REST API in `api/`, and `approvals.py` carries the escalation tools. The API
   knows nothing about Arcade. `arcade deploy` from `mcp` is what put the six `LoanDesk_*`
   tools in your project; swapping the API behind it is [`docs/DOMAIN-SWAP.md`](../DOMAIN-SWAP.md).
5. Add Bob, with the `op run` prefix from setup:

       bun run users add bob@example.com --name Bob --role credit_analyst

   Run `ask.py`, sign in as Bob and ask him to approve the loan. `LoanDesk_ApproveLoan` is not
   in his tool list. Nothing was refused; the tool was never offered. That is the access hook,
   the first of the four acts, and the rest are the next block.

## What to look at

- `agent/agent.py`: the middleware passes the signed-in email to Arcade as `user_id` on every
  call, so every authorization and every hook sees the person, never the agent.
- `auth/oidc.ts` and `api/actor.ts`: the app and the loan API are ordinary OIDC clients of your
  Okta org. The actor comes from the token, never from a parameter.
- `mcp/loan_desk/app.py`: one MCP server, one toolkit, every tool the agent calls on the bank.
- `/panel`, Access lane: Bob's tool list, with `ApproveLoan` removed before his agent ran.

## Checkpoint

Three providers authorized as yourself, and Bob's agent with no approval tool.

## If you are behind

Still `git checkout start`. The authorizations are Arcade state and survive restarts; the
Okta user survives too.
