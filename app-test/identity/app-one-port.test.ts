/**
 * The identity provider, end to end, in the real app on the app's one port
 * (#6, criteria 6 and 3). No Arcade: every request below is the one Arcade's
 * custom OAuth provider would make for hop 2, made by this file.
 *
 *   1. discovery names the app's own origin as issuer and every endpoint on it;
 *   2. `authorize` → the app's `/login` → its `/consent` → a code;
 *   3. `token` with the demo's #79 client authentication: an `Authorization:
 *      Basic` header **and** the same `client_id`/`client_secret` in the body,
 *      which is what Arcade's dashboard template sends and what a strict
 *      reading of RFC 6749 §2.3 refuses;
 *   4. `userinfo` names the persona by email, lowercase — the persona's
 *      address is configured capitalised here, so a lowercase answer is the
 *      provider's doing and not the fixture's;
 *   5. the code, presented again, is refused `invalid_grant`, and the token
 *      the first exchange minted still works at `userinfo` — the replay guard
 *      (`replay-tolerance.ts`, DESIGN.md open risk 3) on Better Auth 1.7.5,
 *      over the wire. The app's log says it kept the rows, which is the line
 *      that only appears when Better Auth's own
 *      `revokeTokensIssuedForAuthorizationCode` was about to delete them.
 *
 * Every URL is asserted to be on the app's port: one port, one origin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnChild } from "../child.ts";
import { bootApp, type App } from "../../test/app.ts";
import { childEnv } from "../child-env.ts";
import { runUsers } from "../demo-cast.ts";

const REPO = join(import.meta.dir, "..", "..");
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const CONFIGURED_EMAIL = "Alice.Officer@Bank.Example";
/** This test's own throwaway password, given to `bun run users add` (#33: nothing is seeded). */
const PASSWORD = "one-port-test-password";

let app: App;
let data: string;
let client: { client_id: string; client_secret: string };
/** Every URL this file asked the app for, so "one port" is a fact rather than a hope. */
const asked: string[] = [];

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  asked.push(url);
  return fetch(url, { ...init, redirect: "manual" });
}

/** A cookie jar, for the login and consent pages. */
const jar = new Map<string, string>();
async function browse(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jar.size > 0) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
  const response = await call(url, { ...init, headers });
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair!.indexOf("=");
    jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
  return response;
}

beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), "cg-one-port-"));
  const env = {
    // Freshly random, environment-only, gone with the process (#6's one
    // permitted secret).
    BETTER_AUTH_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
    IDP_DB_PATH: join(data, "idp.db"),
    IDP_OAUTH_REDIRECT_URIS: REDIRECT_URI,
  };
  app = await bootApp(env);

  // Nobody is seeded (#33), so the person is added the way an operator adds
  // one, capitalised as a human would type it, into the files the app has open.
  const added = await runUsers(
    ["add", CONFIGURED_EMAIL, "--name", "Alice", "--role", "loan_officer", "--clearance", "50000", "--password", PASSWORD],
    { idp: env.IDP_DB_PATH, governance: app.databases.governance },
  );
  if (added.code !== 0) throw new Error(`users add exited ${added.code}:\n${added.out}\n${added.err}`);

  // The `arcade` client's secret is stored hashed and was never printed, so
  // mint a readable one the way a developer does, against the app's idp.db.
  const rotate = spawnChild(["bun", "scripts/identity/oauth-client.ts", "--json", "--rotate"], {
    cwd: REPO,
    env: childEnv({ ...env, APP_PUBLIC_HOST: app.host, NODE_ENV: "test" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(rotate.stdout).text(),
    new Response(rotate.stderr).text(),
    rotate.exited,
  ]);
  if (code !== 0) throw new Error(`oauth-client --rotate exited ${code}: ${err}`);
  client = JSON.parse(out) as { client_id: string; client_secret: string };
}, 240_000);

afterAll(async () => {
  await app?.stop();
  if (data) rmSync(data, { recursive: true, force: true });
});

