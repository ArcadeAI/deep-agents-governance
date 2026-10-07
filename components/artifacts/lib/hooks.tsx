/* Forked from arcade-outreach-library · hook-post @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
import { ArtifactSvg } from './Artifact';
import { P, FONT, alpha } from './palette';
import { clamp01, easeInOut, seg, lerp, n } from './motion';
import type { ArtifactProps } from './types';
import { Avatar } from './people';

/* ============================================================
   Shared frame for the three hook demos.

   Slides 4, 5 and 6 are deliberately the same picture with
   different payloads. Building them from one frame is what makes
   "same envelope, three moments" legible instead of something
   the speaker has to assert.

   Vertical budget is the whole design problem here. Four bands,
   no filler:

     1  mini-map + what moment this is           ~46px
     2  WHO is calling, and the MCP call         ~88px
     3  request payload, under a direction bar
     4  response payload, under a direction bar
        the one line they leave with             ~48px

   Two things that used to eat height are gone. The ARCADE and
   YOUR CODE pillars became coloured dots inside each panel's
   direction bar, which doubles as the legend. And the hairline
   arrows between pillar and panel became those bars, so the
   direction of travel is a labelled object instead of 25px of
   1.5px line that vanished on a compressed stream.

   Everything here returns <g>, never a wrapper element, so the
   portability contract holds: one <svg>, styles inside it.
   ============================================================ */

/* 1400x560 (2.5:1), not 16:9. The layout is horizontal bands and a slide frame
   is roughly 2.5:1, so a 16:9 canvas letterboxed down to about 70% of the
   available width and every label shrank with it. The width it buys is not
   padding: each payload gets a rail on the right saying in English what the
   JSON beside it means. */
export const HOOK_CANVAS = { w: 1400, h: 560 } as const;

/** One coloured run of monospace text inside a payload line. */
export interface Seg { t: string; c?: string; b?: boolean }
export type Line = Seg[];

export const HOOK_POINTS = ['access', 'pre-execution', 'post-execution'] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];

/* ---------- geometry ---------- */
const PAD = 16;
const W = HOOK_CANVAS.w;
const INNER = W - PAD * 2;

const MAP_Y = 30;
const ACTOR = { y: 58, h: 88 };
/** Panels are inset from the canvas edge; the gutters carry the rails that
    show the call arriving from the agent and the result going back to it. */
const GUTTER = 44;
const PANEL_X = PAD + GUTTER;
const PANEL_W = HOOK_CANVAS.w - (PAD + GUTTER) * 2;
const REQ_TOP = 166;
/** Fixed, small gap between the two panels. Bottom-anchoring the response left
    a dead band in the middle, which is the first thing anyone notices. All
    three slides happen to run seven payload lines total, so the pair always
    ends at the same y and the frame stays identical across 4, 5 and 6. */
const PANEL_GAP = 34;
const BAR_H = 34;
const LINE_H = 21;
/** Panel height for a payload of `n` lines, direction bar included. */
const panelH = (lines: number) => 58 + lines * LINE_H;

/* ---------- small parts ---------- */

/** Diamond used by the mini-map and, at size, by the lifecycle diagram. */
export function Diamond({
  cx, cy, r, color, lit = 0, fill,
}: { cx: number; cy: number; r: number; color: string; lit?: number; fill?: string }) {
  return (
    <path
      d={`M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`}
      fill={fill ?? (lit > 0.02 ? alpha(color, 0.14 + 0.2 * lit) : alpha(P.white, 0.02))}
      stroke={lit > 0.02 ? color : alpha(color, 0.4)}
      strokeWidth={1.25 + lit * 1.4}
      strokeLinejoin="round"
      style={{ filter: lit > 0.05 ? `drop-shadow(0 0 ${9 * lit}px ${alpha(color, 0.55)})` : undefined }}
    />
  );
}

/**
 * Where we are in the lifecycle. Same three diamonds, same order, every slide,
 * so the map learned on the lifecycle slide keeps working for the rest.
 */
