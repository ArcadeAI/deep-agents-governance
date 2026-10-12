/**
 * The Slack link, opened in a browser with no session.
 *
 * `DESIGN.md` has each persona in their own Chrome profile, and a link posted
 * to Slack gets opened wherever the person happens to be — so "no session" is
 * the ordinary case rather than the edge, and the human's decision (#180, the
 * driver's call, 2026-09-21) is that it is an ordinary **sign-in** rather than
 * an error:
 *
 * - the request renders exactly as it does for a signed-in opener, because
 *   reading is not deciding and an approver should see what they are being
 *   asked to approve before being asked for a password;
 * - Approve and Deny are replaced by a distinct `Sign in to decide`, never a
 *   greyed-out Approve — a disabled Approve on a governance page reads as a
 *   refusal nothing made;
 * - and signing in comes back to the same link.
 *
 * That last part is **followed**, not read off the handlers. `safeNext`
 * returning a path is not the claim; the claim is that a person who opens a
 * link, types a password at the identity provider, and comes back can press
 * the button. So this drives the whole chain: `next dev` serves the page, the
 * OIDC stand-in asks for the password as Okta would, and the same cookie jar
 * arrives back on the approval page with the buttons on it.
 *
 * No browser here on purpose: every hop is a redirect and an HTML form, which
 * the suite's own cookie jar follows, and the thing being proved is a route
 * rather than a rendering. `approval-identity-browser.test.ts` is where a real
 * Chrome presses a real button.
 */
import type { Subprocess } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appIdentityEnv, stopAppIdentities } from "./app-identity.ts";
import { serveOnFreePort, stopProcess } from "./cdp.ts";
import { spawnChild } from "./child.ts";
import { Browser, SESSION_SECRET, signInAs } from "./identity-harness.ts";
import { RILEY, startHarness, type Harness } from "./harness.ts";

const WEB = join(import.meta.dir, "..");

/** The booted app, and the issuer it signs in through. */
let identity: { webUrl: string; idpUrl: string };
let control: Harness;
const scratch = join(tmpdir(), `cg-approval-signed-out-${crypto.randomUUID()}`);
let next: Subprocess | undefined;
let origin: string;

beforeAll(async () => {
  control = await startHarness();

  // The port is chosen before the app's identity provider starts, because it
  // has to be told to accept this origin's callback: it checks the redirect
  // URI against the registered list, as Okta does. So both happen inside
  // `serveOnFreePort`, which does them again on a new port if another process
  // took this one first (#9; CI lost this race once, on port 44609).
  let idpUrl = "";
  const web = await serveOnFreePort(
    async (webPort) => {
      const appIdentity = await appIdentityEnv(`http://localhost:${webPort}`);
      idpUrl = appIdentity.standIn.issuer;
      return spawnChild({
        // `--bun`: the app runs on Bun since #4, because the control plane it
        // mounts opens governance.db with bun:sqlite (`scripts/next.ts`).
        cmd: ["bun", "--bun", "run", "next", "dev", "--port", String(webPort)],
        cwd: WEB,
        env: {
          ...process.env,
          NODE_ENV: "development",
          PORT: String(webPort),
          // The app mounts the control plane since #4; a throwaway one, not
          // a governance.db in the repo.
          GOVERNANCE_DB_PATH: ":memory:",
          // The app holds the loan book since #5; a throwaway one, not a
          // loans.db in the repo.
          LOANS_DB_PATH: ":memory:",
          SESSION_SECRET,
          // The identity provider is an OIDC stand-in with the demo cast in
          // it, and APP_PUBLIC_HOST is the app's own origin.
          ...appIdentity.env,
          // The app's server-side reads go to CONTROL_PLANE_HOST (#4), which
          // defaults to the app's own listener; this test's control plane is elsewhere.
          CONTROL_PLANE_HOST: control.hooksHost,
          APPROVALS_STORE_TOKEN: control.config.approvalsStoreToken,
          ARCADE_API_URL: control.config.arcadeApiUrl,
          ARCADE_API_KEY: control.config.arcadeApiKey,
          ARCADE_TOOLKIT: control.config.toolkit,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    },
    { url: (webPort) => `http://localhost:${webPort}/` },
  );
  next = web.child;
  origin = `http://localhost:${web.port}`;
  identity = { webUrl: origin, idpUrl };
}, 300_000);

afterAll(async () => {
  await stopProcess(next);
  await control?.stop();
  stopAppIdentities();
  rmSync(scratch, { recursive: true, force: true });
});

const read = async (browser: Browser, path: string) => (await browser.fetch(`${origin}${path}`)).text();

test("an opener with no session sees the request, and a sign-in instead of the buttons", async () => {
  const id = String((await control.escalate()).id);
  const html = await read(new Browser(), `/approvals/${id}`);

  expect(html).toContain("Sign in to decide");
  // The same fields a signed-in opener gets. Not trimmed because signed-out
  // feels sensitive, and not widened either: whether this link should disclose
  // the request at all is a separate question, and it is not answered
  // differently per viewer here.
  expect(html).toContain("LN-2291");
  expect(html).toContain("$95,000");
  expect(html).toContain("Eleven years in business");
  expect(html).toContain("approve_loan");
  // There is no button to press, and nothing that reads as one having been
  // refused.
  expect(html).not.toMatch(/value="approved"/);
  expect(html).not.toContain("disabled");
  expect(html).not.toContain("CHECK_FAILED");
});

test("signing in from that link comes back to the same request, with the buttons", async () => {
  const id = String((await control.escalate()).id);
  const browser = new Browser();

  const cold = await read(browser, `/approvals/${id}`);
  const href = /href="([^"]*api\/auth\/signin[^"]*)"/.exec(cold)?.[1];
  if (href === undefined) throw new Error(`no sign-in link on the signed-out page:\n${cold.slice(0, 800)}`);

  // Followed from the page's own link, not from a URL this test composed — a
  // test that builds its own destination proves its own arithmetic.
  const landed = await signInAs(browser, identity, "riley", {
    from: new URL(href.replace(/&amp;/g, "&"), origin).toString(),
    // Stop on the redirect *to* the approval page. Letting `follow` fetch it
    // would make it fill and post the decide form, which is a decision this
    // test never asked for.
    stopAt: `/approvals/${id}`,
  });

  expect(landed.url).toBe(`${origin}/approvals/${id}`);
  // A real password was typed at the IdP and nowhere else.
  expect(browser.pageHosts).toContain(new URL(identity.idpUrl).host);

  const warm = await read(browser, `/approvals/${id}`);
  expect(warm).toContain("Signed in as");
  expect(warm).toContain("Charlie");
  expect(warm).toContain(RILEY);
  expect(warm).toContain('value="approved"');
  expect(warm).not.toContain("Sign in to decide");
  // Still no way to act as anybody else.
  expect(warm).not.toContain("Act as");
  expect(warm).not.toContain("<select");
}, 120_000);

test("a link nobody recognises says so without costing a password", async () => {
  const html = await read(new Browser(), "/approvals/apr_nosuchthing");

  expect(html).toContain("Nothing to decide");
  expect(html).not.toContain("Sign in to decide");
});