describe("the identity provider, on the app's own port", () => {
  let code = "";
  let verifier = "";
  let accessToken = "";

  test("discovery names the app as issuer, and every endpoint on the app", async () => {
    const response = await call(`${app.origin}/.well-known/openid-configuration`);
    expect(response.status).toBe(200);
    const discovery = (await response.json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      issuer: app.origin,
      authorization_endpoint: `${app.origin}/oauth2/authorize`,
      token_endpoint: `${app.origin}/oauth2/token`,
      userinfo_endpoint: `${app.origin}/oauth2/userinfo`,
      jwks_uri: `${app.origin}/jwks`,
    });
    expect(discovery.id_token_signing_alg_values_supported).toContain("RS256");
  });

  test("authorize, the app's own login and consent, and a code", async () => {
    verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");

    const authorize = await browse(
      `${app.origin}/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        scope: "openid email",
        state: "one-port",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    );
    expect(authorize.status).toBe(302);
    const toLogin = new URL(authorize.headers.get("location")!, app.origin);
    expect(`${toLogin.origin}${toLogin.pathname}`).toBe(`${app.origin}/login`);

    const loginPage = await browse(toLogin.toString());
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain('name="password"');

    const login = await browse(`${app.origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: CONFIGURED_EMAIL, password: PASSWORD, oauth_query: toLogin.search.slice(1) }),
    });
    expect(login.status).toBe(303);
    const toConsent = new URL(login.headers.get("location")!, app.origin);
    expect(`${toConsent.origin}${toConsent.pathname}`).toBe(`${app.origin}/consent`);

    const consent = await browse(`${app.origin}/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ decision: "allow", oauth_query: toConsent.search.slice(1) }),
    });
    expect(consent.status).toBe(303);
    const back = new URL(consent.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    expect(back.searchParams.get("state")).toBe("one-port");
    code = back.searchParams.get("code") ?? "";
    expect(code).not.toBe("");
  });

  /** The token request exactly as Arcade's custom provider sends it (#79). */
  const exchange = () => {
    const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    return call(`${app.origin}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${half(client.client_id)}:${half(client.client_secret)}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: client.client_secret,
      }),
    });
  };

  test("token, with Basic and the same credentials in the body", async () => {
    const response = await exchange();
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as { access_token: string; id_token: string };
    accessToken = tokens.access_token;
    expect(accessToken).not.toBe("");
    // The ID token is the app's, RS256, and names the person by lowercase email.
    const [header, payload] = tokens.id_token
      .split(".")
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe(app.origin);
    expect(payload.email).toBe(CONFIGURED_EMAIL.toLowerCase());
  });

  test("userinfo names the persona by their lowercase email", async () => {
    const response = await call(`${app.origin}/oauth2/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(response.status).toBe(200);
    const userinfo = (await response.json()) as { sub: string; email: string };
    expect(userinfo.email).toBe("alice.officer@bank.example");
    expect(userinfo.email).not.toBe(CONFIGURED_EMAIL);
  });

  test("a replayed code is refused invalid_grant, and the first exchange's token keeps working", async () => {
    const replay = await exchange();
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");

    const still = await call(`${app.origin}/oauth2/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(still.status).toBe(200);
    expect(((await still.json()) as { email: string }).email).toBe("alice.officer@bank.example");

    // Better Auth reached `revokeTokensIssuedForAuthorizationCode` and the
    // guard kept the rows: this line is written only when it did.
    const output = app.output();
    expect(output).toMatch(/\[idp\] replay revocation refused: kept \d+ oauthAccessToken rows? minted by the first exchange/);
    expect(output).toContain("code_state=already_consumed");
  });

  // The #52 live test's sign-in, with a stale IDP_CLIENT_ID (#54): the plugin
  // cannot send the error back to a client it does not know, so it sends the
  // browser to its own `/error`, which was a 404 until #54.
  test("a client the provider does not hold lands on the app's /error page, which shows the error and its description", async () => {
    const authorize = await browse(
      `${app.origin}/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "a-client-from-an-older-clone",
        redirect_uri: REDIRECT_URI,
        scope: "openid email",
        state: "stale-client",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      })}`,
    );
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get("location")!, app.origin);
    expect(`${location.origin}${location.pathname}`).toBe(`${app.origin}/error`);
    expect(location.searchParams.get("error")).toBe("invalid_client");

    const page = await call(location.toString());
    const html = await page.text();
    console.log(`[one-port] GET ${location.pathname}${location.search} -> ${page.status}\n${html.replace(/<style>[\s\S]*<\/style>/, "")}`);
    expect(page.status).toBe(400);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Sign-in stopped");
    expect(html).toContain(`<code>invalid_client</code>: ${location.searchParams.get("error_description")}`);
    expect(location.searchParams.get("error_description")).toBe("client_id is required");
    expect(html).toContain("IDP_CLIENT_ID");
  });

  // The code is the query string's, so anybody can type one, and a name
  // Object.prototype holds answered 500 (the #54 review).
  test("an /error code that names an Object.prototype member gets the page too, with the generic hint", async () => {
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "no_such_code"]) {
      const page = await call(`${app.origin}/error?${new URLSearchParams({ error: code, error_description: "typed by hand" })}`);
      const html = await page.text();
      expect({ code, status: page.status }).toEqual({ code, status: 400 });
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(html).toContain(`<code>${code}</code>: typed by hand`);
      expect(html).toContain("Start the sign-in again from the app.");
    }
  });

  test("and every request above went to the app's one port", () => {
    expect(asked.length).toBeGreaterThan(8);
    expect([...new Set(asked.map((url) => new URL(url).host))]).toEqual([app.host]);
  });
});
