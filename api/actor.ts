/**
 * Who is calling. Derived from the bearer token and from nothing else.
 *
 * The API never takes an actor as a parameter: a request body that named its
 * own author would be one the caller could write anything into. Instead the
 * token is presented to the identity provider that issued it, and the email
 * the provider hands back is the actor. That is the same endpoint Arcade
 * itself identifies the user from, so the `user_id` the control plane governs
 * and the actor this service records are the same string by construction.
 *
 * Addresses are case-insensitive, so the one the provider returns is folded to
 * lower case before it is recorded (#58). Two systems that spell the same
 * person `Alice@…` and `alice@…` join on neither, and the
 * decision history would then describe two people where there is one.
 *
 * This is validation, not decision-making: a token either names someone or it
 * does not. What that someone may do is not asked here.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

const userinfoSchema = z.object({ email: z.string().email() }).passthrough();

/**
 * A request that could not be attributed to anyone. 401 when the token is the
 * problem; 503 when the identity provider is, so that an outage upstream
 * reads as an outage and not as every caller's credentials failing at once.
 */
/**
 * Did the provider refuse the **token**, or refuse the **request**?
 *
 * 401 and 403 are the two answers that are about the bearer: OAuth 2.0 Bearer
 * Token Usage (RFC 6750 §3.1) spends `invalid_token` on 401 and
 * `insufficient_scope` on 403, and both mean the credential presented will not
 * work again as it stands. Every other status — 429, 500, 502, 503 — is the
 * provider saying something about itself, and says nothing at all about this
 * token.
 */
function tokenRefused(status: number): boolean {
  return status === 401 || status === 403;
}

export class ActorError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 503 = 401,
  ) {
    super(message);
  }
}

/**
 * Where the issuer's userinfo endpoint is, read from its OIDC discovery
 * document (`$IDP_ISSUER/.well-known/openid-configuration`) once per issuer
 * and kept. On Okta that is `.../oauth2/default/v1/userinfo`; nothing here
 * spells it, so any OIDC provider works.
 *
 * Its own small copy rather than `auth/discovery.ts`: the loan module imports
 * nothing from the app. A failed read is not kept, so a provider that was
 * down for a minute is retried on the next request.
 */
const userinfoEndpoints = new Map<string, Promise<string>>();

