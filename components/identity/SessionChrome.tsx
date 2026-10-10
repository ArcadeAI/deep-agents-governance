/**
 * The session controls in the bank's top chrome: the one button that changes
 * who this browser is.
 *
 * ## What this replaced, and why
 *
 * Until #176 this file was `SignInPanel.tsx` and drew four "Sign in as …"
 * buttons in a card below the loan files. `DESIGN.md` → Identity already
 * recorded the shape that made them weak — *"on stage each persona runs in its
 * own Chrome profile, so switching is rare"* — and the human, looking at `/` on
 * 2026-09-19, named the consequence: on a screen whose whole argument is that
 * nothing here is a mock, a row of persona buttons is the most demo-looking
 * thing on it. One Chrome profile per persona is the real demo shape, so the
 * switcher went and what is left is what a real application's chrome carries.
 *
 * Nothing about the *route* changed. `SIGNIN_PATH` is the same OIDC
 * authorization against `apps/idp` under client C; it simply no longer carries
 * a `?persona=` hint, which was only ever a label for the page it came back to.
 * The person who returns is whoever typed a password at cg-idp — which was
 * already true when there were four buttons, and is the reason the buttons were
 * never an identity.
 *
 * ## No gateway token row
 *
 * Until the gateway-free refactor this chrome also showed whether a hop-1
 * gateway token was held. There is no hop 1 now: the agent calls the Engine
 * directly with the project key, as the signed-in person, so there is no
 * bearer here to report on.
 *
 * ## No client JavaScript
 *
 * One link and one form, so the whole thing works before hydration and there is
 * no state here that could disagree with the cookie.
 *
 * The misconfiguration banner is **not** here. It is
 * `components/identity/ConfigurationBanner.tsx`, placed by the pages, and its
 * own file says why.
 */
import { SIGNIN_PATH, SIGNOUT_PATH } from "../../auth/handlers.ts";
import type { ConfigurationProblems } from "../../lib/config.ts";
import type { Session } from "../../auth/session.ts";

export interface SessionChromeProps {
  session: Session | null;
  problems: ConfigurationProblems;
}

/**
 * Sized off the chrome bar it sits in rather than off the root, so it scales
 * with `.bank`'s `clamp()` the way the label beside it does. Styled inline
 * because `components/bank/bank.css` is the fork seam and this component is not
 * the bank's — the bank restyles it from outside through `--line` and
 * `--muted`, exactly as it does the chat.
 */
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "0.7em",
  flexWrap: "wrap",
  fontSize: "0.78em",
  lineHeight: 1.4,
};

const control: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "2px",
  padding: "0.15em 0.6em",
  fontSize: "inherit",
  font: "inherit",
  textDecoration: "none",
  color: "inherit",
  background: "transparent",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function SessionChrome({ session, problems }: SessionChromeProps) {
  // A control that cannot work is rendered inert rather than hidden. Hiding it
  // would leave a visitor wondering whether this deployment has a sign-in at
  // all; disabling it says "this exists, and this deployment cannot do it yet"
  // — which is what the banner at the top of the page then explains.
  const signinBroken = problems.signin.length > 0;

  return (
    <div style={row} data-session-chrome="">
      {session ? (
        <form action={SIGNOUT_PATH} method="post" style={{ margin: 0 }}>
          <button type="submit" style={control}>
            Sign out
          </button>
        </form>
      ) : signinBroken ? (
        <button
          type="button"
          disabled
          title="Sign-in is not configured on this deployment"
          style={{ ...control, cursor: "not-allowed", opacity: 0.5 }}
        >
          Sign in
        </button>
      ) : (
        <a href={SIGNIN_PATH} style={control}>
          Sign in
        </a>
      )}
    </div>
  );
}
