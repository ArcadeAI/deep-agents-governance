/**
 * What a visitor sees when this deployment is only half configured.
 *
 * Round 2 of #84's review ran a built cg-web with sign-in configured and
 * `ARCADE_API_KEY` absent (with what was then `ARCADE_GATEWAY_ID`). `/health`
 * answered `{"status":"ok", … "verifier":"missing"}` and `GET /` rendered the
 * ordinary persona buttons with no warning anywhere. The process stayed Ready, the host kept it in rotation, and
 * the only way to discover that no tool call could ever be made was to click
 * into a flow and read a 503.
 *
 * That is the failure mode this whole project argues against, in our own UI: a
 * control that is not there, presented as one that is. So the same sentences
 * now reach three surfaces — the 503 pages, `/health`, and a red banner in
 * front of whoever opens the page — and all three come from `lib/config.ts`,
 * which is what stops them describing different deployments.
 *
 * ## Two components since #176, and that is the point
 *
 * The banner used to be declared inside `SignInPanel.tsx` and rendered above
 * the four "Sign in as …" buttons. #176 deleted the switcher and is explicit
 * that the banner is not part of it — *"do not let it leave with the buttons"*
 * — so it has its own file and each page places it, and this file checks the
 * two halves apart:
 *
 * - `ConfigurationBanner` still appears, still red, still naming the missing
 *   variable, with nothing left of a panel to carry it.
 * - `SessionChrome` — what the bank's top chrome now holds — still goes inert
 *   when sign-in itself is broken, and still says nothing about a persona.
 *
 * The third half, that it reaches the served `/`, is in
 * `app-test/home-full-screen-browser.test.ts`: a claim about the whole page cannot
 * be made by rendering one component of it.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  configurationProblems,
  deploymentReadiness,
  isMisconfigured,
  readIdentitySurface,
} from "../lib/config.ts";
import { ConfigurationBanner } from "../components/identity/ConfigurationBanner.tsx";
import { SessionChrome } from "../components/identity/SessionChrome.tsx";
import { SIGNIN_PATH } from "../auth/handlers.ts";

/** `openssl rand -hex 32`, written out so this suite's green is not a sample. */
const GOOD_SECRET = "3f9a1c7e5b2d84069a1fe73c05b8d42e6c917ab3fd50e28c47196baf3d0c5e81";

/** Everything a cg-web needs. Individual tests take keys away. */
const COMPLETE = {
  APP_PUBLIC_HOST: "cg-web-sa31.example.com",
  IDP_ISSUER: "https://bank.okta.example/oauth2/default",
  IDP_CLIENT_ID: "client-c",
  IDP_CLIENT_SECRET: "client-c-secret",
  SESSION_SECRET: GOOD_SECRET,
  ARCADE_API_KEY: "arcade-key",
} as const;

/** The banner alone, exactly as `app/page.tsx` and `app/chat/page.tsx` place it. */
function banner(env: Record<string, string>): string {
  return renderToStaticMarkup(
    <ConfigurationBanner problems={configurationProblems(readIdentitySurface(env))} />,
  );
}

/** The session controls the bank's top chrome carries, with nobody signed in. */
function chrome(env: Record<string, string>): string {
  return renderToStaticMarkup(
    <SessionChrome session={null} problems={configurationProblems(readIdentitySurface(env))} />,
  );
}

