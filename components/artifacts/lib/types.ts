/* Forked from arcade-outreach-library · execution-record @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
// Fork adaptation: optional props widened with `| undefined` so the copy compiles
// under this repo's exactOptionalPropertyTypes. The library compiles without that option.
import type { CSSProperties } from 'react';

/**
 * Props every artifact accepts.
 *
 * Artifacts are portable, self-contained animated diagrams. They render as a
 * single `<svg>` with a fixed `viewBox`, so they scale as one unit and never
 * reflow: drop one in a slide, a blog post, an Astro page, a PDF renderer or a
 * screenshot pipeline and the layout is identical.
 */
export interface ArtifactProps {
  /**
   * Freeze the animation at this time, in seconds into the loop.
   * Use for PDF / image capture, or to hand-pick a poster frame.
   * When set, the internal clock never runs.
   */
  time?: number | undefined;
  /** Run the clock. Default `true`. Ignored when `time` is set. */
  playing?: boolean | undefined;
  /** Playback rate multiplier. Default `1`. */
  speed?: number | undefined;
  /** Loop forever. Default `true`. When `false`, holds on the last frame. */
  loop?: boolean | undefined;
  /**
   * Change this to restart the animation from t=0.
   * The deck passes a per-slide run counter so every scene entry replays.
   */
  runKey?: string | number | undefined;
  /** Fires each time the loop wraps. */
  onCycle?: () => void | undefined;
  /**
   * Which beat to play up to, for artifacts driven by `useBeats` rather than a
   * loop. Supplied by the deck from its own step counter, so one click or one
   * arrow key advances one beat. Omit it and the artifact plays straight
   * through — which is what the gallery and any non-deck host want.
   */
  step?: number | undefined;
  /** Extra class on the root `<svg>`. */
  className?: string | undefined;
  /** Inline style on the root `<svg>`. */
  style?: CSSProperties | undefined;
  /** Accessible title. Each artifact ships a sensible default. */
  title?: string | undefined;
  /** Accessible long description. Each artifact ships a sensible default. */
  desc?: string | undefined;
  /**
   * Painted behind the diagram. Defaults to solid black so a standalone
   * export (PNG / PDF / .svg) is self-contained. Pass `"transparent"` when
   * the host already provides a surface, or any colour for a light context.
   */
  background?: string | undefined;
}

/** Resolved defaults an artifact hands to `useTimeline`. */
export interface TimelineConfig {
  /** Full loop length in seconds. */
  duration: number;
  /**
   * Time to render before the clock starts — on the server, during hydration,
   * and whenever motion is reduced. Pick a frame that reads as a complete
   * diagram, because this is what a static export captures by default.
   */
  poster: number;
}

/**
 * One moment in an artifact's timeline worth stopping on.
 *
 * The animation is a continuous function of `t`, but a viewer does not think
 * in seconds — they think "the consent step". A beat names a frame that reads
 * as a complete moment, so a host can offer previous/next that land on the
 * diagram's own moments instead of stepping by an arbitrary time delta.
 *
 * The convention is DESIGN.md section 6a. Restated here as an author meets it,
 * at the keyboard, with the mechanics of checking it:
 *
 * - An artifact module MAY export `beats: readonly Beat[]` alongside its
 *   component. It is optional; an artifact with no discrete moments omits it.
 * - `at` is seconds into the loop, ascending, `0 <= at < duration`, and rounds
 *   to 2dp, because it is also a time somebody types after `?t=`.
 * - **`at` must name a settled frame.** Not the instant a transition begins — a
 *   time at which the transitions bounding it have finished and every label is
 *   at full or zero opacity, nothing moving but a travelling packet. A time
 *   mid-crossfade is not a beat. Two labels can share one anchor — a row
 *   swapping `no token` for an address in place — so a beat inside that
 *   crossfade paints both at once and reads as ghosted, concatenated text: it
 *   compiles, it captures, and it is unreadable at exactly the frame somebody
 *   arrived at on purpose. Check it the way DESIGN.md section 12 already says
 *   to check anything visual — capture the frame and look at it — at **every**
 *   declared beat rather than a sampled few, and mechanically with
 *   `unsettledSlots` / `unstableLabels` from `@outreach/catalog`, which
 *   `packages/catalog/src/settled.test.ts` runs over every declared beat of
 *   every artifact.
 * - `label` is short and lowercase — it is read as a caption, not a heading.
 * - It lives in the artifact module, not the frontmatter, because the times it
 *   names are the same constants the animation runs on and so cannot drift
 *   from them. A number in `asset.md` can be silently wrong.
 * - A host with no beats to work from falls back to the poster as the only
 *   stop and says so. Previous and next must never invent a fixed increment;
 *   stepping by a fixed delta is a scrubber wearing a stepper's clothes.
 */
export interface Beat {
  /** Seconds into the loop. Freeze here with the `time` prop to show the beat. */
  at: number;
  /** Short, lowercase caption for the moment — `consent`, `token held`. */
  label: string;
}
