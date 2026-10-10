# Module 5 — The same governance from an MCP client (optional)

**Start from:** modules 1 and 2 done, `bun run dev` and the tunnel up. **Owner:** Arcade. **15 minutes.**

You leave with Claude Code calling the loan desk's tools as yourself, through an Arcade
MCP gateway, and the same hooks refusing the same call they refused the agent. Nothing in
the agent changes: it still calls the Engine directly with the project key, and it never
reads `ARCADE_GATEWAY_ID`.

## What you build

1. Register the gateway. Run `setup-arcade` once more, with the flag:

       bun run setup-arcade <APP_PUBLIC_HOST> --gateway

   It finds everything from step 4 already in place, then registers two more things and
   reads each back: a User Source for your Okta app, through Arcade's Coordinator API, and
   an MCP gateway through it with the nine tools (`LoanDesk` ×6, Gmail ×2, Slack ×1). It
   writes the gateway's slug to `.env` as `ARCADE_GATEWAY_ID` and prints the gateway's URL,
   `https://api.arcade.dev/mcp/<slug>`. The slug defaults to `loan-desk-<first label of your
   host>`; slugs are unique across Arcade, so if yours is taken, run it with
   `--gateway=<another-slug>`. `--dry-run --gateway` prints the requests first.
2. Restart `bun run dev`, so the app reads the new `.env`. The home page's assistant column
   now shows **Connect your MCP client**, with the command to copy.
3. Connect Claude Code:

       claude mcp add --transport http loan-desk https://api.arcade.dev/mcp/<slug>

   In Claude Code, run `/mcp`, pick `loan-desk`, and sign in. The sign-in page is your Okta
   org's, because the gateway authenticates through the User Source: you are yourself
   there, by the same email the hooks govern. Cursor and any other MCP client that speaks
   streamable HTTP with OAuth work the same way; Claude Code is what the room uses.
4. Ask it, as Alice: *"Approve loan LN-2291 for 95000."* Claude Code calls
   `LoanDesk_ApproveLoan` through the gateway, `/hooks/pre` refuses it with the same
   sentence the agent got, naming `LoanDesk_RequestApproval` and a `[ref evt_…]`, and the
   card appears on `/panel`. Ask as Bob, in a Claude Code signed in as him, and
   `LoanDesk_ApproveLoan` is not in `/mcp`'s tool list at all.

## What to look at

- `scripts/setup-arcade.ts`, section 8, and `scripts/setup-arcade/coordinator.ts`: the
  User Source is found by issuer and client or created, never edited; the gateway is found
  by slug and held to that User Source, never to Arcade Headers.
- `auth-config/user-source.json` and `auth-config/gateway.json`: the same two bodies, for
  the dashboard.
- `components/identity/McpClientPanel.tsx`: the one surface that reads `ARCADE_GATEWAY_ID`,
  and `agent/agent.py`, which removes it from the environment on purpose.
- `/health`: `gateway: configured` once the variable is set, and nothing about it before.

## Checkpoint

Claude Code refused on the same rule as the agent, with its own card on `/panel`.

## If you are behind

Skip it. Nothing later depends on the gateway, and `setup-arcade` without the flag leaves
a gateway already in `.env` as it is, with a note.
