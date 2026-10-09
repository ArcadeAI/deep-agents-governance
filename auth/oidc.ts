/**
 * Sign-in against the identity provider at `IDP_ISSUER`, as an ordinary OIDC
 * client.
 *
 * `DESIGN.md` → **Identity**: every persona is a real person in the bank's
 * identity provider, an Okta org in the workshop, and the web UI is a real
 * sign-in against it. The app, Arcade's `app-identity` provider and the User
 * Source all present one Okta Web app's client id and secret
 * (`IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`); Okta tells them apart by redirect
 * URI, not by client.
 *
 * Authorization code + PKCE, `openid email`. Sign-in itself wants one thing
 * from the access token, the **email**, read from the provider's userinfo
 * endpoint, and since #157 the token is kept afterwards rather than dropped,
 * because the bank's own screens read the loan module with it as the
 * signed-in person. `auth/session.ts` → `IdpToken` has the argument; this
 * module's job is only to obtain and renew one.
 *
 * **Every endpoint comes from discovery** (`./discovery.ts`). Nothing here
 * names an Okta path, so another OIDC provider is a change of `IDP_ISSUER`.
 */
import { discover } from "./discovery.ts";

/** What the userinfo endpoint answers with. `email` is the only field this service needs. */
export interface Userinfo {
  sub?: string;
  email?: string;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AuthorizeRequest {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
  /**
   * `prompt=login`: force a fresh authentication even when the browser already
   * holds an IdP session.
   *
   * This is what makes "Sign in as Bob" land on a login page rather than
   * silently continue as Alice. OIDC Core §3.1.2.1 defines it and Okta honours
   * it on its authorize endpoint; the failure it guards against is the whole
   * demo quietly running as one persona.
   */
  prompt?: "login";
}

/** The URL the browser is sent to: the discovered authorization endpoint, with PKCE. */
export async function authorizeUrl(request: AuthorizeRequest): Promise<string> {
  const { authorization_endpoint } = await discover(request.issuer);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scope,
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
  });
  if (request.prompt) params.set("prompt", request.prompt);
  return `${authorization_endpoint}?${params}`;
}

export interface TokenSet {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export type TokenResult =
  | { ok: true; token: TokenSet }
  | { ok: false; status: number; body: string };

/**
 * Trade the authorization code for a token. See {@link tokenRequest} for how
 * the client authenticates itself.
 */
export async function exchangeCode(
  options: {
    issuer: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  } & ClientCredentials,
): Promise<TokenResult> {
  return tokenRequest(options, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });
}

/**
 * Renew the IdP bearer this browser holds, when the IdP issued a refresh token
 * to renew it with.
 *
 * Only reachable on a deployment whose `IDP_SCOPES` asks for `offline_access`
 * and whose Okta app allows the refresh token grant. The default `openid
 * email` sign-in gets no refresh token, so an expired bearer is a re-sign-in.
 */
export async function refreshIdpToken(
  options: { issuer: string; refreshToken: string } & ClientCredentials,
): Promise<TokenResult> {
  return tokenRequest(options, { grant_type: "refresh_token", refresh_token: options.refreshToken });
}

/**
 * The order to try client authentication methods in, from what the provider
 * publishes as `token_endpoint_auth_methods_supported`. Basic first when it is
 * offered, since RFC 6749 §2.3.1 makes it the one every server must accept.
 */
export function authMethodOrder(supported: string[] | undefined): Array<"basic" | "post"> {
  const offered = supported ?? ["client_secret_basic"];
  const order: Array<"basic" | "post"> = [];
  if (offered.includes("client_secret_basic")) order.push("basic");
  if (offered.includes("client_secret_post")) order.push("post");
  return order.length > 0 ? order : ["basic"];
}

/**
 * One `POST` to the discovered token endpoint, authenticated the way the
 * provider says it accepts.
 *
 * Okta accepts either method by default, but an app can be pinned to one, and
 * then the other is refused with `invalid_client`. So a refusal that names the
 * client is retried once with the next published method. A spent or expired
 * code is not retried: a second attempt doubles the noise in the provider's
 * log and tells nobody anything.
 */
