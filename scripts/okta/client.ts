/**
 * The Okta Management API, as far as `bun run okta-setup` and `bun run users`
 * use it: users, one group, one OIDC Web app, and the `default` authorization
 * server's access policies.
 *
 * Auth is `Authorization: SSWS <OKTA_API_TOKEN>`, an API token minted in the
 * Admin Console (Security → API → Tokens). It reaches this process through
 * the environment, `op run -- …` in practice, and never leaves it: no message,
 * error or log line here includes it, and nothing writes it to disk.
 *
 * The org URL is the org's origin, `https://<org>.okta.com`, not the admin
 * console's `-admin` host and not the authorization server's issuer. `fetch`
 * is injectable so the tests run against a recorded conversation rather than
 * an Okta org.
 */

/** A Management API call that did not answer 2xx. The message is Okta's own summary, never the token. */
export class OktaError extends Error {
  override name = "OktaError";
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly summary: string,
  ) {
    super(`${method} ${path} answered ${status}${summary ? `: ${summary}` : ""}`);
  }
}

/** Okta's error body: `errorSummary`, then each `errorCauses[].errorSummary`, which name the failed rule. */
function summaryOf(json: unknown): string {
  if (json === null || typeof json !== "object") return "";
  const body = json as { errorSummary?: unknown; errorCauses?: Array<{ errorSummary?: unknown }> };
  const causes = (body.errorCauses ?? []).map((cause) => cause.errorSummary).filter((each): each is string => typeof each === "string");
  const head = typeof body.errorSummary === "string" ? body.errorSummary : "";
  return [head, ...causes].filter(Boolean).join("; ");
}

/**
 * `OKTA_ORG_URL`, checked and cut to an origin. Https, except a loopback host,
 * which is what the tests' stand-in listens on. The `-admin` host is the
 * console, which the Management API does not answer on, so it is refused by
 * name.
 */
export function orgUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") throw new Error("OKTA_ORG_URL is not set: your org's URL, e.g. https://dev-123456.okta.com");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OKTA_ORG_URL=${value} is not a URL: it is your org's URL, e.g. https://dev-123456.okta.com`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !loopback) throw new Error(`OKTA_ORG_URL=${value} must be https`);
  if (/-admin\./.test(url.hostname)) {
    throw new Error(`OKTA_ORG_URL=${value} is the Admin Console. Drop "-admin": ${url.origin.replace("-admin.", ".")}`);
  }
  return url.origin;
}

/** The org URL from `OKTA_ORG_URL`, else the origin of `IDP_ISSUER`, where an Okta issuer lives. */
export function orgUrlFrom(env: Record<string, string | undefined>): string {
  if (env.OKTA_ORG_URL?.trim()) return orgUrl(env.OKTA_ORG_URL);
  if (env.IDP_ISSUER?.trim()) {
    try {
      return orgUrl(new URL(env.IDP_ISSUER.trim()).origin);
    } catch {
      // Reported below as the missing variable it stands in for.
    }
  }
  return orgUrl(undefined);
}

/** `OKTA_API_TOKEN`, from the environment only. Its value is never echoed. */
export function apiToken(env: Record<string, string | undefined>): string {
  const token = env.OKTA_API_TOKEN?.trim() ?? "";
  if (token === "") {
    throw new Error(
      "OKTA_API_TOKEN is not set. Run this under 1Password, e.g. " +
        'OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- <this command>, ' +
        "or mint one in the Admin Console: Security → API → Tokens",
    );
  }
  return token;
}

export interface OktaUser {
  id: string;
  status: string;
  profile: { login: string; email: string; firstName?: string; lastName?: string };
}

export interface OktaGroup {
  id: string;
  type?: string;
  profile: { name: string; description?: string };
}

export interface OktaApp {
  id: string;
  label: string;
  name: string;
  status?: string;
  credentials?: { oauthClient?: { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string } };
  settings?: { oauthClient?: { redirect_uris?: string[]; grant_types?: string[]; response_types?: string[]; application_type?: string } };
  [key: string]: unknown;
}

export interface Answer {
  status: number;
  json: unknown;
  headers: Headers;
}

