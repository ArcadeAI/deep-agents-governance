/**
 * `bun run reset`: the single command, end to end against the real app and
 * both of its databases.
 *
 * The app booted the way a presenter runs it (`test/app.ts`), on a port the OS
 * handed out, with its own `governance.db` and `loans.db` in a temporary
 * directory, signing in through an OIDC stand-in. The command runs as a
 * **subprocess**, exactly as a presenter runs it between takes, and everything
 * is then read back over the modules' own HTTP surfaces. Nothing here opens a
 * `.db` file: a test that read the disk could pass against a module that never
 * noticed the rows moved.
 *
 * The claims #23 is about, in the order they would go wrong:
 *
 *   1. one command, seconds, and afterwards LN-2291 is unapproved, the grants
 *      and approval requests and the audit log are empty, and the four policy
 *      tables are the fixture's;
 *   2. it is safe to run repeatedly: run it twice, assert identical state;
 *   3. identity is not touched: people and sessions live in Okta, and
 *      `--hard`, which used to reset the bundled provider, is refused by name.
 *
 * The loan module reads the actor off the identity provider's userinfo
 * endpoint, and the stand-in here accepts `Bearer dev:<email>` there, so one
 * loan can be read without walking an authorize flow, which is
 * `app-test/identity-flow.test.ts`'s job.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { freePort, spawnChild } from "../app-test/child.ts";
import { runUsers } from "../app-test/demo-cast.ts";
import { bootApp, type App } from "./app.ts";

const ROOT = join(import.meta.dir, "..");
const RESET_TOKEN = "root-reset-token-for-tests";
const HOOK_SECRET = "root-reset-hook-secret-for-tests";
const DANA = "alice@example.test";
const OVER_LIMIT_LOAN = "LN-2291";

interface LoanBody {
  loan_id: string;
  status: string;
  decisions: unknown[];
}

interface HooksHealth {
  reset: string;
  counts: Record<string, number>;
  audit_rows: number;
  fixture_drift: unknown;
}

interface LoanHealth {
  reset: string;
  loans: number;
}

let app: App;

/** The two modules, each at its own paths on the one app. */
const hooks = { get baseUrl() { return app.origin; } };
const loanApp = { get baseUrl() { return `${app.origin}/bank`; } };

/** The command, run the way a presenter runs it. */
async function runResetCommand(
  overrides: Record<string, string> = {},
  args: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const proc = spawnChild(["bun", join(ROOT, "scripts", "reset.ts"), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      RESET_TOKEN,
      APP_PUBLIC_HOST: app.host,
      ...overrides,
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

const json = async <T>(url: string, init?: RequestInit): Promise<T> =>
  (await (await fetch(url, init)).json()) as T;

const hooksHealth = () => json<HooksHealth>(`${hooks.baseUrl}/hooks/health`);
const loanHealth = () => json<LoanHealth>(`${loanApp.baseUrl}/health`);
const loan = (id: string) =>
  json<LoanBody>(`${loanApp.baseUrl}/loans/${id}`, {
    headers: { authorization: `Bearer dev:${DANA}` },
  });

/** One `/pre` call, which is the cheapest honest way to put a row in the audit log. */
async function governedCall(executionId: string): Promise<Response> {
  return fetch(`${hooks.baseUrl}/hooks/pre`, {
    method: "POST",
    headers: { authorization: `Bearer ${HOOK_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      execution_id: executionId,
      tool: { name: "ApproveLoan", toolkit: "LoanDesk", version: "1.0.0" },
      inputs: { loan_id: OVER_LIMIT_LOAN, amount: 95_000 },
      context: { authorization: [{}], user_id: DANA },
    }),
  });
}

/** Everything the reset is supposed to put back, read through HTTP. */
async function snapshot() {
  const [hooksBody, loanBody, record, control] = await Promise.all([
    hooksHealth(),
    loanHealth(),
    loan(OVER_LIMIT_LOAN),
    loan("LN-2299"),
  ]);
  return {
    counts: hooksBody.counts,
    audit_rows: hooksBody.audit_rows,
    fixture_drift: hooksBody.fixture_drift,
    loans: loanBody.loans,
    record,
    control,
  };
}

beforeAll(async () => {
  app = await bootApp({
    RESET_TOKEN,
    ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
  });

  // A first boot seeds nobody (#33). The loan officer this file acts as is
  // added the way an operator adds one: into the identity provider, and into
  // the `governance.db` the app has open.
  const added = await runUsers(
    ["add", DANA, "--name", "Alice", "--role", "loan_officer", "--clearance", "50000", "--password", "Root-Reset-Test-23"],
    { standIn: app.identity.standIn, governance: app.databases.governance },
  );
  if (added.code !== 0) throw new Error(`users add exited ${added.code}:\n${added.out}\n${added.err}`);
}, 240_000);

afterAll(async () => {
  await app?.stop();
});

describe("one command, two databases", () => {
  let seeded: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    // A clean baseline first, so "back to the seeded state" is compared
    // against a reading rather than against a constant this file made up.
    expect((await runResetCommand()).code).toBe(0);
    seeded = await snapshot();
  });

  test("a take of the demo is undone", async () => {
    // Dirty both: an approved loan, and audit rows.
    const approved = await fetch(`${loanApp.baseUrl}/loans/${OVER_LIMIT_LOAN}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer dev:${DANA}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: 95_000 }),
    });
    expect(approved.status).toBe(200);
    for (const n of [1, 2, 3]) expect((await governedCall(`tc_reset_${n}`)).status).toBe(200);

    const dirty = await snapshot();
    expect(dirty.record.status).toBe("approved");
    expect(dirty.audit_rows).toBeGreaterThan(seeded.audit_rows);

    const { code, out, err } = await runResetCommand();
    expect(err).toBe("");
    expect(code).toBe(0);

    // One line per service, each naming what moved, and nothing about identity.
    expect(out).not.toMatch(/\[reset\] idp/);
    expect(out).toMatch(/\[reset\] hooks\s+OK\s+demo at revision \d+ .*audit_log \d+→0/);
    expect(out).toMatch(/\[reset\] loan-app\s+OK\s+loans \d+→\d+, decisions \d+→\d+/);

    const after = await snapshot();
    expect(after.record.status).toBe("pending");
    expect(after.record).toEqual(seeded.record);
    expect(after.audit_rows).toBe(0);
    expect(after.counts.grants).toBe(0);
    expect(after.counts.approval_requests).toBe(0);
    expect(after.counts.audit_log).toBe(0);
    // The policy is the fixture's, said by the service rather than counted here.
    expect(after.fixture_drift).toBeNull();
  });

  test("it is safe to run repeatedly — twice leaves identical state", async () => {
    expect((await runResetCommand()).code).toBe(0);
    const once = await snapshot();

    expect((await runResetCommand()).code).toBe(0);
    const twice = await snapshot();

    expect(twice).toEqual(once);
  });

  test("no orphaned grants or approval requests are left behind", async () => {
    await runResetCommand();
    const { counts } = await hooksHealth();
    expect(counts.grants).toBe(0);
    expect(counts.approval_requests).toBe(0);
    // And the four tables the demo runs on are populated, not merely empty —
    // a reset that truncated everything would satisfy the two lines above.
    expect(counts.subjects).toBeGreaterThan(0);
    expect(counts.policy_rules).toBeGreaterThan(0);
    expect(counts.output_rules).toBe(2);
  });

  test("identity is left alone: the provider is never called", async () => {
    const before = app.identity.standIn.log.length;
    expect((await runResetCommand()).code).toBe(0);
    // The app reads the actor at userinfo for the loan reads above, but the
    // reset itself makes no call to the identity provider at all.
    expect(app.identity.standIn.log.slice(before)).toEqual([]);
  });

  test("it finishes in seconds, not minutes", async () => {
    const started = performance.now();
    expect((await runResetCommand()).code).toBe(0);
    // Generous on purpose: the claim is "between takes", not a benchmark, and
    // a threshold tight enough to be interesting would be a flake on a loaded
    // CI box. What this catches is a reset that went back to waiting on a
    // deploy.
    expect(performance.now() - started).toBeLessThan(30_000);
  });

  test("every module reports that its reset route exists", async () => {
    const [hooksBody, loanBody] = await Promise.all([hooksHealth(), loanHealth()]);
    expect([hooksBody.reset, loanBody.reset]).toEqual(["enabled", "enabled"]);
  });
});

