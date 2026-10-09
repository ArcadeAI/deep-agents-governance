/**
 * `bun run dev:idp-stub` has to bind the identity provider's port, not the
 * app's own.
 *
 * Until #5 the stub lived under `apps/loan-app/scripts/` and the root script
 * ran it with `--cwd apps/loan-app`, so Bun loaded `apps/loan-app/.env.local`
 * into it. Since #5 it is `scripts/dev-idp.ts`, run from the root, so Bun
 * loads the root `.env.local`, whose `PORT` is the app's — the same trap with
 * a different owner. Until #56 it took `PORT` from that file — the loan API's
 * port. In a worktree
 * owning 4410-4419 both processes wanted 4412, and the identity provider's
 * address pointed at 4413 where nothing was listening. Since the move to Okta
 * that address is `IDP_ISSUER`. Sibling of `app-test/dev-port.test.ts`
 * (#50): same family of silent misbinding, different cause — that one was a
 * shell expanding `${PORT:-3000}` before anything read the file, this one read
 * the right file for the wrong service.
 *
 * The first test therefore runs the *packaged* script, verbatim, from the root
 * manifest, in a throwaway tree whose `.env.local` carries a `PORT` and an
 * `IDP_ISSUER` that disagree. Only one of them can be the one it binds.
 * Before #5 there were two manifests in that chain, the root's and
 * `apps/loan-app`'s; the service's is gone, and so is the one expectation that
 * read a script out of it.
 */
import { afterAll, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveStubPort } from "../../scripts/dev-idp.ts";
import { serveOnFreePort } from "../cdp.ts";
import { freePort, spawnChild } from "../child.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const STUB = join(REPO_ROOT, "scripts", "dev-idp.ts");
const STAND_IN = join(REPO_ROOT, "scripts", "oidc-stand-in.ts");

interface Manifest {
  scripts?: Record<string, string>;
}

async function manifestAt(dir: string): Promise<Manifest> {
  return (await Bun.file(join(dir, "package.json")).json()) as Manifest;
}

/**
 * What the stub is started with: enough of the caller's environment to run
 * `bun`, and nothing the fixture decides.
 *
 * `bun test` sets `NODE_ENV=test`, and under it Bun skips `.env.local`
 * entirely — a real dev server's environment is the one without it, so
 * `NODE_ENV` is not passed. And the whole question is which of the fixture
 * `.env.local`'s two values the stub picks, so neither `PORT` nor
 * `IDP_ISSUER` may reach it from the caller: Bun lets a variable already
 * in the environment win over the file. Measured on #50.
 *
 * An allowlist, not a list of exclusions, since round 1 of #5's review: the
 * first cut dropped `PORT` and `NODE_ENV` only, and a shell that had exported
 * the worktree's own `.env.local` (`set -a; . ./.env.local`) handed the stub
 * the worktree's identity provider address, so it bound that and the test timed out on
 * the fixture's port. Every `*_PUBLIC_HOST`, `CG_PORT_*` or anything else a
 * future fixture writes is excluded the same way, by not being on this list.
 */
const PASSED_THROUGH = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "TERM"] as const;

function devEnv(extra: Record<string, string> = {}): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of PASSED_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return { ...inherited, ...extra };
}

let child: Subprocess | undefined;
let project: string | undefined;

afterAll(() => {
  child?.kill();
  if (project !== undefined) rmSync(project, { recursive: true, force: true });
});

