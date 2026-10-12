/**
 * What the web service reads from its environment, in one place.
 *
 * Every address here is HOST-form (`host` or `host:port`), never a URL: the
 * consumer adds the scheme, and `baseUrl` is the one place that decides which.
 * The cross-service keys are set by hand, never derived: the stage demo's
 * deployment once derived them and got the bare service name rather than the
 * hostname, which #59 has the measurement for.
 * `public-host.ts` refuses a value that still looks like one.
 *
 * Nothing here is `NEXT_PUBLIC_`, deliberately. `next build` inlines those into
 * the client bundle while the hosting platform supplies env vars at runtime, so a
 * `NEXT_PUBLIC_` twin would be empty in production and fine under `next dev` —
 * the worst possible failure mode. Server components read this and pass what
 * the browser needs down as props.
 */
import { publicHost } from "./public-host.ts";
import { sessionSecretProblem } from "../auth/seal.ts";

/**
 * Who the browser is signed in as, and the OAuth hop that follows from it.
 *
 * `DESIGN.md` → **Identity**. Everything here
 * is read from the environment and none of it has a development fallback: an
 * identity provider you can reach without configuring one is a fixture that
 * would eventually be mistaken for a login. `/health` reports which of the
 * two capabilities the environment actually configured, so an unset variable
 * is visible before somebody discovers it mid-rehearsal.
 *
 * `idpIssuer` and `publicUrl` are **URLs**, not the HOST-form the cross-service
 * keys above use. They are origins a browser is redirected to and an OAuth
 * `redirect_uri` that has to match an allowlist byte for byte, so the scheme is
 * part of the value rather than something a consumer adds.
 */
export interface IdentityConfig {
  /**
   * `IDP_ISSUER`: the identity provider's OAuth issuer, no trailing slash. An
   * Okta custom authorization server in the workshop
   * (`https://<org>.okta.com/oauth2/default`). Every endpoint is read from its
   * discovery document (`auth/discovery.ts`), never spelled here.
   */
  idpIssuer: string;
  /** The Okta Web app's client id and secret, shared with the two registrations Arcade holds. */
  idpClientId: string;
  idpClientSecret: string;
  /** What sign-in asks for. `email` is the join key, so it is not optional. */
  idpScopes: string;
  /** Seals the session cookie. No fallback — see `auth/seal.ts`. */
  sessionSecret: string;
  /**
   * This app's own public origin, no trailing slash. Every redirect_uri is
   * built from it. `appOrigin` since #6; it was `PUBLIC_URL`.
   */
  publicUrl: string;
  /**
   * Whether `APP_PUBLIC_HOST` is set, rather than `publicUrl` being the
   * localhost fallback. The sign-in and the verifier refuse to run on the
   * fallback: a deployment that forgot the variable would otherwise send
   * `http://localhost:3000/...` redirect URIs, and the failure would land at
   * Arcade, where no hook fires.
   */
  publicHostConfigured: boolean;
  /**
   * Arcade Cloud, which is a different host from `arcadeApiUrl`.
   *
   * `confirm_user` is `https://cloud.arcade.dev/api/v1/oauth/confirm_user`
   * (measured, spike #75) while tools execute against `api.arcade.dev`. One
   * variable for each, because pointing a test at a stand-in has to move the
   * verifier's calls without moving the Engine's.
   */
  cloudUrl: string;
  /**
   * `ARCADE_GATEWAY_ID`: the slug of the MCP gateway `bun run setup-arcade
   * --gateway` registered, or `""`. Optional, and the agent never reads it:
   * it calls the Engine directly. Set, the home page shows how to connect an
   * MCP client such as Claude Code to the same tools under the same hooks
   * (`components/identity/McpClientPanel.tsx`, `docs/modules/03-govern.md`).
   */
  gatewayId: string;
}

/** Where an MCP client connects to the gateway, `<Engine>/mcp/<slug>`, or `null` with no gateway. The same URL `setup-arcade` prints. */
export function gatewayUrl(config: IdentitySurface): string | null {
  return config.identity.gatewayId === "" ? null : `${config.arcadeApiUrl}/mcp/${config.identity.gatewayId}`;
}

export interface WebConfig {
  /**
   * The control plane's public address: `APP_PUBLIC_HOST` since #6, the host
   * the deployed approvals toolkit and the panel's browser reach it at. The
   * app itself since #4 (`gate/service/`). Validated here; this server
   * never reads the control plane through it (see `controlPlaneHost`).
   */
  hooksHost: string;
  /**
   * Where **this server** reads the control plane: the panel's status strip,
   * the Reset button, the approval page and the resume path. Since #4 that is
   * the app's own local listener, `localhost:$PORT`, so a server-side read
   * never leaves the machine through the public tunnel `APP_PUBLIC_HOST`
   * names. `CONTROL_PLANE_HOST` overrides it, which the test harnesses do when
   * they point the app at `scripts/control-plane.ts` on a port of its own.
   */
  controlPlaneHost: string;
  /** The shared bearer the `/approvals` endpoints require. */
  approvalsStoreToken: string;
  /** Arcade's API root. Overridden in tests by a stand-in. */
  arcadeApiUrl: string;
  arcadeApiKey: string;
  /** `tool.toolkit` as Arcade files the deployed approvals toolkit. */
  toolkit: string;
  /** Sign-in and the custom verifier route. */
  identity: IdentityConfig;
}

