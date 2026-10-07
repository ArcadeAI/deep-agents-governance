/* Forked from arcade-outreach-library · hook-post @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
import { useEffect, useRef, useState } from 'react';
import type { ArtifactProps, TimelineConfig } from './types';

/**
 * The single clock every artifact runs on.
 *
 * Contract:
 *  - SSR / first paint renders `poster` (or the controlled `time`), so a
 *    server-rendered or never-hydrated artifact still looks like a finished
 *    diagram rather than an empty frame.
 *  - Once mounted it advances from `poster` and wraps at `duration`, so there
 *    is no visible jump on hydration.
 *  - `runKey` changing snaps back to 0 and replays (deck scene entry).
 *  - `time` set, `playing:false`, or `prefers-reduced-motion` all freeze it.
 */
export function useTimeline(
  { time, playing = true, speed = 1, loop = true, runKey, onCycle }: ArtifactProps,
  { duration, poster }: TimelineConfig,
): number {
  const controlled = typeof time === 'number';
  const [t, setT] = useState(controlled ? time! : poster);
  const cycleRef = useRef(onCycle);
  cycleRef.current = onCycle;

  useEffect(() => {
    if (controlled) {
      setT(time!);
      return;
    }
    if (!playing) return;

    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setT(poster);
      return;
    }

    // `runKey` present means "replay on entry"; otherwise keep the poster
    // phase so hydration is seamless.
    let elapsed = runKey === undefined ? poster : 0;
    let last = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1) * speed; // clamp tab-switch jumps
      last = now;
      elapsed += dt;
      if (elapsed >= duration) {
        if (loop) {
          elapsed %= duration;
          cycleRef.current?.();
        } else {
          elapsed = duration;
          setT(elapsed);
          return;
        }
      }
      setT(elapsed);
      raf = requestAnimationFrame(tick);
    };

    setT(elapsed);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [controlled, time, playing, speed, loop, duration, poster, runKey]);

  return t;
}
