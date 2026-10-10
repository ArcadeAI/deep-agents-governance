/**
 * The Coordinator API, as far as `bun run setup-arcade --gateway` uses it
 * (#52): the project's User Sources, listed, the issuer checked, and, when
 * this app has none, created, then read back by id.
 *
 * This is the one place that knows the Coordinator's shapes: every field name
 * is in {@link SHAPE}, and every answer is read here. The contract (#52,
 * 2026-09-28):
 *
 * - The routes are under `ARCADE_COORDINATOR_URL`, default
 *   `https://cloud.arcade.dev/api`, and the same org and project as the hooks
 *   and the gateway (`context.ts`): `…/v1/orgs/{org_id}/projects/{project_id}/user_sources`.
 *   Auth is `Authorization: Bearer <ARCADE_API_KEY>`, the project key, which
 *   must belong to the project in the path: a 401 or a 404 means it does not.
 * - Every success is one envelope, `{ code: 200, msg: "Request successful", data }`,
 *   whatever the HTTP status (the create's is 201). Another `code` is a failed
 *   call, and the line the run prints names the `code` and `msg` it got.
 * - `GET …/user_sources?limit&offset` pages, newest first, with no filter, so
 *   the run matches on issuer and client itself. `GET …/user_sources/{id}` is
 *   one. `POST …/user_sources/test_issuer` `{ issuer }` runs the create's own
 *   discovery, JWKS and scope checks and saves nothing: 204, or a 422 whose
 *   `msg` says why. `POST …/user_sources` creates one, 201, and a second
 *   identical create makes a second one, so the run lists first.
 * - Ids are `us_` and a 27-character base62 KSUID. The gateway checks only that
 *   shape, not that the id exists, so the run reads the User Source back by id,
 *   active and this app's, before it creates the gateway.
 * - **Never experience.arcade.dev.** That is the dashboard's own proxy, on the
 *   browser's session. A configured URL on that host is refused before anything
 *   is sent, and the run falls back.
 * - Create-only, like the provider: a User Source is hop 1, the access model
 *   itself. One that exists and differs is reported, never reused and never
 *   edited (`setup-arcade.ts`).
 *
 * Whether this API stays stable for clients outside Arcade is not known, so
 * anything it answers that is not the above is not guessed at: it is a failed
 * call, and the run stops and prints the dashboard forms (`forms.ts`). Nothing
 * here runs without `--gateway`: the agent calls the Engine directly, and the
 * User Source exists only so an MCP client can sign in as the person
 * (`docs/modules/05-mcp-client.md`).
 */
import type { ProjectScope } from "./arcade.ts";

export const DEFAULT_COORDINATOR_URL = "https://cloud.arcade.dev/api";

/** The dashboard's proxy. Nothing here ever calls it. */
const FORBIDDEN_HOST = "experience.arcade.dev";

/**
 * The callback every User Source signs in through, which `bun run okta-setup`
 * allowlists on the app's Okta client. Arcade fixes it for every User Source
 * on Cloud, so no request sends it and no answer carries it.
 */
export const USER_SOURCE_CALLBACK = "https://cloud.arcade.dev/oauth2/intermediate_callback";

/** The name this app's User Source goes by, the same as the dashboard form's (`forms.ts`). */
export const USER_SOURCE_NAME = "Loans Approval Limits";

/** The `code` inside every successful answer, whatever its HTTP status. */
const SUCCESS_CODE = 200;

/** A User Source id: `us_` and a KSUID, 27 base62 characters. */
export const USER_SOURCE_ID = /^us_[0-9A-Za-z]{27}$/;

/** The field names of a User Source, in the list, the read and the create alike. */
export const SHAPE = {
  id: "id",
  name: "name",
  description: "description",
  issuer: "issuer",
  clientId: "client_id",
  subjectClaim: "subject_claim",
  scopes: "scopes",
  bindingType: "binding_type",
  protocol: "protocol",
  status: "status",
  /** The create request's secret, which no read returns. */
  clientSecret: "client_secret",
} as const;

/**
 * The scopes this app's User Source asks for, as the dashboard form names them
 * (`forms.ts`). `openid` is required, and each must be in the app's published
 * `scopes_supported`, which also has `offline_access`: that one is not asked
 * for, so a User Source made through the #48 form matches too.
 */
export const USER_SOURCE_SCOPES = ["openid", "profile", "email"] as const;

/** A User Source as this script reads it. `null` is a field the answer left out. */
export interface UserSource {
  id: string;
  name: string | null;
  issuer: string | null;
  clientId: string | null;
  subjectClaim: string | null;
  scopes: string[] | null;
  status: string | null;
  /** Reported, never checked: `project` for this app's, which is all this script reads. */
  bindingType: string | null;
  protocol: string | null;
}

