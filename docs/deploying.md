# Deploying

The [Quickstart](../README.md#quickstart-) runs the app on your machine behind ngrok. To host it instead, build the root `Dockerfile`. It makes one image, running on Bun, that serves everything on one host: the pages, the hooks under `/hooks`, the loan API under `/bank` and the identity provider. The two toolkits are not in it, because they ship with `arcade deploy`. CI builds the image and boots it on every push.

- **The variables are the ones in `.env.example`.** Set `APP_PUBLIC_HOST` to the deployment's own host. The image runs in production mode, so nothing falls back to a development value: without `ARCADE_HOOK_SIGNING_SECRET`, `APPROVALS_STORE_TOKEN` and `BETTER_AUTH_SECRET` the app still starts, but the control plane and the identity provider refuse to, and `/health` names the refusal.
- **One persistent disk holds all three databases.** Point `GOVERNANCE_DB_PATH`, `LOANS_DB_PATH` and `IDP_DB_PATH` at files on it, for example under `/data`. Without it the databases are recreated with every new container.
- **A redeploy is not a reset.** The databases seed from their fixtures only when empty, and the disk survives a deploy, so every edit and every approval carries forward. `bun run reset` is the way back.
- **The disk holds the OAuth clients Arcade is registered against.** If `idp.db` is recreated, the clients change and the registration in Arcade goes stale.
