/**
 * `bun run users` against the real app on a local port (#31, criterion 7):
 * the app under `next dev`, with its own `governance.db`, signing in through
 * the OIDC stand-in in place of Okta, and the command writing that database
 * and the stand-in's Management API while it runs.
 *
 *   1. a user `users add` created signs in at the identity provider with the
 *      password it printed;
 *   2. `/hooks/pre` holds them to the clearance they were given;
 *   3. `set-clearance` takes effect with no restart, within a policy poll;
 *   4. `remove` deletes them in the org, which ends their session there and
 *      their sign-in, and `/hooks/pre` then denies them as an identity nobody
 *      registered;
 *   5. an address never added is denied the same way;
 *   6. the app has no sign-up of its own: people exist because Okta has them.
 *
 * No Arcade and no Okta: every request is the one Arcade, Okta or a browser
 * would make.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { bootApp, type App } from "../test/app.ts";
import { childEnv } from "./child-env.ts";
import { spawnChild } from "./child.ts";
import { TEST_OKTA_TOKEN } from "./demo-cast.ts";

const ROOT = join(import.meta.dir, "..");
const HOOK_SECRET = `users-live-${crypto.randomUUID()}`;
const POLICY_POLL_MS = 250;
const EMAIL = "Rowan.Quill@Example.com";
const LOWER = EMAIL.toLowerCase();
const NOT_REGISTERED = "an administrator must register the identity";

let app: App;
let env: Record<string, string>;
let password = "";

async function users(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawnChild(["bun", "--no-env-file", "scripts/users.ts", ...args], {
    cwd: ROOT,
    env: childEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`users ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
  return { code, stdout, stderr };
}

const approve = (userId: string, amount: number) =>
  fetch(`${app.origin}/hooks/pre`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${HOOK_SECRET}` },
    body: JSON.stringify({
      execution_id: `tc_users_${crypto.randomUUID()}`,
      tool: { name: "ApproveLoan", toolkit: "LoanDesk", version: "1.0.0" },
      inputs: { loan_id: "LN-2299", amount },
      context: { authorization: [{}], user_id: userId },
    }),
  }).then((response) => response.json() as Promise<{ code: string; error_message?: string }>);

/** The authorize request the app sends a browser with, as a query string. */
async function authorizeQuery(): Promise<string> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  return new URLSearchParams({
    response_type: "code",
    client_id: app.identity.clientId,
    redirect_uri: `${app.origin}/api/auth/callback`,
    scope: "openid email",
    state: "users-live",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
}

/** Sign in at the identity provider's login form. A 302 back to the app is a success; the cookie is the IdP session. */
async function signIn(email: string, secret: string): Promise<{ status: number; cookie: string }> {
  const response = await fetch(app.identity.standIn.endpoints.authorize, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: await authorizeQuery(), email, password: secret }),
    redirect: "manual",
  });
  const cookie = response.headers
    .getSetCookie()
    .map((raw) => raw.split(";")[0]!)
    .join("; ");
  return { status: response.status, cookie };
}

/** Where the IdP sends a browser holding `cookie`: back to the app if its session is live, the login form if not. */
async function authorizeAs(cookie: string): Promise<"app" | "login"> {
  const response = await fetch(`${app.identity.standIn.endpoints.authorize}?${await authorizeQuery()}`, {
    headers: { cookie },
    redirect: "manual",
  });
  if (response.status === 302 && response.headers.get("location")!.startsWith(`${app.origin}/api/auth/callback?code=`)) return "app";
  expect(response.status).toBe(200);
  return "login";
}

beforeAll(async () => {
  app = await bootApp({ ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET, POLICY_POLL_MS: String(POLICY_POLL_MS) }, { cast: false });
  env = {
    GOVERNANCE_DB_PATH: app.databases.governance,
    OKTA_ORG_URL: app.identity.standIn.url,
    OKTA_API_TOKEN: TEST_OKTA_TOKEN,
  };
}, 240_000);

afterAll(async () => {
  await app?.stop();
});

describe("bun run users, against the running app", () => {
  let cookie = "";

  test("a user added with users add signs in with the password it printed", async () => {
    const added = await users(["add", EMAIL, "--name", "Rowan", "--role", "loan_officer", "--clearance", "50000"]);
    password = added.stdout.match(/^ {2}password {3}(\S+)$/m)![1]!;

    expect((await signIn(LOWER, `${password}x`)).status).toBe(401);

    const signedIn = await signIn(EMAIL, password);
    expect(signedIn.status).toBe(302);
    cookie = signedIn.cookie;
    expect(cookie).toContain("standin_sid=");
    // The session is live: authorize goes straight back to the app.
    expect(await authorizeAs(cookie)).toBe("app");
  });

  test("/hooks/pre holds them to their clearance", async () => {
    // The subject is new, so it is there once a policy poll has seen it.
    let over = await approve(LOWER, 60_000);
    const started = performance.now();
    while (over.error_message?.includes(NOT_REGISTERED) && performance.now() - started < 10 * POLICY_POLL_MS) {
      await Bun.sleep(25);
      over = await approve(LOWER, 60_000);
    }
    expect(over.code).toBe("CHECK_FAILED");
    expect(over.error_message).toContain("exceeds your approval authority of 50000");
    expect(await approve(LOWER, 50_000)).toEqual({ code: "OK" });
  });

  test("set-clearance takes effect without a restart, within one policy poll", async () => {
    await users(["set-clearance", LOWER, "75000"]);
    const changed = performance.now();
    let answer = await approve(LOWER, 60_000);
    while (answer.code !== "OK" && performance.now() - changed < 10 * POLICY_POLL_MS) {
      await Bun.sleep(25);
      answer = await approve(LOWER, 60_000);
    }
    const elapsed = performance.now() - changed;
    console.log(`[users-live] set-clearance 50000 -> 75000 visible to /hooks/pre after ${Math.round(elapsed)}ms`);
    expect(answer).toEqual({ code: "OK" });
    // One poll, plus the request that noticed it.
    expect(elapsed).toBeLessThan(2 * POLICY_POLL_MS + 250);
    const over = await approve(LOWER, 80_000);
    expect(over.error_message).toContain("exceeds your approval authority of 75000");
  });

  test("a removed user loses their session and their sign-in, and /hooks/pre denies them", async () => {
    const removed = await users(["remove", LOWER]);
    expect(removed.stdout).toContain("deactivated and deleted in Okta");

    expect(await authorizeAs(cookie)).toBe("login");
    expect((await signIn(LOWER, password)).status).toBe(401);

    let answer = await approve(LOWER, 1);
    const started = performance.now();
    while (answer.code === "OK" && performance.now() - started < 10 * POLICY_POLL_MS) {
      await Bun.sleep(25);
      answer = await approve(LOWER, 1);
    }
    expect(answer.code).toBe("CHECK_FAILED");
    expect(answer.error_message).toContain(NOT_REGISTERED);
  });

  test("an email that was never added is denied as unregistered", async () => {
    const answer = await approve("never.added@example.com", 1);
    expect(answer.code).toBe("CHECK_FAILED");
    expect(answer.error_message).toContain(NOT_REGISTERED);
  });

  test("the app has no sign-up of its own", async () => {
    for (const path of ["/sign-up/email", "/api/auth/sign-up/email"]) {
      const response = await fetch(`${app.origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: app.origin },
        body: JSON.stringify({ email: "walk.in@example.com", password: "Walk-In-Pass-1", name: "Walk In" }),
      });
      expect(response.status).toBe(404);
    }
    expect((await signIn("walk.in@example.com", "Walk-In-Pass-1")).status).toBe(401);
  });
});
