/**
 * The discovery document a stand-in identity provider serves.
 *
 * The app finds every identity endpoint through
 * `$IDP_ISSUER/.well-known/openid-configuration` (`auth/discovery.ts`,
 * `api/actor.ts`), so a stand-in that answers userinfo has to publish where
 * that is. The issuer is the stand-in's own origin and the endpoints are the
 * paths it already serves: `/oauth2/userinfo` and friends. Okta's paths are
 * different (`/oauth2/default/v1/userinfo`), and that is the point: nothing in
 * the app may assume either one.
 */
export function discoveryDocument(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    userinfo_endpoint: `${issuer}/oauth2/userinfo`,
    jwks_uri: `${issuer}/oauth2/keys`,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  };
}

/** The document, if this request asked for it; `undefined` for anything else. */
export function answerDiscovery(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname !== "/.well-known/openid-configuration") return undefined;
  return Response.json(discoveryDocument(url.origin));
}
