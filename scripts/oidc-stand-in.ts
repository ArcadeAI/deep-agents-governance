/**
 * A stand-in OpenID Connect provider, shaped like an Okta custom authorization
 * server. NOT the real one: it is for tests and a laptop.
 *
 * The app, the loan module and `agent/` are ordinary OIDC clients of
 * `IDP_ISSUER` and read every endpoint from its discovery document, so a test
 * can point them here and nothing else changes. What it serves, under the
 * issuer (`<origin>/oauth2/default`, Okta's layout):
 *
 * - `/.well-known/openid-configuration`, naming the four endpoints below;
 * - `/v1/authorize`: authorization code with PKCE (S256 only), an exact
 *   redirect URI match per client, a login form with `email` and `password`
 *   fields, a session cookie, and `prompt=login` honoured the way Okta honours
 *   it, so "the IdP still knows who you are" is a real condition here;
 * - `/v1/token`: `authorization_code` and `refresh_token`, with the client
 *   authenticated by HTTP Basic or by the body, never both (Okta refuses a
 *   request that carries both, and so does this). A refresh token comes only
 *   with `offline_access`, rotates on every use, and a spent one presented
 *   again revokes every token of its grant;
 * - `/v1/userinfo`: `sub`, `email`, `email_verified` and `name` for a live
 *   access token;
 * - `/v1/keys`: the RS256 key every ID token is signed with.
 *
 * With `devTokens`, userinfo also accepts `Bearer dev:<email>` and answers that
 * email: the whole of `bun run dev:idp-stub`'s protocol, for driving the loan
 * API by hand. Never on anything but a laptop.
 *
 * With `managementToken`, the origin also answers the slice of Okta's
 * Management API that `bun run users` calls (`scripts/okta/client.ts`): users
 * by login or id, create with `activate=true`, deactivate and delete, groups
 * by name, membership. `Authorization: SSWS <managementToken>`, as Okta wants
 * it. A user it creates can sign in at once, so a test can run the real
 * `users seed-demo` and then sign in as who it made.
 */

export interface StandInPerson {
  email: string;
  password: string;
  name?: string;
}

export interface StandInClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export interface OidcStandInOptions {
  port?: number;
  hostname?: string;
  /** The issuer's path on the origin. Okta's `default` authorization server by default. */
  issuerPath?: string;
  people?: readonly StandInPerson[];
  clients?: readonly StandInClient[];
  /** Accept `Bearer dev:<email>` at userinfo. */
  devTokens?: boolean;
  /** Seconds put on every access token. */
  accessTokenSeconds?: number;
  /** Serve the Management API's users and groups to `SSWS <managementToken>`. */
  managementToken?: string;
}

/** A user as the Management API holds them. Only an `ACTIVE` one can sign in. */
export interface StandInUser {
  id: string;
  status: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  groups: Set<string>;
}

export interface OidcStandIn {
  /** The origin, `http://<hostname>:<port>`. */
  url: string;
  /** `IDP_ISSUER` for whatever points here. No trailing slash, as Okta publishes it. */
  issuer: string;
  endpoints: { authorize: string; token: string; userinfo: string; jwks: string };
  addPerson(person: StandInPerson): void;
  removePerson(email: string): void;
  /** Every user, by id, as the Management API sees them. */
  users: Map<string, StandInUser>;
  /** Every group, by id. */
  groups: Map<string, { id: string; name: string; description: string }>;
  addClient(client: StandInClient): void;
  /** Every request, as `METHOD path`, and every refusal, as `refused: <why>`. */
  log: string[];
  /** Every `grant_type` the token endpoint was asked for, in order. */
  grants: string[];
  /** Every `prompt` value the authorize endpoint saw, `""` for none. */
  prompts: string[];
  /** While set, userinfo answers this status with no body. */
  failUserinfo: number | null;
  /** Revoke every access token issued so far. */
  revokeAccessTokens(): void;
  stop(): void;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(24)));
