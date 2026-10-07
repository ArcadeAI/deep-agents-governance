/* Forked from arcade-outreach-library · hook-post @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
// Fork adaptation: optional props widened with `| undefined` so the copy compiles
// under this repo's exactOptionalPropertyTypes. The library compiles without that option.
import { P, alpha } from './palette';

/**
 * The two people the whole deck is about.
 *
 * One source of truth, because they appear on four slides. The lifecycle
 * diagram introduces them and slides 4 to 6 follow them through a hook each; if
 * Ray is a "support rep" on one slide and a "support agent" on the next, the
 * audience quietly stops believing it is the same story.
 *
 * `role` is amber wherever it renders. A role comes off the IdP token, which is
 * the same auth layer the lifecycle diagram paints amber. The policy decision
 * about that role is violet. Keeping those two apart is the argument in
 * miniature, so do not restyle the chip.
 *
 * `note` is what constrains this person in general. Individual slides override
 * it when the moment has a sharper one to make.
 */
export interface Person {
  name: string;
  email: string;
  role: string;
  note: string;
}

export const DANA: Person = {
  name: 'Dana Whitfield',
  email: 'dana@acme.com',
  role: 'contractor',
  note: 'support ops agent',
};

export const RAY: Person = {
  name: 'Ray Okonkwo',
  email: 'ray@acme.com',
  role: 'support rep',
  note: 'refund cap $500',
};

/**
 * Fixed columns for anything that lays a person out in a row.
 *
 * Deriving these from `name.length` makes the chip and the note jump sideways
 * when the diagram switches from Dana to Ray. Both names and both roles fit
 * inside these, so the row is stable across people.
 */
export const PERSON_COLS = { name: 150, role: 124 } as const;

/* ------------------------------------------------------------------
   Rendering. A person shows up the same way on every slide that has
   one, so the audience learns the band once: a face, a name, an amber
   role, then what constrains them, with the MCP call opposite.
   ------------------------------------------------------------------ */

/** The person behind the call. A face reads faster than a line of mono. */
export function Avatar({ cx, cy, r, color }: { cx: number; cy: number; r: number; color: string }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={alpha(color, 0.1)} stroke={color} strokeWidth={1.5} />
      <circle cx={cx} cy={cy - r * 0.23} r={r * 0.31} fill={color} opacity={0.92} />
      <path d={`M ${cx - r * 0.54} ${cy + r * 0.69} a ${r * 0.54} ${r * 0.46} 0 0 1 ${r * 1.08} 0 Z`}
        fill={color} opacity={0.92} />
    </g>
  );
}

export interface PersonBarProps {
  /** canvas width; the bar spans it, inset by `x` on both sides */
  w: number;
  person: Person;
  /** overrides `person.note` when a slide has a sharper constraint to name */
  note?: string | undefined;
  /** the MCP call, right-aligned opposite the identity */
  call: string;
  /** what colour that call is, usually the verdict this run ends on */
  callColor: string;
  x?: number | undefined;
  y?: number | undefined;
  h?: number | undefined;
}

/**
 * The identity band. Columns are fixed constants on purpose: derive them from
 * `name.length` and the chip slides sideways the moment a diagram switches
 * from Dana to Ray.
 */
export function PersonBar({
  w, person, note, call, callColor, x = 18, y = 10, h = 50,
}: PersonBarProps) {
  const mid = y + h / 2;
  const nameX = x + 64;
  const roleX = nameX + PERSON_COLS.name;
  const noteX = roleX + PERSON_COLS.role + 14;
  return (
    <g>
      <rect x={x} y={y} width={w - x * 2} height={h} rx={14}
        fill={alpha(P.white, 0.022)} stroke={P.line} strokeWidth={1.25} />
      <Avatar cx={x + 34} cy={mid} r={19} color={P.scopes} />
      <text x={nameX} y={mid + 6} className="a-name" fontSize={17}>{person.name}</text>
      <rect x={roleX} y={mid - 12} width={PERSON_COLS.role} height={24} rx={12}
        fill={alpha(P.scopes, 0.13)} stroke={alpha(P.scopes, 0.6)} />
      <text x={roleX + PERSON_COLS.role / 2} y={mid + 4} textAnchor="middle"
        className="a-lbl b" style={{ fill: P.scopes }} fontSize={10.5}>{person.role}</text>
      <text x={noteX} y={mid + 5} className="a-sub" fontSize={12.5}>{note ?? person.note}</text>
      <text x={w - x - 16} y={mid + 6} textAnchor="end" className="a-mono"
        fontSize={14} style={{ fill: callColor }}>{call}</text>
    </g>
  );
}
