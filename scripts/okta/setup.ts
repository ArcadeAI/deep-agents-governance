/**
 * What `bun run okta-setup` makes in an Okta org, each step idempotent: run it
 * twice and the second run finds everything and changes nothing, except a
 * redirect URI that was not known the first time (Arcade's provider callback,
 * which exists only once `bun run setup-arcade` has created the provider).
 *
 * 1. The `default` authorization server, read back: it must exist and be
 *    active. Its issuer becomes `IDP_ISSUER`.
 * 2. One OIDC Web app, {@link APP_LABEL}: authorization code and refresh
 *    token, client secret over HTTP Basic, consent skipped. The app, Arcade's
 *    `app-identity` provider and `agent/ask.py` all sign in through it, so its
 *    redirect URIs are the three of {@link redirectUris}.
 *    URIs it already has are kept.
 * 3. The app assigned to Everyone, so anybody in the org may sign in. What
 *    they may do is the control plane's business, in `governance.db`.
 * 4. An access policy on the `default` server that lets the app have tokens,
 *    unless one already does (Okta's own "Default Policy" usually does).
 * 5. A group, {@link USERS_GROUP}, that `bun run users` puts the people it
 *    creates in, so it can tell them from anybody else in the org.
 * 6. An app sign-in policy that asks for the password alone, so the demo cast
 *    are not walked through enrolling Okta Verify on stage. Best effort: an org
 *    that refuses it keeps its own policy, and the run says so.
 *
 * Everything goes through {@link Okta}, whose `fetch` the tests replace.
 */
import type { Okta, OktaApp, OktaGroup } from "./client.ts";

/** The app's label in the org. One app per org, found again by this label. */
export const APP_LABEL = "Loan Desk";
/** The group `bun run users` adds the people it creates to. */
export const USERS_GROUP = "Loan Desk users";
/** The custom authorization server the issuer belongs to. Every Okta org ships one called `default`. */
export const AUTH_SERVER = "default";
/** The access policy and rule this run adds when none lets the app have tokens. */
export const ACCESS_POLICY_NAME = "Loan Desk";
/** The app sign-in policy this run assigns, password only. */
export const SIGN_ON_POLICY_NAME = "Loan Desk password only";
/** Where the app's sign-in comes back to (`SIGNIN_CALLBACK_PATH` in `auth/handlers.ts`). */
export const SIGNIN_CALLBACK_PATH = "/api/auth/callback";

/**
 * Where `agent/ask.py` catches its sign-in: loopback, so the ID token it sends
 * the Deep Agent never leaves the machine that asked for it. Allowlisted on the
 * app's Okta client, whose id is the audience `agent/identity.py` checks.
 */
export const AGENT_SIGNIN_CALLBACK = "http://127.0.0.1:8765/callback";

/**
 * The redirect URIs the one app allowlists, in the order they are added:
 *
 * - the app's own sign-in, on `APP_PUBLIC_HOST`;
 * - `agent/ask.py`'s loopback catch, for the agent's ID token;
 * - Arcade's callback for the `app-identity` provider, once known.
 */
export function redirectUris(options: { origin: string | null; providerCallback: string | null }): string[] {
  return [
    ...(options.origin ? [`${options.origin}${SIGNIN_CALLBACK_PATH}`] : []),
    AGENT_SIGNIN_CALLBACK,
    ...(options.providerCallback ? [options.providerCallback] : []),
  ];
}

/** The app as `POST /api/v1/apps` creates it. */
export function appBody(redirects: string[]) {
  return {
    name: "oidc_client",
    label: APP_LABEL,
    signOnMode: "OPENID_CONNECT",
    credentials: { oauthClient: { token_endpoint_auth_method: "client_secret_basic" } },
    settings: {
      oauthClient: {
        application_type: "web",
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: redirects,
        consent_method: "TRUSTED",
      },
    },
  };
}

export interface SetupResult {
  issuer: string;
  clientId: string;
  /** Set only when this run made one: the app was created, or `.env` had none for it. */
  clientSecret: string | null;
  /** One line per thing found or made, for the run to print. */
  lines: string[];
  /** Steps that could not be done here, each with what to do in the dashboard instead. */
  warnings: string[];
}

interface Policy {
  id: string;
  name: string;
  status?: string;
  priority?: number;
  conditions?: { clients?: { include?: string[] } };
}
interface Rule {
  id: string;
  name: string;
  status?: string;
  conditions?: { people?: { groups?: { include?: string[] }; users?: { include?: string[] } }; grantTypes?: { include?: string[] }; scopes?: { include?: string[] } };
}

