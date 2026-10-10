/**
 * `bun run setup-arcade <ngrok-host> [--dry-run] [--skip-deploy] [--redeploy] [--gateway[=<slug>]]` (#9, #30, #48, #52)
 *
 * Everything the Arcade side of this template needs, from one command, after
 * the developer has filled in the few required values in `.env`
 * (`ARCADE_API_KEY` among them). In order:
 *
 * 1. **Refuses** to go on if `.env` is tracked by git or not gitignored: this
 *    command writes secrets into it.
 * 2. **Resolves the Arcade org and project** (`setup-arcade/context.ts`):
 *    `ARCADE_ORG_ID` and `ARCADE_PROJECT_ID`, else the Arcade CLI's active
 *    context. Then, before anything is written, **one read-only call** under
 *    them with the key, `GET …/plugins`: a 401, 403 or 404 means the key and
 *    the resolved project disagree, and the run stops (#30).
 * 3. **Reads the identity provider** from `.env`: `IDP_ISSUER`, `IDP_CLIENT_ID`
 *    and `IDP_CLIENT_SECRET`, which `bun run okta-setup` writes. One blank stops
 *    the run, naming that command. The authorize, token and userinfo endpoints
 *    come from `IDP_ISSUER`'s discovery document, never from a spelled path.
 * 4. **Reads** the hop-2 provider `app-identity` back from Arcade. It is
 *    create-only (DESIGN.md → "Arcade config is read-only"): if it exists and
 *    differs from what this app needs, the differences are printed and the run
 *    stops, having written nothing.
 * 5. **Fills in `.env`**, blanks only, never overwriting: `APP_PUBLIC_HOST`,
 *    `SESSION_SECRET`, `ARCADE_HOOK_SIGNING_SECRET`, `APPROVALS_STORE_TOKEN`
 *    and `GOVERNANCE_STREAM=hooks`. Then `ARCADE_PROVIDER_CALLBACK`, the
 *    callback Arcade made for the provider, kept in step with Arcade;
 *    `bun run okta-setup` allowlists it on the Okta app, and the run says to
 *    rerun that whenever it changes.
 * 6. **Registers by API**: the provider, the tool secrets `APP_PUBLIC_HOST`
 *    and `APPROVALS_STORE_TOKEN`, the custom verifier, and the contextual
 *    access hooks (#30), each read back. The hooks are created **on**, and
 *    hooks found disabled are turned on and read back: they are what governs
 *    every tool call, and nothing here needs them off.
 * 7. **Deploys the toolkits**: one `arcade deploy`, in `mcp`, which
 *    carries the loan and approvals tools, streaming its output and
 *    stopping on a failure (#30). A toolkit Arcade already runs is skipped: `GET …/workers/<name>`,
 *    the CLI's own check, answers 404 when it is missing. `--redeploy`
 *    deploys it anyway, and `--skip-deploy` leaves both to the developer.
 *
 * **No User Source and no gateway, unless `--gateway`.** The agent calls the
 * Arcade Engine directly with the project key, as the person the platform
 * signed in (`agent/agent.py`, DESIGN.md → Integration), and the project's
 * hooks govern every one of those calls. So nothing above registers a User
 * Source or an MCP gateway, and `ARCADE_USER_SOURCE_ID` left in an older
 * `.env` is ignored with a one-line note.
 *
 * 8. **`--gateway`, optional: the User Source and the gateway by API** (#52),
 *    after the deploys, for an MCP client such as Claude Code to reach the
 *    same tools under the same hooks (`docs/modules/05-mcp-client.md`). The
 *    User Source is found by issuer and client in the project, else the
 *    issuer is checked and it is created, through the Coordinator API
 *    (`setup-arcade/coordinator.ts`, `ARCADE_COORDINATOR_URL`), and read back
 *    by id. The gateway is found by slug in `GET …/gateways`, held to that
 *    User Source and never edited, else created through it with the nine
 *    tools (`POST …/gateways`) and read back. Then `ARCADE_GATEWAY_ID` is
 *    written to `.env`, and the app shows how to connect an MCP client. The
 *    slug is `--gateway=<slug>`, else `.env`'s `ARCADE_GATEWAY_ID`, else
 *    `loan-desk-<first label of the host>`: slugs are unique across Arcade.
 *    A Coordinator call that fails, or no org and project, prints the User
 *    Source and gateway as dashboard forms and exits 1: nothing falls back
 *    silently, and the hooks are untouched either way. Without the flag, an
 *    `ARCADE_GATEWAY_ID` already in `.env` is left as it is, with a note.
 *
 * The same command is every run: what Arcade already holds tells them apart,
 * and a rerun of a finished project is a no-op that says so.
 *
 * With no org and project to be found, the hooks are printed as the dashboard
 * form they were before #30, and the run says why.
 *
 * `--dry-run` writes nothing and sends nothing: it prints every request a real
 * run would make from the state on disk, in order, with the key and every
 * secret as a placeholder. Sending nothing, it cannot ask Arcade whether the
 * provider exists, so it infers it: `.env`'s `ARCADE_PROVIDER_CALLBACK` holds
 * the callback Arcade returns when it creates the provider (#28). Nor does it
 * read the identity provider's discovery, so the endpoints are placeholders
 * too. Which registration goes which way, and the spec
 * path of each call, is in `scripts/setup-arcade/arcade.ts`.
 * `app-test/setup-arcade.test.ts` runs this against a local stand-in, with the
 * Arcade CLI faked on `PATH` and its context faked in a throwaway `HOME`. Its
 * first run against the real API (#7) stopped at the tool secrets, sent as
 * POST; they are PUT since #26. The second stopped at `GET /v1/plugins`; the
 * hooks are registered under the project since #30. A rerun picks up from
 * either state.
 *
 * Run it with `--no-env-file` (the package script does): it reads `.env` and
 * `.env.local` itself, so it knows which values `.env` holds and which come
 * from elsewhere, and writes only to `.env`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { discover } from "../auth/discovery.ts";

import {
  ArcadeAdmin,
  ArcadeError,
  arcadeMessage,
  gatewayBody,
  gatewayCheck,
  gatewayDifferences,
  type GatewaySpec,
  gatewayUrl,
  healthCheckUrl,
  HOOKS_NAME,
  type HooksStatus,
  isReachabilityError,
  pageItems,
  pluginBody,
  pluginDifferences,
  pluginPatch,
  unverifiedLine,
  type ProjectScope,
  projectPath,
  PROVIDER_ID,
  providerBody,
  providerDifferences,
  type Registration,
  secretRequest,
  toolSecrets,
  verifierBody,
} from "./setup-arcade/arcade.ts";
import { type ArcadeContext, resolveContext } from "./setup-arcade/context.ts";
import { fillBlanks, MANAGED_KEYS, parseEnv, readEnvFile, replaceValue, shellConflicts, writeEnvFile } from "./setup-arcade/env-file.ts";
import {
  candidates,
  Coordinator,
  coordinatorUrl,
  failureLine,
  readinessDifferences,
  reported,
  USER_SOURCE_NAME,
  type UserSource,
  userSourceBody,
  userSourceDifferences,
  type UserSourceSpec,
} from "./setup-arcade/coordinator.ts";
import { gatewayForm, hooksForm, nextSteps, userSourceForm } from "./setup-arcade/forms.ts";
import { serverName } from "./setup-arcade/toolkit.ts";

/**
 * The gateway slug when neither `--gateway=<slug>` nor `ARCADE_GATEWAY_ID`
 * names one.
 *
 * Gateway slugs are unique across Arcade, not per project: a second person
 * running this with a fixed default got a 409 and a stop (measured
 * 2026-10-06, the first time two people set up the same template). So the
 * default is derived from the one value that is already unique per person,
 * their ngrok host, as `loan-desk-<first label>`. A slug once written to
 * `.env` is kept on every later run.
 */
