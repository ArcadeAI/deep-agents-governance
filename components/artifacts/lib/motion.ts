/* Forked from arcade-outreach-library · execution-record @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
/* Tiny, dependency-free motion helpers shared by every artifact. */

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** Normalised progress of `t` across the window [start, start+len]. */
export const seg = (t: number, start: number, len: number) => clamp01((t - start) / len);

/** 0 -> 1 -> 0 over the window; for blips, pulses and flashes. */
export const pulse = (t: number, start: number, len: number) => {
  const u = seg(t, start, len);
  return Math.sin(u * Math.PI);
};

/** True while `t` sits inside the window. */
export const during = (t: number, start: number, len: number) => t >= start && t < start + len;

export const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
export const easeIn = (u: number) => u * u * u;
export const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeOutBack = (u: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
};

export interface Pt { x: number; y: number }

/** Point along a straight line. */
export const onLine = (a: Pt, b: Pt, u: number): Pt => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) });

/**
 * Point along a quadratic bezier — used for every packet path so the flight
 * arcs instead of sliding, which reads far better on a compressed stream.
 */
export const onCurve = (a: Pt, c: Pt, b: Pt, u: number): Pt => {
  const m = 1 - u;
  return {
    x: m * m * a.x + 2 * m * u * c.x + u * u * b.x,
    y: m * m * a.y + 2 * m * u * c.y + u * u * b.y,
  };
};

/** Control point for a gentle arc between two nodes. `bow` is px of sag. */
export const bowControl = (a: Pt, b: Pt, bow = 26): Pt => {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: mx + (-dy / len) * bow, y: my + (dx / len) * bow };
};

/** `M a Q c b` path string for the arc above. */
export const curvePath = (a: Pt, b: Pt, bow = 26) => {
  const c = bowControl(a, b, bow);
  return `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;
};

/** Deterministic pseudo-random in [0,1) — keeps SSR and client identical. */
export const rand = (seed: number) => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Round to 2dp so SSR and client markup match byte for byte. */
export const n = (v: number) => Math.round(v * 100) / 100;
