/**
 * A real user survives `bun run reset` (#32).
 *
 * Before #32 a reset replaced every `subjects` row in `governance.db` from the
 * fixture. That was right while the cast was only ever the fixture's. Since
 * #31 an operator adds people with `bun run users`, and a reset meant to put
 * the *demo* back would have deleted every one of them: their role gone, and
 * every governed call they made afterwards refused as an identity nobody
 * registered.
 *
 * The app is booted the way a presenter runs it (`test/app.ts`), with nobody
 * in it (#33), and its identity provider is the OIDC stand-in with nobody in
 * it either. The demo cast is added with `bun run users seed-demo` and a
 * person with `bun run users add` itself (#31), each a subprocess writing to
 * the stand-in's Management API, as it writes to Okta's, and to the
 * `governance.db` the running app has open. Bob is removed with
 * `bun run users remove` and brought back with `bun run users seed-demo`, the
 * same way. The reset command then runs as a subprocess, and what survived is
 * read back over HTTP: a sign-in at the identity provider with the password
 * she was given, a `/hooks/pre` decision on her clearance, the roster the
 * pages read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { spawnChild } from "../app-test/child.ts";
import { runUsers } from "../app-test/demo-cast.ts";
import { Browser } from "../app-test/identity-harness.ts";
import { pkce } from "../auth/oidc.ts";
import { bootApp, type App } from "./app.ts";

const ROOT = join(import.meta.dir, "..");
const RESET_TOKEN = "real-users-reset-token-for-tests";
const HOOK_SECRET = "real-users-hook-secret-for-tests";
const STORE_TOKEN = "real-users-store-token-for-tests";
/** This file's own throwaway password for the demo cast, handed to `seed-demo`. Meets Okta's default policy. */
const DEMO_PASSWORD = "Real-Users-Cast-32";

/** The demo cast's addresses on this app: the fixture's, which is what makes them the demo cast's (#33). */
const ALICE = "alice@bank.example";
const BOB = "bob@bank.example";
const CHARLIE = "charlie@bank.example";

/** Somebody `bun run users add` put in: over Alice's limit, with authority for the $95K. */
const PRIYA = {
  email: "priya@company.test",
  name: "Priya",
  password: "Chose-This-One-31",
  role: "vp_credit",
  clearance: 400_000,
};

let app: App;

async function runReset(args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const proc = spawnChild(["bun", join(ROOT, "scripts", "reset.ts"), ...args], {
    cwd: ROOT,
    env: { ...process.env, RESET_TOKEN, APP_PUBLIC_HOST: app.host },
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

/** `bun run users …` (#31), run the way an operator runs it, against this app's identity provider and `governance.db`. */
async function users(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const result = await runUsers(args, { standIn: app.identity.standIn, governance: app.databases.governance });
  if (result.code !== 0) throw new Error(`bun run users ${args.join(" ")} exited ${result.code}:\n${result.out}\n${result.err}`);
  return result;
}

/** The app's own readiness page, which carries `fixture_drift` (DESIGN.md → Readiness). */
async function drift(): Promise<{ ids: string[]; changed: string[]; missing: string[] } | null> {
  const body = (await (await fetch(`${app.origin}/health`)).json()) as { fixture_drift: never };
  return body.fixture_drift;
}

/** Waits for a condition the policy cache reaches on its next poll. */
async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(100);
  }
  throw new Error("the control plane never served the change that was written");
}

/** Waits a policy poll or two for the cache to see a write made from another connection. */
async function untilDrift(predicate: (value: Awaited<ReturnType<typeof drift>>) => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate(await drift())) return;
    await Bun.sleep(100);
  }
  throw new Error(`fixture_drift never reached the expected state: ${JSON.stringify(await drift())}`);
}

/**
 * A sign-in at the identity provider, as the app starts one: authorize with
 * `prompt=login` under the app's client, the password typed into the login
 * form, and a code back at the app's callback. True when a code came back.
 */
async function signIn(email: string, password: string): Promise<boolean> {
  const callback = `${app.origin}/api/auth/callback`;
  const { challenge } = await pkce();
  const authorize = new URL(app.identity.standIn.endpoints.authorize);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: app.identity.clientId,
    redirect_uri: callback,
    scope: "openid email",
    state: crypto.randomUUID(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "login",
  }).toString();
  const landed = await new Browser().follow(
    authorize.toString(),
    (fields) => ({ ...fields, email, password }),
    { stopAt: callback, limit: 4 },
  );
  return landed.url.startsWith(callback) && new URL(landed.url).searchParams.has("code");
}

/** The person the identity provider holds at this address, as its Management API would list them. */
function identityOf(email: string): { firstName: string; status: string } | undefined {
  return [...app.identity.standIn.users.values()].find((user) => user.email === email);
}

