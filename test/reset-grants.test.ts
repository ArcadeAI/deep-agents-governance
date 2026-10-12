/**
 * #123: what a reset does to a grant a persona is already holding.
 *
 * The decision recorded on #123 is that **between takes** (`bun run reset`) a
 * grant a persona already holds **still works afterwards**, so nobody is
 * signed out and nobody has to authorize again, and the loan book and the
 * control plane are still put back, so it is a real reset and not a no-op.
 *
 * With Okta as the identity provider that is structural rather than chosen:
 * people, sessions and tokens live in Okta, and the reset command holds no
 * Okta credential. `--hard`, which used to reset the bundled provider and sign
 * everyone out on purpose (#174), is refused by name, and this file pins that
 * the refusal leaves the grant alive too.
 *
 * ## What this file does not claim
 *
 * Whether **Arcade** presents a stale token or raises an authorization card
 * instead is Arcade's decision, it is not measurable without the project
 * credential, and it is not what is being tested. What these tests pin is our
 * own half: which tokens survive a reset, because that is what
 * `scripts/reset.ts` controls.
 *
 * ## A real token
 *
 * The app signs in through an OIDC stand-in (`test/app.ts`), and the token
 * here is minted through its whole authorize flow (login form, code, PKCE,
 * token) under a client of its own, the way Arcade's `app-identity` provider
 * holds one. Every assertion goes through a **write**
 * (`POST /loans/…/approve`). Reads may be answered from `actorFromRequest`'s
 * 60-second memory (#167) and a read that passed after a reset would prove
 * nothing; a write re-reads userinfo every time, by design.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

// The demo cast as the tests seed it (#33: the app seeds nobody): the
// fixture's own addresses, the tests' own throwaway password.
import { DEMO_CAST, seedDemoSubjects } from "../app-test/demo-cast.ts";
import { Browser } from "../app-test/identity-harness.ts";
import { pkce } from "../auth/oidc.ts";
import { spawnChild } from "../app-test/child.ts";
import { bootApp, type App } from "./app.ts";

const ROOT = join(import.meta.dir, "..");
const RESET_TOKEN = "reset-grants-token-for-tests";
const HOOK_SECRET = "reset-grants-hook-secret-for-tests";
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const CLIENT = { clientId: "0oa-arcade-test", clientSecret: "reset-grants-client-secret", redirectUris: [REDIRECT_URI] };
const OVER_LIMIT_LOAN = "LN-2291";

const alice = DEMO_CAST.dana;

let app: App;
/** The access token Arcade would be holding: minted once, never re-minted. */
let arcadeToken = "";

const hooks = { get baseUrl() { return app.origin; } };
const loanApp = { get baseUrl() { return `${app.origin}/bank`; } };

/** The command, run the way a presenter runs it. */
async function runResetCommand(args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const proc = spawnChild(["bun", join(ROOT, "scripts", "reset.ts"), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      RESET_TOKEN,
      APP_PUBLIC_HOST: app.host,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/** Alice's hop-2 access token, through the whole flow: authorize, login, code, token. */
async function authorizeAlice(): Promise<string> {
  const { endpoints } = app.identity.standIn;
  const { verifier, challenge } = await pkce();
  const authorize = new URL(endpoints.authorize);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid email",
    state: `state-${crypto.randomUUID()}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const landed = await new Browser().follow(
    authorize.toString(),
    (fields) => ({ ...fields, email: alice.email, password: alice.password }),
    { stopAt: REDIRECT_URI },
  );
  const code = new URL(landed.url).searchParams.get("code");
  expect(code).toBeTruthy();

  // HTTP Basic, form-encoded: the shape Arcade sends (#61).
  const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  const basic = `Basic ${Buffer.from(`${half(CLIENT.clientId)}:${half(CLIENT.clientSecret)}`).toString("base64")}`;
  const token = await fetch(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token: string };
  expect(body.access_token).toBeTruthy();
  return body.access_token;
}

/**
 * A governed write, made the way the `Loans` toolkit makes it: the persona's
 * bearer and nothing else. A write rather than a read on purpose; see the
 * note at the top of this file.
 */
function approveAsArcade(): Promise<Response> {
  return fetch(`${loanApp.baseUrl}/loans/${OVER_LIMIT_LOAN}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${arcadeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ amount: 95_000 }),
  });
}

