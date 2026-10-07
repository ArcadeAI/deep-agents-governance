# auth-config/: what to register at Arcade, ready to copy

Everything this demo registers at Arcade, one file per registration, in the shape
Arcade's API takes it. `bun run setup-arcade` sends exactly these bodies; this folder is
the same thing for when you would rather paste it yourself, or read what the run did.
`app-test/auth-config.test.ts` holds each file to the code that sends it, so they cannot
drift apart.

Replace each `<PLACEHOLDER>` with your own value. Nothing in this folder is a secret
until you fill it in, so fill in a copy, not these files.

| File | What it registers | Arcade dashboard |
|---|---|---|
| `user-source.json` | Hop 1: the gateway's users sign in with the app's own OpenID Connect | User Sources → Create |
| `gateway.json` | The MCP gateway the agent calls: the six loan desk tools, Gmail and Slack, through the User Source | MCP Gateways → Create |
| `app-identity-provider.json` | Hop 2: the custom OAuth 2.0 provider the loan tools use to call the loan API as the caller | Auth Providers → Custom → OAuth 2.0 |
| `custom-verifier.json` | The app confirms who finished an Arcade sign-in, so a link cannot be used by someone else | Auth → User Verification |
| `hooks-plugin.json` | The contextual access hooks: `/hooks/access`, `/hooks/pre`, `/hooks/post`, fail closed | Contextual Access → Webhook plugin |

Google (Gmail) and Slack need nothing here: they are Arcade's built-in providers, and
each person authorizes them the first time the agent uses them.

## The placeholders

| Placeholder | Where it comes from |
|---|---|
| `<APP_PUBLIC_HOST>` | your ngrok domain, host form (`my-app.ngrok.app`), as in `.env` |
| `<ARCADE_USER_SOURCE_CLIENT_ID>` / `_SECRET>` | the app's `arcade-user-source` client: `bun run oauth-client --client arcade-user-source --rotate` |
| `<ARCADE_CLIENT_ID>` / `<ARCADE_CLIENT_SECRET>` | the app's `arcade` client: `bun run oauth-client --client arcade --rotate` |
| `<ARCADE_HOOK_SIGNING_SECRET>` | the value of that name in `.env` |
| `<ARCADE_GATEWAY_ID>` | a slug you pick; set `.env`'s `ARCADE_GATEWAY_ID` to the same |
| `<USER_SOURCE_ID>` | the `us_…` id Arcade gives the User Source when you create it |

## Order

1. The app and the tunnel are up first: Arcade reads the User Source's issuer and the
   hooks' health check through the tunnel when you save them.
2. `user-source.json`, then `gateway.json`, which names the User Source.
3. `app-identity-provider.json`. Arcade answers with the provider's callback,
   `https://cloud.arcade.dev/api/v1/oauth/<provider id>/callback`: allowlist it on the
   app's `arcade` client.
4. `custom-verifier.json`.
5. `hooks-plugin.json` last. Active hooks filter the tool list the gateway form shows,
   so create the gateway before turning them on.

## Who is who

| Who | Provider | Notes |
|---|---|---|
| The person using the agent (hop 1) | **User Source**: the app's own sign-in | Subject claim `email`, not the default `sub`: the email the agent acts as is the email the hooks govern. Its callback, `https://cloud.arcade.dev/oauth2/intermediate_callback`, is already allowlisted on the `arcade-user-source` client. |
| The loan API, called by the loan tools (hop 2) | **Custom OAuth 2.0 provider** `app-identity`, served by `auth/provider/` | The tools in `mcp/loan_desk/loans.py` declare `OAuth2(id="app-identity", scopes=["openid", "email"])`, and a test keeps that id equal to the provider's. The loan API attributes each call to the email in the token. |
| Slack, for the approval DM and the channel post | **Arcade's built-in Slack provider** | `RequestApproval` asks for `chat:write`, `im:write`, `users:read`, `users:read.email`. The token is the requester's, so both messages arrive under their name. Arcade routes this provider through its own verifier, so the requester must be a member of the Arcade project (`docs/app-users-and-arcade-accounts.md`). |
| Gmail | **Arcade's built-in Google provider** | The caller's own Google account. |

The agent itself is not an identity: it verifies the app's ID tokens
(`agent/identity.py`) and passes the caller's email to Arcade on every call.

## Bringing your own identity provider

`app-identity-provider.json` points at the app's own provider. To use Okta or Auth0
instead, keep the id `app-identity` and point the three endpoints at your tenant's
authorize, token and userinfo URLs, with `user_id` still read from `$.email`, and make
the User Source's issuer your tenant. The hooks key on that email, so nothing else
changes.

## Where the people are

The personas, their passwords, roles and clearances live in `idp.db` and
`governance.db`, both on your machine: `bun run users add <email> --name … --role … --clearance …`,
or `bun run users seed-demo` for the demo cast. Nothing about a person is stored at Arcade.
