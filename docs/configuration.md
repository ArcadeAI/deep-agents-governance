# Configuration, readiness and reset

What the app reads from `.env`, how it tells you what is missing, and how to put the demo back.

## Configuration and readiness

`.env.example` documents every variable in place, in three blocks: the two you fill in, the ones `bun run setup-arcade` writes, and optional overrides with their defaults.

- **`/health` names what is missing.** It answers HTTP 200 either way, with `status` `ok` or `degraded` and one field per capability, including `signin`, `gateway`, `verifier`, `panel_stream`, `policy`, `loans`, `identity` and `reset`. A fresh clone with nothing filled in answers `degraded` and names `signin`, `gateway` and `verifier` as `missing`. The agent is not one of them: it runs in its own process, on Managed Deep Agents, with its own `agent/.env`. Nothing falls back silently. Arcade's own health check is a different path, `/hooks/health`, with its own `healthy|degraded|unhealthy` vocabulary.
- **The Arcade project.** `bun run setup-arcade` registers the hooks, and checks for the gateway you create, in the Arcade CLI's active org and project, as `arcade whoami` shows them, and stops before writing anything if `ARCADE_API_KEY` belongs to another project. To use a different project, set `ARCADE_ORG_ID` and `ARCADE_PROJECT_ID` in `.env`. With no CLI login and neither variable, it prints the hooks and the gateway as dashboard forms instead.
- **Open the app on its public host.** With `APP_PUBLIC_HOST` set, the home page shows an amber banner when it is served on any other host, such as localhost.
- **`BETTER_AUTH_SECRET` is written by `setup-arcade`.** Blank, the app uses a published development secret, and only on localhost: with `APP_PUBLIC_HOST` set to anything else, identity refuses to start (no sign-in, no approval, no hop-2 exchange) and `/health` says why under `identity`. A plain localhost run with nothing set still works on the development secret.
- **Changing `BETTER_AUTH_SECRET` is a rotation.** An `idp.db` whose signing key the configured secret cannot open is refused at boot and never re-keyed silently. The fix it names is to delete the local `idp.db`, then run `bun run setup-arcade` again before registering anything, because the OAuth clients change with it. That run also points `IDP_CLIENT_ID` and `IDP_CLIENT_SECRET` in `.env` at the new `idp.db`'s web client, with a new secret it does not print; restart `bun run dev` after it. If Arcade still holds a provider or User Source for the old `idp.db`, the run stops there with exit 1, after that rewrite: delete it in the dashboard, then run `bun run setup-arcade` again. Deleting `idp.db` also deletes everyone's sign-in while `governance.db` keeps their roles, so `bun run users list` shows each person half there: run `bun run users remove <email>` and then `bun run users add` for each one, which gives them a new password.
- **The port.** `bun run dev` always passes a port to Next, `PORT` or 3000, so a taken port is an error rather than a silent move to 3001 that the tunnel would not follow. Before starting Next it also checks `127.0.0.1` and `::1`, and refuses a port that anything answers on at either, because Next itself would start beside a listener on only one of them.
- **Never drive the demo from an Arcade Org Admin account.** An admin's tool list is the whole org catalogue: measured at 8259 tools, all correctly denied, and a 1.6 MB `/hooks/access` payload.

`bun run dev` names, never values, any `IDP_*` key, or `SESSION_SECRET`, `BETTER_AUTH_SECRET`, `APP_PUBLIC_HOST`, `ARCADE_API_KEY`, `ARCADE_HOOK_SIGNING_SECRET` or `APPROVALS_STORE_TOKEN`, that the shell sets to a value other than the one the `.env` files give. The shell's value wins. `bun run setup-arcade` refuses to run under such a shell.

## Resetting the demo

The three databases are SQLite files on disk, gitignored, and seeded from their fixtures only when empty. Data persists across restarts on purpose: a policy row edited during one act has to still be there in the next.

- `bun run reset` puts the control plane's policy and audit log and the loan book back, in seconds. It is idempotent.
- `bun run reset --hard` also resets the identity provider's sessions, tokens and consents, and keeps every account. That signs everyone out, so each one needs a sign-in and an authorization card before their next governed call.
- Neither deletes a user. Everyone you added with `bun run users` under an address of your own keeps their account, role and clearance through both, and a clearance you changed with `set-clearance` stays changed. Each reset's output names who it kept.
- Both call each module's own `/admin/reset` route under `RESET_TOKEN`. With it unset, every reset route answers 404 and `/health` reports `reset: disabled`.

**A reset is not a re-registration.** Nothing in `bun run reset` touches the OAuth client Arcade holds. Deleting `idp.db` or changing `BETTER_AUTH_SECRET` does, and the app refuses to start identity until you re-run `bun run setup-arcade` (see above).
