/**
 * `bun run okta-setup` (`scripts/okta-setup.ts`, `scripts/okta/setup.ts`)
 * against a fake Okta org: an in-memory copy of the Management API calls it
 * makes, shaped the way Okta's documentation shows them. No Okta.
 *
 * The contract: one run makes the app, its redirect URIs, the Everyone
 * assignment, the access policy, the users group and the password-only
 * sign-in policy; a second run finds every one of them and changes nothing; a
 * run after `setup-arcade` adds Arcade's provider callback and nothing else.
 * The client id is printed, the client secret goes to `.env` and never to
 * stdout, and an `OKTA_API_TOKEN` in `.env` is refused before any call.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Okta } from "../scripts/okta/client.ts";
import {
  ACCESS_POLICY_NAME,
  APP_LABEL,
  oktaSetup,
  AGENT_SIGNIN_CALLBACK,
  redirectUris,
  SIGN_ON_POLICY_NAME,
  USERS_GROUP,
} from "../scripts/okta/setup.ts";
import { USER_SOURCE_CALLBACK } from "../scripts/setup-arcade/coordinator.ts";
import { childEnv } from "./child-env.ts";
import { spawnChild } from "./child.ts";

const ROOT = join(import.meta.dir, "..");
const TOKEN = `okta-setup-test-${crypto.randomUUID()}`;
const PROVIDER_CALLBACK = "https://cloud.arcade.dev/api/v1/oauth/callback/prv_test";

type Json = Record<string, unknown>;

/** A fake org: just enough of the Management API for `oktaSetup`, with every call logged. */
function fakeOrg(options: { defaultPolicyCovers?: boolean; refuseSignOnPolicy?: boolean } = {}) {
  let next = 1;
  const id = (prefix: string) => `${prefix}${String(next++).padStart(17, "0")}`;
  const state = {
    apps: [] as Json[],
    appGroups: new Map<string, Set<string>>(),
    appPolicies: new Map<string, string>(),
    secrets: [] as string[],
    groups: [{ id: "00gEVERYONE", type: "BUILT_IN", profile: { name: "Everyone" } }] as Json[],
    authzPolicies: [] as Json[],
    authzRules: new Map<string, Json[]>(),
    accessPolicies: [] as Json[],
    accessRules: new Map<string, Json[]>(),
    log: [] as string[],
  };
  if (options.defaultPolicyCovers) {
    state.authzPolicies.push({ id: "00pDEFAULT", name: "Default Policy", status: "ACTIVE", priority: 1, conditions: { clients: { include: ["ALL_CLIENTS"] } } });
    state.authzRules.set("00pDEFAULT", [
      { id: "0prDEFAULT", name: "Default Policy Rule", status: "ACTIVE", conditions: { people: { groups: { include: ["EVERYONE"] } }, grantTypes: { include: ["authorization_code", "client_credentials"] }, scopes: { include: ["*"] } } },
    ]);
  }

  return {
    state,
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const method = request.method;
      const path = url.pathname;
      state.log.push(`${method} ${path}`);
      if (request.headers.get("authorization") !== `SSWS ${TOKEN}`) return Response.json({ errorCode: "E0000011", errorSummary: "Invalid token provided" }, { status: 401 });
      const body = method === "GET" || method === "DELETE" ? null : ((await request.text()) || "null");
      const parsed = body === null ? null : (JSON.parse(body) as Json | null);
      const parts = path.split("/").slice(3);

      if (path === "/api/v1/authorizationServers/default") return Response.json({ id: "aus_default", status: "ACTIVE", issuer: `${url.origin}/oauth2/default` });
      if (parts[0] === "authorizationServers" && parts[2] === "policies") {
        if (parts.length === 3 && method === "GET") return Response.json(state.authzPolicies);
        if (parts.length === 3 && method === "POST") {
          const policy = { ...parsed, id: id("00p") };
          state.authzPolicies.push(policy);
          return Response.json(policy);
        }
        if (parts[4] === "rules" && method === "GET") return Response.json(state.authzRules.get(parts[3]!) ?? []);
        if (parts[4] === "rules" && method === "POST") {
          const rules = state.authzRules.get(parts[3]!) ?? [];
          rules.push({ ...parsed, id: id("0pr"), status: "ACTIVE" });
          state.authzRules.set(parts[3]!, rules);
          return Response.json(rules.at(-1));
        }
      }
      if (parts[0] === "apps" && parts.length === 1 && method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        return Response.json(state.apps.filter((app) => String(app.label).startsWith(q)));
      }
      if (parts[0] === "apps" && parts.length === 1 && method === "POST") {
        const secret = `secret-${crypto.randomUUID()}`;
        state.secrets.push(secret);
        const app = {
          ...parsed,
          id: id("0oa"),
          status: "ACTIVE",
          credentials: { oauthClient: { ...(parsed!.credentials as Json).oauthClient as Json, client_id: id("0oa-client-"), client_secret: secret } },
        };
        state.apps.push(app);
        return Response.json(app);
      }
      const app = parts[0] === "apps" ? state.apps.find((each) => each.id === parts[1]) : undefined;
      if (app && parts.length === 2 && method === "PUT") {
        Object.assign(app, parsed, { id: app.id, credentials: app.credentials });
        return Response.json(app);
      }
      if (app && parts[2] === "credentials" && parts[3] === "secrets" && method === "POST") {
        const secret = `secret-${crypto.randomUUID()}`;
        state.secrets.push(secret);
        return Response.json({ id: id("ocs"), status: "ACTIVE", client_secret: secret });
      }
      if (app && parts[2] === "groups" && parts.length === 3) return Response.json([...(state.appGroups.get(String(app.id)) ?? [])].map((each) => ({ id: each })));
      if (app && parts[2] === "groups" && method === "PUT") {
        const set = state.appGroups.get(String(app.id)) ?? new Set();
        set.add(parts[3]!);
        state.appGroups.set(String(app.id), set);
        return Response.json({ id: parts[3] });
      }
      if (app && parts[2] === "policies" && method === "PUT") {
        state.appPolicies.set(String(app.id), parts[3]!);
        return new Response(null, { status: 204 });
      }
      if (parts[0] === "groups" && parts.length === 1 && method === "GET") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        return Response.json(state.groups.filter((group) => String((group.profile as Json).name).toLowerCase().startsWith(q)));
      }
      if (parts[0] === "groups" && parts.length === 1 && method === "POST") {
        const group = { ...parsed, id: id("00g"), type: "OKTA_GROUP" };
        state.groups.push(group);
        return Response.json(group);
      }
      if (parts[0] === "policies") {
        if (options.refuseSignOnPolicy) return Response.json({ errorCode: "E0000006", errorSummary: "You do not have permission to perform the requested action" }, { status: 403 });
        if (parts.length === 1 && method === "GET") return Response.json(state.accessPolicies);
        if (parts.length === 1 && method === "POST") {
          const policy = { ...parsed, id: id("rst") };
          state.accessPolicies.push(policy);
          return Response.json(policy);
        }
        if (parts[2] === "rules" && method === "GET") return Response.json(state.accessRules.get(parts[1]!) ?? []);
        if (parts[2] === "rules" && method === "POST") {
          const rules = state.accessRules.get(parts[1]!) ?? [];
          rules.push({ ...parsed, id: id("rul") });
          state.accessRules.set(parts[1]!, rules);
          return Response.json(rules.at(-1));
        }
      }
      return Response.json({ errorCode: "E0000007", errorSummary: "Not found: Resource not found" }, { status: 404 });
    },
  };
}

