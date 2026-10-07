/* Forked from arcade-outreach-library · execution-record @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
import { useId } from 'react';
import { ArtifactSvg } from '../lib/Artifact';
import { P, FONT, alpha } from '../lib/palette';
import { useBeats } from '../lib/useBeats';
import type { ArtifactProps, Beat } from '../lib/types';
import { seg, easeOut, clamp01 } from '../lib/motion';

/* ============================================================
   ExecutionRecord — Arcade already wrote it down.

   Three of the four audit requirements fall out of one row that
   nobody wrote any code to produce. The 3-then-1 split with the
   audit log on slide 6 is what makes "four requirements, you
   wrote no code" land, so the split is drawn rather than implied:
   the right-hand panel is slide 3's checklist, and it empties as
   the fields arrive. Requirement 04 stays deliberately unticked
   with "next slide" under it — the one honest cliffhanger in the
   deck. Its label must match slide 3's card 04; they are the same
   requirement seen twice.

   An earlier version was a bare field list on the left two
   thirds of the canvas, with the tick column floating in dead
   space. It read as a code block rather than a diagram. If this
   ever gets simplified back to a list, shrink the canvas too or
   the same 300px hole comes back.

   FIELDS ARE VERIFIED against schemas.ToolExecutionDetailResponse
   and schemas.ToolExecutionAttemptResponse in
   api.arcade.dev/v1/swagger. The schema carries exactly:
     id, user_id, tool_name, toolkit_name, toolkit_version,
     execution_status, execution_type, input, run_at,
     created_at, started_at, finished_at, updated_at,
     attempts[] { id, success, output, started_at, finished_at,
                  system_error_message }

   There is NO `authorization` field. An earlier draft invented
   one so it could tick a requirement that no longer exists. Do
   not add it back.

   `execution_status` is omitted deliberately: the field is real
   but its string values are unverified, and a made-up enum value
   is exactly the kind of thing that gets caught live.
   ============================================================ */

const W = 1400, H = 560;

/* Fixed columns. The tick especially: derive it from the value string and every
   tick lands on a different x, which reads as sloppiness rather than a list. */
const COL = {
  key: 44,
  val: 254,
  sub: 436,
  tick: 726,
} as const;

const ROW_H = 30;
const ROW_TOP = 158;

/** The requirements panel — slide 3's four cards, compressed into a rail. */
const PANEL = { x: 812, y: 128, w: 544, h: 306 };
const PANEL_ROW_TOP = 200;
const PANEL_ROW_H = 62;

const REQUEST = [
  'GET /v1/orgs/{org}/projects/{project}/tool_executions/exec_9f2c1a',
  '    ?include_inputs=true&include_outputs=true',
];

interface Row {
  /** field name, left column — chartreuse, because Arcade wrote it */
  key?: string;
  /** the value, or the first half of a two-part value */
  val?: string;
  /** second column of a nested value, e.g. `payment_intent  pi_3Rb•••` */
  sub?: string;
  /** index into REQS — ticks that requirement as this row lands */
  ticks?: number;
}

const ROWS: Row[] = [
  { key: 'user_id',         val: 'ray@acme.com',                    ticks: 0 },
  { key: 'tool_name',       val: 'CreateRefund' },
  { key: 'toolkit_name',    val: 'Stripe' },
  { key: 'toolkit_version', val: '1.1.2' },
  { key: 'input',           val: 'payment_intent', sub: 'pi_3Rb•••' },
  {                         val: 'amount',         sub: '240000',    ticks: 1 },
  { key: 'attempts[0]',     val: 'success',        sub: 'true',      ticks: 2 },
  {                         val: 'output',         sub: 're_3Rb7Kc2eZvKYlo2C' },
  { key: 'started_at',      val: '2026-08-27T14:02:10Z' },
  { key: 'finished_at',     val: '2026-08-27T14:02:11Z' },
];

/** When each row lands, and therefore when its requirement ticks. */
const rowAt = (i: number) => 1.9 + i * 0.34;
const TICK_LAG = 0.45;

interface Req {
  n: string;
  name: string;
  /** the field that satisfies it, shown on tick */
  by: string;
}

const REQS: Req[] = [
  { n: '01', name: 'actor',          by: 'user_id' },
  { n: '02', name: 'action',         by: 'tool_name  ·  input' },
  { n: '03', name: 'outcome',        by: 'attempts[0]' },
  { n: '04', name: 'policy',         by: '' },
];