async function tokenRequest(
  options: { issuer: string } & ClientCredentials,
  grant: Record<string, string>,
): Promise<TokenResult> {
  const { token_endpoint, token_endpoint_auth_methods_supported } = await discover(options.issuer);
  const order = authMethodOrder(token_endpoint_auth_methods_supported);

  let last: { status: number; body: string } = { status: 0, body: "no token request was made" };
  for (const method of order) {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    const form: Record<string, string> = { ...grant, client_id: options.clientId };
    if (method === "basic") {
      headers.authorization = `Basic ${basic(options)}`;
    } else {
      form.client_secret = options.clientSecret;
    }

    let response: Response;
    try {
      response = await fetch(token_endpoint, { method: "POST", headers, body: new URLSearchParams(form).toString() });
    } catch (cause) {
      return { ok: false, status: 0, body: `${token_endpoint} could not be reached: ${String(cause)}` };
    }
    const body = await response.text();
    if (response.ok) return { ok: true, token: JSON.parse(body) as TokenSet };
    last = { status: response.status, body };
    if (!/invalid_client|client_secret_(post|basic)/.test(body)) break;
  }
  return { ok: false, ...last };
}

/**
 * `expires_in` seconds, as the absolute epoch-millisecond instant the session
 * records.
 *
 * An hour when the IdP says nothing, which is also Okta's default access token
 * lifetime. A token with no stated lifetime is still a token with a lifetime,
 * and treating it as immortal would put the re-sign-in prompt on screen only
 * once the loan book had already refused the read.
 */
export function tokenExpiry(token: TokenSet, now = Date.now()): number {
  const seconds = typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
    ? token.expires_in
    : 3600;
  return now + Math.max(0, seconds) * 1000;
}

/**
 * `Authorization: Basic`, built the way RFC 6749 §2.3.1 says to: each half
 * form-url-encoded before the base64.
 */
function basic({ clientId, clientSecret }: ClientCredentials): string {
  const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  return Buffer.from(`${half(clientId)}:${half(clientSecret)}`).toString("base64");
}

/**
 * Why a userinfo call did not yield an email. Three different things, and the
 * page that reports them has to be able to tell them apart: only one of them
 * is the provider saying anything at all about an email.
 *
 * - `request-failed`: the provider refused the request, or could not be
 *   reached. A 401, a 403, a 429, a 500. It said nothing about email, and a
 *   page that claims it did is asserting something that did not happen (#166,
 *   same family as #151).
 * - `unreadable`: it answered, and the answer was not JSON.
 * - `no-email-claim`: it answered with a user, and that user has no `email`.
 *   On Okta that is usually a token issued without the `email` scope.
 */
export type UserinfoFailure = "request-failed" | "unreadable" | "no-email-claim";

export type UserinfoResult =
  | { ok: true; email: string }
  | { ok: false; failure: UserinfoFailure; status: number; body: string };

/** The signed-in person's email, lowercase, or the reason there is none. */
export async function fetchUserinfo(issuer: string, accessToken: string): Promise<UserinfoResult> {
  const { userinfo_endpoint } = await discover(issuer);
  let response: Response;
  try {
    response = await fetch(userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (cause) {
    return {
      ok: false,
      failure: "request-failed",
      status: 0,
      body: `${userinfo_endpoint} could not be reached: ${String(cause)}`,
    };
  }
  const body = await response.text();
  if (!response.ok) return { ok: false, failure: "request-failed", status: response.status, body };

  let userinfo: Userinfo;
  try {
    userinfo = JSON.parse(body) as Userinfo;
  } catch {
    return { ok: false, failure: "unreadable", status: response.status, body };
  }
  if (!userinfo.email) {
    return { ok: false, failure: "no-email-claim", status: response.status, body };
  }
  // DESIGN.md rule 3: the Arcade user_id, the OAuth subject and the loan book's
  // actor column are one string. Lowercased here because this is the value
  // that ends up on every hook payload.
  return { ok: true, email: userinfo.email.toLowerCase() };
}

/** PKCE S256. The verifier rides in a sealed cookie; only the challenge is ever in a URL. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

/** A CSRF nonce for one authorization leg. */
export function nonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}