/**
 * The value `apps/hooks` falls back to when `APPROVALS_STORE_TOKEN` is unset
 * and it is not running in production — see `DEV_STORE_TOKEN` in
 * `gate/service/config.ts`.
 *
 * Duplicated rather than imported because `apps/web` does not depend on
 * `apps/hooks` in the package graph and should not start to. The cost of a
 * duplicated literal is drift, so `app-test/config.test.ts` reads the other file
 * and fails if the two ever disagree — which is a cheaper guarantee than a
 * dependency edge between the governed UI and the control plane.
 *
 * Without this fallback a clean checkout renders the approval page as "nothing
 * to decide": the store answers `401`, the page has no request to show, and
 * nothing on screen says the cause is an unset variable. That is the whole of
 * what it buys, and it must buy nothing in production — see the guard below.
 */
const DEV_STORE_TOKEN = "cg-approvals-store-dev-token-not-for-production";

/**
 * The identity-shaped part of the environment, read **without** the
 * `APPROVALS_STORE_TOKEN` guard.
 *
 * Its own function for one reason. `/health` and the home page both need to
 * report whether identity is configured, and neither has anything to do with
 * the approvals store — so going through `readWebConfig` would make a missing
 * approvals token take down the landing page and the health endpoint of a
 * production deployment, for a credential neither of them uses. `/health` in
 * particular must answer `200` whatever else is wrong; a health check that
 * fails on a misconfiguration removes the service instead of reporting it.
 *
 * Still one place reading the environment — this file — and `readWebConfig`
 * builds on it rather than repeating it.
 */
export type IdentitySurface = Pick<WebConfig, "identity" | "arcadeApiUrl" | "arcadeApiKey">;

/**
 * Every secret this configuration holds (#37). Declared here, beside the
 * fields, so a new secret is added where it is defined.
 */
export function configSecrets(config: IdentitySurface & Partial<Pick<WebConfig, "approvalsStoreToken">>): string[] {
  return [
    config.arcadeApiKey,
    config.identity.idpClientSecret,
    config.identity.sessionSecret,
    config.approvalsStoreToken,
  ].filter((value): value is string => typeof value === "string" && value !== "");
}

export function readIdentitySurface(
  env: Record<string, string | undefined> = process.env,
): IdentitySurface {
  return {
    arcadeApiUrl: trimUrl(env.ARCADE_API_URL) || "https://api.arcade.dev",
    arcadeApiKey: env.ARCADE_API_KEY?.trim() ?? "",
    identity: {
      idpIssuer: trimUrl(env.IDP_ISSUER),
      idpClientId: env.IDP_CLIENT_ID?.trim() ?? "",
      idpClientSecret: env.IDP_CLIENT_SECRET?.trim() ?? "",
      // `openid` for an ID token, `email` because the address is the join key
      // across Arcade, the OAuth subject and the loan book (DESIGN.md rule 3).
      idpScopes: env.IDP_SCOPES?.trim() || "openid email",
      sessionSecret: env.SESSION_SECRET?.trim() ?? "",
      publicUrl: appOrigin(env),
      publicHostConfigured: !appPublicHostIsFallback(env),
      cloudUrl: trimUrl(env.ARCADE_CLOUD_URL) || "https://cloud.arcade.dev",
      gatewayId: env.ARCADE_GATEWAY_ID?.trim() ?? "",
    },
  };
}

export function readWebConfig(env: Record<string, string | undefined> = process.env): WebConfig {
  const storeToken = env.APPROVALS_STORE_TOKEN?.trim();
  // Same guard, same wording, as `gate/service/config.ts`. Round 3 of #52's
  // review caught it missing here: the control plane refused to boot without a
  // real token while the service that *presents* it fell back to a value
  // published in this file, so a production `apps/web` would have gone on
  // authenticating to the approvals store with a token anyone can read — and
  // gone on doing it quietly, because the fallback works locally.
  //
  // A convenience that only applies outside production is a convenience. One
  // that survives into production is a credential.
  if (!storeToken && env.NODE_ENV === "production") {
    throw new Error("APPROVALS_STORE_TOKEN is required in production");
  }

  return {
    // Refuses a bare service name outright — `public-host.ts` has the measured
    // story. The panel reads this in a server component and hands it to the
    // browser, so a host nothing can resolve fails in a visitor's DevTools.
    // The app's own address since #4: the control plane is a module of this
    // app. One variable for it since #6, `APP_PUBLIC_HOST`.
    hooksHost: appPublicHost(env),
    controlPlaneHost: publicHost(
      "CONTROL_PLANE_HOST",
      env.CONTROL_PLANE_HOST,
      `localhost:${env.PORT?.trim() || "3000"}`,
    ),
    approvalsStoreToken: storeToken || DEV_STORE_TOKEN,
    toolkit: env.ARCADE_TOOLKIT?.trim() || "LoanDesk",
    ...readIdentitySurface(env),
  };
}

