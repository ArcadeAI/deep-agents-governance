/**
 * #46 — the shared happy-dom setup (`app-test/dom.ts`) and the preload that
 * fails a file for what it leaves on the global object
 * (`scripts/test-globals.ts`).
 *
 * The leak this exists for makes no noise in the file that causes it. On main,
 * `chat-rendering` then `panel-live` failed in one process and passed the
 * other way round, because every DOM file closed its own window and React DOM,
 * evaluated once per process, kept the first one's `queueMicrotask`. So each
 * claim here is a real `bun test` over planted files, run from the repo root
 * so `bunfig.toml`'s preload is the one a developer gets, in the order that
 * used to break:
 *
 * - two files that each render an update outside `act` pass in one process,
 *   through `installDom`, and the second fails the way main did when each file
 *   closes a window of its own;
 * - a file that installs a DOM some other way and leaves it, or leaves `fetch`
 *   replaced, fails the run by name;
 * - a root the file never unmounted is unmounted at the end of the file, and a
 *   page that will not go quiet fails its own file, not the next one.
 *
 * The last test is the rule that keeps the next DOM file on `installDom`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { testFiles } from "../scripts/test-shards.ts";
import { childEnv } from "./child-env.ts";
import { spawnChild } from "./child.ts";

const ROOT = join(import.meta.dir, "..");
// Inside the repo, so the planted files resolve happy-dom and React from its
// node_modules; `.test-fixtures/` is gitignored for throwaway files like these.
mkdirSync(join(ROOT, ".test-fixtures"), { recursive: true });
const planted = mkdtempSync(join(ROOT, ".test-fixtures", "dom-"));
afterAll(() => rmSync(planted, { recursive: true, force: true }));

const DOM = JSON.stringify(join(ROOT, "app-test", "dom.ts"));

/**
 * A test that renders `after` 10ms after mounting, from a timer, outside
 * `act`: the update React stopped rendering on main once an earlier file had
 * closed its window.
 */
const RENDERS_LATER = `
test("renders an update made outside act", async () => {
  const { act, createElement, useEffect, useState } = await import("react");
  function Later() {
    const [text, setText] = useState("before");
    useEffect(() => {
      const timer = setTimeout(() => setText("after"), 10);
      return () => clearTimeout(timer);
    }, []);
    return createElement("p", null, text);
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(Later)));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  const deadline = Date.now() + 2_000;
  while (host.textContent !== "after" && Date.now() < deadline) await Bun.sleep(10);
  expect(host.textContent).toBe("after");
  root.unmount();
});
`;

