# Configuration, readiness and reset

What the app reads from `.env`, how it tells you what is missing, and how to put the demo back.

## Configuration and readiness

`.env.example` documents every variable in place, in four blocks: the two you fill in, the ones `bun run okta-setup` writes, the ones `bun run setup-arcade` writes, and optional overrides with their defaults.

- **`/health` names what is missing.** It answers HTTP 200 either way, with `status` `ok` or `degraded` and one field per capability, including `signin`, `verifier`, `panel_stream`, `policy`, `loans`, `identity` and `reset`, plus `gateway: configured` only when `ARCADE_GATEWAY_ID` is set. A fresh clone with nothing filled in answers `degraded` and names `signin` and `verifier` as `missing`. The agent is not one of them: it runs in its own process, on Managed Deep Agents, with its own `agent/.env`. Nothing falls back silently. Arcade's own health check is a different path, `/hooks/health`, with its own `healthy|degraded|unhealthy` vocabulary.
- **The Arcade project.** `bun run setup-arcade` registers the hooks in the Arcade CLI's active org and project, as `arcade whoami` shows them, and stops before writing anything if `ARCADE_API_KEY` belongs to another project. To use a different project, set `ARCADE_ORG_ID` and `ARCADE_PROJECT_ID` in `.env`. With no CLI login and neither variable, it prints the hooks as a dashboard form instead.
- **The optional MCP gateway.** `bun run setup-arcade <host> --gateway` also registers a User Source for the Okta app, through the Coordinator API (`ARCADE_COORDINATOR_URL`, default `https://cloud.arcade.dev/api`), and an MCP gateway through it with the nine tools, and writes the slug to `.env` as `ARCADE_GATEWAY_ID`. The slug is `--gateway=<slug>`, else the one in `.env`, else `loan-desk-<first label of the host>`. With the variable set, the home page shows the `claude mcp add` command and `/health` reports `gateway: configured`; the agent never reads it. Without the flag, a slug already in `.env` is left as it is, with a note. [`modules/05-mcp-client.md`](./modules/05-mcp-client.md).
- **Open the app on its public host.** With `APP_PUBLIC_HOST` set, the home page shows an amber banner when it is served on any other host, such as localhost.
- **`identity` is Okta.** The app is an OIDC client of `IDP_ISSUER` and reads every endpoint from its discovery document. `/health` reports `identity` as `ok` with the issuer once that document answers and names the same issuer, `failed` with the reason when it does not, and `unconfigured` with no `IDP_ISSUER`. The most common `failed` is the org URL where the authorization server's issuer belongs: `https://<org>.okta.com` instead of `https://<org>.okta.com/oauth2/default`. [`okta.md`](./okta.md) covers the org itself.
- **Rotating the Okta client secret.** Generate a new secret on the Loan Desk app in the Admin Console, or empty `IDP_CLIENT_SECRET` in `.env` and run `bun run okta-setup`, which makes one. Arcade does not show a secret back, so `bun run setup-arcade` cannot tell the one it holds is old: paste the new secret into the `app-identity` provider in the Arcade dashboard, or delete it and run `bun run setup-arcade` again. Then restart `bun run dev`. The agent's `agent/.env` holds a copy too.
- **`SESSION_SECRET` seals the app's session cookie.** `setup-arcade` writes it. Changing it signs everyone out of the app, and nothing else: their Okta sessions and their Arcade authorizations are untouched.
- **The port.** `bun run dev` always passes a port to Next, `PORT` or 3000, so a taken port is an error rather than a silent move to 3001 that the tunnel would not follow. Before starting Next it also checks `127.0.0.1` and `::1`, and refuses a port that anything answers on at either, because Next itself would start beside a listener on only one of them.
- **Never drive the demo from an Arcade Org Admin account.** An admin's tool list is the whole org catalogue: measured at 8259 tools, all correctly denied, and a 1.6 MB `/hooks/access` payload.

`bun run dev` names, never values, any `IDP_*` key, or `SESSION_SECRET`, `APP_PUBLIC_HOST`, `ARCADE_API_KEY`, `ARCADE_HOOK_SIGNING_SECRET` or `APPROVALS_STORE_TOKEN`, that the shell sets to a value other than the one the `.env` files give. The shell's value wins. `bun run setup-arcade` refuses to run under such a shell.

## Resetting the demo

The two databases, `governance.db` and `loans.db`, are SQLite files on disk, gitignored, and seeded from their fixtures only when empty. Data persists across restarts on purpose: a policy row edited during one act has to still be there in the next.

- `bun run reset` puts the control plane's policy and audit log and the loan book back, in seconds. It is idempotent.
- There is no `bun run reset --hard` any more: sessions and passwords live in Okta, and the reset holds no Okta credential. To show signing in from clean, sign out in the app and clear the person's sessions in Okta's Admin Console (Directory, People, the person, More Actions, Clear User Sessions).
- It deletes no user. Everyone you added with `bun run users` under an address of your own keeps their Okta account, role and clearance through it, and a clearance you changed with `set-clearance` stays changed. Each reset's output names who it kept.
- It calls each module's own `/admin/reset` route under `RESET_TOKEN`. With it unset, every reset route answers 404 and `/health` reports `reset: disabled`.

**A reset is not a re-registration.** Nothing in `bun run reset` touches Okta or what Arcade holds. A new Okta client secret does (see above).