/** A configured origin with any trailing slashes removed, so concatenation is safe. */
function trimUrl(value: string | undefined): string {
  return (value?.trim() ?? "").replace(/\/+$/, "");
}

/**
 * What `/health` reports, and what each route refuses to run without.
 *
 * Two capabilities rather than one flag, because they fail independently and
 * the person reading `/health` is trying to find out which human step is
 * outstanding. Sign-in needs client C, and the verifier needs the Arcade
 * project API key, which nothing else here uses. There is no gateway to
 * configure: the agent calls the Engine directly with the project key, and the
 * project's hooks govern every call (`DESIGN.md` → Integration). The agent is not one of them: it is the
 * Deep Agent in `agent/`, and its model key lives in its own environment.
 *
 * A control that silently does nothing is worse than no control, and a
 * half-configured identity is exactly that: the browser gets a persona label
 * and every tool call is made as somebody else. So each of these is checked at
 * the edge of the route that needs it and reported as `missing` here.
 *
 * **`missing` covers unusable as well as unset.** Round 1 of #84's review set
 * `SESSION_SECRET=x` and got `{"signin":"configured"}` and a working sign-in —
 * a session cookie holding two bearer tokens, sealed under a key anybody could
 * guess, with every surface saying the deployment was fine. A capability that
 * reports itself configured on a value it cannot safely use is the silent
 * control this project exists to argue against, so the same check that decides
 * whether a key may be derived decides what this function reports.
 */
export interface DeploymentReadiness {
  /**
   * `degraded` whenever either of the two below is `missing`, `ok` only when
   * both are configured.
   *
   * Round 2 of #84's review ran a cg-web with sign-in configured and one
   * capability unset and got `{"status":"ok", …}` with `missing` further down.
   * The top-level word is the one anybody actually reads — it is the first
   * field, it is what the other three services answer, and it is what somebody
   * greps for — so a deployment that cannot make a tool call was describing
   * itself as fine.
   *
   * **Still HTTP 200.** A platform health check takes a non-200 as a dead
   * instance and stops the deploy, and an instance that will not come up is an
   * instance whose `/health` nobody can read. The whole point of this endpoint
   * is to be readable while something is wrong, so the refusal belongs in the
   * body and the routes, not in the status line. CI asks the same question with
   * `curl -fsS`, and it keeps passing.
   */
  status: "ok" | "degraded";
  signin: "configured" | "missing";
  verifier: "configured" | "missing";
  /**
   * Present only with `ARCADE_GATEWAY_ID`, and never `missing`: the gateway
   * is optional (`setup-arcade --gateway`), for an MCP client, and the agent
   * does not use it. Without it the field is absent rather than a word that
   * would read as a fault, and it never counts towards `status`.
   */
  gateway?: "configured";
}

export function deploymentReadiness(config: IdentitySurface): DeploymentReadiness {
  const capabilities = {
    signin: state(signinProblems(config)),
    verifier: state(verifierProblems(config)),
  } as const;
  return {
    status: Object.values(capabilities).every((each) => each === "configured") ? "ok" : "degraded",
    ...capabilities,
    ...(config.identity.gatewayId === "" ? {} : { gateway: "configured" as const }),
  };
}

function state(problems: string[]): "configured" | "missing" {
  return problems.length === 0 ? "configured" : "missing";
}

/**
 * Every problem with this environment, grouped, for the banner the home page
 * puts in front of a visitor.
 *
 * The same sentences the 503 pages render and the same ones `/health` counts —
 * one source, three surfaces. Round 2's finding was that a visitor saw none of
 * them: the page rendered its ordinary persona buttons, and the only way to
 * discover that a capability was unconfigured was to click into a flow and
 * read a 503. A control plane demo whose own UI hides its
 * misconfiguration is arguing against itself.
 */
export interface ConfigurationProblems {
  signin: string[];
  verifier: string[];
}

export function configurationProblems(config: IdentitySurface): ConfigurationProblems {
  return {
    signin: signinProblems(config),
    // Repeating a sentence under two headings is how a banner becomes
    // something people stop reading. Show only what sign-in did not already say.
    verifier: withoutAll(verifierProblems(config), signinProblems(config)),
  };
}