export function MiniMap({ active, x = PAD, y = MAP_Y }: { active: HookPoint; x?: number; y?: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      {HOOK_POINTS.map((k, i) => {
        // 178 apart: "post-execution" at 11px mono needs ~130px, and a label
        // running under the next diamond is the first thing that breaks here.
        const cx = 12 + i * 178;
        const on = k === active;
        return (
          <g key={k}>
            <Diamond cx={cx} cy={0} r={11} color={P.yours} lit={on ? 1 : 0} />
            <text
              x={cx + 20} y={4} className="a-lbl b"
              style={{ fill: on ? P.yours : P.faint }} fontSize={11}
            >
              {k}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * The direction bar at the top of a payload: who is talking to whom, which way,
 * and what the call is. Doubles as the deck's legend, which is why the ARCADE
 * and YOUR CODE pillars could go.
 */
function DirectionBar({
  x, y, w, toYours, accent, meta, travel,
}: {
  x: number; y: number; w: number;
  /** true = Arcade calling your server, false = your answer coming back */
  toYours: boolean;
  accent: string; meta: string;
  /** 0..1 position of the packet along the arrow, or null */
  travel: number | null;
}) {
  const from = toYours
    ? { label: 'arcade', c: P.arcade }
    : { label: 'your hook server', c: P.yours };
  const to = toYours
    ? { label: 'your hook server', c: P.yours }
    : { label: 'arcade', c: P.arcade };

  /* Fixed columns, not measured text. The label widths differ between the two
     bars, so deriving the arrow position from them put the arrow through the
     end of "your hook server" and moved every element between the request bar
     and the response bar. Both bars now use identical x positions. */
  const AX = 236, AW = 100, TO_DOT = 356, TO_LBL = 368;
  const cy = y + BAR_H / 2;

  return (
    <g>
      <rect x={x} y={y} width={w} height={BAR_H} rx={11} fill={alpha(accent, 0.07)} />
      <circle cx={x + 22} cy={cy} r={4.5} fill={from.c} />
      <text x={x + 34} y={cy + 4} className="a-lbl b" style={{ fill: from.c }} fontSize={11}>
        {from.label}
      </text>

      <line x1={x + AX} y1={cy} x2={x + AX + AW - 9} y2={cy} stroke={accent} strokeWidth={2} />
      <path
        d={`M ${x + AX + AW - 9} ${cy - 5.5} L ${x + AX + AW} ${cy} L ${x + AX + AW - 9} ${cy + 5.5} Z`}
        fill={accent}
      />

      <circle cx={x + TO_DOT} cy={cy} r={4.5} fill={to.c} />
      <text x={x + TO_LBL} y={cy + 4} className="a-lbl b" style={{ fill: to.c }} fontSize={11}>
        {to.label}
      </text>

      <text
        x={x + w - 16} y={cy + 4} textAnchor="end"
        className="a-lbl b" fontSize={11.5}
        style={{ fill: accent, letterSpacing: '.06em', textTransform: 'none' }}
      >
        {meta}
      </text>

      {travel !== null && (
        <circle cx={n(lerp(x + AX, x + AX + AW, travel))} cy={cy} r={5} fill={accent}
          style={{ filter: `drop-shadow(0 0 6px ${alpha(accent, 0.9)})` }} />
      )}
    </g>
  );
}

/** Width of the plain-English rail on the right of each payload. */
const GLOSS_W = 360;

/** A payload on the wire, under its direction bar, with what it means beside it. */
function Payload({
  x, y, w, h, toYours, accent, meta, lines, gloss, reveal, travel,
}: {
  x: number; y: number; w: number; h: number;
  toYours: boolean; accent: string; meta: string;
  lines: Line[]; gloss: string[]; reveal: number; travel: number | null;
}) {
  const shown = reveal * lines.length;
  const railX = x + w - GLOSS_W - 20;
  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h} rx={12}
        fill={P.panel2} stroke={alpha(accent, 0.42)} strokeWidth={1.25}
        style={{ filter: `drop-shadow(0 0 16px ${alpha(accent, 0.13)})` }}
      />
      <DirectionBar x={x} y={y} w={w} toYours={toYours} accent={accent} meta={meta} travel={travel} />
      {lines.map((segs, i) => {
        const u = clamp01(shown - i);
        if (u <= 0) return null;
        return (
          <text
            key={i} x={x + 20} y={y + BAR_H + 24 + i * LINE_H}
            className="a-mono" fontSize={14} opacity={u} xmlSpace="preserve"
          >
            {segs.map((s, j) => (
              <tspan key={j} fill={s.c ?? P.muted} fontWeight={s.b ? 700 : 400}>{s.t}</tspan>
            ))}
          </text>
        );
      })}

      {/* what the JSON beside this actually means */}
      <g opacity={clamp01(reveal * 1.4)}>
        <line x1={railX - 24} y1={y + BAR_H + 12} x2={railX - 24} y2={y + h - 12}
          stroke={P.lineSoft} />
        {gloss.map((g, i) => (
          <text key={i} x={railX} y={y + BAR_H + 26 + i * 20} className="a-sub" fontSize={13.5}>
            {g}
          </text>
        ))}
      </g>
    </g>
  );
}

/* ---------- the frame itself ---------- */

export interface HookExchangeProps extends ArtifactProps {
  uid: string;
  t: number;
  /** which diamond is hot */
  point: HookPoint;
  /** right-aligned on the mini-map row: what moment this is */
  context: string;
  /** whose call this is */
  person: string;
  role: string;
  roleNote: string;
  /** the MCP call that started it, and what came back */
  agentOut: Line;
  agentBack: Line;
  /** right-aligned in each direction bar */
  requestMeta: string;
  requestLines: Line[];
  /** one or two short lines of English, beside the request payload */
  requestGloss: string[];
  responseMeta: string;
  responseLines: Line[];
  responseGloss: string[];
  /** colour of the verdict: allow, deny or rewrite */
  verdict: string;
  /** the one line the audience should leave with */
  consequence: string;
}

/** Beat clock shared by all three hook slides. */
export const HOOK_BEATS = {
  /** the agent's tools/list or tools/call. Everything else is downstream of it. */
  agentOut: 0.15,
  reqTravel: [1.0, 1.2] as const,
  reqLines: [1.3, 1.9] as const,
  think: [2.9, 1.0] as const,
  resTravel: [4.0, 1.1] as const,
  resLines: [4.3, 1.5] as const,
  agentBack: 6.2,
  consequence: 6.6,
  duration: 12,
  poster: 7.3,
};

export function HookExchange(props: HookExchangeProps) {
  const {
    uid, t, point, context, person, role, roleNote, agentOut, agentBack,
    requestMeta, requestLines, requestGloss,
    responseMeta, responseLines, responseGloss, verdict, consequence,
  } = props;
  const B = HOOK_BEATS;

  const reqU = easeInOut(seg(t, B.reqTravel[0], B.reqTravel[1]));
  const resU = easeInOut(seg(t, B.resTravel[0], B.resTravel[1]));
  const reqReveal = seg(t, B.reqLines[0], B.reqLines[1]);
  const resReveal = seg(t, B.resLines[0], B.resLines[1]);
  const thinking = seg(t, B.think[0], B.think[1]) * (1 - seg(t, B.think[0] + B.think[1], 0.3));
  const outIn = seg(t, B.agentOut, 0.4);
  const backIn = seg(t, B.agentBack, 0.45);
  const consIn = seg(t, B.consequence, 0.5);

  const reqH = panelH(requestLines.length);
  const resH = panelH(responseLines.length);
  const resTop = REQ_TOP + reqH + PANEL_GAP;
  const gapMid = resTop - PANEL_GAP / 2;

  const actorBottom = ACTOR.y + ACTOR.h;
  const reqBarMid = REQ_TOP + BAR_H / 2;
  const resBarMid = resTop + BAR_H / 2;
  const railL = PAD + 22;
  const railR = W - PAD - 22;
  const inRail = seg(t, B.reqTravel[0] - 0.35, 0.4);

  const roleW = role.length * 8.2 + 26;

  return (
    <>
      {/* ---------- 1. where we are ---------- */}
      <MiniMap active={point} />
      <text x={W - PAD} y={MAP_Y + 4} textAnchor="end" className="a-lbl"
        style={{ fill: P.faint }} fontSize={11}>{context}</text>

      {/* ---------- 2. who is calling, and what they called ---------- */}
      <g>
        <rect x={PAD} y={ACTOR.y} width={INNER} height={ACTOR.h} rx={14}
          fill={alpha(P.white, 0.022)} stroke={P.line} strokeWidth={1.25} />
        <Avatar cx={PAD + 48} cy={ACTOR.y + ACTOR.h / 2} r={26} color={P.scopes} />

        <text x={PAD + 92} y={ACTOR.y + 38} className="a-name" fontSize={20}>{person}</text>
        <rect x={PAD + 92} y={ACTOR.y + 50} width={roleW} height={22} rx={11}
          fill={alpha(P.scopes, 0.13)} stroke={alpha(P.scopes, 0.6)} />
        <text x={PAD + 92 + roleW / 2} y={ACTOR.y + 65} textAnchor="middle"
          className="a-lbl b" style={{ fill: P.scopes }} fontSize={10.5}>{role}</text>
        <text x={PAD + 92 + roleW + 12} y={ACTOR.y + 65} className="a-sub" fontSize={12.5}>
          {roleNote}
        </text>

        <text x={W - PAD - 16} y={ACTOR.y + 36} textAnchor="end" className="a-mono"
          fontSize={14} opacity={outIn} xmlSpace="preserve">
          {agentOut.map((s, j) => (
            <tspan key={j} fill={s.c ?? P.muted} fontWeight={s.b ? 700 : 400}>{s.t}</tspan>
          ))}
        </text>
        <text x={W - PAD - 16} y={ACTOR.y + 66} textAnchor="end" className="a-mono"
          fontSize={14} opacity={backIn} xmlSpace="preserve">
          {agentBack.map((s, j) => (
            <tspan key={j} fill={s.c ?? P.muted} fontWeight={s.b ? 700 : 400}>{s.t}</tspan>
          ))}
        </text>
      </g>

      {/* ---------- 3 + 4. the exchange ----------
          The two rails close the loop. Without the one on the right, the
          response reaches Arcade and visibly stops there, and nobody can see
          how the agent ever hears about it. */}
      <g opacity={inRail}>
        <path
          d={`M ${railL} ${actorBottom} V ${reqBarMid} H ${PANEL_X - 8}`}
          fill="none" stroke={alpha(P.yours, 0.75)} strokeWidth={1.75}
        />
        <path
          d={`M ${PANEL_X - 9} ${reqBarMid - 5} L ${PANEL_X - 1} ${reqBarMid} L ${PANEL_X - 9} ${reqBarMid + 5} Z`}
          fill={P.yours}
        />
      </g>

      <g opacity={backIn}>
        <path
          d={`M ${PANEL_X + PANEL_W} ${resBarMid} H ${railR} V ${actorBottom + 9}`}
          fill="none" stroke={alpha(verdict, 0.85)} strokeWidth={1.75}
        />
        <path
          d={`M ${railR - 5} ${actorBottom + 9} L ${railR} ${actorBottom + 1} L ${railR + 5} ${actorBottom + 9} Z`}
          fill={verdict}
        />
        <text
          transform={`translate(${railR + 13}, ${(actorBottom + resBarMid) / 2}) rotate(-90)`}
          textAnchor="middle" className="a-lbl b" style={{ fill: verdict }} fontSize={10}
        >
          back to the agent
        </text>
      </g>

      <Payload
        x={PANEL_X} y={REQ_TOP} w={PANEL_W} h={reqH}
        toYours accent={P.yours} meta={requestMeta}
        lines={requestLines} gloss={requestGloss} reveal={reqReveal}
        travel={reqU > 0 && reqU < 1 ? reqU : null}
      />
      <Payload
        x={PANEL_X} y={resTop} w={PANEL_W} h={resH}
        toYours={false} accent={verdict} meta={responseMeta}
        lines={responseLines} gloss={responseGloss} reveal={resReveal}
        travel={resU > 0 && resU < 1 ? resU : null}
      />

      {/* your server, working on it — fills the gap the two panels leave */}
      {thinking > 0.02 && (
        <g opacity={thinking}>
          {[0, 1, 2].map((i) => (
            <circle
              key={i} cx={W / 2 - 13 + i * 13} cy={gapMid} r={3.5} fill={P.yours}
              opacity={0.35 + 0.65 * Math.abs(Math.sin((t - B.think[0]) * 6 - i * 0.8))}
            />
          ))}
        </g>
      )}

      {/* ---------- the line they leave with ---------- */}
      {consIn > 0.02 && (
        <g opacity={consIn}>
          <line x1={PAD} y1={497} x2={W - PAD} y2={497} stroke={alpha(verdict, 0.34)} />
          <text x={W / 2} y={530} textAnchor="middle" fontFamily={FONT.serif}
            fontSize={24} fill={verdict}>{consequence}</text>
        </g>
      )}
    </>
  );
}

/** Wraps the shared frame in the standard artifact <svg>. */
export function HookArtifact({
  props, t, uid, title, desc, ...rest
}: {
  props: ArtifactProps; t: number; uid: string; title: string; desc: string;
} & Omit<HookExchangeProps, 'uid' | 't' | keyof ArtifactProps>) {
  return (
    <ArtifactSvg
      uid={uid}
      w={HOOK_CANVAS.w}
      h={HOOK_CANVAS.h}
      title={props.title ?? title}
      desc={props.desc ?? desc}
      className={props.className}
      style={props.style}
      background={props.background}
    >
      <HookExchange uid={uid} t={t} {...rest} />
    </ArtifactSvg>
  );
}
