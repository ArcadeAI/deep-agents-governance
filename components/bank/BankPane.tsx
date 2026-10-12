"use client";

/**
 * The bank's loan desk, and since #155 the whole of `/`.
 *
 * Deliberately dull. Square corners, hairline rules, uppercase field labels, a
 * navy chrome bar, a tab strip, and a release number nobody has bumped since
 * 2009. The argument this screen is making is that
 * *this* — a fifteen-year-old system of record with a real loan book behind it —
 * is what agents are being connected to, and a beautiful version quietly undoes
 * it: it makes the governed system look like part of the same product as the
 * thing governing it. #22's issue comment says so in as many words: resist
 * making it pretty.
 *
 * ## Full-screen, with nothing beside it
 *
 * #22 put this pane in the left half of a split screen with Arcade's control
 * plane in the right. #155 removed the split: the control plane is full-screen
 * at `/panel` and the presenter switches to it. Nothing here knows that page
 * exists — no governance pane, no timeline subscription, no `cg-` class — and
 * the one link across is drawn by `app/page.tsx`, outside this component, for
 * exactly that reason. #176 left it there deliberately: the loan board is the
 * bank's own second screen and belongs in this strip, the control plane is not
 * and does not.
 *
 * ## What is real here
 *
 * Everything, and since #176 that includes the chrome. The loan cards are read
 * from the loan module — the bank's own API, in-process since #5, as the
 * signed-in person, and polled (#157) — the session controls in the top chrome are #82's
 * real OIDC sign-in against `apps/idp`, and the two tabs both navigate. The
 * assistant is not on this screen: it is the Deep Agent in `agent/`, and the
 * assistant column says where to open it. Nothing on this screen is a mock.
 *
 * What #176 removed was the last of the furniture that was: four "Sign in as …"
 * persona buttons in a card below the loan files, and four tabs that were
 * `<span>`s because there was nothing behind them. The old comment defended the
 * dead tabs — *"a tab that navigates nowhere is worse on a projector than one
 * that plainly cannot be pressed"* — and the human's answer, looking at the
 * screen on 2026-09-19, was that five tabs where none navigate is worse still.
 *
 * ## The fork seam
 *
 * A developer forking this template keeps the control plane entirely and
 * replaces this. That is only true if the bank's styling is somewhere they can
 * delete: it is `components/bank/bank.css`, nothing under `components/bank`
 * imports anything from `components/governance`, and no `cg-` class name
 * appears on this screen. `app-test/home-screen.test.tsx` fails if any of that
 * stops holding.
 *
 * The session controls arrive as an element for the same reason they always
 * did: they are `components/identity`'s, they know about the session, and this
 * component may not. Moving them from a card in the records column into the
 * chrome bar did not change which side of the seam they are on.
 *
 * ## Who holds the loan book
 *
 * This component, since #176, rather than `LoanFilesView`. One poll
 * (`use-loan-book.ts`) feeding three surfaces, because two of them have to
 * agree with each other: when the read comes back `expired`, the chrome may not
 * go on saying the session is good while the loan book says the bank refused
 * it. The human's screenshot on 2026-09-19 had both claims on screen at once.
 * A second poll would have let them drift apart again on the very next tick.
 *
 * ## `data-hydrated`
 *
 * The one thing this screen says about itself: whether it is live in a browser
 * yet. The page is server-rendered, so its HTML exists and is inert before
 * React reaches it, and nothing
 * else on the page distinguishes the two states.
 *
 * It is a plain attribute, set once on mount and never read by this code. No
 * style, no behaviour and no branch depends on it; removing it changes what
 * this screen does not at all. What it gives anything driving a real browser is
 * a stable answer to *"can I click yet?"* — a parent's mount effect runs after
 * its children have committed, so this attribute appearing means the loan
 * cards beneath it are hydrated, with their handlers
 * attached. #152 added it because the alternative was reading React's private
 * DOM bookkeeping, which is a promise React never made.
 *
 * It lived on `.cg-split` until #155 deleted that shell. This is the same
 * marker on the component that inherited the job: `BankPane` is now the
 * outermost thing on `/` with a DOM element of its own, and since #157 retired
 * the loan cards' Continue button it is the outermost thing full stop — the
 * `HomeRefreshBoundary` that used to wrap it existed only for that button. So
 * its mount effect is still the last one to run over everything this page's
 * tests drive, and it is now also the signal that the cards have started
 * polling.
 */
import { useEffect, useState, type ReactNode } from "react";

import { LoanFilesView, SIGN_IN } from "./LoanFiles.tsx";
import type { LoanBookState } from "../../lib/loan-context/loans.ts";
import { useLoanBook } from "./use-loan-book.ts";
import "./bank.css";

/**
 * The tab strip: two entries, both real.
 *
 * `Applications` is this page and carries `aria-current="page"`; the board is
 * `/loans`, the bank's own full-screen decision board on the presenter's second
 * display. Both are links — the current one to `/`, so the strip behaves the
 * way a strip does and a reader is never guessing which of two shapes means
 * what.
 *
 * The control plane is deliberately not in here. It is not one of the bank's
 * screens, `components/bank` may not name it, and `app/page.tsx` draws its link
 * from outside this component (#155, reaffirmed by the human at the #176 gate).
 */
const TABS: ReadonlyArray<{ label: string; href: string; current?: true }> = [
  { label: "Requests", href: "/", current: true },
  { label: "Decision board", href: "/loans" },
] as const;

