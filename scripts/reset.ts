/**
 * `bun run reset`: the demo back to the seeded state, in seconds.
 *
 *     bun run reset
 *
 * Two databases, two modules of the one app:
 *
 *     control plane   POST /hooks/admin/reset   {"mode":"demo"}: the four
 *                                         policy tables from the fixture, and
 *                                         grants, approval requests and the
 *                                         audit log emptied (`apps/hooks`
 *                                         until #4)
 *     loan module     POST /bank/admin/reset   the loan book, LN-2291 unapproved
 *                                         (`apps/loan-app` until #5)
 *
 * **It never deletes a user** (#32, #33). Somebody added with `bun run users`
 * keeps their `subjects` row. Only the demo cast's subjects (the fixture's
 * addresses, where `bun run users seed-demo` put them) are put back to the
 * demo's roles and clearances; one that is not on disk is not added. Each line
 * of output names who was kept.
 *
 * Both at one address: `APP_PUBLIC_HOST`. To reset a deployment rather than
 * this checkout's app, run the command with that deployment's
 * `APP_PUBLIC_HOST` and `RESET_TOKEN` in its environment.
 *
 * ## Identity is not reset here
 *
 * People, passwords and sessions are Okta's, and this command holds no Okta
 * credential. Nobody is signed out between takes, which is what #123 wanted
 * anyway: re-signing four personas in costs stage time and buys nothing.
 * `--hard`, which used to reset the bundled identity provider too, is refused
 * by name and says how to sign somebody out from clean (#174's case).
 *
 * ## Why HTTP and not a shell
 *
 * Each service seeds from the fixture compiled into **its own running image**.
 * A `sqlite3` session in a shell on the host cannot promise that: on 2026-09-14,
 * on the stage demo's deployment, two of three manual reseeds were attached to a
 * rolled-back instance and wrote
 * the old rows back, so the next deploy failed closed again (#106). The
 * endpoint is served by the process that is actually answering requests, which
 * is the only thing that can make the promise.
 *
 * It also means this command needs no SSH, no shell on the host and no
 * `sqlite3`: just one bearer and one address.
 *
 * ## Two things this is not
 *
 * **A redeploy is not a reset.** Both databases sit on a persistent disk
 * and seed only when empty (#29), so a redeploy carries every stage edit and
 * every approval forward. This command is the only way back.
 *
 * **A reset is not a re-registration.** The Okta client Arcade's
 * `app-identity` provider and User Source are registered against is not
 * touched by anything here.
 *
 * ## Addresses
 *
 * HOST-form, and read from the environment, never derived: a guessed hostname
 * is somebody else's deployment. The one variable is `APP_PUBLIC_HOST`, which
 * this checkout's `.env` already carries. Scheme is added here: `http` for
 * loopback, `https` for everything else.
 *
 * There is no `--target`. It chose between this checkout and the stage demo's
 * hosted deployment until #11, and it is refused by name rather than ignored:
 * a presenter who typed it expects some other environment to be reset, and
 * quietly resetting this one instead is the half-reset believed clean.
 */

import { assertPublicHost, PublicHostError } from "../gate/service/public-host.ts";

/** sysexits: the environment is wrong, not the invocation. */
const EX_CONFIG = 78;

interface ServiceSpec {
  /** What the output calls it. */
  label: string;
  body?: unknown;
  /**
   * Its reset endpoint: `/hooks/admin/reset` for the control plane since #4,
   * which the app mounts under `/hooks`, and `/bank/admin/reset` for the loan
   * module since #5, mounted under `/bank`.
   */
  resetPath: string;
}

/** The one address both modules are reset at. */
const APP_HOST = "APP_PUBLIC_HOST";

/**
 * Everything a reset puts back, in order. Neither holds a credential Arcade is
 * registered against, so neither can produce the dead grant #123 is about.
 */