const loanStatus = async (): Promise<string> =>
  (
    (await (
      await fetch(`${loanApp.baseUrl}/loans/${OVER_LIMIT_LOAN}`, {
        headers: { authorization: `Bearer ${arcadeToken}` },
      })
    ).json()) as { status: string }
  ).status;

beforeAll(async () => {
  app = await bootApp({ RESET_TOKEN, ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET });
  app.identity.standIn.addClient(CLIENT);
  // The demo cast's subjects, as `bun run users seed-demo` writes them, into
  // the file the running app has open. The people are already in the stand-in.
  seedDemoSubjects(app.databases.governance);

  arcadeToken = await authorizeAlice();
}, 240_000);

afterAll(async () => {
  await app?.stop();
});

describe("a reset between takes leaves every persona's grant alive", () => {
  test("the grant Arcade holds still works after `bun run reset`", async () => {
    // The premise: it works before the reset. Asserted rather than assumed, so
    // a failure below means the reset broke it and not that it never worked.
    expect((await approveAsArcade()).status).toBe(200);

    const { code, err } = await runResetCommand();
    expect(err).toBe("");
    expect(code).toBe(0);

    // The same token, unchanged, on a write, which always re-reads userinfo,
    // so no remembered answer can make this pass.
    expect((await approveAsArcade()).status).toBe(200);
  });

  test("and it is still a real reset: the loan book and the control plane went back", async () => {
    expect((await approveAsArcade()).status).toBe(200);
    expect(await loanStatus()).toBe("approved");

    expect((await runResetCommand()).code).toBe(0);

    expect(await loanStatus()).toBe("pending");
    const health = (await (await fetch(`${hooks.baseUrl}/hooks/health`)).json()) as {
      audit_rows: number;
      counts: Record<string, number>;
    };
    expect(health.audit_rows).toBe(0);
    expect(health.counts.grants).toBe(0);
    expect(health.counts.policy_rules).toBeGreaterThan(0);
  });

  test("the reset never calls the identity provider", async () => {
    const before = app.identity.standIn.log.length;
    expect((await runResetCommand()).code).toBe(0);
    expect(app.identity.standIn.log.slice(before)).toEqual([]);
    expect(app.identity.standIn.users.size).toBeGreaterThanOrEqual(4);
  });
});

describe("the panel's Reset button leaves identity alone too", () => {
  test("`demo` mode does not disturb a grant", async () => {
    expect((await approveAsArcade()).status).toBe(200);

    // Exactly the request `lib/governance/control-plane.ts`'s `runReset` sends
    // for the `demo` mode: one address, one body.
    const pressed = await fetch(`${hooks.baseUrl}/hooks/admin/reset`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${RESET_TOKEN}` },
      body: JSON.stringify({ mode: "demo" }),
    });
    expect(pressed.status).toBe(200);

    const health = (await (await fetch(`${hooks.baseUrl}/hooks/health`)).json()) as { audit_rows: number };
    expect(health.audit_rows).toBe(0);
    expect((await approveAsArcade()).status).toBe(200);

    expect((await runResetCommand()).code).toBe(0);
  });
});

describe("--hard is refused, and the refusal changes nothing", () => {
  test("nothing runs, and the grant still works", async () => {
    expect((await approveAsArcade()).status).toBe(200);
    expect(await loanStatus()).toBe("approved");

    const { code, out, err } = await runResetCommand(["--hard"]);
    expect(code).toBe(78);
    expect(out).toBe("");
    expect(err).toContain("Clear User Sessions");

    // Refused before anything ran: the book is as it was, and so is the grant.
    expect(await loanStatus()).toBe("approved");
    expect((await approveAsArcade()).status).toBe(200);

    expect((await runResetCommand()).code).toBe(0);
  });
});