/**
 * Runs every step. `known` is what `.env` already holds, so a secret that is
 * there for this very app is not replaced.
 */
export async function oktaSetup(
  okta: Okta,
  options: { origin: string | null; providerCallback: string | null; known: { clientId: string; clientSecret: string } },
): Promise<SetupResult> {
  const lines: string[] = [];
  const warnings: string[] = [];

  // 1. The authorization server.
  const server = await okta.expect<{ id?: string; status?: string; issuer?: string }>("GET", `/api/v1/authorizationServers/${AUTH_SERVER}`);
  if (server.status !== undefined && server.status !== "ACTIVE") {
    throw new Error(`the ${AUTH_SERVER} authorization server is ${server.status}. Activate it: Security → API → Authorization Servers`);
  }
  const issuer = (typeof server.issuer === "string" && server.issuer !== "" ? server.issuer : `${okta.orgUrl}/oauth2/${AUTH_SERVER}`).replace(/\/+$/, "");
  lines.push(`authorization server: ${AUTH_SERVER}, active, issuer ${issuer}`);

  // 2. The app, and its redirect URIs.
  const wanted = redirectUris(options);
  let app = await okta.findApp(APP_LABEL);
  let clientSecret: string | null = null;
  if (app === null) {
    app = await okta.createApp(appBody(wanted));
    clientSecret = app.credentials?.oauthClient?.client_secret ?? null;
    lines.push(`app: created ${APP_LABEL} (${app.id}), with ${wanted.length} redirect URIs`);
  } else {
    lines.push(`app: found ${APP_LABEL} (${app.id})`);
    const updated = withRedirectsAndGrants(app, wanted);
    if (updated.added.length > 0 || updated.grantsAdded.length > 0) {
      app = await okta.updateApp(updated.app);
      for (const uri of updated.added) lines.push(`  redirect URI added: ${uri}`);
      for (const grant of updated.grantsAdded) lines.push(`  grant type added: ${grant}`);
    } else {
      lines.push(`  its ${wanted.length} redirect URIs are already there`);
    }
  }
  const clientId = app.credentials?.oauthClient?.client_id ?? "";
  if (clientId === "") throw new Error(`Okta answered with no client id for the app ${app.id}`);
  if (app.status !== undefined && app.status !== "ACTIVE") warnings.push(`the app ${APP_LABEL} is ${app.status}: activate it in Applications → Applications`);

  if (clientSecret === null && !(options.known.clientId === clientId && options.known.clientSecret !== "")) {
    clientSecret = await okta.newClientSecret(app.id);
    lines.push("  a new client secret was made for it, because .env has none for this app");
  }

  // 3. Everyone may sign in.
  const everyone = await everyoneGroup(okta);
  const assigned = await okta.appGroups(app.id);
  if (assigned.includes(everyone.id)) {
    lines.push("assignment: the app is already assigned to Everyone");
  } else {
    await okta.assignGroup(app.id, everyone.id);
    lines.push("assignment: assigned the app to Everyone");
  }

  // 4. Tokens for the app on the default server.
  lines.push(await ensureAccessPolicy(okta, clientId));

  // 5. The users group.
  const { group, created } = await okta.ensureGroup(USERS_GROUP, "People added by bun run users in the Loan Desk workshop");
  lines.push(`group: ${created ? "created" : "found"} ${USERS_GROUP} (${group.id})`);

  // 6. Password only, best effort.
  try {
    lines.push(await ensurePasswordOnly(okta, app.id));
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    warnings.push(
      `the password-only sign-in policy was not set (${why}). The org's own policy applies, which may ask the demo cast to ` +
        `enroll a second factor. To change it: Security → Authentication Policies → add a rule with "Password" as the only factor, ` +
        `and assign the policy to ${APP_LABEL}.`,
    );
  }

  return { issuer, clientId, clientSecret, lines, warnings };
}

/** The app with every wanted redirect URI and both grant types, keeping what it had. */
export function withRedirectsAndGrants(app: OktaApp, wanted: string[]): { app: OktaApp; added: string[]; grantsAdded: string[] } {
  const settings = app.settings?.oauthClient ?? {};
  const have = settings.redirect_uris ?? [];
  const added = wanted.filter((uri) => !have.includes(uri));
  const grants = settings.grant_types ?? [];
  const grantsAdded = ["authorization_code", "refresh_token"].filter((grant) => !grants.includes(grant));
  const copy = structuredClone(app);
  copy.settings = { ...copy.settings, oauthClient: { ...settings, redirect_uris: [...have, ...added], grant_types: [...grants, ...grantsAdded] } };
  return { app: copy, added, grantsAdded };
}