export class Okta {
  readonly orgUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: { orgUrl: string; token: string; fetch?: typeof fetch }) {
    this.orgUrl = orgUrl(options.orgUrl);
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  /** One call. `path` is under the org, or a full `Link` URL from a previous page. */
  async request(method: string, path: string, body?: unknown): Promise<Answer> {
    const url = path.startsWith("http") ? path : `${this.orgUrl}${path}`;
    // The token goes to the org and nowhere else, whatever a `Link` header says.
    if (new URL(url).origin !== this.orgUrl) throw new Error(`refusing to send the API token to ${new URL(url).origin}`);
    const response = await this.#fetch(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `SSWS ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown = null;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = { errorSummary: text.slice(0, 200) };
      }
    }
    return { status: response.status, json, headers: response.headers };
  }

  /** A call that must answer 2xx, its body, or an {@link OktaError}. */
  async expect<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const answer = await this.request(method, path, body);
    if (answer.status < 200 || answer.status >= 300) throw new OktaError(method, shown(path), answer.status, summaryOf(answer.json));
    return answer.json as T;
  }

  /** Every item of a listing, following `Link: <…>; rel="next"` the way Okta pages. */
  async all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;
    for (let page = 0; next !== null && page < 50; page++) {
      const answer = await this.request("GET", next);
      if (answer.status !== 200) throw new OktaError("GET", shown(next), answer.status, summaryOf(answer.json));
      if (Array.isArray(answer.json)) items.push(...(answer.json as T[]));
      next = nextLink(answer.headers.get("link"));
    }
    return items;
  }

  // --- Users -----------------------------------------------------------------

  /** The user whose login is `login`, or `null`. Okta takes the login in place of the id here. */
  async findUser(login: string): Promise<OktaUser | null> {
    const path = `/api/v1/users/${encodeURIComponent(login)}`;
    const answer = await this.request("GET", path);
    if (answer.status === 404) return null;
    if (answer.status !== 200) throw new OktaError("GET", path, answer.status, summaryOf(answer.json));
    return answer.json as OktaUser;
  }

  /**
   * A user, created active with a password, so they can sign in at once.
   * `activate=true` and a password in `credentials` skip the activation email.
   * A password the org's policy refuses is a 400 whose causes name the rule.
   */
  createUser(person: { email: string; firstName: string; lastName: string; password: string }): Promise<OktaUser> {
    return this.expect<OktaUser>("POST", "/api/v1/users?activate=true", {
      profile: { firstName: person.firstName, lastName: person.lastName, email: person.email, login: person.email },
      credentials: { password: { value: person.password } },
    });
  }

  /** Deactivated, then deleted: Okta deletes only a deactivated user. Sessions and tokens go with them. */
  async deleteUser(id: string): Promise<void> {
    const path = `/api/v1/users/${encodeURIComponent(id)}`;
    await this.expect("POST", `${path}/lifecycle/deactivate?sendEmail=false`);
    await this.expect("DELETE", `${path}?sendEmail=false`);
  }

  // --- Groups ----------------------------------------------------------------

  async findGroup(name: string): Promise<OktaGroup | null> {
    const listed = await this.all<OktaGroup>(`/api/v1/groups?q=${encodeURIComponent(name)}&limit=200`);
    return listed.find((group) => group.profile?.name === name) ?? null;
  }

  async ensureGroup(name: string, description: string): Promise<{ group: OktaGroup; created: boolean }> {
    const found = await this.findGroup(name);
    if (found) return { group: found, created: false };
    const group = await this.expect<OktaGroup>("POST", "/api/v1/groups", { profile: { name, description } });
    return { group, created: true };
  }

  async addToGroup(groupId: string, userId: string): Promise<void> {
    await this.expect("PUT", `/api/v1/groups/${encodeURIComponent(groupId)}/users/${encodeURIComponent(userId)}`);
  }

  groupMembers(groupId: string): Promise<OktaUser[]> {
    return this.all<OktaUser>(`/api/v1/groups/${encodeURIComponent(groupId)}/users?limit=200`);
  }

  /** Whether the user is in the group, from their own group list, which is short. */
  async inGroup(groupId: string, userId: string): Promise<boolean> {
    const groups = await this.all<OktaGroup>(`/api/v1/users/${encodeURIComponent(userId)}/groups`);
    return groups.some((group) => group.id === groupId);
  }

  // --- Apps ------------------------------------------------------------------

  /** The active or inactive app labelled exactly `label`; Okta's `q` is a prefix match on name and label. */
  async findApp(label: string): Promise<OktaApp | null> {
    const listed = await this.all<OktaApp>(`/api/v1/apps?q=${encodeURIComponent(label)}&limit=200`);
    return listed.find((app) => app.label === label && app.status !== "DELETED") ?? null;
  }

  createApp(body: unknown): Promise<OktaApp> {
    return this.expect<OktaApp>("POST", "/api/v1/apps", body);
  }

  /** Okta replaces an app whole on `PUT`, so the body is the app as read, changed. */
  updateApp(app: OktaApp): Promise<OktaApp> {
    return this.expect<OktaApp>("PUT", `/api/v1/apps/${encodeURIComponent(app.id)}`, app);
  }

  /** The groups the app is assigned to, by id. */
  async appGroups(appId: string): Promise<string[]> {
    const listed = await this.all<{ id: string }>(`/api/v1/apps/${encodeURIComponent(appId)}/groups?limit=200`);
    return listed.map((each) => each.id);
  }

  async assignGroup(appId: string, groupId: string): Promise<void> {
    await this.expect("PUT", `/api/v1/apps/${encodeURIComponent(appId)}/groups/${encodeURIComponent(groupId)}`, {});
  }

  /** A new client secret for an existing app. The old ones stay active; Okta allows two. */
  async newClientSecret(appId: string): Promise<string> {
    const made = await this.expect<{ client_secret?: unknown }>("POST", `/api/v1/apps/${encodeURIComponent(appId)}/credentials/secrets`, {});
    if (typeof made.client_secret !== "string" || made.client_secret === "") {
      throw new Error(`Okta made a client secret for the app ${appId} and returned none`);
    }
    return made.client_secret;
  }
}

/** A path as it is safe to print: the query is dropped, in case a filter ever names somebody. */
function shown(path: string): string {
  return path.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (match) return match[1]!;
  }
  return null;
}
