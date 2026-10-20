# Governing agent actions with policy hooks and human approval

**10:45 to 11:30. Owner: Arcade.**

This block runs in the attendee portal at https://arcadeworkshop.dev. Sign in there with your email and the workshop code from your welcome mail; the portal provisions your own Arcade project, identity, loan book and policy, and walks you through the steps below. This page predates the portal and only says where its content went.

## In the portal

- **Turn on contextual access**: your own tenant, and the extension with three hooks wired into your project.
- **Set your policies**: the Loan Desk policy, where approval requests go, and the requests as they land.
- **End to end**: one request, three tools: approve the $15,500 loan, tell the room, mail the borrower.
- **Make it safer**: ask for the $95,000 approval, and your own policy refuses it, routes it to a human and logs every step.

Loan ids are per attendee: your two-digit seat number, then the last two digits of the loan's id, so LN-2291 reads LN-1491 in seat 14. The borrowers and amounts are the same for everyone.

## Take it home: the same governance from an MCP client

Optional, after the workshop, on your own build from the README's Quickstart. Claude Code calls the loan desk's tools as
yourself through an Arcade MCP gateway, and the same hooks refuse the same call they refused
the agent. Nothing in the agent changes: it still calls the Engine directly with the project
key, and it never reads `ARCADE_GATEWAY_ID`.

1. Register the gateway: `bun run setup-arcade <APP_PUBLIC_HOST> --gateway`. It finds the
   setup block already in place, then registers a User Source for your Okta app through
   Arcade's Coordinator API and an MCP gateway through it with the nine tools (`LoanDesk` ×6,
   Gmail ×2, Slack ×1), writes the slug to `.env` as `ARCADE_GATEWAY_ID` and prints
   `https://api.arcade.dev/mcp/<slug>`. Slugs are unique across Arcade; if yours is taken, run
   it with `--gateway=<another-slug>`.
2. Restart `bun run dev`. The home page's assistant column now shows **Connect your MCP
   client**, with the command to copy.
3. Connect Claude Code:

       claude mcp add --transport http loan-desk https://api.arcade.dev/mcp/<slug>

   Run `/mcp`, pick `loan-desk`, and sign in. The sign-in page is the Okta org's, because the
   gateway authenticates through the User Source: you are yourself there, by the same email the
   hooks govern.
4. Ask it, as Alice: *"Approve loan LN-2291 for 95000."* Claude Code calls
   `LoanDesk_ApproveLoan` through the gateway, `/hooks/pre` refuses it with the same sentence
   the agent got, and the card appears on `/panel`.

`scripts/setup-arcade.ts` section 8 and `scripts/setup-arcade/coordinator.ts` register the two;
`auth-config/user-source.json` and `auth-config/gateway.json` are the same bodies for the
dashboard; `components/identity/McpClientPanel.tsx` is the one surface that reads
`ARCADE_GATEWAY_ID`. `setup-arcade` without the flag leaves a gateway already in `.env` as it
is, with a note.

