/**
 * A shell variable that beats `.env` is named on start, never valued (#54).
 *
 * The #52 live test: the human's terminal still exported an older clone's
 * `.env`, `bun run dev` ran on its `IDP_CLIENT_ID`, and sign-in failed with
 * `invalid_client` while nothing on screen mentioned the shell. `bun run dev`
 * now prints one warning naming each identity or secret key the shell sets to
 * a value no `.env` file holds, and `bun run setup-arcade` refuses
 * (`setup-arcade.test.ts`).
 *
 * The first half plants each case against `scripts/env-overrides.ts` directly. The
 * second runs the packaged `dev` script, verbatim, in a throwaway project, the
 * way `dev-port.test.ts` does, because a warning in a function nobody calls is
 * the silent failure this repo keeps shipping.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isOverrideWarned, overrideWarning, shellOverrides } from "../scripts/env-overrides.ts";
import { childEnv } from "./child-env.ts";
import { spawnChild } from "./child.ts";

const ROOT = join(import.meta.dir, "..");

/** #54's list, and a spread of `IDP_*`: the ones `.env.example` ships and two it leaves commented out. */
const WARNED = [
  "SESSION_SECRET",
  "BETTER_AUTH_SECRET",
  "APP_PUBLIC_HOST",
  "ARCADE_API_KEY",
  "ARCADE_HOOK_SIGNING_SECRET",
  "APPROVALS_STORE_TOKEN",
  "IDP_CLIENT_ID",
  "IDP_CLIENT_SECRET",
  "IDP_OAUTH_CLIENTS",
  "IDP_OAUTH_REDIRECT_URIS_WEB",
  "IDP_DB_PATH",
  "IDP_SCOPES",
] as const;

/** A value nobody would type, so finding it in the output means it was printed. */
const planted = (key: string) => `planted-${key.toLowerCase()}-${crypto.randomUUID()}`;

const fixtures = join(ROOT, ".test-fixtures");
mkdirSync(fixtures, { recursive: true });
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A directory holding exactly `files`, `.env` and its siblings. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(fixtures, "env-overrides-"));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const lines = (env: Record<string, string>) => Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join("");
const each = (value: (key: string) => string) => Object.fromEntries(WARNED.map((key) => [key, value(key)]));

/**
 * The environment `bun scripts/next.ts dev` starts with in `dir` when the
 * shell exports `shell`: Bun's own load, measured rather than assumed.
 */
function bunLoads(dir: string, shell: Record<string, string>): Record<string, string> {
  const child = Bun.spawnSync([process.execPath, "--eval", "process.stdout.write(JSON.stringify(process.env))"], { cwd: dir, env: shell, stdout: "pipe" });
  return JSON.parse(child.stdout.toString()) as Record<string, string>;
}

