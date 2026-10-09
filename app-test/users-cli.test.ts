/**
 * `bun run users` (#31), driven the way a person drives it: the command, in a
 * child process, against a fresh `governance.db` and a fresh Okta org, read
 * back afterwards.
 *
 * The org is the OIDC stand-in with its Management API slice switched on
 * (`scripts/oidc-stand-in.ts`), so every call the command makes is the call it
 * would make to Okta, and every user it creates can sign in at the stand-in's
 * authorize endpoint. What the app does with the rows (sign-in, `/hooks/pre`,
 * the policy poll) is `users-live.test.ts`. This file is the command's own
 * contract: both halves or neither, the role read from the policy, every
 * change recorded, and the password held to Okta's policy and never kept.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type OidcStandIn, startOidcStandIn } from "../scripts/oidc-stand-in.ts";
import { passwordProblem } from "../scripts/okta/people.ts";
import { USERS_GROUP } from "../scripts/okta/setup.ts";
import { childEnv } from "./child-env.ts";
import { spawnChild } from "./child.ts";

const ROOT = join(import.meta.dir, "..");
const INVITE = "Arcade dashboard (https://api.arcade.dev/dashboard), your project, Members: invite";
const MANAGEMENT_TOKEN = `users-cli-${crypto.randomUUID()}`;

const scratch = mkdtempSync(join(tmpdir(), "cg-users-cli-"));
let dir = "";
let okta: OidcStandIn;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(async () => {
  dir = mkdtempSync(join(scratch, "case-"));
  okta = await startOidcStandIn({ managementToken: MANAGEMENT_TOKEN });
});

afterEach(() => okta.stop());

const governancePath = () => join(dir, "governance.db");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The command, with nothing from this checkout's `.env` files: `--no-env-file`,
 * and an allowlisted environment naming this case's database and org.
 */
