# Do your app's users need Arcade accounts?

You have an Arcade account already, because `bun run setup-arcade` registers the template in your Arcade project. The question is whether the people who sign in to the app need one too. The answer depends on which Slack app `LoanDesk_RequestApproval` authorizes through:

| Slack app | Loan officers, who request approvals | Approvers, and the loan tools |
|---|---|---|
| Arcade's built-in Slack app, the default | must be members of your Arcade project | need no Arcade account |
| Your own Slack app | need no Arcade account | need no Arcade account |

## Why

Arcade sends every tool authorization through a user verifier, and which one depends on the provider:

- **Custom providers go through the app's custom verifier.** The loan tools authorize against the app's own provider, `app-identity`, and the custom verifier at `/api/arcade/verify`, which `bun run setup-arcade` registers, binds that grant to whoever is signed in to the app.
- **Arcade's built-in providers, Slack among them, go through Arcade's own verifier.** That verifier only lets members of your Arcade project through, so with the built-in Slack app every loan officer has to be one.
- **Approving needs no provider.** `LoanDesk_Decide`, which the approval page calls when an approver presses Approve, has no auth requirement, so an approver who only approves needs no Arcade account on either route.

Arcade does not document which verifier each provider goes through. It was measured against a real Arcade project (`DESIGN.md`, "Slack and Arcade accounts").

## Route 1: Arcade's built-in Slack app

There is nothing to set up for Slack. For each loan officer:

1. Add them with `bun run users add`, as step 7 of the Quickstart does.
2. In the Arcade dashboard, open your project's Members and invite them under the email they sign in to the app with.

`bun run users add` and `bun run users seed-demo` print this reminder for everyone who could request an approval, the approver included.

## Route 2: your own Slack app

Arcade's [Slack auth provider](https://docs.arcade.dev/en/references/auth-providers/slack) page covers this. In short:

1. Create a Slack app, following the Slack guide that page links to.
2. Add the four scopes `mcp/loan_desk/approvals.py` asks for, `chat:write`, `im:write`, `users:read` and `users:read.email`, under User Token Scopes, not Bot Token Scopes. The page explains why: "Arcade requests Slack credentials as user tokens, so scopes declared only for a bot token are never granted."
3. In the Arcade dashboard, under Connected apps, click Add OAuth Provider, open the Included Providers tab and select Slack. Choose a unique ID, then enter the Slack app's client ID and client secret.
4. Set the Slack app's redirect URL to the Redirect URI Arcade shows there, then create the provider.

The page says Arcade then uses this provider automatically for tools that need Slack. It also asks for a custom user verifier when you use your own app credentials. Yours is the one `bun run setup-arcade` already registered, and Slack now goes through it, so your app's users need no Arcade account. The DM still comes from the loan officer's own Slack account, because Arcade requests user tokens.

Nothing in this repo changes. `mcp/loan_desk/approvals.py` asks for Slack by type, `Slack(scopes=...)` with no `id`, so keep yours the only Slack provider in the project. The page links to what to do if you have more than one. `bun run users` still prints the invite reminder, and on this route you can ignore it.

This route is not the default because it asks everyone who forks the template to create a Slack app.
