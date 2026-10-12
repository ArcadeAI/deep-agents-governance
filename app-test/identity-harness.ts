/**
 * What the identity suite runs against.
 *
 * The line between "real" and "stand-in" is drawn at the network edge:
 *
 * - **The identity provider is the OIDC stand-in** (`scripts/oidc-stand-in.ts`),
 *   which speaks what Okta's custom authorization server speaks: discovery,
 *   `authorize` with a login form and an SSO cookie, `token` with PKCE and
 *   `client_secret_basic`, `userinfo` and `keys`. One client, as in
 *   production, whose redirect URIs are this harness's callback and the Arcade
 *   stand-in's provider callback. Every sign-in in this suite is a real
 *   authorization-code + PKCE flow with a password typed into a login form, and
 *   `prompt=login` is measured against the stand-in's SSO cookie rather than
 *   assumed.
 * - **The web UI's handlers are real, behind a real server.** `Bun.serve` on
 *   a free port, routing to the same `auth/handlers.ts` functions `app/api/**`
 *   calls, which reach the provider over HTTP through its discovery document as
 *   they do in the app. Nothing is mocked: the suite drives them with a cookie
 *   jar over HTTP and asserts on the `Set-Cookie` headers a browser would
 *   actually get.
 * - **Arcade Cloud is a stand-in.** It serves `confirm_user` and a `next_uri`
 *   whose code is single-use, and one MCP tool endpoint the hop-2 regression
 *   calls `LoanDesk_SearchLoans` on. It is a stand-in because the real one
 *   needs a project API key and a human's dashboard field; the shape it
 *   imitates is the one spike #04 and #75 measured off the live service. There
 *   is no hop 1 to imitate: the agent calls the Engine directly with the
 *   project key, so no gateway OAuth runs in a browser.
 *
 * Every port is `:0` and read back. This worktree owns a block of ten and the
 * reviewer's owns a different block, so nothing here may pick a number.
 */
import { readWebConfig, type WebConfig } from "../lib/config.ts";
import {
  CHAT_PAGE,
  signin,
  signinCallback,
  signout,
  verify,
} from "../auth/handlers.ts";
import { freePort } from "./child.ts";
import { DEMO_CAST, DEMO_PEOPLE, TEST_OKTA_TOKEN } from "./demo-cast.ts";
import { forgetDiscovery } from "../auth/discovery.ts";
import { nonce, pkce } from "../auth/oidc.ts";
import { startOidcStandIn, type OidcStandIn } from "../scripts/oidc-stand-in.ts";

/**
 * The four demo people, as this harness seeds them (`demo-cast.ts`): the
 * fixture's addresses and the tests' own throwaway password. Nothing is seeded
 * by the app itself since #33.
 */
export const PEOPLE = {
  dana: { email: DEMO_CAST.dana.email, password: DEMO_CAST.dana.password },
  sam: { email: DEMO_CAST.sam.email, password: DEMO_CAST.sam.password },
  riley: { email: DEMO_CAST.riley.email, password: DEMO_CAST.riley.password },
  morgan: { email: DEMO_CAST.morgan.email, password: DEMO_CAST.morgan.password },
} as const;

export type PersonaKey = keyof typeof PEOPLE;

export const SESSION_SECRET = "identity-suite-session-secret-0123456789";
export const ARCADE_API_KEY = "identity-suite-arcade-key";
/** The MCP path the stand-in answers tool calls on. A fixture name; nothing registers it. */
export const GATEWAY_ID = "cg-demo-us";

// ---------------------------------------------------------------------------
// A browser, minus the browser
// ---------------------------------------------------------------------------

