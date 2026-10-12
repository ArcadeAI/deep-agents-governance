/**
 * The root `README.md` is what a new user reads first. Its outline is the one
 * Mastra's template guide set for the template it was built from (#10), kept
 * because it reads well, with Credits in place of About Mastra templates. These are the mechanical halves of its
 * acceptance criteria: Mastra's outline in order, the Demo placeholder word for
 * word, every environment variable it names present in `.env.example`, its
 * Prerequisites naming exactly `.env.example`'s Required block, every relative
 * link and anchor resolving, every external link one somebody verified, no em
 * dash, and no ordinary paragraph indented.
 *
 * Each check is a function of the text, so each one is also run against a
 * planted violation below: a check that cannot fail is indistinguishable from
 * one that passes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { brokenRelativeLinks as brokenLinks, headings, links, proseLines, section } from "./markdown.ts";

const REPO = join(import.meta.dir, "..");
const README = readFileSync(join(REPO, "README.md"), "utf8");
const ENV_EXAMPLE = readFileSync(join(REPO, ".env.example"), "utf8");
/** The agent's own variables: the README and the docs may name them, and Prerequisites may not. */
const AGENT_ENV_EXAMPLE = readFileSync(join(REPO, "agent", ".env.example"), "utf8");

/** Mastra's required outline (`.orca/local/human/mastra-contributing-guide.md`), before any contributor section. */
const REQUIRED_H2 = ["Why we built this", "Demo", "Prerequisites", "Quickstart 🚀", "Try it out", "Customization"];
const LAST_H2 = "Further reading";
const DEMO_PLACEHOLDER = [
  "<!-- TODO: REPLACE THIS PLACEHOLDER WITH THE CLOUDINARY DEMO VIDEO URL -->",
  '<video controls width="640" height="360" src="CLOUDINARY_DEMO_VIDEO_URL_REQUIRED"></video>',
];

/**
 * Every external URL the README may link to, and where each was verified. A
 * new one fails here until somebody verifies it and adds it: the README never
 * guesses a URL (#10). `localhost` links are the reader's own machine and are
 * not listed.
 */
const VERIFIED_URLS = new Set([
  // The human's, relayed by the driver on #10 (2026-09-24).
  "https://api.arcade.dev/dashboard/api-keys",
  "https://github.com/ArcadeAI/mastra-template-loan-approval-limits",
  // Mateo's tool-building workshop, credited in Further reading for the tag-paced method. Cloned and read 2026-09-29.
  "https://github.com/ArcadeAI/tool-building-workshop",
  // Fetched 2026-10-06: LangSmith's "Managed Deep Agents" overview, and uv's home page.
  "https://docs.langchain.com/langsmith/managed-deep-agents",
  "https://docs.astral.sh/uv/",
  // Fetched on #10: Arcade's "Deploying to the cloud with Arcade Deploy", which installs the CLI.
  "https://docs.arcade.dev/en/build/arcade-deploy",
  // Fetched on #10: ngrok's "Domains", on the free dev domain every account has.
  "https://ngrok.com/docs/universal-gateway/domains/",
  // Fetched on #30, for the Arcade CLI steps under Prerequisites: the CLI
  // reference (`uv tool install arcade-mcp`, `arcade login`), the cheat sheet
  // (`arcade org set`, `arcade project set`, `arcade whoami`, and "switching
  // organization also resets your active project"), the API key page, and the
  // Operate quickstart ("create administrator credentials and a project").
  "https://docs.arcade.dev/en/references/arcade-cli",
  "https://docs.arcade.dev/en/references/cli-cheat-sheet",
  "https://docs.arcade.dev/en/get-started/setup/api-keys",
  "https://docs.arcade.dev/en/operate/quickstart",
]);

/** Upper-snake words in the README that are not environment variables. Each is also proved absent from `.env.example`. */
const NOT_VARIABLES = new Set(["CHECK_FAILED", "CLOUDINARY_DEMO_VIDEO_URL_REQUIRED"]);

