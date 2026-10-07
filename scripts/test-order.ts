/**
 * Test files run two at a time, one after the other in one `bun test` process
 * and without `--isolate`, to find a file that leaks state into the file after
 * it (#46).
 *
 *   bun scripts/test-order.ts pairs [--jobs N] <first> <second> [<first> <second> …]
 *       each pair, in both orders
 *   bun scripts/test-order.ts sweep [--jobs N]
 *       every happy-dom file after every other tracked test file, and before it
 *   bun scripts/test-order.ts sample <count> <seed> [--jobs N]
 *       a fixed pseudo-random sample of ordered pairs of tracked test files
 *
 * Why pairs: `bun test` with no arguments runs every file in one global object
 * and one module registry, in one order. A file that leaves something behind
 * breaks only the files after it, so the one order hides every leak whose
 * victim happens to run first. #38's shards put files side by side that the
 * serial order never had, and `panel-live` timed out behind `chat-rendering`.
 *
 * A failed pair is not yet an order dependency. Under `--jobs` several Next
 * servers and Chromes can boot at once, and a file can fail on its own. So
 * every failed pair is run again, alone, and so is each of its two files, and
 * the pair is reported as one of:
 *
 *   order     the pair fails again, and each file passes alone: a leak
 *   alone     one of the two files fails on its own: not about order
 *   load      the pair passes when nothing else is running
 *
 * The exit status is 1 on any `order` or `alone`, and 0 otherwise; `load`
 * pairs are listed, never dropped.
 */
import { spawn } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSummary, testFiles, type Summary } from "./test-shards.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * The happy-dom files: the tracked test files that put a DOM on the global
 * object, through the shared setup (`app-test/dom.ts`) or, as every one did
 * before #46, through happy-dom's own registrator. Only an import statement
 * of its own counts, so a file that plants either as a string to watch it
 * fail (`app-test/dom.test.ts`) is not one.
 */
export const DOM_SETUP =
  /^import\s*\{[^}]*\binstallDom\b[^}]*\}\s*from\s*["'](?:\.\.?\/)+(?:app-test\/)?dom\.ts["']|^(?:import\s*\{\s*GlobalRegistrator\s*\}\s*from|const\s*\{\s*GlobalRegistrator\s*\}\s*=\s*await\s+import\()\s*["']@happy-dom\/global-registrator["']/m;

export function domFiles(files: readonly string[], root = ROOT): string[] {
  return files.filter((file) => DOM_SETUP.test(readFileSync(join(root, file), "utf8")));
}

export type Pair = readonly [first: string, second: string];

/** Every ordered pair with a happy-dom file on at least one side, each once. */
export function sweepPairs(files: readonly string[], dom: readonly string[]): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const d of dom) {
    for (const other of files) {
      if (other === d) continue;
      pairs.set(`${other}\0${d}`, [other, d]);
      pairs.set(`${d}\0${other}`, [d, other]);
    }
  }
  return [...pairs.values()];
}

/** `count` distinct ordered pairs, the same ones for the same seed and files. */
export function samplePairs(files: readonly string[], count: number, seed: number): Pair[] {
  const possible = files.length * (files.length - 1);
  if (count > possible) throw new Error(`asked for ${count} pairs of ${files.length} files, which have ${possible}`);
  // mulberry32: small, and the same sequence on every machine.
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pairs = new Map<string, Pair>();
  while (pairs.size < count) {
    const first = files[Math.floor(next() * files.length)] as string;
    const second = files[Math.floor(next() * files.length)] as string;
    if (first !== second) pairs.set(`${first}\0${second}`, [first, second]);
  }
  return [...pairs.values()];
}

export interface Run {
  files: readonly string[];
  exitCode: number | null;
  summary: Summary;
  passed: boolean;
  log: string;
}

/** A pair (or one file) that takes longer than this is killed and counted as failed. */
const RUN_TIMEOUT_MS = 300_000;

/**
 * `bun test` on these files, in this order, in one process, without
 * `--isolate`. It passes only on exit 0 with every file run, no failed test
 * and no Bun "error": a file that throws while it is imported registers
 * nothing and fails nothing, and Bun still prints "0 fail" (.orca/project.md).
 */