async function everyoneGroup(okta: Okta): Promise<OktaGroup> {
  const listed = await okta.all<OktaGroup>("/api/v1/groups?q=Everyone&limit=200");
  const found = listed.find((group) => group.profile?.name === "Everyone" && (group.type === undefined || group.type === "BUILT_IN"));
  if (!found) throw new Error("the org has no Everyone group, which every Okta org ships with");
  return found;
}

const BASE = `/api/v1/authorizationServers/${AUTH_SERVER}/policies`;

/** Whether a rule hands authorization-code tokens to everybody, for every scope or at least `openid email`. */
function rulePasses(rule: Rule): boolean {
  if (rule.status !== undefined && rule.status !== "ACTIVE") return false;
  const grants = rule.conditions?.grantTypes?.include ?? [];
  const groups = rule.conditions?.people?.groups?.include ?? [];
  const scopes = rule.conditions?.scopes?.include ?? [];
  return grants.includes("authorization_code") && groups.includes("EVERYONE") && (scopes.includes("*") || ["openid", "email"].every((scope) => scopes.includes(scope)));
}

/**
 * An access policy on the `default` server that lets the app have tokens.
 * Okta evaluates policies by priority and stops at the first that names the
 * client, so a policy found is only enough when its own rules pass. Made at
 * priority 1 when none does.
 */
export async function ensureAccessPolicy(okta: Okta, clientId: string): Promise<string> {
  const policies = await okta.all<Policy>(BASE);
  const covering = policies
    .filter((policy) => policy.status === undefined || policy.status === "ACTIVE")
    .filter((policy) => {
      const include = policy.conditions?.clients?.include ?? [];
      return include.includes("ALL_CLIENTS") || include.includes(clientId);
    })
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const first = covering[0];
  if (first) {
    const rules = await okta.all<Rule>(`${BASE}/${encodeURIComponent(first.id)}/rules`);
    if (rules.some(rulePasses)) return `access policy: ${first.name} already lets the app have tokens`;
  }

  let policy = policies.find((each) => each.name === ACCESS_POLICY_NAME);
  if (!policy) {
    policy = await okta.expect<Policy>("POST", BASE, {
      type: "OAUTH_AUTHORIZATION_POLICY",
      status: "ACTIVE",
      name: ACCESS_POLICY_NAME,
      description: "Lets the Loan Desk app sign people in",
      priority: 1,
      conditions: { clients: { include: [clientId] } },
    });
  }
  await okta.expect("POST", `${BASE}/${encodeURIComponent(policy.id)}/rules`, {
    type: "RESOURCE_ACCESS",
    name: "Sign in",
    priority: 1,
    conditions: {
      people: { groups: { include: ["EVERYONE"] } },
      grantTypes: { include: ["authorization_code"] },
      scopes: { include: ["*"] },
    },
    actions: { token: { accessTokenLifetimeMinutes: 60, refreshTokenLifetimeMinutes: 0, refreshTokenWindowMinutes: 10080 } },
  });
  return `access policy: created ${ACCESS_POLICY_NAME} on the ${AUTH_SERVER} server, with a rule for the authorization code grant`;
}

/** The app's sign-in policy, password only, made once and assigned to the app. */
async function ensurePasswordOnly(okta: Okta, appId: string): Promise<string> {
  const policies = await okta.all<Policy>("/api/v1/policies?type=ACCESS_POLICY");
  let policy = policies.find((each) => each.name === SIGN_ON_POLICY_NAME);
  let made = false;
  if (!policy) {
    policy = await okta.expect<Policy>("POST", "/api/v1/policies", {
      type: "ACCESS_POLICY",
      name: SIGN_ON_POLICY_NAME,
      description: "The Loan Desk demo cast sign in with a password alone",
    });
    made = true;
  }
  const rules = await okta.all<Rule>(`/api/v1/policies/${encodeURIComponent(policy.id)}/rules`);
  if (!rules.some((rule) => rule.name === "Password only")) {
    await okta.expect("POST", `/api/v1/policies/${encodeURIComponent(policy.id)}/rules`, {
      type: "ACCESS_POLICY",
      name: "Password only",
      priority: 0,
      actions: {
        appSignOn: {
          access: "ALLOW",
          verificationMethod: { factorMode: "1FA", type: "ASSURANCE", reauthenticateIn: "PT2H", constraints: [{ knowledge: { types: ["password"] } }] },
        },
      },
    });
  }
  await okta.expect("PUT", `/api/v1/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(policy.id)}`);
  return `sign-in policy: ${made ? "created" : "found"} ${SIGN_ON_POLICY_NAME}, assigned to the app`;
}