function defaultGateway(host: string): string {
  const label = host.split(":")[0]!.split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return label === "" ? "loan-desk" : `loan-desk-${label}`.slice(0, 63).replace(/-+$/, "");
}

/**
 * Where `arcade deploy` runs. One directory: `mcp` is one server,
 * `LoanDesk` (`mcp/loan_desk/app.py`), carrying the loan and approvals tools.
 * Gmail and Slack are Arcade's own and are not deployed.
 */
const TOOLKIT_DIRS = ["mcp"] as const;

const out = (line = "") => console.log(line);
function fail(message: string, code = 1): never {
  console.error(`\nsetup-arcade: ${message}`);
  process.exit(code);
}

// --- Arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const skipDeploy = argv.includes("--skip-deploy");
const redeploy = argv.includes("--redeploy");
// `--gateway`, `--gateway=<slug>`, or `--gateway <slug>` when a second bare
// word follows it: the one option that takes a value, and the value is optional.
const gatewayAt = argv.findIndex((arg) => arg === "--gateway" || arg.startsWith("--gateway="));
const withGateway = gatewayAt !== -1;
const bare = argv.filter((arg) => !arg.startsWith("--"));
const gatewayValueAt = withGateway && argv[gatewayAt] === "--gateway" && bare.length === 2 && argv[gatewayAt + 1] === bare[1] ? gatewayAt + 1 : -1;
const gatewayArg: string | null = !withGateway ? null : argv[gatewayAt]!.startsWith("--gateway=") ? argv[gatewayAt]!.slice("--gateway=".length) : gatewayValueAt === -1 ? null : argv[gatewayValueAt]!;
const positional = argv.filter((arg, index) => !arg.startsWith("--") && index !== gatewayValueAt);
const FLAGS = new Set(["--dry-run", "--skip-deploy", "--redeploy", "--gateway"]);
const USAGE =
  "usage: bun run setup-arcade <ngrok-host> [--dry-run] [--skip-deploy] [--redeploy] [--gateway[=<slug>]]\n" +
  "  <ngrok-host> is the public host Arcade reaches this app at, e.g. my-app.ngrok.app\n" +
  "  --gateway also registers an MCP gateway, for Claude Code or another MCP client (docs/modules/05-mcp-client.md)";

const unknown = argv.filter((arg) => arg.startsWith("--") && !FLAGS.has(arg) && !arg.startsWith("--gateway="));
if (unknown.length > 0) fail(`${unknown.join(", ")}: not an option of this command\n${USAGE}`, 64);
if (positional.length !== 1) fail(USAGE, 64);
if (gatewayArg !== null && !/^[a-z0-9][a-z0-9-]*$/.test(gatewayArg)) {
  fail(`--gateway ${gatewayArg || "(empty)"}: a slug is lowercase letters, digits and hyphens`, 64);
}

// A pasted URL is accepted and cut down to the host form everything else uses.
const host = positional[0]!.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || !host.includes(".")) {
  fail(`${positional[0]} is not a public host. Pass the ngrok domain, e.g. my-app.ngrok.app`, 64);
}
if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
  fail(`${host} is this machine; Arcade Cloud cannot reach it. Pass the ngrok domain that tunnels to it.`, 64);
}
const origin = `https://${host}`;

// --- The environment, the way Bun would load it for the app -----------------

const cwd = process.cwd();
// The environment this command was started in, before `.env` is read into it:
// what `arcade deploy` runs with, the way it runs from the developer's shell.
const shellEnv: Record<string, string | undefined> = { ...process.env };
const envPath = join(cwd, ".env");
const examplePath = join(cwd, ".env.example");
let envText = readEnvFile(envPath);
const envExists = existsSync(envPath);
if (!envExists && existsSync(examplePath)) envText = readFileSync(examplePath, "utf8");
const fileEnv = parseEnv(envText);
const localEnv = parseEnv(readEnvFile(join(cwd, ".env.local")));
// Real environment first, then .env.local, then .env: Bun's own precedence.
for (const source of [localEnv, fileEnv]) {
  for (const [key, value] of Object.entries(source)) if (process.env[key] === undefined) process.env[key] = value;
}
// What the app would see, frozen before this run adds its own values to
// `process.env`. Used for the settings this run only reads (`ARCADE_API_URL`,
// `PORT`, the toolkit names).
const loaded: Record<string, string | undefined> = { ...process.env };
const effective = (key: string): string => loaded[key]?.trim() ?? "";
/**
 * A variable this run manages, as `.env` holds it, and nothing else (#30).
 * What to fill, and what is "already set", is decided from the file alone,
 * because the file is what this run writes and what `bun run dev` reads. On
 * the fourth live run the shell still exported an old `.env`, the shell won,
 * and the run reported "nothing to fill" into a fresh `.env`: the app then
 * booted with no secret of its own, and the provider was created with the
 * shell's old client. `shellConflicts` below refuses that state instead.
 */
const fromFile = (key: string): string => fileEnv[key]?.trim() ?? "";

out(dryRun ? "setup-arcade --dry-run: nothing is written and nothing is sent.\n" : "setup-arcade");
out(`  public host   ${host}  (${origin})`);

