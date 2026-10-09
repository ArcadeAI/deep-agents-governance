/**
 * Reading and filling in `.env` for `bun run setup-arcade` (#9) and
 * `bun run okta-setup`.
 *
 * The rule: **blanks only**, with two exceptions, both through
 * {@link replaceValue}. `ARCADE_PROVIDER_CALLBACK` is kept in sync with the
 * live provider's callback (#30), and `IDP_ISSUER`, `IDP_CLIENT_ID` and
 * `IDP_CLIENT_SECRET` follow the Okta org, which `okta-setup` reads them from.
 * Every other key with a value is never changed, whoever wrote it.
 * A key present and empty (`KEY=`, as `.env.example` ships them) is
 * filled where it stands; a key that is absent is appended under one header.
 * Comments and order survive, so the file stays the one the developer copied.
 */
import { writeFileSync } from "node:fs";

import { isOverrideWarned, parseEnv, readEnvText } from "../env-overrides.ts";

export { parseEnv };

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function readEnvFile(path: string): string {
  return readEnvText(path);
}

export interface FillResult {
  text: string;
  /** Keys this call wrote, in order. */
  written: string[];
  /** Keys it was asked to fill and left alone because they already had a value. */
  kept: string[];
}

/** Fills each blank or absent key in `text`; never touches a key that has a value. `by` names the command in the appended block's header. */
export function fillBlanks(text: string, values: Record<string, string>, by = "setup-arcade"): FillResult {
  const existing = parseEnv(text);
  const written: string[] = [];
  const kept: string[] = [];
  const lines = text.split("\n");
  const appended: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (existing[key] !== undefined && existing[key] !== "") {
      kept.push(key);
      continue;
    }
    const index = lines.findIndex((line) => LINE.exec(line)?.[1] === key);
    if (index === -1) appended.push(`${key}=${value}`);
    else lines[index] = `${key}=${value}`;
    written.push(key);
  }

  let out = lines.join("\n");
  if (appended.length > 0) {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
    out += `\n# Written by \`bun run ${by}\`.\n${appended.join("\n")}\n`;
  }
  return { text: out, written, kept };
}

export function writeEnvFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
}

/**
 * The variables `bun run setup-arcade` decides about (#30): `.env.example`'s
 * two required values, which it reads; the identity provider's, which
 * `bun run okta-setup` writes and it reads; and the block it writes itself.
 * `app-test/setup-arcade.test.ts` holds the lists to `.env.example`.
 * No persona addresses since #33: users are added with `bun run users`.
 */
export const REQUIRED_KEYS = ["ARCADE_API_KEY", "APP_PUBLIC_HOST"] as const;

/** Written by `bun run okta-setup`, from the org. `OKTA_API_TOKEN` is never among them: it never goes in a file. */
export const IDP_KEYS = ["OKTA_ORG_URL", "IDP_ISSUER", "IDP_CLIENT_ID", "IDP_CLIENT_SECRET"] as const;

export const WRITTEN_KEYS = [
  "SESSION_SECRET",
  "ARCADE_PROVIDER_CALLBACK",
  "ARCADE_HOOK_SIGNING_SECRET",
  "APPROVALS_STORE_TOKEN",
  "ARCADE_GATEWAY_ID",
  "GOVERNANCE_STREAM",
] as const;

export const MANAGED_KEYS: readonly string[] = [...REQUIRED_KEYS, ...IDP_KEYS, ...WRITTEN_KEYS];

/**
 * The variables the shell exports with a value `.env` does not hold, names
 * only, sorted: every managed one, and every identity or secret key the app
 * warns about on start (#54, `isOverrideWarned` in `scripts/env-overrides.ts`), so
 * `IDP_SCOPES` left over from an older clone stops this run too. A shell variable equal to `.env`'s value is no conflict; one `.env`
 * leaves blank or out is.
 */
export function shellConflicts(shell: Record<string, string | undefined>, file: Record<string, string>): string[] {
  const keys = new Set([...MANAGED_KEYS, ...Object.keys(shell).filter(isOverrideWarned)]);
  return [...keys].filter((key) => shell[key] !== undefined && shell[key]!.trim() !== (file[key]?.trim() ?? ""));
}

/**
 * `key`'s line set to `value`, whatever it held. For the variables whose
 * source of truth is Arcade or the Okta org rather than `.env` (#30): every
 * other key keeps the never-overwrite rule of {@link fillBlanks}.
 */
export function replaceValue(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => LINE.exec(line)?.[1] === key);
  if (index === -1) return fillBlanks(text, { [key]: value }).text;
  lines[index] = `${key}=${value}`;
  return lines.join("\n");
}