/** Tags stripped, whitespace collapsed — what a person actually reads. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

describe("the banner, with ARCADE_API_KEY absent", () => {
  const { ARCADE_API_KEY, ...withoutKey } = COMPLETE;

  test("it appears, and names the missing variable in the visitor's face", () => {
    const html = banner(withoutKey);

    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("This deployment is not fully configured");
    expect(text(html)).toContain("The custom verifier is not configured");
    // The same sentence `verifierProblems` produces for the 503 page. One source.
    expect(text(html)).toContain("ARCADE_API_KEY is not set");
    expect(configurationProblems(readIdentitySurface(withoutKey)).verifier).toContain(
      "ARCADE_API_KEY is not set",
    );
  });

  test("sign-in still works, so its control stays live", () => {
    const html = chrome(withoutKey);
    // Only the verifier is broken. Disabling the way in here would say the
    // wrong thing: a visitor can sign in, and finding out how far they get is
    // the point of the banner above them.
    expect(html).toContain(`href="${SIGNIN_PATH}"`);
    expect(html).not.toContain("disabled");
  });

  test("the banner does not repeat sign-in's problems under every heading", () => {
    // `APP_PUBLIC_HOST` is a problem for sign-in and the verifier both.
    // Printing the same sentence under two headings is how a banner becomes
    // something people stop reading.
    const problems = configurationProblems(readIdentitySurface({ ARCADE_CLOUD_URL: "https://cloud.arcade.dev" }));
    expect(problems.signin).toContain("APP_PUBLIC_HOST is not set");
    expect(problems.verifier).not.toContain("APP_PUBLIC_HOST is not set");
    expect(problems.verifier).toContain("ARCADE_API_KEY is not set");
  });
});

describe("the banner, with sign-in itself broken", () => {
  const { IDP_CLIENT_SECRET, ...withoutClientC } = COMPLETE;

  test("the way in is disabled rather than hidden", () => {
    const html = chrome(withoutClientC);

    // Inert, not absent: hiding it would leave a visitor wondering whether this
    // deployment has a sign-in at all.
    expect(html).toContain("disabled");
    expect(html).toContain("Sign in");
    expect(html).not.toContain(`href="${SIGNIN_PATH}"`);
    expect(text(banner(withoutClientC))).toContain("IDP_CLIENT_SECRET is not set");
  });

  test("a SESSION_SECRET that is set but too weak reads as a configuration problem too", () => {
    expect(text(banner({ ...COMPLETE, SESSION_SECRET: "x" }))).toContain("at least 32 characters");
    expect(chrome({ ...COMPLETE, SESSION_SECRET: "x" })).toContain("disabled");
  });
});

describe("a fully configured deployment", () => {
  test("no banner, a live way in, and /health says ok", () => {
    const config = readIdentitySurface(COMPLETE);

    expect(isMisconfigured(configurationProblems(config))).toBe(false);
    expect(deploymentReadiness(config)).toEqual({
      status: "ok",
      signin: "configured",
      verifier: "configured",
    });

    expect(banner(COMPLETE)).toBe("");

    const html = chrome(COMPLETE);
    expect(html).not.toContain("disabled");
    expect(html).toContain(`href="${SIGNIN_PATH}"`);
  });

  /**
   * #176's first criterion, at the one place a persona button could come back.
   *
   * The switcher is gone because one Chrome profile per persona is the real
   * demo shape and a row of "Sign in as …" buttons read as the most
   * demo-looking thing on a screen arguing that nothing here is a mock. What
   * replaced it is one `Sign in` that starts the same OIDC authorization with
   * **no persona preselected** — so the hint is what must not reappear, and a
   * `?persona=` on this anchor is exactly how it would.
   */
  test("nothing here names a persona or preselects one", () => {
    const html = chrome(COMPLETE);

    expect(html).toContain(`href="${SIGNIN_PATH}"`);
    expect(html).not.toContain("persona=");
    for (const persona of ["Alice", "Bob", "Charlie", "Michael"]) {
      expect(text(html)).not.toContain(persona);
    }
    expect(text(html)).not.toContain("Sign in as");
  });
});

describe("/health's top-level status", () => {
  test("degraded whenever any capability is missing, ok only when none is", () => {
    // Every one-variable-short deployment, because `status` is the field
    // anybody actually reads and the one that said `ok` on a cg-web that could
    // not make a tool call.
    for (const absent of Object.keys(COMPLETE)) {
      const partial = Object.fromEntries(
        Object.entries(COMPLETE).filter(([key]) => key !== absent),
      ) as Record<string, string>;
      const readiness = deploymentReadiness(readIdentitySurface(partial));
      expect(readiness.status).toBe("degraded");
      // And it is never `degraded` with both capabilities configured: the two
      // halves of the claim have to agree.
      expect([readiness.signin, readiness.verifier]).toContain(
        "missing",
      );
    }

    expect(deploymentReadiness(readIdentitySurface(COMPLETE)).status).toBe("ok");
  });
});

describe("the banner asks nothing of the agent", () => {
  test("a complete app environment with no model key is ok", () => {
    // The assistant is the Deep Agent in `agent/`, with its own environment.
    // The app runs no model, so a missing ANTHROPIC_API_KEY is not its problem.
    expect(COMPLETE).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(deploymentReadiness(readIdentitySurface(COMPLETE)).status).toBe("ok");
    expect(banner(COMPLETE)).toBe("");
  });
});