// --- 1. .env must be private ------------------------------------------------

function git(...args: string[]): number {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode;
}
if (git("rev-parse", "--is-inside-work-tree") === 0) {
  if (git("ls-files", "--error-unmatch", ".env") === 0) {
    fail(".env is tracked by git, and this command writes secrets into it. Untrack it first: git rm --cached .env");
  }
  if (git("check-ignore", "-q", ".env") !== 0) {
    fail(".env is not gitignored, and this command writes secrets into it. Add `.env` to .gitignore first.");
  }
} else {
  out("  warning       this is not a git work tree, so nothing checked that .env is kept out of version control");
}

// --- Inputs -----------------------------------------------------------------

// A managed variable the shell exports with another value than `.env`'s, or
// that `.env` leaves blank, stops the run before anything is sent or written
// (#30). At runtime a real environment variable still wins over `.env`, for
// the app as in `scripts/next.ts`, and that is the reason: whatever this run
// registered from `.env`, the app would run on the shell's value instead. So
// the shell is not overridden here and not ignored either: it has to agree.
const exported = shellConflicts(shellEnv, fileEnv);
if (exported.length > 0) {
  fail(
    `${exported.join(", ")} ${exported.length === 1 ? "is" : "are"} exported in this shell with a value .env does not hold ` +
      "(different, or blank in .env). This command decides what to write from .env alone, and the app would run on the " +
      "shell's values rather than the ones registered in Arcade. Nothing was sent or written.\n" +
      `  Open a new terminal, or run: unset ${exported.join(" ")}`,
  );
}

const onFile = fileEnv.APP_PUBLIC_HOST?.trim() ?? "";
if (onFile !== "" && onFile.toLowerCase() !== host) {
  fail(`.env has APP_PUBLIC_HOST=${onFile}, and this run was given ${host}. Pass ${onFile}, or blank it in .env to use ${host}.`);
}
const onLocal = localEnv.APP_PUBLIC_HOST?.trim() ?? "";
if (onLocal !== "" && onLocal.toLowerCase() !== host) {
  out(`  warning       APP_PUBLIC_HOST=${onLocal} is set in .env.local, and wins over .env when the app runs`);
}
const apiKey = fromFile("ARCADE_API_KEY");
if (apiKey === "" && !dryRun) fail("ARCADE_API_KEY is blank. Fill it in .env (Arcade dashboard → API keys), then run this again.");
const apiUrl = (effective("ARCADE_API_URL") || "https://api.arcade.dev").replace(/\/+$/, "");

// The gateway's slug, under `--gateway`: the flag's value, else the one `.env`
// already holds, else one derived from the host. Without the flag the gateway
// is nobody's business here: one in `.env` is left as it is, and said once.
const onFileGateway = fromFile("ARCADE_GATEWAY_ID");
if (gatewayArg !== null && onFileGateway !== "" && onFileGateway !== gatewayArg) {
  fail(`.env has ARCADE_GATEWAY_ID=${onFileGateway}, and this run was given --gateway ${gatewayArg}. Blank it in .env to use ${gatewayArg}.`);
}
const slug = gatewayArg ?? (onFileGateway || defaultGateway(host));
if (!withGateway && onFileGateway !== "") {
  out(`  note          ARCADE_GATEWAY_ID=${onFileGateway} is set; this run leaves the gateway as it is (pass --gateway to check or create it)`);
}
// What an older `.env` may still hold: the User Source is found by issuer and
// client now, so its id is read by nothing. Said once, never an error.
if (effective("ARCADE_USER_SOURCE_ID") !== "") {
  out("  note          ARCADE_USER_SOURCE_ID is set, and ignored: the User Source is found by its issuer and client, so you can delete it");
}

// The org and project the hooks are registered in (#30).
const resolution = resolveContext(loaded);
const scope: (ArcadeContext & ProjectScope) | null = resolution.context;
if (scope !== null) {
  out(`  arcade        org ${scope.orgId}, project ${scope.projectId} (from ${scope.source})`);
  if (!scope.source.startsWith("the Arcade CLI") && !skipDeploy) {
    // `arcade deploy` always deploys into the CLI's own active project
    // (`arcade_cli/deploy.py`): these variables do not reach it.
    out("  warning       arcade deploy uses the Arcade CLI's active project, not these variables: `arcade whoami` must show the same one");
  }
} else {
  out(`  arcade        no org and project: ${"why" in resolution ? resolution.why : "unknown"}.`);
  out(`                The hooks${withGateway ? ", the User Source and the gateway" : ""} are printed as ${withGateway ? "dashboard forms" : "a dashboard form"} instead. Set ARCADE_ORG_ID and`);
  out("                ARCADE_PROJECT_ID in .env, or make the project the Arcade CLI's active one, to register them by API.");
}

// The Coordinator API, for the User Source, only under `--gateway` (#52).
// Refused before anything is sent when it is the dashboard's own proxy.
const coordinatorBase = withGateway ? coordinatorUrl(effective("ARCADE_COORDINATOR_URL")) : null;
const coordinator = coordinatorBase?.url ? new Coordinator(coordinatorBase.url, apiKey, dryRun, out) : null;
/** The toolkit name as Arcade files the one deployed server: the gateway's tool filter names its tools `LoanDesk.<Tool>`. */
const toolkit = effective("ARCADE_TOOLKIT") || "LoanDesk";
if (withGateway) {
  out(`  gateway       ${slug}  (${gatewayUrl(apiUrl, slug)})`);
  if (coordinatorBase !== null && coordinatorBase.url === null) out(`  coordinator   none: ${coordinatorBase.why}. The User Source and the gateway are printed as dashboard forms.`);
}

// The identity provider, as `bun run okta-setup` wrote it. The same client
// signs people in to the app and is hop 2's provider.
const idp = {
  issuer: fromFile("IDP_ISSUER").replace(/\/+$/, ""),
  clientId: fromFile("IDP_CLIENT_ID"),
  clientSecret: fromFile("IDP_CLIENT_SECRET"),
};
const idpBlank = (["IDP_ISSUER", "IDP_CLIENT_ID", "IDP_CLIENT_SECRET"] as const).filter((key) => fromFile(key) === "");
if (idpBlank.length > 0 && !dryRun) {
  fail(
    `${idpBlank.join(", ")} ${idpBlank.length === 1 ? "is" : "are"} blank in .env. Run \`bun run okta-setup\` first: it makes the Okta app ` +
      "and writes them (README → Create your Okta org).",
  );
}
if (dryRun) {
  idp.issuer ||= "<IDP_ISSUER, from bun run okta-setup>";
  idp.clientId ||= "<IDP_CLIENT_ID, from bun run okta-setup>";
}
out(`  identity      ${idp.issuer}, client ${idp.clientId}`);