const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function startOidcStandIn(options: OidcStandInOptions = {}): Promise<OidcStandIn> {
  const issuerPath = (options.issuerPath ?? "/oauth2/default").replace(/\/+$/, "");
  const users = new Map<string, StandInUser>();
  const groups = new Map<string, { id: string; name: string; description: string }>();
  const clients = new Map<string, StandInClient>();
  for (const client of options.clients ?? []) clients.set(client.clientId, client);
  let nextId = 1;
  const userId = () => `00u${String(nextId++).padStart(17, "0")}`;
  const byLogin = (email: string) => [...users.values()].find((user) => user.email === email.trim().toLowerCase());
  /** Who can sign in: the active user with this email. */
  const people = {
    get: (email: string) => {
      const user = byLogin(email);
      return user && user.status === "ACTIVE" ? { email: user.email, password: user.password, name: `${user.firstName} ${user.lastName}`.trim() } : undefined;
    },
    has: (email: string) => people.get(email) !== undefined,
  };
  const addPerson = (person: StandInPerson) => {
    if (byLogin(person.email)) return;
    const [firstName = person.email, ...rest] = (person.name ?? person.email).split(" ");
    const id = userId();
    users.set(id, { id, status: "ACTIVE", email: person.email.trim().toLowerCase(), password: person.password, firstName, lastName: rest.join(" "), groups: new Set() });
  };
  for (const person of options.people ?? []) addPerson(person);

  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const kid = random().slice(0, 16);
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid, use: "sig", alg: "RS256" };

  const sessions = new Map<string, string>();
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; email: string; nonce: string | null; scope: string }
  >();
  const access = new Map<string, { email: string; expires: number; family: string }>();
  const refresh = new Map<string, { clientId: string; email: string; scope: string; family: string }>();
  /** Refresh tokens already redeemed, by the family they belonged to: presenting one again revokes the family. */
  const spent = new Map<string, string>();
  const revokeFamily = (family: string) => {
    for (const [token, held] of access) if (held.family === family) access.delete(token);
    for (const [token, held] of refresh) if (held.family === family) refresh.delete(token);
  };
  const lifetime = options.accessTokenSeconds ?? 3600;
  const cookieName = "standin_sid";

  const state: OidcStandIn = {
    url: "",
    issuer: "",
    endpoints: { authorize: "", token: "", userinfo: "", jwks: "" },
    addPerson,
    removePerson: (email) => {
      const user = byLogin(email);
      if (user) users.delete(user.id);
    },
    users,
    groups,
    addClient: (client) => void clients.set(client.clientId, client),
    log: [],
    grants: [],
    prompts: [],
    failUserinfo: null,
    revokeAccessTokens: () => access.clear(),
    stop: () => server.stop(true),
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const oauthError = (error: string, description: string, status = 400) => {
    state.log.push(`refused: ${error}: ${description}`);
    return json({ error, error_description: description }, status);
  };

  async function idToken(clientId: string, email: string, nonce: string | null): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const person = people.get(email);
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
    const payload = b64url(
      new TextEncoder().encode(
        JSON.stringify({
          iss: state.issuer,
          aud: clientId,
          sub: `00u${Buffer.from(email).toString("hex").slice(0, 17)}`,
          email,
          email_verified: true,
          name: person?.name ?? email,
          iat: now,
          exp: now + lifetime,
          ...(nonce ? { nonce } : {}),
        }),
      ),
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${b64url(signature)}`;
  }

  /**
   * A refresh token only for `offline_access`, as Okta issues one, and rotated
   * on every use with no grace period: the strictest setting an Okta app can
   * have, so a caller that replays a spent token is caught here.
   */
  async function tokens(clientId: string, email: string, scope: string, nonce: string | null, family = random()) {
    const accessToken = `standin-access-${random()}`;
    access.set(accessToken, { email, expires: Date.now() + lifetime * 1000, family });
    const offline = scope.split(" ").includes("offline_access");
    const refreshToken = offline ? `standin-refresh-${random()}` : null;
    if (refreshToken) refresh.set(refreshToken, { clientId, email, scope, family });
    return {
      token_type: "Bearer",
      expires_in: lifetime,
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope,
      ...(scope.split(" ").includes("openid") ? { id_token: await idToken(clientId, email, nonce) } : {}),
    };
  }

  function loginPage(query: string, error = "") {
    return new Response(
      `<!doctype html><title>Sign in</title>${error ? `<p role="alert">${escape(error)}</p>` : ""}` +
        `<form method="post" action="${escape(`${issuerPath}/v1/authorize`)}">` +
        `<input type="hidden" name="request" value="${escape(query)}">` +
        `<input name="email" type="email" value=""><input name="password" type="password" value="">` +
        `<button type="submit">Sign in</button></form>`,
      { status: error ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  /** The authorize request's own checks, before anybody is asked who they are. */
  function checkAuthorize(params: URLSearchParams): Response | null {
    const client = clients.get(params.get("client_id") ?? "");
    if (!client) return oauthError("invalid_client", "unknown client_id");
    if (!client.redirectUris.includes(params.get("redirect_uri") ?? "")) {
      return oauthError("invalid_request", "The 'redirect_uri' parameter must be a Login redirect URI in the client app settings");
    }
    if (params.get("response_type") !== "code") return oauthError("unsupported_response_type", "only code");
    if (!params.get("code_challenge") || params.get("code_challenge_method") !== "S256") {
      return oauthError("invalid_request", "PKCE with S256 is required");
    }
    return null;
  }

  function issueCode(params: URLSearchParams, email: string, sid: string | null): Response {
    const code = random();
    codes.set(code, {
      clientId: params.get("client_id")!,
      redirectUri: params.get("redirect_uri")!,
      challenge: params.get("code_challenge")!,
      email,
      nonce: params.get("nonce"),
      scope: params.get("scope") ?? "openid",
    });
    const back = new URL(params.get("redirect_uri")!);
    back.searchParams.set("code", code);
    const returnedState = params.get("state");
    if (returnedState !== null) back.searchParams.set("state", returnedState);
    const headers = new Headers({ location: back.toString() });
    if (sid) headers.append("set-cookie", `${cookieName}=${sid}; Path=${issuerPath}; HttpOnly; SameSite=Lax`);
    return new Response(null, { status: 302, headers });
  }

  function clientAuth(request: Request, body: URLSearchParams): StandInClient | Response {
    const basic = request.headers.get("authorization");
    const inBody = body.has("client_secret");
    if (basic && inBody) {
      return oauthError("invalid_request", "Cannot supply multiple client credentials. Use one of the following: credentials in the Authorization header, credentials in the post body, or a client_assertion in the post body.");
    }
    let id: string;
    let secret: string;
    if (basic?.startsWith("Basic ")) {
      const [rawId = "", rawSecret = ""] = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":");
      id = decodeURIComponent(rawId.replace(/\+/g, " "));
      secret = decodeURIComponent(rawSecret.replace(/\+/g, " "));
    } else {
      id = body.get("client_id") ?? "";
      secret = body.get("client_secret") ?? "";
    }
    const client = clients.get(id);
    if (!client || client.clientSecret !== secret) return oauthError("invalid_client", "Client authentication failed.", 401);
    return client;
  }

  const oktaUser = (user: StandInUser) => ({
    id: user.id,
    status: user.status,
    profile: { login: user.email, email: user.email, firstName: user.firstName, lastName: user.lastName },
  });
  const oktaGroup = (group: { id: string; name: string; description: string }) => ({
    id: group.id,
    type: "OKTA_GROUP",
    profile: { name: group.name, description: group.description },
  });
  const notFound = () => json({ errorCode: "E0000007", errorSummary: "Not found: Resource not found", errorCauses: [] }, 404);

  /** Users and groups, the way Okta answers them. Everything else is a 404. */
  async function management(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("authorization") !== `SSWS ${options.managementToken}`) {
      return json({ errorCode: "E0000011", errorSummary: "Invalid token provided", errorCauses: [] }, 401);
    }
    const parts = url.pathname.split("/").slice(3).map(decodeURIComponent);
    const method = request.method;
    const findUser = (key: string) => users.get(key) ?? byLogin(key);

    if (parts[0] === "users" && parts.length === 1 && method === "POST") {
      const body = (await request.json()) as {
        profile: { login: string; email: string; firstName?: string; lastName?: string };
        credentials?: { password?: { value?: string } };
      };
      if (byLogin(body.profile.login)) {
        return json(
          {
            errorCode: "E0000001",
            errorSummary: "Api validation failed: login",
            errorCauses: [{ errorSummary: "login: An object with this field already exists in the current organization" }],
          },
          400,
        );
      }
      const id = userId();
      const user: StandInUser = {
        id,
        status: url.searchParams.get("activate") === "true" ? "ACTIVE" : "STAGED",
        email: body.profile.login.trim().toLowerCase(),
        password: body.credentials?.password?.value ?? "",
        firstName: body.profile.firstName ?? "",
        lastName: body.profile.lastName ?? "",
        groups: new Set(),
      };
      users.set(id, user);
      return json(oktaUser(user));
    }
    if (parts[0] === "users" && parts.length >= 2) {
      const user = findUser(parts[1]!);
      if (!user) return notFound();
      if (parts.length === 2 && method === "GET") return json(oktaUser(user));
      if (parts.length === 2 && method === "DELETE") {
        if (user.status !== "DEPROVISIONED") user.status = "DEPROVISIONED";
        else users.delete(user.id);
        return new Response(null, { status: 204 });
      }
      if (parts[2] === "lifecycle" && parts[3] === "deactivate" && method === "POST") {
        user.status = "DEPROVISIONED";
        return json({});
      }
      if (parts[2] === "groups" && method === "GET") return json([...user.groups].map((id) => oktaGroup(groups.get(id)!)));
    }
    if (parts[0] === "groups" && parts.length === 1 && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json([...groups.values()].filter((group) => group.name.toLowerCase().startsWith(q)).map(oktaGroup));
    }
    if (parts[0] === "groups" && parts.length === 1 && method === "POST") {
      const body = (await request.json()) as { profile: { name: string; description?: string } };
      const id = `00g${String(nextId++).padStart(17, "0")}`;
      groups.set(id, { id, name: body.profile.name, description: body.profile.description ?? "" });
      return json(oktaGroup(groups.get(id)!));
    }
    if (parts[0] === "groups" && parts[2] === "users") {
      const group = groups.get(parts[1]!);
      if (!group) return notFound();
      if (parts.length === 3 && method === "GET") {
        return json([...users.values()].filter((user) => user.groups.has(group.id)).map(oktaUser));
      }
      const user = findUser(parts[3] ?? "");
      if (!user) return notFound();
      if (method === "PUT") {
        user.groups.add(group.id);
        return new Response(null, { status: 204 });
      }
    }
    return notFound();
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      state.log.push(`${request.method} ${path}`);

      if (path.startsWith("/api/v1/") && options.managementToken !== undefined) return management(request, url);

      if (path === `${issuerPath}/.well-known/openid-configuration`) {
        return json({
          issuer: state.issuer,
          authorization_endpoint: state.endpoints.authorize,
          token_endpoint: state.endpoints.token,
          userinfo_endpoint: state.endpoints.userinfo,
          jwks_uri: state.endpoints.jwks,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          scopes_supported: ["openid", "profile", "email", "offline_access"],
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }

      if (path === `${issuerPath}/v1/keys`) return json({ keys: [publicJwk] });

      if (path === `${issuerPath}/v1/authorize` && request.method === "GET") {
        const refused = checkAuthorize(url.searchParams);
        if (refused) return refused;
        const prompt = url.searchParams.get("prompt") ?? "";
        state.prompts.push(prompt);
        const sid = /(?:^|;\s*)standin_sid=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
        const known = sid ? sessions.get(sid) : undefined;
        if (known && prompt !== "login" && people.has(known)) return issueCode(url.searchParams, known, null);
        return loginPage(url.searchParams.toString());
      }

      if (path === `${issuerPath}/v1/authorize` && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const params = new URLSearchParams(form.get("request") ?? "");
        const refused = checkAuthorize(params);
        if (refused) return refused;
        const email = (form.get("email") ?? "").trim().toLowerCase();
        const person = people.get(email);
        if (!person || person.password !== form.get("password")) {
          state.log.push(`refused: sign-in failed for ${email || "(no email)"}`);
          return loginPage(params.toString(), "Unable to sign in");
        }
        const sid = random();
        sessions.set(sid, email);
        return issueCode(params, email, sid);
      }

      if (path === `${issuerPath}/v1/token` && request.method === "POST") {
        const body = new URLSearchParams(await request.text());
        const client = clientAuth(request, body);
        if (client instanceof Response) return client;
        const grant = body.get("grant_type") ?? "";
        state.grants.push(grant);
        if (grant === "authorization_code") {
          const code = codes.get(body.get("code") ?? "");
          codes.delete(body.get("code") ?? "");
          if (!code || code.clientId !== client.clientId) return oauthError("invalid_grant", "The authorization code is invalid or has expired.");
          if (code.redirectUri !== body.get("redirect_uri")) return oauthError("invalid_grant", "redirect_uri does not match");
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.get("code_verifier") ?? ""));
          if (b64url(digest) !== code.challenge) return oauthError("invalid_grant", "PKCE verification failed.");
          return json(await tokens(client.clientId, code.email, code.scope, code.nonce));
        }
        if (grant === "refresh_token") {
          const presented = body.get("refresh_token") ?? "";
          const replayed = spent.get(presented);
          if (replayed !== undefined) revokeFamily(replayed);
          const held = refresh.get(presented);
          if (!held || held.clientId !== client.clientId || !people.has(held.email)) {
            return oauthError("invalid_grant", "The refresh token is invalid or expired.");
          }
          refresh.delete(presented);
          spent.set(presented, held.family);
          return json(await tokens(client.clientId, held.email, held.scope, null, held.family));
        }
        return oauthError("unsupported_grant_type", `${grant || "(none)"} is not supported`);
      }

      if (path === `${issuerPath}/v1/userinfo`) {
        if (state.failUserinfo !== null) return new Response(null, { status: state.failUserinfo });
        const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        let email: string | null = null;
        if (options.devTokens && bearer.startsWith("dev:")) email = bearer.slice(4).trim().toLowerCase() || null;
        else {
          const held = access.get(bearer);
          if (held && held.expires > Date.now() && people.has(held.email)) email = held.email;
        }
        if (!email) {
          state.log.push("refused: invalid_token at userinfo");
          return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
        }
        return json({
          sub: `00u${Buffer.from(email).toString("hex").slice(0, 17)}`,
          email,
          email_verified: true,
          name: people.get(email)?.name ?? email,
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  state.url = `http://${options.hostname ?? "127.0.0.1"}:${server.port}`;
  state.issuer = `${state.url}${issuerPath}`;
  state.endpoints = {
    authorize: `${state.issuer}/v1/authorize`,
    token: `${state.issuer}/v1/token`,
    userinfo: `${state.issuer}/v1/userinfo`,
    jwks: `${state.issuer}/v1/keys`,
  };
  return state;
}