export const SERVICES: readonly ServiceSpec[] = [
  // `demo` explicitly, never the endpoint's own default: `policy` is the
  // conservative mode for a caller that did not say, and a rehearsal reset
  // that quietly left the audit log full is exactly the silent half-reset this
  // command exists to replace.
  {
    label: "hooks",
    body: { mode: "demo" },
    resetPath: "/hooks/admin/reset",
  },
  // The loan module, in the app since #5. Still labelled `loan-app`, because
  // that is what its reset answers as and what a presenter reads in this
  // output.
  {
    label: "loan-app",
    resetPath: "/bank/admin/reset",
  },
];

/** Why `--hard` is refused, and what to do instead. */
export const NO_HARD_RESET =
  "--hard is not an option any more: people, passwords and sessions live in Okta, and this command " +
  "holds no Okta credential. To show signing in from clean, sign out in the app, then clear the " +
  "person's Okta session (Admin Console: Directory, People, the person, More Actions, Clear User Sessions).";

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[?::1\]?)(:\d+)?$/i;

export function originFor(host: string): string {
  return `${LOOPBACK.test(host) ? "http" : "https"}://${host}`;
}

export interface ResetOptions {
  env: Record<string, string | undefined>;
  /** Injected in tests; `fetch` in anger. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export interface ServiceOutcome {
  label: string;
  ok: boolean;
  line: string;
}

export interface ResetOutcome {
  ok: boolean;
  services: ServiceOutcome[];
}

/** A configuration problem: names the variable and where the value comes from. */
export class ResetConfigError extends Error {}

function requireToken(env: Record<string, string | undefined>): string {
  const token = env.RESET_TOKEN?.trim() ?? "";
  if (token.length > 0) return token;
  throw new ResetConfigError(
    "RESET_TOKEN is unset. It is the bearer both modules require, it has no development " +
      "default, and without it each of them answers 404 on its admin/reset route. Generate one " +
      "with `openssl rand -hex 32`, set it on the app (which holds the control plane and the loan " +
      "module), and put the same value in .env.local here.",
  );
}

function requireHost(options: ResetOptions): string {
  const name = APP_HOST;
  const host = options.env[name]?.trim() ?? "";
  if (host.length === 0) {
    throw new ResetConfigError(
      `${name} is unset, so there is no address for the app. Set it to the host the app is ` +
        "served on, host part only and no scheme: the ngrok domain for this checkout, or the " +
        "deployment's own host. Never derive or guess it: a guessed hostname is somebody " +
        "else's deployment.",
    );
  }
  try {
    assertPublicHost(name, host);
  } catch (cause) {
    if (cause instanceof PublicHostError) throw new ResetConfigError(cause.message);
    throw cause;
  }
  return host;
}

/** `4 → 4`, or `918 → 0`, for every table the service reported. */
function deltas(before: Record<string, number>, after: Record<string, number>): string {
  return Object.keys(after)
    .map((table) => `${table} ${before[table] ?? 0}→${after[table] ?? 0}`)
    .join(", ");
}

/**
 * One service: POST, read the body, turn it into a line a presenter can read
 * at a glance.
 *
 * A non-2xx is reported with the status **and** the body, because the two
 * interesting failures are distinguishable only that way: a 404 means
 * `RESET_TOKEN` is unset on *that service* (the route does not exist), and a
 * 401 means this command holds a different value from the one it is set to.
 */
async function resetOne(
  spec: ServiceSpec,
  options: Required<Pick<ResetOptions, "fetch" | "timeoutMs">> & ResetOptions,
  token: string,
): Promise<ServiceOutcome> {
  const host = requireHost(options);
  const origin = originFor(host);
  const label = spec.label.padEnd(8);

  let response: Response;
  try {
    response = await options.fetch(`${origin}${spec.resetPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (cause) {
    return { label: spec.label, ok: false, line: `${label} UNREACHABLE  ${origin} — ${String(cause)}` };
  }

  const text = await response.text();
  if (!response.ok) {
    const hint =
      response.status === 404
        ? " — RESET_TOKEN is unset on that service, so the route does not exist"
        : response.status === 401
          ? " — that service has a different RESET_TOKEN from this one"
          : "";
    return {
      label: spec.label,
      ok: false,
      line: `${label} REFUSED  HTTP ${response.status}${hint}: ${text.slice(0, 400)}`,
    };
  }

  const body = JSON.parse(text) as Record<string, unknown>;

  if (spec.label === "hooks") {
    const counts = body.counts as {
      before: Record<string, number>;
      after: Record<string, number>;
    };
    const kept = ((body.kept as { subjects?: string[] } | undefined)?.subjects ?? []) as string[];
    const demoCast = ((body.demo_cast as { subjects?: string[] } | undefined)?.subjects ?? []) as string[];
    return {
      label: spec.label,
      ok: true,
      line:
        `${label} OK  ${String(body.mode)} at revision ${String(body.revision)} — ${deltas(counts.before, counts.after)}` +
        "; " +
        (demoCast.length === 0
          ? "no demo cast on disk, none added"
          : `demo cast's subjects put back to the demo's roles and clearances (${demoCast.join(", ")})`) +
        `; ${kept.length} added by \`bun run users\` kept` +
        (kept.length === 0 ? "" : ` (${kept.join(", ")})`),
    };
  }

  const counts = body.counts as {
    before: Record<string, number>;
    after: Record<string, number>;
  };
  return {
    label: spec.label,
    ok: true,
    line: `${label} OK  ${deltas(counts.before, counts.after)}`,
  };
}

/**
 * Both, in order, one line each. Exported so the test drives exactly what
 * the command does rather than a re-implementation of it.
 *
 * It does **not** stop at the first failure. A presenter between takes wants
 * to know everything that is wrong in one run, not to discover the second
 * problem after fixing the first, and a loan book is still worth putting
 * back when the control plane refused.
 */
export async function runReset(options: ResetOptions): Promise<ResetOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const resolved = {
    ...options,
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? 30_000,
  };
  const token = requireToken(options.env);
  const specs = SERVICES;

