/**
 * A `bun test` preload, from `bunfig.toml`, that fails the run when a test file
 * leaves a DOM or a replaced global behind for the files after it (#46).
 *
 * `bun test` runs every file in one global object. A file that leaves happy-dom
 * on it, or leaves `fetch` pointing at its own stand-in, does not fail: the
 * files after it do, or pass for the wrong reason, and only in the orders that
 * put them there. This makes the file that left it fail, by name.
 *
 * Between two test files, and after the last, the global object is compared
 * with what it was before the first:
 *
 * - a global that was there before and now holds something else, or is gone
 *   (`fetch`, `setTimeout`, `Response`, …), and
 * - a global a DOM puts there: any key a happy-dom window has, string or
 *   symbol, and React's `IS_REACT_ACT_ENVIRONMENT`.
 *
 * Other new globals are not a leak: modules keep process-wide singletons on the
 * global object on purpose (zod's registry, `Symbol.for("cg.control-plane")`).
 *
 * Each leak is printed when it is found, naming the file that ran last, and
 * the preload's `afterAll`, which runs once after every file (after each file
 * under `--isolate`), fails with all of them. Bun counts that as a failed test,
 * so the run exits 1 and `scripts/test-shards.ts check` fails the shard.
 *
 * The files are told apart the way `scripts/test-shards-record.ts` does it: an
 * `onResolve` that sees each test file as Bun loads it, after the one before
 * it has finished, `afterAll` included (measured, Bun 1.3.14).
 * `app-test/dom.test.ts` shows it red on planted files.
 */
import { plugin } from "bun";
import { afterAll } from "bun:test";
import { isAbsolute, join, relative } from "node:path";

import { TEST_FILE } from "./test-shards.ts";

const ROOT = join(import.meta.dir, "..");

type Seen = { value: unknown } | { get: unknown; set: unknown };

function snapshot(): Map<PropertyKey, Seen> {
  const seen = new Map<PropertyKey, Seen>();
  for (const key of Reflect.ownKeys(globalThis)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key) as PropertyDescriptor;
    seen.set(key, "value" in descriptor ? { value: descriptor.value } : { get: descriptor.get, set: descriptor.set });
  }
  return seen;
}

function same(a: Seen, b: Seen): boolean {
  if ("value" in a && "value" in b) return Object.is(a.value, b.value);
  if ("get" in a && "get" in b) return a.get === b.get && a.set === b.set;
  return false;
}

const before = snapshot();

let domKeys: Set<PropertyKey> | null = null;
/** Every key a happy-dom window has, read off a throwaway one the first time it is needed. */
function isDomKey(key: PropertyKey): boolean {
  if (key === "IS_REACT_ACT_ENVIRONMENT") return true;
  if (domKeys === null) {
    const { Window } = require("happy-dom") as typeof import("happy-dom");
    const window = new Window();
    domKeys = new Set(Reflect.ownKeys(window));
    void window.happyDOM.close();
  }
  return domKeys.has(key);
}

const name = (key: PropertyKey) => (typeof key === "symbol" ? key.toString() : key);

type Kind = "replaced" | "deleted" | "left";

/** What is different on the global object now, against the snapshot taken before the first file. */
function leftBehind(): Array<{ kind: Kind; key: PropertyKey }> {
  const now = snapshot();
  const found: Array<{ kind: Kind; key: PropertyKey }> = [];
  for (const [key, then] of before) {
    const current = now.get(key);
    if (current === undefined) found.push({ kind: "deleted", key });
    else if (!same(then, current)) found.push({ kind: "replaced", key });
  }
  for (const key of now.keys()) if (!before.has(key) && isDomKey(key)) found.push({ kind: "left", key });
  return found;
}

/** Named first when there are many, because they say what happened. */
const TELLING = ["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch", "setTimeout", "queueMicrotask", "Response", "Request"];

function summarize(kind: Kind, keys: PropertyKey[]): string {
  const ordered = [...keys].sort((a, b) => rank(a) - rank(b));
  const shown = ordered.slice(0, 6).map(name).join(", ");
  const what = kind === "left" ? "DOM global" : "global";
  return `${kind} ${keys.length} ${what}${keys.length === 1 ? "" : "s"} (${shown}${keys.length > 6 ? ", …" : ""})`;
}
function rank(key: PropertyKey): number {
  const at = TELLING.indexOf(String(key));
  return at === -1 ? TELLING.length : at;
}

const leaks: string[] = [];
/** Keys already reported, so the files after the one that leaked are not blamed for it too. */
const reported = new Set<string>();
let last: string | null = null;

function check(): void {
  if (last === null) return;
  const fresh = leftBehind().filter(({ kind, key }) => !reported.has(`${kind} ${name(key)}`));
  if (fresh.length === 0) return;
  for (const { kind, key } of fresh) reported.add(`${kind} ${name(key)}`);
  const parts = (["left", "replaced", "deleted"] as const)
    .map((kind) => [kind, fresh.filter((leak) => leak.kind === kind).map(({ key }) => key)] as const)
    .filter(([, keys]) => keys.length > 0)
    .map(([kind, keys]) => summarize(kind, keys));
  const message =
    `${last} left the global object changed for the files after it: ${parts.join("; ")}. ` +
    "Put back what the file changed in its afterAll; a DOM file installs its DOM with app-test/dom.ts, which does.";
  leaks.push(message);
  console.error(`\n# test-globals: ${message}\n`);
}

const loaded = new Set<string>();
plugin({
  name: "cg-test-globals",
  setup(build) {
    build.onResolve({ filter: TEST_FILE }, (args) => {
      const path = isAbsolute(args.path) ? args.path : join(args.importer === "" ? ROOT : join(args.importer, ".."), args.path);
      if (!loaded.has(path)) {
        loaded.add(path);
        check();
        last = relative(ROOT, path);
      }
      return undefined;
    });
  },
});

afterAll(() => {
  check();
  if (leaks.length > 0) throw new Error(`test-globals: ${leaks.length} test file(s) leaked globals:\n${leaks.join("\n")}`);
});
