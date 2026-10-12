/**
 * Runs once when the app's server starts (Next's instrumentation hook).
 *
 * It boots the control plane (#4): the policy is loaded into memory, a stale
 * policy is recovered and the boot lines are printed before the first request,
 * which is the order `apps/hooks` kept when it was a service — Arcade's first
 * `/access` may be the 1.6 MB one, and it should meet a warm cache. A
 * configuration the control plane refuses is reported here, loudly, and then
 * on `/health` and in every hook's 503 (`gate/service/instance.ts`).
 *
 * It opens the loan book (#5): `loans.db` is seeded from the fixture when it is
 * empty, inside one transaction with the schema, before the first request. A
 * loan book that will not open — a fixture that does not parse, a seed that
 * fails, a disk written by a newer build — is reported here, loudly, and then
 * on `/health` and in every `/bank/…` route's 503 (`api/instance.ts`).
 * It never comes up empty.
 *
 * It reads the identity provider's discovery document: `IDP_ISSUER` is an
 * Okta authorization server, and the app is an ordinary OIDC client of it. An
 * issuer that does not answer is reported here, loudly, and then on `/health`;
 * the read is not kept when it fails, so sign-in recovers when the provider
 * does, with no restart (`auth/discovery.ts`).
 *
 * Only in the server runtime: the control plane and the loan module open
 * `governance.db` and `loans.db` with `bun:sqlite`, which is why the app runs
 * on Bun (`scripts/next.ts`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // First, so no request is served before a closed client can be noticed.
  // See the file for the Bun behaviour it corrects.
  const { installResponseClose } = await import("./lib/runtime/response-close.ts");
  installResponseClose();
  const { controlPlaneFailure } = await import("./gate/service/instance.ts");
  controlPlaneFailure();
  const { loanModuleFailure } = await import("./api/instance.ts");
  loanModuleFailure();
  const issuer = process.env.IDP_ISSUER?.trim() ?? "";
  if (issuer !== "") {
    const { discover } = await import("./auth/discovery.ts");
    await discover(issuer).then(
      (document) => console.log(`[identity] signing in through ${document.issuer}`),
      (error: unknown) => console.error(`[identity] ${error instanceof Error ? error.message : String(error)}: sign-in fails until it answers`),
    );
  }
}
