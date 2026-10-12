/**
 * `auth-config/` is the copy-paste form of what `bun run setup-arcade` sends:
 * one JSON body per registration, with `<PLACEHOLDERS>` where a value is the
 * developer's own. A body edited in the script and not here would leave a
 * dashboard user registering something the app no longer expects, so each file
 * is held to the builder that sends it.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gatewayBody, pluginBody, providerBody, verifierBody } from "../scripts/setup-arcade/arcade.ts";
import { userSourceBody } from "../scripts/setup-arcade/coordinator.ts";

const REPO = join(import.meta.dir, "..");
const HOST = "<APP_PUBLIC_HOST>";
const ORIGIN = `https://${HOST}`;
/**
 * The identity provider's endpoints, in Okta's shape under `<IDP_ISSUER>`.
 * Another provider's come from its discovery document.
 */
const ISSUER = "<IDP_ISSUER>";
const ENDPOINTS = {
  authorize: `${ISSUER}/v1/authorize`,
  token: `${ISSUER}/v1/token`,
  userinfo: `${ISSUER}/v1/userinfo`,
};

const read = (name: string) => JSON.parse(readFileSync(join(REPO, "auth-config", name), "utf8"));

const EXPECTED: Record<string, unknown> = {
  "app-identity-provider.json": providerBody({
    host: HOST,
    origin: ORIGIN,
    endpoints: ENDPOINTS,
    clientId: "<IDP_CLIENT_ID>",
    clientSecret: "<IDP_CLIENT_SECRET>",
    approvalsStoreToken: "",
  }),
  "custom-verifier.json": verifierBody(ORIGIN),
  "hooks-plugin.json": pluginBody(ORIGIN, "<ARCADE_HOOK_SIGNING_SECRET>", "active"),
  // The optional pair `setup-arcade --gateway` sends: the User Source, then the gateway through it.
  "user-source.json": userSourceBody({ issuer: ISSUER, clientId: "<IDP_CLIENT_ID>", clientSecret: "<IDP_CLIENT_SECRET>" }),
  "gateway.json": gatewayBody({ slug: "<ARCADE_GATEWAY_ID>", userSourceId: "<USER_SOURCE_ID>", toolkit: "LoanDesk" }),
};

describe("auth-config/", () => {
  for (const [name, body] of Object.entries(EXPECTED)) {
    test(`${name} is what setup-arcade sends`, () => {
      expect(read(name)).toEqual(body);
    });
  }

  test("README.md names every file in the folder", () => {
    const readme = readFileSync(join(REPO, "auth-config", "README.md"), "utf8");
    for (const name of Object.keys(EXPECTED)) expect(readme).toContain(`\`${name}\``);
  });

  test("the folder holds exactly those files", () => {
    // The agent calls the Engine directly with the project key: the User
    // Source and the gateway are the optional `--gateway` pair, and the README
    // says so. Anything else here would have a dashboard user create something
    // the app never uses.
    const files = readdirSync(join(REPO, "auth-config")).filter((name) => name.endsWith(".json"));
    expect(files.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test("no file holds a value of its own where a placeholder belongs", () => {
    for (const name of Object.keys(EXPECTED)) {
      const text = readFileSync(join(REPO, "auth-config", name), "utf8");
      expect(text).not.toMatch(/ngrok|localhost|127\.0\.0\.1/);
    }
  });

  test("the README marks the User Source and the gateway optional, and the agent needs neither", () => {
    const readme = readFileSync(join(REPO, "auth-config", "README.md"), "utf8");
    expect(readme).toMatch(/`user-source\.json` \| Optional, with `--gateway`/);
    expect(readme).toMatch(/`gateway\.json` \| Optional, with `--gateway`/);
    expect(readme).toContain("The agent needs no User Source and no MCP gateway.");
    expect(read("gateway.json").auth_type).toBe("user_source");
  });
});
