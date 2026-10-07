/* Forked from arcade-outreach-library · tool-call-lifecycle @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
import { useEffect, useId, useState } from 'react';
import type { MouseEvent } from 'react';
import { ArtifactSvg, Packet } from '../lib/Artifact';
import { Diamond } from '../lib/hooks';
import { GITHUB, GOOGLE, LINEAR, Mark, SLACK, STRIPE, type Brand } from '../lib/brands';
import { P, FONT, alpha } from '../lib/palette';
import { DANA, PersonBar, RAY, type Person } from '../lib/people';
import { useTimeline } from '../lib/useTimeline';
import type { ArtifactProps, Beat } from '../lib/types';
import { clamp01, easeInOut, seg, n, type Pt } from '../lib/motion';

/* ============================================================
   ToolCallLifecycle — what is behind a tool call.

   Deliberately not a complete architecture. It is the view from
   one tool call, with the harness abstracted away, and it
   assumes every tool is routed through Arcade. Say that once on
   the slide and the simplification stops being a lie.

   Amber is the layer you already have: a grant, and a valid
   token. Violet is where your own code gets to answer. The whole
   argument is the second run, where a call clears every amber
   check and still dies in violet.

   Four things shape the layout:

     1  access, pre and post share one x. They are the three
        places your code answers, so they read as one column
        instead of three decorations on someone else's diagram.
     2  every drawn wire starts and ends on a node EDGE, and long
        returns are routed as right-angled rails rather than
        arcs. Centre-to-centre curves ran under the very boxes
        they connected.
     3  a packet rests on the edge of the node it just reached,
        never over that node's label, and the node lights up to
        say it is the one working. Lighting is measured to the
        shape, not to its centre, so an edge counts as arrival.
     4  RUN hangs off a column of the services a tool actually
        executes against, so "run" is visibly somebody else's API
        and not another box inside Arcade.

   Runs are click-driven, not one long timeline: a click plays
   one run, it holds on its last frame, the next click plays the
   next, and the third wraps round to the first. A `?t=` capture
   still sees one continuous clock — see `locate`.
   ============================================================ */

/* 1400x700 (2:1). The slide carries a headline and nothing else, so the frame
   is squarer than the hook slides and the diagram gets the height back. Measure
   the frame before changing this: too tall and it letterboxes horizontally,
   which costs width everywhere. */
const W = 1400, H = 700;

/* The calling lane reads left to right, then straight down: pre, run, post in
   one vertical column at x=830. That column is the sequence a call goes
   through, so stacking it makes the order literal instead of implied by
   arrowheads. The listing lane above it is deliberately shallow — it is the
   short story, and it should not claim half the height. */
const AGENT = { x: 40, y: 306, w: 170, h: 88 };
const ACTION = { x: 272, y: 316, w: 176, h: 68 };
const AUTH = { x: 510, y: 298, w: 210, h: 104 };
const PRE = { cx: 830, cy: 350, r: 40 };
const RUN = { x: 764, y: 436, w: 132, h: 62 };
const POST = { cx: 830, cy: 584, r: 40 };
const RUN_CY = RUN.y + RUN.h / 2;

const ACCESS = { cx: 900, cy: 124, r: 42 };
const CATALOG = { x: 1060, y: 94, w: 230, h: 60 };
/** where the listing loop comes back along, under the access caption */
const LIST_RAIL = 226;

/** The rail the third-party column hangs off, and the pills on it. */
const BUS_X = 1020;
const PILL = { x: 1060, w: 230, h: 36 };
const PILL_PITCH = 48;
/** third of five, so Stripe sits level with RUN and the call runs straight out */
const STRIPE_ROW = 2;
const PILL_TOP = RUN_CY - STRIPE_ROW * PILL_PITCH;
const pillY = (i: number) => PILL_TOP + i * PILL_PITCH;

const SERVICES: Brand[] = [GOOGLE, SLACK, STRIPE, GITHUB, LINEAR];
const STRIPE_Y = pillY(STRIPE_ROW);

/** Each hook's caption and its verdict badge share one slot; they crossfade. */
const SLOT = { access: 182, pre: 276, post: 640 };
const CAPTION = { access: 188, pre: 282, post: 646 };