test("the packaged dev:idp-stub script binds IDP_ISSUER's port, not PORT", async () => {
  // Nothing listens on the app's port: the stub must leave it alone.
  const loanPort = freePort();

  const root = await manifestAt(REPO_ROOT);
  const stubScript = root.scripts?.["dev:idp-stub"];
  expect(stubScript).toBeString();

  // The root manifest, reproduced with the real script string, so the test
  // exercises the whole chain: where the script runs from decides which
  // `.env.local` Bun loads.
  project = mkdtempSync(join(tmpdir(), "cg-dev-idp-port-"));
  mkdirSync(join(project, "scripts"), { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify(
      { name: "cg-dev-idp-port-fixture", private: true, scripts: { "dev:idp-stub": stubScript } },
      null,
      2,
    )}\n`,
  );
  cpSync(STUB, join(project, "scripts", "dev-idp.ts"));
  cpSync(STAND_IN, join(project, "scripts", "oidc-stand-in.ts"));

  // The stub's port is chosen inside `serveOnFreePort`, which writes it and
  // starts the stub again on a new one if another process took it first (#9).
  // The child's own output is the only thing that says *why* nothing answered
  // — "bound the loan port instead" and "crashed on startup" look identical
  // from out here — and the error a failed boot throws carries it.
  const dir = project;
  const booted = await serveOnFreePort(
    (idpPort) => {
      // The only two ports in the fixture, and they disagree on purpose: `PORT` is
      // the app's, the way `scripts/orca-setup.sh` writes the root `.env.local`.
      writeFileSync(join(dir, ".env.local"), `PORT=${loanPort}\nIDP_ISSUER=http://localhost:${idpPort}/oauth2/default\n`);
      return spawnChild(["bun", "run", "--cwd", dir, "dev:idp-stub"], {
        env: devEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
    },
    { ready: async (idpPort) => (await fetch(`http://localhost:${idpPort}/oauth2/default/.well-known/openid-configuration`)).ok, timeoutMs: 30_000 },
  ).catch((error: unknown) => {
    throw new Error(
      `\`${stubScript as string}\` did not answer on the port in IDP_ISSUER.\n${(error as Error).message}`,
    );
  });
  child = booted.child;
  expect(booted.port).not.toBe(loanPort);

  const issuer = `http://localhost:${booted.port}/oauth2/default`;
  const body = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as { issuer?: string; userinfo_endpoint?: string };
  expect(body.issuer).toBe(issuer);
  // The whole of its protocol: `dev:<email>` is that email.
  const me = await fetch(body.userinfo_endpoint!, { headers: { authorization: "Bearer dev:alice@example.test" } });
  expect(((await me.json()) as { email?: string }).email).toBe("alice@example.test");

  // And the other half of the bug: the app's port is still free, so `bun run
  // dev` can have it.
  await expect(fetch(`http://localhost:${loanPort}/health`)).rejects.toThrow();
}, 60_000);

/** Unset, there is no issuer to stand in for, and no port to fall back to: the #56 lesson. */
test("a missing IDP_ISSUER is refused rather than defaulted", () => {
  expect(() => resolveStubPort({})).toThrow(/IDP_ISSUER is not set/);
  expect(() => resolveStubPort({ IDP_ISSUER: "  " })).toThrow(/IDP_ISSUER is not set/);
});

test("the port is read out of the issuer", () => {
  expect(resolveStubPort({ IDP_ISSUER: "http://localhost:4413/oauth2/default" })).toBe(4413);
  expect(resolveStubPort({ IDP_ISSUER: " http://localhost:4413/oauth2/default " })).toBe(4413);
  expect(resolveStubPort({ IDP_ISSUER: "http://127.0.0.1:4413" })).toBe(4413);
  expect(resolveStubPort({ IDP_ISSUER: "http://[::1]:4413/oauth2/default" })).toBe(4413);
});

/**
 * The refusal matters as much as the binding. A host with no port is a real
 * identity provider somewhere else, and a stub that quietly fell back to 8083
 * there would be listening where nobody is calling — the #56 failure again,
 * wearing a different hat.
 */
test("an issuer with no port is refused rather than defaulted", () => {
  expect(() => resolveStubPort({ IDP_ISSUER: "https://example.okta.com/oauth2/default" })).toThrow(/names no port/);
  expect(() => resolveStubPort({ IDP_ISSUER: "example.okta.com" })).toThrow(/not a URL|names no port/);
});

test("the stub exits EX_CONFIG, and binds nothing, when the issuer names no port", async () => {
  const refused = spawnChild(["bun", STUB], {
    env: devEnv({ IDP_ISSUER: "https://example.okta.com/oauth2/default" }),
    stdout: "pipe",
    stderr: "pipe",
  });

  const status = await refused.exited;
  const stderr = await new Response(refused.stderr as ReadableStream).text();

  // Exit status, not just the message: a script that printed this and then
  // served anyway would pass a stderr-only assertion.
  expect(status).toBe(78);
  expect(stderr).toContain("IDP_ISSUER=https://example.okta.com/oauth2/default");
}, 30_000);