/** A value this run needs: what the app already has, else a fresh one. */
function secretFor(key: string): { value: string; generated: boolean } {
  const existing = fromFile(key);
  if (existing !== "") return { value: existing, generated: false };
  if (dryRun) return { value: `<generated ${key}>`, generated: true };
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { value: Buffer.from(bytes).toString("hex"), generated: true };
}

const sessionSecret = secretFor("SESSION_SECRET");
const hookToken = secretFor("ARCADE_HOOK_SIGNING_SECRET");
const storeToken = secretFor("APPROVALS_STORE_TOKEN");
// Optional: the room's copy of every approval request (.env.example).
const approvalsChannel = effective("SLACK_APPROVALS_CHANNEL") || "";

/** Everything this run writes to `.env`, blanks only. */
const planned: Record<string, string> = {
  APP_PUBLIC_HOST: host,
  SESSION_SECRET: sessionSecret.value,
  ARCADE_HOOK_SIGNING_SECRET: hookToken.value,
  APPROVALS_STORE_TOKEN: storeToken.value,
  // Arcade calls the hooks from here on, so the panel watches them rather
  // than the fixture replay a blank value means under `next dev`.
  GOVERNANCE_STREAM: "hooks",
};
// Every managed variable is `.env`'s value or this run's, whatever .env.local
// or the shell had, and the host is always this run's.
for (const key of MANAGED_KEYS) {
  const value = fromFile(key) || planned[key];
  if (value) process.env[key] = value;
  else delete process.env[key];
}
process.env.APP_PUBLIC_HOST = host;

const admin = new ArcadeAdmin(apiUrl, apiKey, dryRun, out);
/** Set when this run wrote a new provider callback, which Okta does not allowlist until `okta-setup` runs again. */
let oktaRerun = false;

/**
 * The steps left, and the forms: the hooks' when there was no project to
 * register them in, and under `--gateway` the User Source's and the gateway's
 * when the run could not make them by API (`registered` names a User Source
 * it did make, whose form is then not left). The last thing every run prints.
 */
function finish(hooks: "on" | "form", gateway: "created" | "form" | null, code = 0, registered: UserSource | null = null): never {
  const forms = (hooks === "form" ? 1 : 0) + (gateway === "form" ? (registered === null ? 2 : 1) : 0);
  if (forms > 0) out(`\n${forms === 1 ? "One dashboard form is" : `${["Two", "Three"][forms - 2]} dashboard forms are`} left${forms > 1 ? ", in the order you fill them in" : ""}:\n`);
  if (hooks === "form") out(hooksForm({ origin }));
  if (gateway === "form") {
    if (hooks === "form") out();
    if (registered === null) {
      out(userSourceForm({ issuer: idp.issuer, clientId: idp.clientId }));
      out();
    }
    out(gatewayForm({ slug, toolkit, ...(registered === null ? {} : { userSourceId: registered.id }) }));
  }
  out();
  out(
    nextSteps({
      host,
      origin,
      port: effective("PORT") || "3000",
      hooks,
      deployed: !skipDeploy,
      ...(gateway === null ? {} : { gateway: { slug, apiUrl, state: gateway } }),
      oktaRerun,
    }),
  );
  process.exit(code);
}

/**
 * What `arcade deploy` says about the tool secrets, and why it is fine: it
 * uploads a secret only from its own environment, and this run set both by API.
 */
const DEPLOY_SECRETS_NOTE =
  "  (arcade deploy may print \"Secret 'APP_PUBLIC_HOST' not found in environment, skipping upload\". That is expected:\n" +
  "  this run already set the tool secrets by API, above.)";

/** `arcade deploy`, as printed by the dry run and run by a real one. */
function deployLine(dir: string): string {
  return `  arcade deploy   (in ${dir})`;
}

// --- Dry run: the whole sequence, nothing sent ------------------------------