  log(`[reset] ${APP_HOST} ${requireHost(resolved)}: ${specs.map((spec) => spec.label).join(", ")}`);

  const started = performance.now();
  const services: ServiceOutcome[] = [];
  for (const spec of specs) {
    const outcome = await resetOne(spec, resolved, token);
    log(`[reset] ${outcome.line}`);
    services.push(outcome);
  }

  const ok = services.every((service) => service.ok);
  const ms = Math.round(performance.now() - started);
  log(
    ok
      ? `[reset] done in ${ms}ms — ${specs.length} services back to the seeded state. A redeploy is not a reset; a reset is not a re-registration.`
      : `[reset] FAILED in ${ms}ms — ${services.filter((service) => !service.ok).map((service) => service.label).join(", ")}. The demo is NOT in a known state.`,
  );
  return { ok, services };
}

/** `--target` is gone, and refused rather than ignored (see "Addresses" above). */
export function refuseTarget(argv: string[]): void {
  if (!argv.some((arg) => arg === "--target" || arg.startsWith("--target="))) return;
  throw new ResetConfigError(
    `--target is not an option any more. The reset runs against ${APP_HOST}; to reset a ` +
      `deployment, run it with that deployment's ${APP_HOST} and RESET_TOKEN in the environment.`,
  );
}

/**
 * `--hard`, or anything that looks like it, is refused rather than ignored: a
 * presenter who typed it expects a clean sign-in to demonstrate, and a quiet
 * soft reset would leave them believing they had one.
 */
export function refuseHard(argv: string[]): void {
  const hard = argv.find((arg) => /^--?hard/i.test(arg));
  if (hard !== undefined) throw new ResetConfigError(NO_HARD_RESET);
}

if (import.meta.main) {
  try {
    const argv = Bun.argv.slice(2);
    refuseTarget(argv);
    refuseHard(argv);
    const outcome = await runReset({ env: process.env });
    process.exit(outcome.ok ? 0 : 1);
  } catch (cause) {
    if (!(cause instanceof ResetConfigError)) throw cause;
    console.error(`[reset] ${cause.message}`);
    process.exit(EX_CONFIG);
  }
}