const ORG = "https://fake-org.okta.example";
const writes = (log: string[]) => log.filter((line) => !line.startsWith("GET "));
const redirectsOf = (app: Json) => ((app.settings as Json).oauthClient as Json).redirect_uris as string[];

describe("oktaSetup, against a fake org", () => {
  test("a first run makes the app, assigns it, lets it have tokens, makes the group and the password-only policy", async () => {
    const org = fakeOrg();
    const okta = new Okta({ orgUrl: ORG, token: TOKEN, fetch: org.fetch as typeof fetch });
    const result = await oktaSetup(okta, { origin: "https://desk.example", providerCallback: null, known: { clientId: "", clientSecret: "" } });

    expect(result.issuer).toBe(`${ORG}/oauth2/default`);
    expect(org.state.apps).toHaveLength(1);
    const app = org.state.apps[0]!;
    expect(app.label).toBe(APP_LABEL);
    expect(((app.settings as Json).oauthClient as Json).grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(redirectsOf(app)).toEqual(["https://desk.example/api/auth/callback", AGENT_SIGNIN_CALLBACK, USER_SOURCE_CALLBACK]);
    expect(result.clientId).toBe(String(((app.credentials as Json).oauthClient as Json).client_id));
    // The secret Okta returned on create is the one handed back, and no second one was made.
    expect(result.clientSecret).toBe(org.state.secrets[0]!);
    expect(org.state.secrets).toHaveLength(1);
    expect([...org.state.appGroups.get(String(app.id))!]).toEqual(["00gEVERYONE"]);
    expect(org.state.authzPolicies.map((policy) => policy.name)).toEqual([ACCESS_POLICY_NAME]);
    expect((org.state.authzPolicies[0]!.conditions as Json).clients).toEqual({ include: [result.clientId] });
    expect(org.state.groups.map((group) => (group.profile as Json).name)).toContain(USERS_GROUP);
    expect(org.state.accessPolicies.map((policy) => policy.name)).toEqual([SIGN_ON_POLICY_NAME]);
    expect(org.state.appPolicies.get(String(app.id))).toBe(String(org.state.accessPolicies[0]!.id));
    expect(result.warnings).toEqual([]);
  });

  test("a second run with the secret in .env finds everything and writes nothing", async () => {
    const org = fakeOrg();
    const okta = new Okta({ orgUrl: ORG, token: TOKEN, fetch: org.fetch as typeof fetch });
    const first = await oktaSetup(okta, { origin: "https://desk.example", providerCallback: null, known: { clientId: "", clientSecret: "" } });
    const before = org.state.log.length;

    const second = await oktaSetup(okta, {
      origin: "https://desk.example",
      providerCallback: null,
      known: { clientId: first.clientId, clientSecret: first.clientSecret! },
    });
    expect(writes(org.state.log.slice(before)).filter((line) => !line.startsWith("PUT /api/v1/apps/") || !line.includes("/policies/"))).toEqual([]);
    expect(second.clientId).toBe(first.clientId);
    expect(second.clientSecret).toBeNull();
    expect(org.state.apps).toHaveLength(1);
    expect(org.state.secrets).toHaveLength(1);
    expect(second.lines).toContain("  its 3 redirect URIs are already there");
  });

  test("a run after setup-arcade adds the provider callback, keeping every URI the app had", async () => {
    const org = fakeOrg();
    const okta = new Okta({ orgUrl: ORG, token: TOKEN, fetch: org.fetch as typeof fetch });
    const first = await oktaSetup(okta, { origin: "https://desk.example", providerCallback: null, known: { clientId: "", clientSecret: "" } });
    // Somebody added one by hand in the dashboard.
    redirectsOf(org.state.apps[0]!).push("https://elsewhere.example/callback");

    const again = await oktaSetup(okta, {
      origin: "https://desk.example",
      providerCallback: PROVIDER_CALLBACK,
      known: { clientId: first.clientId, clientSecret: first.clientSecret! },
    });
    expect(redirectsOf(org.state.apps[0]!)).toEqual([
      "https://desk.example/api/auth/callback",
      AGENT_SIGNIN_CALLBACK,
      USER_SOURCE_CALLBACK,
      "https://elsewhere.example/callback",
      PROVIDER_CALLBACK,
    ]);
    expect(again.lines).toContain(`  redirect URI added: ${PROVIDER_CALLBACK}`);
  });

  test("an app whose secret .env does not hold gets a new one", async () => {
    const org = fakeOrg();
    const okta = new Okta({ orgUrl: ORG, token: TOKEN, fetch: org.fetch as typeof fetch });
    await oktaSetup(okta, { origin: null, providerCallback: null, known: { clientId: "", clientSecret: "" } });
    const again = await oktaSetup(okta, { origin: null, providerCallback: null, known: { clientId: "", clientSecret: "" } });
    expect(org.state.secrets).toHaveLength(2);
    expect(again.clientSecret).toBe(org.state.secrets[1]!);
  });

  test("an access policy that already covers every client is used, and none is added", async () => {
    const org = fakeOrg({ defaultPolicyCovers: true });
    const okta = new Okta({ orgUrl: ORG, token: TOKEN, fetch: org.fetch as typeof fetch });
    const result = await oktaSetup(okta, { origin: null, providerCallback: null, known: { clientId: "", clientSecret: "" } });
    expect(org.state.authzPolicies.map((policy) => policy.name)).toEqual(["Default Policy"]);
    expect(result.lines).toContain("access policy: Default Policy already lets the app have tokens");
  });

  test("an org that refuses the sign-in policy still finishes, with a warning that says what to do by hand", async () => {
    const org = fakeOrg({ refuseSignOnPolicy: true });
    const okta = new Okta({ orgUrl: ORG, token: TOKEN, fetch: org.fetch as typeof fetch });
    const result = await oktaSetup(okta, { origin: null, providerCallback: null, known: { clientId: "", clientSecret: "" } });
    expect(result.clientId).not.toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Security → Authentication Policies");
  });

  test("the redirect URIs: the app's own only with a public host, the provider's only once known", () => {
    expect(redirectUris({ origin: null, providerCallback: null })).toEqual([AGENT_SIGNIN_CALLBACK, USER_SOURCE_CALLBACK]);
    expect(redirectUris({ origin: "https://a.example", providerCallback: PROVIDER_CALLBACK })).toEqual([
      "https://a.example/api/auth/callback",
      AGENT_SIGNIN_CALLBACK,
      USER_SOURCE_CALLBACK,
      PROVIDER_CALLBACK,
    ]);
    // The User Source's callback is fixed on Arcade Cloud and always
    // allowlisted, so `setup-arcade --gateway` needs no second Okta run.
    expect(USER_SOURCE_CALLBACK).toBe("https://cloud.arcade.dev/oauth2/intermediate_callback");
  });

  test("the token is sent to the org and nowhere else", async () => {
    const org = fakeOrg();
    const okta = new Okta({ orgUrl: ORG, token: TOKEN, fetch: org.fetch as typeof fetch });
    await expect(okta.request("GET", "https://elsewhere.example/api/v1/users")).rejects.toThrow("refusing to send the API token");
  });
});

describe("bun run okta-setup, the command", () => {
  let dir = "";
  let server: ReturnType<typeof Bun.serve>;
  let org: ReturnType<typeof fakeOrg>;
  const scratch = mkdtempSync(join(tmpdir(), "cg-okta-setup-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  beforeEach(() => {
    dir = mkdtempSync(join(scratch, "case-"));
    org = fakeOrg();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => org.fetch(request) });
  });
  afterEach(() => server.stop(true));

  async function run(env: Record<string, string>) {
    const child = spawnChild(["bun", "--no-env-file", join(ROOT, "scripts/okta-setup.ts")], {
      cwd: dir,
      env: childEnv(env),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  const orgUrl = () => `http://127.0.0.1:${server.port}`;
  const envFile = () => readFileSync(join(dir, ".env"), "utf8");
  const valueOf = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(envFile())?.[1] ?? "";

  test("prints the client id, writes the secret to .env (0600) and never to stdout, and a rerun changes nothing", async () => {
    writeFileSync(join(dir, ".env"), "APP_PUBLIC_HOST=desk.example\nOKTA_ORG_URL=\nIDP_ISSUER=\nIDP_CLIENT_ID=\nIDP_CLIENT_SECRET=\n");
    const first = await run({ OKTA_ORG_URL: orgUrl(), OKTA_API_TOKEN: TOKEN });
    expect(first.code).toBe(0);

    const secret = org.state.secrets[0]!;
    expect(valueOf("IDP_CLIENT_SECRET")).toBe(secret);
    expect(first.stdout).not.toContain(secret);
    expect(first.stderr).not.toContain(secret);
    expect(first.stdout).not.toContain(TOKEN);
    expect(first.stdout).toContain(`IDP_CLIENT_ID  ${valueOf("IDP_CLIENT_ID")}`);
    expect(first.stdout).toContain("op item create");
    expect(valueOf("IDP_ISSUER")).toBe(`${orgUrl()}/oauth2/default`);
    expect(valueOf("OKTA_ORG_URL")).toBe(orgUrl());
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(redirectsOf(org.state.apps[0]!)[0]).toBe("https://desk.example/api/auth/callback");

    const before = envFile();
    const second = await run({ OKTA_API_TOKEN: TOKEN });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("nothing changed");
    expect(envFile()).toBe(before);
    expect(org.state.apps).toHaveLength(1);
    expect(org.state.secrets).toHaveLength(1);
  });

  test("ARCADE_PROVIDER_CALLBACK in .env is added on the next run", async () => {
    writeFileSync(join(dir, ".env"), "APP_PUBLIC_HOST=desk.example\nOKTA_ORG_URL=\nIDP_ISSUER=\nIDP_CLIENT_ID=\nIDP_CLIENT_SECRET=\nARCADE_PROVIDER_CALLBACK=\n");
    expect((await run({ OKTA_ORG_URL: orgUrl(), OKTA_API_TOKEN: TOKEN })).code).toBe(0);
    writeFileSync(join(dir, ".env"), envFile().replace("ARCADE_PROVIDER_CALLBACK=", `ARCADE_PROVIDER_CALLBACK=${PROVIDER_CALLBACK}`));
    const again = await run({ OKTA_API_TOKEN: TOKEN });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`redirect URI added: ${PROVIDER_CALLBACK}`);
    expect(redirectsOf(org.state.apps[0]!).at(-1)).toBe(PROVIDER_CALLBACK);
  });

  test("an OKTA_API_TOKEN in .env is refused before any call to Okta", async () => {
    writeFileSync(join(dir, ".env"), `OKTA_API_TOKEN=${TOKEN}\n`);
    const run1 = await run({ OKTA_ORG_URL: orgUrl(), OKTA_API_TOKEN: TOKEN });
    expect(run1.code).toBe(78);
    expect(run1.stderr).toContain("OKTA_API_TOKEN is set in .env");
    expect(run1.stderr).not.toContain(TOKEN);
    expect(org.state.log).toEqual([]);
  });

  test("no token, or a refused one, is said plainly without the token", async () => {
    const none = await run({ OKTA_ORG_URL: orgUrl() });
    expect(none.code).toBe(78);
    expect(none.stderr).toContain("OKTA_API_TOKEN is not set");
    expect(none.stderr).toContain("op run");

    const wrong = await run({ OKTA_ORG_URL: orgUrl(), OKTA_API_TOKEN: "not-the-token" });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("Okta refused the token");
    expect(wrong.stderr).not.toContain("not-the-token");
  });

  test("the Admin Console's -admin host is refused by name", async () => {
    const admin = await run({ OKTA_ORG_URL: "https://trial-123-admin.okta.com", OKTA_API_TOKEN: TOKEN });
    expect(admin.code).toBe(78);
    expect(admin.stderr).toContain('Drop "-admin": https://trial-123.okta.com');
  });
});
