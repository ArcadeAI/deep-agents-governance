/**
 * `/` — the bank's loan desk, full-screen.
 *
 * **No split view (#155, reversing #22).** Until the 2026-09-18 rehearsal this
 * page was two halves: the bank on the left, the control plane on the right.
 * Every action on the left moved the right at the same moment, so the audience
 * watched two surfaces animate while the presenter explained a third. The
 * control plane now lives on its own full-screen page at `/panel`, and the
 * presenter switches between the two deliberately. `DESIGN.md` → Decisions →
 * Design.
 *
 * What went with the split: the `correlationKey` join. #6's token still rides
 * in every denial's text and the panel still outlines what it is given — but
 * nothing on this page hands it one, because the card and the sentence are no
 * longer on the same screen. It is not reconstructed across tabs.
 *
 * A **server** component, and it does two things a client one could not:
 *
 * 1. It unseals the session here, so the tokens in the cookie never reach the
 *    browser. `SessionChrome` is rendered on this side of the
 *    boundary and handed down as an element, so only what it prints crosses.
 *    Since #176 that element is the session controls in the bank's top chrome
 *    — `Sign out` or `Sign in` — rather than a
 *    card of four "Sign in as …" persona buttons below the loan files. One
 *    Chrome profile per persona is the real demo shape, so a switcher read as
 *    the most demo-looking thing on a screen arguing that nothing here is a
 *    mock.
 * 2. It reads the loan book, not through Arcade: `readLoanBook` calls the
 *    loan module in-process with this browser's IdP bearer, so the first paint
 *    is already correct and the cards poll `GET /api/loans` from then on.
 *    `lib/loan-context/loans.ts` has the argument. Loading `/` makes no Arcade
 *    call and no governed tool call: every MCP call in the demo starts in the
 *    agent, which is what keeps the panel legible.
 *
 * The assistant is not on this page. It is the Deep Agent in `agent/`, on
 * Managed Deep Agents; the bank pane says where to open it, and links there
 * when `AGENT_URL` names a deployment.
 */
import type { CSSProperties } from "react";
import { cookies, headers } from "next/headers";

import { configurationProblems, readIdentitySurface } from "../lib/config.ts";
import { originMismatch } from "../lib/origin.ts";
import { readSessionFromCookies } from "../auth/session.ts";
import { readLoanBook } from "../lib/loan-context/read.ts";
import { ConfigurationBanner } from "../components/identity/ConfigurationBanner.tsx";
import { OriginBanner } from "../components/identity/OriginBanner.tsx";
import { SessionChrome } from "../components/identity/SessionChrome.tsx";
import { BankPane } from "../components/bank/BankPane.tsx";

/**
 * Dynamic, because it reads a session cookie and the environment. Saying so
 * explicitly rather than relying on `cookies()` to infer it keeps `next build`
 * from evaluating this component at all — a prerender of a page about who is
 * signed in is either wrong or empty, and it runs under `NODE_ENV=production`
 * with none of the deployment's environment.
 */
export const dynamic = "force-dynamic";

/**
 * The presenter's way across, and the only mention of the other surface on this
 * page (#155). Deliberately small, in the corner, and styled inline rather than
 * with a class: `components/bank/bank.css` owns the bank's chrome and this is
 * not part of it, and a `cg-` class here would put the panel's namespace on a
 * page that must not carry one.
 */
const PANEL_LINK: CSSProperties = {
  position: "fixed",
  right: "0.5rem",
  bottom: "0.4rem",
  zIndex: 1,
  font: "inherit",
  fontSize: "0.7rem",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#6d6a62",
  textDecoration: "none",
  opacity: 0.75,
};

export default async function Home() {
  const jar = await cookies();
  const config = readIdentitySurface();
  const session = await readSessionFromCookies(
    new Map(jar.getAll().map((cookie) => [cookie.name, cookie.value])),
    config,
  );
  // No session means no network call: both of these answer without asking.
  const loans = await readLoanBook(session);

  const problems = configurationProblems(config);
  const mismatch = originMismatch(await headers());

  return (
    <>
      {/* In front of the application rather than inside it (#176). `.bank` is
          `100dvh`, so a banner here is the first thing on the page and pushes
          the whole screen down — which is the point: it appears only on a
          deployment that cannot do what it claims, and #84 round 2 found that
          one renders a perfectly normal page and fails at the point of use. It
          used to ride in on the sign-in panel; the panel is gone and it is
          not. */}
      {/* #9: the one host this app's sessions live on, when the browser is
          on another. Before the configuration banner, because on the wrong
          host nothing below it is true. */}
      <OriginBanner mismatch={mismatch} />
      <ConfigurationBanner problems={problems} />
      <BankPane
        signedInAs={session?.email ?? null}
        identity={<SessionChrome session={session} problems={problems} />}
        loans={loans}
        agentUrl={process.env.AGENT_URL?.trim() || null}
      />
      <a href="/panel" style={PANEL_LINK}>
        Control plane ↗
      </a>
    </>
  );
}