if (dryRun) {
  // What a real run would find, read off the disk alone: a dry run sends
  // nothing, so it cannot ask Arcade (#28). `ARCADE_PROVIDER_CALLBACK` is
  // written only from the callback Arcade returns when it creates the provider.
  const registered = fromFile("ARCADE_PROVIDER_CALLBACK") !== "";

  const keys = Object.keys(planned).filter((key) => fromFile(key) === "");
  if (!registered) keys.push("ARCADE_PROVIDER_CALLBACK (with the callback Arcade generates for the provider)");
  if (withGateway && onFileGateway === "") keys.push(`ARCADE_GATEWAY_ID (${slug}, once the gateway exists)`);
  out(
    `\n.env${envExists ? "" : " (created from .env.example)"}: ` +
      (keys.length > 0 ? `would fill ${keys.join(", ")}` : "nothing to fill: every value is already set, and none is overwritten"),
  );
  if (idpBlank.length > 0) {
    out(`  warning       ${idpBlank.join(", ")} ${idpBlank.length === 1 ? "is" : "are"} blank: a real run stops here. Run \`bun run okta-setup\` first.`);
  }
  out(`identity: a real run reads ${idp.issuer}/.well-known/openid-configuration for the provider's endpoints`);

  out(`\nRequests, in order (${apiUrl}):`);
  if (scope !== null) {
    await admin.request("GET", projectPath(scope, "/plugins?limit=100"));
    out("    (before anything is written: a 401, 403 or 404 stops the run, because the key and this project disagree)");
  }
  const registration: Registration = {
    host,
    origin,
    endpoints: {
      authorize: "<authorization_endpoint from IDP_ISSUER's discovery>",
      token: "<token_endpoint from IDP_ISSUER's discovery>",
      userinfo: "<userinfo_endpoint from IDP_ISSUER's discovery>",
    },
    clientId: idp.clientId,
    clientSecret: "<IDP_CLIENT_SECRET from .env>",
    approvalsStoreToken: storeToken.generated ? storeToken.value : "<APPROVALS_STORE_TOKEN from .env>",
  };
  await admin.request("GET", `/v1/admin/auth_providers/${PROVIDER_ID}`);
  if (registered) {
    out("    (expected 200: .env holds the callback Arcade made for this provider. It is compared, a difference stops");
    out("    the run, and nothing is created. If Arcade answers 404 instead, a real run creates the provider.)");
  } else {
    out("    (404: the provider is created below. 200: it is compared, and a difference stops the run.)");
    await admin.request("POST", "/v1/admin/auth_providers", providerBody(registration));
  }
  for (const secret of toolSecrets(host, registration.approvalsStoreToken, approvalsChannel)) {
    const { method, path, body } = secretRequest(secret);
    await admin.request(method, path, body);
  }
  await admin.request("PUT", "/v1/admin/settings/session_verification", verifierBody(origin));
  await admin.request("GET", "/v1/admin/settings/session_verification");
  if (scope !== null) {
    const token = hookToken.generated ? hookToken.value : "<ARCADE_HOOK_SIGNING_SECRET from .env>";
    out(`    (the hooks: the list above is searched for ${HOOKS_NAME}. With none, it is created on:)`);
    await admin.request("POST", projectPath(scope, "/plugins"), pluginBody(origin, token, "active"));
    out(`    (one that differs, or is disabled, is updated instead, PATCH ${projectPath(scope, "/plugins/<plugin_id>")}, with`);
    out("    status \"active\", and one that matches and is on is left as it is. A created or updated one is read back:)");
    await admin.request("GET", projectPath(scope, "/plugins/<plugin_id>"));
    await admin.request("GET", projectPath(scope, "/hooks?plugin_id=<plugin_id>"));
  }
  if (scope !== null && !skipDeploy && !redeploy) {
    for (const dir of TOOLKIT_DIRS) {
      const name = serverName(join(cwd, dir));
      if (name === null) continue;
      await admin.request("GET", projectPath(scope, `/workers/${encodeURIComponent(name)}`));
    }
    out("    (the deploys' check, one per toolkit: 404 deploys it, found skips it; --redeploy deploys both anyway)");
  }
  out(
    skipDeploy
      ? "\nDeploys: skipped (--skip-deploy)."
      : `\nDeploys, after the hooks, each stopping the run if it fails${redeploy ? " (--redeploy: both, whatever Arcade already runs)" : ", unless Arcade already runs it"}:`,
  );
  if (!skipDeploy) {
    for (const dir of TOOLKIT_DIRS) out(deployLine(dir));
    out(DEPLOY_SECRETS_NOTE);
  }
  if (withGateway && scope !== null && coordinator !== null) {
    out(`\nThe gateway (--gateway), after the deploys. The User Source, through the Coordinator API at ${coordinator.baseUrl}:`);
    await coordinator.list(scope);
    out(`    (searched for ${idp.issuer} and the client ${idp.clientId}. One that matches is used; one that differs stops the run.`);
    out("    With none, Arcade checks the issuer, then it is created, and read back by id:)");
    await coordinator.testIssuer(scope, idp.issuer);
    await coordinator.create(scope, userSourceBody({ issuer: idp.issuer, clientId: idp.clientId, clientSecret: "<IDP_CLIENT_SECRET from .env>" }));
    await coordinator.get(scope, "<user_source_id>");
    out(`  The gateway (${apiUrl}):`);
    await admin.request("GET", projectPath(scope, "/gateways?limit=100"));
    out(`    (searched for the gateway ${slug}. One found is held to the User Source and never edited. With none, it is created through`);
    out("    the User Source, and read back:)");
    await admin.request("POST", projectPath(scope, "/gateways"), gatewayBody({ slug, userSourceId: "<the User Source's id>", toolkit }));
    await admin.request("GET", projectPath(scope, "/gateways/<gateway_id>"));
    out(`    (then ARCADE_GATEWAY_ID=${slug} is written to .env. A Coordinator call that fails stops the run on the dashboard forms;`);
    out("    the hooks are not touched either way.)");
  }
  finish(scope === null ? "form" : "on", !withGateway ? null : scope !== null && coordinator !== null ? "created" : "form");
}

// --- 2. The provider is read back before anything is written ----------------

// The identity provider's endpoints, from its own discovery document: nothing here spells an Okta path.
let endpoints: Registration["endpoints"];
try {
  const document = await discover(idp.issuer);
  endpoints = { authorize: document.authorization_endpoint, token: document.token_endpoint, userinfo: document.userinfo_endpoint };
} catch (error) {
  fail(`reading ${idp.issuer}/.well-known/openid-configuration failed: ${(error as Error).message}. Is IDP_ISSUER the issuer \`bun run okta-setup\` wrote?`);
}

out(`\nArcade (${apiUrl}):`);

// The key's check, before anything is written (#30): one read-only call under
// the org and project this run resolved. Its list is the hooks' search too.
let listedPlugins: unknown[] = [];
if (scope !== null) {
  const path = projectPath(scope, "/plugins?limit=100");
  const answer = await admin.request("GET", path);
  if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
    fail(
      `ARCADE_API_KEY and the Arcade project this run resolved disagree: GET ${path} answered ${answer.status}.\n` +
        `  The project is ${scope.projectId} in the org ${scope.orgId} (from ${scope.source}).\n` +
        "  Either make the key's own project the active one, `arcade project set <project_id>` (`arcade project list` shows the ids),\n" +
        `  or create an API key in the project ${scope.projectId} and put it in ARCADE_API_KEY. Nothing was written.`,
    );
  }
  if (answer.status !== 200) fail(new ArcadeError("GET", path, answer.status, JSON.stringify(answer.json)).message);
  listedPlugins = pageItems(answer.json);
  out(`  the key answers for the project ${scope.projectId}`);
}

const existingProvider = await admin.request("GET", `/v1/admin/auth_providers/${PROVIDER_ID}`);
if (existingProvider.status !== 200 && existingProvider.status !== 404) {
  fail(new ArcadeError("GET", `/v1/admin/auth_providers/${PROVIDER_ID}`, existingProvider.status, JSON.stringify(existingProvider.json)).message);
}
const providerExists = existingProvider.status === 200;

if (providerExists) {
  const desired = providerBody({ host, origin, endpoints, clientId: idp.clientId, clientSecret: "", approvalsStoreToken: "" });
  const differences = providerDifferences(existingProvider.json, desired);
  if (differences.length > 0) {
    out(`\nThe provider ${PROVIDER_ID} already exists in this Arcade project, and it is not what this app needs:`);
    for (const line of differences) out(`  - ${line}`);
    fail(
      "nothing was changed in Arcade or in .env. This command never edits an existing provider (DESIGN.md: " +
        "Arcade config is read-only). Correct it in the dashboard, or delete it there and run this again.",
    );
  }
  out(`  the provider ${PROVIDER_ID} is already registered and matches; it is left as it is`);
}