/**
 * One click per beat, contiguous so no click is followed by dead air.
 *
 *   1  the request types out
 *   2  the empty checklist arrives beside it
 *   3  the record lands, ticking three requirements as it goes
 *   4  requirement 04 shows as pending — the cliffhanger into slide 6
 *   5  retention
 */
/**
 * The moments worth stopping on (DESIGN.md section 6a). Every `at` is a
 * settled frame: the transitions bounding it have finished and every label is
 * at full or zero opacity. Verified by capture-and-look at each one.
 */
export const beats: readonly Beat[] = [
  { at: 1.6, label: 'the request' },
  { at: 5.3, label: 'actor, action, outcome' },
  { at: 6.9, label: 'policy is a different log' },
  { at: 8.3, label: 'retained seven days by default' },
];

/*
 * Four beats, not the deck's five.
 *
 * The deck's numbers were step CEILINGS — where a click stops the clock — not
 * settled frames, and section 6a wants the second thing.
 *
 * "The request" is the deck's 1.6 again, but it took a retime to get there.
 * Typing used to finish at exactly 1.5 and the checklist used to start fading
 * at exactly 1.5, so every time in the neighbourhood was either mid-type or
 * mid-fade — 1.6 sat 0.1s into the panel's fade with all four of its labels
 * ghosted, and 1.5 named the instant a transition began, which section 6a
 * forbids for the same reason. The panel now waits until 1.75, which leaves
 * the request finished and alone on screen from 1.5 to 1.75. 1.6 sits in the
 * middle of that hold.
 *
 * The checklist arriving still has no settled frame: it fades 1.75 -> 2.25
 * while the record rows start landing at 1.9 and keep landing every 0.34s
 * until 5.2, so the diagram does not come to rest once between 1.75 and 5.2.
 * Rather than move that beat onto a frame that happens to be clean and call it
 * "the checklist", it is not declared. Recovering it means holding the rows
 * until the panel has settled, which pushes every later beat out by half a
 * second and lengthens the loop — a change to what the artifact does, not to
 * how it is indexed, and not one this slice needs.
 *
 * The last beat is 8.3, not the loop length. `retention` finishes at 7.6 + 0.7
 * = 8.3 and nothing moves after it, so 8.3 is the frame "retained seven days
 * by default" actually names; 8.4 was the wrap point, which is the first frame
 * again or an out-of-range seek depending on the host.
 */

const RULE_Y = ROW_TOP + ROWS.length * ROW_H + 22;

