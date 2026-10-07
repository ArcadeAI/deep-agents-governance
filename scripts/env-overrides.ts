/**
 * The app's `.env` files, and the shell variables that beat them (#54).
 *
 * A real environment variable wins over `.env` for every process this repo
 * starts: Bun's own precedence for `bun run dev` (`scripts/next.ts`), and
 * Next's under it. That is right for a host that injects its
 * configuration, and it is a trap on a laptop. On the #52 live test the
 * human's terminal still exported an older clone's `.env`: `bun run dev` ran on
 * that clone's `IDP_CLIENT_ID`, sign-in failed with `invalid_client`, and the
 * same stale `BETTER_AUTH_SECRET` encrypted `idp.db`'s signing key, so the next
 * clean boot refused it. Nothing said the shell was involved.
 *
 * So that command names, on start, every identity or secret key the
 * shell sets to a value other than the one the `.env` files give, and says the
 * shell's value wins.
 * Names only, never a value: the warning goes to a terminal, and the values
 * are secrets. `bun run setup-arcade` goes further and refuses to run
 * (`shellConflicts` in `scripts/setup-arcade/env-file.ts`), because it decides
 * what to register from `.env` alone.
 *
 * The launcher calls it, `scripts/next.ts`, before the app starts, and never
 * the app itself: comparing `BETTER_AUTH_SECRET` means reading it, and no app
 * source outside the identity provider does
 * (`app-test/identity/only-identity-mints.test.ts`). `scripts/` is not in the image.
 */
import { readFileSync } from "node:fs";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** `KEY=value` lines to a record. Comments, blanks and `export ` are handled; quotes are stripped. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    env[match[1]!] = unquote(match[2]!);
  }
  return env;
}

function unquote(raw: string): string {
  const value = raw.trim();
  const quoted = /^(['"])(.*)\1$/.exec(value);
  if (quoted) return quoted[2]!;
  // An unquoted value ends at a ` #` comment, the way dotenv reads it.
  return value.replace(/\s+#.*$/, "");
}

/** The file at `path`, or `""` when there is none. */
export function readEnvText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * The keys a shell override is worth a warning for: every `IDP_*`, and the
 * secrets and host the identity and the Arcade registration are keyed on. The
 * first five are #54's list; `ARCADE_HOOK_SIGNING_SECRET` and
 * `APPROVALS_STORE_TOKEN` are the other two secrets `setup-arcade` writes and
 * registers with Arcade, so a stale one fails the same way, out of sight.
 */
export const OVERRIDE_WARNED_KEYS = [
  "SESSION_SECRET",
  "BETTER_AUTH_SECRET",
  "APP_PUBLIC_HOST",
  "ARCADE_API_KEY",
  "ARCADE_HOOK_SIGNING_SECRET",
  "APPROVALS_STORE_TOKEN",
] as const;

export function isOverrideWarned(key: string): boolean {
  return key.startsWith("IDP_") || (OVERRIDE_WARNED_KEYS as readonly string[]).includes(key);
}

/**
 * What Bun loads for each of `keys` from the `.env` files in `dir`, given `env`
 * as the environment it starts with: asked of Bun itself, in a child that
 * prints them and exits (about 20ms). Its rules are not worth copying: it
 * picks the files by NODE_ENV (`.env.development.local`, `.env.local`,
 * `.env.development`, `.env`, in that order, when NODE_ENV is unset, and no
 * `.env.local` under `test`), and it expands `$VAR` and `${VAR}` even in single
 * quotes, one level deep, from the rest of the environment, shell included.
 * Next picks the same files in the same order, and never overrides a variable
 * Bun already set, so for `bun run dev` this is the value the app runs on.
 *
 * The values are secrets, so they travel over a pipe and are never printed:
 * a failure says how the child exited and nothing it wrote.
 */
function loadedFromFiles(dir: string, env: Record<string, string>, keys: readonly string[]): Record<string, string | undefined> {
  const child = Bun.spawnSync(
    [process.execPath, "--eval", `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((key) => [key, process.env[key]]))))`],
    { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  if (child.exitCode !== 0) throw new Error(`bun could not load the .env files in ${dir} (exit ${child.exitCode})`);
  return JSON.parse(child.stdout.toString()) as Record<string, string | undefined>;
}

/**
 * The warned keys the shell sets to a value other than the one the `.env`
 * files would give, sorted: the keys where the process environment really
 * wins over a different value.
 *
 * `env` is either the shell's own (`bun --no-env-file`, as `bun run setup-arcade`
 * runs) or a process's that Bun loaded the files into (`bun run dev`), and the
 * question is the same for both: with the key dropped and everything else as
 * it is, what would Bun load for it? A key the files set, however it got
 * there, comes back as it is; a key the shell set comes back as the files'
 * value instead, or as nothing, which counts as blank, so a shell that
 * exports a key empty where no file sets it is no override.
 *
 * All the keys are dropped at once first, and only the ones that come back
 * different are asked again one at a time. The second ask is what keeps
 * `IDP_OAUTH_REDIRECT_URIS_WEB=https://${APP_PUBLIC_HOST}/…` out of the
 * warning when only APP_PUBLIC_HOST is the shell's: with both dropped the
 * redirect expands from the file's host, and with only itself dropped, from
 * the shell's, which is what it holds.
 */
export function shellOverrides(env: Record<string, string | undefined>, dir: string): string[] {
  const defined = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const candidates = Object.keys(defined).filter(isOverrideWarned);
  if (candidates.length === 0) return [];
  const without = (dropped: readonly string[]) => Object.fromEntries(Object.entries(defined).filter(([key]) => !dropped.includes(key)));
  const differs = (key: string, loaded: Record<string, string | undefined>) => defined[key] !== (loaded[key] ?? "");

  const together = loadedFromFiles(dir, without(candidates), candidates);
  return candidates
    .filter((key) => differs(key, together))
    .filter((key) => differs(key, loadedFromFiles(dir, without([key]), [key])))
    .sort();
}

/** The one warning, naming each key and never a value. `command` is what the developer typed. */
export function overrideWarning(keys: readonly string[], command: string): string {
  const one = keys.length === 1;
  return (
    `warning: ${keys.join(", ")} ${one ? "is" : "are"} set in this shell to ${one ? "a value" : "values"} ` +
    `the .env files do not give, and the shell's value wins: \`${command}\` runs on ${one ? "it" : "them"}, not on .env. ` +
    `A shell that exported an older clone's .env is the usual cause, and sign-in then fails. ` +
    `Open a new terminal, or run: unset ${keys.join(" ")}`
  );
}

/** Prints {@link overrideWarning} when there is anything to warn about, and returns the keys. */
export function warnShellOverrides(
  command: string,
  { env = process.env, dir = process.cwd(), log = console.warn }: { env?: Record<string, string | undefined>; dir?: string; log?: (line: string) => void } = {},
): string[] {
  const keys = shellOverrides(env, dir);
  if (keys.length > 0) log(overrideWarning(keys, command));
  return keys;
}
