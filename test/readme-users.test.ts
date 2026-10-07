/**
 * The README's `bun run users` commands, run as written (#34).
 *
 * Since #33 nobody is seeded, so the Quickstart's "Add yourself and an
 * approver" step is the only way anybody can sign in, and Try it out adds Bob
 * and Michael the same way. A command there that the CLI refuses (a role the
 * policy does not know, a clearance it requires and the line leaves out) reads
 * exactly like one that works until somebody types it. So this reads the
 * commands out of the README, fills in the placeholders, and runs each one
 * against a scratch pair of databases, the way `app-test/users-cli.test.ts`
 * runs the command: `--no-env-file` and an allowlisted environment, so nothing
 * from this checkout's `.env` files reaches it.
 *
 * It also holds the step to the act it sets up: the loan officer's clearance
 * is under the $95K the Quickstart asks for, and the approver's covers it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnChild } from "../app-test/child.ts";
import { childEnv } from "../app-test/child-env.ts";

const REPO = join(import.meta.dir, "..");
const README = readFileSync(join(REPO, "README.md"), "utf8");
const DOMAIN_SWAP = readFileSync(join(REPO, "docs", "DOMAIN-SWAP.md"), "utf8");
/** The FAQ moved out of the README into its own page, one H2 per question (#58). */
const FAQ = readFileSync(join(REPO, "docs", "faq.md"), "utf8");
const ACCOUNTS_QUESTION = "Do my users need Arcade accounts?";

/** Who needs an Arcade account, and why, moved out of the README into its own page (#55). */
const ACCOUNTS_PAGE = "docs/app-users-and-arcade-accounts.md";
const ACCOUNTS_LINK = `[\`${ACCOUNTS_PAGE}\`](./${ACCOUNTS_PAGE})`;
/** The same page linked from `docs/faq.md`, its neighbour. */
const ACCOUNTS_LINK_FROM_DOCS = "[`app-users-and-arcade-accounts.md`](./app-users-and-arcade-accounts.md)";
const SLACK_PAGE = "https://docs.arcade.dev/en/references/auth-providers/slack";

const ADD_STEP = "7. **Add yourself and an approver**";
const ASK_STEP = "8. **Run the agent and ask it**";

const scratch = mkdtempSync(join(tmpdir(), "cg-readme-users-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The text under one H2, up to the next H2. */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** The Quickstart's add step, up to the step after it. */
function addStep(markdown: string): string {
  const quickstart = section(markdown, "Quickstart 🚀");
  const start = quickstart.indexOf(ADD_STEP);
  const end = quickstart.indexOf(ASK_STEP);
  return start === -1 || end === -1 || end < start ? "" : quickstart.slice(start, end);
}

/** Every backticked `bun run users add …` in the text, as argv after `users`. */
function addCommands(text: string): string[][] {
  return [...text.matchAll(/`bun run users (add [^`]+)`/g)].map((match) => match[1]!.trim().split(/\s+/));
}

/** The placeholders filled in with a different address each, as a reader would. */
function filled(argv: string[], index: number): string[] {
  return argv.map((arg) => (/^<[\w-]*email>$/.test(arg) ? `reader-${index}@example.test` : arg));
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

/** Whether the loan officer is refused the $95K and the approver may grant it: act 2, as step 7 sets it up. */
function coversTheAct(commands: string[][]): boolean {
  const [officer, approver] = commands.map((argv) => Number(flag(argv, "clearance")));
  return officer! < 95_000 && approver! >= 95_000;
}

/** The README with step 7 moved after step 8, the order in which nobody can sign in. */
function addStepAfterAsk(markdown: string): string {
  const start = markdown.indexOf(ADD_STEP);
  const ask = markdown.indexOf(ASK_STEP);
  const end = markdown.indexOf("\n## ", ask);
  return markdown.slice(0, start) + markdown.slice(ask, end) + markdown.slice(start, ask) + markdown.slice(end);
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function users(dir: string, args: string[]): Promise<Run> {
  const child = spawnChild(["bun", "--no-env-file", "scripts/users.ts", ...args], {
    cwd: REPO,
    env: childEnv({ IDP_DB_PATH: join(dir, "idp.db"), GOVERNANCE_DB_PATH: join(dir, "governance.db") }),
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

/** Runs every command against one fresh pair of databases; the failures, by command. */
async function runAll(commands: string[][]): Promise<{ failures: string[]; list: string }> {
  const dir = mkdtempSync(join(scratch, "case-"));
  const failures: string[] = [];
  for (const [i, argv] of commands.entries()) {
    const run = await users(dir, filled(argv, i));
    if (run.code !== 0) failures.push(`users ${argv.join(" ")} exited ${run.code}: ${run.stderr.trim()}`);
  }
  const list = await users(dir, ["list"]);
  return { failures, list: list.stdout };
}

describe("the README's users commands", () => {
  const step = addStep(README);
  const quickstartAdds = addCommands(step);
  const tryItOutAdds = addCommands(section(README, "Try it out"));

  test("step 7 adds a loan officer and a VP, right before the app is opened", () => {
    expect(step).not.toBe("");
    expect(quickstartAdds.map((argv) => flag(argv, "role"))).toEqual(["loan_officer", "vp_credit"]);
    const quickstart = section(README, "Quickstart 🚀");
    expect(quickstart.indexOf(ADD_STEP)).toBeLessThan(quickstart.indexOf("Open `https://<APP_PUBLIC_HOST>`"));
  });

  test("the loan officer's clearance is under $95K and the approver's covers it", () => {
    expect(coversTheAct(quickstartAdds)).toBe(true);
  });

  test("step 7 says the approver's email is their Slack one, answers who needs an Arcade account, and offers seed-demo", () => {
    expect(step).toContain("Use the email the approver's Slack account uses");
    expect(step).toContain(
      "   - Do your app's users need Arcade accounts? With Arcade's built-in Slack app, yes: invite each loan officer to your Arcade project's Members. " +
        `With your own Slack app, no. See ${ACCOUNTS_LINK}.\n`,
    );
    expect(step).toContain("`bun run users seed-demo`");
  });

  test("Try it out adds Bob and Michael, with the demo's roles", () => {
    expect(tryItOutAdds.map((argv) => [flag(argv, "name"), flag(argv, "role")])).toEqual([
      ["Bob", "credit_analyst"],
      ["Michael", "chief_credit_officer"],
    ]);
  });

  test("every one of them runs as written, and adds who it says", async () => {
    const commands = [...quickstartAdds, ...tryItOutAdds];
    expect(commands).toHaveLength(4);
    const { failures, list } = await runAll(commands);
    expect(failures).toEqual([]);
    const rows = list.split("\n").filter((line) => line.startsWith("reader-"));
    expect(rows.map((row) => row.split(/\s{2,}/).slice(1, 4))).toEqual([
      ["Alice", "loan_officer", "50000"],
      ["Charlie", "vp_credit", "250000"],
      ["Bob", "credit_analyst", "0"],
      ["Michael", "chief_credit_officer", "5000000"],
    ]);
  }, 60_000);
});

