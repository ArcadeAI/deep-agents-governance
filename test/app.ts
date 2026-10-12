/**
 * The app, booted for the reset tests: one process, one port, both modules.
 *
 * The reset command resets the control plane and the loan module at one
 * address, `APP_PUBLIC_HOST`, and this is that address: the real app, under
 * `next dev`, the way a presenter runs it, with its own throwaway
 * `governance.db` and `loans.db`, signing in through an OIDC stand-in
 * (`app-test/app-identity.ts`) in place of Okta.
 *
 * Its own `distDir` (`CG_NEXT_DIST_DIR`, as `app-test/control-plane-app.test.ts`
 * does), so it does not fight another `next dev` over `.next`. A port the OS
 * handed out, never a guess, and handed out again if somebody else took it (#9).
 */
import type { Subprocess } from "bun";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveOnFreePort, type Booted } from "../app-test/cdp.ts";
import { spawnChild } from "../app-test/child.ts";
import { childEnv } from "../app-test/child-env.ts";
import { appIdentityEnv, stopAppIdentities, type AppIdentity } from "../app-test/app-identity.ts";

const ROOT = join(import.meta.dir, "..");
const BOOT_MS = 180_000;

export interface App {
  origin: string;
  /** HOST-form, what the reset command is handed. */
  host: string;
  child: Subprocess;
  /** Everything the app printed, for a failure message. */
  output(): string;
  /**
   * Where this app's two databases are, for a test that has to do what
   * `bun run users` does (#31), write a subject straight into
   * `governance.db`, before it asks the app over HTTP what survived.
   */
  databases: { governance: string; loans: string };
  /** The identity provider it signs in through, with the demo cast in it and a Management API. */
  identity: AppIdentity;
  stop(): Promise<void>;
}

/** `cast: false` starts the identity provider with nobody in it, for a test that seeds the cast itself. */
export async function bootApp(env: Record<string, string>, options: { cast?: boolean } = {}): Promise<App> {
  const data = mkdtempSync(join(tmpdir(), "cg-reset-app-"));
  const distDirs: string[] = [];
  const cleanup = () => {
    rmSync(data, { recursive: true, force: true });
    for (const distDir of distDirs) rmSync(join(ROOT, distDir), { recursive: true, force: true });
    stopAppIdentities();
  };
  const identities = new Map<number, AppIdentity>();

  // An allowlist, not the developer's shell minus some of it (`child-env.ts`):
  // an IDP_* from a local run would make these tests about
  // their environment, and a host or database path would point the app
  // somewhere else.
  //
  // The port is chosen inside `serveOnFreePort`, which starts the app again on
  // a new one if another process took it first (#9); each attempt gets its own
  // databases and `distDir`. Up means every module answered, not just the
  // page: the two `/health` routes are what the reset tests read back.
  let booted: Booted;
  try {
    booted = await serveOnFreePort(
      async (port) => {
        const identity = await appIdentityEnv(`http://127.0.0.1:${port}`, { devTokens: true, cast: options.cast ?? true });
        identities.set(port, identity);
        const dir = join(data, String(port));
        mkdirSync(dir);
        const distDir = `.next/cg-reset-${port}`;
        distDirs.push(distDir);
        return spawnChild(["bun", "scripts/next.ts", "dev"], {
          cwd: ROOT,
          env: childEnv({
            NODE_ENV: "development",
            PORT: String(port),
            CG_NEXT_DIST_DIR: distDir,
            NEXT_TELEMETRY_DISABLED: "1",
            APP_PUBLIC_HOST: `127.0.0.1:${port}`,
            GOVERNANCE_DB_PATH: join(dir, "governance.db"),
            LOANS_DB_PATH: join(dir, "loans.db"),
            ...identity.env,
            ...env,
          }),
          stdout: "pipe",
          stderr: "pipe",
        });
      },
      {
        ready: async (port) => {
          const answers = await Promise.all(
            ["/hooks/health", "/bank/health"].map((path) => fetch(`http://127.0.0.1:${port}${path}`)),
          );
          return answers.every((answer) => answer.ok);
        },
        timeoutMs: BOOT_MS,
      },
    );
  } catch (error) {
    cleanup();
    throw new Error(`the app did not come up: ${(error as Error).message}`, { cause: error });
  }

  const { child, port, output } = booted;
  const host = `127.0.0.1:${port}`;
  const dir = join(data, String(port));
  const databases = {
    governance: join(dir, "governance.db"),
    loans: join(dir, "loans.db"),
  };
  const stop = async () => {
    child.kill();
    await child.exited;
    cleanup();
  };
  return { origin: `http://${host}`, host, child, output, databases, identity: identities.get(port)!, stop };
}
