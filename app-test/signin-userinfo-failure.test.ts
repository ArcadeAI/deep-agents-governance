/**
 * What the sign-in callback tells a person when the userinfo endpoint does not
 * yield an email.
 *
 * #166 is the reason this file exists. Alice could not sign in on the live
 * deployment and the page told her **"The identity provider returned no
 * email"** — which was not true. The provider had said nothing about email; it
 * had answered `429 Too many requests`, because the loan screens' 2-second
 * poll had filled its quota. The real answer was in the body underneath the
 * heading the whole time, and the heading sent whoever read it to look at the
 * IdP's user records instead of at the poll. #151 was the same mistake in
 * another fault surface: a screen asserting something that did not occur.
 *
 * So these drive the real handler against a provider that fails in each of
 * the three different ways, and assert on what the page *says*.
 *
 * The provider is a small issuer served on a port of its own: a discovery
 * document, a token endpoint and a userinfo endpoint whose answer each test
 * chooses. The handler finds the last two through the first, as it finds
 * Okta's.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { readIdentitySurface } from "../lib/config.ts";
import { signinCallback } from "../auth/handlers.ts";
import { forgetDiscovery } from "../auth/discovery.ts";
import { SIGNIN_COOKIE, writeLeg, type SigninLeg } from "../auth/session.ts";

const SESSION_SECRET = "userinfo-failure-suite-secret-0123456789";
const STATE = "state-from-this-browser";

/** How the stand-in provider answers userinfo for the next request. */
let userinfoAnswer: { status: number; body: string; contentType?: string } = {
  status: 200,
  body: JSON.stringify({ sub: "alice", email: "alice@bank.example" }),
};

const idp = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const issuer = `http://127.0.0.1:${idp.port}/oauth2/default`;
    if (pathname === "/oauth2/default/.well-known/openid-configuration") {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/v1/authorize`,
        token_endpoint: `${issuer}/v1/token`,
        userinfo_endpoint: `${issuer}/v1/userinfo`,
        jwks_uri: `${issuer}/v1/keys`,
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (pathname === "/oauth2/default/v1/token") {
      await request.text();
      return Response.json({ access_token: "at-alice", token_type: "Bearer", expires_in: 3600 });
    }
    if (pathname === "/oauth2/default/v1/userinfo") {
      return new Response(userinfoAnswer.body, {
        status: userinfoAnswer.status,
        headers: { "content-type": userinfoAnswer.contentType ?? "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const config = readIdentitySurface({
  APP_PUBLIC_HOST: "localhost:3999",
  IDP_ISSUER: `http://127.0.0.1:${idp.port}/oauth2/default`,
  IDP_CLIENT_ID: "client-c",
  IDP_CLIENT_SECRET: "client-c-secret",
  SESSION_SECRET,
});

afterAll(() => {
  idp.stop(true);
  forgetDiscovery();
});

afterEach(() => {
  userinfoAnswer = { status: 200, body: JSON.stringify({ sub: "alice", email: "alice@bank.example" }) };
});

/** A browser mid-sign-in: the sealed leg cookie the callback expects to find. */
async function callback(): Promise<Response> {
  const leg: SigninLeg = { state: STATE, verifier: "a".repeat(43), next: "/" };
  const sealed = new Headers();
  await writeLeg(sealed, SIGNIN_COOKIE, leg, config);
  const cookie = sealed.getSetCookie()[0]!.split(";")[0]!;

  return signinCallback(
    new Request(`http://localhost:3999/api/auth/callback?code=code-from-idp&state=${STATE}`, {
      headers: { cookie },
    }),
    config,
  );
}

describe("when userinfo will not name the person", () => {
  test("a 429 says it is a 429, and does not claim anything about email", async () => {
    userinfoAnswer = { status: 429, body: '{"message":"Too many requests. Please try again later."}' };

    const response = await callback();
    const html = await response.text();

    expect(response.status).toBe(502);
    // The claim #166 was actually about. The IdP said nothing about email and
    // the page must not put words in its mouth.
    expect(html).not.toContain("returned no email");
    expect(html).toContain("refusing requests");
    expect(html).toContain("429");
    // The body it really sent, still shown underneath.
    expect(html).toContain("Too many requests");
    // And the part that stops someone debugging the wrong hop: the exchange
    // before this one worked.
    expect(html).toContain("token exchange succeeded");
  });

  test("some other refusal names its status rather than guessing", async () => {
    userinfoAnswer = { status: 503, body: "upstream unavailable" };

    const html = await (await callback()).text();

    expect(html).not.toContain("returned no email");
    expect(html).toContain("HTTP 503");
    expect(html).toContain("upstream unavailable");
  });

  test("an answer with no email claim is the one case that still says so", async () => {
    userinfoAnswer = { status: 200, body: JSON.stringify({ sub: "alice" }) };

    const response = await callback();
    const html = await response.text();

    expect(response.status).toBe(502);
    expect(html).toContain("The identity provider returned no email");
    expect(html).toContain("no <code>email</code>");
  });

  test("an answer that is not JSON says that, rather than blaming the email claim", async () => {
    userinfoAnswer = { status: 200, body: "<html>maintenance</html>", contentType: "text/html" };

    const html = await (await callback()).text();

    expect(html).not.toContain("returned no email");
    expect(html).toContain("could not be read");
    // Escaped, not rendered: this is a counterparty's string.
    expect(html).toContain("&lt;html&gt;maintenance");
  });

  test("a provider that answers normally still signs the person in", async () => {
    const response = await callback();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });
});