const FILES: Record<string, string> = {
  // Through the shared setup, as every DOM file is now.
  "shared-a.test.ts": `import { expect, test } from "bun:test";\nimport { createRoot, installDom } from ${DOM};\ninstallDom({ url: "http://a.test/" });\n${RENDERS_LATER}`,
  "shared-b.test.ts": `import { expect, test } from "bun:test";\nimport { createRoot, installDom } from ${DOM};\ninstallDom({ url: "http://b.test/" });\n${RENDERS_LATER}`,
  // What every DOM file did on main: a window of its own, closed in afterAll.
  "closes-a.test.ts": `import { afterAll, expect, test } from "bun:test";\nimport { GlobalRegistrator } from "@happy-dom/global-registrator";\nGlobalRegistrator.register({ url: "http://a.test/" });\nconst { createRoot } = await import("react-dom/client");\nafterAll(() => GlobalRegistrator.unregister());\n${RENDERS_LATER}`,
  "closes-b.test.ts": `import { afterAll, expect, test } from "bun:test";\nimport { GlobalRegistrator } from "@happy-dom/global-registrator";\nGlobalRegistrator.register({ url: "http://b.test/" });\nconst { createRoot } = await import("react-dom/client");\nafterAll(() => GlobalRegistrator.unregister());\n${RENDERS_LATER}`,
  // A DOM put on the global object and never taken off.
  "forgets.test.ts": `import { expect, test } from "bun:test";\nimport { GlobalRegistrator } from "@happy-dom/global-registrator";\nGlobalRegistrator.register({ url: "http://forgets.test/" });\ntest("has a document", () => expect(typeof document).toBe("object"));\n`,
  // \`fetch\` pointed at a stand-in and never put back.
  "keeps-fetch.test.ts": `import { expect, test } from "bun:test";\nglobalThis.fetch = (async () => new Response("stand-in")) as unknown as typeof fetch;\ntest("uses the stand-in", async () => expect(await (await fetch("http://x.test/")).text()).toBe("stand-in"));\n`,
  "innocent.test.ts": `import { expect, test } from "bun:test";\ntest("runs after", () => expect(1).toBe(1));\n`,
  // A root left mounted, whose effect runs a loop happy-dom cannot abort: only
  // unmounting stops it.
  "never-unmounts.test.ts": `import { test } from "bun:test";
import { createRoot, installDom } from ${DOM};
installDom({ url: "http://never-unmounts.test/" });
test("mounts and walks away", async () => {
  const { act, createElement, useEffect } = await import("react");
  const counter = globalThis as { plantedTicks?: number };
  counter.plantedTicks = 0;
  function Ticks() {
    useEffect(() => {
      let live = true;
      void (async () => { while (live) { counter.plantedTicks = (counter.plantedTicks ?? 0) + 1; await Bun.sleep(5); } })();
      return () => { live = false; };
    }, []);
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => createRoot(host).render(createElement(Ticks)));
  await Bun.sleep(30);
});
`,
  "after-unmount.test.ts": `import { expect, test } from "bun:test";
test("the earlier file's root is no longer running", async () => {
  const counter = globalThis as { plantedTicks?: number };
  expect(counter.plantedTicks).toBeGreaterThan(0);
  const then = counter.plantedTicks;
  await Bun.sleep(100);
  expect(counter.plantedTicks).toBe(then);
});
`,
  // Starts a page timer on every turn of the event loop, from outside React,
  // for 3s: longer than the 2s the page gets to go quiet, so there is always
  // one pending when happy-dom looks (it looks 1ms after an abort), and then
  // it stops, so the next file's page can go quiet.
  "never-quiet.test.ts": `import { test } from "bun:test";
import { installDom } from ${DOM};
const window = installDom({ url: "http://never-quiet.test/" });
const until = Date.now() + 3_000;
const again = () => { window.setTimeout(() => {}, 50); if (Date.now() < until) setImmediate(again); };
again();
test("starts something it does not stop", () => {});
`,
  "after-never-quiet.test.ts": `import { expect, test } from "bun:test";
import { installDom } from ${DOM};
installDom({ url: "http://after.test/" });
test("starts on a clean global object", () => expect(document.body.childNodes.length).toBe(0));
`,
};
for (const [name, source] of Object.entries(FILES)) writeFileSync(join(planted, name), source);

interface Ran {
  log: string;
  exitCode: number;
  failed: string[];
}

