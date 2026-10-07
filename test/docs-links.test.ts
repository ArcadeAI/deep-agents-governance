/**
 * Every relative link and `#anchor` in `README.md` and in each `docs/*.md`
 * resolves (#58). The README's internals moved into `docs/`, so the links now
 * run both ways between them and between the pages, and a moved heading that
 * drops its anchor breaks a link in another file. `readme.test.ts` checks the
 * README's links from the README's side; this checks every page the same way,
 * each read as its own file, so `../README.md#quickstart-` from `docs/` and
 * `./docs/faq.md` from the root are both resolved where they are written.
 *
 * The pages are the tracked ones: `docs/PRESENTATION-BRIEF.md` is untracked on
 * purpose and never ships, so a checkout that has it is not checked against it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { brokenRelativeLinks, links } from "./markdown.ts";

const REPO = join(import.meta.dir, "..");

const TRACKED = Bun.spawnSync(["git", "ls-files", "README.md", "docs"], { cwd: REPO }).stdout.toString().split("\n");
/** README.md and the top-level pages under `docs/`, plus the pages #58 adds, which are new until they are committed. */
const PAGES = [
  ...new Set([
    ...TRACKED.filter((path) => path === "README.md" || /^docs\/[^/]+\.md$/.test(path)),
    "README.md",
    "docs/architecture.md",
    "docs/configuration.md",
    "docs/deploying.md",
    "docs/faq.md",
  ]),
].sort();

const relative = (markdown: string) => links(markdown).filter((target) => !/^(https?:|mailto:)/.test(target));

describe("every relative link and anchor in the README and docs/ resolves", () => {
  test("the pages checked include the README and every docs page", () => {
    expect(PAGES).toContain("README.md");
    expect(PAGES.filter((page) => page.startsWith("docs/")).length).toBeGreaterThanOrEqual(8);
  });

  test("across all of them, there are links to check, anchors among them", () => {
    const all = PAGES.flatMap((page) => relative(readFileSync(join(REPO, page), "utf8")));
    expect(all.length).toBeGreaterThan(30);
    expect(all.filter((target) => target.includes("#")).length).toBeGreaterThan(5);
  });

  for (const page of PAGES) {
    test(page, () => {
      expect(brokenRelativeLinks(readFileSync(join(REPO, page), "utf8"), join(REPO, page))).toEqual([]);
    });
  }
});

describe("the check bites", () => {
  test("a link from docs/ that still points at a README section that moved out", () => {
    const page = join(REPO, "docs", "DOMAIN-SWAP.md");
    const planted = `${readFileSync(page, "utf8")}\n[the FAQ](../README.md#faq) and [reset](../README.md#resetting-the-demo)\n`;
    expect(brokenRelativeLinks(planted, page)).toEqual([
      "../README.md#faq: no heading with that anchor",
      "../README.md#resetting-the-demo: no heading with that anchor",
    ]);
  });

  test("a link read from the wrong directory, and an anchor into a page that renamed its heading", () => {
    const faq = join(REPO, "docs", "faq.md");
    // Written as if from the root: from docs/ it names docs/docs/architecture.md.
    expect(brokenRelativeLinks("[layers](./docs/architecture.md#how-the-controls-work)", faq)).toEqual([
      "./docs/architecture.md#how-the-controls-work: no such file",
    ]);
    expect(brokenRelativeLinks("[layers](./architecture.md#how-the-controls-work)", faq)).toEqual([]);
    expect(brokenRelativeLinks("[layers](./architecture.md#the-controls)", faq)).toEqual([
      "./architecture.md#the-controls: no heading with that anchor",
    ]);
  });

  test("an anchor into a page's own heading, with the heading gone", () => {
    const faq = join(REPO, "docs", "faq.md");
    const text = readFileSync(faq, "utf8");
    const planted = `${text}\n[above](#why-bun)\n`;
    expect(brokenRelativeLinks(planted, faq)).toEqual([]);
    expect(brokenRelativeLinks(planted.replace("## Why Bun?", "## Bun"), faq)).toEqual(["#why-bun: no heading with that anchor"]);
  });
});
