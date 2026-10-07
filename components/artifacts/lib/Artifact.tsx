/* Forked from arcade-outreach-library · execution-record @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
// Fork adaptation: optional props widened with `| undefined` so the copy compiles
// under this repo's exactOptionalPropertyTypes. The library compiles without that option.
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { P, FONT, alpha } from './palette';

/** Default artifact canvas. 16:9 so it drops straight into a slide or a hero image. */
export const CANVAS = { w: 1000, h: 560 } as const;

/**
 * Typographic + surface primitives, injected as an SVG-internal `<style>`.
 *
 * Inside `<svg>` on purpose: the rules travel with the element into any host —
 * an Astro page, an MDX blog post, a headless-Chrome PDF, or a raw `.svg` file
 * saved out of the DOM. Nothing here depends on the deck's stylesheet.
 */
const BASE_CSS = `
.a-lbl{font-family:${FONT.mono};font-size:12px;letter-spacing:.16em;text-transform:uppercase;fill:${P.faint}}
.a-lbl.b{font-weight:700}
.a-name{font-family:${FONT.sans};font-size:16px;font-weight:600;fill:${P.ink}}
.a-sub{font-family:${FONT.sans};font-size:13px;fill:${P.muted}}
.a-mono{font-family:${FONT.mono};font-size:13px;fill:${P.body}}
.a-mono.sm{font-size:11px;letter-spacing:.06em}
.a-ttl{font-family:${FONT.serif};font-size:26px;fill:${P.ink}}
.a-node{fill:${P.panel};stroke:${P.line};stroke-width:1.25}
.a-wire{fill:none;stroke:${alpha(P.white, 0.14)};stroke-width:1.5}
text{paint-order:stroke}
`;

export interface ArtifactSvgProps {
  uid: string;
  w?: number | undefined;
  h?: number | undefined;
  title: string;
  desc: string;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /**
   * Painted behind everything. Defaults to solid black so a standalone export
   * (PNG / PDF / .svg) is self-contained; pass `"transparent"` when the host
   * already provides a surface.
   */
  background?: string | undefined;
  /**
   * Artifacts are non-interactive by default. Pass a handler only when the
   * diagram itself is the control — the lifecycle artifact uses this to let a
   * click step through its three runs. Handlers must stop propagation, or the
   * deck's click-to-advance will fire underneath.
   */
  onClick?: ((e: MouseEvent<SVGSVGElement>) => void) | undefined;
  children: ReactNode;
}

/**
 * The frame every artifact renders into.
 *
 * `viewBox` + `width:100%` means the diagram scales as a rigid unit: type,
 * strokes and spacing all grow together and the internal layout never reflows.
 * That is the whole reason artifacts are SVG rather than HTML.
 */
export function ArtifactSvg({
  uid, w = CANVAS.w, h = CANVAS.h,
  title, desc, className, style, background = P.bg, onClick, children,
}: ArtifactSvgProps) {
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby={`${uid}-t ${uid}-d`}
      className={className}
      onClick={onClick}
      style={{
        display: 'block', width: '100%', height: 'auto', overflow: 'visible',
        ...(onClick ? { cursor: 'pointer' } : null),
        ...style,
      }}
    >
      <title id={`${uid}-t`}>{title}</title>
      <desc id={`${uid}-d`}>{desc}</desc>
      <style>{BASE_CSS}</style>
      <defs>
        {/* soft outer glow, used on live packets and lit nodes */}
        <filter id={`${uid}-glow`} x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={`${uid}-glow-sm`} x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {background !== 'transparent' && <rect x="0" y="0" width={w} height={h} fill={background} />}
      {children}
    </svg>
  );
}

/** A rounded box with a title + optional accent — the shared "component" look. */
export function Node({
  x, y, w, h, accent, lit = 0, label, name, sub, r = 12,
}: {
  x: number; y: number; w: number; h: number;
  accent?: string; lit?: number; label?: string; name?: string; sub?: string; r?: number;
}) {
  const a = accent ?? P.muted;
  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h} rx={r}
        fill={P.panel}
        stroke={lit > 0 ? a : P.line}
        strokeWidth={1.25 + lit * 1.5}
        style={{ filter: lit > 0.02 ? `drop-shadow(0 0 ${8 * lit}px ${alpha(a, 0.55 * lit)})` : undefined }}
      />
      {label && (
        <text x={x + 16} y={y + 22} className="a-lbl b" style={{ fill: accent ? a : P.faint }}>
          {label}
        </text>
      )}
      {name && (
        <text x={x + 16} y={y + (label ? 48 : 30)} className="a-name">
          {name}
        </text>
      )}
      {sub && (
        <text x={x + 16} y={y + (label ? 70 : 52)} className="a-sub">
          {sub}
        </text>
      )}
    </g>
  );
}

/** A travelling request/response packet. */
export function Packet({
  x, y, color, uid, r = 6, opacity = 1, tail,
}: { x: number; y: number; color: string; uid: string; r?: number; opacity?: number; tail?: string }) {
  return (
    <g opacity={opacity} filter={`url(#${uid}-glow)`}>
      {tail && <path d={tail} fill="none" stroke={alpha(color, 0.4)} strokeWidth={2} strokeLinecap="round" />}
      <circle cx={x} cy={y} r={r} fill={color} />
      <circle cx={x} cy={y} r={r * 2.1} fill={alpha(color, 0.18)} />
    </g>
  );
}