/** `bun test` on the planted files, in this order, from the repo root, in one process. */
async function run(...names: string[]): Promise<Ran> {
  const child = spawnChild({
    cmd: ["bun", "test", ...names.map((name) => `./${relative(ROOT, join(planted, name))}`)],
    cwd: ROOT,
    env: childEnv({}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exitCode = await child.exited;
  const log = `${stdout}${stderr}`;
  return { log, exitCode, failed: [...log.matchAll(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/gm)].map((match) => match[1] as string) };
}

describe("two DOM files in one process", () => {
  test.each([
    ["shared-a.test.ts", "shared-b.test.ts"],
    ["shared-b.test.ts", "shared-a.test.ts"],
  ])("through installDom, %s then %s both render an update outside act", async (first, second) => {
    const ran = await run(first, second);
    expect(ran.failed).toEqual([]);
    expect(ran.log).toMatch(/^\s*2 pass$/m);
    expect(ran.log).not.toContain("test-globals");
    expect(ran.exitCode).toBe(0);
  }, 30_000);

  test("each closing a window of its own, as on main, the second renders nothing, and the run names the leak", async () => {
    const ran = await run("closes-a.test.ts", "closes-b.test.ts");
    // Each passes alone, so the failure is the order.
    expect((await run("closes-b.test.ts")).failed).not.toContain("renders an update made outside act");
    expect(ran.failed).toContain("renders an update made outside act");
    expect(ran.log).toMatch(/^\s*1 pass$/m);
    // What `GlobalRegistrator.unregister` leaves: the act flag and happy-dom's symbol-keyed globals.
    expect(ran.log).toContain("closes-a.test.ts left the global object changed for the files after it: left ");
    expect(ran.log).toContain("Symbol(listeners)");
    expect(ran.exitCode).toBe(1);
  }, 30_000);
});

describe("a file that forgets to clean up fails the run, by name", () => {
  test("a DOM registered some other way and never taken off", async () => {
    const ran = await run("forgets.test.ts", "innocent.test.ts");
    expect(ran.log).toMatch(/forgets\.test\.ts left the global object changed for the files after it: left \d+ DOM globals \(window, document, /);
    expect(ran.log).toMatch(/; replaced \d+ globals \(fetch, setTimeout, queueMicrotask, /);
    expect(ran.log).toContain("test-globals: 1 test file(s) leaked globals");
    expect(ran.exitCode).toBe(1);
  }, 30_000);

  test("a replaced fetch", async () => {
    const ran = await run("keeps-fetch.test.ts", "innocent.test.ts");
    expect(ran.log).toContain("keeps-fetch.test.ts left the global object changed for the files after it: replaced 1 global (fetch)");
    expect(ran.exitCode).toBe(1);
  }, 30_000);

  test("even when it is the last file", async () => {
    const ran = await run("innocent.test.ts", "forgets.test.ts");
    expect(ran.log).toContain("forgets.test.ts left the global object changed");
    expect(ran.log).not.toContain("innocent.test.ts left");
    expect(ran.exitCode).toBe(1);
  }, 30_000);

  test("the next DOM file refuses to start on the leftover DOM, and says whose it is not", async () => {
    const ran = await run("forgets.test.ts", "shared-a.test.ts");
    expect(ran.log).toContain("something other than app-test/dom.ts left a DOM on the global object");
    expect(ran.exitCode).toBe(1);
  }, 30_000);
});

describe("what a DOM file leaves in the window", () => {
  test("a root the file never unmounted is unmounted at the end of the file", async () => {
    const ran = await run("never-unmounts.test.ts", "after-unmount.test.ts");
    expect(ran.failed).toEqual([]);
    expect(ran.log).toMatch(/^\s*2 pass$/m);
    expect(ran.exitCode).toBe(0);
  }, 30_000);

  test("a page that never goes quiet fails its own file, and the next file still starts clean", async () => {
    const ran = await run("never-quiet.test.ts", "after-never-quiet.test.ts");
    expect(ran.log).toContain("never-quiet.test.ts: the page at http://never-quiet.test/ was still starting timers");
    expect(ran.failed).not.toContain("starts on a clean global object");
    expect(ran.log).not.toContain("left the global object changed");
    expect(ran.exitCode).toBe(1);
  }, 30_000);
});

/**
 * The rule that keeps a new DOM file from reintroducing the leak: no test code
 * registers happy-dom or imports `react-dom/client` except `app-test/dom.ts`.
 * A static import of React DOM runs before the file's first line, so it is
 * evaluated before any DOM exists (`panel-keyboard`, #46).
 */
// Code, not a string that quotes it: nothing on the line before the match may
// open a string, so a file that plants the old way to watch it fail (this one,
// `test/test-order.test.ts`) is not caught for it.
const FORBIDDEN: ReadonlyArray<[what: string, pattern: RegExp]> = [
  [
    "registers happy-dom itself",
    /^[^\n`"']*(?:from\s*|import\(\s*)["']@happy-dom\/global-registrator["']|^[^\n`"']*\bnew\s+(?:Global)?Window\s*\(/m,
  ],
  [
    "imports react-dom/client, not app-test/dom.ts's createRoot",
    /^\s*import\s+(?!type\b)[^;]*?from\s+["']react-dom\/client["']|^[^\n`"']*import\(\s*["']react-dom\/client["']\s*\)(?!\s*\.)/m,
  ],
];

test("no test code installs a DOM or imports react-dom/client except through app-test/dom.ts", () => {
  const tracked = testFiles();
  expect(tracked).toContain("app-test/panel-keyboard.test.tsx");
  // The helpers and workers beside the test files, too.
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "app-test", "test"], { cwd: ROOT }).stdout.toString().split("\0");
  const sources = [...new Set([...tracked, ...listed])].filter((file) => /\.[cm]?[jt]sx?$/.test(file) && file !== "app-test/dom.ts");
  const found: string[] = [];
  for (const file of sources) {
    let source: string;
    try {
      source = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue; // deleted in the working tree, not yet in the index
    }
    for (const [what, pattern] of FORBIDDEN) if (pattern.test(source)) found.push(`${file} ${what}`);
  }
  expect(found).toEqual([]);
});

test("the rule catches each way main's DOM files did it", () => {
  const main = [
    `const { GlobalRegistrator } = await import("@happy-dom/global-registrator");`,
    `import { GlobalRegistrator } from "@happy-dom/global-registrator";`,
    `import { createRoot } from "react-dom/client";`,
    `const { createRoot } = await import("react-dom/client");`,
  ];
  for (const line of main) expect(FORBIDDEN.some(([, pattern]) => pattern.test(line))).toBe(true);
  for (const line of [
    `type Root = import("react-dom/client").Root;`,
    `import type { Root } from "react-dom/client";`,
    `  "forgets.test.ts": \`import { GlobalRegistrator } from "@happy-dom/global-registrator";\\n\`,`,
  ]) {
    expect(FORBIDDEN.some(([, pattern]) => pattern.test(line))).toBe(false);
  }
});