describe("each identity or secret key the shell sets", () => {
  // Each case plants every warned key at once, and is asked two ways: of the
  // shell's own environment, as `bun run setup-arcade` sees it (`--no-env-file`),
  // and of the one Bun loaded the files into, as `bun run dev` sees it.
  const cases: Array<[string, Record<string, string>, (key: string) => string, boolean]> = [
    ["different from .env's", { ".env": lines(each(() => "from-dotenv")) }, planted, true],
    ["set, where .env has it blank, as `.env.example` ships the second block", { ".env": lines(each(() => "")) }, planted, true],
    ["set, where no file has it", {}, planted, true],
    ["exported empty over a file's value: the shell's empty string still wins", { ".env": lines(each(() => "from-dotenv")) }, () => "", true],
    ["equal to .env's, where .env.local sets another, which it beats", { ".env": lines(each((key) => `dotenv-${key}`)), ".env.local": lines(each(() => "from-local")) }, (key) => `dotenv-${key}`, true],
    ["equal to .env's", { ".env": lines(each((key) => `dotenv-${key}`)) }, (key) => `dotenv-${key}`, false],
    ["equal to .env.local's, over a different .env", { ".env": lines(each(() => "from-dotenv")), ".env.local": lines(each((key) => `local-${key}`)) }, (key) => `local-${key}`, false],
    ["exported empty where no file has it", {}, () => "", false],
  ];

  test.each(cases)("%s", (_, files, value, warned) => {
    const dir = project(files);
    const shell = each(value);
    const expected = warned ? [...WARNED].sort() : [];
    expect(shellOverrides(shell, dir)).toEqual(expected);
    expect(shellOverrides(bunLoads(dir, shell), dir)).toEqual(expected);
  });

  test("keys that are neither identity nor secret are not warned about, however they differ", () => {
    const env = { PORT: "1", AGENT_URL: "https://agent.example.test", GOVERNANCE_STREAM: "hooks", NODE_ENV: "test" };
    for (const key of Object.keys(env)) expect(isOverrideWarned(key)).toBe(false);
    expect(shellOverrides(env, project({ ".env": lines(Object.fromEntries(Object.keys(env).map((key) => [key, "from-dotenv"]))) }))).toEqual([]);
  });

  // The review of #54 measured both: Bun expands `${VAR}` and loads
  // `.env.development`, and a check that read `.env` as text warned on every
  // start, with an `unset` that could not clear it.
  test("a value .env expands from another variable is the file's, not the shell's", () => {
    const dir = project({
      ".env": 'APP_PUBLIC_HOST=\nIDP_OAUTH_REDIRECT_URIS_WEB=https://${APP_PUBLIC_HOST}/api/auth/callback\nIDP_SCOPES="${TUNNEL_SCOPES} email"\n',
      ".env.local": "APP_PUBLIC_HOST=fork.example.test\n",
    });
    const loaded = bunLoads(dir, { TUNNEL_SCOPES: "openid" });
    expect(loaded.IDP_OAUTH_REDIRECT_URIS_WEB).toBe("https://fork.example.test/api/auth/callback");
    expect(loaded.IDP_SCOPES).toBe("openid email");
    expect(shellOverrides(loaded, dir)).toEqual([]);
    // Exported with the value Bun gives it, as a shell that sourced a load would.
    expect(shellOverrides({ TUNNEL_SCOPES: "openid", IDP_OAUTH_REDIRECT_URIS_WEB: loaded.IDP_OAUTH_REDIRECT_URIS_WEB!, IDP_SCOPES: "openid email" }, dir)).toEqual([]);
    // And one the shell really sets is still named, alone: the redirect that
    // expands from it is the file's, and unsetting it would change nothing.
    expect(shellOverrides(bunLoads(dir, { TUNNEL_SCOPES: "openid", APP_PUBLIC_HOST: "older-clone.example.test" }), dir)).toEqual(["APP_PUBLIC_HOST"]);
  });

  test("a key only .env.development sets, or only .env.development.local, is the file's, not the shell's", () => {
    const dir = project({ ".env": "IDP_CLIENT_ID=\n", ".env.development": "IDP_SCOPES=openid email\nIDP_CLIENT_ID=dev-client\n", ".env.development.local": "IDP_DB_PATH=./dev-idp.db\n" });
    const loaded = bunLoads(dir, {});
    expect([loaded.IDP_SCOPES, loaded.IDP_CLIENT_ID, loaded.IDP_DB_PATH]).toEqual(["openid email", "dev-client", "./dev-idp.db"]);
    expect(shellOverrides(loaded, dir)).toEqual([]);
    expect(shellOverrides({ IDP_SCOPES: "openid email", IDP_CLIENT_ID: "dev-client", IDP_DB_PATH: "./dev-idp.db" }, dir)).toEqual([]);
    // Next and Bun both skip them under a NODE_ENV that is not development.
    expect(shellOverrides({ NODE_ENV: "production", IDP_SCOPES: "openid email" }, dir)).toEqual(["IDP_SCOPES"]);
  });

  test("the warning names every key, says the shell's value wins, and says how to stop it", () => {
    const line = overrideWarning(["BETTER_AUTH_SECRET", "IDP_CLIENT_ID"], "bun run dev");
    expect(line).toContain("BETTER_AUTH_SECRET, IDP_CLIENT_ID are set in this shell");
    expect(line).toContain("the shell's value wins: `bun run dev` runs on them, not on .env");
    expect(line).toContain("unset BETTER_AUTH_SECRET IDP_CLIENT_ID");
    expect(overrideWarning(["IDP_CLIENT_ID"], "bun run dev")).toContain("IDP_CLIENT_ID is set in this shell to a value");
  });
});

// --- `bun run dev`, for real ---------------------------------------------------

/**
 * A listener on the port the fixture's `.env.local` names. The launcher warns
 * first, then refuses a port somebody holds (#30) and exits, so no Next server
 * starts: a run that got past the warning is one that reached that check.
 */
const holder = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("held") });
afterAll(() => holder.stop(true));

/** The host the fixture's `.env.local` sets. Nothing binds or dials it. */
const HOST = `localhost:${holder.port}`;

/**
 * A project with the real launchers, the real `dev` script string, and a `.env`
 * and `.env.local` of its own, and any other file in `more`.
 */