/* The identity band, same shape as the one on slides 4 to 6: a face, a name, an
   amber role chip, then what constrains that person. It is the first thing the
   diagram says, because every verdict below it is a verdict about a person. */
const WHO = { x: 18, y: 10, h: 50 };

/* ---------- geometry ---------------------------------------------------- */

/** A wire is a polyline: straight where nodes face each other, right-angled
    where they do not. Nothing is allowed to pass through a node. */
type Route = Pt[];

/** Where a line arriving from `from` meets a diamond's edge. */
function dmAnchor(d: { cx: number; cy: number; r: number }, from: Pt): Pt {
  const dx = d.cx - from.x, dy = d.cy - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const reach = d.r / (Math.abs(ux) + Math.abs(uy));
  return { x: n(d.cx - ux * reach), y: n(d.cy - uy * reach) };
}

const RUN_BOTTOM: Pt = { x: RUN.x + RUN.w / 2, y: RUN.y + RUN.h };

/**
 * Every wire, edge to edge.
 *
 * Both the painted line and the packet use these, so a packet always rests on
 * the boundary of the node it just reached, never over that node's label. The
 * node lighting up is what says "this one is working" — see `litBox` / `litDm`,
 * which measure distance to the shape rather than to its centre, so a packet
 * parked on an edge lights the whole box.
 */
const R = {
  listOut: [{ x: 90, y: AGENT.y }, { x: 90, y: ACCESS.cy }, { x: ACCESS.cx - ACCESS.r, y: ACCESS.cy }],
  listCheck: [{ x: ACCESS.cx + ACCESS.r, y: ACCESS.cy }, { x: CATALOG.x, y: ACCESS.cy }],
  listBack: [
    { x: CATALOG.x + CATALOG.w / 2, y: CATALOG.y + CATALOG.h },
    { x: CATALOG.x + CATALOG.w / 2, y: LIST_RAIL },
    { x: 140, y: LIST_RAIL },
    { x: 140, y: AGENT.y },
  ],
  callOut: [{ x: AGENT.x + AGENT.w, y: 328 }, { x: ACTION.x, y: 328 }],
  toAuth: [{ x: ACTION.x + ACTION.w, y: PRE.cy }, { x: AUTH.x, y: PRE.cy }],
  toPre: [{ x: AUTH.x + AUTH.w, y: PRE.cy }, { x: PRE.cx - PRE.r, y: PRE.cy }],
  toRun: [{ x: PRE.cx, y: PRE.cy + PRE.r }, { x: RUN.x + RUN.w / 2, y: RUN.y }],
  toBus: [{ x: RUN.x + RUN.w, y: RUN_CY }, { x: BUS_X, y: RUN_CY }],
  runToPost: [RUN_BOTTOM, { x: POST.cx, y: POST.cy - POST.r }],
  postBack: [
    { x: POST.cx - POST.r, y: POST.cy },
    { x: ACTION.x + ACTION.w / 2, y: POST.cy },
    { x: ACTION.x + ACTION.w / 2, y: ACTION.y + ACTION.h },
  ],
  toAgent: [{ x: ACTION.x, y: 366 }, { x: AGENT.x + AGENT.w, y: 366 }],
  // not painted: Stripe is level with RUN, so the packet runs straight out along
  // the rail the column already draws
  toStripe: [{ x: RUN.x + RUN.w, y: RUN_CY }, { x: PILL.x, y: STRIPE_Y }],
  fromStripe: [{ x: PILL.x, y: STRIPE_Y }, { x: RUN.x + RUN.w, y: RUN_CY }],
} satisfies Record<string, Route>;

const legLens = (r: Route) => r.slice(1).map((p, i) => Math.hypot(p.x - r[i]!.x, p.y - r[i]!.y));

/** Point at `u` along a polyline, by arc length. */
function pointOn(r: Route, u: number): Pt {
  const lens = legLens(r);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let want = clamp01(u) * total;
  for (let i = 0; i < lens.length; i++) {
    if (want <= lens[i]! || i === lens.length - 1) {
      const k = lens[i]! ? want / lens[i]! : 0;
      return { x: r[i]!.x + (r[i + 1]!.x - r[i]!.x) * k, y: r[i]!.y + (r[i + 1]!.y - r[i]!.y) * k };
    }
    want -= lens[i]!;
  }
  return r[r.length - 1]!;
}

