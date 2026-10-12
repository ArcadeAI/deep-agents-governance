/**
 * Every identity route, as plain `(Request) => Promise<Response>` functions.
 *
 * `app/api/**` is a one-line adapter onto each of these. The indirection buys
 * one thing: a test can mount these same functions behind a real `Bun.serve`
 * and drive them with a cookie jar over real HTTP, so it exercises the
 * `Set-Cookie` header a browser would actually receive and the redirect chain
 * a browser would actually walk, with no framework mock.
 *
 * The four routes, and the two hops they make up:
 *
 *   GET  /api/auth/signin     start sign-in at IDP_ISSUER (Okta)      ─┐ hop 0:
 *   GET  /api/auth/callback   the IdP's return leg; the session is made ┘ who you are
 *   GET  /api/arcade/verify   Arcade's custom user verifier            ← hop 2
 *   POST /api/auth/signout    forget this browser's persona
 *
 * There is no hop 1. The agent reaches its tools by calling the Engine directly
 * with the project key, as the person the platform signed in (`agent/agent.py`),
 * so this app holds no gateway token and drives no gateway authorization.
 */
/**
 * The identity routes read `readIdentitySurface`, not `readWebConfig`.
 *
 * Nothing in this file touches the approvals store, and `readWebConfig` throws
 * under `NODE_ENV=production` when `APPROVALS_STORE_TOKEN` is unset. Going
 * through it would make a missing approvals credential turn every sign-in into
 * a `500` — measured against the production build before this line existed:
 *
 *   GET /api/auth/signin -> 500
 *   Error: APPROVALS_STORE_TOKEN is required in production
 *
 * Same environment, same file reading it; just without a guard that belongs to
 * a credential these routes do not present.
 */
import { readIdentitySurface, signinProblems, verifierProblems, type IdentitySurface } from "../lib/config.ts";
import { clearLeg, clearSession, PENDING_FLOW_COOKIE, readLeg, readSession, SIGNIN_COOKIE, writeLeg,
  writeSession, type PendingFlow, type Session, type SigninLeg } from "./session.ts";
import { escapeHtml, notConfigured, page, redirect, verbatim } from "./pages.ts";
import { authorizeUrl, exchangeCode, fetchUserinfo, nonce, pkce, tokenExpiry, type UserinfoFailure } from "./oidc.ts";
import { knownPersona } from "./personas.ts";
import { confirmUser, flowReference, followNextUri, identityReference, loggable } from "./verifier.ts";

export const SIGNIN_PATH = "/api/auth/signin";
export const SIGNIN_CALLBACK_PATH = "/api/auth/callback";
export const VERIFY_PATH = "/api/arcade/verify";
export const SIGNOUT_PATH = "/api/auth/signout";

/**
 * Query parameters this service refuses to see on the verifier route.
 *
 * Arcade sends a verifier **exactly one** parameter — `flow_id` — measured on
 * #75 by recording the whole query string rather than reading the field we
 * expected. So a request carrying an identity hint did not come from Arcade,
 * and the only reason to send one is to have the verifier confirm a flow as
 * somebody other than the person holding the browser.
 *
 * Ignoring them would be correct — nothing here reads them — but silence is the
 * failure mode this project keeps out of its controls. A refusal is testable
 * from outside, and a log line beats an assurance that some code does not do
 * something.
 */
export const IDENTITY_PARAMS = ["user_id", "email", "sub", "login_hint"] as const;