function withoutAll(problems: string[], already: string[]): string[] {
  return problems.filter((problem) => !already.includes(problem));
}

/** True when anything at all is wrong — what decides whether the banner renders. */
export function isMisconfigured(problems: ConfigurationProblems): boolean {
  return Object.values(problems).some((each) => each.length > 0);
}

/**
 * Everything wrong with this environment for signing somebody in, as sentences.
 *
 * Sentences rather than variable names because one of them is not a name: an
 * unusable `SESSION_SECRET` needs to say *why* it is unusable and what a good
 * one looks like, and "SESSION_SECRET" on its own would send a human to look at
 * a field that is already filled in. The route that refuses renders this list
 * and `/health` counts it, so the two can never disagree.
 */
export function signinProblems(config: IdentitySurface): string[] {
  const { identity } = config;
  const secret = sessionSecretProblem(identity.sessionSecret);
  return [
    ...(identity.publicHostConfigured ? [] : ["APP_PUBLIC_HOST is not set"]),
    ...(identity.idpIssuer ? [] : ["IDP_ISSUER is not set"]),
    ...(identity.idpClientId ? [] : ["IDP_CLIENT_ID is not set"]),
    ...(identity.idpClientSecret ? [] : ["IDP_CLIENT_SECRET is not set"]),
    ...(secret ? [secret] : []),
  ];
}

/**
 * The verifier reads the session and calls `confirm_user` with the project API
 * key. It does not need client C — a browser that already has a session never
 * reaches the IdP — but with no session it starts a sign-in, so `/health`
 * reports the two separately and this list stays the narrower one.
 */
export function verifierProblems(config: IdentitySurface): string[] {
  const secret = sessionSecretProblem(config.identity.sessionSecret);
  return [
    ...(config.identity.publicHostConfigured ? [] : ["APP_PUBLIC_HOST is not set"]),
    ...(config.arcadeApiKey ? [] : ["ARCADE_API_KEY is not set"]),
    ...(config.identity.cloudUrl ? [] : ["ARCADE_CLOUD_URL is not set"]),
    ...(secret ? [secret] : []),
  ];
}

/**
 * Whether cookies this service writes carry `Secure`.
 *
 * Derived from the app's origin rather than configured: a browser silently
 * drops a `Secure` cookie that arrives over plain http, so a local run on
 * `http://localhost:4400` with `Secure` set looks like a sign-in that succeeds
 * and then forgets. The origin is http exactly when `APP_PUBLIC_HOST` is
 * localhost or 127.0.0.1 (`baseUrl`), unset included.
 */
export function cookiesAreSecure(config: IdentitySurface): boolean {
  return !config.identity.publicUrl.startsWith("http://");
}

/**
 * `APP_PUBLIC_HOST`: the one host Arcade Cloud reaches this app at (#6).
 *
 * The ngrok host in a real run, and the one Arcade tool secret besides the
 * store token: `mcp/loan_desk/loans.py` and `mcp/loan_desk/approvals.py` read it too. It replaced
 * one host variable per service — the loan API's, the control plane's and the
 * web UI's, three services that are now one app — and the app's `PUBLIC_URL`.
 * The app's sealed session cookie and the custom verifier live on it. The
 * identity provider does not: it is Okta, at `IDP_ISSUER`.
 *
 * HOST-form like every address here. Unset, it is this process's own port on
 * localhost, which is what a local run without a tunnel wants.
 *
 * **Addressed to the outside world only.** A server-side read of the app's own
 * modules never goes through it: the tunnel would carry the app's own traffic
 * out and back in. Those reads go in-process, or to `CONTROL_PLANE_HOST`,
 * which is local. `app-test/server-side-readers.test.ts`
 * fails if one targets this host.
 */
export function appPublicHost(env: Record<string, string | undefined> = process.env): string {
  return publicHost("APP_PUBLIC_HOST", env.APP_PUBLIC_HOST, `localhost:${env.PORT?.trim() || "3000"}`);
}

/** Whether `APP_PUBLIC_HOST` is unset, so {@link appPublicHost} is the localhost fallback. */
export function appPublicHostIsFallback(env: Record<string, string | undefined> = process.env): boolean {
  return !env.APP_PUBLIC_HOST?.trim();
}

/**
 * `APP_PUBLIC_HOST` with its scheme, and no trailing slash: the app's public
 * origin and the base of every
 * `redirect_uri` this app registers. http for localhost and 127.0.0.1, https
 * for everything else (see {@link baseUrl}).
 */
export function appOrigin(env: Record<string, string | undefined> = process.env): string {
  return baseUrl(appPublicHost(env));
}

/** HOST-form to URL: http for a local address, https everywhere else. */
export function baseUrl(host: string): string {
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${host}`;
}
