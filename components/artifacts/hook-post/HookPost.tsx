/* Forked from arcade-outreach-library · hook-post @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
import { useId } from 'react';
import { P } from '../lib/palette';
import { RAY } from '../lib/people';
import { useTimeline } from '../lib/useTimeline';
import { HookArtifact, HOOK_BEATS, type Line } from '../lib/hooks';
import type { ArtifactProps } from '../lib/types';

/* ============================================================
   HookPost — the call was fine. The answer was not.

   Deliberately NOT a card number: Stripe never returns a full
   PAN, only last4, so a masked-card demo would be a lie anyone
   who has touched the API would spot. A Customer object carries
   real PII though - email, phone, address - and that is what
   the hook rewrites.

   This is the only place the rewrite can happen. Once it is in
   the context window it is in the trace, the logs, and whatever
   the model says next.
   ============================================================ */

const AGENT_OUT: Line = [
  { t: '→  ', c: P.faint },
  { t: '{ "method": "tools/call", ', c: P.muted },
  { t: '"name": "Stripe_ListCustomers"', c: P.ink, b: true },
  { t: ' }', c: P.muted },
];

const AGENT_BACK: Line = [
  { t: '←  content  ·  ', c: P.faint },
  { t: 'email and phone redacted', c: P.rewrite, b: true },
];

const REQUEST: Line[] = [
  [{ t: '{ ', c: P.faint }, { t: '"execution_id"', c: P.muted }, { t: ': "exec_9a03b7",', c: P.faint }],
  [{ t: '  "tool"', c: P.muted }, { t: ': { "name": ', c: P.faint }, { t: '"ListCustomers"', c: P.ink }, { t: ' }, ', c: P.faint }, { t: '"success"', c: P.muted }, { t: ': ', c: P.faint }, { t: 'true', c: P.allow }, { t: ',', c: P.faint }],
  [{ t: '  "output"', c: P.muted }, { t: ': { ', c: P.faint }, { t: '"email"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"j.reyes@northwind.com"', c: P.deny, b: true }, { t: ',', c: P.faint }],
  [{ t: '              "phone"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"+1 415 555 0134"', c: P.deny, b: true }, { t: ' } }', c: P.faint }],
];

const RESPONSE: Line[] = [
  [{ t: '{ ', c: P.faint }, { t: '"code"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"OK"', c: P.allow }, { t: ', ', c: P.faint }, { t: '"override"', c: P.rewrite, b: true }, { t: ': {', c: P.faint }],
  [{ t: '    "output"', c: P.muted }, { t: ': { ', c: P.faint }, { t: '"email"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"‹redacted›"', c: P.rewrite, b: true }, { t: ',', c: P.faint }],
  [{ t: '                "phone"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"‹redacted›"', c: P.rewrite, b: true }, { t: ' } } }', c: P.faint }],
];

export function HookPost(props: ArtifactProps) {
  const uid = useId().replace(/:/g, '');
  const t = useTimeline(props, { duration: HOOK_BEATS.duration, poster: HOOK_BEATS.poster });

  return (
    <HookArtifact
      props={props}
      t={t}
      uid={uid}
      title="The post-execution hook redacts customer PII before the model sees it"
      desc="An agent calls tools/call for Stripe_ListCustomers. The call passes policy and runs, and Stripe returns a customer email and phone number. The post-execution hook answers OK but with an override that replaces both fields, so the agent receives the redacted version."
      point="post-execution"
      context="after it returns"
      person={RAY.name}
      role={RAY.role}
      roleNote="allowed, ran, and the answer is the problem"
      agentOut={AGENT_OUT}
      agentBack={AGENT_BACK}
      requestMeta="POST /post"
      requestLines={REQUEST}
      requestGloss={[
        "The tool already ran. This is what it wants",
        "to hand to the model.",
      ]}
      responseMeta="200 OK  ·  output overridden"
      responseLines={RESPONSE}
      responseGloss={[
        "Same shape, two fields replaced. The agent",
        "never sees the originals.",
      ]}
      verdict={P.rewrite}
      consequence="The model gets the record. Not the person."
    />
  );
}