/** What this app needs its User Source to be. `issuer` is byte for byte: Arcade compares it so. */
export interface UserSourceSpec {
  issuer: string;
  clientId: string;
}

function at(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown, key: string): string | null {
  const found = at(value, key);
  return typeof found === "string" ? found : null;
}

/** One User Source, or `null` when the answer is not one: no string id, or a field of the wrong type. */
export function parseUserSource(json: unknown): UserSource | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const id = text(json, SHAPE.id);
  if (id === null || id === "") return null;
  for (const key of [SHAPE.name, SHAPE.issuer, SHAPE.clientId, SHAPE.subjectClaim, SHAPE.status]) {
    const value = at(json, key);
    if (value !== undefined && value !== null && typeof value !== "string") return null;
  }
  const scopes = at(json, SHAPE.scopes);
  if (scopes !== undefined && scopes !== null && !(Array.isArray(scopes) && scopes.every((each) => typeof each === "string"))) return null;
  // Reported only: whatever they are, shown as text, never refused.
  const shown = (key: string) => {
    const value = at(json, key);
    return value === undefined || value === null ? null : typeof value === "string" ? value : JSON.stringify(value);
  };
  return {
    id,
    name: text(json, SHAPE.name),
    issuer: text(json, SHAPE.issuer),
    clientId: text(json, SHAPE.clientId),
    subjectClaim: text(json, SHAPE.subjectClaim),
    scopes: Array.isArray(scopes) ? (scopes as string[]) : null,
    status: text(json, SHAPE.status),
    bindingType: shown(SHAPE.bindingType),
    protocol: shown(SHAPE.protocol),
  };
}

/** One page of the list's `data`: its items and the total, or `null` when it is not a page of User Sources. */
export function parseUserSourcePage(data: unknown): { items: UserSource[]; total: number } | null {
  const items = at(data, "items");
  const total = at(data, "total_count");
  if (!Array.isArray(items) || typeof total !== "number" || !Number.isInteger(total) || total < 0) return null;
  const parsed = items.map(parseUserSource);
  return parsed.every((each): each is UserSource => each !== null) ? { items: parsed, total } : null;
}

/** The create's `data`: the User Source it made, with an id of the `us_` shape, or `null`. */
export function parseCreated(data: unknown): UserSource | null {
  const source = parseUserSource(data);
  return source !== null && USER_SOURCE_ID.test(source.id) ? source : null;
}

/**
 * The create request's body. The issuer is `IDP_ISSUER`, as the identity
 * provider's discovery names it, byte for byte: Arcade reads that document at
 * the create and refuses any other string. `protocol` and `status` are the defaults, sent so the
 * request says what it makes.
 */
export function userSourceBody({ issuer, clientId, clientSecret }: { issuer: string; clientId: string; clientSecret: string }) {
  return {
    [SHAPE.name]: USER_SOURCE_NAME,
    [SHAPE.description]: "The app's sign-in, through its identity provider (hop 1)",
    [SHAPE.protocol]: "oidc",
    [SHAPE.issuer]: issuer,
    [SHAPE.clientId]: clientId,
    [SHAPE.clientSecret]: clientSecret,
    [SHAPE.subjectClaim]: "email",
    [SHAPE.scopes]: [...USER_SOURCE_SCOPES],
    [SHAPE.status]: "active",
  };
}

/** An issuer as `candidates` looks for it: a trailing slash still claims the app, and is then a difference. */
const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * The User Sources that are this app's, or claim to be: the issuer is
 * `IDP_ISSUER`, or the client is `IDP_CLIENT_ID`. Each of them is held
 * to the whole spec, so one that shares only its issuer or only its client is
 * a mismatch to report, never a stranger to ignore.
 */
export function candidates(sources: UserSource[], want: UserSourceSpec): UserSource[] {
  return sources.filter((each) => (each.issuer !== null && sameIssuer(each.issuer, want.issuer)) || each.clientId === want.clientId);
}

const differenceLine = (field: string, have: unknown, need: unknown) =>
  `${field}: Arcade has ${have === null ? "nothing" : JSON.stringify(have)}, this app needs ${JSON.stringify(need)}`;

/**
 * `field: Arcade has X, this app needs Y`, one line per difference: the issuer,
 * byte for byte, the client id, the subject claim (`email`, the join key) and
 * the scopes, as a set. Absent is a difference for each: a User Source that
 * cannot be shown to be this app's is not reused. The callback is Arcade's,
 * the same for every User Source, so there is none to compare.
 */