/** Polyline path string with rounded corners. */
function routeD(r: Route, radius = 12): string {
  let d = `M ${r[0]!.x} ${r[0]!.y}`;
  for (let i = 1; i < r.length - 1; i++) {
    const prev = r[i - 1]!, cur = r[i]!, next = r[i + 1]!;
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y) || 1;
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y) || 1;
    const rr = Math.min(radius, d1 / 2, d2 / 2);
    d += ` L ${n(cur.x + ((prev.x - cur.x) / d1) * rr)} ${n(cur.y + ((prev.y - cur.y) / d1) * rr)}`;
    d += ` Q ${cur.x} ${cur.y} ${n(cur.x + ((next.x - cur.x) / d2) * rr)} ${n(cur.y + ((next.y - cur.y) / d2) * rr)}`;
  }
  const last = r[r.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

function head(tip: Pt, from: Pt, color: string) {
  const dx = tip.x - from.x, dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const bx = tip.x - ux * 9, by = tip.y - uy * 9;
  return (
    <path
      d={`M ${n(tip.x)} ${n(tip.y)} L ${n(bx - uy * 4.6)} ${n(by + ux * 4.6)} L ${n(bx + uy * 4.6)} ${n(by - ux * 4.6)} Z`}
      fill={color}
    />
  );
}

const WIRE_INK = alpha(P.white, 0.32);

/**
 * A wire, drawn once. `both` marks the segments traffic uses in both
 * directions; `plain` drops the arrowhead, for a line that ends on a junction
 * rather than on a node.
 */
function Wire({ r, both = false, plain = false }: { r: Route; both?: boolean; plain?: boolean }) {
  return (
    <g>
      <path d={routeD(r)} className="a-wire" strokeDasharray="3 6" />
      {!plain && head(r[r.length - 1]!, r[r.length - 2]!, WIRE_INK)}
      {both && head(r[0]!, r[1]!, WIRE_INK)}
    </g>
  );
}

/** A label sitting on its wire, with the background knocked out behind it. */
function WireLabel({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <text
      x={x} y={y} className="a-lbl" fontSize={10.5} style={{ fill: P.faint }} textAnchor="middle"
      stroke={P.bg} strokeWidth={5} paintOrder="stroke"
    >
      {text}
    </text>
  );
}

/* ---------- the three runs ---------------------------------------------- */

interface Leg { r: Route; rev?: boolean | undefined; t0: number; dur: number }

type BadgeKey = 'access' | 'preDeny' | 'preOk' | 'post' | 'statement';

interface Run {
  /** who is making this call — the amber identity across the top */
  who: Person;
  /** what constrains them for this run, when it is sharper than `who.note` */
  note?: string | undefined;
  /** the MCP call itself, right-aligned opposite the identity */
  call: string;
  accent: string;
  legs: Leg[];
  /** from this leg index on, the packet carries the verdict colour */
  verdictFrom: number;
  verdict: string;
  duration: number;
  poster: number;
  /** [from, to] windows; `HOLD` means it stays up for the rest of the run */
  badges: Partial<Record<BadgeKey, [number, number]>>;
  /** when the amber checks tick, if this run gets that far */
  authFrom?: number;
}

const HOLD = 999;

/** How long a verdict badge takes to arrive, and to leave. `hold` uses both. */
const BADGE_IN = 0.3, BADGE_OUT = 0.35;

/** Lay legs end to end from `start`, resting `gap` seconds between each. */
function chain(start: number, spec: Array<[Route, number, boolean?]>, gap = 0.25): Leg[] {
  let t = start;
  return spec.map(([r, dur, rev]) => {
    const leg = { r, dur, rev, t0: t };
    t += dur + gap;
    return leg;
  });
}

const RUNS: Run[] = [
  {
    who: DANA,
    call: 'tools/list',
    accent: P.yours,
    verdictFrom: 2,
    verdict: P.yours,
    duration: 5.8,
    poster: 5.0,
    badges: { access: [1.9, HOLD] },
    legs: chain(0.5, [
      [R.listOut, 1.2],
      [R.listCheck, 0.5],
      [R.listBack, 1.5],
    ], 0.35),
  },
  {
    who: RAY,
    call: 'Stripe_CreateRefund  amount 240000',
    accent: P.deny,
    verdictFrom: 3,
    verdict: P.deny,
    duration: 8.6,
    poster: 7.6,
    authFrom: 2.2,
    badges: { preDeny: [3.6, HOLD], statement: [6.5, HOLD] },
    legs: [
      ...chain(0.5, [[R.callOut, 0.6], [R.toAuth, 0.55], [R.toPre, 0.5]], 0.4),
      // a denial halts the pipeline, so the error unwinds the way it came in
      ...chain(4.1, [
        [R.toPre, 0.5, true],
        [R.toAuth, 0.55, true],
        [R.toAgent, 0.5],
      ], 0.35),
    ],
  },
  {
    who: RAY,
    note: 'must not see raw customer PII',
    call: 'Stripe_ListCustomers',
    accent: P.rewrite,
    verdictFrom: 7,
    verdict: P.rewrite,
    duration: 11.0,
    poster: 10.2,
    authFrom: 2.0,
    badges: { preOk: [2.75, 4.2], post: [7.9, HOLD] },
    legs: [
      { r: R.callOut, t0: 0.5, dur: 0.6 },
      { r: R.toAuth, t0: 1.35, dur: 0.55 },
      { r: R.toPre, t0: 2.15, dur: 0.5 },
      { r: R.toRun, t0: 3.05, dur: 0.55 },
      { r: R.toStripe, t0: 3.85, dur: 0.75 },
      // 0.9s sitting on Stripe: that is where the work actually happens
      { r: R.fromStripe, t0: 5.5, dur: 0.85 },
      { r: R.runToPost, t0: 6.65, dur: 0.55 },
      { r: R.postBack, t0: 8.0, dur: 0.9 },
      { r: R.toAgent, t0: 9.1, dur: 0.5 },
    ],
  },
];

const SPANS = RUNS.map((r) => r.duration);
/** Full length of all three runs back to back, for `?t=` captures. */
export const LIFECYCLE_TOTAL = SPANS.reduce((a, b) => a + b, 0);

/** The second each run opens on that clock. */
const RUN_AT = SPANS.map((_, i) => SPANS.slice(0, i).reduce((a, b) => a + b, 0));

/**
 * Long enough after a transition for the frame to be at rest, short enough to
 * still read as the same moment.
 */
const REST = 0.2;

/** The second run `i`'s badge `key` is fully up and the caption it replaced is gone. */
const badgeUp = (i: number, key: BadgeKey) =>
  n(RUN_AT[i]! + RUNS[i]!.badges[key]![0] + BADGE_IN + REST);

/** The second run `i`'s packet has finished leg `leg` and is parked. */
const parkedAfter = (i: number, leg: number) => {
  const l = RUNS[i]!.legs[leg]!;
  return n(RUN_AT[i]! + l.t0 + l.dur + REST);
};

/**
 * The moments worth stopping on (DESIGN.md section 6a). Every `at` is a
 * settled frame: the transitions bounding it have finished and every label is
 * at full or zero opacity. Verified by capture-and-look at each one.
 *
 * Times are on the continuous clock `locate` maps onto the three runs, and are
 * derived from each run's own badge windows and legs rather than typed out —
 * every hook caption crossfades with the badge that replaces it, so a beat is
 * only readable once that badge is fully up.
 *
 * One beat for the listing run, which is the short story; three for the denial,
 * which is the argument; three for the run that completes.
 */
export const beats: readonly Beat[] = [
  { at: badgeUp(0, 'access'), label: 'twelve of fifteen tools, for this user' },
  { at: n(RUN_AT[1]! + RUNS[1]!.authFrom! + REST), label: 'authorized, and the token is valid' },
  { at: badgeUp(1, 'preDeny'), label: 'denied at the pre-execution hook' },
  { at: badgeUp(1, 'statement'), label: 'the scope said yes; the policy said no' },
  { at: badgeUp(2, 'preOk'), label: 'same hook, this call allowed' },
  { at: parkedAfter(2, 4), label: 'the tool runs against stripe' },
  { at: badgeUp(2, 'post'), label: 'post rewrites what comes back' },
];

/**
 * Map one continuous clock onto the three runs, so a `?t=` capture and
 * reduced-motion both see the whole diagram without anyone clicking.
 */
function locate(g: number) {
  let acc = 0;
  for (let i = 0; i < SPANS.length; i++) {
    if (g < acc + SPANS[i]!) return { run: i, local: g - acc };
    acc += SPANS[i]!;
  }
  return { run: SPANS.length - 1, local: SPANS[SPANS.length - 1]! };
}

/**
 * Where the packet is right now.
 *
 * Between two legs it slides from where it landed to where it leaves. When
 * those are the same point it simply waits, which is the pause at a hook while
 * your code decides; when they differ it crosses the node, which is the node
 * doing its job. Either way there is never a jump cut.
 */
function packetAt(r: Run, t: number): { p: Pt; leg: number } | null {
  for (let i = 0; i < r.legs.length; i++) {
    const l = r.legs[i]!;
    const on = (u: number) => pointOn(l.r, l.rev ? 1 - u : u);
    if (t >= l.t0 && t < l.t0 + l.dur) return { p: on(easeInOut(clamp01((t - l.t0) / l.dur))), leg: i };
    if (t < l.t0 + l.dur) continue;
    const next = r.legs[i + 1];
    if (!next) return { p: on(1), leg: i };
    if (t < next.t0) {
      const gap = next.t0 - (l.t0 + l.dur);
      const u = gap > 0 ? easeInOut(clamp01((t - l.t0 - l.dur) / gap)) : 1;
      const a = on(1);
      const b = pointOn(next.r, next.rev ? 1 : 0);
      return { p: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, leg: i };
    }
  }
  return null;
}

interface Box { x: number; y: number; w: number; h: number }
interface Dm { cx: number; cy: number; r: number }

const toRect = (p: Pt, b: Box) =>
  Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.w), Math.max(b.y - p.y, 0, p.y - b.y - b.h));