// --- Reading the Markdown ----------------------------------------------------

/** Every upper-snake word in the text, which is how this repo spells an environment variable. */
function variablesNamed(markdown: string): Set<string> {
  const words = markdown.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  return new Set(words.filter((word) => !NOT_VARIABLES.has(word)));
}

/** Every variable `.env.example` carries, set or commented out. */
function exampleVariables(example: string): Set<string> {
  return new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!));
}

/** A variable the root `.env.example` or `agent/.env.example` carries. */
function knownVariable(name: string): boolean {
  return exampleVariables(ENV_EXAMPLE).has(name) || exampleVariables(AGENT_ENV_EXAMPLE).has(name);
}

/** The variables in `.env.example`'s "Required: you fill these" block. */
function requiredBlock(example: string): Set<string> {
  const lines = example.split("\n");
  const start = lines.findIndex((line) => /^# --- Required/.test(line));
  const end = lines.findIndex((line, i) => i > start && /^# --- /.test(line));
  return exampleVariables(lines.slice(start + 1, end).join("\n"));
}

// --- The checks ---------------------------------------------------------------

/** Relative links whose file, or whose anchor in that file, does not exist; read as the README unless `from` says otherwise. */
function brokenRelativeLinks(markdown: string, from = join(REPO, "README.md")): string[] {
  return brokenLinks(markdown, from);
}

/** External links nobody verified. */
function unverifiedUrls(markdown: string): string[] {
  return links(markdown).filter(
    (target) => /^https?:/.test(target) && !/^https?:\/\/localhost[:/]/.test(target) && !VERIFIED_URLS.has(target),
  );
}

/** Indented lines outside fenced code that do not belong to a list item. */
function indentedParagraphs(markdown: string): number[] {
  const offending: number[] = [];
  let inList = false;
  for (const { n, text } of proseLines(markdown)) {
    if (text.trim() === "") continue;
    if (/^\S/.test(text)) {
      inList = /^([-*]|\d+\.) /.test(text);
      continue;
    }
    if (!inList) offending.push(n);
  }
  return offending;
}

/** Lines that are only bold text, the shape the guide forbids as a section title. */
function boldTitles(markdown: string): number[] {
  return proseLines(markdown)
    .filter(({ text }) => /^\s*(?:[-*]\s+)?\*\*[^*]+\*\*:?\s*$/.test(text))
    .map(({ n }) => n);
}

/**
 * The Quickstart from step 5 on, in the one order that works: the app first,
 * then the tunnel that reaches it, then opening the app through the tunnel.
 * There is no User Source or gateway form between them: the agent calls the
 * Engine directly with the project key, and `--gateway` is an optional aside
 * in step 4, not a step. `setup-arcade`'s "Then:"
 * list is held to the same order in `app-test/setup-arcade.test.ts`.
 */
const QUICKSTART_ORDER: Array<[string, RegExp]> = [
  ["start the app", /run `bun run dev`/i],
  ["start the tunnel", /`ngrok http --url=/],
  ["open the app", /Open `https:\/\/<APP_PUBLIC_HOST>`/],
];

const REGISTER_STEP = "4. **Register the app with Arcade**";
/** Where the app and the tunnel start. */
const START_STEP = "5. **Start the app and the tunnel**";

/**
 * Step 4, the one run: the script, the hooks registered on, the deploys after
 * them, and a second run that changes nothing.
 */
const ONE_CLICK_ORDER: Array<[string, RegExp]> = [
  ["the script", /Run `bun run setup-arcade <APP_PUBLIC_HOST>`\./],
  ["the hooks, on", /contextual access hooks through Arcade's API, with the hooks on/],
  ["the deploys", /Then it runs `arcade deploy`/],
  ["the rerun", /Run it again, and it says everything is already in place/],
];

/** Step 4's text, from its title to step 5's. */
function registerStep(markdown: string): string {
  const quickstart = section(markdown, "Quickstart 🚀");
  return quickstart.slice(quickstart.indexOf(REGISTER_STEP), quickstart.indexOf(START_STEP));
}

/**
 * The Arcade CLI's setup under Prerequisites, in the order it has to happen
 * (#30): `setup-arcade` takes the org and project from the CLI's active
 * context, so the CLI is installed, logged in and pointed at the project the
 * key belongs to before the first run. `arcade org set` comes before
 * `arcade project set` because switching org resets the active project.
 */
const CLI_SETUP: Array<[string, RegExp]> = [
  ["install the CLI", /`uv tool install arcade-mcp`/],
  ["log in", /`arcade login`/],
  ["use the default project", /Use the default project Arcade made when you signed up/],
  ["another project, if you want one", /`arcade project set <project_id>`/],
  ["an API key in that project", /Create an API key in that project and set `ARCADE_API_KEY`/],
  ["check it", /`arcade whoami` shows that org and project/],
];

function inOrder(text: string, steps: Array<[string, RegExp]>): string[] {
  const found = steps.map(([name, pattern]) => ({ name, at: text.search(pattern) }));
  const missing = found.filter(({ at }) => at === -1).map(({ name }) => `missing: ${name}`);
  return missing.length > 0 ? missing : found.sort((a, b) => a.at - b.at).map(({ name }) => name);
}

/**
 * Lines that name a port number the reader's own variable decides, without
 * naming the variable (#34 review): `ngrok http … 3000` is only right while
 * `PORT` is unset, and nothing else in the README is tied to a port.
 */
function portsTiedToVariables(markdown: string): number[] {
  const PORTS: Array<[RegExp, string]> = [
    [/\b3000\b/, "`PORT`"],
  ];
  return proseLines(markdown)
    .filter(({ text }) => PORTS.some(([port, variable]) => port.test(text) && !text.includes(variable)))
    .map(({ n }) => n);
}

/** The steps in the order the Quickstart's remainder first names them, or the ones it never does. */
function quickstartOrder(markdown: string): string[] {
  const quickstart = section(markdown, "Quickstart 🚀");
  const rest = quickstart.slice(Math.max(0, quickstart.indexOf(START_STEP)));
  const found = QUICKSTART_ORDER.map(([name, pattern]) => ({ name, at: rest.search(pattern) }));
  const missing = found.filter(({ at }) => at === -1).map(({ name }) => `missing: ${name}`);
  return missing.length > 0 ? missing : found.sort((a, b) => a.at - b.at).map(({ name }) => name);
}

// --- The README ---------------------------------------------------------------

describe("README.md follows the template's outline", () => {
  test("one H1, the template's title", () => {
    expect(headings(README).filter((h) => h.level === 1).map((h) => h.title)).toEqual(["Deep Agents Loan Desk with Arcade"]);
  });

  test("the required H2s come first and in order, and Further reading is last", () => {
    const h2 = headings(README).filter((h) => h.level === 2).map((h) => h.title);
    expect(h2.slice(0, REQUIRED_H2.length)).toEqual(REQUIRED_H2);
    expect(h2.at(-1)).toBe(LAST_H2);
    expect(h2.filter((title) => title === LAST_H2)).toHaveLength(1);
    expect(h2.some((title) => /feature/i.test(title))).toBe(false);
  });

  test("no section title is a bold line", () => {
    expect(boldTitles(README)).toEqual([]);
  });

  test("Demo carries the guide's placeholder, word for word", () => {
    const demo = section(README, "Demo");
    for (const line of DEMO_PLACEHOLDER) expect(demo).toContain(line);
  });

  test("Quickstart is numbered steps with bold labels, from git clone to ask.py", () => {
    const quickstart = section(README, "Quickstart 🚀");
    const steps = quickstart.split("\n").filter((line) => /^\S/.test(line));
    expect(steps.length).toBeGreaterThan(3);
    for (const step of steps) expect(step).toMatch(/^\d+\. \*\*[^*]+\*\*$/);

    const clone = /`git clone [^`]+ (\S+)`/.exec(quickstart);
    expect(clone).not.toBeNull();
    expect(quickstart).toContain(`\`cd ${clone![1]}\``);
    for (const command of ["`bun install`", "`cp .env.example .env`", "`bun run setup-arcade <APP_PUBLIC_HOST>`", "`bun run dev`", "`arcade deploy`", "`uv run mda dev .`", "python ask.py"]) {
      expect(quickstart).toContain(command);
    }
    expect(quickstart).toContain("https://<APP_PUBLIC_HOST>");
    expect(quickstart).not.toContain("create-mastra");
  });

  test("the Quickstart's last steps run in the one order that works: the app, the tunnel, then opening it", () => {
    expect(quickstartOrder(README)).toEqual(QUICKSTART_ORDER.map(([name]) => name));
  });

  test("the ngrok command is the one bun run dev printed for PORT, with 3000 only as the default's example", () => {
    expect(portsTiedToVariables(README)).toEqual([]);
    const quickstart = section(README, "Quickstart 🚀");
    expect(quickstart).toContain("run the ngrok command `bun run dev` printed");
    expect(quickstart).toContain("With the default `PORT` it is `ngrok http --url=<APP_PUBLIC_HOST> 3000`");
    expect(quickstart).not.toContain("bun run studio");
  });

  test("step 4 is the one run: the hooks registered on, the deploys, and the gateway only as the optional --gateway", () => {
    const register = registerStep(README);
    expect(inOrder(register, ONE_CLICK_ORDER)).toEqual(ONE_CLICK_ORDER.map(([name]) => name));
    expect(register).toContain("the contextual access hooks through Arcade's API");
    expect(register).toContain("it runs `arcade deploy` once, in `mcp`");
    expect(register).toContain("The agent needs no User Source and no MCP gateway");
    expect(register).toContain("add `--gateway`");
    expect(register).toContain("[`docs/modules/03-govern.md`](./docs/modules/03-govern.md#take-it-home-the-same-governance-from-an-mcp-client)");
    expect(register).toContain("the agent ignores the variable");
    // What Arcade cannot reach is named, with the step that fixes it.
    expect(register).toContain("If Arcade cannot reach the app's hooks health check");
    expect(register).toContain("start the app and the tunnel as in step 5, then run it again");
    // No wait, no Coordinator and no dashboard fallback is left to describe.
    expect(register).not.toMatch(/Coordinator|Press Enter|fell back|disabled/);
    expect(section(README, "Quickstart 🚀")).not.toMatch(/fill in the .* form/i);
  });

  test("the Quickstart's steps are the gateway-free ones, with no step that registers a gateway", () => {
    const quickstart = section(README, "Quickstart 🚀");
    const titles = [...quickstart.matchAll(/^(\d+)\. \*\*(.+)\*\*$/gm)].map(([, n, title]) => `${n}. ${title}`);
    expect(titles.slice(3)).toEqual([
      "4. Register the app with Arcade",
      "5. Start the app and the tunnel",
      "6. Add yourself and an approver",
      "7. Run the agent and ask it",
    ]);
    // No step asks for a User Source id, a gateway id or a gateway consent.
    expect(quickstart).not.toMatch(/us_|User Source's page|--user-source|gateway id|Authorize the gateway/);
  });

  test("Prerequisites sets up the Arcade CLI in order, on the default project, each step with its command", () => {
    const prerequisites = section(README, "Prerequisites");
    expect(inOrder(prerequisites, CLI_SETUP)).toEqual(CLI_SETUP.map(([name]) => name));
    expect(prerequisites).toContain("There is no CLI or API to create a project");
    expect(prerequisites).toContain("after `arcade org set <org_id>` if you have more than one org");
  });

  test("the Quickstart warns about ngrok's page on a free domain, once, where the app is first opened", () => {
    const quickstart = section(README, "Quickstart 🚀");
    const open = quickstart.slice(quickstart.indexOf("7. **Run the agent and ask it**"));
    expect(open).toContain("The first time a browser opens a free ngrok domain, ngrok shows its own warning page first: click **Visit Site**.");
    expect(open).toContain("Arcade's own calls to the app never see that page.");
    expect(README.match(/Visit Site/g)).toHaveLength(1);
  });

  test("no Elasticsearch, no Mastra runtime and no chat to send a prompt in", () => {
    expect(README).not.toMatch(/elastic/i);
    expect(README).not.toMatch(/Mastra Studio|bun run studio|In the chat/);
  });
});

describe("README.md's variables are .env.example's", () => {
  test("every variable the README names is in .env.example", () => {
    const missing = [...variablesNamed(README)].filter((name) => !knownVariable(name));
    expect(missing).toEqual([]);
  });

  test("Prerequisites names exactly the Required block", () => {
    const required = requiredBlock(ENV_EXAMPLE);
    expect([...required].sort()).toEqual([
      "APP_PUBLIC_HOST",
      "ARCADE_API_KEY",
    ]);
    expect([...variablesNamed(section(README, "Prerequisites"))].sort()).toEqual([...required].sort());
  });

  test("the words exempted from the check are not variables .env.example knows", () => {
    for (const word of NOT_VARIABLES) expect(exampleVariables(ENV_EXAMPLE).has(word)).toBe(false);
  });
});

describe("README.md's links and typography", () => {
  test("every relative link and anchor resolves", () => {
    expect(links(README).filter((target) => !/^https?:/.test(target)).length).toBeGreaterThan(0);
    expect(brokenRelativeLinks(README)).toEqual([]);
  });

  test("every external link is one somebody verified", () => {
    expect(unverifiedUrls(README)).toEqual([]);
  });

  test("no em dash", () => {
    expect(README.split("—").length - 1).toBe(0);
  });

  test("no ordinary paragraph is indented", () => {
    expect(indentedParagraphs(README)).toEqual([]);
  });
});

// --- What moved out of the README (#58) ---------------------------------------

/**
 * The README is a landing page and a quick start (#58). After Customization it
 * carries only Further reading, which links each page under `docs/` with one
 * line on what it answers. Everything that used to follow Customization moved
 * whole into one of the pages below, and each page is pinned here by its
 * headings and by the facts a reader would most miss, so an edit cannot drop
 * one quietly. The first-run sections stay in the README and are pinned above.
 */
const CONTRIBUTOR_H2: string[] = [];
const MOVED: Array<{ page: string; headings: string[]; facts: string[] }> = [
  {
    page: "docs/architecture.md",
    headings: ["How the controls work", "Two OAuth hops, two mechanisms", "Project layout"],
    facts: [
      "| 3 | Whether you have the authority for *this* call | identity + policy | `/hooks/pre` → `CHECK_FAILED` |",
      "Arcade evaluates auth requirements before `/hooks/pre`, so a refusal there fires no hook, writes no audit row and shows nothing on the panel.",
      "A rule keyed on `get_loan` matches nothing, and a rule that matches nothing is indistinguishable from a rule that permits.",
      "`app-test/loans/knows-nothing-about-governance.test.ts` fails if governance vocabulary",
      "`gate/engine/test/no-app-dependencies.test.ts` fails if it declares a dependency on an app package",
      "The custom verifier covers custom providers only.",
      "**Email is the join key.**",
      "The loan module takes the actor from the token, never from a request parameter",
      "The toolkits are Python because `arcade-mcp`, the tool-authoring framework, is Python-only.",
    ],
  },
  {
    page: "docs/configuration.md",
    headings: ["Configuration and readiness", "Resetting the demo"],
    facts: [
      "A fresh clone with nothing filled in answers `degraded` and names `signin` and `verifier` as `missing`.",
      "To use a different project, set `ARCADE_ORG_ID` and `ARCADE_PROJECT_ID` in `.env`.",
      "**`identity` is Okta.**",
      "**Rotating the Okta client secret.**",
      "so a taken port is an error rather than a silent move to 3001 that the tunnel would not follow",
      "**Never drive the demo from an Arcade Org Admin account.**",
      "There is no `bun run reset --hard` any more",
      "It deletes no user.",
      "With it unset, every reset route answers 404 and `/health` reports `reset: disabled`.",
      "**A reset is not a re-registration.**",
    ],
  },
  {
    page: "docs/faq.md",
    headings: [
      "Why are the limits enforced in hooks rather than in the agent's prompt?",
      "Do the hooks fire for toolkits shipped with `arcade deploy`?",
      "How do I tell a refusal from a failure?",
      "Why does the $95K approval depend on stripping the note pasted into `LN-2291`?",
      "Why does Charlie's Slack DM come from Alice and not from a bot?",
      "Why two OAuth hops?",
      "Can the control plane see an OAuth misconfiguration?",
      "Do my users need Arcade accounts?",
      "Why does it need a public host when it runs on my machine?",
      "Why Bun?",
      "Which model does the agent run?",
    ],
    facts: [
      "With the note visible, the $95K request reached `/hooks/pre` roughly 5 times in 17; with `/hooks/post` stripping the note first, 5 of 5, and 5 of 5 again on an independent re-measurement.",
      "`chat:write`, `im:write`, `users:read` and `users:read.email`",
      "`MODEL_ID` goes to LangChain's `init_chat_model`, so any provider it knows works with no code change.",
      "Read the auth provider's configuration back through Arcade's admin API rather than off the dashboard",
    ],
  },
  {
    page: "docs/deploying.md",
    headings: ["Deploying"],
    facts: [
      "build the root `Dockerfile`",
      "without `ARCADE_HOOK_SIGNING_SECRET` and `APPROVALS_STORE_TOKEN` the app still starts, but the control plane refuses to",
      "**One persistent disk holds both databases.**",
      "**A redeploy is not a reset.**",
      "**People live in Okta, their roles on the disk.**",
    ],
  },
];

/** What `page` is missing of what moved into it: a heading, at any level, or a fact. */
function movedGaps(text: string, entry: (typeof MOVED)[number]): string[] {
  const titles = new Set(headings(text).map(({ title }) => title));
  return [
    ...entry.headings.filter((title) => !titles.has(title)).map((title) => `heading: ${title}`),
    ...entry.facts.filter((fact) => !text.includes(fact)).map((fact) => `fact: ${fact}`),
  ];
}

/** Pages Further reading does not link as its own bullet, with a line on what the page answers. */
function unlinkedPages(markdown: string, pages: string[]): string[] {
  const bullets = section(markdown, "Further reading").split("\n");
  return pages.filter((page) => !bullets.some((line) => line.startsWith(`- [\`${page}\`](./${page})`) && line.length > page.length * 2 + 30));
}

/** The docs pages that ship: tracked, top-level Markdown under `docs/`. */
const SHIPPED_DOCS = Bun.spawnSync(["git", "ls-files", "docs"], { cwd: REPO })
  .stdout.toString()
  .split("\n")
  .filter((path) => /^docs\/[^/]+\.md$/.test(path));

const read = (page: string) => readFileSync(join(REPO, page), "utf8");

describe("what moved out of the README lives in docs/ (#58)", () => {
  test("after Customization the README carries only Further reading", () => {
    const h2 = headings(README).filter((h) => h.level === 2).map((h) => h.title);
    expect(h2).toEqual([...REQUIRED_H2, ...CONTRIBUTOR_H2, LAST_H2]);
  });

  for (const entry of MOVED) {
    test(`${entry.page} holds its moved sections whole`, () => {
      expect(existsSync(join(REPO, entry.page))).toBe(true);
      expect(movedGaps(read(entry.page), entry)).toEqual([]);
    });
  }

  test("Further reading links every moved page and every page docs/ ships, each with a line on what it answers", () => {
    const pages = [...new Set([...MOVED.map(({ page }) => page), ...SHIPPED_DOCS, "DESIGN.md"])];
    expect(pages.length).toBeGreaterThan(MOVED.length);
    expect(unlinkedPages(README, pages)).toEqual([]);
  });

  test("every variable a moved page names is in .env.example", () => {
    for (const { page } of MOVED) {
      expect({ page, missing: [...variablesNamed(read(page))].filter((name) => !knownVariable(name)) }).toEqual({ page, missing: [] });
    }
  });

  test("every external link in a moved page is one somebody verified", () => {
    for (const { page } of MOVED) expect({ page, unverified: unverifiedUrls(read(page)) }).toEqual({ page, unverified: [] });
  });
});

// --- Each check, shown failing ------------------------------------------------

describe("each check bites on a planted violation", () => {
  test("a variable .env.example does not have", () => {
    const planted = `${README}\nSet \`ARCADE_IDP_PROVIDER_ID\` too.\n`;
    expect([...variablesNamed(planted)].filter((name) => !exampleVariables(ENV_EXAMPLE).has(name))).toEqual(["ARCADE_IDP_PROVIDER_ID"]);
  });

  test("an eighth variable in Prerequisites", () => {
    const planted = README.replace("## Prerequisites\n", "## Prerequisites\n\n- Set `MODEL_ID`.\n");
    expect(variablesNamed(section(planted, "Prerequisites")).has("MODEL_ID")).toBe(true);
    expect(variablesNamed(section(planted, "Prerequisites")).size).toBe(requiredBlock(ENV_EXAMPLE).size + 1);
  });

  test("a stale path, and an anchor that is not there", () => {
    expect(brokenRelativeLinks("[web](./apps/web/README.md) and [setup](#setup-from-zero)")).toEqual([
      "./apps/web/README.md: no such file",
      "#setup-from-zero: no heading with that anchor",
    ]);
    expect(brokenRelativeLinks("[design](./DESIGN.md#identity-and-oauth) and [start](#quickstart-)", join(REPO, "README.md"))).toEqual([
      "#quickstart-: no heading with that anchor",
    ]);
    expect(brokenRelativeLinks(`${README}\n[start](#quickstart-)\n`)).toEqual([]);
  });

  test("a link into a doc #11 deleted, planted in the README itself", () => {
    // The README linked into all three until #11 removed them; each one is now
    // a dead link the check has to catch.
    const planted = `${README}\n[runbook](./docs/RUNBOOK.md), [app](./docs/app.md) and [spikes](./docs/spikes/04-user-source.md)\n`;
    expect(brokenRelativeLinks(planted)).toEqual([
      "./docs/RUNBOOK.md: no such file",
      "./docs/app.md: no such file",
      "./docs/spikes/04-user-source.md: no such file",
    ]);
  });

  test("a Quickstart that opens the app before the tunnel, starts the tunnel before the app, or never starts it", () => {
    const order = QUICKSTART_ORDER.map(([name]) => name);
    const moveBefore = (moving: RegExp, before: RegExp) => {
      const lines = README.split("\n");
      const [line] = lines.splice(lines.findIndex((each) => moving.test(each)), 1);
      lines.splice(lines.findIndex((each) => before.test(each)), 0, line!);
      return lines.join("\n");
    };
    expect(quickstartOrder(moveBefore(/Open `https:\/\/<APP_PUBLIC_HOST>`/, /`ngrok http --url=/))).not.toEqual(order);
    expect(quickstartOrder(moveBefore(/`ngrok http --url=/, /run `bun run dev`\. It prints/))).not.toEqual(order);
    const noTunnel = README.split("\n").filter((line) => !/`ngrok http --url=/.test(line)).join("\n");
    expect(quickstartOrder(noTunnel)).toEqual(["missing: start the tunnel"]);
  });

  test("a step 4 with the deploys before the script, or the hooks not on", () => {
    const order = ONE_CLICK_ORDER.map(([name]) => name);
    const register = registerStep(README);
    const sentences = (text: string) => text.split(/(?<=\.) /);
    const moveBefore = (text: string, moving: RegExp, before: RegExp) => {
      const parts = sentences(text);
      const [part] = parts.splice(parts.findIndex((each) => moving.test(each)), 1);
      parts.splice(parts.findIndex((each) => before.test(each)), 0, part!);
      return parts.join(" ");
    };
    expect(inOrder(moveBefore(register, /Then it runs `arcade deploy`/, /Run `bun run setup-arcade <APP_PUBLIC_HOST>`\./), ONE_CLICK_ORDER)).not.toEqual(order);
    expect(inOrder(register.replace(", with the hooks on", ""), ONE_CLICK_ORDER)).toContain("missing: the hooks, on");
  });

  test("a Prerequisites whose CLI steps are out of order, or missing one", () => {
    const prerequisites = section(README, "Prerequisites");
    const lines = prerequisites.split("\n");
    const [whoami] = lines.splice(lines.findIndex((line) => line.includes("`arcade whoami`")), 1);
    expect(inOrder(lines.join("\n"), CLI_SETUP)).toContain("missing: check it");
    lines.splice(lines.findIndex((line) => line.includes("`arcade login`")), 0, whoami!);
    expect(inOrder(lines.join("\n"), CLI_SETUP)).not.toEqual(CLI_SETUP.map(([name]) => name));
  });

  test("an ngrok command with its port and no variable", () => {
    expect(portsTiedToVariables("5. **Start**\n   - In a second terminal, run `ngrok http --url=<APP_PUBLIC_HOST> 3000`.\n")).toEqual([2]);
    // The line as it stood before the #34 review, planted back into the README.
    const lines = README.split("\n");
    const ngrok = lines.findIndex((line) => line.includes("run the ngrok command `bun run dev` printed"));
    lines[ngrok] = "   - In a second terminal, run that command: `ngrok http --url=<APP_PUBLIC_HOST> 3000`.";
    expect(portsTiedToVariables(lines.join("\n"))).toEqual([ngrok + 1]);
  });

  test("a URL nobody verified", () => {
    expect(unverifiedUrls("[keys](https://console.anthropic.com/) and [studio](http://localhost:4111)")).toEqual([
      "https://console.anthropic.com/",
    ]);
  });

  test("an indented paragraph, and a bold line standing in for a heading", () => {
    expect(indentedParagraphs("Intro.\n\n    An indented paragraph.\n\n- a list\n  - nested, which is fine\n")).toEqual([3]);
    expect(boldTitles("Intro.\n\n**Customization**\n\n- **Label**: a bullet with a bold label is fine\n")).toEqual([3]);
  });
});

describe("the #58 checks bite on a planted violation", () => {
  test("a moved fact deleted from its page, and a moved heading renamed", () => {
    const entry = MOVED.find(({ page }) => page === "docs/configuration.md")!;
    const page = read(entry.page);
    const withoutFact = page.replace("**A reset is not a re-registration.**", "");
    expect(movedGaps(withoutFact, entry)).toEqual(["fact: **A reset is not a re-registration.**"]);
    expect(movedGaps(page.replace("## Resetting the demo", "## Resetting"), entry)).toEqual(["heading: Resetting the demo"]);
  });

  test("a moved section put back in the README", () => {
    const planted = README.replace("## Further reading", "## How the controls work\n\nArcade gives every tool call four control points.\n\n## Further reading");
    const h2 = headings(planted).filter((h) => h.level === 2).map((h) => h.title);
    expect(h2).not.toEqual([...REQUIRED_H2, ...CONTRIBUTOR_H2, LAST_H2]);
  });

  test("a page Further reading drops, or links with no line on what it answers", () => {
    const line = section(README, "Further reading").split("\n").find((each) => each.startsWith("- [`docs/faq.md`]"))!;
    expect(unlinkedPages(README.replace(`${line}\n`, ""), ["docs/faq.md"])).toEqual(["docs/faq.md"]);
    expect(unlinkedPages(README.replace(line, "- [`docs/faq.md`](./docs/faq.md)"), ["docs/faq.md"])).toEqual(["docs/faq.md"]);
  });
});