/**
 * A cookie jar and manual redirects.
 *
 * Flat across hosts on purpose: real browsers key cookies by host and ignore
 * the port, so `localhost:<web>` and `localhost:<idp>` genuinely do share a jar
 * on a developer's machine. Imitating that is what makes "the IdP's session
 * cookie is still here when the second sign-in starts" a real condition rather
 * than one the harness arranged away, which is the whole of the `prompt=login`
 * measurement.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  /** Every response, in order, as `status METHOD url` — what a redirect chain looked like. */
  readonly visited: string[] = [];
  /** Hosts that rendered a form. Which server asked for the password. */
  readonly pageHosts: string[] = [];

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    this.visited.push(`${response.status} ${init.method ?? "GET"} ${url.split("?")[0]}`);
    this.store(response);
    return response;
  }

  store(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0]!;
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /**
   * Walk a redirect chain, filling in whatever HTML form appears, until the
   * chain lands on a page with no form or on a path this caller is waiting for.
   *
   * `stopAt` is a substring rather than a full URL because the interesting stop
   * is usually a path on a host whose port is assigned at boot. `stopAtUrl` is
   * the exact one, for a stop (the app's `/`) that every other URL on the
   * chain would contain as a substring.
   */
  async follow(
    from: string,
    fill: (fields: Record<string, string>, html: string) => Record<string, string>,
    options: { stopAt?: string; stopAtUrl?: string; limit?: number } = {},
  ): Promise<{ url: string; response: Response; html: string }> {
    let url = from;
    for (let hop = 0; hop < (options.limit ?? 25); hop += 1) {
      const response = await this.fetch(url, { headers: { accept: "text/html" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`${response.status} with no Location at ${url}`);
        url = new URL(location, url).toString();
        if ((options.stopAt && url.includes(options.stopAt)) || url === options.stopAtUrl) {
          return { url, response, html: "" };
        }
        continue;
      }

      const html = await response.text();
      const form = parseForm(html);
      if (!form) return { url, response, html };

      this.pageHosts.push(new URL(url).host);
      const action = new URL(form.action || url, url).toString();
      const post = await this.fetch(action, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
        body: new URLSearchParams(fill(form.fields, html)).toString(),
      });
      const location = post.headers.get("location");
      if (!location) return { url: action, response: post, html: await post.text() };
      url = new URL(location, action).toString();
      if ((options.stopAt && url.includes(options.stopAt)) || url === options.stopAtUrl) {
        return { url, response: post, html: "" };
      }
    }
    throw new Error(`the chain from ${from} did not terminate`);
  }
}

interface ParsedForm {
  action: string;
  fields: Record<string, string>;
}

/**
 * HTML entities, back to characters. A browser does this and a regex does not,
 * and a hidden field carrying a query string arrives with every `&` as `&amp;`.
 */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&");
}

/** The pages here are server-rendered HTML with one form; a regex parse is enough. */
export function parseForm(html: string): ParsedForm | null {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(form[0])?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const match of form[1]!.matchAll(/<(?:input|button)\b[^>]*>/gi)) {
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1];
    if (!name) continue;
    fields[name] = unescapeHtml(/\bvalue\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1] ?? "");
  }
  return { action, fields };
}

// ---------------------------------------------------------------------------
// The Arcade stand-in
// ---------------------------------------------------------------------------

