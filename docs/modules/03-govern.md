# Governing agent actions with policy hooks and human approval

**10:45 to 11:30. Owner: Arcade.** Acts 2 to 4: a refusal the model cannot argue with, a
human in the loop, and data the model never sees.

You leave with the four acts run from your agent against the room's deployment: a loan
officer asks for a $95K loan and "double-check your work", four things go wrong, and the
control plane catches all four while the model never gets a vote. The agent needs its real model from
[`01-build.md`](./01-build.md).

## What you build

1. Meet the rest of the cast. The host seeded it on the room's deployment: Charlie, the VP
   Credit at $250,000, and Michael, the chief credit officer at $5,000,000. Charlie's email is
   the one thing that has to be real, because the escalation finds the approver in Slack by
   it, so Charlie is the host: every request in the room DMs the host and is posted in
   `#deal-desk-approvals`, and the host approves them from the signed-in approval page, one
   by one. Running it yourself after the day, `bun run users seed-demo --alice <your-email>
   --charlie <an email you can read>` puts you in both seats.
2. Confirm the hooks are on: `/hooks/health` on the app's URL reports `status: healthy`. The
   host's `setup-arcade` turns them on last, so if they are off, that is the host's one
   command to rerun.
3. Run the acts, in the words `README.md` → Try it out uses:
   - **Act 2.** As Alice: *"Approve the loan for Northwind at $95K and double-check your
     work."* `/hooks/pre` refuses, the denial names `LoanDesk_RequestApproval`, the agent
     calls it, Charlie gets a Slack DM from your own Slack account (the `--as` address) and the
     request appears in
     `#deal-desk-approvals` with the link and no buttons, Alice's turn ends. Charlie approves
     on the signed-in page; Alice asks again and her retry passes on a single-use grant. Then
     the agent emails the borrower the outcome from your own Gmail, under the same hooks.
   - **Act 3.** As Alice: *"Read LN-2291 and quote its bank account number and tax ID."* Both
     come back `[REDACTED]`. As Charlie, on the host's screen, they come through.
   - **Act 4.** Any read of LN-2291 strips the pasted instruction from `underwriter_notes`
     before the model sees it, for everyone. The host restarts the app with
     `INJECTION_DETECTION=off` to show what was prevented.
4. Edit a rule live. The host raises Alice's clearance with `bun run users set-clearance`, and
   everyone's Alice watches the same prompt pass within one policy poll, with no restart.

## What to look at

- `gate/policies/governance.json`: every rule, keyed on `Toolkit.Tool` with
  the model-facing sentence in `Toolkit_Tool` spelling. The catalogue is a closed world.
- `gate/engine/src/policy-engine.ts` and `redaction-engine.ts`: pure, no
  domain words, the same engine for every act.
- `/panel`: one card per hook decision, with the audit row's reference on it.

## Take it home: the same governance from an MCP client

Optional, if there is time, or after the workshop. Claude Code calls the loan desk's tools as
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

## Checkpoint

All four acts from your agent, and one rule edited live on the room's deployment.

## If you are behind

Still `git checkout start`. This block is Arcade state, not code: users, hooks on, Slack.
The host's `bun run reset` puts the loan book and the control plane back between attempts,
for everyone at once, so ask before you count on a pending request surviving it.