describe("when it cannot do its job it says so and exits non-zero", () => {
  test("a wrong RESET_TOKEN is a failure, not a quiet no-op", async () => {
    const { code, out } = await runResetCommand({ RESET_TOKEN: "not-the-token" });
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSED");
    expect(out).toContain("different RESET_TOKEN");
    expect(out).toContain("The demo is NOT in a known state");
  });

  test("an unset RESET_TOKEN names the variable and exits EX_CONFIG", async () => {
    const { code, err } = await runResetCommand({ RESET_TOKEN: "" });
    expect(code).toBe(78);
    expect(err).toContain("RESET_TOKEN is unset");
  });

  test("a bare service name is refused before anything is reset", async () => {
    const { code, err } = await runResetCommand({ APP_PUBLIC_HOST: "cg-hooks" });
    expect(code).toBe(78);
    expect(err).toContain("APP_PUBLIC_HOST=cg-hooks");
    expect(err).toContain("has no dot and is not loopback");
  });

  /**
   * There is one host, so an unreachable app is every module unreachable at
   * once; every module is still attempted, and each says so on its own line,
   * so a presenter reads every problem in one run rather than one per run.
   */
  test("an unreachable app is reported for every module, and the command still tries each", async () => {
    const dead = `127.0.0.1:${freePort()}`;
    const { code, out } = await runResetCommand({ APP_PUBLIC_HOST: dead });
    expect(code).not.toBe(0);
    expect(out).toMatch(/\[reset\] hooks\s+UNREACHABLE/);
    expect(out).toMatch(/\[reset\] loan-app\s+UNREACHABLE/);
  });

  test("--hard is refused, in any spelling, and says how to sign somebody out instead", async () => {
    for (const args of [["--hard"], ["--hard-reset"], ["-hard"]]) {
      const { code, out, err } = await runResetCommand({}, args);
      expect(code).toBe(78);
      expect(err).toContain("--hard is not an option any more");
      expect(err).toContain("Okta");
      expect(err).toContain("Clear User Sessions");
      // Refused before anything ran, not after.
      expect(out).toBe("");
    }
  });

  /**
   * Until #11, `--target` chose between this checkout and the stage demo's
   * hosted deployment, and this test refused a value it did not know. The flag
   * is gone, and still refused, in either spelling: a presenter who typed it
   * expects some other environment to be reset, and quietly resetting this
   * checkout's app instead would be the half-reset believed clean.
   */
  test("--target is refused, and the refusal names the one address there is", async () => {
    for (const args of [["--target", "staging"], ["--target=local"]]) {
      const { code, out, err } = await runResetCommand({}, args);
      expect(code).toBe(78);
      expect(err).toContain("--target is not an option");
      expect(err).toContain("APP_PUBLIC_HOST");
      // Refused before anything ran, not after.
      expect(out).toBe("");
    }
  });
});