export interface ArcadeStandIn {
  url: string;
  /** Every `confirm_user` call, as Arcade received it. The identity assertion under test. */
  confirmations: Array<{ flow_id: string; user_id: string; authorized: boolean }>;
  /** `next_uri`s that were actually fetched. Measured on #75: the grant needs this. */
  nextUriFetches: string[];
  /**
   * What `next_uri` answers with.
   *
   * `continuation` is the live service's shape as #100 reads it: landing there
   * runs Arcade's provider exchange and 302s onward to a page that is *not*
   * `next_uri`. `terminal` is a 200 with no `Location`, which is the other end
   * of the range and the case where the verifier has nowhere left to send the
   * browser. Both have to leave the code redeemed exactly once.
   */
  nextUriAnswer: "continuation" | "terminal";
  /**
   * Every `next_uri` hit, as `flow_id` — including the replays #100 is about.
   *
   * Separate from `nextUriFetches`, which is deduplicated per flow, because the
   * bug is a *second* hit on a flow that already had one, and a list that folds
   * them together cannot see it.
   */
  nextUriHits: string[];
  /**
   * Every `Location` this stand-in answered a `next_uri` fetch with, in order.
   *
   * #118: the browser is never sent to any of them. A test asserting that has
   * to know what Arcade offered, and reconstructing it from the URL template
   * would be the test checking its own copy of the stand-in rather than the
   * stand-in — the same reason `nextUriOf` exists.
   */
  continuations: string[];
  /**
   * The `next_uri` this stand-in handed back for a flow.
   *
   * A test asserting "the browser was not sent to `next_uri`" has to know what
   * `next_uri` was, and reconstructing it from the URL template would be the
   * test asserting against its own copy of the stand-in rather than against the
   * stand-in.
   */
  nextUriOf(flowId: string): string | undefined;
  /** Force the next `confirm_user` to fail with this status and body. */
  failConfirm: { status: number; body: string } | null;
  /** Answer `confirm_user` without a `next_uri`. */
  omitNextUri: boolean;
  /**
   * Test-only view of a hop-2 grant. It intentionally carries identities, but
   * never an authorization code, access token, refresh token or URL value.
   * This is the observation that joins the verifier's confirmation to the
   * real IdP token/userinfo exchange below.
   */
  grantObservations: Array<{
    flow_id: string;
    confirmed_user_id: string;
    effective_user_id: string | null;
    finalized: boolean;
  }>;
  /** The later LoanDesk_SearchLoans auth decision, with no credential material. */
  loanSearchCalls: Array<{
    user_id: string;
    grant_flow_id: string | null;
    outcome: "grant" | "fresh_challenge";
  }>;
  /** Configure the identity provider used by the provider leg below. */
  configureIdpProvider(options: {
    endpoints: { authorize: string; token: string; userinfo: string };
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): void;
  /** The local provider's public client id; the secret never leaves the stand-in. */
  providerClientIdForTest(): string;
  /** Capture one provider code inside the harness; the code never leaves it. */
  bindProviderCode(flowId: string, authorizationState: string, codeVerifier: string): void;
  /** A tool-call bearer whose actor is the supplied test persona. */
  issueToolToken(email: string): string;
  /** Reset only the stand-in's provider grants between focused test cases. */
  clearToolGrantsForTest(): void;
  stop(): void;
}

/**
 * Arcade Cloud, as far as this slice can see it.
 *
 * Faithful where it matters and no further: `confirm_user` demands the project
 * API key, and the grant is only recorded once something fetches `next_uri`.
 * The focused `LoanDesk_SearchLoans` probe below is the one tool path modeled
 * here; all other tool execution remains absent because this harness does not
 * attempt to model the whole Engine.
 */
export function startArcadeStandIn(): ArcadeStandIn {
  const flows = new Map<
    string,
    {
      user_id: string;
      next_uri: string;
      authorized: boolean;
      redeemed: boolean;
      provider?: { code: string; codeVerifier: string };
      effective_user_id?: string | null;
    }
  >();
  const providerCodes = new Map<string, string>();
  const pendingProvider = new Map<string, { code: string; codeVerifier: string }>();
  const actors = new Map<string, string>();
  const grantsByUser = new Map<string, string>();
  let idpProvider: {
    endpoints: { authorize: string; token: string; userinfo: string };
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  } | null = null;

  /** Tool-call bearers the stand-in accepts. */
  const liveAccess = new Set<string>();

  const state: ArcadeStandIn = {
    url: "",
    confirmations: [],
    nextUriFetches: [],
    nextUriAnswer: "continuation",
    nextUriHits: [],
    continuations: [],
    nextUriOf: (flowId) => flows.get(flowId)?.next_uri,
    failConfirm: null,
    omitNextUri: false,
    grantObservations: [],
    loanSearchCalls: [],
    configureIdpProvider(options) {
      idpProvider = options;
    },
    providerClientIdForTest() {
      if (!idpProvider) throw new Error("the local IdP provider is not configured");
      return idpProvider.clientId;
    },
    bindProviderCode(flowId, authorizationState, codeVerifier) {
      const code = providerCodes.get(authorizationState);
      if (!code) throw new Error(`no local IdP authorization code captured for state ${authorizationState}`);
      const flow = flows.get(flowId);
      if (flow) flow.provider = { code, codeVerifier };
      else pendingProvider.set(flowId, { code, codeVerifier });
    },
    issueToolToken(email) {
      const token = `gw-tool-${crypto.randomUUID()}`;
      actors.set(token, email.trim().toLowerCase());
      liveAccess.add(token);
      return token;
    },
    clearToolGrantsForTest() {
      grantsByUser.clear();
    },
    stop: () => server.stop(true),
  };

  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;

      // The tool endpoint, as MCP. A bearer from `issueToolToken` names the
      // actor; anything else is refused.
      if (pathname === `/mcp/${GATEWAY_ID}`) {
        if (request.method !== "POST") return new Response(null, { status: 405 });

        const bearer = request.headers.get("authorization")?.replace(/^Bearer /i, "");
        if (!bearer || !liveAccess.has(bearer)) {
          return Response.json({ error: "invalid_token" }, { status: 401 });
        }

        const body = (await request.json()) as { id?: number; method?: string; params?: { name?: string } };
        if (body.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "LoanDesk_GetLoan",
                  description: "Read one loan file.",
                  inputSchema: {
                    type: "object",
                    properties: { loan_id: { type: "string" } },
                    required: ["loan_id"],
                    additionalProperties: false,
                  },
                },
              ],
            },
          });
        }
        if (body.method === "tools/call") {
          const toolName = body.params?.name;
          if (toolName === "LoanDesk_SearchLoans") {
            const actor = actors.get(bearer) ?? "";
            const grantFlowId = grantsByUser.get(actor) ?? null;
            state.loanSearchCalls.push({
              user_id: actor,
              grant_flow_id: grantFlowId,
              outcome: grantFlowId === null ? "fresh_challenge" : "grant",
            });
            if (grantFlowId === null) {
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        authorization_url: `${state.url}/oauth/authorize?tool=LoanDesk_SearchLoans`,
                        llm_instructions: "Authorize the tool and try again.",
                      }),
                    },
                  ],
                },
              });
            }
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ count: 1, loans: [{ loan_id: "LN-2291" }] }) }],
              },
            });
          }
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: `{"loan_id":"LN-2291","status":"pending"}` }] },
          });
        }
        // `capabilities` and `serverInfo` are not decoration: the MCP client
        // validates the `initialize` result and an incomplete one makes it fall
        // back to SSE and then give up, which reads as a transport failure
        // rather than as the malformed answer it is.
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "arcade-stand-in", version: "0.1.0" },
          },
        });
      }

      // Hop 2. The project API key is demanded, because the real one does.
      if (pathname === "/api/v1/oauth/confirm_user" && request.method === "POST") {
        if (request.headers.get("authorization") !== `Bearer ${ARCADE_API_KEY}`) {
          return new Response(JSON.stringify({ code: 401, msg: "Unauthorized" }), { status: 401 });
        }
        if (state.failConfirm) {
          const { status, body } = state.failConfirm;
          return new Response(body, { status });
        }
        const body = (await request.json()) as { flow_id?: string; user_id?: string };
        if (!body.flow_id || !body.user_id) {
          return new Response(JSON.stringify({ code: 400, msg: "Bad request" }), { status: 400 });
        }
        const nextUri = `${state.url}/api/v1/oauth/callback_success?flow_id=${encodeURIComponent(body.flow_id)}`;
        const provider = pendingProvider.get(body.flow_id);
        flows.set(body.flow_id, {
          user_id: body.user_id,
          next_uri: nextUri,
          authorized: false,
          redeemed: false,
          ...(provider ? { provider } : {}),
        });
        pendingProvider.delete(body.flow_id);
        state.confirmations.push({ flow_id: body.flow_id, user_id: body.user_id, authorized: false });
        return Response.json({
          auth_id: `auth_${body.flow_id}`,
          ...(state.omitNextUri ? {} : { next_uri: nextUri }),
        });
      }

      // Measured on #75: the grant is not finalised until something lands here.
      //
      // And measured on #100: the code behind it is single-use. This stand-in
      // redeems it the first time and refuses every hit after that, the way
      // Better Auth's token endpoint does — `invalid_grant "invalid code"`, and
      // the grant already made is revoked rather than left alone. Without the
      // refusal a replay is invisible here and a test asserting "one hit" is
      // asserting nothing about what a second one would cost.
      if (pathname === "/api/v1/oauth/callback_success") {
        const flowId = url.searchParams.get("flow_id") ?? "";
        state.nextUriHits.push(flowId);
        const flow = flows.get(flowId);
        if (!flow || flow.redeemed) {
          if (flow) {
            // `revokeTokensIssuedForAuthorizationCode`, in one line.
            flow.authorized = false;
            for (const confirmation of state.confirmations) {
              if (confirmation.flow_id === flowId) confirmation.authorized = false;
            }
          }
          return Response.json(
            { error: "invalid_grant", error_description: "invalid code" },
            { status: 400 },
          );
        }

        flow.redeemed = true;
        flow.authorized = true;
        state.nextUriFetches.push(flowId);

        // In the live path Arcade exchanges the provider code after the
        // verifier confirms the user. When a test binds a provider code
        // to this flow, perform that same server-to-server exchange here and
        // derive the effective identity from /userinfo. The ordinary identity
        // tests do not bind a code, so their narrower stand-in behavior stays
        // unchanged.
        if (flow.provider && idpProvider) {
          const formEncode = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
          const basic = Buffer.from(
            `${formEncode(idpProvider.clientId)}:${formEncode(idpProvider.clientSecret)}`,
          ).toString("base64");
          const tokenResponse = await fetch(idpProvider.endpoints.token, {
            method: "POST",
            headers: {
              authorization: `Basic ${basic}`,
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": "identity-harness/1.0",
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: flow.provider.code,
              redirect_uri: idpProvider.redirectUri,
              code_verifier: flow.provider.codeVerifier,
            }).toString(),
          });
          const token = (await tokenResponse.json().catch(() => null)) as
            | { access_token?: string }
            | null;
          let effective: string | null = null;
          if (tokenResponse.ok && typeof token?.access_token === "string") {
            const userinfo = await fetch(idpProvider.endpoints.userinfo, {
              headers: { authorization: `Bearer ${token.access_token}` },
            });
            const identity = (await userinfo.json().catch(() => null)) as { email?: string } | null;
            if (userinfo.ok && typeof identity?.email === "string") effective = identity.email.trim().toLowerCase();
          }
          flow.effective_user_id = effective;
          flow.authorized = effective === flow.user_id.trim().toLowerCase();
          state.grantObservations.push({
            flow_id: flowId,
            confirmed_user_id: flow.user_id,
            effective_user_id: effective,
            finalized: flow.authorized,
          });
          if (flow.authorized) grantsByUser.set(flow.user_id.trim().toLowerCase(), flowId);
        }

        for (const confirmation of state.confirmations) {
          if (confirmation.flow_id === flowId) confirmation.authorized = flow.authorized;
        }
        if (state.nextUriAnswer === "terminal") {
          return new Response("authorized", { headers: { "content-type": "text/plain" } });
        }
        // The continuation: somewhere that is not `next_uri`, carrying the
        // authorization leg's query string — which is why the verifier's log
        // line prints parameter names and not values.
        const continuation =
          `${state.url}/authorized?flow_id=${encodeURIComponent(flowId)}&code=s3cr3t-should-not-be-logged`;
        state.continuations.push(continuation);
        return new Response(null, { status: 302, headers: { location: continuation } });
      }

      // Where Arcade's continuation lands. Renders no form, so a browser
      // walking the chain stops here.
      if (pathname === "/idp/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (code && state) providerCodes.set(state, code);
        return Response.json({ received: Boolean(code && state) });
      }

      if (pathname === "/authorized") {
        return new Response("<!doctype html><p>Arcade: authorized", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  state.url = `http://localhost:${server.port}`;
  return state;
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

export interface IdentityHarness {
  webUrl: string;
  /** The identity provider's issuer, as the app is configured with it. */
  idpUrl: string;
  idp: OidcStandIn;
  arcade: ArcadeStandIn;
  config: WebConfig;
  /** Every request the identity provider served, and every refusal, one per line. */
  idpLog(): Promise<string>;
  stop(): Promise<void>;
}

export interface IdentityHarnessOptions {
  /**
   * Extra callback URLs the identity provider will accept for the app's
   * client.
   *
   * For a suite that serves the *pages* from its own `next dev` on its own
   * port rather than from this harness's handler server. The provider checks
   * the redirect URI against the registered list, as Okta does, so reserve
   * the port with `freePort()` first and pass the callback here.
   */
  extraWebRedirectUris?: readonly string[];
}

/** The one client the app and the provider leg share, as `bun run okta-setup` makes one. */
export const HARNESS_CLIENT_ID = "0oa-identity-suite";

export async function startIdentityHarness(
  options: IdentityHarnessOptions = {},
): Promise<IdentityHarness> {
  // Discovery is a module-level cache keyed by issuer, and every run of this
  // harness stands a new one up on a new port. Clearing it is what keeps one
  // suite's provider out of the next suite's flow.
  forgetDiscovery();

  const arcade = startArcadeStandIn();

  const webPort = freePort();
  const webUrl = `http://localhost:${webPort}`;

  const clientSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  const idp = await startOidcStandIn({
    people: DEMO_PEOPLE.map((person) => ({ name: person.name, email: person.email, password: person.password })),
    clients: [
      {
        clientId: HARNESS_CLIENT_ID,
        clientSecret,
        redirectUris: [
          `${webUrl}/api/auth/callback`,
          `${arcade.url}/idp/callback`,
          ...(options.extraWebRedirectUris ?? []),
        ],
      },
    ],
    managementToken: TEST_OKTA_TOKEN,
  });
  const idpUrl = idp.issuer;

  // The same client is the provider leg in the focused hop-2 regression, as
  // the `app-identity` provider is in production. The callback is a route on
  // the Arcade stand-in, so the browser captures the authorization code there
  // and the stand-in exchanges it at the token and userinfo endpoints during
  // next_uri finalization. No code or token is exposed by the harness API.
  arcade.configureIdpProvider({
    endpoints: idp.endpoints,
    clientId: HARNESS_CLIENT_ID,
    clientSecret,
    redirectUri: `${arcade.url}/idp/callback`,
  });

  const config = readWebConfig({
    ARCADE_API_URL: arcade.url,
    ARCADE_API_KEY: ARCADE_API_KEY,
    ARCADE_CLOUD_URL: arcade.url,
    APP_PUBLIC_HOST: `localhost:${webPort}`,
    IDP_ISSUER: idp.issuer,
    IDP_CLIENT_ID: HARNESS_CLIENT_ID,
    IDP_CLIENT_SECRET: clientSecret,
    SESSION_SECRET,
  });

  const web = Bun.serve({
    port: webPort,
    idleTimeout: 30,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/auth/signin") return signin(request, config);
      if (pathname === "/api/auth/callback") return signinCallback(request, config);
      if (pathname === "/api/auth/signout" && request.method === "POST") return signout(request, config);
      if (pathname === "/api/arcade/verify") return verify(request, config);
      // Stands in for the app shell: the landing page a completed sign-in
      // reaches. It renders no form, so the browser stops here.
      if (pathname === "/") return new Response("<!doctype html><p>home", { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });

  return {
    webUrl,
    idpUrl,
    idp,
    arcade,
    config,
    idpLog: async () => idp.log.join("\n"),
    async stop() {
      web.stop(true);
      arcade.stop();
      idp.stop();
      forgetDiscovery();
    },
  };
}

/**
 * Mint a provider authorization code at the identity provider, retaining it
 * only inside the Arcade stand-in until a flow's `next_uri` is finalized.
 */
export async function prepareProviderCode(
  browser: Browser,
  harness: IdentityHarness,
  persona: PersonaKey,
): Promise<{ authorizationState: string; codeVerifier: string }> {
  const { verifier, challenge } = await pkce();
  const authorizationState = nonce();
  const authorize = new URL(harness.idp.endpoints.authorize);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: harness.arcade.providerClientIdForTest(),
    redirect_uri: `${harness.arcade.url}/idp/callback`,
    scope: "openid email",
    state: authorizationState,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  await browser.follow(
    authorize.toString(),
    (fields) => ({
      ...fields,
      ...(fields.email !== undefined
        ? { email: PEOPLE[persona].email, password: PEOPLE[persona].password }
        : {}),
      ...(fields.decision !== undefined ? { decision: "allow" } : {}),
    }),
  );
  return { authorizationState, codeVerifier: verifier };
}

/**
 * Sign a persona in from scratch: press their button, land on the IdP, type the
 * password, and come back.
 *
 * Returns where the chain ended, so a caller can assert it reached the app
 * rather than an error page. `stopAtLanding` stops on the redirect to the app's
 * landing page (`CHAT_PAGE`) without fetching it: a booted app renders a
 * `Sign out` form there, and walking into it would sign the persona out again.
 */
export async function signInAs(
  browser: Browser,
  /** Where sign-in starts: this harness, or a booted app. */
  harness: Pick<IdentityHarness, "webUrl">,
  persona: PersonaKey,
  options: { from?: string; stopAt?: string; stopAtLanding?: boolean } = {},
): Promise<{ url: string; response: Response; html: string }> {
  const person = PEOPLE[persona];
  const landing = new URL(CHAT_PAGE, harness.webUrl).toString();
  return browser.follow(
    options.from ?? `${harness.webUrl}/api/auth/signin?persona=${persona}`,
    (fields) => {
      const filled: Record<string, string> = { ...fields };
      // The login form asks for an identifier and a password; a consent form,
      // if a provider shows one, does not. Filling by shape rather than by page
      // means this helper does not have to know how many pages it showed.
      if ("email" in fields) {
        filled.email = person.email;
        filled.password = person.password;
      }
      if ("decision" in fields) filled.decision = "allow";
      return filled;
    },
    {
      ...(options.stopAt !== undefined && { stopAt: options.stopAt }),
      ...(options.stopAtLanding && { stopAtUrl: landing }),
    },
  );
}