/** The FAQ's answer to who needs an Arcade account: the text under its H2 in `docs/faq.md`. */
function accountsAnswer(faq: string): string {
  return section(faq, ACCOUNTS_QUESTION);
}

describe("the FAQ the docs point at", () => {
  test("docs/faq.md answers it, and DOMAIN-SWAP links to that answer rather than repeating it", () => {
    const entry = accountsAnswer(FAQ);
    expect(entry).toContain("With Arcade's built-in Slack app, the default, each loan officer who requests an approval has to be invited");
    expect(entry).toContain("With your own Slack app");
    expect(entry).toContain(ACCOUNTS_LINK_FROM_DOCS);
    expect(DOMAIN_SWAP).toContain("[Do my users need Arcade accounts?](./faq.md#do-my-users-need-arcade-accounts)");
    expect(DOMAIN_SWAP).not.toContain("each loan officer who requests an approval has to be invited");
  });

  test("the README keeps no FAQ of its own, and links the page from Further reading", () => {
    expect(section(README, "FAQ")).toBe("");
    expect(section(README, "Further reading")).toContain("[`docs/faq.md`](./docs/faq.md)");
  });
});

/** The ways the accounts page falls short of answering the question: each one a thing a reader would miss. */
function accountsPageGaps(page: string): string[] {
  const gaps: string[] = [];
  if (!page.startsWith("# Do your app's users need Arcade accounts?\n")) gaps.push("the question as its title");
  if (!page.includes(`](${SLACK_PAGE})`)) gaps.push("a link to Arcade's Slack auth provider page");
  for (const heading of ["## Why", "## Route 1: Arcade's built-in Slack app", "## Route 2: your own Slack app"])
    if (!page.split("\n").includes(heading)) gaps.push(heading);
  return gaps;
}

describe("the page on who needs an Arcade account", () => {
  const path = join(REPO, ACCOUNTS_PAGE);

  test("exists, answers the question for both routes, and links Arcade's Slack page", () => {
    expect(existsSync(path)).toBe(true);
    expect(accountsPageGaps(readFileSync(path, "utf8"))).toEqual([]);
  });

  test("the README points at it from Prerequisites, step 7 and Further reading, and the FAQ from its answer", () => {
    for (const title of ["Prerequisites", "Quickstart 🚀", "Further reading"]) expect(section(README, title)).toContain(ACCOUNTS_LINK);
    expect(accountsAnswer(FAQ)).toContain(ACCOUNTS_LINK_FROM_DOCS);
  });

  test("the check bites on a page with the Slack link or a route missing", () => {
    const page = readFileSync(path, "utf8");
    expect(accountsPageGaps(page.replaceAll(SLACK_PAGE, "https://example.com/slack"))).toEqual([
      "a link to Arcade's Slack auth provider page",
    ]);
    expect(accountsPageGaps(page.replace("## Route 2: your own Slack app", "## Your own Slack app"))).toEqual([
      "## Route 2: your own Slack app",
    ]);
  });
});

describe("the checks bite on a planted violation", () => {
  test("a role the policy does not know, and a clearance the role needs left out", async () => {
    const planted = addCommands(addStep(README.replace("--role vp_credit", "--role vp").replace("--clearance 50000", "")));
    const { failures } = await runAll(planted);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("--clearance is required for role loan_officer");
    expect(failures[1]).toContain('role "vp" is not one the policy knows');
  }, 60_000);

  test("an approver whose clearance does not cover the $95K, and a loan officer whose does", () => {
    expect(coversTheAct(addCommands(addStep(README.replace("--clearance 250000", "--clearance 90000"))))).toBe(false);
    expect(coversTheAct(addCommands(addStep(README.replace("--clearance 50000", "--clearance 100000"))))).toBe(false);
  });

  test("the FAQ's answer without the route that needs no Arcade account, or under a renamed question", () => {
    const entry = accountsAnswer(FAQ);
    expect(accountsAnswer(FAQ.replace(entry, entry.replace("With your own Slack app", "With a Slack app")))).not.toContain("With your own Slack app");
    expect(accountsAnswer(FAQ.replace(`## ${ACCOUNTS_QUESTION}`, "## Arcade accounts"))).toBe("");
  });

  test("the add step moved after the step that opens the app", () => {
    const planted = addStepAfterAsk(README);
    expect(planted.length).toBe(README.length);
    expect(addStep(planted)).toBe("");
  });
});
