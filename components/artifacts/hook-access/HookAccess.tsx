/* Forked from arcade-outreach-library · hook-access @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
import { useId } from 'react';
import { P } from '../lib/palette';
import { DANA } from '../lib/people';
import { useTimeline } from '../lib/useTimeline';
import { HookArtifact, HOOK_BEATS, type Line } from '../lib/hooks';
import type { ArtifactProps } from '../lib/types';

/* ============================================================
   HookAccess — Dana asks for tools and gets a shorter list.

   It starts with tools/list, because that is the part of this
   picture a general audience already recognises. Arcade calling
   your hook is plumbing underneath it.

   Nothing is blocked here. The tool simply is not in the
   catalogue she is handed, which beats a refusal: a tool the
   model never sees is a tool it cannot be talked into calling.
   ============================================================ */

const AGENT_OUT: Line = [
  { t: '→  ', c: P.faint },
  { t: '{ "jsonrpc": "2.0", "id": 1, ', c: P.muted },
  { t: '"method": "tools/list"', c: P.ink, b: true },
  { t: ' }', c: P.muted },
];

const AGENT_BACK: Line = [
  { t: '←  result.tools  ', c: P.faint },
  { t: '12 of 15', c: P.deny, b: true },
];

const REQUEST: Line[] = [
  [{ t: '{ ', c: P.faint }, { t: '"user_id"', c: P.muted }, { t: ': ', c: P.faint }, { t: '"dana@acme.com"', c: P.ink, b: true }, { t: ',', c: P.faint }],
  [{ t: '  "toolkits"', c: P.muted }, { t: ': {', c: P.faint }],
  [{ t: '    "Stripe"', c: P.muted }, { t: ': { ', c: P.faint }, { t: '"tools"', c: P.muted }, { t: ': { … } }', c: P.faint }],
  [{ t: '} }', c: P.faint }],
];

const RESPONSE: Line[] = [
  [{ t: '{ ', c: P.faint }, { t: '"deny"', c: P.deny, b: true }, { t: ': { ', c: P.faint }, { t: '"Stripe"', c: P.muted }, { t: ': { ', c: P.faint }, { t: '"tools"', c: P.muted }, { t: ': {', c: P.faint }],
  [{ t: '    "CreateRefund"', c: P.deny }, { t: ': [], ', c: P.faint }, { t: '"CreateInvoice"', c: P.deny }, { t: ': [],', c: P.faint }],
  [{ t: '    "CreatePaymentLink"', c: P.deny }, { t: ': [] } } } }', c: P.faint }],
];

export function HookAccess(props: ArtifactProps) {
  const uid = useId().replace(/:/g, '');
  const t = useTimeline(props, { duration: HOOK_BEATS.duration, poster: HOOK_BEATS.poster });

  return (
    <HookArtifact
      props={props}
      t={t}
      uid={uid}
      title="The access hook decides which tools a user can see"
      desc="An agent calls tools/list. Before answering, Arcade posts the catalogue and the caller's user id to the access hook. The hook returns a deny list covering the three money-moving tools, so the agent's tool list comes back with twelve of the fifteen Stripe tools and the refund tool is not among them."
      point="access"
      context="when tools are listed"
      person={DANA.name}
      role={DANA.role}
      roleNote={DANA.note}
      agentOut={AGENT_OUT}
      agentBack={AGENT_BACK}
      requestMeta="POST /access  ·  15 offered"
      requestLines={REQUEST}
      requestGloss={[
        "Arcade hands your server the caller and every",
        "tool it was about to put in front of them.",
      ]}
      responseMeta="200 OK  ·  3 denied"
      responseLines={RESPONSE}
      responseGloss={[
        "Your rule: contractors do not get the tools",
        "that move money.",
      ]}
      verdict={P.deny}
      consequence="To Dana, the refund tool does not exist."
    />
  );
}
