/* Forked from arcade-outreach-library · hook-pre @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
import { useId } from 'react';
import { P } from '../lib/palette';
import { RAY } from '../lib/people';
import { useTimeline } from '../lib/useTimeline';
import { HookArtifact, HOOK_BEATS, type Line } from '../lib/hooks';
import type { ArtifactProps } from '../lib/types';

/* ============================================================
   HookPre — Ray is allowed to refund. Not for $2,400.

   Every scope checks out and the OAuth token is valid. The
   amount is the problem, and no scope string has ever been able
   to say "under five hundred dollars".

   Stripe counts in minor units, so 240000 is $2,400. Worth
   saying out loud on the slide; someone always asks.
   ============================================================ */

const AGENT_OUT: Line = [
  { t: '→  ', c: P.faint },
  { t: '{ "method": "tools/call", ', c: P.muted },
  { t: '"name": "Stripe_CreateRefund"', c: P.ink, b: true },
  { t: ' }', c: P.muted },
];

const AGENT_BACK: Line = [
  { t: '←  ', c: P.faint },
  { t: '"isError": true', c: P.deny, b: true },
  { t: '  ·  over the $500 refund cap', c: P.muted },
];

const REQUEST: Line[] = [
  [{ t: '{ ', c: P.faint }, { t: '"execution_id"', c: P.muted }, { t: ': "exec_8f21c4",', c: P.faint }],
  [{ t: '  "tool"', c: P.muted }, { t: ': { ', c: P.faint }, { t: '"toolkit"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"Stripe"', c: P.ink }, { t: ', ', c: P.faint }, { t: '"name"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"CreateRefund"', c: P.ink, b: true }, { t: ' },', c: P.faint }],
  [{ t: '  "inputs"', c: P.muted }, { t: ': { "payment_intent_id": "pi_3Qx…",', c: P.faint }],
  [{ t: '              "amount"', c: P.muted }, { t: ': ', c: P.faint }, { t: '240000', c: P.deny, b: true }, { t: ' },', c: P.faint }],
  [{ t: '  "context"', c: P.muted }, { t: ': { "user_id": ', c: P.faint }, { t: '"ray@acme.com"', c: P.ink }, { t: ' } }', c: P.faint }],
];

const RESPONSE: Line[] = [
  [{ t: '{ ', c: P.faint }, { t: '"code"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"CHECK_FAILED"', c: P.deny, b: true }, { t: ',', c: P.faint }],
  [{ t: '  "error_message"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"over the $500 refund cap"', c: P.ink }, { t: ' }', c: P.faint }],
];

export function HookPre(props: ArtifactProps) {
  const uid = useId().replace(/:/g, '');
  const t = useTimeline(props, { duration: HOOK_BEATS.duration, poster: HOOK_BEATS.poster });

  return (
    <HookArtifact
      props={props}
      t={t}
      uid={uid}
      title="The pre-execution hook blocks a refund that is over the cap"
      desc="An agent calls tools/call for Stripe_CreateRefund. Before running anything, Arcade posts the tool, its inputs and the calling user to the pre-execution hook. The amount is 240000 minor units, or 2400 dollars, against a 500 dollar cap, so the hook answers CHECK_FAILED with a reason and the tool never runs."
      point="pre-execution"
      context="before the call runs"
      person={RAY.name}
      role={RAY.role}
      roleNote={RAY.note}
      agentOut={AGENT_OUT}
      agentBack={AGENT_BACK}
      requestMeta="POST /pre"
      requestLines={REQUEST}
      requestGloss={[
        "The tool, the arguments and the person,",
        "handed over before anything is executed.",
      ]}
      responseMeta="200 OK  ·  CHECK_FAILED"
      responseLines={RESPONSE}
      responseGloss={[
        "Not a 500. A sentence the agent can read",
        "and repeat back to Ray.",
      ]}
      verdict={P.deny}
      consequence="The call never runs. The agent gets a reason, not a 500."
    />
  );
}
