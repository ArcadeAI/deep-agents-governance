/**
 * Where the identity provider keeps its endpoints, read from the provider.
 *
 * The app is an ordinary OIDC client of `IDP_ISSUER`: an Okta custom
 * authorization server (`https://<org>.okta.com/oauth2/default`) in the
 * workshop, and any issuer that publishes OpenID Connect Discovery 1.0
 * otherwise. Nothing in this repo spells an Okta path. The authorize, token,
 * userinfo and key endpoints are whatever
 * `$IDP_ISSUER/.well-known/openid-configuration` says they are, which is what
 * lets an Auth0 tenant or a Keycloak realm drop in with no code change.
 *
 * The document is fetched once per issuer per process and kept. A failed read
 * is not kept: a provider having a bad minute at boot must not leave sign-in
 * broken until a restart.
 */

/** The fields this app reads. Providers publish many more. */
export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** Discovery did not produce a usable document. The message says which part. */
export class DiscoveryError extends Error {
  override name = "DiscoveryError";
}

const REQUIRED = ["issuer", "authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"] as const;

const cache = new Map<string, Promise<DiscoveryDocument>>();

/** No trailing slash, so `…/default` and `…/default/` are one issuer. */
export function normaliseIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

/** `$issuer/.well-known/openid-configuration`, per OIDC Discovery 1.0 §4. */
export function discoveryUrl(issuer: string): string {
  return `${normaliseIssuer(issuer)}/.well-known/openid-configuration`;
}

/**
 * The provider's discovery document, fetched on first use and then reused.
 *
 * The document's own `issuer` must be the configured one (§4.3). A mismatch is
 * the classic misconfiguration, the org URL pasted where the authorization
 * server's issuer belongs, and it fails here, by name, rather than later as a
 * token whose `iss` nothing accepts.
 */
export function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<DiscoveryDocument> {
  const key = normaliseIssuer(issuer);
  const held = cache.get(key);
  if (held) return held;
  const pending = load(key, fetchImpl);
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

async function load(issuer: string, fetchImpl: typeof fetch): Promise<DiscoveryDocument> {
  if (!issuer) throw new DiscoveryError("IDP_ISSUER is not set");
  const url = discoveryUrl(issuer);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new DiscoveryError(`${url} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) throw new DiscoveryError(`${url} answered ${response.status}`);

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null || typeof body !== "object") throw new DiscoveryError(`${url} did not answer JSON`);
  const missing = REQUIRED.filter((field) => typeof body[field] !== "string" || body[field] === "");
  if (missing.length > 0) throw new DiscoveryError(`${url} has no ${missing.join(", ")}`);
  if (normaliseIssuer(body.issuer as string) !== issuer) {
    throw new DiscoveryError(
      `${url} names its issuer ${body.issuer as string}, not ${issuer}. IDP_ISSUER must be the ` +
        "authorization server's issuer exactly as it publishes it.",
    );
  }
  return body as unknown as DiscoveryDocument;
}

/** Drop every cached document. For tests, which point one process at many issuers. */
export function forgetDiscovery(): void {
  cache.clear();
}