async function devProject(dotenv: Record<string, string>, more: Record<string, string> = {}): Promise<string> {
  const dir = mkdtempSync(join(fixtures, "env-overrides-"));
  made.push(dir);
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
  const { scripts } = (await Bun.file(join(ROOT, "package.json")).json()) as { scripts: Record<string, string> };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "env-overrides-fixture", private: true, scripts: { dev: scripts.dev } }, null, 2)}\n`);
  writeFileSync(join(dir, ".env"), Object.entries(dotenv).map(([key, value]) => `${key}=${value}\n`).join(""));
  // The held port, and a host in .env.local the way `scripts/orca-setup.sh` writes one.
  writeFileSync(join(dir, ".env.local"), `PORT=${holder.port}\nAPP_PUBLIC_HOST=${HOST}\n`);
  for (const [name, text] of Object.entries(more)) writeFileSync(join(dir, name), text);
  return dir;
}

/** `bun run dev` in `dir`, with `shell` exported, to its exit. */
async function dev(dir: string, shell: Record<string, string>): Promise<string> {
  // An allowlist: no NODE_ENV, under which Bun skips `.env.local`, and nothing
  // of this checkout's own environment.
  const child = spawnChild(["bun", "run", "--cwd", dir, "dev"], { env: childEnv(shell), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return `${stdout}${stderr}`;
}

test("`bun run dev` names each key a shell sets to a value .env does not hold, once, and prints none of the values", async () => {
  const dotenv = Object.fromEntries(WARNED.map((key) => [key, `dotenv-${key.toLowerCase()}`]));
  // APP_PUBLIC_HOST agrees with .env.local here: the files decide it, not the shell.
  const dir = await devProject({ ...dotenv, APP_PUBLIC_HOST: "" });
  const overridden = WARNED.filter((key) => key !== "APP_PUBLIC_HOST");
  const shell = Object.fromEntries(overridden.map((key) => [key, planted(key)]));

  const output = await dev(dir, { ...shell, APP_PUBLIC_HOST: HOST });
  console.log(`--- bun run dev, with an older clone's values exported ---\n${output}`);

  const warnings = output.split("\n").filter((line) => line.includes("set in this shell"));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(`[next.ts] warning: ${[...overridden].sort().join(", ")} are set in this shell`);
  expect(warnings[0]).toContain("the shell's value wins: `bun run dev` runs on them");
  expect(warnings[0]).not.toContain("APP_PUBLIC_HOST");
  for (const [key, value] of Object.entries(shell)) expect(output, `bun run dev printed ${key}'s value`).not.toContain(value);
  // It warned and went on, to the port check, which stops the run before Next.
  expect(output).toContain(`Port ${holder.port} is already in use`);
  expect(output.indexOf("set in this shell")).toBeLessThan(output.indexOf(`Port ${holder.port} is already in use`));
}, 60_000);

test("`bun run dev` says nothing when the shell exports what .env holds, or nothing at all", async () => {
  const dotenv = { IDP_CLIENT_ID: "the-same-client", BETTER_AUTH_SECRET: "the-same-secret" };
  const dir = await devProject(dotenv);
  for (const shell of [dotenv, {}]) {
    const output = await dev(dir, shell);
    expect(output).toContain(`Port ${holder.port} is already in use`);
    expect(output).not.toContain("set in this shell");
  }
}, 60_000);

// The review's two false alarms, in the packaged script: each warned on every
// start, and the `unset` it suggested could not clear it.
test("`bun run dev` says nothing about a value .env expands, or a key only .env.development sets, and still names a planted one", async () => {
  const dir = await devProject(
    { APP_PUBLIC_HOST: "", IDP_OAUTH_REDIRECT_URIS_WEB: "https://${APP_PUBLIC_HOST}/api/auth/callback", IDP_CLIENT_ID: "the-file-client" },
    { ".env.development": "IDP_SCOPES=openid email profile\n" },
  );
  const quiet = await dev(dir, {});
  console.log(`--- bun run dev, an expanded redirect and a .env.development key, nothing exported ---\n${quiet}`);
  expect(quiet).toContain(`Port ${holder.port} is already in use`);
  expect(quiet).not.toContain("set in this shell");

  const value = planted("IDP_CLIENT_ID");
  const planting = await dev(dir, { IDP_CLIENT_ID: value });
  const warnings = planting.split("\n").filter((line) => line.includes("set in this shell"));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("[next.ts] warning: IDP_CLIENT_ID is set in this shell");
  expect(planting).not.toContain(value);
}, 60_000);