// --- 4. .env, blanks only ---------------------------------------------------

let filled = fillBlanks(envText, planned);
writeEnvFile(envPath, filled.text);
out(`\n.env${envExists ? "" : " (created from .env.example)"}:`);
out(`  filled   ${filled.written.join(", ") || "(nothing to fill: every value was already set)"}`);
if (filled.kept.length > 0) out(`  kept     ${filled.kept.join(", ")}  (already set; never overwritten)`);

// --- 5. Arcade --------------------------------------------------------------

const registration: Registration = {
  host,
  origin,
  endpoints,
  clientId: idp.clientId,
  clientSecret: idp.clientSecret,
  approvalsStoreToken: storeToken.value,
};

async function step<T>(what: string, run: () => Promise<T>, hint?: (error: unknown) => string | undefined): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const said = arcadeMessage(error);
    const advice = hint?.(error);
    fail(
      `${what} failed: ${(error as Error).message}\n` +
        (said ? `Arcade says: ${said}\n` : "") +
        (advice ? `${advice}\n` : "") +
        `.env keeps what this run wrote, so running the same command again picks up from here.`,
    );
  }
}

let provider = existingProvider.json;
if (!providerExists) {
  provider = await step("creating the provider", () => admin.expect("POST", "/v1/admin/auth_providers", providerBody(registration)));
}

// Arcade generates the provider's callback, one per provider (measured in the
// custom-verifier spike: `…/oauth/<id>/callback`), and the Okta app must
// allowlist it exactly.
//
// The live provider is the source of truth for ARCADE_PROVIDER_CALLBACK, which
// this run replaces rather than only fills (#30). On run 4, app-identity was
// recreated, so Arcade made a new callback, and `.env` still named the old
// provider's: the identity provider then refused it (invalid_redirect) at hop
// 2's Authorize. `bun run okta-setup` reads it from `.env` and adds it to the
// Okta app's redirect URIs, so a changed one is a rerun of that command.
const callback = (provider as { oauth2?: { redirect_uri?: string } } | null)?.oauth2?.redirect_uri;
const CALLBACK_KEY = "ARCADE_PROVIDER_CALLBACK";
const onFileCallback = fromFile(CALLBACK_KEY);
if (callback && onFileCallback !== callback) {
  filled =
    onFileCallback === "" ? fillBlanks(filled.text, { [CALLBACK_KEY]: callback }) : { ...filled, text: replaceValue(filled.text, CALLBACK_KEY, callback) };
  writeEnvFile(envPath, filled.text);
  process.env[CALLBACK_KEY] = callback;
  oktaRerun = true;
  out(
    onFileCallback !== ""
      ? `  replaced the provider's callback in .env: ${onFileCallback} -> ${callback}`
      : `  wrote the provider's callback to .env: ${callback}`,
  );
  out("  Okta does not allowlist it until you run `bun run okta-setup` again (the steps at the end say how)");
}
for (const secret of toolSecrets(host, storeToken.value, approvalsChannel)) {
  const { method, path, body } = secretRequest(secret);
  await step(`setting the tool secret ${secret.key}`, () => admin.expect(method, path, body));
}

const verifier = await step("setting the custom verifier", async () => {
  await admin.expect("PUT", "/v1/admin/settings/session_verification", verifierBody(origin));
  return admin.expect("GET", "/v1/admin/settings/session_verification");
});
if (verifier?.verifier_url !== verifierBody(origin).verifier_url || verifier?.unsafe_skip_verification !== false) {
  fail(
    `the custom verifier did not take: Arcade reads back ${JSON.stringify(verifier)}. Without it a grant binds to ` +
      `whoever is signed in at Arcade, not to the app's user (DESIGN.md open risk 2). ` +
      `Set it in the dashboard: Auth → Settings → Custom verifier → ${verifierBody(origin).verifier_url}`,
  );
}
out(`  custom verifier: ${verifier.verifier_url} (read back)`);

// --- 6. The hooks (#30) -----------------------------------------------------

const objectField = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/** The plugin and its hooks read back, held to `status`: anything else fails the run with `failure`. */
async function readHooksBack(scope: ProjectScope, id: string, status: HooksStatus, failure: string): Promise<void> {
  const plugin = await step("reading the hooks back", () => admin.expect("GET", projectPath(scope, `/plugins/${encodeURIComponent(id)}`)));
  const { differences, unverified } = pluginDifferences(plugin, await hooksOf(scope, id), origin, status);
  if (differences.length > 0) fail(`${failure}: Arcade reads back\n${differences.map((line) => `  - ${line}`).join("\n")}`);
  const healthUnread = unverified.some(({ path }) => path === "webhook_config.health_check_path");
  out(
    `  hooks: ${origin}/hooks/access, /hooks/pre and /hooks/post, fail closed` +
      `${healthUnread ? "" : `, health check ${healthCheckUrl(origin)}`}, status ${status} (read back)`,
  );
  for (const field of unverified) out(`  ${unverifiedLine(field)}`);
}
async function hooksOf(scope: ProjectScope, id: string): Promise<unknown[]> {
  return pageItems(await step("reading the hooks back", () => admin.expect("GET", projectPath(scope, `/hooks?plugin_id=${encodeURIComponent(id)}`))));
}

if (scope === null) {
  out("  hooks: no org and project, so the form below");
} else {
  const existing = listedPlugins.find((each) => objectField(each, "name") === HOOKS_NAME);
  let id = typeof objectField(existing, "id") === "string" ? (objectField(existing, "id") as string) : "";
  if (existing === undefined) {
    // On from the start: the agent's calls go to the Engine directly, and
    // these hooks are what governs them. There is no gateway form whose tool
    // list they would hide (#48's reason for creating them disabled).
    const created = await step(
      "creating the contextual access hooks",
      () => admin.expect("POST", projectPath(scope, "/plugins"), pluginBody(origin, hookToken.value, "active")),
      (error) =>
        isReachabilityError(error)
          ? `Arcade could not reach ${healthCheckUrl(origin)}: start \`bun run dev\` and the tunnel first.`
          : undefined,
    );
    id = typeof objectField(created, "id") === "string" ? (objectField(created, "id") as string) : "";
    if (id === "") fail(`Arcade created the hooks and answered with no id: ${JSON.stringify(created)}`);
    out(`  hooks: created ${HOOKS_NAME}, on`);
    await readHooksBack(scope, id, "active", "the hooks did not take");
  } else {
    const status: HooksStatus = objectField(existing, "status") === "active" ? "active" : "inactive";
    const { differences, unverified } = pluginDifferences(existing, await hooksOf(scope, id), origin, null);
    if (differences.length === 0 && status === "active") {
      out(`  hooks: ${HOOKS_NAME} is already registered, matches and is on; it is left as it is`);
      for (const field of unverified) out(`  ${unverifiedLine(field)}`);
    } else {
      if (differences.length > 0) {
        out(`  hooks: ${HOOKS_NAME} is registered and differs from what this app needs, so it is updated:`);
        for (const line of differences) out(`    - ${line}`);
      }
      if (status !== "active") out(`  hooks: ${HOOKS_NAME} is registered and disabled, so it is turned on`);
      await step(differences.length > 0 ? "updating the contextual access hooks" : "turning the hooks on", () =>
        admin.expect("PATCH", projectPath(scope, `/plugins/${encodeURIComponent(id)}`), pluginPatch(origin, hookToken.value, "active")),
      );
      await readHooksBack(scope, id, "active", status === "active" ? "the hooks did not take" : "the hooks did not turn on");
    }
  }
}

