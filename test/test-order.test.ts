/**
 * `scripts/test-order.ts` (#46): which files it pairs, and what it calls a
 * failed pair, shown on real `bun test` runs of planted files.
 *
 * A sweep that matched no happy-dom file would run zero pairs and pass, so the
 * first test is that it finds the DOM files by name.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DOM_SETUP, domFiles, runPairs, samplePairs, sweepPairs } from "../scripts/test-order.ts";
import { testFiles } from "../scripts/test-shards.ts";

const FILES = testFiles();

describe("the pairs", () => {
  test("finds every file that puts happy-dom on the global object, and no other", () => {
    const dom = domFiles(FILES);
    for (const file of [
      "app-test/control-plane-strip.test.tsx",
      "app-test/panel-keyboard.test.tsx",
    ]) {
      expect(dom).toContain(file);
    }
    // Files that plant one as a string to watch it fail never install one in
    // the runner's own process.
    expect(dom).not.toContain("app-test/dom.test.ts");
    expect(dom).not.toContain("test/test-order.test.ts");
  });

  test("finds them the way main's files did it, too", () => {
    const main = {
      "chat-rendering": `const { GlobalRegistrator } = await import("@happy-dom/global-registrator");\nGlobalRegistrator.register({ url: "http://chat.test/" });`,
      "panel-keyboard": `import { aGovernanceEvent } from "@cg/policy-schema";\nimport { GlobalRegistrator } from "@happy-dom/global-registrator";`,
    };
    for (const source of Object.values(main)) expect(DOM_SETUP.test(source)).toBe(true);
    expect(DOM_SETUP.test(`import { childEnv } from "./child-env.ts";`)).toBe(false);
  });

  test("the sweep is every other file before and after each DOM file, each ordered pair once", () => {
    const dom = domFiles(FILES);
    const pairs = sweepPairs(FILES, dom);
    const others = FILES.length - 1;
    const domToDom = dom.length * (dom.length - 1);
    expect(pairs.length).toBe(2 * dom.length * others - domToDom);
    expect(new Set(pairs.map((pair) => pair.join(" "))).size).toBe(pairs.length);
    expect(pairs.every(([first, second]) => first !== second && (dom.includes(first) || dom.includes(second)))).toBe(true);
    for (const d of dom) {
      expect(pairs).toContainEqual(["test/readme.test.ts", d]);
      expect(pairs).toContainEqual([d, "test/readme.test.ts"]);
    }
  });

  test("a sample is the same for the same seed, distinct, and at least what was asked for", () => {
    const one = samplePairs(FILES, 200, 46);
    expect(one).toEqual(samplePairs(FILES, 200, 46));
    expect(one).not.toEqual(samplePairs(FILES, 200, 47));
    expect(new Set(one.map((pair) => pair.join(" "))).size).toBe(200);
    expect(one.every(([first, second]) => first !== second)).toBe(true);
  });
});

const scratch = mkdtempSync(join(tmpdir(), "cg-test-order-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PLANTED = {
  "leaks.test.ts": `import { test } from "bun:test";\ntest("leaves a global behind", () => { (globalThis as { leaked?: boolean }).leaked = true; });\n`,
  "minds-the-leak.test.ts": `import { expect, test } from "bun:test";\ntest("fails if an earlier file leaked", () => expect((globalThis as { leaked?: boolean }).leaked).toBeUndefined());\n`,
  "broken.test.ts": `import { expect, test } from "bun:test";\ntest("fails on its own", () => expect(1).toBe(2));\n`,
  "throws.test.ts": `throw new Error("fails while it is imported");\n`,
};
for (const [name, source] of Object.entries(PLANTED)) writeFileSync(join(scratch, name), source);

describe("a pair, from a real bun test in one process", async () => {
  const results = await runPairs(
    [
      ["leaks.test.ts", "minds-the-leak.test.ts"],
      ["minds-the-leak.test.ts", "leaks.test.ts"],
      ["leaks.test.ts", "broken.test.ts"],
      ["leaks.test.ts", "throws.test.ts"],
    ],
    { jobs: 2, cwd: scratch },
  );
  const verdict = (first: string, second: string) =>
    results.find(({ pair }) => pair[0] === first && pair[1] === second)?.verdict;

  test("is an order dependency when it fails and each file passes alone", () => {
    expect(verdict("leaks.test.ts", "minds-the-leak.test.ts")).toBe("order");
    expect(verdict("minds-the-leak.test.ts", "leaks.test.ts")).toBe("pass");
  });

  test("is not about order when one of its files fails alone, and a Bun error counts as failing", () => {
    expect(verdict("leaks.test.ts", "broken.test.ts")).toBe("alone");
    expect(verdict("leaks.test.ts", "throws.test.ts")).toBe("alone");
  });

  test("keeps the runs behind a verdict", () => {
    const order = results.find(({ verdict }) => verdict === "order");
    expect(order?.runs.map(({ files }) => files)).toEqual([
      ["leaks.test.ts", "minds-the-leak.test.ts"],
      ["leaks.test.ts", "minds-the-leak.test.ts"],
      ["leaks.test.ts"],
      ["minds-the-leak.test.ts"],
    ]);
    expect(order?.runs.map(({ passed }) => passed)).toEqual([false, false, true, true]);
  });
});
