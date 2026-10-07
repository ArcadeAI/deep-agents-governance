/* Forked from arcade-outreach-library · execution-record @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
import { useEffect, useRef, useState } from 'react';
import type { ArtifactProps, Beat } from './types';

export interface BeatConfig {
  /**
   * The artifact's own `beats` table (DESIGN.md section 6a), verbatim.
   *
   * Taking `Beat[]` rather than the bare numbers is deliberate: the times the
   * clock stops at and the times previous/next advertise have to be the same
   * times, and the only way to guarantee that is for there to be one table.
   * Passing `beats.map(b => b.at)` would put a second copy one edit away from
   * disagreeing with the first.
   *
   * `at` ascending. Step 0 plays the first beat on arrival, so a host stepping
   * this needs `steps={beats.length - 1}` — derived from the exported table
   * rather than repeated as a number.
   */
  beats: readonly Beat[];
  /**
   * Frame to render before the clock exists — SSR, pre-hydration, and reduced
   * motion. Defaults to the last beat, i.e. the finished diagram, which is
   * both the portability contract's "meaningful poster" and the right answer
   * for a click-stepped artifact: its end state is everything visible.
   */
  poster?: number;
}

/**
 * The clock for an artifact that advances in beats rather than on a loop.
 *
 * `useTimeline` runs a diagram end to end and wraps. That is wrong for a
 * diagram a speaker is talking over: it either races ahead of them or loops
 * back under them mid-sentence. This runs the same choreography, but stops at
 * the end of the current beat and waits.
 *
 * The step comes from the deck's own step counter (see `deck:step` in
 * Deck.astro), so one click or one arrow key advances one beat, and the deck
 * leaves the slide by itself once the last beat has played. Nothing here knows
 * about the deck — `step` arrives as a prop, and the artifact stays portable.
 *
 * Three behaviours worth knowing:
 *
 *  - **It never loops.** Once the last beat is reached the diagram holds. That
 *    is the point; the end state is the finished picture.
 *  - **A jump of more than one beat snaps** instead of animating. Pressing End,
 *    arriving at a slide backwards, or loading `?steps=all` should land on the
 *    finished diagram immediately, not replay nine seconds of build-up.
 *  - **Stepping backwards snaps too**, to the end of the beat you land on.
 *
 * `time` still overrides everything, so the capture pages are unaffected.
 */
export function useBeats(
  { time, playing = true, speed = 1, runKey, step }: ArtifactProps,
  { beats, poster }: BeatConfig,
): number {
  const controlled = typeof time === 'number';
  const last = beats[beats.length - 1]?.at as number;
  const end = poster ?? last;

  /** the time this beat plays up to; no `step` means "play the whole thing" */
  const ceiling =
    step === undefined ? last : (beats[Math.max(0, Math.min(beats.length - 1, step))]?.at as number);

  const [t, setT] = useState(controlled ? time! : runKey === undefined ? end : 0);

  /* Elapsed lives in a ref because a step change must RAISE the ceiling and
     carry on from where the diagram already is, not restart it. */
  const elapsed = useRef(controlled ? time! : runKey === undefined ? end : 0);
  const prevStep = useRef(step);
  const prevRun = useRef(runKey);

  useEffect(() => {
    if (controlled) {
      elapsed.current = time!;
      setT(time!);
      return;
    }

    /* Scene entry. Clearing prevStep rather than adopting the incoming one is
       what makes the next block decide correctly: entering at step 0 replays
       from the top, while entering already part-way in (`?steps=all`, arriving
       backwards, a number key) is treated as a jump and lands on the finished
       beat instead of animating up to it from zero. */
    if (runKey !== prevRun.current) {
      prevRun.current = runKey;
      prevStep.current = undefined;
      elapsed.current = 0;
      setT(0);
    }

    /* A "jump" is any move that is not a single step forward: stepping back,
       skipping ahead (End, a number key, `?steps=all`), or mounting already
       part-way in. Those land on the finished beat instead of replaying.

       `step === undefined` is NOT a jump — it means no one is stepping this
       artifact, so it should play straight through. Treating it as one made
       the diagram snap to its end state the moment it mounted, then visibly
       rewind on the first click. */
    const from = prevStep.current;
    const jumped =
      step !== undefined &&
      (from === undefined ? step > 0 : step < from || step - from > 1);
    prevStep.current = step;

    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Reduced motion, or any jump that is not a single step forward, lands on
    // the finished beat without replaying the build-up.
    if (reduced || jumped) {
      elapsed.current = ceiling;
      setT(ceiling);
      return;
    }
    if (!playing) return;

    if (elapsed.current >= ceiling) {
      setT(ceiling);
      return;
    }

    let lastNow = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min((now - lastNow) / 1000, 0.1) * speed; // clamp tab-switch jumps
      lastNow = now;
      elapsed.current = Math.min(elapsed.current + dt, ceiling);
      setT(elapsed.current);
      if (elapsed.current < ceiling) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [controlled, time, playing, speed, runKey, step, ceiling]);

  return t;
}
