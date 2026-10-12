# Okta, the identity provider

Okta is where the people who use the loan desk exist. They sign in to the app, to the agent's `ask.py` and to the loan desk's `app-identity` provider at Arcade with their Okta login, and each of those is an ordinary OpenID Connect client of one Okta app. The app reads every endpoint from the issuer's discovery document, `IDP_ISSUER/.well-known/openid-configuration`, and spells no Okta path, so any provider that publishes one, Auth0 included, works with the same code.

Okta holds who someone is and their password. What they may do, their role and their approval clearance, stays in the app's `governance.db`, where `/hooks/pre` reads it.

## Create your Okta org

1. Sign up for an org. Okta's free Integrator plan works, and so does a Workforce Identity trial. Either one gives you `https://<org>.okta.com` and its Admin Console, which is the same host with `-admin` added to the org name. Everything here uses the first one, without `-admin`.
2. Create an API token. In the Admin Console, open Security → API → Tokens and create a token while signed in as a Super Administrator, because the token acts with its creator's rights. Okta shows it once.
3. Keep the token in 1Password, never in `.env`. It reaches `bun run okta-setup` and `bun run users` through `op run`, so it is in the command's environment for that run and nowhere else:

   ```sh
   OKTA_ORG_URL=https://<org>.okta.com OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- bun run okta-setup
   ```

   Both commands refuse to run if they find `OKTA_API_TOKEN` in `.env`.

That is the whole of the manual part. `bun run okta-setup` makes the rest.

## What `bun run okta-setup` makes

Each step looks for what it makes before making it, so a second run changes nothing:

- **The app**, an OIDC Web app labelled "Loan Desk", with the authorization code and refresh token grants, the client secret sent over HTTP Basic, and the consent screen skipped. Its sign-in redirect URIs are:
  - `https://<APP_PUBLIC_HOST>/api/auth/callback`, the app's own sign-in, once `APP_PUBLIC_HOST` is set;
  - `http://127.0.0.1:8765/callback`, where `ask.py` listens while you sign in;
  - `ARCADE_PROVIDER_CALLBACK`, Arcade's callback for the `app-identity` provider, once `bun run setup-arcade` has written it to `.env`. That is why the Quickstart runs `okta-setup` a second time.
- **The assignment** of the app to the Everyone group, so anybody in the org may sign in to it. Whether they can do anything once signed in is `governance.db`'s call.
- **An access policy** on the `default` authorization server, "Loan Desk", with a rule that hands the app tokens for the authorization code grant. If a policy on that server already does, it uses that one and adds nothing.
- **The group** "Loan Desk users", which `bun run users` puts each person it creates in.
- **A password-only sign-in policy**, "Loan Desk password only", assigned to the app, so the demo people sign in with their password and no second factor. Some orgs do not allow an API token to change sign-in policies. Then the command finishes anyway and says so, and Okta's default policy asks each person to enroll a second factor at their first sign-in.

It writes `OKTA_ORG_URL` to `.env` if it has none, and `IDP_ISSUER`, `IDP_CLIENT_ID` and `IDP_CLIENT_SECRET` every time they differ: the org is their source of truth. It prints the client id. It never prints the client secret: it writes it to `.env`, with mode 0600, and prints an `op item create` command that copies it from `.env` into 1Password without it passing through your terminal. It makes a new secret only for a new app, or when `.env` has none for the app it found.

## The same setup in the Admin Console

If you would rather click, or the token cannot do one of the steps above:

1. Applications → Applications → Create App Integration: OIDC, Web Application. Name it "Loan Desk". Grant types: Authorization Code and Refresh Token. Add the sign-in redirect URIs listed above. Under Assignments, allow everyone in your organization. Save, and copy the client id and secret into `IDP_CLIENT_ID` and `IDP_CLIENT_SECRET` in `.env`.
2. Security → API → Authorization Servers → `default`. Copy its Issuer URI into `IDP_ISSUER`, and `https://<org>.okta.com` into `OKTA_ORG_URL`. Under Access Policies, add a policy assigned to the Loan Desk app, with a rule for the Authorization Code grant, any user assigned the app, and any scope.
3. Optional: Security → Authentication Policies → add a policy whose one rule has Password as the only factor, and assign it to the Loan Desk app, so the demo people need no second factor.

Run `bun run okta-setup` afterwards anyway: it finds what you made by the app's label and adds anything missing.

## People

`bun run users add` and `bun run users seed-demo` create each person in Okta, active, with a password, and put them in "Loan Desk users". The password is generated unless you give one with `--password`, and either way it has to meet Okta's default password policy: at least 8 characters, a lowercase letter, an uppercase letter and a number, and no part of the email address of three characters or more. A generated one always does. `seed-demo --password` gives the whole cast one password, so it cannot contain a part any of their addresses share: `Demo-Desk-2026` is refused for `alice@demo.test`.

Someone who is already in the org keeps the password they have, and `bun run users remove` leaves them there. Anyone the command created, `remove` deactivates and deletes in Okta, which also ends their Okta session.

## Another provider

Nothing in the app, the agent or the Arcade registration is specific to Okta: they read the issuer's discovery document and nothing else. `bun run okta-setup` and `bun run users` are, because they create the client and the people through Okta's Management API. To use another OIDC provider, create the client there by hand with the redirect URIs above, set `IDP_ISSUER`, `IDP_CLIENT_ID` and `IDP_CLIENT_SECRET`, and create the people there too. `bun run users add` cannot do that half for another provider yet. The provider must put the person's `email` in the userinfo response, because that is the identity Arcade, the hooks and `governance.db` all key on.
