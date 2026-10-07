/**
 * The co-branded frame, and the one thing on this template that says whose
 * demo this is (#177).
 *
 * The shape chosen at the 2026-09-19 gate was a frame **around** the surfaces
 * rather than a restyling of any of them, and the reason is `BankPane.tsx`'s
 * own argument, which #22 wrote and #177 reaffirmed: a beautiful loan desk
 * *"makes the governed system look like part of the same product as the thing
 * governing it."* Branding the bank would reverse the demo's central claim. So
 * the marks go on the page, outside everything, and the system of record keeps
 * its navy bar, its square corners and its `Rel. 7.2.1`.
 *
 * ## Why it lives here and not in a component
 *
 * `app/layout.tsx` wraps `/`, `/loans` and `/panel` identically, so one file
 * brands three surfaces and nothing inside `components/bank` or
 * `components/governance` is touched or even aware. A developer forking this
 * template deletes the bank and keeps the control plane, and the frame has to
 * be on the keep side of that cut and be one file they can restyle. It is this
 * one and `frame.css`.
 *
 * ## The lockup
 *
 * `brand-kit` → `references/logo.md` → Lockups: *"when locking up with a
 * partner logo, use the Arcade **'e'** to space the wordmark, a graphic
 * separator (vertical divider), and the partner's logo"*, shown as
 * `Arcade | Partner Logo`. The partner here is LangChain's Deep Agents. This
 * repo carries no LangChain artwork, so the partner side is set in type until
 * a wordmark from LangChain's own brand files replaces it: swap the `<span>`
 * for an `<img>` the way the Arcade side does it.
 *
 * ## The height budget
 *
 * The frame is **in flow**, not fixed: it occupies its 34px and the surfaces
 * get the rest, so nothing it draws can ever sit on top of anything they draw
 * — including #84's misconfiguration banner. `frame.css` hands the stage
 * `100dvh - 34px` and every surface root — `.bank`, `.cg-page`, both
 * `height: 100dvh` — is capped to the stage instead of to the viewport, without
 * any of them knowing the frame exists. `app-test/frame.test.ts` measures the
 * arithmetic in a real browser at 1920×1080 rather than asserting it.
 */
import type { ReactNode } from "react";

import "./frame.css";

/**
 * The served asset paths.
 *
 * `arcade-wordmark-white.svg` is `brand-kit`'s file byte for byte — the brand
 * kit is a skill on the presenter's machine rather than a dependency of this
 * repo, and a template a stranger forks has to carry the mark it renders.
 */
const ARCADE_WORDMARK = "/arcade-wordmark-white.svg";
const PARTNER = "LangChain Deep Agents";

export function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="frame">
      <header className="frame-bar">
        {/* One element around the three parts, so the "e" gaps are the lockup's
            internal spacing and the bar's padding is its clear space. */}
        <span className="frame-lockup">
          <img
            className="frame-mark frame-mark-arcade"
            src={ARCADE_WORDMARK}
            alt="Arcade"
            // The files' own viewBox dimensions, so the browser reserves the
            // right box before the SVG arrives and the bar does not reflow.
            width={1206}
            height={320}
          />
          {/* Decorative: the lockup already names both sides to a screen
              reader, and a divider it also read would be noise. */}
          <span className="frame-divider" aria-hidden="true" />
          <span className="frame-partner">{PARTNER}</span>
        </span>
      </header>

      {/* Everything else. Named a stage rather than a main because `/panel` and
          `/loans` bring their own `<main>`, and two would be one too many. */}
      <div className="frame-stage">{children}</div>
    </div>
  );
}
