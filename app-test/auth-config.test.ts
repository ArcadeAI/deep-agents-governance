/**
 * `auth-config/` is the copy-paste form of what `bun run setup-arcade` sends:
 * one JSON body per registration, with `<PLACEHOLDERS>` where a value is the
 * developer's own. A body edited in the script and not here would leave a
 * dashboard user registering something the app no longer expects, so each file
 * is held to the builder that sends it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { gatewayBody, pluginBody, providerBody, verifierBody } from "../scripts/setup-arcade/arcade.ts";
import { userSourceBody } from "../scripts/setup-arcade/coordinator.ts";
import { serverName } from "../scripts/setup-arcade/toolkit.ts";

const REPO = join(import.meta.dir, "..");
const HOST = "<APP_PUBLIC_HOST>";
const ORIGIN = `https://${HOST}`;

/** `loan_desk` as Arcade prefixes its tools: `LoanDesk` (`mcp/loan_desk/app.py`). */
const TOOLKIT = serverName(join(REPO, "mcp"))!
  .split("_")
  .map((word) => word[0]!.toUpperCase() + word.slice(1))
  .join("");

const read = (name: string) => JSON.parse(readFileSync(join(REPO, "auth-config", name), "utf8"));

const EXPECTED: Record<string, unknown> = {
  "user-source.json": userSourceBody({
    issuer: ORIGIN,
    clientId: "<ARCADE_USER_SOURCE_CLIENT_ID>",
    clientSecret: "<ARCADE_USER_SOURCE_CLIENT_SECRET>",
  }),
  "app-identity-provider.json": providerBody({
    host: HOST,
    origin: ORIGIN,
    arcadeClientId: "<ARCADE_CLIENT_ID>",
    arcadeClientSecret: "<ARCADE_CLIENT_SECRET>",
    approvalsStoreToken: "",
  }),
  "custom-verifier.json": verifierBody(ORIGIN),
  "hooks-plugin.json": pluginBody(ORIGIN, "<ARCADE_HOOK_SIGNING_SECRET>", "active"),
  "gateway.json": gatewayBody({
    slug: "<ARCADE_GATEWAY_ID>",
    userSourceId: "<USER_SOURCE_ID>",
    toolkit: TOOLKIT,
  }),
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

  test("no file holds a value of its own where a placeholder belongs", () => {
    for (const name of Object.keys(EXPECTED)) {
      const text = readFileSync(join(REPO, "auth-config", name), "utf8");
      expect(text).not.toMatch(/ngrok|localhost|127\.0\.0\.1/);
    }
  });
});
