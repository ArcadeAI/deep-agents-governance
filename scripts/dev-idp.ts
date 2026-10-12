/**
 * A stand-in identity provider for local development. NOT the real one.
 *
 * The loan module (`api/`) validates every bearer token by asking the userinfo
 * endpoint `IDP_ISSUER`'s discovery document names who it belongs to. The real
 * issuer is Okta; this serves an issuer of the same shape on a local port
 * (`scripts/oidc-stand-in.ts`), so the loan API can be driven by hand without
 * an Okta org:
 *
 *     IDP_ISSUER=http://localhost:4403/oauth2/default bun run dev:idp-stub   # binds 4403
 *     IDP_ISSUER=http://localhost:4403/oauth2/default PORT=4402 bun run loans
 *     curl -H 'Authorization: Bearer dev:alice@example.test' "localhost:4402/bank/loans"
 *
 * A token is `dev:<email>`; the email after the prefix is who you are. That
 * is the whole protocol, so this must never run anywhere but a laptop. It
 * lives under the repo's `scripts/`, outside the `api/` the boundary test
 * scans, and outside the Docker image. It lived in `apps/loan-app/scripts/`
 * until #5 folded that service into the app.
 */
import { startOidcStandIn } from "./oidc-stand-in.ts";

/** An example value, for the error messages. Never a fallback, see `resolveStubPort`. */
const EXAMPLE_ISSUER = "http://localhost:4403/oauth2/default";

/**
 * The port comes from `IDP_ISSUER`, the issuer the loan API is pointed at,
 * and deliberately not from `PORT`.
 *
 * `PORT` here belongs to somebody else. Since #5 this script runs from the
 * root, so Bun loads the root `.env.local`, whose `PORT` is the app's. Until
 * #56 it read `PORT` and bound the loan API's port: measured in a worktree
 * owning 4410-4419, both processes wanted 4412, whichever started second lost,
 * and nothing was listening where the identity provider was meant to be. It
 * failed silently: the stub announced a port and answered on it, just not the
 * one anybody was calling.
 *
 * Reading the issuer the API already asks for makes the two agree by
 * construction. Move `IDP_ISSUER` and both sides follow.
 *
 * `env` is a parameter so the resolution can be tested without a subprocess.
 */
export function resolveStubPort(env: Record<string, string | undefined> = process.env): number {
  const issuer = env.IDP_ISSUER?.trim() ?? "";

  if (issuer === "") {
    throw new Error(
      "IDP_ISSUER is not set, so there is no issuer for this stub to stand in for. Set it to a local " +
        `issuer (e.g. ${EXAMPLE_ISSUER}) for both this stub and \`bun run loans\`.`,
    );
  }

  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`IDP_ISSUER=${issuer} is not a URL. Expected something like ${EXAMPLE_ISSUER}.`);
  }

  // An issuer with no port is a real, remote identity provider on 80 or 443,
  // not something this stub can stand in for. Falling back to a default here
  // would bind a port nothing is calling and look like it worked, which is the
  // bug this function exists to end.
  if (url.port === "") {
    throw new Error(
      `IDP_ISSUER=${issuer} names no port, so there is nothing here for the stub to bind. ` +
        `It wants a local issuer, e.g. ${EXAMPLE_ISSUER}.`,
    );
  }

  return Number(url.port);
}

if (import.meta.main) {
  let port: number;
  try {
    port = resolveStubPort();
  } catch (cause) {
    console.error(`[dev-idp] ${cause instanceof Error ? cause.message : String(cause)}`);
    // 78 is sysexits' EX_CONFIG: the environment is wrong, not the invocation.
    // `scripts/next.ts` exits 64, EX_USAGE, for the other case.
    process.exit(78);
  }

  const issuer = new URL(process.env.IDP_ISSUER!.trim());
  const stand = await startOidcStandIn({
    port,
    hostname: issuer.hostname,
    issuerPath: issuer.pathname,
    devTokens: true,
  });

  console.log(
    `[dev-idp] listening on :${port}, the port in IDP_ISSUER, as ${stand.issuer}. ` +
      "Tokens are `dev:<email>`. Not for anything real.",
  );
}
