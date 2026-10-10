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
| `app-identity-provider.json` | Hop 2: the custom OAuth 2.0 provider the loan tools use to call the loan API as the caller | Auth Providers → Custom → OAuth 2.0 |
| `custom-verifier.json` | The app confirms who finished an Arcade sign-in, so a link cannot be used by someone else | Auth → User Verification |
| `hooks-plugin.json` | The contextual access hooks: `/hooks/access`, `/hooks/pre`, `/hooks/post`, fail closed | Contextual Access → Webhook plugin |

Google (Gmail) and Slack need nothing here: they are Arcade's built-in providers, and
each person authorizes them the first time the agent uses them.

There is no User Source and no MCP gateway to register. The agent calls the Arcade Engine
directly with the project API key and the signed-in person's email as `user_id`
(`agent/agent.py`), and the hooks govern every call it makes.

## The placeholders

| Placeholder | Where it comes from |
|---|---|
| `<APP_PUBLIC_HOST>` | your ngrok domain, host form (`my-app.ngrok.app`), as in `.env` |
| `<IDP_ISSUER>` | the Okta authorization server's issuer, `https://<org>.okta.com/oauth2/default`, as `bun run okta-setup` writes it to `.env` |
| `<IDP_CLIENT_ID>` / `<IDP_CLIENT_SECRET>` | the Okta app's client, the values of those names in `.env`. Hop 2, the app's own sign-in and `agent/ask.py` all use this one client |
| `<ARCADE_HOOK_SIGNING_SECRET>` | the value of that name in `.env` |

## Order

1. The app and the tunnel are up first: Arcade reads the hooks' health check through
   the tunnel when you save them.
2. `app-identity-provider.json`. Arcade answers with the provider's callback: put it in
   `.env` as `ARCADE_PROVIDER_CALLBACK` and run `bun run okta-setup`, which adds it to the
   Okta app's redirect URIs, or add it there yourself.
3. `custom-verifier.json`.
4. `hooks-plugin.json`, created active.

## Who is who

| Who | Provider | Notes |
|---|---|---|
| The person using the agent | **Okta**, through the app's sign-in or `agent/ask.py` | The agent verifies the ID token and passes its `email` to Arcade as `user_id`: the email the agent acts as is the email the hooks govern. |
| The loan API, called by the loan tools (hop 2) | **Custom OAuth 2.0 provider** `app-identity`, at Okta | The tools in `mcp/loan_desk/loans.py` declare `OAuth2(id="app-identity", scopes=["openid", "email"])`, and a test keeps that id equal to the provider's. The loan API attributes each call to the email in the token. |
| Slack, for the approval DM and the channel post | **Arcade's built-in Slack provider** | `RequestApproval` asks for `chat:write`, `im:write`, `users:read`, `users:read.email`. The token is the requester's, so both messages arrive under their name. Arcade routes this provider through its own verifier, so the requester must be a member of the Arcade project (`docs/app-users-and-arcade-accounts.md`). |
| Gmail | **Arcade's built-in Google provider** | The caller's own Google account. |

The agent itself is not an identity: it verifies Okta's ID tokens against the issuer's
published keys (`agent/identity.py`) and passes the caller's email to Arcade on every call.

## Bringing your own identity provider

The file spells Okta's endpoint paths under `<IDP_ISSUER>` because that is the
workshop's provider. `bun run setup-arcade` does not: it reads the authorize, token and
userinfo URLs from the issuer's discovery document and registers those. To paste the body
for Auth0 or another provider, keep the id `app-identity`, use the three endpoints its
`/.well-known/openid-configuration` names, with `user_id` still read from `$.email`. The
hooks key on that email, so nothing else changes.

## Where the people are

Each person's account and password live in Okta, and their role and clearance in
`governance.db` on your machine. `bun run users add <email> --name … --role … --clearance …`
writes both, or `bun run users seed-demo` the demo cast, with the Okta API token through
`op run`. Nothing about a person is stored at Arcade.
