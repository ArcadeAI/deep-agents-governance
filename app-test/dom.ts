/**
 * The one happy-dom window every DOM test file shares (#46).
 *
 * A test file that renders React installs the DOM at the top, imports React
 * after it, and takes its roots from here rather than from `react-dom/client`:
 *
 *   import { createRoot, installDom } from "./dom.ts";
 *   installDom({ url: "http://chat.test/" });
 *   const { act } = await import("react");
 *
 * and nothing else. `installDom` registers the file's own `afterAll`, which
 * unmounts every root the file left mounted, stops what the page still has
 * running, and puts back every global the DOM replaced and every one on
 * `RESTORED` below, whatever the file assigned to them in between. There is
 * nothing to forget. `app-test/dom.test.ts` fails if a test file registers a
 * DOM or imports `react-dom/client` any other way.
 *
 * **Why one window for the whole process, never closed.** `bun test` runs
 * every file in one module registry, so `react-dom/client` is evaluated once,
 * by whichever file imports it first, and keeps what it found then for every
 * later file. Measured on main (#46), both ways:
 *
 * - Each file used to register its own window with `GlobalRegistrator` and
 *   close it in `afterAll`. React keeps the first window's `queueMicrotask`,
 *   and a closed happy-dom window's `queueMicrotask` does nothing (happy-dom
 *   20.14, `BrowserWindow.queueMicrotask`). So in every later file React never
 *   rendered an update made outside `act`: `panel-live` timed out behind
 *   `chat-rendering`, `chat-resume` or `control-plane-strip` (#38).
 * - `panel-keyboard` imported `react-dom/client` statically, which runs before
 *   the file registered its DOM, so React DOM was evaluated with no DOM at all
 *   and `chat-resume` after it failed three tests.
 *
 * So the window is created once, before React is imported, and never closed.
 * What a file leaves in it (roots, timers, fetches, listeners, nodes,
 * storage) is cleared at the end of the file instead, so the next file starts
 * on an empty page. Closing had also been hiding roots nobody unmounted
 * (`chat-resume` mounted a `Chat` with a live reconnect loop in every test):
 * a closed window's timers never fire. Here they would, so the roots are
 * unmounted.
 *
 * `GlobalRegistrator.unregister` also leaves every symbol-keyed property it
 * installed on the global object (it deletes `Object.keys`, which skips
 * symbols); this uses `Reflect.ownKeys` both ways.
 *
 * `scripts/test-globals.ts` checks between every two test files that no DOM
 * and no replaced global survived the file, so a file that installs a DOM some
 * other way and does not clean up fails loudly.
 */
import { afterAll } from "bun:test";
import { GlobalWindow, PropertySymbol } from "happy-dom";
import type { Root } from "react-dom/client";

/** Keys `GlobalRegistrator` never copies from the window, for the same reasons. */
const SKIPPED = new Set<PropertyKey>(["constructor", "undefined", "NaN", "global", "globalThis"]);

/**
 * Restored at the end of a file even though the DOM does not install all of
 * them: DOM files swap the network classes back to Bun's after installing, to
 * talk to a real `Bun.serve`, and set React's act flag.
 */
const RESTORED: readonly PropertyKey[] = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "ReadableStream",
  "TextEncoder",
  "TextDecoder",
  "TextDecoderStream",
  "TextEncoderStream",
  "WritableStream",
  "TransformStream",
  "IS_REACT_ACT_ENVIRONMENT",
];

/** How long the page may take to go quiet once its roots are unmounted. */
const QUIET_MS = 2_000;

type Listeners = Map<string, unknown[]>;
interface ListenerTarget {
  removeEventListener(type: string, listener: unknown, options: { capture: boolean }): void;
  [key: symbol]: unknown;
}

interface Installed {
  url: string;
  /** The test file that called `installDom`, for the messages. */
  by: string;
  saved: Map<PropertyKey, PropertyDescriptor | undefined>;
  roots: Set<Root>;
}

let shared: GlobalWindow | null = null;
let current: Installed | null = null;

/** The file that called into this module, from the stack. */
function caller(): string {
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  const outside = lines.find((line) => !line.includes(import.meta.path) && /\/[^/]+\.[cm]?[jt]sx?:\d+/.test(line));
  const match = outside?.match(/(\/[^\s()]+?\.[cm]?[jt]sx?):\d+/);
  return match?.[1]?.replace(`${import.meta.dir.replace(/\/app-test$/, "")}/`, "") ?? "(unknown file)";
}