// --- 7. The deploys (#30) ---------------------------------------------------

if (skipDeploy) {
  out("\nDeploys: skipped (--skip-deploy). Deploy the toolkits yourself: arcade deploy, in mcp.");
} else {
  out(`\n${DEPLOY_SECRETS_NOTE.trimStart()}`);
  for (const dir of TOOLKIT_DIRS) {
    const where = join(cwd, dir);
    if (!existsSync(where)) fail(`there is no ${dir} under ${cwd} to deploy. Run this from the project's root, or pass --skip-deploy.`);
    // Already on Arcade: skipped, because a rerun otherwise pays for two full
    // deploys of unchanged code (#30). The CLI's own check, `server_already_exists`: 404 is missing.
    // Arcade's answer carries no version to compare (schemas.WorkerResponse),
    // so a changed toolkit needs --redeploy.
    const name = serverName(where);
    if (scope !== null && name !== null && !redeploy) {
      const path = projectPath(scope, `/workers/${encodeURIComponent(name)}`);
      const found = await admin.request("GET", path);
      if (found.status === 200) {
        out(`  ${dir}: already deployed on Arcade, skipped (pass --redeploy after changing it)`);
        continue;
      }
      if (found.status !== 404) {
        const error = new ArcadeError("GET", path, found.status, JSON.stringify(found.json));
        const said = arcadeMessage(error);
        fail(`checking whether ${dir} is deployed failed: ${error.message}${said ? `\nArcade says: ${said}` : ""}`);
      }
    }
    out(`\n${deployLine(dir).trim()}:`);
    let code: number;
    try {
      // The developer's own environment, not this run's: `arcade deploy`
      // reads its login and active project the way it does from their shell.
      // No stdin (#30): the CLI asks "View full deployment logs? [y/n]" when
      // stdin and stdout are both a terminal (arcade_cli/deploy.py, 1.16.1),
      // and with the developer's terminal inherited every deploy waited for a
      // key. Its output still streams to this one.
      const child = Bun.spawn(["arcade", "deploy"], { cwd: where, env: shellEnv, stdio: ["ignore", "inherit", "inherit"] });
      code = await child.exited;
    } catch (error) {
      fail(
        `could not run arcade deploy: ${(error as Error).message}. Install the Arcade CLI (uv tool install arcade-mcp) and ` +
          "run `arcade login`, or pass --skip-deploy and deploy the toolkits yourself.",
      );
    }
    if (code !== 0) {
      fail(
        `arcade deploy in ${dir} exited ${code}; its output is above, and nothing after it ran. Fix that and run this again ` +
          "(every step before it checks what is already there), or pass --skip-deploy and deploy it yourself.",
      );
    }
  }
}

// --- 8. The User Source and the gateway, under --gateway (#52) --------------

/**
 * The run stops here, under `--gateway`, when the User Source or the gateway
 * could not be made by API: what failed, then the forms, then the steps.
 * Nothing registered above is undone, and the hooks are as they were.
 */
function gatewayNotRegistered(why: string, registered: UserSource | null = null): never {
  console.error(`\nsetup-arcade: ${why}`);
  out(
    registered === null
      ? "\nThe User Source and the gateway were not registered by API, so they are the dashboard forms below. Everything above is done."
      : `\nThe User Source ${registered.id} is registered and the gateway is not, so the gateway is the dashboard form below. Everything above is done.`,
  );
  finish("on", "form", 1, registered);
}

/**
 * The User Source found by issuer or created through the Coordinator API,
 * read back by id, then the gateway found by slug or created through it,
 * read back. Create-only, both: one that exists and differs stops the run.
 */