export function userinfoEndpoint(issuer: string): Promise<string> {
  const key = issuer.trim().replace(/\/+$/, "");
  const held = userinfoEndpoints.get(key);
  if (held) return held;
  const pending = (async () => {
    if (!key) throw new Error("IDP_ISSUER is not set");
    const response = await fetch(`${key}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`discovery answered ${response.status}`);
    const document = (await response.json()) as { userinfo_endpoint?: unknown };
    if (typeof document.userinfo_endpoint !== "string" || document.userinfo_endpoint === "") {
      throw new Error("the discovery document has no userinfo_endpoint");
    }
    return document.userinfo_endpoint;
  })();
  userinfoEndpoints.set(key, pending);
  pending.catch(() => userinfoEndpoints.delete(key));
  return pending;
}

/** Drop every discovered endpoint. Used by tests that point one process at many issuers. */
export function forgetUserinfoEndpoints(): void {
  userinfoEndpoints.clear();
}

// ---------------------------------------------------------------------------
// Remembering a resolution
// ---------------------------------------------------------------------------

/**
 * How long one token→email answer is reused, in milliseconds.
 *
 * The arithmetic, measured on the live deployment (#166). The bank's own
 * screens poll this API every 2 seconds and there are two of them — `/` and
 * the `/loans` board on a presenter's second display — so a single signed-in
 * person costs 2 × 30 = 60 introspections a minute, and each one is a request
 * the identity provider counts. Reusing an answer for T milliseconds turns
 * that into one call per T per person: at T = 60_000 it is 60/min → 1/min,
 * 59 of every 60 calls gone.
 *
 * **Why the provider's rate is the constraint.** The bundled identity
 * provider this app shipped before Okta allowed 60 userinfo calls per
 * 60-second window, measured 2026-09-18, and a 2-second poll ratcheted into
 * that ceiling within a minute and stopped sign-in, which reads the same
 * endpoint (#166). Okta meters its userinfo endpoint per org as well, so the
 * same arithmetic holds there: one remembered answer per person per minute
 * keeps a lone signed-in person at one call a minute, whatever the screens
 * poll. A longer T would trade more staleness for headroom; one minute is the
 * staleness this file promises.
 *
 * **Staleness bound.** An answer may be up to {@link RESOLUTION_TTL_MS}
 * milliseconds — 60 seconds — older than the moment it is used. A token
 * revoked or expired at the provider therefore keeps naming its owner here for
 * at most one minute. Two things keep that bound from mattering:
 *
 *  1. Only reads are answered from memory. Anything that writes to the loan
 *     book asks the provider afresh, so no state changes on the strength of a
 *     remembered token — see {@link actorFromRequest}.
 *  2. A fresh answer replaces the remembered one, and a refusal erases it, so
 *     the first write after a revocation both fails and clears the reads.
 *
 * This is memoisation, not a session: nothing here decides anything, and the
 * worst it can do is attribute a read of the loan book to the person who was
 * holding that exact token up to a minute ago.
 */
export const RESOLUTION_TTL_MS = 60_000;

/**
 * How many resolutions are held at once. Four personas and a handful of
 * reissued tokens is the real working set; this is three orders of magnitude
 * above it, and exists so that a long-running process with a churn of tokens
 * cannot grow without bound. Oldest insertion goes first.
 */
const MAX_REMEMBERED = 512;

/**
 * Per-process, so a digest taken from this map means nothing anywhere else and
 * nothing survives a restart. Salting costs one `randomBytes` at boot.
 */
const digestSalt = randomBytes(32);

/**
 * What a remembered answer is filed under.
 *
 * Never the bearer itself. A map of live access tokens in process memory is a
 * credential store nobody designed and nobody is guarding: anything that can
 * read a heap dump, a debugger, or a careless log of this map would walk away
 * with working credentials. A salted SHA-256 digest is enough to recognise the
 * same token again and is worth nothing to whoever reads it.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(digestSalt).update(token).digest("hex");
}

interface Remembered {
  email: string;
  expiresAt: number;
}

const remembered = new Map<string, Remembered>();

/**
 * The keys currently held, so that "never the raw token" is something a test
 * measures rather than something this comment claims.
 */
export function rememberedKeys(): string[] {
  return [...remembered.keys()];
}

/** Drop everything. Used by tests to start from a known state. */
export function forgetRememberedActors(): void {
  remembered.clear();
}

function recall(key: string, now: number): string | undefined {
  const hit = remembered.get(key);
  if (hit === undefined) return undefined;
  if (now >= hit.expiresAt) {
    remembered.delete(key);
    return undefined;
  }
  return hit.email;
}

function remember(key: string, email: string, now: number): void {
  // Re-inserting moves the key to the end, which is what makes the eviction
  // below "oldest first" rather than "whatever Map happened to hold".
  remembered.delete(key);
  remembered.set(key, { email, expiresAt: now + RESOLUTION_TTL_MS });
  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next();
    if (oldest.done === true) break;
    remembered.delete(oldest.value);
  }
}

// ---------------------------------------------------------------------------

/**
 * The email this request's bearer names.
 *
 * A read may be answered from the last minute's resolution; anything else asks
 * the identity provider. Nothing but a successful resolution is ever kept — a
 * 401, a 429 or an unreachable provider is passed straight to the caller and
 * erases whatever was held for that token, because remembering a refusal would
 * turn a provider having a bad minute into an outage that outlives it.
 *
 * `now` is a parameter so that the expiry is testable without waiting a minute
 * of wall clock; nothing in the service passes it.
 */
export async function actorFromRequest(
  request: Request,
  idpIssuer: string,
  now: number = Date.now(),
): Promise<string> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (match === null) throw new ActorError("A bearer token is required.");

  const key = tokenFingerprint(match[1]!);
  // A request that changes the loan book is resolved against the provider
  // every time. Reads are what the bank's screens poll, so they are where all
  // the traffic is, and a read is also the only thing a minute-old answer can
  // get wrong cheaply.
  const mayReuse = request.method === "GET" || request.method === "HEAD";
  if (mayReuse) {
    const known = recall(key, now);
    if (known !== undefined) return known;
  }

  let response: Response;
  try {
    response = await fetch(await userinfoEndpoint(idpIssuer), {
      headers: { authorization: `Bearer ${match[1]}` },
    });
  } catch (cause) {
    remembered.delete(key);
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new ActorError(`The identity provider could not be reached: ${why}`, 503);
  }

  if (!response.ok) {
    remembered.delete(key);
    // Which of the two it is matters to whoever reads the answer. "The
    // provider says this bearer is no good" and "the provider would not answer
    // just now" have different recoveries — one is a fresh sign-in or a fresh
    // grant, the other is waiting — and collapsing them meant a provider
    // having a bad minute was reported as a bad token. #167 made the same
    // split on the other side of this call; this is the same fix one service
    // down (#123).
    throw tokenRefused(response.status)
      ? new ActorError("The identity provider rejected the token.")
      : new ActorError(
          `The identity provider answered ${response.status} and did not say whether this ` +
            "token is still good.",
          503,
        );
  }

  const parsed = userinfoSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    remembered.delete(key);
    throw new ActorError("The token does not identify an email address.");
  }

  const email = parsed.data.email.trim().toLowerCase();
  remember(key, email, now);
  return email;
}
