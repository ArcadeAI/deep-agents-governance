"use client";
/**
 * The four acts, as five of the outreach library's artifacts with one line
 * each. Forked with the library's `fork-artifact` skill; the provenance header
 * on every file under `components/artifacts/` names the commit.
 *
 * The artifacts argue the mechanism — Stripe refunds, customer PII — and the
 * captions say what the same mechanism does to the loan desk. Relabelling the
 * artifacts themselves is legitimate (a fork is a detached copy) and is left
 * for whoever presents; the mechanism is the point on stage.
 *
 * Brand tokens are the library's, written as literals because this page loads
 * no CSS of the library's: `bg` black, `ink` for the one heading line, `body`
 * and `muted` for copy, `arcade` chartreuse for the kicker. Serif for the one
 * large line, per the brand skill.
 */
import { ToolCallLifecycle } from "../../components/artifacts/tool-call-lifecycle/ToolCallLifecycle";
import { HookAccess } from "../../components/artifacts/hook-access/HookAccess";
import { HookPre } from "../../components/artifacts/hook-pre/HookPre";
import { HookPost } from "../../components/artifacts/hook-post/HookPost";
import { ExecutionRecord } from "../../components/artifacts/execution-record/ExecutionRecord";

const T = {
  bg: "#000000",
  ink: "#F2F2F2",
  body: "#DCDCDC",
  muted: "#B8B8B8",
  arcade: "#C3FF02",
  line: "rgba(255,255,255,0.16)",
  sans: '-apple-system, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: '"GT Sectra Display", Georgia, "Times New Roman", serif',
  mono: '"GT Cinetype Mono", ui-monospace, Menlo, Consolas, monospace',
} as const;

const ACTS: Array<{ kicker: string; line: string; Artifact: (p: { background?: string }) => React.JSX.Element }> = [
  {
    kicker: "Every call, one road",
    line: "Alice asks for a $95K loan. Her agent's call passes identity, then policy, then runs holding the credential, then is written down.",
    Artifact: ToolCallLifecycle,
  },
  {
    kicker: "Act 1 · access",
    line: "Bob, a credit analyst, never sees LoanDesk_ApproveLoan. It is not refused; it is not offered.",
    Artifact: HookAccess,
  },
  {
    kicker: "Act 2 · pre-execution",
    line: "$95K is over Alice's $50K. The refusal names the escalation tool, Charlie approves in Slack, and her retry passes on a single-use grant.",
    Artifact: HookPre,
  },
  {
    kicker: "Acts 3 and 4 · post-execution",
    line: "LN-2291 comes back with the billing identifiers masked and the pasted instruction gone, whether it was read from the loan book or from the index.",
    Artifact: HookPost,
  },
  {
    kicker: "Written down",
    line: "Who, which tool, which rule, what happened. The reference on the denial the model read is this row.",
    Artifact: ExecutionRecord,
  },
];

export default function Walkthrough() {
  return (
    <main style={{ background: T.bg, color: T.body, fontFamily: T.sans, minHeight: "100vh", padding: "56px 24px 96px" }}>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        <p style={{ color: T.arcade, fontFamily: T.mono, fontSize: 12, letterSpacing: 2, textTransform: "uppercase", margin: 0 }}>MCP4GTM · 10/8 · SF Tech Week</p>
        <h1 style={{ color: T.ink, fontFamily: T.serif, fontWeight: 400, fontSize: 44, lineHeight: 1.1, margin: "12px 0 0", maxWidth: 820 }}>
          Treat the model as an adversary. Put the controls where it cannot reason around them.
        </h1>
        {ACTS.map(({ kicker, line, Artifact }) => (
          <section key={kicker} style={{ borderTop: `1px solid ${T.line}`, marginTop: 56, paddingTop: 28 }}>
            <p style={{ color: T.arcade, fontFamily: T.mono, fontSize: 12, letterSpacing: 2, textTransform: "uppercase", margin: 0 }}>{kicker}</p>
            <p style={{ color: T.body, fontSize: 18, lineHeight: 1.5, margin: "10px 0 22px", maxWidth: 760 }}>{line}</p>
            <Artifact background="transparent" />
          </section>
        ))}
        <p style={{ color: T.muted, fontSize: 13, marginTop: 64 }}>
          Diagrams from Arcade&rsquo;s outreach library, forked at 1d4d7a7. They show the mechanism on a Stripe refund; the loan desk runs the same road.
        </p>
      </div>
    </main>
  );
}