export function userSourceDifferences(found: UserSource, want: UserSourceSpec): string[] {
  const differences: string[] = [];
  if (found.issuer !== want.issuer) differences.push(differenceLine("issuer", found.issuer, want.issuer));
  if (found.clientId !== want.clientId) differences.push(differenceLine("client_id", found.clientId, want.clientId));
  if (found.subjectClaim !== "email") differences.push(differenceLine("subject_claim", found.subjectClaim, "email"));
  const need = [...USER_SOURCE_SCOPES].sort();
  const have = found.scopes === null ? null : [...new Set(found.scopes)].sort();
  if (have === null || JSON.stringify(have) !== JSON.stringify(need)) differences.push(differenceLine("scopes", found.scopes, [...USER_SOURCE_SCOPES]));
  return differences;
}

/**
 * What a gateway needs of the User Source it authenticates through, beyond
 * {@link userSourceDifferences}: the id asked for, of the `us_` shape, and
 * `active`. The gateway create checks only the shape.
 */
export function readinessDifferences(found: UserSource, id: string): string[] {
  const differences: string[] = [];
  if (found.id !== id) differences.push(differenceLine("id", found.id, id));
  if (!USER_SOURCE_ID.test(found.id)) differences.push(`id: ${JSON.stringify(found.id)} is not a User Source id (us_ and 27 base62 characters)`);
  if (found.status !== "active") differences.push(differenceLine("status", found.status, "active"));
  return differences;
}

/** The values the answer reports and the run does not check, as one clause for its output. */
export function reported(source: UserSource): string {
  return `binding_type ${source.bindingType ?? "(none)"}, protocol ${source.protocol ?? "(none)"}`;
}

/** A Coordinator call that did not give this script what it needs, as the run prints it in one line. */
export interface CoordinatorFailure {
  ok: false;
  /** `METHOD <url>`. */
  call: string;
  /** `404`, `a network error (…)`, `200 with a body that is not a page of User Sources`, … */
  status: string;
  /** The HTTP status when there was one, for the flow and the tests. */
  code: number | null;
  /** The envelope's `msg`, when the answer had one. */
  msg: string | null;
  /** A 401, or a 404 on a route every project has: the key is missing, not valid, or another project's. */
  keyRefused?: boolean;
}

export type CoordinatorResult<T> = { ok: true; value: T } | CoordinatorFailure;

/**
 * One line, naming the call and its status: the first thing a fallback prints
 * (#52). A 401 or a 404 is the key: missing, not valid, or another project's.
 */
export function failureLine(failure: CoordinatorFailure): string {
  const why =
    failure.keyRefused
      ? ": the project key is not valid for this org and project, or belongs to another project (check ARCADE_API_KEY, and the org and project above)"
      : failure.msg
        ? `: ${failure.msg}`
        : "";
  return `coordinator: ${failure.call} answered ${failure.status}${why}`;
}

/**
 * `ARCADE_COORDINATOR_URL`, or the default, with no trailing slash; or why it
 * is refused. Refused: not an http(s) URL, or the dashboard's proxy.
 */
export function coordinatorUrl(configured: string | undefined): { url: string } | { url: null; why: string } {
  const raw = (configured?.trim() || DEFAULT_COORDINATOR_URL).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: null, why: `ARCADE_COORDINATOR_URL=${raw} is not a URL` };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return { url: null, why: `ARCADE_COORDINATOR_URL=${raw} is not an http(s) URL` };
  const host = parsed.hostname.toLowerCase();
  if (host === FORBIDDEN_HOST || host.endsWith(`.${FORBIDDEN_HOST}`)) {
    return { url: null, why: `ARCADE_COORDINATOR_URL=${raw} is the dashboard's own proxy, which this command never calls` };
  }
  return { url: raw };
}

/** How long one Coordinator call may take before it counts as failed. The create's own discovery takes up to 10s. */
const TIMEOUT_MS = 20_000;
/** One page of the list, and how many pages a run reads before it calls the answer unreadable. */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** What one call answered, when it was the status asked for: the envelope's `data`, or nothing for a 204. */
type Answered = { ok: true; code: number; data: unknown };

/**
 * The User Source calls. Like `ArcadeAdmin`: under `--dry-run` it prints each
 * request, the key and the client secret as placeholders, and sends nothing;
 * for real it prints one line per call and never a body.
 */