/** A same-origin path, or the default. Never an absolute URL, and never `//host`. */
export function safeNext(value: string | null, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

/**
 * The chat, as a page a person can be sent to.
 *
 * `/` and not `/chat`: since #22 the demo's chat is on the bank's screen at
 * screen, and `/chat` says so about itself — *"the tracer bullet's bare
 * scaffold"*. Sign-in and the verifier both end here (#118): one constant,
 * exported, so two flows never put a person on two different screens after
 * doing the same kind of thing.
 *
 * The page, never `CHAT_PATH` — that is the route the browser POSTs to, and
 * sending somebody there answers them with a JSON refusal about a missing
 * prompt.
 */
export const CHAT_PAGE = "/";

function redirectUri(config: IdentitySurface, path: string): string {
  return `${config.identity.publicUrl}${path}`;
}

// ---------------------------------------------------------------------------
// Hop 0 — sign in as a person
// ---------------------------------------------------------------------------

/**
 * `GET /api/auth/signin?persona=&next=`
 *
 * **`prompt=login` on every sign-in, unconditionally.** The issue asks that
 * switching persona never silently reuse the previous persona's IdP session,
 * and the cheap version of that is to detect a switch and force re-auth only
 * then. This does it always instead: a switch that has to be detected is a
 * switch that can be missed, and the cost of being wrong is every tool call for
 * the rest of the demo being made as the wrong person while the screen says
 * otherwise. One password per sign-in is the correct price.
 *
 * The old session is cleared here rather than on the way back, so a sign-in
 * abandoned at the IdP's login page leaves this browser signed in as nobody
 * rather than still signed in as the previous persona.
 */
export async function signin(request: Request, config: IdentitySurface = readIdentitySurface()): Promise<Response> {
  const problems = signinProblems(config);
  if (problems.length > 0) return notConfigured("Sign-in", problems);

  const url = new URL(request.url);
  const headers = new Headers();
  clearSession(headers, request, config);

  const { verifier, challenge } = await pkce();
  const state = nonce();
  // The persona key is a label for the page and never an identity — an
  // unknown one is dropped rather than echoed back into a cookie.
  const persona = knownPersona(url.searchParams.get("persona"));
  const leg: SigninLeg = {
    state,
    verifier,
    next: safeNext(url.searchParams.get("next"), CHAT_PAGE),
    ...(persona ? { persona } : {}),
  };
  await writeLeg(headers, SIGNIN_COOKIE, leg, config);

  let location: string;
  try {
    location = await authorizeUrl({
      issuer: config.identity.idpIssuer,
      clientId: config.identity.idpClientId,
      redirectUri: redirectUri(config, SIGNIN_CALLBACK_PATH),
      scope: config.identity.idpScopes,
      state,
      challenge,
      prompt: "login",
    });
  } catch (cause) {
    // Discovery failed: the issuer is unreachable, or `IDP_ISSUER` is not the
    // authorization server's issuer. Say which, rather than redirect nowhere.
    return page(
      "The identity provider could not be found",
      verbatim(cause instanceof Error ? cause.message : String(cause)),
      502,
      headers,
    );
  }
  return redirect(location, headers);
}

/**
 * What to tell someone whose sign-in got as far as a token and no further.
 *
 * This page used to say "The identity provider returned no email" whatever had
 * happened — including the live 429 that made #166, where the provider said
 * nothing whatsoever about email and the token exchange one step earlier had
 * succeeded. A fault surface that asserts something that did not occur sends
 * whoever reads it to look at the wrong thing: #151 was the same mistake, and
 * the body underneath was carrying the real answer the whole time.
 *
 * `fetchUserinfo` already knows which of the three things happened. This turns
 * that into the sentence at the top of the page.
 */
function userinfoFailurePage(userinfo: {
  failure: UserinfoFailure;
  status: number;
}): { title: string; explanation: string } {
  if (userinfo.failure === "no-email-claim") {
    return {
      title: "The identity provider returned no email",
      explanation:
        "<p>The provider answered, and the account it described carries no <code>email</code>. " +
        "Sign-in needs one: the email is the identity every other part of this demo joins on.</p>",
    };
  }

  if (userinfo.failure === "unreadable") {
    return {
      title: "The identity provider's answer could not be read",
      explanation:
        `<p>The userinfo endpoint answered ${userinfo.status}, and the body was not JSON. ` +
        "It is shown below exactly as it arrived.</p>",
    };
  }

  if (userinfo.status === 429) {
    return {
      title: "The identity provider is refusing requests for now",
      explanation:
        "<p>Your password was accepted and the token exchange succeeded — the last step, reading " +
        "your email back from the userinfo endpoint, was turned away with <strong>429 Too " +
        "Many Requests</strong>. That is the provider throttling this application, not anything " +
        "about your account.</p>" +
        "<p>It clears on its own. Closing any open loan screens makes it clear sooner, because " +
        "they are what fills the quota (#166). Then sign in again.</p>",
    };
  }

  return {
    title: `The identity provider refused to say who you are (HTTP ${userinfo.status})`,
    explanation:
      "<p>Your password was accepted and the token exchange succeeded; the request that reads your " +
      "email back from the userinfo endpoint was refused. What it answered is below.</p>",
  };
}

/**
 * `GET /api/auth/callback?code&state`
 *
 * Establishes the session, then does one of three things: completes a parked
 * Arcade verification, reports that a parked one expired, or carries on to
 * where the sign-in was headed (the home page, unless it said otherwise).
 */
export async function signinCallback(request: Request, config: IdentitySurface = readIdentitySurface()): Promise<Response> {
  const problems = signinProblems(config);
  if (problems.length > 0) return notConfigured("Sign-in", problems);

  const url = new URL(request.url);
  const leg = await readLeg<SigninLeg>(request, SIGNIN_COOKIE, config);
  const headers = new Headers();
  clearLeg(headers, SIGNIN_COOKIE, config);

  if (!leg) {
    return page(
      "This sign-in did not start here",
      "<p>The request that brought you back has no sign-in in progress on this browser. " +
        "It may have taken more than ten minutes, or this may be a link from somewhere else.</p>" +
        `<p><a href="/">Start again</a>.</p>`,
      400,
      headers,
    );
  }

  const error = url.searchParams.get("error");
  if (error) {
    return page(
      "The identity provider refused",
      verbatim(`${error}: ${url.searchParams.get("error_description") ?? ""}`),
      400,
      headers,
    );
  }
  // A state that does not match is a callback this browser did not ask for.
  if (url.searchParams.get("state") !== leg.state) {
    return page(
      "This sign-in did not start here",
      "<p>The <code>state</code> on the callback is not the one this browser issued.</p>",
      400,
      headers,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) return page("No authorization code", "<p>The callback carried no <code>code</code>.</p>", 400, headers);

  let exchanged: Awaited<ReturnType<typeof exchangeCode>>;
  let userinfo: Awaited<ReturnType<typeof fetchUserinfo>>;
  try {
    exchanged = await exchangeCode({
      issuer: config.identity.idpIssuer,
      clientId: config.identity.idpClientId,
      clientSecret: config.identity.idpClientSecret,
      redirectUri: redirectUri(config, SIGNIN_CALLBACK_PATH),
      code,
      codeVerifier: leg.verifier,
    });
    if (!exchanged.ok) {
      return page("Token exchange failed", verbatim(`${exchanged.status} ${exchanged.body}`), 502, headers);
    }
    userinfo = await fetchUserinfo(config.identity.idpIssuer, exchanged.token.access_token);
  } catch (cause) {
    return page(
      "The identity provider could not be found",
      verbatim(cause instanceof Error ? cause.message : String(cause)),
      502,
      headers,
    );
  }
  if (!userinfo.ok) {
    const { title, explanation } = userinfoFailurePage(userinfo);
    return page(title, explanation + verbatim(`${userinfo.status} ${userinfo.body}`), 502, headers);
  }

  // The bearer is kept, not dropped (#157). The loan module derives the actor
  // from it at the userinfo endpoint — the same endpoint that just named this
  // person — so the bank's own screens read the loan book as them and not as a
  // service account. `refresh_token` is present only when `IDP_SCOPES` asked
  // for `offline_access`; `session.ts` records what that costs.
  const session: Session = {
    email: userinfo.email,
    signed_in_at: Date.now(),
    idp: {
      access_token: exchanged.token.access_token,
      ...(exchanged.token.refresh_token ? { refresh_token: exchanged.token.refresh_token } : {}),
      expires_at: tokenExpiry(exchanged.token),
    },
  };
  await writeSession(headers, request, session, config);

  // A sign-in that an Arcade verification parked: finish that, not the
  // ordinary landing. The flow cookie is this browser's, sealed, and holds
  // nothing but the id Arcade sent.
  const pending = await readLeg<PendingFlow>(request, PENDING_FLOW_COOKIE, config);
  if (pending?.flow_id) {
    clearLeg(headers, PENDING_FLOW_COOKIE, config);
    return completeVerification(pending.flow_id, session.email, config, headers);
  }
  if (leg.next === VERIFY_PATH) {
    // The sign-in was started *by* the verifier and the parked flow is gone —
    // the ten minutes ran out, or the cookie was dropped. Say so. Arcade's
    // authorization is still half-open and the tool will ask again; what must
    // not happen is this browser landing on a cheerful home page as though the
    // authorization had completed.
    clearLeg(headers, PENDING_FLOW_COOKIE, config);
    return page(
      "That authorization request expired",
      `<p>You are signed in as <code>${escapeHtml(session.email)}</code>, but the tool authorization ` +
        "that sent you here was parked more than ten minutes ago and is no longer held on this browser.</p>" +
        "<p>Ask the agent for the same tool again — Arcade will start a fresh authorization, and this " +
        "time you are already signed in, so it will complete without another password.</p>",
      410,
      headers,
    );
  }

  return redirect(leg.next, headers);
}

/** `POST /api/auth/signout` — forget the persona and the IdP token with it. */
export function signout(request: Request, config: IdentitySurface = readIdentitySurface()): Response {
  const headers = new Headers();
  clearSession(headers, request, config);
  clearLeg(headers, SIGNIN_COOKIE, config);
  clearLeg(headers, PENDING_FLOW_COOKIE, config);
  return redirect("/", headers);
}

/**
 * Every token this browser's sealed session holds, for the chat to withhold
 * from what it shows of a tool call (#37).
 *
 * Here because this file is the one audited reader of a stored token
 * (`app-test/studio-entry.test.ts`, "one token seam"). The chat gets the
 * values to match against and nothing to present anywhere.
 * `app-test/chat-leak-probes.test.ts` builds a session with every token field
 * filled, typed so that a new field cannot be left out, and fails if one is
 * missing here.
 */
export function sessionSecrets(session: Session): string[] {
  return [session.idp?.access_token, session.idp?.refresh_token].filter((value): value is string => typeof value === "string" && value !== "");
}

// ---------------------------------------------------------------------------
// Hop 2 — the custom verifier
// ---------------------------------------------------------------------------

/**
 * `GET /api/arcade/verify?flow_id=…`
 *
 * The identity comes from this browser's sealed session and from nowhere else.
 * There is no branch in this function that reads a persona from the request,
 * and a request that carries one is refused rather than quietly served.
 */
export async function verify(request: Request, config: IdentitySurface = readIdentitySurface()): Promise<Response> {
  const url = new URL(request.url);

  const smuggled = IDENTITY_PARAMS.filter((name) => url.searchParams.has(name));
  if (smuggled.length > 0) {
    return page(
      "This route does not take an identity",
      `<p>The request carried ${escapeHtml(smuggled.join(", "))}. Arcade calls this route with ` +
        "<code>flow_id</code> and nothing else, and the person a flow is confirmed as is read from " +
        "this browser's signed-in session — never from the request.</p>",
      400,
    );
  }

  const flowId = url.searchParams.get("flow_id");
  if (!flowId) {
    return page(
      "No flow_id",
      "<p>Arcade calls this route as <code>/api/arcade/verify?flow_id=…</code>.</p>",
      400,
    );
  }

  const problems = verifierProblems(config);
  if (problems.length > 0) return notConfigured("The custom verifier", problems);

  const session = await readSession(request, config);
  if (!session) {
    // The human's case, and expected on every fresh Chrome profile. Park the
    // flow — sealed, so the id is not readable or forgeable in the browser —
    // and send them to sign in. `next` is the verify path so the callback can
    // tell a sign-in that owes an authorization from one that does not.
    const headers = new Headers();
    await writeLeg(headers, PENDING_FLOW_COOKIE, { flow_id: flowId, parked_at: Date.now() } satisfies PendingFlow, config);
    return redirect(`${SIGNIN_PATH}?next=${encodeURIComponent(VERIFY_PATH)}`, headers);
  }

  return completeVerification(flowId, session.email, config, new Headers());
}

/**
 * The two server-side calls, in the one order that finalises a grant, and then
 * the one place the browser may be sent afterwards.
 *
 * Shared by the with-session path and the signed-in-just-now path, so the
 * parked flow completes through exactly the same code as an ordinary one —
 * which is why #100's double exchange had to be fixed in exactly one function
 * to be fixed on both routes.
 */
export async function completeVerification(
  flowId: string,
  email: string,
  config: IdentitySurface,
  headers: Headers,
): Promise<Response> {
  const confirmed = await confirmUser({
    cloudUrl: config.identity.cloudUrl,
    apiKey: config.arcadeApiKey,
    flowId,
    email,
  });
  if (!confirmed.ok) {
    return page(
      "Arcade would not confirm this authorization",
      `<p>Confirming the flow as <code>${escapeHtml(email)}</code> answered ` +
        `<code>${confirmed.status}</code>.</p>${verbatim(confirmed.body)}` +
        "<p>Nothing was authorized. The tool will ask again.</p>",
      502,
      headers,
    );
  }

  const next = typeof confirmed.response.next_uri === "string" ? confirmed.response.next_uri : undefined;
  if (!next) {
    return page(
      "Verified",
      `<p>Confirmed <code>${escapeHtml(email)}</code>, but Arcade returned no <code>next_uri</code>, ` +
        "so there is nothing to finalise the grant against.</p>" +
        `<p><a href="${CHAT_PAGE}">Back to the chat</a>.</p>`,
      200,
      headers,
    );
  }

  // Measured on #75: Arcade does not finalise the grant until something fetches
  // this. A 303 the browser follows is not enough — a scripted agent, a
  // prefetch-blocking extension or a closed tab leaves the grant half-made and
  // the tool re-challenging with nothing on screen to say why.
  const followed = await followNextUri(next);
  // #100: this line did not exist, and its absence is most of why the bug took
  // three sittings. The status and the continuation were computed and thrown
  // away, so the one place that could have said "the server already walked this
  // leg, and here is where it ended" said nothing at all. Neither value is a
  // credential; `loggable` keeps it that way by printing parameter names only.
  console.info(
    `[verifier] hop2 finalized flow_ref=${flowReference(flowId)} ` +
      `persona_ref=${identityReference(email)} next_uri answered ${followed.status}, ` +
      `location ${loggable(followed.location)}`,
  );

  // And the browser stays here. `followed.location` is read for the log line
  // above and used for nothing else (#118).
  //
  // #100 established the half of this that is not negotiable: the browser must
  // never be sent to `next_uri`, because the server fetch has already redeemed
  // that authorization code at the identity provider, and a provider that
  // follows RFC 6749 §4.1.2 answers the replay with `invalid_grant` *and* may
  // revoke the tokens the first exchange minted (the bundled Better Auth did,
  // measured on #100); the grant is destroyed rather than merely unfinished, and
  // `get_loan` fails at `userinfo` a turn later. #100 then forwarded Arcade's
  // `Location` instead, with a guard to catch the cases where that `Location`
  // was `next_uri` written differently.
  //
  // #118 removes the fork rather than the guard. Forwarding Arcade's
  // continuation was safe once the guard was right, but it ended hop 2 on
  // Arcade's domain — a screen this demo does not own, with no route back to
  // the chat the person left. The grant is finalised by the server fetch alone
  // (measured on #75), so the continuation buys nothing the app needs. One
  // target, no guard, no branch that can be wrong: a redirect the code cannot
  // emit is a redirect nobody has to reason about.
  return verifiedPage(email, headers);
}

/**
 * The end of hop 2, on every path (#118).
 *
 * A blank 200 would be indistinguishable from a route that did nothing, and
 * this is the screen a human sees at the exact moment they are wondering
 * whether the authorization worked. It names the persona, because binding the
 * grant to the wrong one is the failure mode hop 2 exists to prevent.
 *
 * The link is `CHAT_PAGE`, a constant, and not a return path read off this
 * request: Arcade calls this route with `flow_id` and nothing else (measured,
 * #75), so anything on the query string claiming to be a return target did not
 * come from Arcade. The demo has one chat page, which is what makes a constant
 * the whole answer rather than a simplification.
 */
function verifiedPage(email: string, headers: Headers): Response {
  return page(
    "Authorized",
    `<p>This tool is now authorized as <code>${escapeHtml(email)}</code>.</p>` +
      `<p><a href="${CHAT_PAGE}">Back to the chat</a> — ask the agent for the same thing again.</p>`,
    200,
    headers,
  );
}