/** A `/hooks/pre` decision for this person approving the $95K. */
async function approve95k(userId: string): Promise<unknown> {
  const response = await fetch(`${app.origin}/hooks/pre`, {
    method: "POST",
    headers: { authorization: `Bearer ${HOOK_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      execution_id: `tc_${crypto.randomUUID()}`,
      tool: { name: "ApproveLoan", toolkit: "LoanDesk", version: "1.0.0" },
      inputs: { loan_id: "LN-2291", amount: 95_000 },
      context: { authorization: [{}], user_id: userId },
    }),
  });
  return response.json();
}

interface RosterEntry {
  user_id: string;
  display_name: string;
  role: string;
  clearance: number;
  attributes: Record<string, unknown>;
}

/** The roster the pages read (`auth/roster.ts`). */
async function roster(): Promise<RosterEntry[]> {
  const response = await fetch(`${app.origin}/api/approvals/roster`, {
    headers: { authorization: `Bearer ${STORE_TOKEN}` },
  });
  return ((await response.json()) as { subjects: RosterEntry[] }).subjects;
}

async function priyaInRoster(): Promise<RosterEntry | undefined> {
  return (await roster()).find((entry) => entry.user_id === PRIYA.email);
}

const EXPECTED_PRIYA_ROW: RosterEntry = {
  user_id: PRIYA.email,
  display_name: PRIYA.name,
  role: PRIYA.role,
  clearance: PRIYA.clearance,
  attributes: {},
};

/** One row of `bun run users list`, by address. */
async function listed(email: string): Promise<string | undefined> {
  const { out } = await users(["list"]);
  return out.split("\n").find((line) => line.startsWith(`${email} `));
}

beforeAll(async () => {
  app = await bootApp(
    { RESET_TOKEN, ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET, APPROVALS_STORE_TOKEN: STORE_TOKEN },
    { cast: false },
  );

  // A first boot seeds nobody (#33). The demo cast comes in the way an
  // operator brings it in, at the fixture's addresses.
  const seeded = await users([
    "seed-demo", "--alice", ALICE, "--bob", BOB, "--charlie", CHARLIE,
    "--michael", "michael@bank.example", "--password", DEMO_PASSWORD,
  ]);
  expect(seeded.out).toContain(`Alice: added ${ALICE}`);
  expect(seeded.out).not.toContain("real user");

  await users([
    "add", PRIYA.email, "--name", PRIYA.name, "--role", PRIYA.role,
    "--clearance", String(PRIYA.clearance), "--password", PRIYA.password,
  ]);
  await until(async () => (await priyaInRoster()) !== undefined);
}, 240_000);

afterAll(async () => {
  await app?.stop();
});

describe("before any reset, the added user is a user", () => {
  test("she signs in, and the control plane decides on her clearance", async () => {
    expect(await signIn(PRIYA.email, PRIYA.password)).toBe(true);
    expect(await signIn(PRIYA.email, DEMO_PASSWORD)).toBe(false);
    expect(await approve95k(PRIYA.email)).toEqual({ code: "OK" });
    // And the $95K is still over Alice's limit, so the allow above is Priya's
    // clearance and not a policy that permits everybody.
    expect(await approve95k(ALICE)).toMatchObject({ code: "CHECK_FAILED" });
  });
});

describe("drift, with a user `bun run users add` created (#32)", () => {
  test("she is not drift, and a hand-edited demo row beside her still is", async () => {
    await untilDrift((value) => value === null);

    const governance = new Database(app.databases.governance);
    governance.run("UPDATE subjects SET clearance = 250000 WHERE user_id = ?", [ALICE]);
    governance.close();
    await untilDrift((value) => value !== null);
    const found = await drift();
    expect(found?.ids).toEqual([`subjects:${ALICE}`]);
    expect(found?.changed).toEqual([`subjects:${ALICE}`]);

    // Put back by hand, so the next test starts from the fixture.
    const back = new Database(app.databases.governance);
    back.run("UPDATE subjects SET clearance = 50000 WHERE user_id = ?", [ALICE]);
    back.close();
    await untilDrift((value) => value === null);
  }, 60_000);

  // Changed by #33: a demo row that is absent is not fixture drift, and a
  // reset does not add anybody. That Charlie can still sign in with no
  // subject is what `bun run users list` names.
  test("a demo row deleted by hand is not fixture drift, a reset does not add it back, and `users list` names it", async () => {
    const governance = new Database(app.databases.governance);
    governance.run("DELETE FROM subjects WHERE user_id = ?", [CHARLIE]);
    governance.close();
    await until(async () => !(await roster()).some((entry) => entry.user_id === CHARLIE));
    expect(await drift()).toBeNull();
    expect(await listed(CHARLIE)).toContain("in Okta, but has no subject: denied at every hook");

    const { code, out } = await runReset();
    expect(code).toBe(0);
    const hooksLine = out.split("\n").find((line) => line.startsWith("[reset] hooks "));
    expect(hooksLine).toContain(`demo cast's subjects put back to the demo's roles and clearances (${ALICE}, ${BOB}, michael@bank.example)`);
    expect((await roster()).some((entry) => entry.user_id === CHARLIE)).toBe(false);

    // Put back the way an operator would, so the next test starts whole.
    const back = new Database(app.databases.governance);
    back.run(
      "INSERT INTO subjects (user_id, display_name, role, clearance, attributes) VALUES (?, 'Charlie', 'vp_credit', 250000, '{}')",
      [CHARLIE],
    );
    back.close();
    await until(async () => (await roster()).some((entry) => entry.user_id === CHARLIE));
    expect(await drift()).toBeNull();

    // And the other direction: a subject with nobody who can sign in as it,
    // which approval routing could still pick.
    const GHOST = "ghost@company.test";
    const ghost = new Database(app.databases.governance);
    ghost.run(
      "INSERT INTO subjects (user_id, display_name, role, clearance, attributes) VALUES (?, 'Ghost', 'vp_credit', 300000, '{}')",
      [GHOST],
    );
    ghost.close();
    expect(await listed(GHOST)).toContain("has a subject, but no identity in Okta: signs in as a shared persona, or not at all");
    const gone = new Database(app.databases.governance);
    gone.run("DELETE FROM subjects WHERE user_id = ?", [GHOST]);
    gone.close();
  }, 60_000);
});

describe("`bun run reset` keeps her", () => {
  test("her subjects row is untouched, she is still served, and the output names her", async () => {
    // A stage edit to a demo row, which this reset is meant to undo.
    const governance = new Database(app.databases.governance);
    governance.run("UPDATE subjects SET clearance = 250000 WHERE user_id = ?", [ALICE]);
    governance.close();

    const { code, out, err } = await runReset();
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain(`1 added by \`bun run users\` kept (${PRIYA.email})`);

    expect(await priyaInRoster()).toEqual(EXPECTED_PRIYA_ROW);
    expect((await roster()).find((entry) => entry.user_id === ALICE)?.clearance).toBe(50_000);
    expect(await approve95k(PRIYA.email)).toEqual({ code: "OK" });
    // Identity is Okta's, and the reset never touches it.
    expect(await signIn(PRIYA.email, PRIYA.password)).toBe(true);
    expect(identityOf(PRIYA.email)?.firstName).toBe(PRIYA.name);

    // And her row is not drift, so /health is not degraded by her existing.
    const health = (await (await fetch(`${app.origin}/hooks/health`)).json()) as { fixture_drift: unknown };
    expect(health.fixture_drift).toBeNull();
  }, 60_000);

  test("`--hard` is refused, and nothing is touched", async () => {
    const { code, out, err } = await runReset(["--hard"]);
    expect(code).toBe(78);
    expect(out).toBe("");
    expect(err).toContain("--hard is not an option any more");
    expect(await priyaInRoster()).toEqual(EXPECTED_PRIYA_ROW);
    expect(await signIn(PRIYA.email, PRIYA.password)).toBe(true);
  });
});

