/* Forked from arcade-outreach-library · execution-record @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
/**
 * GENERATED FILE — do not edit.
 *
 * Emitted from brand/tokens.source.ts by `bun run tokens`. Hand-editing it is invalid
 * (DESIGN.md sections 1 and 13) and a test in packages/tokens fails when this
 * file and the source disagree. The sibling output is
 * brand/generated/tokens.css.
 *
 * Plain hex, deliberately not CSS custom properties: an artifact has to keep
 * its colours when it is lifted out of the library into a blog post, a PDF
 * renderer or a standalone .svg, where the host's `:root` never loads.
 *
 * Colour means ownership. Chartreuse is Arcade, violet is code you wrote,
 * amber is the auth layer you already had. The three verdict colours say what
 * a hook answered. Reach for a semantic token, never a raw one and never a
 * literal (DESIGN.md section 6).
 *
 * Why any individual token is the value it is — including why `sans` is a
 * system stack rather than GT Cinetype — is documented beside it in
 * brand/tokens.source.ts.
 */
export const P = {
  /* --- raw — the brand colours and the surfaces built out of them --- */
  black: '#000000',
  white: '#FFFFFF',
  chartreuse: '#C3FF02',
  amber: '#FFB700',
  green: '#00FF68',
  purple: '#A30EFF',
  violet: '#C56BFF',
  blue: '#4708F9',
  fuchsia: '#FF1FBC',
  red: '#FF0037',
  redLifted: '#FF3B60',
  sky: '#005EFF',
  blueLifted: '#5B8CFF',
  aqua: '#00F7FF',
  panel: '#0E0E0E',
  panel2: '#161616',
  line: 'rgba(255,255,255,0.16)',
  lineSoft: 'rgba(255,255,255,0.08)',

  /* --- semantic — what a colour MEANS. Artifacts reach for these. --- */
  bg: '#000000', // black
  arcade: '#C3FF02', // chartreuse
  yours: '#C56BFF', // violet
  yoursDeep: '#A30EFF', // purple
  scopes: '#FFB700', // amber
  allow: '#00FF68', // green
  deny: '#FF3B60', // red-lifted
  rewrite: '#00F7FF', // aqua
  met: '#00FF68', // green
  key: '#00F7FF', // aqua
  governed: '#C3FF02', // chartreuse
  shadow: '#FF1FBC', // fuchsia
  drift: '#FFB700', // amber
  registry: '#5B8CFF', // blue-lifted
  consent: '#00F7FF', // aqua

  /* --- text — type colour --- */
  ink: '#F2F2F2',
  body: '#DCDCDC',
  muted: '#B8B8B8',
  faint: '#8C8C8C',
} as const;

export const FONT = {
  sans: '-apple-system, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: '"GT Sectra Display", Georgia, "Times New Roman", serif',
  mono: '"GT Cinetype Mono", ui-monospace, Menlo, Consolas, monospace',
} as const;

/** rgba() from a hex + alpha, for glows and fills. */
export const alpha = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(v, 16);
  return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${a})`;
};