export function ExecutionRecord(props: ArtifactProps) {
  const uid = useId().replace(/:/g, '');
  const t = useBeats(props, { beats });

  /* The request line types rather than fades. It is the only thing on screen
     for the first second, and a fade would leave the frame looking empty. */
  const typed = seg(t, 0.2, 1.3);
  const chars = Math.round(typed * REQUEST.join('\n').length);

  /* 1.75, not 1.5. The request finishes typing at 1.5, and starting the panel
     in the same instant left the first beat with no settled frame to name:
     either mid-type or mid-fade, with the panel's four labels ghosted (section
     6a). The 0.25s hold is the beat. */
  const panel = easeOut(seg(t, 1.75, 0.5));
  const pending = seg(t, 6.0, 0.8);
  const retention = seg(t, 7.6, 0.7);

  /** when requirement `r` ticks — driven off the row that satisfies it */
  const tickTime = (r: number) => {
    const i = ROWS.findIndex((row) => row.ticks === r);
    return i < 0 ? Infinity : rowAt(i) + TICK_LAG;
  };

  return (
    <ArtifactSvg
      uid={uid}
      w={W} h={H}
      title={props.title ?? 'One tool execution record, satisfying three of four audit requirements'}
      desc={props.desc ??
        'A single tool execution record fetched by id. It carries user_id ray@acme.com, tool_name CreateRefund, toolkit Stripe version 1.1.2, the exact input arguments payment_intent and amount 240000, and the attempt with success true and the returned refund id. Beside it, the four audit requirements: actor, action and outcome tick off this row, while the policy question is answered by the audit log instead. Recording is retained for seven days by default and is configurable from one to ninety.'}
      className={props.className}
      style={props.style}
      background={props.background}
    >
      {/* ================= the request ================= */}
      {REQUEST.map((line, i) => {
        const before = REQUEST.slice(0, i).join('\n').length;
        const shown = clamp01((chars - before) / line.length);
        return (
          <text key={line} x={COL.key} y={62 + i * 26} className="a-mono" fontSize={14.5}
            style={{ fill: i === 0 ? P.body : P.faint }}>
            {line.slice(0, Math.round(shown * line.length))}
          </text>
        );
      })}

      {/* ================= the record ================= */}
      {ROWS.map((row, i) => {
        const y = ROW_TOP + i * ROW_H;
        const appear = easeOut(seg(t, rowAt(i), 0.32));
        const tick = row.ticks === undefined
          ? 0
          : easeOut(seg(t, rowAt(i) + TICK_LAG, 0.4));
        return (
          <g key={`${row.key ?? ''}-${row.val ?? ''}-${i}`} opacity={appear}>
            {row.key && (
              <text x={COL.key} y={y} className="a-mono" fontSize={15.5}
                style={{ fill: P.arcade }}>{row.key}</text>
            )}
            {row.val && (
              <text x={COL.val} y={y} className="a-mono" fontSize={15.5}
                style={{ fill: row.key ? P.body : P.muted }}>{row.val}</text>
            )}
            {row.sub && (
              <text x={COL.sub} y={y} className="a-mono" fontSize={15.5}
                style={{ fill: P.body }}>{row.sub}</text>
            )}
            {/* the row's own tick and its requirement light on the same beat —
                that simultaneity is what teaches the mapping */}
            {row.ticks !== undefined && (
              <text x={COL.tick} y={y} className="a-mono" fontSize={18}
                opacity={tick} style={{ fill: P.met }}>✓</text>
            )}
          </g>
        );
      })}

      {/* ================= retention ================= */}
      {/* Red because it is the one thing here that will bite you: the window is
          seven days unless somebody changes it, and the request for August
          always arrives in October. */}
      <g opacity={retention}>
        <line x1={COL.key} y1={RULE_Y} x2={PANEL.x - 40} y2={RULE_Y} stroke={P.lineSoft} />
        <text x={COL.key} y={RULE_Y + 34} className="a-lbl" fontSize={10.5}>retention</text>
        <text x={COL.val} y={RULE_Y + 34} className="a-mono" fontSize={15.5}
          style={{ fill: P.deny }}>7 days by default</text>
        <text x={COL.val + 200} y={RULE_Y + 34} className="a-mono" fontSize={15.5}
          style={{ fill: P.faint }}>·  configurable 1–90</text>
      </g>

      {/* ================= the requirements panel ================= */}
      <g opacity={panel}>
        <rect x={PANEL.x} y={PANEL.y} width={PANEL.w} height={PANEL.h} rx={14}
          fill={alpha(P.white, 0.022)} stroke={P.line} strokeWidth={1.25} />
        <text x={PANEL.x + 28} y={PANEL.y + 38} className="a-lbl b" fontSize={11}
          style={{ fill: P.faint }}>what the audit asked for</text>
      </g>

      {REQS.map((req, i) => {
        const y = PANEL_ROW_TOP + i * PANEL_ROW_H;
        const last = i === REQS.length - 1;
        const lit = last ? pending : easeOut(seg(t, tickTime(i), 0.45));
        return (
          <g key={req.n} opacity={last ? pending : panel}>
            <text x={PANEL.x + 28} y={y} className="a-mono" fontSize={15}
              style={{ fill: lit > 0.5 ? P.met : P.faint }}>{req.n}</text>
            <text x={PANEL.x + 72} y={y} fontFamily={FONT.sans} fontSize={17}
              fontWeight={600} fill={lit > 0.5 ? P.ink : P.faint}>{req.name}</text>

            {/* satisfied: green tick plus the field that did it */}
            {!last && (
              <g opacity={lit}>
                <text x={PANEL.x + PANEL.w - 34} y={y} textAnchor="end"
                  className="a-mono" fontSize={18} style={{ fill: P.met }}>✓</text>
                <text x={PANEL.x + 72} y={y + 22} className="a-mono" fontSize={13}
                  style={{ fill: P.arcade }}>{req.by}</text>
              </g>
            )}

            {/* the cliffhanger. Not red — nothing is wrong, it is just answered
                somewhere else, and slide 6 is where. */}
            {last && (
              <g opacity={pending}>
                <text x={PANEL.x + PANEL.w - 34} y={y} textAnchor="end"
                  className="a-lbl b" fontSize={10.5}
                  style={{ fill: P.scopes }}>next slide</text>
                <text x={PANEL.x + 72} y={y + 22} className="a-mono" fontSize={13}
                  style={{ fill: P.faint }}>a different log</text>
              </g>
            )}

            {i < REQS.length - 1 && (
              <line x1={PANEL.x + 28} y1={y + 38} x2={PANEL.x + PANEL.w - 28} y2={y + 38}
                stroke={P.lineSoft} opacity={panel} />
            )}
          </g>
        );
      })}
    </ArtifactSvg>
  );
}