describe("Bob, removed and brought back", () => {
  test("Bob removed with `bun run users remove` has neither half after a reset, and is not drift", async () => {
    const { out: removed } = await users(["remove", BOB]);
    expect(removed).toContain("deactivated and deleted in Okta");
    expect(identityOf(BOB)).toBeUndefined();
    // Served from the policy cache, which sees the removal on its next poll.
    await until(async () => !(await roster()).some((entry) => entry.user_id === BOB));
    // A removal recorded in subject_changes is intent, not drift.
    await untilDrift((value) => value === null);

    const { code, out } = await runReset();
    expect(code).toBe(0);
    const hooksLine = out.split("\n").find((line) => line.startsWith("[reset] hooks "));
    // Changed by #33: the line names the demo cast it put back, which is
    // everybody on disk but Bob, instead of naming Bob as removed.
    expect(hooksLine).toContain(`demo cast's subjects put back to the demo's roles and clearances (${ALICE}, ${CHARLIE}, michael@bank.example)`);
    expect(hooksLine).not.toContain(BOB);

    expect(identityOf(BOB)).toBeUndefined();
    expect((await roster()).some((entry) => entry.user_id === BOB)).toBe(false);
    expect(await signIn(BOB, DEMO_PASSWORD)).toBe(false);
    expect(await drift()).toBeNull();
    expect(await signIn(PRIYA.email, PRIYA.password)).toBe(true);
  }, 90_000);

  test("Bob removed, then `bun run users seed-demo`, is back as a user with no drift", async () => {
    const { out } = await users([
      "seed-demo", "--alice", ALICE, "--bob", BOB, "--charlie", CHARLIE,
      "--michael", "michael@bank.example", "--password", "Back-Again-2026",
    ]);
    expect(out).toContain(`Bob: added ${BOB}`);
    await until(async () => (await roster()).some((entry) => entry.user_id === BOB));
    await untilDrift((value) => value === null);
    expect((await roster()).find((entry) => entry.user_id === BOB)?.role).toBe("credit_analyst");
    expect(await signIn(BOB, "Back-Again-2026")).toBe(true);

    // Present again, so the reset treats him as the demo cast once more.
    const { code, out: resetOut } = await runReset();
    expect(code).toBe(0);
    expect(resetOut).toContain(
      `demo cast's subjects put back to the demo's roles and clearances (${ALICE}, ${BOB}, ${CHARLIE}, michael@bank.example)`,
    );
    expect((await roster()).some((entry) => entry.user_id === BOB)).toBe(true);
    expect(await drift()).toBeNull();
  }, 90_000);
});