const toDiamond = (p: Pt, d: Dm) =>
  Math.max(0, Math.abs(p.x - d.cx) + Math.abs(p.y - d.cy) - d.r) / Math.SQRT2;

const hold = (t: number, w?: [number, number]) =>
  w ? seg(t, w[0], BADGE_IN) * (1 - seg(t, w[1], BADGE_OUT)) : 0;

function Badge({ cx, cy, w, label, color, opacity }: {
  cx: number; cy: number; w: number; label: string; color: string; opacity: number;
}) {
  if (opacity <= 0.02) return null;
  return (
    <g opacity={opacity}>
      <rect x={cx - w / 2} y={cy - 15} width={w} height={30} rx={15}
        fill={alpha(color, 0.16)} stroke={color} />
      <text x={cx} y={cy + 5} className="a-lbl b" style={{ fill: color, letterSpacing: '.06em' }}
        textAnchor="middle" fontSize={11.5}>{label}</text>
    </g>
  );
}

export function ToolCallLifecycle(props: ArtifactProps) {
  const uid = useId().replace(/:/g, '');
  const controlled = typeof props.time === 'number';
  const [pick, setPick] = useState(0);

  // a fresh visit to the slide starts over at the first run
  useEffect(() => { setPick(0); }, [props.runKey]);

  const spot = controlled ? locate(props.time!) : null;
  const active = spot ? spot.run : pick;
  const run = RUNS[active]!;

  // one clock per run: it plays once and holds its last frame, so the diagram
  // rests on a finished state until the next click
  const t = useTimeline(
    { ...props, time: spot?.local, loop: false, runKey: `${props.runKey ?? 'x'}:${active}` },
    { duration: run.duration, poster: run.poster },
  );

  const at = packetAt(run, t);
  const packetColor = at && at.leg >= run.verdictFrom ? run.verdict : P.arcade;
  /** How lit a node is: 1 when the packet is touching it, 0 by `reach` px away. */
  const litBox = (b: Box, reach = 30) => (at ? clamp01(1 - toRect(at.p, b) / reach) : 0);
  const litDm = (d: Dm, reach = 30) => (at ? clamp01(1 - toDiamond(at.p, d) / reach) : 0);

  const accessOn = hold(t, run.badges.access);
  const preDeny = hold(t, run.badges.preDeny);
  const preOk = hold(t, run.badges.preOk);
  const postOn = hold(t, run.badges.post);
  const statement = hold(t, run.badges.statement);
  const authOn = run.authFrom !== undefined && t >= run.authFrom;
  const stripeOn = litBox({ x: PILL.x, y: STRIPE_Y - PILL.h / 2, w: PILL.w, h: PILL.h }, 26);

  const cycle = (e: MouseEvent<SVGSVGElement>) => {
    e.stopPropagation();
    setPick((k) => (k + 1) % RUNS.length);
  };

  return (
    <ArtifactSvg
      uid={uid}
      w={W} h={H}
      title={props.title ?? 'What is behind a tool call'}
      desc={props.desc ??
        'A tool call routed through Arcade, in three runs. Listing tools runs the access hook against the catalogue. Invoking a tool passes the existing authorization and OAuth checks, then a pre-execution hook, then the tool itself against a third-party API such as Stripe, then a post-execution hook. The middle run clears both authorization checks and is still denied at the pre-execution hook.'}
      className={props.className}
      style={props.style}
      background={props.background}
      onClick={controlled ? undefined : cycle}
    >
      {/* ---------- who is calling, and what they called ---------- */}
      <PersonBar w={W} x={WHO.x} y={WHO.y} h={WHO.h}
        person={run.who} note={run.note} call={run.call} callColor={run.accent} />

      {/* ---------- wiring, under everything ---------- */}
      <g>
        <Wire r={R.listOut} />
        <Wire r={R.listCheck} />
        <Wire r={R.listBack} />
        <Wire r={R.callOut} />
        <Wire r={R.toAuth} both />
        <Wire r={R.toPre} both />
        <Wire r={R.toRun} />
        <Wire r={R.toBus} plain />
        <Wire r={R.runToPost} />
        <Wire r={R.postBack} />
        <Wire r={R.toAgent} />
        {/* the service rail, and a stub into every pill on it */}
        <path d={`M ${BUS_X} ${pillY(0)} V ${pillY(SERVICES.length - 1)}`}
          className="a-wire" strokeDasharray="3 6" />
        {SERVICES.map((s, i) => (
          <g key={s.label}>
            <path d={`M ${BUS_X} ${pillY(i)} H ${PILL.x}`} className="a-wire" strokeDasharray="3 6" />
            {head({ x: PILL.x, y: pillY(i) }, { x: BUS_X, y: pillY(i) }, WIRE_INK)}
          </g>
        ))}
        <circle cx={BUS_X} cy={RUN_CY} r={3} fill={alpha(P.white, 0.34)} />
      </g>
      <WireLabel x={420} y={ACCESS.cy} text="tools/list" />
      <WireLabel x={600} y={LIST_RAIL} text="tool list" />
      {/* the two vertical hops are too short for a label on the line, so these
          sit beside them */}
      <text x={PRE.cx + 16} y={(PRE.cy + PRE.r + RUN.y) / 2 + 4} className="a-lbl"
        fontSize={10.5} style={{ fill: P.faint }}>run</text>
      <text x={POST.cx + 16} y={(RUN.y + RUN.h + POST.cy - POST.r) / 2 + 4} className="a-lbl"
        fontSize={10.5} style={{ fill: P.faint }}>result</text>

      {/* ---------- the agent ---------- */}
      <g>
        <rect x={AGENT.x} y={AGENT.y} width={AGENT.w} height={AGENT.h} rx={12}
          fill={P.panel} stroke={litBox(AGENT) > 0.05 ? P.ink : P.line}
          strokeWidth={1.25 + litBox(AGENT)} />
        <text x={AGENT.x + 16} y={AGENT.y + 28} className="a-lbl b" style={{ fill: P.faint }}>Agent</text>
        <text x={AGENT.x + 16} y={AGENT.y + 54} className="a-name" fontSize={15}>Support Ops</text>
      </g>

      {/* ---------- listing ---------- */}
      <g>
        <Diamond cx={ACCESS.cx} cy={ACCESS.cy} r={ACCESS.r} color={P.yours} lit={litDm(ACCESS)} />
        <text x={ACCESS.cx} y={ACCESS.cy + 5} className="a-lbl b" style={{ fill: P.yours }}
          textAnchor="middle" fontSize={11.5}>access</text>
        <text x={ACCESS.cx} y={CAPTION.access} className="a-sub" fontSize={12.5} opacity={1 - accessOn}
          textAnchor="middle" style={{ fill: P.muted }}>which tools exist, for this user</text>
        <Badge cx={ACCESS.cx} cy={SLOT.access} w={112} label="12 of 15" color={P.yours} opacity={accessOn} />

        <rect x={CATALOG.x} y={CATALOG.y} width={CATALOG.w} height={CATALOG.h} rx={12}
          fill={P.panel} stroke={litBox(CATALOG) > 0.05 ? P.arcade : P.line} strokeWidth={1.25 + litBox(CATALOG)} />
        <text x={CATALOG.x + 18} y={CATALOG.y + 23} className="a-lbl b" style={{ fill: P.arcade }}>Arcade</text>
        <text x={CATALOG.x + 18} y={CATALOG.y + 45} className="a-name" fontSize={15}>Tool catalog</text>
      </g>

      {/* ---------- calling ---------- */}
      <g>
        <rect x={ACTION.x} y={ACTION.y} width={ACTION.w} height={ACTION.h} rx={12}
          fill={P.panel} stroke={litBox(ACTION) > 0.05 ? P.arcade : P.line} strokeWidth={1.25 + litBox(ACTION)} />
        <text x={ACTION.x + 16} y={ACTION.y + 23} className="a-lbl b" style={{ fill: P.arcade }}>Arcade</text>
        <text x={ACTION.x + 16} y={ACTION.y + 46} className="a-name" fontSize={15}>Action layer</text>

        <rect x={AUTH.x} y={AUTH.y} width={AUTH.w} height={AUTH.h} rx={12}
          fill={P.panel} stroke={litBox(AUTH) > 0.05 ? P.scopes : alpha(P.scopes, 0.38)}
          strokeWidth={1.25 + litBox(AUTH)} />
        <text x={AUTH.x + 16} y={AUTH.y + 24} className="a-lbl b" style={{ fill: P.scopes }}>Auth + scopes</text>
        {['tool authorized', 'oauth token valid'].map((row, i) => (
          <g key={row}>
            <text x={AUTH.x + 16} y={AUTH.y + 52 + i * 24} className="a-sub" fontSize={12.5}>{row}</text>
            <text x={AUTH.x + AUTH.w - 16} y={AUTH.y + 52 + i * 24} textAnchor="end" className="a-mono"
              fontSize={13} style={{ fill: authOn ? P.allow : P.faint }}>&#10003;</text>
          </g>
        ))}

        <Diamond cx={PRE.cx} cy={PRE.cy} r={PRE.r} color={P.yours} lit={litDm(PRE)} />
        <text x={PRE.cx} y={PRE.cy + 5} className="a-lbl b" style={{ fill: P.yours }}
          textAnchor="middle" fontSize={11.5}>pre</text>
        <text x={PRE.cx} y={CAPTION.pre} className="a-sub" fontSize={12.5}
          opacity={1 - clamp01(preDeny + preOk)}
          textAnchor="middle" style={{ fill: P.muted }}>should this run, with these inputs</text>
        <Badge cx={PRE.cx} cy={SLOT.pre} w={168} label="CHECK_FAILED" color={P.deny} opacity={preDeny} />
        <Badge cx={PRE.cx} cy={SLOT.pre} w={80} label="OK" color={P.allow} opacity={preOk} />

        <rect x={RUN.x} y={RUN.y} width={RUN.w} height={RUN.h} rx={12}
          fill={P.panel} stroke={litBox(RUN) > 0.05 ? P.arcade : P.line} strokeWidth={1.25 + litBox(RUN)} />
        <text x={RUN.x + 16} y={RUN.y + 23} className="a-lbl b" style={{ fill: P.arcade }}>Arcade</text>
        <text x={RUN.x + 16} y={RUN.y + 46} className="a-name" fontSize={15}>Run</text>

        <Diamond cx={POST.cx} cy={POST.cy} r={POST.r} color={P.yours} lit={litDm(POST)} />
        <text x={POST.cx} y={POST.cy + 5} className="a-lbl b" style={{ fill: P.yours }}
          textAnchor="middle" fontSize={11.5}>post</text>
        <text x={POST.cx} y={CAPTION.post} className="a-sub" fontSize={12.5} opacity={1 - postOn}
          textAnchor="middle" style={{ fill: P.muted }}>what may come back</text>
        <Badge cx={POST.cx} cy={SLOT.post} w={184} label="override.output" color={P.rewrite} opacity={postOn} />
      </g>

      {/* ---------- what it actually runs against ---------- */}
      <g>
        <text x={PILL.x} y={pillY(0) - PILL.h / 2 - 14} className="a-lbl b" style={{ fill: P.faint }} fontSize={10.5}>
          third-party api
        </text>
        {SERVICES.map((brand, i) => {
          const isStripe = i === STRIPE_ROW;
          const on = isStripe ? stripeOn : 0;
          const y = pillY(i);
          const ink = on > 0.05 ? P.allow : isStripe ? P.body : P.faint;
          return (
            <g key={brand.label}>
              <rect x={PILL.x} y={y - PILL.h / 2} width={PILL.w} height={PILL.h} rx={10}
                fill={P.panel}
                stroke={on > 0.05 ? P.allow : isStripe ? alpha(P.ink, 0.28) : P.lineSoft}
                strokeWidth={1 + on} />
              <Mark brand={brand} x={PILL.x + 16} y={y - 9} size={18} color={ink} />
              <text x={PILL.x + 46} y={y + 5} className="a-name" fontSize={14} style={{ fill: ink }}>
                {brand.label}
              </text>
            </g>
          );
        })}
        <text x={PILL.x + PILL.w / 2} y={pillY(SERVICES.length - 1) + 42} textAnchor="middle"
          className="a-name" fontSize={18} style={{ fill: P.faint }}>&#8230;</text>
      </g>

      {/* ---------- the packet ---------- */}
      {at && <Packet uid={uid} x={n(at.p.x)} y={n(at.p.y)} color={packetColor} r={7} />}

      {/* ---------- the line the diagram exists to earn ---------- */}
      {statement > 0.02 && (
        <g opacity={statement}>
          {/* the calling lane now runs down the right, so the line lands in the
              space that opens up under the agent instead of across the bottom */}
          <line x1={40} y1={636} x2={700} y2={636} stroke={alpha(P.deny, 0.34)} />
          <text x={370} y={676} textAnchor="middle" fontFamily={FONT.serif} fontSize={26} fill={P.ink}>
            <tspan fill={P.scopes}>The scope said yes.</tspan>
            <tspan>{'  '}</tspan>
            <tspan fill={P.deny}>The policy said no.</tspan>
          </text>
        </g>
      )}

      {/* ---------- legend, out of the way at the foot ---------- */}
      <text x={W - 18} y={H - 20} className="a-lbl" fontSize={11} textAnchor="end">
        <tspan fill={P.arcade}>&#9679; arcade</tspan>
        <tspan fill={P.faint}>{'  '}</tspan>
        <tspan fill={P.scopes}>&#9679; auth + scopes</tspan>
        <tspan fill={P.faint}>{'  '}</tspan>
        <tspan fill={P.yours}>&#9679; your code</tspan>
      </text>

      {/* ---------- which run you are on ---------- */}
      <g>
        {RUNS.map((r, i) => (
          <circle key={r.call} cx={24 + i * 15} cy={H - 24} r={4.5}
            fill={i === active ? r.accent : 'none'} stroke={i === active ? r.accent : P.line} />
        ))}
      </g>
    </ArtifactSvg>
  );
}
