# Welcome and setup

**9:00 to 9:15. Joint.** The agenda, the people, and a laptop that can run the rest.

You leave with the app registered with Arcade, running on your laptop behind a tunnel, with you
in it as the loan officer. Everything after this is one of the two products doing its part on
that build.

## Before the workshop

Five signups, all with the **same email**:

- An [Arcade](https://api.arcade.dev/dashboard) account and one project in it, with an API key.
  The project is yours; everything the workshop registers lands there.
- An Okta Integrator org of your own ([`docs/okta.md`](../okta.md)): it is the loan desk's
  identity provider, and each attendee runs one. Make an API token in it and keep it in 1Password.
- The Slack invite the host sent, to the workshop workspace. Accept it with the same email. The
  escalation in [`03-govern.md`](./03-govern.md) is sent from your own Slack account, so you
  have to be in the workspace.
- An [ngrok](https://ngrok.com) account and its free static domain. Arcade reaches your laptop
  through it.
- A LangSmith workspace with Managed Deep Agents beta access, and its API key.

No model key is needed to start: the agent runs a scripted model until you give it one. The
host shares a model key in the room.

## What you build

1. Clone and install: the README's Quickstart steps 1 and 2.
2. Fill in `.env`: `ARCADE_API_KEY`, `APP_PUBLIC_HOST`, and one value for the room,
   `SLACK_APPROVALS_CHANNEL=C0C83CW2CDN`, the workspace's `#deal-desk-approvals`, so every
   approval request you raise is posted where everyone sees it.
3. Make the Okta app, with the token through `op run` and never in the shell:

       OKTA_ORG_URL=https://<org>.okta.com OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- bun run okta-setup

4. Register with Arcade: `bun run setup-arcade <APP_PUBLIC_HOST>`. It runs one `arcade deploy`
   (`mcp`: the Loans and Approvals tools together), mints the OAuth clients, registers the
   identity provider and the hooks, on. Read what it prints; every name it reports is a name a
   rule is keyed on later.
5. Start the app and the tunnel: `bun run dev` and the ngrok command it prints, or `bun run up`
   for both.
6. Run the `okta-setup` command from step 3 once more: `setup-arcade` wrote Arcade's callback to
   `.env`, and this run adds it to the Okta app's redirect URIs.
7. Add yourself, with the same `op run` prefix:

       bun run users add <your-email> --name Alice --role loan_officer --clearance 50000

   Keep the password it prints once. Open `https://<APP_PUBLIC_HOST>` and sign in as Alice to
   check it.

## Checkpoint

`/health` answers `ok`, and the home page shows you signed in as Alice.

## If you are behind

`git checkout start` is the whole state; nothing here changes code. `okta-setup` and
`setup-arcade` are idempotent, so run them again.
