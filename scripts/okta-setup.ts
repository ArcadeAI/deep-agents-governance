/**
 * `bun run okta-setup`: the Okta side of the workshop, from one command, so
 * the only things done by hand are signing up for the org and minting one API
 * token.
 *
 *     OKTA_ORG_URL=https://<org>.okta.com \
 *     OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- bun run okta-setup
 *
 * What it makes, and why each step is safe to repeat, is `scripts/okta/setup.ts`.
 * What it writes to `.env` (mode 0600, the way `setup-arcade` writes it):
 *
 * - `OKTA_ORG_URL`, when `.env` has none, so `bun run users` finds the org;
 * - `IDP_ISSUER`, the `default` authorization server's issuer;
 * - `IDP_CLIENT_ID`, the app's client id, which it also prints;
 * - `IDP_CLIENT_SECRET`, only when it made one: the app is new, or `.env` had
 *   none for it. It is never printed.
 *
 * The three `IDP_*` values are replaced rather than only filled: the org is
 * their source of truth, the way Arcade is for the provider callback.
 *
 * `OKTA_API_TOKEN` is read from this process's environment only, never from
 * `.env`, and nothing prints it. `APP_PUBLIC_HOST` and
 * `ARCADE_PROVIDER_CALLBACK` (written by `setup-arcade` once Arcade has made
 * the provider) are read from the shell or `.env`; each one blank is a
 * redirect URI left for a rerun to add.
 *
 * Run it with `--no-env-file` (the package script does): it reads `.env` and
 * `.env.local` itself and writes only `.env`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { apiToken, Okta, OktaError, orgUrl } from "./okta/client.ts";
import { APP_LABEL, oktaSetup } from "./okta/setup.ts";
import { fillBlanks, parseEnv, readEnvFile, replaceValue, writeEnvFile } from "./setup-arcade/env-file.ts";

const out = (line = "") => console.log(line);
function fail(message: string, code = 1): never {
  console.error(`\nokta-setup: ${message}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.length > 0) fail(`okta-setup takes no arguments; it reads OKTA_ORG_URL and OKTA_API_TOKEN from the environment`, 64);

const cwd = process.cwd();
const envPath = join(cwd, ".env");
const examplePath = join(cwd, ".env.example");
const shell: Record<string, string | undefined> = { ...process.env };
const envExists = existsSync(envPath);
let envText = envExists ? readEnvFile(envPath) : existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
const fileEnv = parseEnv(envText);
const localEnv = parseEnv(readEnvFile(join(cwd, ".env.local")));
/** The shell first, then `.env.local`, then `.env`: Bun's own precedence. */
const value = (key: string): string => (shell[key] ?? localEnv[key] ?? fileEnv[key] ?? "").trim();

// .env must be private before a secret goes into it.
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode;
if (git("rev-parse", "--is-inside-work-tree") === 0) {
  if (git("ls-files", "--error-unmatch", ".env") === 0) fail(".env is tracked by git, and this command writes a client secret into it. Untrack it first: git rm --cached .env");
  if (git("check-ignore", "-q", ".env") !== 0) fail(".env is not gitignored, and this command writes a client secret into it. Add `.env` to .gitignore first.");
}
if ((fileEnv.OKTA_API_TOKEN ?? "").trim() !== "") {
  fail("OKTA_API_TOKEN is set in .env. Take it out: it reaches this command through the environment only (op run), never through a file.", 78);
}

let org: string;
let token: string;
try {
  org = orgUrl(value("OKTA_ORG_URL"));
  token = apiToken(shell);
} catch (cause) {
  fail((cause as Error).message, 78);
}

const host = value("APP_PUBLIC_HOST").replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
const origin = host === "" ? null : `https://${host}`;
const providerCallback = value("ARCADE_PROVIDER_CALLBACK") || null;

out("okta-setup");
out(`  org           ${org}`);
out(`  public host   ${host || "(APP_PUBLIC_HOST is blank: the app's own callback is left for a rerun)"}`);
out(`  provider      ${providerCallback ?? "(no ARCADE_PROVIDER_CALLBACK yet: setup-arcade writes it, then run this again)"}`);
out();

const okta = new Okta({ orgUrl: org, token });
let result: Awaited<ReturnType<typeof oktaSetup>>;
try {
  result = await oktaSetup(okta, {
    origin,
    providerCallback,
    known: { clientId: (fileEnv.IDP_CLIENT_ID ?? "").trim(), clientSecret: (fileEnv.IDP_CLIENT_SECRET ?? "").trim() },
  });
} catch (cause) {
  const hint =
    cause instanceof OktaError && cause.status === 401
      ? "\nOkta refused the token: check OKTA_API_TOKEN is a live token from this org (Security → API → Tokens)."
      : cause instanceof OktaError && cause.status === 403
        ? "\nThe token's admin cannot do this: mint it as a Super Administrator."
        : "";
  fail(`${(cause as Error).message}${hint}\nWhat was made before this step stays; running the command again picks up from here.`);
}
for (const line of result.lines) out(`  ${line}`);

// .env: the org if blank, then the three IDP_* values from the org.
let text = fillBlanks(envText, { OKTA_ORG_URL: org }, "okta-setup").text;
const replaced: string[] = [];
const setTo = (key: string, next: string) => {
  if ((parseEnv(text)[key] ?? "").trim() === next) return;
  text = replaceValue(text, key, next);
  replaced.push(key);
};
setTo("IDP_ISSUER", result.issuer);
setTo("IDP_CLIENT_ID", result.clientId);
if (result.clientSecret !== null) setTo("IDP_CLIENT_SECRET", result.clientSecret);
if (text !== envText) {
  writeEnvFile(envPath, text);
  envText = text;
}

out(`\n.env${envExists ? "" : " (created from .env.example)"}:`);
out(`  ${replaced.length > 0 ? `wrote    ${replaced.join(", ")}` : "nothing changed: it already names this org's app"}`);
out(`\n  IDP_ISSUER     ${result.issuer}`);
out(`  IDP_CLIENT_ID  ${result.clientId}`);
if (result.clientSecret !== null) {
  out("  IDP_CLIENT_SECRET is in .env and is not shown. To keep a copy in 1Password, without it passing through your terminal:");
  out(`    op item create --category="API Credential" --title="${APP_LABEL} Okta client" "credential=$(sed -n 's/^IDP_CLIENT_SECRET=//p' .env)"`);
}
for (const warning of result.warnings) out(`\n  warning  ${warning}`);

out("\nNext:");
out("  bun run users seed-demo     the four demo people, in Okta and in governance.db (needs OKTA_API_TOKEN the same way)");
if (providerCallback === null) out(`  bun run setup-arcade ${host || "<APP_PUBLIC_HOST>"}   then this command again, to allowlist Arcade's provider callback`);