export interface BankPaneProps {
  /** The persona this browser is signed in as, or `null`. Read from the sealed session. */
  signedInAs: string | null;
  /**
   * #82's session controls, rendered on the server and handed down as an
   * element: `Sign out` or `Sign in`.
   *
   * An element rather than a `Session`, so the sealed cookie is unsealed in the
   * server component that owns it and only what it prints crosses to the
   * browser. There is still no client-side control here that changes a
   * `user_id`: signing in is an OIDC authorization against `apps/idp` and the
   * person who comes back is whoever typed a password there.
   */
  identity: ReactNode;
  /**
   * The loan book as the server read it for this request.
   *
   * Data rather than an element, and required rather than optional: a screen
   * that silently drew no applications would look exactly like a loan book with
   * nothing in it. This is the **first paint**; this component polls
   * `GET /api/loans` from there (#157) and hands the answer to everything that
   * needs it.
   */
  loans: LoanBookState;
  /**
   * Where the assistant lives. The agent is the Deep Agent in `agent/`, on
   * Managed Deep Agents, not a chat on this page: this pane says where to open
   * it, and links there when `AGENT_URL` names a deployment.
   */
  agentUrl?: string | null;
  /**
   * How to connect an MCP client, when the deployment has a gateway
   * (`setup-arcade --gateway`): `components/identity/McpClientPanel.tsx`,
   * rendered by the page and handed down as an element, like `identity`, so
   * this pane knows nothing about gateways. `null` draws nothing.
   */
  mcpClient?: ReactNode;
}

export function BankPane({
  signedInAs,
  identity,
  loans,
  agentUrl = null,
  mcpClient = null,
}: BankPaneProps) {
  // Inert, and deliberately so: nothing here reads it. See the note above.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const book = useLoanBook(loans);

  /**
   * The bank has an intact session cookie and will not accept it.
   *
   * `expired` is `lib/loan-context/read.ts`'s name for a real 401 from
   * the loan module on this browser's own IdP bearer. It is **not** a policy
   * decision — no hook runs on this path — so nothing keyed on it may reach for
   * the control plane's words. What it is is a sign-in to do again, and the
   * reason the whole screen has to know is #176's third complaint: the cookie
   * is intact, so `signedInAs` is perfectly true, and a chrome bar reading
   * `SIGNED IN AS bob@…` in 30px navy while the loan book underneath says the
   * bank just refused that person is the screen contradicting itself in favour
   * of the half the audience reads first.
   */
  const stale = book.status === "expired";

  return (
    <div className="bank" data-hydrated={hydrated ? "true" : undefined}>
      <header className="bank-chrome">
        <p className="bank-chrome-name">Loan Desk</p>
        <span className="bank-chrome-division">Commercial Lending Division</span>
        <span className="bank-chrome-release">Rel. 7.2.1</span>
      </header>

      <nav className="bank-tabs" aria-label="Sections">
        {TABS.map((tab) => (
          <a
            key={tab.label}
            className="bank-tab"
            href={tab.href}
            {...(tab.current ? { "aria-current": "page" as const } : {})}
          >
            {tab.label}
          </a>
        ))}
      </nav>

      {/* The one line the back of the room has to be able to read: who the
          system thinks is using it, and — since #176 — whether it still thinks
          so. Every tool call this screen makes is made as this person, so when
          the control plane on the other page shows a refusal the first question
          — refused for whom — is already answered here, where the call was
          made.

          Beside it, the session controls: the one button that changes who
          this browser is. */}
      <div className="bank-user" data-session={stale ? "stale" : signedInAs === null ? "none" : "active"}>
        <span className="bank-user-label">{stale ? "Sign-in stale" : "Signed in as"}</span>
        <span className="bank-user-value" data-signed-in={signedInAs !== null} data-stale={stale || undefined}>
          {signedInAs ?? "no user"}
        </span>

        {stale ? (
          // Careful about every word. `expiredFor` in `lib/loan-context/read.ts`
          // says "Nothing was refused by policy" and that distinction is
          // load-bearing for the demo: a stale bearer that looked like
          // governance working would be this project arguing against itself on
          // its own screen.
          <span className="bank-user-note" role="status">
            The loan system is not accepting this browser&rsquo;s sign-in. Nothing was refused by
            policy — <a href={SIGN_IN.href}>sign in again</a> to keep working.
          </span>
        ) : null}

        <div className="bank-user-session">{identity}</div>
      </div>

      {/* Two columns: the loan files, and where the assistant lives. The
          assistant used to be a chat in the second column; it is now the Deep
          Agent in `agent/`, so the column says where to open it and makes no
          claim about this browser's session, which the agent does not use. */}
      <div className="bank-body">
        <div className="bank-column bank-column-records">
          <LoanFilesView state={book} />
        </div>

        <div className="bank-column bank-column-assistant">
          <section className="bank-panel bank-assistant" aria-label="Assistant">
            <h2 className="bank-panel-title">Assistant</h2>
            <div className="bank-panel-body">
              <p>
                The assistant is the Deep Agent in <code>agent/</code>, running on Managed Deep
                Agents. You ask it from a terminal with <code>ask.py</code>, which signs you in
                here first, and it works this loan book as you.
              </p>
              {agentUrl ? (
                <p>
                  <a href={agentUrl}>Open the assistant ↗</a>
                </p>
              ) : (
                <p>
                  Start it with <code>cd agent &amp;&amp; uv run mda dev .</code>, then ask it with{" "}
                  <code>uv run --env-file .env python ask.py &quot;Which loan applications are pending?&quot;</code>.
                </p>
              )}
              {mcpClient}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