/**
 * Put the shared happy-dom window on the global object for the rest of the
 * calling test file, at `url`, on an empty page.
 */
export function installDom({ url }: { url: string }): GlobalWindow {
  const by = caller();
  if (current !== null) {
    throw new Error(
      `installDom (${by}): ${current.by} installed a DOM that is still on the global object. ` +
        "It did not finish, or it called installDom twice.",
    );
  }
  if ("document" in globalThis || "window" in globalThis) {
    throw new Error(
      `installDom (${by}): something other than app-test/dom.ts left a DOM on the global object ` +
        `(document: ${typeof (globalThis as { document?: unknown }).document}). Every DOM test file installs ` +
        "its DOM through installDom, which takes it off again at the end of the file.",
    );
  }
  const window = (shared ??= new GlobalWindow({ url, console: globalThis.console }));
  window.happyDOM.setURL(url);

  const saved = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const key of RESTORED) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of Reflect.ownKeys(window)) {
    if (SKIPPED.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(window, key) as PropertyDescriptor;
    const existing = Object.getOwnPropertyDescriptor(globalThis, key);
    if (existing !== undefined && "value" in existing && existing.value !== undefined && existing.value === descriptor.value) {
      continue;
    }
    if (!saved.has(key)) saved.set(key, existing);
    // The window's references to itself (`window`, `self`, `top`, …) point at
    // the global object, as `GlobalRegistrator` makes them.
    if (descriptor.value === window) {
      (window as unknown as Record<PropertyKey, unknown>)[key] = globalThis;
      descriptor.value = globalThis;
    }
    Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
  }
  (window.document as unknown as Record<symbol, unknown>)[PropertySymbol.defaultView] = globalThis;
  current = { url, by, saved, roots: new Set() };

  afterAll(uninstallDom);
  return window;
}

/**
 * `react-dom/client`'s `createRoot`, for a DOM installed by `installDom`. The
 * file's `afterAll` unmounts the root if the file did not.
 */
export function createRoot(container: Element | DocumentFragment): Root {
  if (current === null) throw new Error(`createRoot (${caller()}): call installDom first`);
  // `require`, not a static import: this module is imported before the DOM
  // exists, and React DOM must first be evaluated with one.
  const client = require("react-dom/client") as typeof import("react-dom/client");
  const root = client.createRoot(container);
  current.roots.add(root);
  return root;
}

function removeAllListeners(target: ListenerTarget): void {
  const listeners = target[PropertySymbol.listeners] as { bubbling: Listeners; capturing: Listeners } | undefined;
  if (listeners === undefined) return;
  for (const [phase, capture] of [
    [listeners.bubbling, false],
    [listeners.capturing, true],
  ] as const) {
    for (const [type, list] of phase) {
      for (const listener of [...list]) target.removeEventListener(type, listener, { capture });
    }
  }
}

/**
 * Take the DOM off the global object and empty the window. `installDom`
 * registers this as the file's `afterAll`. The globals go back even when the
 * page does not go quiet, so that the next file is not blamed; the error is
 * this file's.
 */
export async function uninstallDom(): Promise<void> {
  if (current === null || shared === null) return;
  const { saved, roots, url, by } = current;
  const window = shared;
  current = null;
  let problem: string | null = null;
  try {
    const { act } = require("react") as typeof import("react");
    // Inside `act`, so the effects' cleanups run now. The flag is one of
    // `RESTORED`, put back below. Unmounting an unmounted root does nothing,
    // so every root is unmounted whether or not the file did it.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const root of roots) await act(async () => root.unmount());
    // Timers, intervals, animation frames and fetches the page still has.
    // `abort` resolves only once none is left, so a page that keeps starting
    // new ones is reported rather than waited on forever.
    const quiet = await Promise.race([
      window.happyDOM.abort().then(() => true),
      Bun.sleep(QUIET_MS).then(() => false),
    ]);
    if (!quiet) {
      problem =
        `${by}: the page at ${url} was still starting timers or requests ${QUIET_MS}ms after every root ` +
        "was unmounted. Something the file started outside React is still running.";
    }
    removeAllListeners(window as unknown as ListenerTarget);
    // `document.open` removes the document's listeners and every node, and
    // leaves an empty html, head and body.
    window.document.open();
    window.document.close();
    window.localStorage.clear();
    window.sessionStorage.clear();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete (globalThis as Record<PropertyKey, unknown>)[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  }
  if (problem !== null) throw new Error(problem);
}