export async function runFiles(files: readonly string[], cwd = ROOT): Promise<Run> {
  const child = spawn(["bun", "test", ...files.map((file) => `./${file}`)], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const log = `${stdout}${stderr}`;
  const summary = parseSummary(log);
  const passed = exitCode === 0 && summary.files === files.length && summary.fail === 0 && summary.error === 0;
  return { files, exitCode, summary, passed, log };
}

export type Verdict = "pass" | "order" | "alone" | "load";

export interface PairResult {
  pair: Pair;
  verdict: Verdict;
  /** The pair's own run, and for a failed pair the re-runs that decided it. */
  runs: Run[];
}

/** Settle a failed pair by running it again and each of its files alone, with nothing else running. */
export async function settle(pair: Pair, first: Run, cwd = ROOT): Promise<PairResult> {
  const again = await runFiles(pair, cwd);
  const alone = [await runFiles([pair[0]], cwd), await runFiles([pair[1]], cwd)];
  const runs = [first, again, ...alone];
  if (alone.some((run) => !run.passed)) return { pair, verdict: "alone", runs };
  return { pair, verdict: again.passed ? "load" : "order", runs };
}

/** Run every pair, `jobs` at a time, then settle the failures one at a time. */
export async function runPairs(
  pairs: readonly Pair[],
  { jobs = 1, cwd = ROOT, progress = (_line: string) => {} } = {},
): Promise<PairResult[]> {
  const firstRuns = new Array<Run>(pairs.length);
  let nextIndex = 0;
  let done = 0;
  const worker = async () => {
    while (nextIndex < pairs.length) {
      const index = nextIndex++;
      const run = await runFiles(pairs[index] as Pair, cwd);
      firstRuns[index] = run;
      done += 1;
      progress(`${done}/${pairs.length} ${run.passed ? "pass" : "FAIL"}  ${run.files.join(" -> ")}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, pairs.length)) }, worker));

  const results: PairResult[] = [];
  for (const [index, pair] of pairs.entries()) {
    const run = firstRuns[index] as Run;
    if (run.passed) {
      results.push({ pair, verdict: "pass", runs: [run] });
      continue;
    }
    const settled = await settle(pair, run, cwd);
    progress(`settled ${settled.verdict}  ${pair.join(" -> ")}`);
    results.push(settled);
  }
  return results;
}

function describeRun(run: Run): string {
  const { summary } = run;
  return (
    `${run.files.join(" -> ")}: exit ${run.exitCode}, ${summary.files ?? "?"} files, ` +
    `${summary.pass} pass, ${summary.fail} fail, ${summary.error} error`
  );
}

/** The report: counts, then every pair that did not simply pass, with the runs behind its verdict. */
export function report(results: readonly PairResult[]): string[] {
  const lines: string[] = [];
  const by = (verdict: Verdict) => results.filter((result) => result.verdict === verdict);
  lines.push(
    `${results.length} pairs: ${by("pass").length} pass, ${by("order").length} order, ` +
      `${by("alone").length} alone, ${by("load").length} load`,
  );
  for (const verdict of ["order", "alone", "load"] as const) {
    for (const result of by(verdict)) {
      lines.push(`${verdict}: ${result.pair.join(" -> ")}`);
      for (const run of result.runs) lines.push(`    ${describeRun(run)}`);
      if (verdict === "order") {
        const failed = [...(result.runs[1]?.log ?? "").matchAll(/^\(fail\) .*$/gm)].map((match) => match[0]);
        for (const line of failed.slice(0, 5)) lines.push(`      ${line}`);
      }
    }
  }
  return lines;
}

function usage(): never {
  console.error(
    [
      "usage: bun scripts/test-order.ts pairs [--jobs N] <first> <second> [<first> <second> …]",
      "       bun scripts/test-order.ts sweep [--jobs N]",
      "       bun scripts/test-order.ts sample <count> <seed> [--jobs N]",
    ].join("\n"),
  );
  process.exit(64);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let jobs = 1;
  const at = args.indexOf("--jobs");
  if (at !== -1) {
    jobs = Number(args[at + 1]);
    if (!Number.isInteger(jobs) || jobs < 1) usage();
    args.splice(at, 2);
  }
  const [mode, ...rest] = args;
  const files = testFiles();
  let pairs: Pair[];
  if (mode === "pairs") {
    if (rest.length === 0 || rest.length % 2 !== 0) usage();
    const tracked = new Set(files);
    for (const file of rest) if (!tracked.has(file)) throw new Error(`${file} is not a tracked test file`);
    pairs = [];
    for (let index = 0; index < rest.length; index += 2) {
      const first = rest[index] as string;
      const second = rest[index + 1] as string;
      pairs.push([first, second], [second, first]);
    }
  } else if (mode === "sweep" && rest.length === 0) {
    const dom = domFiles(files);
    console.log(`${dom.length} happy-dom files of ${files.length} tracked:`);
    for (const file of dom) console.log(`    ${file}`);
    pairs = sweepPairs(files, dom);
  } else if (mode === "sample" && rest.length === 2) {
    pairs = samplePairs(files, Number(rest[0]), Number(rest[1]));
  } else {
    usage();
  }
  console.log(`${pairs.length} ordered pairs, ${jobs} at a time, without --isolate`);
  const started = Date.now();
  const results = await runPairs(pairs, { jobs, progress: (line) => console.log(line) });
  for (const line of report(results)) console.log(line);
  console.log(`${((Date.now() - started) / 1000).toFixed(0)}s`);
  process.exit(results.some((result) => result.verdict === "order" || result.verdict === "alone") ? 1 : 0);
}