export class Coordinator {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly dryRun: boolean,
    private readonly log: (line: string) => void,
  ) {}

  path(scope: ProjectScope, rest = ""): string {
    return `/v1/orgs/${encodeURIComponent(scope.orgId)}/projects/${encodeURIComponent(scope.projectId)}/user_sources${rest}`;
  }

  /** Every page, `limit` at a time, until `total_count` is reached. A page that adds nothing short of it is a failed call. */
  async list(scope: ProjectScope): Promise<CoordinatorResult<UserSource[]>> {
    const sources: UserSource[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const path = this.path(scope, `?limit=${PAGE_SIZE}&offset=${sources.length}`);
      const answer = await this.send("GET", path, 200);
      if (!answer.ok) return answer;
      if (this.dryRun) return { ok: true, value: [] };
      const parsed = parseUserSourcePage(answer.data);
      if (parsed === null) return this.unreadable("GET", path, answer.code, "a page of User Sources");
      sources.push(...parsed.items);
      if (sources.length >= parsed.total) return { ok: true, value: sources };
      if (parsed.items.length === 0) return this.unreadable("GET", path, answer.code, `the rest of the ${parsed.total} User Sources it counts`);
    }
    return { ok: false, call: `GET ${this.baseUrl}${this.path(scope)}`, status: `more than ${MAX_PAGES} pages`, code: null, msg: null };
  }

  /** One User Source, by id. */
  async get(scope: ProjectScope, id: string): Promise<CoordinatorResult<UserSource>> {
    // A dry run's id is a placeholder, printed as it is.
    const path = this.path(scope, `/${this.dryRun ? id : encodeURIComponent(id)}`);
    const answer = await this.send("GET", path, 200);
    // The list answered with this key, so a 404 here is the id: not there.
    if (!answer.ok) return answer.code === 404 ? { ...answer, status: "404, no User Source with that id", keyRefused: false } : answer;
    if (this.dryRun) return { ok: false, call: "", status: "dry run", code: null, msg: null };
    const source = parseUserSource(answer.data);
    return source === null ? this.unreadable("GET", path, answer.code, "a User Source") : { ok: true, value: source };
  }

  /**
   * The create's own checks of the issuer, with nothing saved: 204 is a go. A
   * 422 is the reason it would refuse the create now, in its `msg`.
   */
  async testIssuer(scope: ProjectScope, issuer: string): Promise<CoordinatorResult<null>> {
    const answer = await this.send("POST", this.path(scope, "/test_issuer"), 204, { issuer });
    // The list answered with this key, so a 404 here is the route: this Coordinator has no issuer check.
    return answer.ok ? { ok: true, value: null } : { ...answer, keyRefused: false };
  }

  /** The create: 201, with the User Source it made. */
  async create(scope: ProjectScope, body: ReturnType<typeof userSourceBody>): Promise<CoordinatorResult<UserSource>> {
    const answer = await this.send("POST", this.path(scope), 201, body);
    if (!answer.ok) return answer;
    if (this.dryRun) return { ok: false, call: "", status: "dry run", code: null, msg: null };
    const source = parseCreated(answer.data);
    return source === null
      ? this.unreadable("POST", this.path(scope), answer.code, "a User Source with an id of us_ and 27 base62 characters")
      : { ok: true, value: source };
  }

  private unreadable(method: string, path: string, code: number, what: string): CoordinatorFailure {
    return { ok: false, call: `${method} ${this.baseUrl}${path}`, status: `${code} with a body that is not ${what}`, code, msg: null };
  }

  private async send(method: string, path: string, expected: number, body?: unknown): Promise<Answered | CoordinatorFailure> {
    const url = `${this.baseUrl}${path}`;
    const call = `${method} ${url}`;
    if (this.dryRun) {
      this.log(`  ${method} ${url}`);
      this.log(`    Authorization: Bearer <ARCADE_API_KEY>`);
      if (body !== undefined) {
        this.log(`    Content-Type: application/json`);
        for (const line of JSON.stringify(body, null, 2).split("\n")) this.log(`    ${line}`);
      }
      return { ok: true, code: 0, data: null };
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError" ? `nothing within ${TIMEOUT_MS / 1000}s` : `a network error (${(error as Error).message})`;
      this.log(`  coordinator ${method} ${path} → ${reason}`);
      return { ok: false, call, status: reason, code: null, msg: null };
    }
    const raw = await response.text();
    this.log(`  coordinator ${method} ${path} → ${response.status}`);
    let json: unknown = null;
    let parsed = true;
    try {
      json = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsed = false;
    }
    const msg = text(json, "msg");
    if (response.status !== expected) {
      return { ok: false, call, status: String(response.status), code: response.status, msg, keyRefused: response.status === 401 || response.status === 404 };
    }
    // A 204 has no body, and no envelope.
    if (expected === 204) return { ok: true, code: response.status, data: null };
    if (!parsed) return { ok: false, call, status: `${response.status} with a body that is not JSON`, code: response.status, msg: null };
    const code = at(json, "code");
    if (code !== SUCCESS_CODE) {
      const got = code === undefined ? "no envelope code" : `the envelope code ${JSON.stringify(code)}`;
      return {
        ok: false,
        call,
        status: `${response.status} with ${got}${msg === null ? "" : ` and msg ${JSON.stringify(msg)}`}, not code ${SUCCESS_CODE}`,
        code: response.status,
        msg: null,
      };
    }
    return { ok: true, code: response.status, data: at(json, "data") ?? null };
  }
}