async function users(args: string[], stdin?: string, env: Record<string, string> = {}): Promise<Run> {
  const child = spawnChild(["bun", "--no-env-file", "scripts/users.ts", ...args], {
    cwd: ROOT,
    env: childEnv({ GOVERNANCE_DB_PATH: governancePath(), OKTA_ORG_URL: okta.url, OKTA_API_TOKEN: MANAGEMENT_TOKEN, ...env }),
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function ok(args: string[], stdin?: string): Promise<Run> {
  const run = await users(args, stdin);
  if (run.code !== 0) throw new Error(`users ${args.join(" ")} exited ${run.code}\n${run.stdout}\n${run.stderr}`);
  return run;
}

function query<T>(sql: string, ...params: string[]): T[] {
  const db = new Database(governancePath(), { readonly: true });
  try {
    return db.query<T, string[]>(sql).all(...params);
  } finally {
    db.close();
  }
}

/** The Okta user with this login, as the org holds them. */
const person = (email: string) => [...okta.users.values()].find((user) => user.email === email);
/** Whether they are in the group `bun run users` keeps the people it made in. */
const ours = (email: string) => {
  const group = [...okta.groups.values()].find((each) => each.name === USERS_GROUP);
  return group !== undefined && person(email)?.groups.has(group.id) === true;
};
const subject = (email: string) =>
  query<{ user_id: string; display_name: string; role: string; clearance: number }>(
    "SELECT user_id, display_name, role, clearance FROM subjects WHERE user_id = ?",
    email,
  )[0];
const changes = (email?: string) =>
  query<Record<string, string | number | null>>(
    email === undefined ? "SELECT * FROM subject_changes ORDER BY seq" : "SELECT * FROM subject_changes WHERE user_id = ? ORDER BY seq",
    ...(email === undefined ? [] : [email]),
  );
const counts = () => ({
  people: okta.users.size,
  subjects: query<{ n: number }>("SELECT COUNT(*) AS n FROM subjects")[0]!.n,
  changes: query<{ n: number }>("SELECT COUNT(*) AS n FROM subject_changes")[0]!.n,
});

/** Opens the database once, the way the app's first boot would, so a refusal test has something to compare. */
async function bootstrap(): Promise<void> {
  await ok(["list"]);
}

/** The generated password `add` printed. */
function printedPassword(stdout: string): string {
  const match = stdout.match(/^ {2}password {3}(\S+)$/m);
  if (!match) throw new Error(`no password line in:\n${stdout}`);
  return match[1]!;
}

/** Raw bytes of a database and its WAL, so "not on disk" covers pages not yet checkpointed. */
function onDisk(path: string): string {
  return ["", "-wal", "-shm"]
    .map((suffix) => (existsSync(path + suffix) ? readFileSync(path + suffix).toString("latin1") : ""))
    .join("");
}

function plant(sql: string): void {
  const db = new Database(governancePath());
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe("users add", () => {
  test("creates the Okta user and the subject, lowercased, and prints the change row", async () => {
    const run = await ok(["add", "Dana.Lee@Example.COM", "--name", "Dana Lee", "--role", "loan_officer", "--clearance", "75000"]);

    const who = person("dana.lee@example.com");
    expect(who).toMatchObject({ status: "ACTIVE", firstName: "Dana", lastName: "Lee" });
    expect(ours("dana.lee@example.com")).toBe(true);

    expect(subject("dana.lee@example.com")).toEqual({
      user_id: "dana.lee@example.com",
      display_name: "Dana Lee",
      role: "loan_officer",
      clearance: 75000,
    });

    const [row] = changes("dana.lee@example.com");
    expect(row).toMatchObject({
      action: "add",
      role_before: null,
      role_after: "loan_officer",
      clearance_before: null,
      clearance_after: 75000,
    });
    expect(String(row!.id)).toMatch(/^chg_[0-9a-z]{10}$/);
    expect(String(row!.actor)).toStartWith("cli:");
    // The row it wrote is the row it printed.
    expect(run.stdout).toContain(
      `subject_changes #${row!.seq} ${row!.id} at ${row!.ts} by ${row!.actor}: add dana.lee@example.com, ` +
        `role (none) -> loan_officer, clearance (none) -> 75000`,
    );
  });

  test("a generated password is printed once, meets Okta's policy, is the one Okta got, and is nowhere on disk", async () => {
    const run = await ok(["add", "erin@example.com", "--name", "Erin", "--role", "vp_credit", "--clearance", "250000"]);
    const password = printedPassword(run.stdout);
    expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(passwordProblem(password, "erin@example.com")).toBeNull();
    expect(run.stdout.split(password)).toHaveLength(2);
    expect(run.stderr).not.toContain(password);
    expect(person("erin@example.com")?.password).toBe(password);
    expect(onDisk(governancePath())).not.toContain(password);
  });

  test("--password is used as given and not echoed", async () => {
    const given = "Granite-Harbor-42";
    const run = await ok(["add", "finn@example.com", "--name", "Finn", "--role", "loan_officer", "--clearance", "1000", "--password", given]);
    expect(run.stdout).not.toContain(given);
    expect(run.stdout).not.toMatch(/^ {2}password /m);
    expect(person("finn@example.com")?.password).toBe(given);
  });

  test("a --password Okta's default policy would refuse is refused first, naming the rule, and nothing is written", async () => {
    await bootstrap();
    const before = counts();
    const cases: Array<[string, string]> = [
      ["correct-horse-battery", "needs an uppercase letter"],
      ["Short-1", "must be 8 to 72 characters"],
      ["Gabriel-Example-9", 'must not contain part of the username ("example")'],
    ];
    for (const [password, why] of cases) {
      const run = await users(["add", "gabe@example.com", "--name", "Gabe", "--role", "loan_officer", "--clearance", "5", "--password", password]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(why);
      expect(run.stderr).not.toContain(password);
    }
    expect(counts()).toEqual(before);
  });

  test("without --role it refuses before writing anything", async () => {
    await bootstrap();
    const before = counts();
    const run = await users(["add", "gil@example.com", "--name", "Gil", "--clearance", "5"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--role is required");
    expect(counts()).toEqual(before);
    expect(person("gil@example.com")).toBeUndefined();
  });

  test("a role the policy does not know is refused, naming the ones it does, and nothing is written", async () => {
    await bootstrap();
    const before = counts();
    const run = await users(["add", "gil@example.com", "--name", "Gil", "--role", "janitor", "--clearance", "5"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      'role "janitor" is not one the policy knows: chief_credit_officer, credit_analyst, loan_officer, vp_credit',
    );
    expect(counts()).toEqual(before);
  });

  test("the roles come from the policy: a role a rule names is accepted, and a role outlives its last holder", async () => {
    await bootstrap();
    plant(
      `INSERT INTO policy_rules (id, description, hook, toolkit, tool, subjects, conditions, effect, reason, priority)
       VALUES ('access.auditors-cannot-see-deny', '', 'access', 'LoanDesk', 'DenyLoan',
               '{"user_ids":null,"roles":["auditor"],"clearance_below":null,"clearance_at_least":null}',
               '[]', 'deny', 'Auditors do not deny loans.', 20)`,
    );
    await ok(["add", "hana@example.com", "--name", "Hana", "--role", "auditor", "--clearance", "0"]);
    expect(subject("hana@example.com")?.role).toBe("auditor");

    // Every loan officer gone from governance.db: the role is still the fixture's.
    plant("DELETE FROM subjects WHERE role = 'loan_officer'");
    await ok(["add", "ivan@example.com", "--name", "Ivan", "--role", "loan_officer", "--clearance", "10"]);
  });

  test("--clearance defaults to 0 for credit_analyst only, and must be a non-negative whole number", async () => {
    const analyst = await ok(["add", "jo@example.com", "--name", "Jo", "--role", "credit_analyst"]);
    expect(analyst.stdout).toContain("clearance 0");
    expect(subject("jo@example.com")?.clearance).toBe(0);

    for (const role of ["loan_officer", "vp_credit", "chief_credit_officer"]) {
      const run = await users(["add", `k.${role}@example.com`, "--name", "K", "--role", role]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(`--clearance is required for role ${role}`);
      expect(person(`k.${role}@example.com`)).toBeUndefined();
    }

    for (const clearance of ["-1", "1.5", "50k", ""]) {
      const run = await users(["add", "lee@example.com", "--name", "Lee", "--role", "loan_officer", `--clearance=${clearance}`]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("is not a non-negative whole number");
    }
    expect(person("lee@example.com")).toBeUndefined();
  });

  test("the implied 0 is the policy's: without the access rule, credit_analyst needs --clearance too", async () => {
    await bootstrap();
    plant("UPDATE policy_rules SET enabled = 0 WHERE id = 'access.analysts-cannot-see-approve'");
    const run = await users(["add", "mo@example.com", "--name", "Mo", "--role", "credit_analyst"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--clearance is required for role credit_analyst");
  });

  test("an address with a subject is refused, with or without its Okta user, and nothing changes", async () => {
    await ok(["add", "nia@example.com", "--name", "Nia", "--role", "loan_officer", "--clearance", "1"]);
    const before = counts();
    const again = await users(["add", "NIA@example.com", "--name", "Nia", "--role", "vp_credit", "--clearance", "2"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("nia@example.com already exists");

    okta.users.delete(person("nia@example.com")!.id);
    const half = await users(["add", "nia@example.com", "--name", "Nia", "--role", "vp_credit", "--clearance", "2"]);
    expect(half.code).toBe(1);
    expect(half.stderr).toContain("half there: a subject in governance.db but no identity in Okta");
    expect(counts()).toEqual({ ...before, people: before.people - 1 });
  });

  test("somebody already in the org gets a subject, keeps their password, and is not put in the group", async () => {
    okta.addPerson({ email: "admin@example.com", password: "Their-Own-Pass-1", name: "Ada Admin" });
    const run = await ok(["add", "admin@example.com", "--name", "Ada", "--role", "chief_credit_officer", "--clearance", "5000000"]);
    expect(run.stdout).toContain("admin@example.com was already in Okta (active)");
    expect(run.stdout).not.toMatch(/^ {2}password /m);
    expect(person("admin@example.com")?.password).toBe("Their-Own-Pass-1");
    expect(ours("admin@example.com")).toBe(false);
    expect(subject("admin@example.com")?.role).toBe("chief_credit_officer");

    // And --password is refused for them: this command never changes an existing person's password.
    plant("DELETE FROM subjects WHERE user_id = 'admin@example.com'");
    const withPassword = await users([
      "add", "admin@example.com", "--name", "Ada", "--role", "vp_credit", "--clearance", "1", "--password", "Another-Pass-77",
    ]);
    expect(withPassword.code).toBe(1);
    expect(withPassword.stderr).toContain("never changes an existing person's password");
    expect(person("admin@example.com")?.password).toBe("Their-Own-Pass-1");
  });

  test("both halves or neither: a subject that cannot be written deletes the Okta user again", async () => {
    await bootstrap();
    plant("CREATE TRIGGER planted_refusal BEFORE INSERT ON subjects BEGIN SELECT RAISE(ABORT, 'planted refusal'); END;");
    const before = counts();
    const run = await users(["add", "omar@example.com", "--name", "Omar", "--role", "loan_officer", "--clearance", "1"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("planted refusal");
    expect(run.stderr).toContain("the identity was deleted again and nothing was added");
    expect(person("omar@example.com")).toBeUndefined();
    expect(counts()).toEqual(before);
    // And no password was handed out for an account that does not exist.
    expect(run.stdout).not.toMatch(/password/);
  });

  test("a refused API token is said plainly, without the token", async () => {
    const run = await users(["list"], undefined, { OKTA_API_TOKEN: "not-the-token" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("check OKTA_API_TOKEN is a live token for this org");
    expect(run.stderr).not.toContain("not-the-token");
  });

  test("with no token at all it refuses, naming op run", async () => {
    const run = await users(["list"], undefined, { OKTA_API_TOKEN: "" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("OKTA_API_TOKEN is not set");
    expect(run.stderr).toContain("op run");
  });

  test("the org can come from IDP_ISSUER's origin", async () => {
    const run = await users(["add", "pia@example.com", "--name", "Pia", "--role", "loan_officer", "--clearance", "5"], undefined, {
      OKTA_ORG_URL: "",
      IDP_ISSUER: okta.issuer,
    });
    expect(run.code).toBe(0);
    expect(person("pia@example.com")?.status).toBe("ACTIVE");
  });
});

describe("the Arcade invite reminder", () => {
  test("names the email for every role that can request an approval", async () => {
    const roles = { loan_officer: "5", credit_analyst: "0", vp_credit: "5", chief_credit_officer: "5" };
    for (const [role, clearance] of Object.entries(roles)) {
      const email = `req.${role}@example.com`;
      const run = await ok(["add", email, "--name", "R", "--role", role, "--clearance", clearance]);
      expect(run.stdout).toContain(`${INVITE} ${email}`);
      expect(run.stdout).toContain(`${email} can request approvals`);
    }
  });

  test("is not printed for a role the policy hides the request tool from", async () => {
    await bootstrap();
    plant(
      `INSERT INTO policy_rules (id, description, hook, toolkit, tool, subjects, conditions, effect, reason, priority)
       VALUES ('access.analysts-cannot-request', '', 'access', 'LoanDesk', 'RequestApproval',
               '{"user_ids":null,"roles":["credit_analyst"],"clearance_below":null,"clearance_at_least":null}',
               '[]', 'deny', 'Analysts do not request approvals.', 11)`,
    );
    const analyst = await ok(["add", "pat@example.com", "--name", "Pat", "--role", "credit_analyst"]);
    expect(analyst.stdout).not.toContain(INVITE);
    const officer = await ok(["add", "quinn@example.com", "--name", "Quinn", "--role", "loan_officer", "--clearance", "5"]);
    expect(officer.stdout).toContain(`${INVITE} quinn@example.com`);
  });
});

describe("set-role and set-clearance", () => {
  test("each change writes a row, with before and after, and touches nothing in Okta", async () => {
    await ok(["add", "rae@example.com", "--name", "Rae", "--role", "loan_officer", "--clearance", "50000"]);
    const calls = okta.log.length;

    const clearance = await ok(["set-clearance", "Rae@Example.com", "75000"]);
    expect(subject("rae@example.com")?.clearance).toBe(75000);
    const role = await ok(["set-role", "rae@example.com", "vp_credit"]);
    expect(subject("rae@example.com")?.role).toBe("vp_credit");
    expect(okta.log.length).toBe(calls);

    const rows = changes("rae@example.com");
    expect(rows.map((row) => row.action)).toEqual(["add", "set-clearance", "set-role"]);
    expect(rows[1]).toMatchObject({ role_before: "loan_officer", role_after: "loan_officer", clearance_before: 50000, clearance_after: 75000 });
    expect(rows[2]).toMatchObject({ role_before: "loan_officer", role_after: "vp_credit", clearance_before: 75000, clearance_after: 75000 });
    expect(clearance.stdout).toContain(`subject_changes #${rows[1]!.seq} ${rows[1]!.id}`);
    expect(role.stdout).toContain(`subject_changes #${rows[2]!.seq} ${rows[2]!.id}`);
  });

  test("no change, no row", async () => {
    await ok(["add", "sol@example.com", "--name", "Sol", "--role", "loan_officer", "--clearance", "10"]);
    const before = counts();
    expect((await ok(["set-clearance", "sol@example.com", "10"])).stdout).toContain("nothing recorded");
    expect((await ok(["set-role", "sol@example.com", "loan_officer"])).stdout).toContain("nothing recorded");
    expect(counts()).toEqual(before);
  });

  test("refuses an unknown role, a bad clearance and an unknown user, writing nothing", async () => {
    await ok(["add", "tao@example.com", "--name", "Tao", "--role", "loan_officer", "--clearance", "10"]);
    const before = counts();
    expect((await users(["set-role", "tao@example.com", "janitor"])).code).toBe(1);
    expect((await users(["set-clearance", "tao@example.com", "-3"])).code).toBe(2);
    const nobody = await users(["set-clearance", "nobody@example.com", "3"]);
    expect(nobody.code).toBe(1);
    expect(nobody.stderr).toContain("nobody@example.com has no subject");
    expect(counts()).toEqual(before);
    expect(subject("tao@example.com")).toMatchObject({ role: "loan_officer", clearance: 10 });
  });

  test("subject_changes is append-only", async () => {
    await ok(["add", "uma@example.com", "--name", "Uma", "--role", "loan_officer", "--clearance", "10"]);
    expect(() => plant("UPDATE subject_changes SET clearance_after = 999")).toThrow(/append-only/);
    expect(() => plant("DELETE FROM subject_changes")).toThrow(/append-only/);
    expect(changes("uma@example.com")).toHaveLength(1);
  });
});

describe("users remove", () => {
  test("deletes the subject and the Okta user it created, deactivating first, and records the change", async () => {
    await ok(["add", "vic@example.com", "--name", "Vic", "--role", "loan_officer", "--clearance", "10"]);
    const { id } = person("vic@example.com")!;

    const run = await ok(["remove", "VIC@example.com"]);
    expect(run.stdout).toContain("deactivated and deleted in Okta, with their sessions and tokens");
    expect(okta.users.has(id)).toBe(false);
    expect(subject("vic@example.com")).toBeUndefined();
    // Okta deletes only a deactivated user, so the deactivate came first.
    const lifecycle = okta.log.filter((line) => line.includes(id));
    expect(lifecycle.slice(-2)).toEqual([`POST /api/v1/users/${id}/lifecycle/deactivate`, `DELETE /api/v1/users/${id}`]);

    const last = changes("vic@example.com").at(-1);
    expect(last).toMatchObject({ action: "remove", role_before: "loan_officer", role_after: null, clearance_before: 10, clearance_after: null });
    expect(run.stdout).toContain(`subject_changes #${last!.seq} ${last!.id}`);
  });

  test("somebody who was in the org already keeps their Okta account", async () => {
    okta.addPerson({ email: "owner@example.com", password: "Their-Own-Pass-1", name: "Olu Owner" });
    await ok(["add", "owner@example.com", "--name", "Olu", "--role", "vp_credit", "--clearance", "1"]);
    const run = await ok(["remove", "owner@example.com"]);
    expect(run.stdout).toContain("left in Okta");
    expect(person("owner@example.com")?.status).toBe("ACTIVE");
    expect(subject("owner@example.com")).toBeUndefined();
  });

  test("removes whichever half is there, and refuses an address with neither", async () => {
    await ok(["add", "wen@example.com", "--name", "Wen", "--role", "loan_officer", "--clearance", "10"]);
    plant("DELETE FROM subjects WHERE user_id = 'wen@example.com'");
    const half = await ok(["remove", "wen@example.com"]);
    expect(half.stdout).toContain("subject    none in governance.db");
    expect(person("wen@example.com")).toBeUndefined();

    const none = await users(["remove", "wen@example.com"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("there is no user wen@example.com");
  });
});

describe("a first boot (#33)", () => {
  test("seeds nobody on either side: no Okta user, no subject, no change recorded", async () => {
    const run = await ok(["list"]);
    expect(run.stdout.trim()).toBe("no users. Add one with `bun run users add`.");
    expect(counts()).toEqual({ people: 0, subjects: 0, changes: 0 });
  });
});

describe("users list", () => {
  test("shows both halves side by side, and says what a half-present user cannot do", async () => {
    await ok(["add", "xan@example.com", "--name", "Xan", "--role", "vp_credit", "--clearance", "250000"]);
    await ok(["add", "yui@example.com", "--name", "Yui", "--role", "loan_officer", "--clearance", "5"]);
    await ok(["add", "zed@example.com", "--name", "Zed", "--role", "loan_officer", "--clearance", "5"]);
    plant("DELETE FROM subjects WHERE user_id = 'yui@example.com'");
    okta.users.delete(person("zed@example.com")!.id);
    const { stdout } = await ok(["list"]);
    expect(stdout).toMatch(/^xan@example\.com\s+Xan\s+vp_credit\s+250000\s+yes\s+yes$/m);
    expect(stdout).toMatch(/^yui@example\.com\s+Yui\s+-\s+-\s+yes\s+no\s+in Okta, but has no subject: denied at every hook$/m);
    expect(stdout).toMatch(/^zed@example\.com\s+Zed\s+loan_officer\s+5\s+no\s+yes\s+has a subject, but no identity in Okta: cannot sign in$/m);
  });
});

describe("users seed-demo", () => {
  const FLAGS = ["--alice", "al@demo.test", "--bob", "bo@demo.test", "--charlie", "ch@demo.test", "--michael", "mi@demo.test"];
  const CAST = [
    ["al@demo.test", "Alice", "loan_officer", 50_000],
    ["bo@demo.test", "Bob", "credit_analyst", 0],
    ["ch@demo.test", "Charlie", "vp_credit", 250_000],
    ["mi@demo.test", "Michael", "chief_credit_officer", 5_000_000],
  ] as const;

  test("adds the four in Okta with today's roles and limits, each with a password and the invite reminder", async () => {
    const run = await ok(["seed-demo", ...FLAGS]);
    for (const [email, name, role, clearance] of CAST) {
      expect(person(email)).toMatchObject({ status: "ACTIVE", firstName: name, lastName: "Loan Desk" });
      expect(ours(email)).toBe(true);
      expect(subject(email)).toEqual({ user_id: email, display_name: name, role, clearance });
      expect(changes(email).map((row) => row.action)).toEqual(["add"]);
      expect(run.stdout).toContain(`${INVITE} ${email}`);
    }
    const printed = run.stdout.match(/^ {2}password {3}\S+$/gm)!;
    expect(printed).toHaveLength(4);
    for (const [email] of CAST) expect(passwordProblem(person(email)!.password, email)).toBeNull();
  });

  test("one --password for all four is held to the policy for each of their emails", async () => {
    // "demo" is part of every username here, so Okta would refuse it for all four.
    const refused = await users(["seed-demo", ...FLAGS, "--password", "Demo-Desk-2026"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('must not contain part of the username ("demo")');
    expect(okta.users.size).toBe(0);

    await ok(["seed-demo", ...FLAGS, "--password", "Ledger-Desk-2026"]);
    for (const [email] of CAST) expect(person(email)?.password).toBe("Ledger-Desk-2026");
  });

  test("is idempotent: a second run writes nothing and prints no password, and still reminds", async () => {
    await ok(["seed-demo", ...FLAGS]);
    const before = counts();
    const again = await ok(["seed-demo", ...FLAGS]);
    expect(counts()).toEqual(before);
    expect(again.stdout).not.toMatch(/password/);
    for (const [email] of CAST) {
      expect(again.stdout).toContain(`${email} already present`);
      expect(again.stdout).toContain(`${INVITE} ${email}`);
    }
  });

  test("asks for the emails it was not given", async () => {
    const run = await ok(["seed-demo", "--bob", "bo@demo.test"], "al@demo.test\nch@demo.test\nmi@demo.test\n");
    expect(run.stderr).toContain("Alice's email (loan_officer, clearance 50000): ");
    expect(run.stderr).not.toContain("Bob's email");
    for (const [email, , role] of CAST) expect(subject(email)?.role).toBe(role);
  });

  test("with no answers and no flags it refuses before writing anything", async () => {
    await bootstrap();
    const before = counts();
    const run = await users(["seed-demo", "--alice", "al@demo.test"], "");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("pass --alice, --bob, --charlie, --michael, or answer the prompts");
    expect(counts()).toEqual(before);
  });

  // #33: the demo cast is known by the fixture's addresses. Seeded anywhere
  // else, a demo person is a real user from then on, and seed-demo says so.
  test("under addresses that are not the fixture's, each one is said to count as a real user", async () => {
    const run = await ok(["seed-demo", ...FLAGS]);
    for (const [email, name] of CAST) {
      expect(run.stdout).toContain(`real user  ${email} is not the fixture's`);
      expect(run.stdout).toContain(`so from here on ${name} counts as a real user`);
    }
    expect(run.stdout.match(/^ {2}real user {2}/gm)).toHaveLength(4);
    expect(run.stdout).toContain("`bun run reset` keeps their role and clearance as they are");
  });

  test("at the fixture's own addresses, nobody is called a real user", async () => {
    const run = await ok([
      "seed-demo", "--alice", "alice@bank.example", "--bob", "bob@bank.example",
      "--charlie", "charlie@bank.example", "--michael", "michael@bank.example",
    ]);
    expect(run.stdout).not.toContain("real user");
    expect(run.stdout.match(/^ {2}password {3}\S+$/gm)).toHaveLength(4);
  });

  test("refuses the same email twice", async () => {
    const run = await users(["seed-demo", "--alice", "x@demo.test", "--bob", "x@demo.test", "--charlie", "c@demo.test", "--michael", "m@demo.test"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("a different email for each person");
  });
});