async function registerGateway(scope: ProjectScope, coordinator: Coordinator): Promise<void> {
  out(`\nThe User Source (${coordinator.baseUrl}):`);
  const want: UserSourceSpec = { issuer: idp.issuer, clientId: idp.clientId };
  const listed = await coordinator.list(scope);
  if (!listed.ok) gatewayNotRegistered(failureLine(listed));

  let found: UserSource;
  let createdNow = false;
  const claimants = candidates(listed.value, want);
  const mismatched = claimants.map((each) => ({ each, differences: userSourceDifferences(each, want) })).filter(({ differences }) => differences.length > 0);
  if (mismatched.length > 0 || claimants.length > 1) {
    const report = (claimants.length > 1 && mismatched.length === 0 ? claimants.map((each) => ({ each, differences: ["one of several for this app"] })) : mismatched)
      .map(({ each, differences }) => `The User Source ${each.name ?? "(no name)"} (${each.id}):\n${differences.map((line) => `  - ${line}`).join("\n")}`)
      .join("\n");
    fail(
      `${claimants.length > 1 ? `${claimants.length} User Sources in this project claim this app's issuer or client` : "a User Source in this project claims this app's issuer or client"}, and this command will not pick one or reuse one that differs:\n` +
        `${report}\n` +
        "Nothing was changed in Arcade: this command never edits a User Source, because it is hop 1, the access model itself. No gateway was created, " +
        "and everything above is done. In the dashboard (your project → User Sources), correct it or delete it, then run this again.",
    );
  }
  if (claimants.length === 1) {
    found = claimants[0]!;
    out(`  user source: found ${found.name ?? USER_SOURCE_NAME} (${found.id}), issuer ${want.issuer}, client ${want.clientId}; it matches and is left as it is`);
  } else {
    out(`  user source: there is none for ${want.issuer} in this project yet; Arcade checks the issuer, then it is created`);
    // Arcade's own check, the create's without the save. It reads the identity provider's discovery, not the app's.
    const checked = await coordinator.testIssuer(scope, want.issuer);
    if (!checked.ok) {
      if (checked.code === 404 || checked.code === 405) {
        gatewayNotRegistered(`coordinator: ${checked.call} answered ${checked.status}, so this Coordinator cannot check the issuer before the create`);
      }
      if (checked.code === 422) gatewayNotRegistered(`user source: Arcade cannot use the issuer ${want.issuer}: ${checked.msg ?? "(no reason given)"}`);
      gatewayNotRegistered(failureLine(checked));
    }
    const created = await coordinator.create(scope, userSourceBody({ issuer: want.issuer, clientId: want.clientId, clientSecret: idp.clientSecret }));
    if (!created.ok) gatewayNotRegistered(failureLine(created));
    found = created.value;
    createdNow = true;
  }

  // Read back by id, found or created: the gateway create checks only the id's shape, not that it is there, active and this app's.
  const read = await coordinator.get(scope, found.id);
  if (!read.ok) gatewayNotRegistered(`reading the User Source back failed: ${failureLine(read)}`, createdNow ? found : null);
  const source = read.value;
  const differences = [...readinessDifferences(source, found.id), ...userSourceDifferences(source, want)];
  if (differences.length > 0) {
    fail(
      `the User Source ${found.id} ${createdNow ? "did not take" : "is not one a gateway can use"}: Arcade reads back\n${differences.map((line) => `  - ${line}`).join("\n")}\n` +
        "No gateway was created, and everything above is done. In the dashboard (your project → User Sources), correct it or delete it, then run this again.",
    );
  }
  out(
    createdNow
      ? `  user source: created ${USER_SOURCE_NAME} (${source.id}), issuer ${source.issuer}, client ${want.clientId}, status active (read back)`
      : `  user source: ${source.id} is active (read back)`,
  );
  out(`  user source: ${reported(source)} (reported, not checked)`);

  // The gateway, through it.
  out(`\nThe gateway (${apiUrl}):`);
  const spec: GatewaySpec = { slug, userSourceId: source.id, toolkit };
  const listPath = projectPath(scope, "/gateways?limit=100");
  const listing = await admin.request("GET", listPath);
  if (listing.status !== 200) gatewayNotRegistered(new ArcadeError("GET", listPath, listing.status, JSON.stringify(listing.json)).message, source);
  const existing = pageItems(listing.json).find((each) => objectField(each, "slug") === slug);
  if (existing !== undefined) {
    // Made before, by a run like this one or in the dashboard: held to the User Source, never edited.
    const check = gatewayCheck(existing, toolkit);
    const through = objectField(existing, "user_source_id");
    const other = typeof through === "string" && through !== source.id ? `user_source_id: Arcade has ${JSON.stringify(through)}, this app needs "${source.id}"` : null;
    if (check.authType !== null || other !== null) {
      fail(
        `the gateway ${slug} does not authenticate through this app's User Source:\n  - ${check.authType ?? other}\n` +
          "Everything above is done. Hop 1 is the access model, and this template never runs a gateway on Arcade Headers or on " +
          "Arcade accounts. In the dashboard, set its Authentication to Non-Arcade Users → User Source → Loans Approval Limits, " +
          "or delete it, or blank ARCADE_GATEWAY_ID in .env and run this with --gateway=<another-slug>.",
      );
    }
    out(`  gateway: found ${slug}, through the User Source ${source.id}; it is left as it is`);
    for (const line of check.tools) out(`  warning       ${line}`);
  } else {
    const path = projectPath(scope, "/gateways");
    const created = await admin.request("POST", path, gatewayBody(spec));
    if (created.status === 409) {
      gatewayNotRegistered(`Arcade says the slug ${slug} is taken. Blank ARCADE_GATEWAY_ID in .env and run this with --gateway=<another-slug>`, source);
    }
    if (created.status < 200 || created.status >= 300) {
      const error = new ArcadeError("POST", path, created.status, JSON.stringify(created.json));
      const said = arcadeMessage(error);
      gatewayNotRegistered(`${error.message}${said ? `\nArcade says: ${said}` : ""}`, source);
    }
    const id = objectField(created.json, "id");
    if (typeof id !== "string" || id === "") gatewayNotRegistered(`Arcade answered with no id: ${JSON.stringify(created.json)}`, source);
    const readPath = projectPath(scope, `/gateways/${encodeURIComponent(id)}`);
    const readBack = await admin.request("GET", readPath);
    if (readBack.status !== 200) {
      fail(
        `the gateway ${slug} was created (${id}), and reading it back failed: ${new ArcadeError("GET", readPath, readBack.status, JSON.stringify(readBack.json)).message}\n` +
          "Everything above is done. Run this again with --gateway: it finds the gateway and checks it.",
      );
    }
    const gatewayDiff = gatewayDifferences(readBack.json, spec);
    if (gatewayDiff.length > 0) {
      fail(
        `the gateway did not take: Arcade reads back\n${gatewayDiff.map((line) => `  - ${line}`).join("\n")}\n` +
          "Everything above is done. Correct it in the dashboard, or delete it and run this again with --gateway.",
      );
    }
    out(`  gateway: created ${slug}, through the User Source ${source.id}, with the six ${toolkit} tools and Gmail and Slack (read back)`);
  }

  // The slug, to .env: the app shows the "Connect your MCP client" panel from it.
  filled = fillBlanks(filled.text, { ARCADE_GATEWAY_ID: slug });
  writeEnvFile(envPath, filled.text);
  process.env.ARCADE_GATEWAY_ID = slug;
  out(`  gateway: ${gatewayUrl(apiUrl, slug)}${filled.written.includes("ARCADE_GATEWAY_ID") ? ", written to .env as ARCADE_GATEWAY_ID" : " (ARCADE_GATEWAY_ID is already in .env)"}`);
}

let gatewayState: "created" | "form" | null = null;
if (withGateway) {
  if (scope === null) {
    out("\nThe gateway: no org and project, so the User Source and the gateway are the forms below");
    gatewayState = "form";
  } else if (coordinator === null) {
    gatewayNotRegistered(`coordinator: ${coordinatorBase !== null && "why" in coordinatorBase ? coordinatorBase.why : "none"}`);
  } else {
    await registerGateway(scope, coordinator);
    gatewayState = "created";
  }
}

finish(scope === null ? "form" : "on", gatewayState);
