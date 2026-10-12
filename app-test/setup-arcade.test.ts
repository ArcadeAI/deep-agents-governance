/**
 * `bun run setup-arcade <host>` against a stand-in for Arcade's admin API (#9, #30, #48).
 *
 * Never the real API, never the real Arcade CLI, never the real `~/.arcade`.
 *
 * - **The stand-in** answers the routes `scripts/setup-arcade/arcade.ts`
 *   sends, each with the method the official client uses where one exists,
 *   keeps what it is sent, and records every request, so each test can say
 *   exactly what reached "Arcade". **Anything else gets the 404 Arcade itself
 *   answers** for a route or method it does not serve, byte for byte: until #26
 *   this stand-in served `POST /v1/admin/secrets/{key}` because the pinned spec
 *   says POST, and the first live run got that 404 instead. Since #30 it serves
 *   the plugins and hooks under one org and project, as the live swagger has
 *   them, and still 404s the bare `/v1/plugins` the second live run was
 *   refused. Without `--gateway` it serves no gateway and no User Source
 *   route: the agent calls the Engine directly with the project key, so the
 *   script asks for neither. Under `--gateway` the gateway routes answer on
 *   the same server and the User Source ones on a Coordinator stand-in of its
 *   own (#52), each as the live API answered on 2026-09-28.
 * - **The Arcade CLI** is a shell script first on `PATH` that records where it
 *   was run and with what, so `arcade deploy` is observed and never performed.
 * - **The CLI's context** is a `credentials.yaml` in a throwaway `HOME`, in the
 *   shape `arcade_core.config_model.Config` writes, holding fake tokens that
 *   must never be printed.
 * - **The identity provider** is a discovery document served on a port of its
 *   own, as Okta's custom authorization server publishes it under
 *   `/oauth2/default`. The run reads it for the provider's endpoints.
 *
 * Each test runs the real script in a throwaway project of its own: a git
 * repository whose `.env` is the repo's `.env.example` copied verbatim with
 * `ARCADE_API_KEY` filled, and the identity provider's block filled the way
 * `bun run okta-setup` fills it, which is where a developer stands after the
 * Quickstart's `cp .env.example .env` and `okta-setup`.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnChild } from "./child.ts";
import { childEnv } from "./child-env.ts";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "setup-arcade.ts");
const HOST = "template-test.ngrok.app";
const ORIGIN = `https://${HOST}`;
const KEY = "stand-in-project-key";
const CALLBACK = "https://cloud.arcade.dev/api/v1/oauth/stand_in_ap_1/callback";
/** The one org and project the stand-in's key belongs to. */
const ORG = "org_standin";
const PROJECT = "prj_standin";
const SCOPED = `/v1/orgs/${ORG}/projects/${PROJECT}`;
/** A User Source id an older `.env` may still hold, from when hop 1 went through a gateway. Never sent or printed. */
const USER_SOURCE = "us_2StandInUserSource000000000";
/** A gateway slug an older `.env` may still hold. Never sent or printed. */
const OLD_GATEWAY = "loan-desk-old-gateway";
/** What the faked CLI's credentials hold besides the ids: never to be printed. */
const CLI_TOKENS = ["cli-access-token-must-not-leak", "cli-refresh-token-must-not-leak", "cli-api-key-must-not-leak"];
/** The Okta app's client, as `bun run okta-setup` writes it to `.env`. */
const CLIENT_ID = "0oaStandInClient";
/** Its secret: sent to Arcade, never printed. */
const CLIENT_SECRET = "okta-client-secret-must-not-leak";

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/**
 * What Arcade answered `POST /v1/admin/secrets/APP_PUBLIC_HOST` with, on the
 * human's first live run (#7, 2026-09-25). The same body is Arcade's answer to
 * any route it does not serve, so it is this stand-in's too.
 */
const ROUTE_NOT_FOUND = { name: "route_not_found", message: "requested route is not found or method is not allowed" };

/** The Coordinator's User Source routes the stand-in serves (#52), by the name a test injects an answer under. */
type CoordinatorRoute = "list" | "get" | "test_issuer" | "create";

/** What an Okta custom authorization server publishes as `scopes_supported`, as far as this app asks. */
const IDP_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/**
 * What Arcade answered the fourth live run's `POST …/plugins` with, byte for
 * byte (#30, F6): the body sent `health_check_path: "/hooks/health"`.
 */
const HEALTH_CHECK_NOT_A_URL = {
  name: "malformed_request",
  message: "failed to validate request body: webhook_config: health_check_path must be a valid URL",
  field_errors: [{ field: "webhook_config.health_check_path", rule: "url", message: "health_check_path must be a valid URL" }],
};

/** Arcade's `url` rule, as far as anyone has seen it: an absolute http(s) URL. */
function isUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

type Json = Record<string, any>;

/** Arcade's admin API, as far as setup-arcade uses it (the table is on #26's PR; the org routes on #30's). */
class StandIn {
  requests: Recorded[] = [];
  providers = new Map<string, Json>();
  secrets = new Map<string, string>();
  verifier: Json = { verifier_url: "", unsafe_skip_verification: false };
  /** Plugins as stored, bearer token included, which no read ever returns. */
  plugins = new Map<string, Json>();
  /** Hooks, as `schemas.HookResponse`, made from each plugin's endpoints. */
  hooks: Json[] = [];
  /** Gateways (`schemas.GatewayResponse`), as `--gateway` or the dashboard made them. */
  gateways = new Map<string, Json>();
  /** When set, the next gateway create answers this instead of creating anything (#52). */
  nextGatewayCreate: { status: number; body: Json } | null = null;
  /** When set, a gateway read-back answers this instead (#52). */
  gatewayReadBack: { status: number; body: Json } | null = null;

  // --- The Coordinator API (#52) --------------------------------------------
  /**
   * `unavailable` answers every Coordinator call with the 404 the project key
   * got for `…/user_sources` on api.arcade.dev (#7). `available` is the contract
   * the human's agent read on #52 (2026-09-28), and nothing more. Default
   * available: `--gateway` is the only thing that calls it.
   */
  coordinatorMode: "unavailable" | "available" = "available";
  /** User Sources as the Coordinator stores them, oldest first, secret included, which no read returns. */
  userSources = new Map<string, Json>();
  coordinatorRequests: Recorded[] = [];
  /** When set, the next Coordinator call to that route answers this instead. */
  nextCoordinator: Partial<Record<CoordinatorRoute, { status: number; body: unknown }>> = {};
  /** When set, a PATCH is stored but its `status` and each endpoint's are not: the plugin reads back as it was. */
  patchIgnoresStatus = false;
  /** When set, a plugin read-back leaves `status` out. */
  omitStatus = false;
  /** When set, the next plugin create answers this instead of creating anything. */
  nextPluginCreate: { status: number; body: Json } | null = null;
  /**
   * What a plugin read-back says `health_check_path` is. `undefined` leaves the
   * field out, which is what real Arcade did on the fourth live run's retry
   * (#30), so it is the default; `"stored"` echoes what was sent.
   */
  healthCheckReadBack: string | undefined = undefined;
  /** When set, a plugin read-back leaves this endpoint's URL out. */
  omitEndpointUrl: string | null = null;
  /** When set, a PUT to the verifier settings is accepted and ignored. */
  verifierIgnoresPut = false;
  /** The servers Arcade already runs, by name, as `GET …/workers/<name>` finds them. */
  workers = new Set<string>();
  /** When set, `GET …/workers/<name>` answers this instead. */
  workerLookup: { status: number; body: Json } | null = null;
  /** The identity provider: what its discovery document answers. `issuer` unset is its own. */
  idp: { status: number; issuer?: string; scopes?: string[]; signingKeys?: number } = { status: 200, scopes: [...IDP_SCOPES], signingKeys: 1 };
  idpRequests = 0;
  /** Every request to Arcade or the identity provider, in order, with which one got it. */
  timeline: string[] = [];
  /** The callback Arcade generates for the next provider created: one per provider, `…/oauth/<ap_ id>/callback`. */
  nextCallback = CALLBACK;
  /**
   * When set, the tool-secret route answers every method with Arcade's 404, the
   * way the live run's POST was answered: the run stops just after the provider
   * is created, which is the state the human's live project is in (#26).
   */
  secretsLikeTheLiveRun = false;
  private ids = 0;
  // On 127.0.0.1, the address the script is pointed at, not the default
  // 0.0.0.0: macOS lets another process hold 127.0.0.1 on the same port, and
  // it then answers in the stand-in's place (a 403 from somebody else, seen
  // once on #28's full run).
  private readonly server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
  readonly url = `http://127.0.0.1:${this.server.port}`;
  /** The Coordinator, as `ARCADE_COORDINATOR_URL` names it: under `/api`, like the default `https://cloud.arcade.dev/api`. */
  private readonly coordinatorServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handleCoordinator(request) });
  readonly coordinatorUrl = `http://127.0.0.1:${this.coordinatorServer.port}/api`;
  /** The identity provider's org, as `OKTA_ORG_URL` names it. */
  private readonly idpServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handleIdp(request) });
  readonly idpUrl = `http://127.0.0.1:${this.idpServer.port}`;
  /** Its `default` custom authorization server, as `IDP_ISSUER` names it. */
  readonly issuer = `${this.idpUrl}/oauth2/default`;

  stop(): void {
    this.server.stop(true);
    this.coordinatorServer.stop(true);
    this.idpServer.stop(true);
  }

  private handleIdp(request: Request): Response {
    this.idpRequests += 1;
    this.timeline.push(`idp ${request.method} ${new URL(request.url).pathname}`);
    if (new URL(request.url).pathname !== "/oauth2/default/.well-known/openid-configuration") return new Response("not found", { status: 404 });
    if (this.idp.status !== 200) return new Response("unavailable", { status: this.idp.status });
    return Response.json(this.discoveryDocument());
  }

  /** The discovery document as Okta's custom authorization server publishes it, from what `idp` says. */
  private discoveryDocument(): Json {
    const issuer = this.idp.issuer ?? this.issuer;
    const base = issuer.replace(/\/+$/, "");
    return {
      issuer,
      authorization_endpoint: `${base}/v1/authorize`,
      token_endpoint: `${base}/v1/token`,
      userinfo_endpoint: `${base}/v1/userinfo`,
      jwks_uri: `${base}/v1/keys`,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      ...(this.idp.scopes === undefined ? {} : { scopes_supported: this.idp.scopes }),
    };
  }

  /**
   * What the Coordinator checks of an issuer at `test_issuer` and at the
   * create: its discovery document is reachable, names itself, has a signing
   * key, and supports each scope asked for. The stand-in reads `idp` instead of the network.
   */
  private issuerRefusal(issuer: string, scopes: string[]): string | null {
    const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    if (this.idp.status !== 200 || issuer.replace(/\/+$/, "") !== this.issuer) return `Could not reach \`${url}\` at this time. Try again.`;
    const document = this.discoveryDocument();
    if (document.issuer !== issuer) return `The issuer in \`${url}\` is \`${document.issuer}\`, not \`${issuer}\`.`;
    if ((this.idp.signingKeys ?? 0) < 1) return `The JWKS at \`${document.jwks_uri}\` has no signing key.`;
    const unsupported = document.scopes_supported === undefined ? [] : scopes.filter((scope) => !(document.scopes_supported as string[]).includes(scope));
    if (unsupported.length > 0) return `Scopes not supported by the issuer: ${unsupported.join(", ")}.`;
    return null;
  }

  /** A User Source as the Coordinator returns it: every field but the secret. */
  private userSourceResponse(stored: Json): Json {
    const { client_secret: _secret, ...shown } = stored;
    return shown;
  }

  /** The Coordinator API (#52): `{ code, msg, data }` envelopes, User Sources only. */
  private async handleCoordinator(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = await request.text();
    const body = text ? (JSON.parse(text) as Json) : undefined;
    this.coordinatorRequests.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.get("authorization"), body });
    this.timeline.push(`coordinator ${request.method} ${url.pathname.replace(/^\/api/, "")}${url.search}`);
    const refused = (status: number, msg: string) => Response.json({ code: status, msg, data: null }, { status });
    const success = (data: unknown, status = 200) => Response.json({ code: 200, msg: "Request successful", data }, { status });
    if (request.headers.get("authorization") !== `Bearer ${KEY}`) return refused(401, "Unauthorized");
    if (this.coordinatorMode === "unavailable") return Response.json(ROUTE_NOT_FOUND, { status: 404 });
    const route = /^\/api\/v1\/orgs\/([^/]+)\/projects\/([^/]+)\/user_sources(?:\/([^/]+))?$/.exec(url.pathname);
    if (!route) return Response.json(ROUTE_NOT_FOUND, { status: 404 });
    if (route[1] !== ORG || route[2] !== PROJECT) return refused(404, "Not Found");
    const sub = route[3];
    const name: CoordinatorRoute | null =
      request.method === "GET" && sub === undefined ? "list"
      : request.method === "GET" ? "get"
      : request.method === "POST" && sub === "test_issuer" ? "test_issuer"
      : request.method === "POST" && sub === undefined ? "create"
      : null;
    if (name === null) return refused(405, "Method Not Allowed");
    const injected = this.nextCoordinator[name];
    if (injected) {
      delete this.nextCoordinator[name];
      return typeof injected.body === "string" ? new Response(injected.body, { status: injected.status }) : Response.json(injected.body, { status: injected.status });
    }
    if (name === "list") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) return refused(422, "Invalid request parameters: limit, offset");
      const all = [...this.userSources.values()].reverse().map((each) => this.userSourceResponse(each));
      return success({ limit, offset, total_count: all.length, items: all.slice(offset, offset + limit) });
    }
    if (name === "get") {
      const stored = this.userSources.get(decodeURIComponent(sub!));
      return stored === undefined ? refused(404, "Not Found") : success(this.userSourceResponse(stored));
    }
    if (name === "test_issuer") {
      if (typeof body?.issuer !== "string" || !/^https?:\/\//.test(body.issuer)) return refused(422, "Invalid request parameters: issuer");
      const why = this.issuerRefusal(body.issuer, ["openid", "profile", "email"]);
      return why === null ? new Response(null, { status: 204 }) : refused(422, why);
    }
    const invalid: string[] = [];
    if (typeof body?.name !== "string" || body.name.length < 1 || body.name.length > 255) invalid.push("name");
    if (body?.protocol !== undefined && body.protocol !== "oidc") invalid.push("protocol");
    if (typeof body?.issuer !== "string" || !/^https?:\/\//.test(body.issuer)) invalid.push("issuer");
    if (typeof body?.client_id !== "string" || body.client_id === "") invalid.push("client_id");
    if (typeof body?.client_secret !== "string" || body.client_secret === "") invalid.push("client_secret");
    const scopes = body?.scopes ?? ["openid", "profile", "email"];
    if (!Array.isArray(scopes) || !scopes.includes("openid")) invalid.push("scopes");
    if (invalid.length > 0) return refused(422, `Invalid request parameters: ${invalid.join(", ")}`);
    const why = this.issuerRefusal(body!.issuer, [...new Set(scopes as string[])]);
    if (why !== null) return refused(422, why);
    const stored = userSourceRecord({
      id: `us_StandIn${String(++this.ids).padStart(20, "0")}`,
      name: body!.name,
      description: body!.description ?? "",
      issuer: body!.issuer,
      client_id: body!.client_id,
      client_secret: body!.client_secret,
      scopes: [...new Set(scopes as string[])],
      subject_claim: body!.subject_claim ?? "sub",
      status: body!.status ?? "active",
    });
    this.userSources.set(stored.id, stored);
    return success(this.userSourceResponse(stored), 201);
  }

  /** A plugin as `GET` returns it (`schemas.PluginResponse`): the bearer only as `{ exists }`. */
  private pluginResponse(stored: Json): Json {
    const { token, ...auth } = stored.webhook_config?.auth ?? {};
    const endpoints = Object.fromEntries(
      Object.entries(stored.webhook_config?.endpoints ?? {}).map(([point, endpoint]) => [point, point === this.omitEndpointUrl ? {} : { url: (endpoint as Json).url }]),
    );
    const health = this.healthCheckReadBack === "stored" ? stored.webhook_config?.health_check_path : this.healthCheckReadBack;
    return {
      id: stored.id,
      name: stored.name,
      description: stored.description,
      plugin_type: stored.plugin_type,
      ...(this.omitStatus ? {} : { status: stored.status }),
      health_status: "unknown",
      webhook_config: {
        ...(health === undefined ? {} : { health_check_path: health }),
        auth: { ...auth, token: { exists: typeof token === "string" && token !== "", editable: true, binding: "project" } },
        endpoints,
      },
    };
  }

  private writeHooks(pluginId: string, endpoints: Json): void {
    this.hooks = this.hooks.filter((hook) => hook.plugin_id !== pluginId);
    for (const [point, endpoint] of Object.entries(endpoints)) {
      this.hooks.push({
        id: `hk_${point}_${pluginId}`,
        plugin_id: pluginId,
        hook_point: `tool.${point}`,
        name: `${point}`,
        phase: (endpoint as Json).phase,
        failure_mode: (endpoint as Json).failure_mode,
        status: (endpoint as Json).status ?? "active",
      });
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = await request.text();
    const body = text ? (JSON.parse(text) as Json) : undefined;
    this.requests.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.get("authorization"), body });
    this.timeline.push(`arcade ${request.method} ${url.pathname}${url.search}`);
    if (request.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ message: "unauthorized" }, { status: 401 });

    // The org and project routes: only the key's own project is there.
    const scoped = /^\/v1\/orgs\/([^/]+)\/projects\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (scoped) {
      const [, org, project, rest] = scoped;
      if (org !== ORG || project !== PROJECT) return Response.json({ name: "not_found", message: "project not found" }, { status: 404 });
      return this.project(request.method, rest!, url.searchParams, body);
    }

    const [, , ...parts] = url.pathname.split("/"); // "", "v1", ...
    const route = `${request.method} /${parts.map((part, i) => (i > 0 && /^(auth_providers|secrets)$/.test(parts[i - 1]!) ? ":id" : part)).join("/")}`;
    switch (route) {
      case "GET /admin/auth_providers/:id": {
        const provider = this.providers.get(parts[2]!);
        return provider ? Response.json(provider) : Response.json({ message: "not found" }, { status: 404 });
      }
      case "POST /admin/auth_providers": {
        const sent = body as { id: string; oauth2: Json };
        const stored = {
          ...sent,
          status: "active",
          oauth2: { ...sent.oauth2, client_secret: { exists: true, editable: true, binding: "project" }, redirect_uri: this.nextCallback },
        };
        this.providers.set(sent.id, stored);
        return Response.json(stored, { status: 201 });
      }
      // The Arcade CLI's upsert (`arcade_cli/secret.py` `_upsert_secret`, and
      // `deploy.py` for `arcade deploy`): PUT, `{ description, value }`.
      // `value` is required and at most 5000 characters
      // (`schemas.UpsertStoredSecretRequest`).
      case "PUT /admin/secrets/:id": {
        if (this.secretsLikeTheLiveRun) return Response.json(ROUTE_NOT_FOUND, { status: 404 });
        const sent = body as { value?: unknown; description?: unknown } | undefined;
        if (typeof sent?.value !== "string" || sent.value === "" || sent.value.length > 5000) {
          return Response.json({ name: "malformed_request", message: "value is a required field" }, { status: 400 });
        }
        this.secrets.set(parts[2]!, sent.value);
        return Response.json({ id: `sec_${parts[2]}`, key: parts[2], description: sent.description ?? "" });
      }
      // No bare `/v1/plugins`, and nothing under a bare `/hooks` (#28): real
      // Arcade answered `GET /v1/plugins?limit=100` with the 404 below on the
      // second live run. They fall through to the default.
      case "PUT /admin/settings/session_verification":
        if (!this.verifierIgnoresPut) this.verifier = { ...(body as Json) };
        return Response.json(this.verifier);
      case "GET /admin/settings/session_verification":
        return Response.json(this.verifier);
      default:
        return Response.json(ROUTE_NOT_FOUND, { status: 404 });
    }
  }

  /** `/v1/orgs/{org}/projects/{project}<rest>`, in the live swagger's shapes (fetched on #30). */
  private project(method: string, rest: string, query: URLSearchParams, body: Json | undefined): Response {
    const page = (items: Json[]) => Response.json({ items, limit: Number(query.get("limit") ?? 20), offset: 0, total_count: items.length });
    const pluginId = /^\/plugins\/([^/]+)$/.exec(rest)?.[1];
    if (method === "GET" && rest === "/plugins") return page([...this.plugins.values()].map((each) => this.pluginResponse(each)));
    if ((method === "POST" && rest === "/plugins") || (pluginId !== undefined && method === "PATCH")) {
      const health = body?.webhook_config?.health_check_path;
      if ((method === "POST" || health !== undefined) && !isUrl(health)) return Response.json(HEALTH_CHECK_NOT_A_URL, { status: 400 });
    }
    if (method === "POST" && rest === "/plugins" && this.nextPluginCreate !== null) {
      const { status, body: answer } = this.nextPluginCreate;
      this.nextPluginCreate = null;
      return Response.json(answer, { status });
    }
    if (method === "POST" && rest === "/plugins") {
      if (!body?.name || !body.plugin_type || !body.webhook_config?.endpoints) {
        return Response.json({ name: "malformed_request", message: "name, plugin_type and webhook_config.endpoints are required" }, { status: 400 });
      }
      const id = `plg_${++this.ids}`;
      const stored = { ...body, id };
      this.plugins.set(id, stored);
      this.writeHooks(id, body.webhook_config.endpoints);
      return Response.json({ ...this.pluginResponse(stored), hooks: this.hooks.filter((hook) => hook.plugin_id === id) }, { status: 201 });
    }
    if (pluginId !== undefined && (method === "GET" || method === "PATCH")) {
      const stored = this.plugins.get(pluginId);
      if (!stored) return Response.json({ name: "not_found", message: "plugin not found" }, { status: 404 });
      if (method === "PATCH") {
        let patch = body;
        if (this.patchIgnoresStatus) {
          const endpoints = Object.fromEntries(
            Object.entries(body?.webhook_config?.endpoints ?? {}).map(([point, each]) => [point, { ...(each as Json), status: stored.webhook_config.endpoints[point]?.status }]),
          );
          patch = { ...body, status: stored.status, webhook_config: { ...body?.webhook_config, endpoints } };
        }
        const merged = { ...stored, ...patch, webhook_config: { ...stored.webhook_config, ...patch?.webhook_config } };
        this.plugins.set(pluginId, merged);
        if (body?.webhook_config?.endpoints) this.writeHooks(pluginId, merged.webhook_config.endpoints);
        return Response.json(this.pluginResponse(merged));
      }
      return Response.json(this.pluginResponse(stored));
    }
    if (method === "GET" && rest === "/hooks") {
      const plugin = query.get("plugin_id");
      return page(this.hooks.filter((hook) => plugin === null || hook.plugin_id === plugin));
    }
    // The gateway routes (#52), only ever reached under `--gateway`.
    if (method === "GET" && rest === "/gateways") return page([...this.gateways.values()]);
    if (method === "POST" && rest === "/gateways") {
      if (this.nextGatewayCreate !== null) {
        const { status, body: answer } = this.nextGatewayCreate;
        this.nextGatewayCreate = null;
        return Response.json(answer, { status });
      }
      if (body?.auth_type !== "user_source" || !this.userSources.has(body?.user_source_id)) {
        return Response.json({ name: "malformed_request", message: "user_source_id must name a User Source in this project" }, { status: 400 });
      }
      if ([...this.gateways.values()].some((each) => each.slug === body.slug)) {
        return Response.json({ name: "conflict", message: `slug ${body.slug} is taken` }, { status: 409 });
      }
      const id = `gw_${++this.ids}`;
      const stored = { ...body, id, status: "active" };
      this.gateways.set(id, stored);
      return Response.json(stored, { status: 201 });
    }
    const gatewayId = /^\/gateways\/([^/]+)$/.exec(rest)?.[1];
    if (gatewayId !== undefined && method === "GET") {
      if (this.gatewayReadBack !== null) return Response.json(this.gatewayReadBack.body, { status: this.gatewayReadBack.status });
      const stored = this.gateways.get(gatewayId);
      return stored ? Response.json(stored) : Response.json({ name: "not_found", message: "gateway not found" }, { status: 404 });
    }
    // The Arcade CLI's `server_already_exists`: org-scoped, 404 when the server is missing.
    const worker = /^\/workers\/([^/]+)$/.exec(rest)?.[1];
    if (worker !== undefined && method === "GET") {
      if (this.workerLookup !== null) return Response.json(this.workerLookup.body, { status: this.workerLookup.status });
      return this.workers.has(worker)
        ? Response.json({ id: worker, enabled: true, managed: true, type: "mcp" })
        : Response.json({ name: "not_found", message: `worker ${worker} not found` }, { status: 404 });
    }
    return Response.json(ROUTE_NOT_FOUND, { status: 404 });
  }
}

/**
 * A User Source with every key the human measured on #52 (`data.items.N`), as
 * this app's would be: `binding_type` `project`, `protocol` `oidc`, and
 * `active`, which the read by id requires.
 */
function userSourceRecord(fields: Json): Json {
  return {
    name: "Loans Approval Limits",
    description: "The app's sign-in, through its identity provider (hop 1)",
    issuer: arcade.issuer,
    binding_type: "project",
    protocol: "oidc",
    status: "active",
    subject_claim: "email",
    scopes: ["openid", "profile", "email"],
    organization_id: ORG,
    project_id: PROJECT,
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
    ...fields,
  };
}

/** A User Source somebody made in the dashboard, for this app's issuer and client. */
function dashboardUserSource(overrides: Json = {}): Json {
  const source = userSourceRecord({ id: USER_SOURCE, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...overrides });
  arcade.userSources.set(source.id, source);
  return source;
}

/** A gateway somebody made in the dashboard, under the slug a run on `HOST` derives. */
function dashboardGateway(overrides: Json = {}): Json {
  const gateway = {
    id: `gw_dashboard_${arcade.gateways.size + 1}`,
    name: "Loans Approval Limits",
    slug: "loan-desk-template-test",
    status: "active",
    auth_type: "user_source",
    user_source_id: USER_SOURCE,
    tool_filter: { allowed_tools: SIX_TOOLS },
    ...overrides,
  };
  arcade.gateways.set(gateway.id, gateway);
  return gateway;
}

/** The gateway's tool filter: the six LoanDesk tools, then Gmail and Slack (`gatewayTools` in arcade.ts). */
const SIX_TOOLS = ["LoanDesk.SearchLoans", "LoanDesk.GetLoan", "LoanDesk.ApproveLoan", "LoanDesk.DenyLoan", "LoanDesk.RequestApproval", "LoanDesk.Decide", "Gmail.SendEmail", "Gmail.ListEmails", "Slack.SendMessage"];

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cg-setup-arcade-")));
let arcade: StandIn;

/**
 * The Arcade CLI, faked: it records its working directory and arguments, and
 * fails where a test asks it to. First on `PATH`, so the real `arcade` is never
 * reached, and run under a throwaway `HOME`, so it could not find a login if it were.
 */
const FAKE_BIN = join(scratch, "bin");
mkdirSync(FAKE_BIN, { recursive: true });
writeFileSync(
  join(FAKE_BIN, "arcade"),
  [
    "#!/bin/sh",
    'echo "fake arcade: $* (in $PWD)"',
    'echo "$PWD|$*" >> "$FAKE_ARCADE_LOG"',
    // What the CLI would see as stdin: the harness hands setup-arcade a pipe, so an inherited stdin is one.
    // `/dev/null` is a character device; a pipe or socket (Bun's "pipe") is not.
    'if [ -c /dev/fd/0 ]; then echo "$PWD|stdin=none" >> "$FAKE_ARCADE_LOG.stdin"; else echo "$PWD|stdin=inherited" >> "$FAKE_ARCADE_LOG.stdin"; fi',
    'case "$PWD" in *"${FAKE_ARCADE_FAIL_IN:-no such directory}") echo "fake arcade: deploy failed" >&2; exit 3 ;; esac',
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(join(FAKE_BIN, "arcade"), 0o755);

beforeEach(() => {
  arcade?.stop();
  arcade = new StandIn();
});
afterAll(() => {
  arcade?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], { cwd, env: childEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }) });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
}

/** A `credentials.yaml` the way the Arcade CLI 1.16 writes it: named contexts, and the active one flat as well. */
function credentials(orgId: string, projectId: string): string {
  const [access, refresh, apiKey] = CLI_TOKENS;
  const context = [
    "      auth:",
    `        access_token: ${access}`,
    `        refresh_token: ${refresh}`,
    "        expires_at: '2026-09-26T00:00:00Z'",
    `      api_key: ${apiKey}`,
    "      context:",
    `        org_id: ${orgId}`,
    "        org_name: Stand-in Org",
    `        project_id: ${projectId}`,
    "        project_name: Stand-in Project",
    "      coordinator_url: https://cloud.arcade.dev",
    "      kind: cloud",
    "      user:",
    "        email: developer@example.com",
  ];
  return ["cloud:", "  active_context: cloud.arcade.dev", "  contexts:", "    cloud.arcade.dev:", ...context, ...context.map((line) => line.slice(4)), ""].join("\n");
}

interface Project {
  dir: string;
  /** The throwaway `HOME` the script and the fake CLI see. */
  home: string;
  /** Every `arcade` invocation, as `<dir relative to the project>|<args>`. */
  deploys(): string[];
}
const projects = new Map<string, Project>();

/**
 * A fresh project: `.env.example` copied to `.env`, `ARCADE_API_KEY` filled,
 * `.env` gitignored, the one toolkit directory `arcade deploy` runs in, and a
 * `HOME` whose Arcade CLI is logged in with the stand-in's project active.
 * `cli: null` is a CLI that was never logged in.
 */
function project(
  name: string,
  edit: (env: string) => string = (env) => env,
  cli: { orgId: string; projectId: string } | null = { orgId: ORG, projectId: PROJECT },
): string {
  const dir = join(scratch, name);
  // The one server directory, named the way this template's is: `[project] name`.
  mkdirSync(join(dir, "mcp"), { recursive: true });
  writeFileSync(join(dir, "mcp", "pyproject.toml"), `[project]\nname = "loan_desk"\nversion = "1.0.0"\n`);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".env\n*.db\n*.db-*\n");
  copyFileSync(join(ROOT, ".env.example"), join(dir, ".env.example"));
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  // The key, and what `bun run okta-setup` writes.
  const filled: Record<string, string> = {
    ARCADE_API_KEY: KEY,
    OKTA_ORG_URL: arcade.idpUrl,
    IDP_ISSUER: arcade.issuer,
    IDP_CLIENT_ID: CLIENT_ID,
    IDP_CLIENT_SECRET: CLIENT_SECRET,
  };
  let env = example;
  for (const [key, value] of Object.entries(filled)) {
    const next = env.replace(new RegExp(`^${key}=$`, "m"), `${key}=${value}`);
    if (next === env) throw new Error(`.env.example has no blank ${key}= line`);
    env = next;
  }
  writeFileSync(join(dir, ".env"), edit(env));
  const home = join(scratch, `${name}.home`);
  mkdirSync(home, { recursive: true });
  if (cli !== null) {
    mkdirSync(join(home, ".arcade"), { recursive: true });
    writeFileSync(join(home, ".arcade", "credentials.yaml"), credentials(cli.orgId, cli.projectId));
  }
  const log = join(scratch, `${name}.arcade.log`);
  projects.set(dir, {
    dir,
    home,
    deploys: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => line.replace(`${realpathSync(dir)}/`, "").replace(`${dir}/`, ""))
        : [],
  });
  return dir;
}

/** `failDeployIn`: the toolkit directory the fake CLI fails in. `shell`: variables the developer's shell exports. */
type RunOptions = { failDeployIn?: string; shell?: Record<string, string> };

async function setupArcade(cwd: string, ...args: Array<string | RunOptions>): Promise<{ code: number; stdout: string; stderr: string }> {
  const project = projects.get(cwd);
  if (!project) throw new Error(`${cwd} was not made by project()`);
  const options = args.find((arg): arg is RunOptions => typeof arg === "object") ?? {};
  const child = spawnChild(["bun", "--no-env-file", SCRIPT, HOST, ...args.filter((arg): arg is string => typeof arg === "string")], {
    cwd,
    env: childEnv({
      ...options.shell,
      ARCADE_API_URL: arcade.url,
      ARCADE_COORDINATOR_URL: arcade.coordinatorUrl,
      HOME: project.home,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
      FAKE_ARCADE_LOG: join(scratch, `${cwd.slice(scratch.length + 1)}.arcade.log`),
      ...(options.failDeployIn ? { FAKE_ARCADE_FAIL_IN: options.failDeployIn } : {}),
    }),
    // A pipe that stays open and is never written: what a child that inherits stdin would get.
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  // The CLI's tokens are in the file the script reads: none may come out of it.
  for (const token of CLI_TOKENS) expect(`${stdout}${stderr}`, `the run printed the CLI's ${token}`).not.toContain(token);
  expect(`${stdout}${stderr}`, "the run printed the Okta client's secret").not.toContain(CLIENT_SECRET);
  return { code, stdout, stderr };
}

function envOf(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(dir, ".env"), "utf8").split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

/** `METHOD /path`, with the ids Arcade minted written `{id}`, so a real run and a dry run compare. */
const normalise = (line: string) => line.replace(/plg_\d+|<plugin_id>|gw_\d+|<gateway_id>|us_[0-9A-Za-z]+|<user_source_id>/g, "{id}");
const sequence = (requests: Recorded[]) => requests.map((each) => normalise(`${each.method} ${each.path}`));

/** The key's check, the first call of every run that found a project (#30). */
const GUARD = `GET ${SCOPED}/plugins?limit=100`;
/** A fresh project's registrations, after the guard, up to the deploy's check. */
const FIRST_RUN = [
  GUARD,
  "GET /v1/admin/auth_providers/app-identity",
  "POST /v1/admin/auth_providers",
  "PUT /v1/admin/secrets/APP_PUBLIC_HOST",
  "PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN",
  "PUT /v1/admin/settings/session_verification",
  "GET /v1/admin/settings/session_verification",
  `POST ${SCOPED}/plugins`,
  `GET ${SCOPED}/plugins/{id}`,
  `GET ${SCOPED}/hooks?plugin_id={id}`,
  `GET ${SCOPED}/workers/loan_desk`,
];
/** A rerun's, once everything the first run did is there. */
const RERUN = [
  GUARD,
  "GET /v1/admin/auth_providers/app-identity",
  "PUT /v1/admin/secrets/APP_PUBLIC_HOST",
  "PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN",
  "PUT /v1/admin/settings/session_verification",
  "GET /v1/admin/settings/session_verification",
  `GET ${SCOPED}/hooks?plugin_id={id}`,
  `GET ${SCOPED}/workers/loan_desk`,
];
/** What a run adds when it finds the hooks disabled: turned on, and read back. */
const TURN_ON = [`PATCH ${SCOPED}/plugins/{id}`, `GET ${SCOPED}/plugins/{id}`, `GET ${SCOPED}/hooks?plugin_id={id}`];
const DEPLOYS = ["mcp|deploy"];
/** `--gateway` (#52): the gateway searched for by slug, after the deploys. */
const GATEWAY_CHECK = `GET ${SCOPED}/gateways?limit=100`;
/** What a fresh `--gateway` run adds after the check: the gateway created and read back. */
const GATEWAY_CREATE = [`POST ${SCOPED}/gateways`, `GET ${SCOPED}/gateways/{id}`];
/** The Coordinator's User Source route under the stand-in's project (#52), as a sequence names it. */
const USER_SOURCES = `/v1/orgs/${ORG}/projects/${PROJECT}/user_sources`;
const LIST = `GET ${USER_SOURCES}?limit=100&offset=0`;
const TEST_ISSUER = `POST ${USER_SOURCES}/test_issuer`;
const READ_BY_ID = `GET ${USER_SOURCES}/{id}`;
/** A fresh `--gateway` run's Coordinator calls: the list, the issuer check, the create, the read-back by id. */
const FIRST_COORDINATOR = [LIST, TEST_ISSUER, `POST ${USER_SOURCES}`, READ_BY_ID];
/** A rerun's: the list finds it, and it is read back by id. */
const RERUN_COORDINATOR = [LIST, READ_BY_ID];
const coordinatorSequence = () =>
  arcade.coordinatorRequests.map((each) => `${each.method} ${each.path.replace(/^\/api/, "").replace(/\/user_sources\/us_[0-9A-Za-z]+$/, "/user_sources/{id}")}`);
/**
 * The hooks as Arcade holds them, field by field: the three URLs on the
 * public host, fail closed, the health path, `.env`'s bearer, which the
 * stand-in keeps and never returns, and `status` on the plugin and on every
 * endpoint: `active` from the first run on. Nothing waits for a gateway form
 * any more (#48's reason for creating them disabled), so they govern every
 * call the agent makes from the start.
 */
function hooksAreRegistered(dir: string, status: "inactive" | "active"): void {
  const plugins = [...arcade.plugins.values()];
  expect(plugins.map((each) => each.name)).toEqual(["loan-approval-limits-hooks"]);
  const [plugin] = plugins as [Json];
  expect(plugin.plugin_type).toBe("webhook");
  expect(plugin.status).toBe(status);
  expect(plugin.webhook_config.health_check_path).toBe(`${ORIGIN}/hooks/health`);
  expect(plugin.webhook_config.auth).toEqual({ type: "bearer", token: envOf(dir).ARCADE_HOOK_SIGNING_SECRET });
  expect(plugin.webhook_config.endpoints).toEqual({
    access: { url: `${ORIGIN}/hooks/access`, phase: "before", failure_mode: "fail_closed", status },
    pre: { url: `${ORIGIN}/hooks/pre`, phase: "before", failure_mode: "fail_closed", status },
    post: { url: `${ORIGIN}/hooks/post`, phase: "after", failure_mode: "fail_closed", status },
  });
  expect(arcade.hooks.map((hook) => `${hook.hook_point} ${hook.phase} ${hook.failure_mode} ${hook.status}`).sort()).toEqual([
    `tool.access before fail_closed ${status}`,
    `tool.post after fail_closed ${status}`,
    `tool.pre before fail_closed ${status}`,
  ]);
}

/** No request about a gateway or a User Source, of any method, under any path: there is neither to find or make. */
function noGatewayRequest(): void {
  expect(arcade.requests.filter((each) => /\/(gateways|user_sources)\b/.test(each.path)).map((each) => `${each.method} ${each.path}`)).toEqual([]);
  expect(arcade.coordinatorRequests).toEqual([]);
}

/** What somebody switching the hooks off in the dashboard leaves: the plugin, every endpoint and every hook `inactive`. */
function disableHooks(): void {
  for (const plugin of arcade.plugins.values()) {
    plugin.status = "inactive";
    for (const endpoint of Object.values(plugin.webhook_config.endpoints)) (endpoint as Json).status = "inactive";
  }
  for (const hook of arcade.hooks) hook.status = "inactive";
}

/**
 * The contextual access hooks form (#28), field by field, for a run that found
 * no org and project. Every name on the left is the live swagger's, and the
 * bearer is named, never printed.
 */
function hooksFormIsComplete(stdout: string): void {
  const start = stdout.indexOf("┌─ Contextual access hooks");
  expect(start, "no contextual access hooks form").toBeGreaterThan(-1);
  const form = stdout.slice(start, stdout.indexOf("└─", start));
  expect(form).toMatch(/│ {2}name +loan-approval-limits-hooks$/m);
  expect(form).toMatch(/│ {2}plugin_type +webhook$/m);
  expect(form).toMatch(/│ {2}status +active$/m);
  for (const [point, phase] of [["access", "before"], ["pre", "before"], ["post", "after"]] as const) {
    const at = form.indexOf(`│  webhook_config.endpoints.${point}   (hook_point tool.${point})`);
    expect(at, `the form has no ${point} endpoint`).toBeGreaterThan(-1);
    const block = form.slice(at).split("\n").slice(1, 5).join("\n");
    expect(block).toMatch(new RegExp(`│ {4}url +${ORIGIN.replace(/\./g, "\\.")}/hooks/${point}$`, "m"));
    expect(block).toMatch(new RegExp(`│ {4}phase +${phase}$`, "m"));
    expect(block).toMatch(/│ {4}failure_mode +fail_closed$/m);
    expect(block).toMatch(/│ {4}status +active$/m);
  }
  expect(form).toMatch(new RegExp(`│ {2}webhook_config\\.health_check_path +${ORIGIN.replace(/\./g, "\\.")}/hooks/health$`, "m"));
  expect(form).toMatch(/│ {2}webhook_config\.auth\.type +bearer$/m);
  expect(form).toMatch(/│ {2}webhook_config\.auth\.token +the value of ARCADE_HOOK_SIGNING_SECRET in \.env \(not printed here\)$/m);
}

/** The forms in the order the output prints them. */
function formOrder(stdout: string): string[] {
  return [...stdout.matchAll(/^┌─ (.*)$/gm)].map(([, title]) =>
    /Contextual access hooks/.test(title!) ? "hooks" : title!,
  );
}

test("a first run registers every API-able piece with the hooks on, deploys the toolkits, and asks for no gateway or User Source", async () => {
  const mine = "the-developer-chose-this-session-secret-0123456789";
  const dir = project("full", (env) => env.replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${mine}`));
  const run = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, the first run ---\n${run.stdout}${run.stderr}`);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

  expect(run.stdout).toContain(`arcade        org ${ORG}, project ${PROJECT} (from the Arcade CLI's active context, `);
  expect(run.stdout).toContain(`.arcade/credentials.yaml, context cloud.arcade.dev)`);
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN);
  for (const request of arcade.requests) expect(request.authorization).toBe(`Bearer ${KEY}`);

  const env = envOf(dir);

  // The provider: Okta's endpoints from discovery, the Okta app's client, Basic plus PKCE, email as the user id.
  const provider = arcade.requests[2]!.body as { id: string; oauth2: Record<string, any> };
  expect(provider.id).toBe("app-identity");
  expect(provider.oauth2.client_id).toBe(CLIENT_ID);
  expect(provider.oauth2.client_secret).toBe(CLIENT_SECRET);
  expect(provider.oauth2.authorize_request.endpoint).toBe(`${arcade.issuer}/v1/authorize`);
  expect(provider.oauth2.token_request.endpoint).toBe(`${arcade.issuer}/v1/token`);
  expect(provider.oauth2.token_request.auth_method).toBe("client_secret_basic");
  expect(provider.oauth2.user_info_request.endpoint).toBe(`${arcade.issuer}/v1/userinfo`);
  expect(provider.oauth2.user_info_request.response_map).toEqual({ user_id: "$.email" });
  expect(provider.oauth2.pkce).toEqual({ enabled: true, code_challenge_method: "S256" });
  // Arcade's generated callback came back, and is in .env for `bun run okta-setup` to allowlist.
  expect(env.ARCADE_PROVIDER_CALLBACK).toBe(CALLBACK);
  expect(run.stdout).toContain(`wrote the provider's callback to .env: ${CALLBACK}`);
  expect(run.stdout).toContain("Okta does not allowlist it until you run `bun run okta-setup` again");

  // The hooks: by API since #30, with the bearer the app checks, which is never printed,
  // and on from the start: the agent calls the Engine directly, and these govern every call.
  hooksAreRegistered(dir, "active");
  const created = arcade.requests.find((each) => each.method === "POST" && each.path === `${SCOPED}/plugins`)!.body as Json;
  expect(created.status).toBe("active");
  expect(Object.values(created.webhook_config.endpoints).map((each) => (each as Json).status)).toEqual(["active", "active", "active"]);
  expect(run.stdout).toContain("hooks: created loan-approval-limits-hooks, on");
  expect(run.stdout).toContain(`hooks: ${ORIGIN}/hooks/access, /hooks/pre and /hooks/post, fail closed, status active (read back)`);
  expect(run.stdout).toContain(`hooks: Arcade doesn't echo webhook_config.health_check_path back; it was sent as ${ORIGIN}/hooks/health and can't be verified`);
  expect(`${run.stdout}${run.stderr}`).not.toContain(env.ARCADE_HOOK_SIGNING_SECRET!);

  // The deploy: one directory, streamed, after the hooks.
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(run.stdout).toContain("arcade deploy   (in mcp):\nfake arcade: deploy (in ");
  expect(run.stdout.indexOf("arcade deploy   (in mcp):")).toBeGreaterThan(run.stdout.indexOf("hooks: created"));

  // The tool secrets, in the CLI's body shape, and the verifier as read back.
  for (const request of arcade.requests.filter((each) => each.path.startsWith("/v1/admin/secrets/"))) {
    expect(Object.keys(request.body as object).sort()).toEqual(["description", "value"]);
  }
  expect(arcade.secrets.get("APP_PUBLIC_HOST")).toBe(HOST);
  expect(arcade.secrets.get("APPROVALS_STORE_TOKEN")).toBe(env.APPROVALS_STORE_TOKEN);
  expect(arcade.verifier).toEqual({ verifier_url: `${ORIGIN}/api/arcade/verify`, unsafe_skip_verification: false });

  // .env: every blank this run owns is filled, and the developer's value is not touched.
  expect(env.APP_PUBLIC_HOST).toBe(HOST);
  expect(env.ARCADE_HOOK_SIGNING_SECRET).toMatch(/^[0-9a-f]{64}$/);
  expect(env.APPROVALS_STORE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set([env.SESSION_SECRET, env.ARCADE_HOOK_SIGNING_SECRET, env.APPROVALS_STORE_TOKEN]).size).toBe(3);
  // What `bun run okta-setup` wrote is read, and left as it was.
  expect([env.IDP_ISSUER, env.IDP_CLIENT_ID, env.IDP_CLIENT_SECRET]).toEqual([arcade.issuer, CLIENT_ID, CLIENT_SECRET]);
  // No gateway slug: without --gateway there is no gateway to name, and the line stays blank.
  expect(env.ARCADE_GATEWAY_ID ?? "").toBe("");
  expect(env.GOVERNANCE_STREAM).toBe("hooks");
  // Every key .env.example says setup-arcade fills is filled.
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  const section = example.slice(example.indexOf("# --- Filled in by `bun run setup-arcade"), example.indexOf("# --- Optional"));
  // ARCADE_GATEWAY_ID is filled only under --gateway.
  const owned = [...section.matchAll(/^([A-Z_][A-Z0-9_]*)=$/gm)].map(([, key]) => key!).filter((key) => key !== "ARCADE_GATEWAY_ID");
  // Five: the sweep has to find them, or it proves nothing.
  expect(owned.length).toBeGreaterThanOrEqual(5);
  for (const key of owned) expect(env[key], `setup-arcade left ${key} blank`).toMatch(/\S/);
  expect(env.ARCADE_API_KEY).toBe(KEY);
  // A value setup-arcade would otherwise have written, set by hand first: kept.
  expect(env.SESSION_SECRET).toBe(mine);
  expect(run.stdout).toMatch(/kept\s+SESSION_SECRET/);

  // No gateway and no User Source: never asked about, and no form left for either.
  noGatewayRequest();
  expect(formOrder(run.stdout)).toEqual([]);
  expect(`${run.stdout}${run.stderr}`).not.toMatch(/gateway|User Source/i);
  // The steps left end the output, on opening the app.
  expect(run.stdout.trimEnd().endsWith(thenList(run.stdout))).toBe(true);
  expect(thenList(run.stdout).split("\n").slice(1)).toEqual([
    '  1. Allowlist the provider\'s callback on the Okta app: OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- bun run okta-setup',
    "  2. Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.",
    `  3. Start the tunnel: ngrok http --url=${HOST} 3000`,
    `  4. Open ${ORIGIN}, never localhost, and sign in.`,
  ]);
  // Nothing printed carries the API key.
  expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
}, 60_000);

/**
 * What is left after the first run, in the order the README's Quickstart
 * gives it (#11, #30): the app, the tunnel, then the app in a browser. There
 * is no dashboard form between them: no User Source, no gateway, and the
 * hooks are on already. Both texts are read here, so the list cannot drift
 * from the README, or the README from the list, without this failing.
 */
const NEXT_STEPS: Array<[string, RegExp]> = [
  ["start the app", /`bun run dev`/],
  ["start the tunnel", /ngrok http --url=/],
  ["open the app", /open `?https:\/\//i],
];

/** The step names in the order the text first mentions them, or the ones it never does. */
function stepOrder(text: string): string[] {
  const found = NEXT_STEPS.map(([name, pattern]) => ({ name, at: text.search(pattern) }));
  const missing = found.filter(({ at }) => at === -1).map(({ name }) => `missing: ${name}`);
  if (missing.length > 0) return missing;
  return found.sort((a, b) => a.at - b.at).map(({ name }) => name);
}

/** From the Quickstart step that starts the app and the tunnel to the end of the Quickstart. */
function readmeRemainder(): string {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const start = readme.indexOf("5. **Start the app and the tunnel**");
  const end = readme.indexOf("\n## ", start);
  if (start === -1 || end === -1) throw new Error("README.md's Quickstart has no step 5 to read from");
  return readme.slice(start, end);
}

/** The printed "Then:" list, from its heading to the blank line after it. */
function thenList(stdout: string): string {
  const start = stdout.lastIndexOf("Then:");
  expect(start, "no Then: list").toBeGreaterThan(-1);
  const rest = stdout.slice(start);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest.trimEnd() : rest.slice(0, end);
}

test("the steps it prints after the form are the README's, in the README's order", async () => {
  const run = await setupArcade(project("next-steps"));
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const printed = thenList(run.stdout);

  const order = NEXT_STEPS.map(([name]) => name);
  expect(stepOrder(printed)).toEqual(order);
  expect(stepOrder(readmeRemainder())).toEqual(order);
  expect(printed).toContain(`ngrok http --url=${HOST} `);
  expect(printed).toContain(`Open ${ORIGIN}, never localhost`);
  startsTheApp(printed);
  // Nothing about deploying, a form or a second run is left: this run
  // deployed, and registered the hooks by API, on.
  expect(printed).not.toMatch(/arcade deploy|form|setup-arcade/);

  // The check bites: the tunnel ahead of the app fails it, and so does
  // opening the app ahead of the tunnel it is reached through.
  const moveBefore = (moving: RegExp, before: RegExp) => {
    const lines = printed.split("\n");
    const [line] = lines.splice(lines.findIndex((each) => moving.test(each)), 1);
    lines.splice(lines.findIndex((each) => before.test(each)), 0, line!);
    return lines.join("\n");
  };
  expect(stepOrder(moveBefore(/ngrok http/, /bun run dev/))).not.toEqual(order);
  expect(stepOrder(moveBefore(/Open /, /ngrok http/))).not.toEqual(order);
}, 60_000);

test("a dry run ends with the same steps", async () => {
  const run = await setupArcade(project("next-steps-dry"), "--dry-run");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const printed = thenList(run.stdout);
  expect(stepOrder(printed)).toEqual(NEXT_STEPS.map(([name]) => name));
  startsTheApp(printed);
});

/**
 * The first step starts the app; it does not restart it (#26). A developer
 * following the Quickstart runs `setup-arcade` at step 4 and has never started
 * `bun run dev`: "Restart" told them to restart something that was not running.
 * The one step allowed ahead of it is the Okta allowlist, when this run wrote a
 * new provider callback: sign-in through Arcade fails until Okta knows it.
 */
function startsTheApp(printed: string): void {
  const numbered = printed.split("\n").filter((line) => /^\s*\d+\./.test(line));
  const first = /bun run okta-setup/.test(numbered[0] ?? "") ? numbered[1] : numbered[0];
  expect(first ?? "").toMatch(/^\s*\d\. Start `bun run dev`/);
  expect(printed).not.toMatch(/^\s*\d\. Restart/m);
}

test("--dry-run from a fresh project prints the requests a real run makes, in order, and writes, sends and deploys nothing", async () => {
  const dir = project("dry");
  const before = readFileSync(join(dir, ".env"), "utf8");
  const run = await setupArcade(dir, "--dry-run");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

  expect(arcade.requests).toEqual([]);
  expect(projects.get(dir)!.deploys()).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);

  expect(printedRequests(run.stdout)).toEqual(FIRST_RUN);
  expect(run.stdout).toContain("Authorization: Bearer <ARCADE_API_KEY>");
  // Each tool secret: PUT, the CLI's `{ description, value }`, and the store
  // token only as a placeholder, because a dry run shows no secret.
  const secret = (key: string) => bodyAfter(run.stdout, `  PUT ${arcade.url}/v1/admin/secrets/${key}\n`);
  expect(Object.keys(secret("APP_PUBLIC_HOST"))).toEqual(["description", "value"]);
  expect(secret("APP_PUBLIC_HOST").value).toBe(HOST);
  expect(Object.keys(secret("APPROVALS_STORE_TOKEN"))).toEqual(["description", "value"]);
  expect(secret("APPROVALS_STORE_TOKEN").value).toBe("<generated APPROVALS_STORE_TOKEN>");
  // The hooks: the whole body, with the bearer as a placeholder.
  const plugin = bodyAfter(run.stdout, `  POST ${arcade.url}${SCOPED}/plugins\n`);
  expect(plugin.webhook_config.auth).toEqual({ type: "bearer", token: "<generated ARCADE_HOOK_SIGNING_SECRET>" });
  expect(plugin.status).toBe("active");
  expect(plugin.webhook_config.endpoints.pre).toEqual({ url: `${ORIGIN}/hooks/pre`, phase: "before", failure_mode: "fail_closed", status: "active" });
  expect(run.stdout).toContain("(the hooks: the list above is searched for loan-approval-limits-hooks. With none, it is created on:)");
  expect(run.stdout).toContain(`identity: a real run reads ${arcade.issuer}/.well-known/openid-configuration for the provider's endpoints`);
  expect(run.stdout).toContain(
    "Deploys, after the hooks, each stopping the run if it fails, unless Arcade already runs it:\n  arcade deploy   (in mcp)",
  );
  expect(run.stdout).not.toContain("POST " + arcade.url + "/v1/admin/secrets");
  expect(run.stdout).toMatch(/would fill .*\bARCADE_PROVIDER_CALLBACK\b/);
  expect(run.stdout).not.toContain(CLIENT_SECRET);
  expect(run.stdout).not.toContain(KEY);
  expect(formOrder(run.stdout)).toEqual([]);
  expect(run.stdout).not.toMatch(/gateway|User Source|user_sources/i);
});

/** The JSON body a dry run prints under a request line. */
function bodyAfter(stdout: string, line: string): Json {
  const at = stdout.indexOf(line);
  expect(at, `the dry run prints no ${line.trim()}`).toBeGreaterThan(-1);
  const block = stdout.slice(at).split("\n");
  const json = block.slice(3, block.findIndex((each, i) => i > 3 && each === "    }") + 1).join("\n");
  return JSON.parse(json) as Json;
}

test("hooks found disabled are turned on and read back, and the run after says they are on", async () => {
  const dir = project("turn-on");
  expect((await setupArcade(dir)).code).toBe(0);
  // Somebody switched them off in the dashboard.
  disableHooks();
  hooksAreRegistered(dir, "inactive");
  arcade.requests = [];
  const run = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, with the hooks found disabled ---\n${run.stdout}${run.stderr}`);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(sequence(arcade.requests)).toEqual([...RERUN.slice(0, -1), ...TURN_ON, RERUN.at(-1)!]);
  const patch = arcade.requests.find((each) => each.method === "PATCH")!.body as Json;
  expect(patch.status).toBe("active");
  expect(Object.values(patch.webhook_config.endpoints).map((each) => (each as Json).status)).toEqual(["active", "active", "active"]);
  hooksAreRegistered(dir, "active");
  expect(run.stdout).toContain("hooks: loan-approval-limits-hooks is registered and disabled, so it is turned on");
  expect(run.stdout).toContain(`hooks: ${ORIGIN}/hooks/access, /hooks/pre and /hooks/post, fail closed, status active (read back)`);
  noGatewayRequest();
  expect(formOrder(run.stdout)).toEqual([]);

  // The run after: a no-op for the hooks, which says they are on.
  arcade.requests = [];
  const plugin = JSON.stringify([...arcade.plugins.values()]);
  const again = await setupArcade(dir);
  expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
  expect(sequence(arcade.requests)).toEqual(RERUN);
  expect(again.stdout).toContain("hooks: loan-approval-limits-hooks is already registered, matches and is on; it is left as it is");
  expect(JSON.stringify([...arcade.plugins.values()])).toBe(plugin);
}, 90_000);

test("rerunning the first run after it failed finds the hooks on and leaves them", async () => {
  const dir = project("first-run-again");
  const failed = await setupArcade(dir, { failDeployIn: "mcp" });
  expect(failed.code).toBe(1);
  hooksAreRegistered(dir, "active");
  arcade.requests = [];
  const again = await setupArcade(dir);
  expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
  hooksAreRegistered(dir, "active");
  expect(arcade.requests.filter((each) => each.method === "PATCH" || each.method === "POST")).toEqual([]);
}, 90_000);

test("hooks that read back not active fail the run: a create, a turn-on, and a read-back with no status", async () => {
  // A create that does not take.
  const created = project("create-not-taken");
  arcade.omitStatus = true;
  const fresh = await setupArcade(created);
  expect(fresh.code).toBe(1);
  expect(fresh.stderr).toContain("the hooks did not take: Arcade reads back");
  expect(fresh.stderr).toContain('  - status: Arcade has nothing, this app needs "active"');
  arcade.omitStatus = false;

  const dir = project("turn-on-not-taken");
  expect((await setupArcade(dir)).code).toBe(0);
  disableHooks();

  arcade.patchIgnoresStatus = true;
  const ignored = await setupArcade(dir);
  expect(ignored.code).toBe(1);
  expect(ignored.stderr).toContain("the hooks did not turn on: Arcade reads back");
  expect(ignored.stderr).toContain('  - status: Arcade has "inactive", this app needs "active"');
  expect(ignored.stderr).toContain('  - tool.pre.status: Arcade has "inactive", this app needs "active"');

  arcade.patchIgnoresStatus = false;
  arcade.omitStatus = true;
  const silent = await setupArcade(dir);
  expect(silent.code).toBe(1);
  expect(silent.stderr).toContain("the hooks did not turn on: Arcade reads back");
  expect(silent.stderr).toContain('  - status: Arcade has nothing, this app needs "active"');
}, 90_000);

test("--gateway with a slug that is not one is refused before anything is sent, and an unknown flag names the usage", async () => {
  const bad = await setupArcade(project("bad-slug"), "--gateway=Loan_Desk");
  expect(bad.code).toBe(64);
  expect(bad.stderr).toContain("--gateway Loan_Desk: a slug is lowercase letters, digits and hyphens");
  const unknown = await setupArcade(project("unknown-flag"), "--gateways");
  expect(unknown.code).toBe(64);
  expect(unknown.stderr).toContain("--gateways: not an option of this command");
  expect(unknown.stderr).toContain("usage: bun run setup-arcade <ngrok-host> [--dry-run] [--skip-deploy] [--redeploy] [--gateway[=<slug>]]\n");
  expect(arcade.requests).toEqual([]);
  noGatewayRequest();
});

test("without --gateway, ARCADE_GATEWAY_ID in .env is left alone with a note, and ARCADE_USER_SOURCE_ID is ignored with one", async () => {
  const dir = project("leftover-gateway", (env) => `${env.replace(/^ARCADE_GATEWAY_ID=$/m, `ARCADE_GATEWAY_ID=${OLD_GATEWAY}`)}\nARCADE_USER_SOURCE_ID=${USER_SOURCE}\n`);
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const notes = run.stdout.split("\n").filter((line) => /ARCADE_(GATEWAY|USER_SOURCE)_ID/.test(line));
  expect(notes).toEqual([
    `  note          ARCADE_GATEWAY_ID=${OLD_GATEWAY} is set; this run leaves the gateway as it is (pass --gateway to check or create it)`,
    "  note          ARCADE_USER_SOURCE_ID is set, and ignored: the User Source is found by its issuer and client, so you can delete it",
  ]);
  expect(`${run.stdout}${run.stderr}`).not.toContain(USER_SOURCE);
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN);
  noGatewayRequest();
  // Left in .env as they were: deleting a line is the developer's call.
  expect(envOf(dir).ARCADE_GATEWAY_ID).toBe(OLD_GATEWAY);
  // Without either, no note.
  const clean = await setupArcade(project("no-leftover"));
  expect(clean.stdout).not.toContain("note          ARCADE_");
}, 60_000);

test("without --gateway it never asks Arcade about a gateway or a User Source, and never names Arcade Headers mode, in a run, a rerun or a dry one", async () => {
  const dir = project("no-headers");
  const first = await setupArcade(dir);
  const second = await setupArcade(dir);
  const dry = await setupArcade(project("no-headers-dry"), "--dry-run");
  for (const run of [first, second, dry]) expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const everything = [first.stdout, first.stderr, second.stdout, second.stderr, dry.stdout, dry.stderr, JSON.stringify(arcade.requests), readFileSync(join(ROOT, "scripts", "setup-arcade", "arcade.ts"), "utf8")].join("\n");
  expect(everything).not.toMatch(/arcade_header/i);
  noGatewayRequest();
  expect(dry.stdout).not.toMatch(/\/(gateways|user_sources)\b/);
  // The check bites: a gateway read in the log is caught, and so is a User Source one.
  arcade.requests.push({ method: "GET", path: `${SCOPED}/gateways?limit=100`, authorization: null, body: undefined });
  expect(() => noGatewayRequest()).toThrow();
  arcade.requests = [{ method: "GET", path: `/v1/orgs/${ORG}/projects/${PROJECT}/user_sources`, authorization: null, body: undefined }];
  expect(() => noGatewayRequest()).toThrow();
}, 90_000);

// --- --gateway (#52): the User Source and the gateway, by API ------------------

test("--gateway on a fresh project: the User Source through the Coordinator, the gateway through it with the nine tools, each read back, and ARCADE_GATEWAY_ID written", async () => {
  const dir = project("gateway-first");
  const run = await setupArcade(dir, "--gateway");
  console.log(`--- setup-arcade ${HOST} --gateway, the first run ---\n${run.stdout}${run.stderr}`);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

  // Arcade's API: the first run as without the flag, then the gateway searched, created and read back. The hooks are not touched again.
  expect(sequence(arcade.requests)).toEqual([...FIRST_RUN, GATEWAY_CHECK, ...GATEWAY_CREATE]);
  expect(coordinatorSequence()).toEqual(FIRST_COORDINATOR);
  for (const request of [...arcade.requests, ...arcade.coordinatorRequests]) expect(request.authorization).toBe(`Bearer ${KEY}`);
  hooksAreRegistered(dir, "active");
  expect(arcade.requests.filter((each) => each.method === "PATCH")).toEqual([]);

  // The User Source: the dashboard form's fields, the Okta app's client, IDP_ISSUER, email as the join key.
  expect(arcade.userSources.size).toBe(1);
  const [source] = [...arcade.userSources.values()] as [Json];
  const [checked, create] = arcade.coordinatorRequests.filter((each) => each.method === "POST");
  expect(checked!.body).toEqual({ issuer: arcade.issuer });
  expect(create!.body).toEqual({
    name: "Loans Approval Limits",
    description: "The app's sign-in, through its identity provider (hop 1)",
    protocol: "oidc",
    issuer: arcade.issuer,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    subject_claim: "email",
    scopes: ["openid", "profile", "email"],
    status: "active",
  });
  expect(run.stdout).toContain(`user source: created Loans Approval Limits (${source.id}), issuer ${arcade.issuer}, client ${CLIENT_ID}, status active (read back)`);

  // The gateway: through that User Source, never Headers, exactly the nine tools.
  const created = arcade.requests.find((each) => each.method === "POST" && each.path === `${SCOPED}/gateways`)!.body as Json;
  expect(created).toEqual({
    name: "Loans Approval Limits",
    description: "The loan officer's agent",
    slug: "loan-desk-template-test",
    auth_type: "user_source",
    user_source_id: source.id,
    tool_filter: { allowed_tools: SIX_TOOLS },
  });
  expect(arcade.gateways.size).toBe(1);
  expect(run.stdout).toContain(`gateway: created loan-desk-template-test, through the User Source ${source.id}, with the six LoanDesk tools and Gmail and Slack (read back)`);
  expect(run.stdout).toContain(`gateway: ${arcade.url}/mcp/loan-desk-template-test, written to .env as ARCADE_GATEWAY_ID`);

  // .env: the slug, on the line .env.example leaves blank for it.
  expect(envOf(dir).ARCADE_GATEWAY_ID).toBe("loan-desk-template-test");
  // No form, and the steps end on the MCP client.
  expect(formOrder(run.stdout)).toEqual([]);
  expect(thenList(run.stdout).split("\n").slice(1)).toEqual([
    '  1. Allowlist the provider\'s callback on the Okta app: OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- bun run okta-setup',
    "  2. Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.",
    `  3. Start the tunnel: ngrok http --url=${HOST} 3000`,
    `  4. Open ${ORIGIN}, never localhost, and sign in.`,
    `  5. Connect an MCP client to the gateway: claude mcp add --transport http loan-desk ${arcade.url}/mcp/loan-desk-template-test, then /mcp in Claude Code to sign in at Okta.`,
  ]);
  expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
  expect(`${run.stdout}${run.stderr}`).not.toContain(CLIENT_SECRET);
  expect(JSON.stringify([...arcade.requests, ...arcade.coordinatorRequests])).not.toMatch(/arcade_header/i);
}, 60_000);

test("--gateway again finds both and changes nothing; without the flag the next run leaves the gateway alone with a note", async () => {
  const dir = project("gateway-rerun");
  expect((await setupArcade(dir, "--gateway")).code).toBe(0);
  const envText = readFileSync(join(dir, ".env"), "utf8");
  const gateways = JSON.stringify([...arcade.gateways.values()]);
  arcade.requests = [];
  arcade.coordinatorRequests = [];

  const again = await setupArcade(dir, "--gateway");
  expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
  expect(sequence(arcade.requests)).toEqual([...RERUN, GATEWAY_CHECK]);
  expect(coordinatorSequence()).toEqual(RERUN_COORDINATOR);
  const [source] = [...arcade.userSources.values()] as [Json];
  expect(again.stdout).toContain(`user source: found Loans Approval Limits (${source.id}), issuer ${arcade.issuer}, client ${CLIENT_ID}; it matches and is left as it is`);
  expect(again.stdout).toContain(`gateway: found loan-desk-template-test, through the User Source ${source.id}; it is left as it is`);
  expect(again.stdout).toContain(`gateway: ${arcade.url}/mcp/loan-desk-template-test (ARCADE_GATEWAY_ID is already in .env)`);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envText);
  expect(JSON.stringify([...arcade.gateways.values()])).toBe(gateways);
  expect(arcade.userSources.size).toBe(1);

  // The flag off: the slug in .env is a note, and nothing about a gateway is asked.
  arcade.requests = [];
  arcade.coordinatorRequests = [];
  const plain = await setupArcade(dir);
  expect(plain.code, `${plain.stdout}\n${plain.stderr}`).toBe(0);
  expect(plain.stdout).toContain("  note          ARCADE_GATEWAY_ID=loan-desk-template-test is set; this run leaves the gateway as it is (pass --gateway to check or create it)");
  expect(sequence(arcade.requests)).toEqual(RERUN);
  noGatewayRequest();
  expect(envOf(dir).ARCADE_GATEWAY_ID).toBe("loan-desk-template-test");
  expect(thenList(plain.stdout)).not.toContain("claude mcp add");
}, 90_000);

test("--gateway=<slug> names the gateway, --gateway <slug> too, and a slug that disagrees with .env is refused", async () => {
  const dir = project("gateway-slug");
  const run = await setupArcade(dir, "--gateway=loan-desk-mine");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect([...arcade.gateways.values()].map((each) => each.slug)).toEqual(["loan-desk-mine"]);
  expect(envOf(dir).ARCADE_GATEWAY_ID).toBe("loan-desk-mine");
  // The same slug, as a separate word: found.
  arcade.requests = [];
  const spaced = await setupArcade(dir, "--gateway", "loan-desk-mine");
  expect(spaced.code, `${spaced.stdout}\n${spaced.stderr}`).toBe(0);
  expect(spaced.stdout).toContain("gateway: found loan-desk-mine");
  expect(arcade.gateways.size).toBe(1);
  // Another slug, with .env naming this one: refused before anything is sent.
  arcade.requests = [];
  arcade.coordinatorRequests = [];
  const other = await setupArcade(dir, "--gateway=loan-desk-other");
  expect(other.code).toBe(1);
  expect(other.stderr).toContain(".env has ARCADE_GATEWAY_ID=loan-desk-mine, and this run was given --gateway loan-desk-other. Blank it in .env to use loan-desk-other.");
  expect(arcade.requests).toEqual([]);
  noGatewayRequest();
}, 90_000);

test("--gateway --dry-run prints the Coordinator and gateway requests after the deploys, and writes, sends and deploys nothing", async () => {
  const dir = project("gateway-dry");
  const before = readFileSync(join(dir, ".env"), "utf8");
  const run = await setupArcade(dir, "--gateway", "--dry-run");
  console.log(`--- setup-arcade ${HOST} --gateway --dry-run ---\n${run.stdout}${run.stderr}`);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(arcade.requests).toEqual([]);
  expect(arcade.coordinatorRequests).toEqual([]);
  expect(projects.get(dir)!.deploys()).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(printedRequests(run.stdout)).toEqual([...FIRST_RUN, ...FIRST_COORDINATOR, GATEWAY_CHECK, ...GATEWAY_CREATE]);
  expect(run.stdout).toContain(`  gateway       loan-desk-template-test  (${arcade.url}/mcp/loan-desk-template-test)`);
  expect(run.stdout).toMatch(/would fill .*\bARCADE_GATEWAY_ID \(loan-desk-template-test, once the gateway exists\)/);
  expect(bodyAfter(run.stdout, `  POST ${arcade.coordinatorUrl}${USER_SOURCES}/test_issuer\n`)).toEqual({ issuer: arcade.issuer });
  const source = bodyAfter(run.stdout, `  POST ${arcade.coordinatorUrl}${USER_SOURCES}\n`);
  expect(source.client_id).toBe(CLIENT_ID);
  expect(source.client_secret).toBe("<IDP_CLIENT_SECRET from .env>");
  const gateway = bodyAfter(run.stdout, `  POST ${arcade.url}${SCOPED}/gateways\n`);
  expect(gateway.slug).toBe("loan-desk-template-test");
  expect(gateway.auth_type).toBe("user_source");
  expect(gateway.tool_filter.allowed_tools).toEqual(SIX_TOOLS);
  expect(run.stdout).toContain("then ARCADE_GATEWAY_ID=loan-desk-template-test is written to .env");
  expect(run.stdout).not.toContain(CLIENT_SECRET);
  expect(run.stdout).not.toContain(KEY);
  expect(formOrder(run.stdout)).toEqual([]);
  expect(thenList(run.stdout)).toContain("claude mcp add --transport http loan-desk");
});

test("--gateway with the Coordinator unavailable registers the hooks, then stops on the User Source and gateway forms, exit 1, nothing written for the gateway", async () => {
  const dir = project("gateway-no-coordinator");
  arcade.coordinatorMode = "unavailable";
  const run = await setupArcade(dir, "--gateway");
  console.log(`--- setup-arcade ${HOST} --gateway, Coordinator unavailable ---\n${run.stdout}${run.stderr}`);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
  // Everything up to the gateway is done, and the hooks are on.
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN);
  expect(coordinatorSequence()).toEqual([LIST]);
  hooksAreRegistered(dir, "active");
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(run.stderr).toContain("setup-arcade: ");
  expect(run.stdout).toContain("The User Source and the gateway were not registered by API, so they are the dashboard forms below. Everything above is done.");
  expect(run.stdout).toContain("Two dashboard forms are left, in the order you fill them in:");
  expect(formOrder(run.stdout)).toEqual(["Arcade dashboard → your project → User Sources → Create User Source", "Arcade dashboard → your project → MCP Gateways → Create Gateway"]);
  expect(run.stdout).toContain(`│  Issuer URL      ${arcade.issuer}`);
  expect(run.stdout).toContain("│  Slug              loan-desk-template-test        ← .env's ARCADE_GATEWAY_ID");
  expect(run.stdout).not.toContain(CLIENT_SECRET);
  expect(envOf(dir).ARCADE_GATEWAY_ID ?? "").toBe("");
  expect(thenList(run.stdout)).toContain("Fill in the User Source form and then the gateway form above");
  // The provider, the secrets, the hooks: a rerun with the Coordinator back finishes the job without redoing them.
  arcade.coordinatorMode = "available";
  arcade.requests = [];
  const again = await setupArcade(dir, "--gateway");
  expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
  expect(sequence(arcade.requests)).toEqual([...RERUN, GATEWAY_CHECK, ...GATEWAY_CREATE]);
  expect(envOf(dir).ARCADE_GATEWAY_ID).toBe("loan-desk-template-test");
}, 90_000);

test("--gateway with no org and project prints the hooks, User Source and gateway forms, and exits 0", async () => {
  const dir = project("gateway-no-scope", (env) => env, null);
  const run = await setupArcade(dir, "--gateway");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain("The hooks, the User Source and the gateway are printed as dashboard forms instead.");
  expect(run.stdout).toContain("Three dashboard forms are left, in the order you fill them in:");
  expect(formOrder(run.stdout)).toEqual(["hooks", "Arcade dashboard → your project → User Sources → Create User Source", "Arcade dashboard → your project → MCP Gateways → Create Gateway"]);
  noGatewayRequest();
  expect(envOf(dir).ARCADE_GATEWAY_ID ?? "").toBe("");
}, 60_000);

test("--gateway with the slug taken elsewhere stops on the gateway form, with the User Source registered", async () => {
  const dir = project("gateway-taken");
  arcade.nextGatewayCreate = { status: 409, body: { name: "conflict", message: "slug loan-desk-template-test is taken" } };
  const run = await setupArcade(dir, "--gateway");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
  expect(run.stderr).toContain("Arcade says the slug loan-desk-template-test is taken. Blank ARCADE_GATEWAY_ID in .env and run this with --gateway=<another-slug>");
  const [source] = [...arcade.userSources.values()] as [Json];
  expect(run.stdout).toContain(`The User Source ${source.id} is registered and the gateway is not, so the gateway is the dashboard form below.`);
  expect(formOrder(run.stdout)).toEqual(["Arcade dashboard → your project → MCP Gateways → Create Gateway"]);
  expect(run.stdout).toContain(`(${source.id}, already registered)`);
  expect(envOf(dir).ARCADE_GATEWAY_ID ?? "").toBe("");
  // Another slug: created, and the User Source found.
  arcade.requests = [];
  arcade.coordinatorRequests = [];
  const other = await setupArcade(dir, "--gateway=loan-desk-template-test-2");
  expect(other.code, `${other.stdout}\n${other.stderr}`).toBe(0);
  expect(coordinatorSequence()).toEqual(RERUN_COORDINATOR);
  expect(sequence(arcade.requests)).toEqual([...RERUN, GATEWAY_CHECK, ...GATEWAY_CREATE]);
  expect(envOf(dir).ARCADE_GATEWAY_ID).toBe("loan-desk-template-test-2");
}, 90_000);

test("--gateway finds a dashboard-made gateway on the slug, and refuses one that does not authenticate through the User Source", async () => {
  const dir = project("gateway-dashboard");
  dashboardUserSource();
  dashboardGateway();
  const run = await setupArcade(dir, "--gateway");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(coordinatorSequence()).toEqual(RERUN_COORDINATOR);
  expect(run.stdout).toContain(`gateway: found loan-desk-template-test, through the User Source ${USER_SOURCE}; it is left as it is`);
  expect(arcade.requests.filter((each) => each.method === "POST" && each.path.endsWith("/gateways"))).toEqual([]);
  expect(envOf(dir).ARCADE_GATEWAY_ID).toBe("loan-desk-template-test");

  for (const authType of ["arcade", ["arcade", "header"].join("_"), undefined]) {
    arcade.gateways.clear();
    dashboardGateway({ auth_type: authType, user_source_id: undefined });
    const refused = await setupArcade(dir, "--gateway");
    expect(refused.code, `${authType}: ${refused.stdout}\n${refused.stderr}`).toBe(1);
    expect(refused.stderr).toContain("the gateway loan-desk-template-test does not authenticate through this app's User Source:");
    expect(refused.stderr).toContain(`  - auth_type: Arcade has ${JSON.stringify(authType) ?? "nothing"}, this app needs "user_source"`);
    expect(refused.stderr).toContain("this template never runs a gateway on Arcade Headers or on Arcade accounts");
  }
  // A tool list that is not the nine: found anyway, with the differences as warnings.
  arcade.gateways.clear();
  dashboardGateway({ tool_filter: { allowed_tools: [...SIX_TOOLS.filter((tool) => tool !== "LoanDesk.DenyLoan"), "Elsewhere.Other"] } });
  const differs = await setupArcade(dir, "--gateway");
  expect(differs.code, `${differs.stdout}\n${differs.stderr}`).toBe(0);
  expect(differs.stdout).toContain("  warning       tool_filter.allowed_tools is missing LoanDesk.DenyLoan");
  expect(differs.stdout).toContain("  warning       tool_filter.allowed_tools also has Elsewhere.Other, which this app does not use");
}, 120_000);

test("--gateway with a User Source that differs for this issuer stops, edits nothing, and creates no gateway", async () => {
  const dir = project("gateway-source-differs");
  dashboardUserSource({ client_id: "0oaSomebodyElses" });
  const run = await setupArcade(dir, "--gateway");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
  expect(run.stderr).toContain(`  - client_id: Arcade has "0oaSomebodyElses", this app needs "${CLIENT_ID}"`);
  expect(run.stderr).toContain("this command never edits a User Source");
  expect(coordinatorSequence()).toEqual([LIST]);
  expect(arcade.gateways.size).toBe(0);
  expect(envOf(dir).ARCADE_GATEWAY_ID ?? "").toBe("");
}, 60_000);

/** The routes real Arcade does not have (#28): a bare `/v1/plugins`, and a bare `/v1/hooks`. */
const BARE_PLUGIN_OR_HOOK_ROUTE = /^\/v1\/(plugins|hooks)(\/|\?|$)/;

test("it never calls the bare plugins or hooks route, in a fresh run, a rerun or a dry run: only the project's", async () => {
  const dir = project("no-bare-plugins");
  const first = await setupArcade(dir);
  const again = await setupArcade(dir);
  const dry = await setupArcade(dir, "--dry-run");
  const dryFresh = await setupArcade(project("no-bare-plugins-dry"), "--dry-run");

  const paths = arcade.requests.map((each) => each.path);
  expect(paths.filter((each) => BARE_PLUGIN_OR_HOOK_ROUTE.test(each))).toEqual([]);
  expect(paths.filter((each) => /\/(plugins|hooks)\b/.test(each)).every((each) => each.startsWith(`${SCOPED}/`))).toBe(true);
  for (const run of [dry, dryFresh]) {
    const printed = [...run.stdout.matchAll(/^ {2}(GET|POST|PUT|PATCH|DELETE) (\S+)$/gm)].map(([, , url]) => new URL(url!).pathname);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.filter((each) => BARE_PLUGIN_OR_HOOK_ROUTE.test(each))).toEqual([]);
  }
  for (const run of [first, again, dry, dryFresh]) expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  // The check bites: the request the pre-#28 script sent first is caught.
  expect(BARE_PLUGIN_OR_HOOK_ROUTE.test("/v1/plugins")).toBe(true);
  expect(BARE_PLUGIN_OR_HOOK_ROUTE.test(`${SCOPED}/plugins`)).toBe(false);
}, 120_000);

test("the stand-in has no bare plugins route, and only the key's own project under the org routes", async () => {
  const call = (method: string, path: string) =>
    fetch(`${arcade.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
  for (const [method, path] of [
    ["GET", "/v1/plugins?limit=100"],
    ["POST", "/v1/plugins"],
    ["PATCH", "/v1/plugins/plg_1"],
    ["POST", "/v1/hooks"],
    ["GET", `/v1/orgs/${ORG}/plugins`],
  ] as const) {
    const answer = await call(method, path);
    expect(answer.status, `${method} ${path}`).toBe(404);
    expect(await answer.text()).toBe('{"name":"route_not_found","message":"requested route is not found or method is not allowed"}');
  }
  expect((await call("GET", `${SCOPED}/plugins`)).status).toBe(200);
  expect((await call("GET", `/v1/orgs/${ORG}/projects/prj_somebody_else/plugins`)).status).toBe(404);
});

test("a tracked .env is refused before anything is read, written or sent", async () => {
  const dir = project("tracked");
  git(dir, "add", "-f", ".env");
  git(dir, "commit", "-q", "-m", "a developer's mistake");
  const before = readFileSync(join(dir, ".env"), "utf8");

  const run = await setupArcade(dir);

  expect(run.code).toBe(1);
  expect(run.stderr).toContain(".env is tracked by git");
  expect(arcade.requests).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);
});

test("a .env that is not gitignored is refused", async () => {
  const dir = project("not-ignored");
  writeFileSync(join(dir, ".gitignore"), "*.db\n");
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(".env is not gitignored");
  expect(arcade.requests).toEqual([]);
});

test("an existing provider that differs is reported and never edited, and nothing is written", async () => {
  const dir = project("provider-differs");
  arcade.providers.set("app-identity", {
    id: "app-identity",
    type: "oauth2",
    oauth2: {
      client_id: "somebody-elses-client",
      client_secret: { exists: true },
      pkce: { enabled: true, code_challenge_method: "S256" },
      authorize_request: { endpoint: "https://old-host.example/oauth2/authorize" },
      token_request: { endpoint: "https://old-host.example/oauth2/token", auth_method: "client_secret_basic" },
      user_info_request: { endpoint: "https://old-host.example/oauth2/userinfo", auth_method: "bearer_access_token", response_map: { user_id: "$.email" } },
      redirect_uri: CALLBACK,
    },
  });
  const before = readFileSync(join(dir, ".env"), "utf8");

  const run = await setupArcade(dir);

  expect(run.code).toBe(1);
  expect(run.stdout).toContain(`oauth2.token_request.endpoint: Arcade has "https://old-host.example/oauth2/token", this app needs "${arcade.issuer}/v1/token"`);
  expect(run.stdout).toContain("oauth2.client_id: Arcade has \"somebody-elses-client\"");
  expect(run.stderr).toContain("never edits an existing provider");
  // Two reads, and nothing after them: no PATCH, no DELETE, no re-create, no hooks, no deploys.
  expect(sequence(arcade.requests)).toEqual([GUARD, "GET /v1/admin/auth_providers/app-identity"]);
  expect(projects.get(dir)!.deploys()).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
});

test("running it again changes nothing that is registered and rotates nothing Arcade holds", async () => {
  const dir = project("twice");
  expect((await setupArcade(dir)).code).toBe(0);
  const envAfterFirst = readFileSync(join(dir, ".env"), "utf8");
  const providerAfterFirst = JSON.stringify(arcade.providers.get("app-identity"));
  const pluginAfterFirst = JSON.stringify([...arcade.plugins.values()]);
  arcade.requests = [];

  const again = await setupArcade(dir);

  expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
  expect(again.stdout).toContain("the provider app-identity is already registered and matches");
  expect(again.stdout).toContain("hooks: loan-approval-limits-hooks is already registered, matches and is on; it is left as it is");
  expect(sequence(arcade.requests)).toEqual(RERUN);
  expect(JSON.stringify(arcade.providers.get("app-identity"))).toBe(providerAfterFirst);
  expect(JSON.stringify([...arcade.plugins.values()])).toBe(pluginAfterFirst);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envAfterFirst);
  // The callback on file is the provider's, so Okta has nothing new to allowlist.
  expect(again.stdout).not.toContain("provider's callback");
  expect(thenList(again.stdout)).not.toContain("okta-setup");
}, 60_000);

test("hooks that differ are updated, because they are not the access model, and read back, on", async () => {
  const dir = project("hooks-differ");
  expect((await setupArcade(dir)).code).toBe(0);
  // Somebody set the pre hook to fail open in the dashboard, and pointed post elsewhere.
  const [plugin] = [...arcade.plugins.values()] as [Json];
  plugin.webhook_config.endpoints.pre.failure_mode = "fail_open";
  plugin.webhook_config.endpoints.post.url = "https://old-host.example/hooks/post";
  arcade.hooks.find((hook) => hook.hook_point === "tool.pre")!.failure_mode = "fail_open";
  arcade.requests = [];

  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain("hooks: loan-approval-limits-hooks is registered and differs from what this app needs, so it is updated:");
  expect(run.stdout).toContain(`webhook_config.endpoints.post.url: Arcade has "https://old-host.example/hooks/post", this app needs "${ORIGIN}/hooks/post"`);
  expect(run.stdout).toContain('tool.pre.failure_mode: Arcade has "fail_open", this app needs "fail_closed"');
  expect(sequence(arcade.requests).slice(-5, -1)).toEqual([
    `GET ${SCOPED}/hooks?plugin_id={id}`,
    `PATCH ${SCOPED}/plugins/{id}`,
    `GET ${SCOPED}/plugins/{id}`,
    `GET ${SCOPED}/hooks?plugin_id={id}`,
  ]);
  // On, as they were: an update never switches the hooks off.
  expect((arcade.requests.find((each) => each.method === "PATCH")!.body as Json).status).toBe("active");
  expect(run.stdout).not.toContain("so it is turned on");
  hooksAreRegistered(dir, "active");
  expect(arcade.plugins.size).toBe(1);
}, 60_000);

test("a verifier setting that does not read back fails the run, naming open risk 2", async () => {
  const dir = project("verifier");
  arcade.verifierIgnoresPut = true;
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("the custom verifier did not take");
  expect(run.stderr).toContain("open risk 2");
});

/**
 * The stand-in is a test double for Arcade, so it refuses what Arcade refused
 * (#26). Until then it served `POST /v1/admin/secrets/{key}`, because the pinned
 * spec (and `arcade-js`, generated from it) says POST, and the real API
 * answered the first live run's POST with this 404.
 */
test("the stand-in answers a tool secret POSTed the spec's way with Arcade's own 404", async () => {
  const post = await fetch(`${arcade.url}/v1/admin/secrets/APP_PUBLIC_HOST`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ value: HOST, description: "d" }),
  });
  expect(post.status).toBe(404);
  expect(await post.text()).toBe('{"name":"route_not_found","message":"requested route is not found or method is not allowed"}');
  expect(arcade.secrets.size).toBe(0);

  const put = await fetch(`${arcade.url}/v1/admin/secrets/APP_PUBLIC_HOST`, {
    method: "PUT",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ description: "d", value: HOST }),
  });
  expect(put.status).toBe(200);
  expect(arcade.secrets.get("APP_PUBLIC_HOST")).toBe(HOST);

  // And a PUT with no value is refused, as `value` is required.
  const empty = await fetch(`${arcade.url}/v1/admin/secrets/APPROVALS_STORE_TOKEN`, {
    method: "PUT",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ description: "d" }),
  });
  expect(empty.status).toBe(400);
});

// --- The org and project, and the key's check (#30) --------------------------

test("with no org and project anywhere, the hooks fall back to the form, and the run says why", async () => {
  const dir = project("no-context", (env) => env, null);
  const run = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, with no Arcade CLI context ---\n${run.stdout}${run.stderr}`);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

  expect(run.stdout).toContain(
    `arcade        no org and project: ARCADE_ORG_ID and ARCADE_PROJECT_ID are unset, and there is no ${projects.get(dir)!.home}/.arcade/credentials.yaml: run \`arcade login\`.`,
  );
  expect(run.stdout).toContain("The hooks are printed as a dashboard form instead.");
  expect(run.stdout).toContain("  hooks: no org and project, so the form below");
  // Nothing under any org, and the rest as before.
  expect(arcade.requests.filter((each) => each.path.startsWith("/v1/orgs/"))).toEqual([]);
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN.slice(1, 7));
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(formOrder(run.stdout)).toEqual(["hooks"]);
  hooksFormIsComplete(run.stdout);
  expect(run.stdout).toContain("One dashboard form is left:");
  expect(thenList(run.stdout).split("\n").slice(1)).toEqual([
    '  1. Allowlist the provider\'s callback on the Okta app: OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- bun run okta-setup',
    "  2. Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.",
    `  3. Start the tunnel: ngrok http --url=${HOST} 3000`,
    "  4. Fill in the contextual access hooks form above. Arcade checks /hooks/health through the tunnel.",
    `  5. Open ${ORIGIN}, never localhost, and sign in.`,
  ]);
}, 60_000);

test("ARCADE_ORG_ID and ARCADE_PROJECT_ID win over the CLI's active project", async () => {
  const dir = project(
    "context-from-env",
    (env) => `${env}\nARCADE_ORG_ID=${ORG}\nARCADE_PROJECT_ID=${PROJECT}\n`,
    { orgId: "org_the_cli_has", projectId: "prj_the_cli_has" },
  );
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain(`arcade        org ${ORG}, project ${PROJECT} (from ARCADE_ORG_ID and ARCADE_PROJECT_ID)`);
  expect(run.stdout).toContain("warning       arcade deploy uses the Arcade CLI's active project, not these variables");
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN);
  expect(JSON.stringify(arcade.requests)).not.toContain("prj_the_cli_has");
}, 60_000);

test("one of ARCADE_ORG_ID and ARCADE_PROJECT_ID alone is not enough, and says so", async () => {
  const dir = project("context-half", (env) => `${env}\nARCADE_PROJECT_ID=${PROJECT}\n`);
  const run = await setupArcade(dir, "--dry-run");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain("no org and project: ARCADE_PROJECT_ID is set without ARCADE_ORG_ID; set both, or neither to use the Arcade CLI's active project");
});

test("a key from another project is stopped by the check before anything is written", async () => {
  const dir = project("key-mismatch", (env) => env, { orgId: ORG, projectId: "prj_not_the_keys" });
  const before = readFileSync(join(dir, ".env"), "utf8");
  const run = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, with the CLI on another project ---\n${run.stdout}${run.stderr}`);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`ARCADE_API_KEY and the Arcade project this run resolved disagree: GET /v1/orgs/${ORG}/projects/prj_not_the_keys/plugins?limit=100 answered 404.`);
  expect(run.stderr).toContain(`The project is prj_not_the_keys in the org ${ORG} (from the Arcade CLI's active context`);
  expect(run.stderr).toContain("`arcade project set <project_id>`");
  expect(run.stderr).toContain("or create an API key in the project prj_not_the_keys and put it in ARCADE_API_KEY. Nothing was written.");
  // One read, and nothing else at all.
  expect(sequence(arcade.requests)).toEqual([`GET /v1/orgs/${ORG}/projects/prj_not_the_keys/plugins?limit=100`]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);
  expect(projects.get(dir)!.deploys()).toEqual([]);
});

test("a key Arcade does not accept is stopped by the same check", async () => {
  const dir = project("key-refused", (env) => env.replace(`ARCADE_API_KEY=${KEY}`, "ARCADE_API_KEY=somebody-elses-key"));
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`GET ${SCOPED}/plugins?limit=100 answered 401.`);
  expect(arcade.requests).toHaveLength(1);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);
});

// --- The deploys (#30) ------------------------------------------------------

test("a deploy that fails stops the run there, after the hooks", async () => {
  const dir = project("deploy-fails");
  const run = await setupArcade(dir, { failDeployIn: "mcp" });
  expect(run.code).toBe(1);
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(run.stdout).toContain("fake arcade: deploy (in");
  expect(run.stderr).toContain("fake arcade: deploy failed");
  expect(run.stderr).toContain("arcade deploy in mcp exited 3; its output is above, and nothing after it ran.");
  expect(run.stderr).toContain("or pass --skip-deploy");
  // The hooks were registered first, on, and no step left reads as done.
  hooksAreRegistered(dir, "active");
  expect(run.stdout).not.toContain("Then:");
  noGatewayRequest();
}, 60_000);

test("--skip-deploy runs no deploy, and the steps left say to deploy before opening the app", async () => {
  const dir = project("skip-deploy");
  const run = await setupArcade(dir, "--skip-deploy");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(projects.get(dir)!.deploys()).toEqual([]);
  expect(run.stdout).toContain("Deploys: skipped (--skip-deploy). Deploy the toolkits yourself: arcade deploy, in mcp.");
  const steps = thenList(run.stdout);
  expect(steps).toContain("4. Deploy the toolkits (their secrets are set above): arcade deploy, in mcp.");
  const open = steps.indexOf(`Open ${ORIGIN}`);
  expect(open).toBeGreaterThan(-1);
  expect(steps.indexOf("arcade deploy")).toBeLessThan(open);
}, 60_000);

// --- Resuming from the live project -----------------------------------------

/**
 * The human's live project after the first real run (#7, 2026-09-25): the
 * provider was created (201) and its callback written to `.env`, `.env`'s
 * second block was filled, and the run stopped at the tool secrets' 404, so no
 * secret, no hooks and no verifier were set. The fixed command must pick up
 * from exactly there (#26).
 */
test("a rerun resumes from the live project's state after run 1: the provider matches, nothing is minted or overwritten, and the rest is set", async () => {
  const dir = project("resume-live");

  // How the live project got into that state: the tool secrets answered 404.
  arcade.secretsLikeTheLiveRun = true;
  const first = await setupArcade(dir);
  expect(first.code).toBe(1);
  expect(first.stderr).toContain("setting the tool secret APP_PUBLIC_HOST failed");
  expect(first.stderr).toContain('"name":"route_not_found"');
  expect(first.stderr).toContain("running the same command again picks up from here");

  // The state the issue describes, checked rather than assumed.
  expect(arcade.providers.has("app-identity")).toBe(true);
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  const section = example.slice(example.indexOf("# --- Filled in by `bun run setup-arcade"), example.indexOf("# --- Optional"));
  const envBefore = envOf(dir);
  for (const [, key] of section.matchAll(/^([A-Z_][A-Z0-9_]*)=$/gm)) if (key !== "ARCADE_GATEWAY_ID") expect(envBefore[key!], `block 2 left ${key} blank`).toMatch(/\S/);
  expect(envBefore.ARCADE_PROVIDER_CALLBACK).toBe(CALLBACK);
  expect(arcade.secrets.size).toBe(0);
  expect(arcade.verifier).toEqual({ verifier_url: "", unsafe_skip_verification: false });

  const envText = readFileSync(join(dir, ".env"), "utf8");
  const provider = JSON.stringify(arcade.providers.get("app-identity"));
  arcade.secretsLikeTheLiveRun = false;
  arcade.requests = [];

  const rerun = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, resuming from the live state ---\n${rerun.stdout}${rerun.stderr}`);

  expect(rerun.code, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
  expect(rerun.stdout).toContain("the provider app-identity is already registered and matches; it is left as it is");
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN.filter((each) => each !== "POST /v1/admin/auth_providers"));
  // Overwrote nothing, re-created nothing.
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envText);
  expect(rerun.stdout).toContain("filled   (nothing to fill: every value was already set)");
  expect(JSON.stringify(arcade.providers.get("app-identity"))).toBe(provider);
  // And went on to set the secrets, the verifier and the hooks.
  expect(arcade.secrets.get("APP_PUBLIC_HOST")).toBe(HOST);
  expect(arcade.secrets.get("APPROVALS_STORE_TOKEN")).toBe(envBefore.APPROVALS_STORE_TOKEN);
  hooksAreRegistered(dir, "active");
  expect(arcade.verifier).toEqual({ verifier_url: `${ORIGIN}/api/arcade/verify`, unsafe_skip_verification: false });
  expect(rerun.stdout).toContain(`custom verifier: ${ORIGIN}/api/arcade/verify (read back)`);
}, 60_000);

/** The requests a dry run prints, as `METHOD /path`. */
const printedRequests = (stdout: string) =>
  [...stdout.matchAll(/^ {2}(GET|POST|PUT|PATCH|DELETE) \S+?(\/v1\/\S+)$/gm)].map(([, method, path]) => normalise(`${method} ${path}`));

/** What a dry run says only when it is about to create what a resumed project already has (#28). */
const FRESH_ONLY = [
  "would fill ",
  "ARCADE_PROVIDER_CALLBACK (with the callback Arcade generates for the provider)",
  "(404: the provider is created below.",
  "/v1/admin/auth_providers\n",
];

test("a dry run of a fresh project describes the real run that follows it", async () => {
  const dir = project("dry-fresh-truth");
  const dry = await setupArcade(dir, "--dry-run");
  expect(dry.code, `${dry.stdout}\n${dry.stderr}`).toBe(0);
  expect(arcade.requests).toEqual([]);

  expect(dry.stdout).toMatch(/would fill .*\bSESSION_SECRET\b.*\bARCADE_PROVIDER_CALLBACK\b/);
  expect(dry.stdout).toContain(`  POST ${arcade.url}/v1/admin/auth_providers\n`);

  const real = await setupArcade(dir);
  expect(real.code, `${real.stdout}\n${real.stderr}`).toBe(0);
  expect(printedRequests(dry.stdout)).toEqual(sequence(arcade.requests));
}, 60_000);

/**
 * The human's live project as #30 describes it: after run 3, the provider,
 * both tool secrets and the verifier are set, `.env`'s second block is filled,
 * and there is no plugin, because it was a dashboard form. That state is built
 * here by a whole run with the plugin then taken back out, and checked rather
 * than assumed. From it, the dry run and the real rerun must agree (#28, #30).
 */
test("from the live project's state after run 3, the dry run tells the truth, and the rerun adds the hooks, on", async () => {
  const dir = project("resume-run-3");
  expect((await setupArcade(dir)).code).toBe(0);
  arcade.plugins.clear();
  arcade.hooks = [];

  expect(arcade.providers.has("app-identity")).toBe(true);
  expect([...arcade.secrets.keys()].sort()).toEqual(["APPROVALS_STORE_TOKEN", "APP_PUBLIC_HOST"]);
  expect(arcade.verifier).toEqual({ verifier_url: `${ORIGIN}/api/arcade/verify`, unsafe_skip_verification: false });
  const envBefore = envOf(dir);
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  const block2 = example.slice(example.indexOf("# --- Filled in by `bun run setup-arcade"), example.indexOf("# --- Optional"));
  for (const [, key] of block2.matchAll(/^([A-Z_][A-Z0-9_]*)=$/gm)) if (key !== "ARCADE_GATEWAY_ID") expect(envBefore[key!], `block 2 left ${key} blank`).toMatch(/\S/);
  const secretsBefore = new Map(arcade.secrets);
  const envText = readFileSync(join(dir, ".env"), "utf8");
  const provider = JSON.stringify(arcade.providers.get("app-identity"));
  arcade.requests = [];

  // The dry run: what a real run does from here, and nothing a fresh one does.
  const dry = await setupArcade(dir, "--dry-run");
  console.log(`--- setup-arcade ${HOST} --dry-run, from the live state after run 3 ---\n${dry.stdout}${dry.stderr}`);
  expect(dry.code, `${dry.stdout}\n${dry.stderr}`).toBe(0);
  expect(arcade.requests).toEqual([]);
  for (const phrase of FRESH_ONLY) expect(dry.stdout, `the resumed dry run says ${JSON.stringify(phrase)}`).not.toContain(phrase);
  expect(dry.stdout).toContain(".env: nothing to fill: every value is already set, and none is overwritten");
  expect(dry.stdout).toContain("(expected 200: .env holds the callback Arcade made for this provider.");
  expect(dry.stdout).toContain("If Arcade answers 404 instead, a real run creates the provider.");
  expect(bodyAfter(dry.stdout, `  POST ${arcade.url}${SCOPED}/plugins\n`).webhook_config.auth.token).toBe("<ARCADE_HOOK_SIGNING_SECRET from .env>");
  expect(formOrder(dry.stdout)).toEqual([]);
  // The check bites: the fresh project's dry run says every one of them.
  const fresh = await setupArcade(project("resume-run-3-fresh"), "--dry-run");
  for (const phrase of FRESH_ONLY) expect(fresh.stdout).toContain(phrase);

  // The real rerun.
  const rerun = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, from the live state after run 3 ---\n${rerun.stdout}${rerun.stderr}`);
  expect(rerun.code, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
  const called = sequence(arcade.requests);
  expect(called).toEqual(FIRST_RUN.filter((each) => each !== "POST /v1/admin/auth_providers"));
  expect(printedRequests(dry.stdout)).toEqual(called);
  hooksAreRegistered(dir, "active");

  // In this order: the project, the key's check, provider matches, .env has nothing to fill, both secrets, the verifier, the hooks, the deploys, the steps left.
  const at = (text: string) => {
    const index = rerun.stdout.indexOf(text);
    expect(index, `the rerun never printed ${JSON.stringify(text)}`).toBeGreaterThan(-1);
    return index;
  };
  const marks = [
    at(`arcade        org ${ORG}, project ${PROJECT}`),
    at(`the key answers for the project ${PROJECT}`),
    at("the provider app-identity is already registered and matches"),
    at("filled   (nothing to fill: every value was already set)"),
    at("PUT /v1/admin/secrets/APP_PUBLIC_HOST → 200"),
    at("PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN → 200"),
    at(`custom verifier: ${ORIGIN}/api/arcade/verify (read back)`),
    at("hooks: created loan-approval-limits-hooks"),
    at("arcade deploy   (in mcp):"),
    at("Then:"),
    at(`Open ${ORIGIN}, never localhost`),
  ];
  expect([...marks].sort((a, b) => a - b)).toEqual(marks);

  // Idempotent: the same secrets, nothing overwritten, nothing re-created.
  expect(arcade.secrets).toEqual(secretsBefore);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envText);
  expect(JSON.stringify(arcade.providers.get("app-identity"))).toBe(provider);
  expect(`${rerun.stdout}${dry.stdout}`).not.toContain(envBefore.ARCADE_HOOK_SIGNING_SECRET!);
  noGatewayRequest();
}, 120_000);

// --- What the run is told, and by whom (#30, F6 and F7) ----------------------

test("the stand-in refuses a health_check_path that is not a URL with the body Arcade sent the fourth live run", async () => {
  const create = (health: string) =>
    fetch(`${arcade.url}${SCOPED}/plugins`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", plugin_type: "webhook", webhook_config: { health_check_path: health, endpoints: {} } }),
    });
  const path = await create("/hooks/health");
  expect(path.status).toBe(400);
  expect(await path.text()).toBe(
    '{"name":"malformed_request","message":"failed to validate request body: webhook_config: health_check_path must be a valid URL","field_errors":[{"field":"webhook_config.health_check_path","rule":"url","message":"health_check_path must be a valid URL"}]}',
  );
  expect((await create(`${ORIGIN}/hooks/health`)).status).toBe(201);
});

test("a refusal that is not about reaching the app prints Arcade's own message, and no advice about the tunnel", async () => {
  const dir = project("hooks-refused");
  arcade.nextPluginCreate = { status: 400, body: HEALTH_CHECK_NOT_A_URL };
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("creating the contextual access hooks failed: POST");
  expect(run.stderr).toContain("Arcade says: failed to validate request body: webhook_config: health_check_path must be a valid URL");
  expect(run.stderr).not.toMatch(/tunnel|bun run dev/);
});

test("a refusal about reaching the app says to start it and the tunnel", async () => {
  const dir = project("hooks-unreachable");
  // Nobody has seen Arcade's answer for an unreachable health check: this is the wording the check looks for.
  arcade.nextPluginCreate = { status: 422, body: { name: "health_check_failed", message: `health check failed: dial tcp: lookup ${HOST}: no such host` } };
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`Arcade says: health check failed: dial tcp: lookup ${HOST}: no such host`);
  expect(run.stderr).toContain(`Arcade could not reach ${ORIGIN}/hooks/health: start \`bun run dev\` and the tunnel first.`);
});

test("setup-arcade manages exactly .env.example's required values, okta-setup's block and its own", async () => {
  const { REQUIRED_KEYS, IDP_KEYS, WRITTEN_KEYS } = await import("../scripts/setup-arcade/env-file.ts");
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  const block = (from: string, to: string) =>
    [...example.slice(example.indexOf(from), example.indexOf(to)).matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map(([, key]) => key!).sort();
  expect(([...REQUIRED_KEYS] as string[]).sort()).toEqual(block("# --- Required", "# --- Filled in by `bun run okta-setup"));
  expect(([...IDP_KEYS] as string[]).sort()).toEqual(block("# --- Filled in by `bun run okta-setup", "# --- Filled in by `bun run setup-arcade"));
  expect(([...WRITTEN_KEYS] as string[]).sort()).toEqual(block("# --- Filled in by `bun run setup-arcade", "# --- Optional"));
});

/**
 * The fourth live run (#7, F7): a fresh clone, a fresh `.env` with its second
 * block blank, and a shell that still exported the previous clone's `.env`
 * (`set -a; . ./.env`). The shell won, the run said ".env: nothing to fill",
 * the provider was created with the shell's old client, and `bun run dev`,
 * which reads `.env`, had none of the second block. The run now
 * stops before it sends or writes anything, and names the keys, never the values.
 */
test("a shell that still exports an old .env is refused before anything is sent or written, naming the keys and not the values", async () => {
  const old = project("old-clone");
  expect((await setupArcade(old)).code).toBe(0);
  const exported = envOf(old);
  const managed = (await import("../scripts/setup-arcade/env-file.ts")).MANAGED_KEYS;
  const shell = Object.fromEntries(Object.entries(exported).filter(([key, value]) => managed.includes(key) && value !== ""));
  expect(Object.keys(shell)).toContain("SESSION_SECRET");
  expect(Object.keys(shell)).toContain("ARCADE_PROVIDER_CALLBACK");
  arcade.requests = [];

  // The seven filled in, as the human's were, and the second block blank.
  const dir = project("fresh-clone", (env) => env.replace(/^APP_PUBLIC_HOST=$/m, `APP_PUBLIC_HOST=${HOST}`));
  const before = readFileSync(join(dir, ".env"), "utf8");
  const run = await setupArcade(dir, { shell });
  console.log(`--- setup-arcade ${HOST}, with the old clone's .env exported ---\n${run.stdout}${run.stderr}`);
  expect(run.code).toBe(1);
  const refused = Object.keys(shell).filter((key) => (envOf(dir)[key] ?? "") !== shell[key]);
  expect(refused).toEqual(expect.arrayContaining(["SESSION_SECRET", "ARCADE_PROVIDER_CALLBACK", "ARCADE_HOOK_SIGNING_SECRET", "APPROVALS_STORE_TOKEN"]));
  expect(run.stderr).toContain(`${refused.join(", ")} are exported in this shell with a value .env does not hold`);
  expect(run.stderr).toContain(`Open a new terminal, or run: unset ${refused.join(" ")}`);
  expect(run.stderr).toContain("Nothing was sent or written.");
  // The keys an old .env shares with this one (the API key, the host, the personas) are no conflict.
  expect(run.stderr).not.toMatch(/\bARCADE_API_KEY\b|\bAPP_PUBLIC_HOST\b/);
  // Names only.
  for (const key of refused) expect(`${run.stdout}${run.stderr}`, `the run printed ${key}'s value`).not.toContain(shell[key]!);
  expect(arcade.requests).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(projects.get(dir)!.deploys()).toEqual([]);
  // A dry run says the same.
  expect((await setupArcade(dir, "--dry-run", { shell })).code).toBe(1);

  // In a new terminal: the second block is filled into this .env, fresh, and the
  // provider's callback written for okta-setup to allowlist.
  arcade.providers.clear();
  arcade.plugins.clear();
  const clean = await setupArcade(dir);
  expect(clean.code, `${clean.stdout}\n${clean.stderr}`).toBe(0);
  const env = envOf(dir);
  expect(env.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
  expect(env.SESSION_SECRET).not.toBe(exported.SESSION_SECRET);
  expect(env.ARCADE_PROVIDER_CALLBACK).toBe(CALLBACK);
  expect(clean.stdout).toContain(`wrote the provider's callback to .env: ${CALLBACK}`);
  expect((arcade.providers.get("app-identity") as Json).oauth2.client_id).toBe(CLIENT_ID);
}, 120_000);

test("in a new clone on the same Okta app, the provider the old clone created matches, and its callback is written", async () => {
  expect((await setupArcade(project("old-clone-2"))).code).toBe(0);
  const dir = project("fresh-clone-2");
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain("the provider app-identity is already registered and matches");
  expect(envOf(dir).ARCADE_PROVIDER_CALLBACK).toBe(CALLBACK);
}, 60_000);

test("in a new clone on another Okta app, the provider the old clone created is reported, and never edited", async () => {
  expect((await setupArcade(project("old-clone-3"))).code).toBe(0);
  const run = await setupArcade(project("fresh-clone-3", (env) => env.replace(`IDP_CLIENT_ID=${CLIENT_ID}`, "IDP_CLIENT_ID=0oaAnotherOktaApp")));
  expect(run.code).toBe(1);
  expect(run.stdout).toContain("The provider app-identity already exists in this Arcade project, and it is not what this app needs:");
  expect(run.stdout).toContain(`oauth2.client_id: Arcade has "${CLIENT_ID}"`);
  expect(run.stderr).toContain("never edits an existing provider");
}, 60_000);

test("a shell that exports the same values as .env is no conflict", async () => {
  const dir = project("shell-agrees");
  const run = await setupArcade(dir, { shell: { ARCADE_API_KEY: KEY, SESSION_SECRET: "" } });
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(envOf(dir).SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
}, 60_000);

// --- A read-back that leaves fields out (#30, run 4's retry) ------------------

/**
 * Real Arcade, on the fourth live run's retry: `POST …/plugins → 201`, both
 * read-backs 200, and no `webhook_config.health_check_path` in the plugin's.
 * The run stopped with "the hooks did not take". The stand-in's read-back has
 * that shape by default, and this is the live project's state from there.
 */
test("a read-back without health_check_path is a warning, and a rerun from that state neither re-creates nor loops", async () => {
  const dir = project("health-not-echoed");
  const first = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, Arcade not echoing health_check_path ---\n${first.stdout}${first.stderr}`);
  expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
  const warning = `hooks: Arcade doesn't echo webhook_config.health_check_path back; it was sent as ${ORIGIN}/hooks/health and can't be verified`;
  expect(first.stdout).toContain(warning);
  expect(first.stdout).not.toContain("the hooks did not take");
  // It carried on: the deploys ran, and the run ended on the steps left.
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(thenList(first.stdout)).toContain(`Open ${ORIGIN}`);
  // What was sent is what the app needs, whatever the read-back says.
  hooksAreRegistered(dir, "active");

  for (const attempt of [1, 2]) {
    arcade.requests = [];
    const rerun = await setupArcade(dir);
    expect(rerun.code, `rerun ${attempt}: ${rerun.stdout}\n${rerun.stderr}`).toBe(0);
    expect(rerun.stdout).toContain("hooks: loan-approval-limits-hooks is already registered, matches and is on; it is left as it is");
    expect(rerun.stdout).toContain(warning);
    // Found by name: no second plugin, and no PATCH for a field it cannot see.
    expect(sequence(arcade.requests)).toEqual(RERUN);
    expect(arcade.plugins.size).toBe(1);
  }
}, 120_000);

test("a health_check_path read back present but different still fails the run", async () => {
  const dir = project("health-differs");
  arcade.healthCheckReadBack = "https://old-host.example/hooks/health";
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("the hooks did not take: Arcade reads back");
  expect(run.stderr).toContain(`webhook_config.health_check_path: Arcade has "https://old-host.example/hooks/health", this app needs "${ORIGIN}/hooks/health"`);
  expect(projects.get(dir)!.deploys()).toEqual([]);
}, 60_000);

test("a health_check_path Arcade does echo is checked, and the line says so", async () => {
  const dir = project("health-echoed");
  arcade.healthCheckReadBack = "stored";
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain(`hooks: ${ORIGIN}/hooks/access, /hooks/pre and /hooks/post, fail closed, health check ${ORIGIN}/hooks/health, status active (read back)`);
  expect(run.stdout).not.toContain("doesn't echo webhook_config.health_check_path");
}, 60_000);

test("an endpoint URL missing from the read-back means the hooks did not take", async () => {
  const dir = project("endpoint-missing");
  arcade.omitEndpointUrl = "pre";
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`webhook_config.endpoints.pre.url: Arcade has nothing, this app needs "${ORIGIN}/hooks/pre"`);
  expect(projects.get(dir)!.deploys()).toEqual([]);
}, 60_000);

// --- The deploys, unattended (#30, run 4) -------------------------------------

test("arcade deploy is given no stdin, so its logs prompt never waits for a key", async () => {
  const dir = project("deploy-no-stdin");
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const log = join(scratch, "deploy-no-stdin.arcade.log.stdin");
  const seen = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("|")[1]);
  // The one deploy, without the pipe setup-arcade itself was given.
  expect(seen).toEqual(["stdin=none"]);
  // And the CLI's own line about the secrets is called out as expected, next to the deploys.
  expect(run.stdout).toContain(`Secret 'APP_PUBLIC_HOST' not found in environment, skipping upload". That is expected:`);
  expect(run.stdout.indexOf("That is expected:")).toBeLessThan(run.stdout.indexOf("arcade deploy   (in mcp):"));
}, 60_000);

// --- The provider's callback follows the provider (#30, run 4) ----------------

/**
 * Run 4: app-identity was recreated in the dashboard, Arcade made it a new
 * callback, and `.env` still named the old one. The run only warned ("add it
 * … yourself"), and hop 2's Authorize failed with invalid_redirect. The live
 * provider is the source of truth for this one variable.
 */
test("a provider recreated with a new callback: the rerun replaces it in .env, and says to run okta-setup again", async () => {
  const dir = project("callback-replaced");
  expect((await setupArcade(dir)).code).toBe(0);
  expect(envOf(dir).ARCADE_PROVIDER_CALLBACK).toBe(CALLBACK);

  // Deleted and created again: a new provider, a new callback.
  const recreated = "https://cloud.arcade.dev/api/v1/oauth/stand_in_ap_2/callback";
  arcade.providers.clear();
  arcade.nextCallback = recreated;
  const envBefore = envOf(dir);
  const rerun = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, after the provider was recreated ---\n${rerun.stdout}${rerun.stderr}`);
  expect(rerun.code, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);

  expect(rerun.stdout).toContain(`replaced the provider's callback in .env: ${CALLBACK} -> ${recreated}`);
  expect(envOf(dir).ARCADE_PROVIDER_CALLBACK).toBe(recreated);
  // okta-setup is what puts it on the Okta app's allowlist, so the steps start there.
  expect(thenList(rerun.stdout).split("\n")[1]).toContain("op run -- bun run okta-setup");
  // Every other value on file is kept, as ever.
  for (const [key, value] of Object.entries(envBefore)) if (key !== "ARCADE_PROVIDER_CALLBACK") expect(envOf(dir)[key], key).toBe(value);

  // And a third run has nothing to replace.
  const again = await setupArcade(dir);
  expect(again.code).toBe(0);
  expect(again.stdout).not.toContain("provider's callback");
}, 90_000);

// --- A rerun does not redeploy what Arcade already runs (#30, run 4) ----------

/**
 * Run 4: the second run, which then turned the hooks on, cost two full deploys of unchanged code.
 * Before each deploy the run asks what the Arcade CLI asks
 * (`server_already_exists`, `GET …/workers/<name>`): 404 deploys it, found
 * skips it. Arcade's answer has no version to compare, so --redeploy is the
 * way to ship a changed toolkit.
 */
test("a server Arcade already runs is skipped, after one lookup under its own name", async () => {
  const dir = project("deploy-skip");
  arcade.workers.add("loan_desk");
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain("  mcp: already deployed on Arcade, skipped (pass --redeploy after changing it)");
  expect(run.stdout).not.toContain("arcade deploy   (in mcp):");
  expect(projects.get(dir)!.deploys()).toEqual([]);
  expect(sequence(arcade.requests).filter((each) => each.includes("/workers/"))).toEqual([`GET ${SCOPED}/workers/loan_desk`]);
}, 60_000);

test("a second run with the server on Arcade deploys nothing, and hooks found disabled are still turned on", async () => {
  const dir = project("deploy-skip-both");
  expect((await setupArcade(dir)).code).toBe(0);
  arcade.workers.add("loan_desk");
  disableHooks();
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(run.stdout).toContain("  mcp: already deployed on Arcade, skipped (pass --redeploy after changing it)");
  hooksAreRegistered(dir, "active");
}, 60_000);

test("--redeploy deploys whatever Arcade runs, and asks it nothing", async () => {
  const dir = project("deploy-redeploy");
  arcade.workers.add("loan");
  arcade.workers.add("approvals");
  const run = await setupArcade(dir, "--redeploy");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(arcade.requests.filter((each) => each.path.includes("/workers/"))).toEqual([]);
  const dry = await setupArcade(dir, "--dry-run", "--redeploy");
  expect(dry.stdout).toContain("(--redeploy: both, whatever Arcade already runs)");
  expect(dry.stdout).not.toContain("/workers/");
}, 60_000);

test("a worker lookup that fails for another reason stops the run with Arcade's message", async () => {
  const dir = project("deploy-lookup-fails");
  arcade.workerLookup = { status: 500, body: { name: "internal", message: "the engine is having a moment" } };
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`checking whether mcp is deployed failed: GET ${SCOPED}/workers/loan_desk answered 500`);
  expect(run.stderr).toContain("Arcade says: the engine is having a moment");
  expect(projects.get(dir)!.deploys()).toEqual([]);
}, 60_000);

// --- The identity provider (#54) ------------------------------------------------

test("a blank IDP_ISSUER, IDP_CLIENT_ID or IDP_CLIENT_SECRET stops the run before anything is sent, naming okta-setup", async () => {
  const dir = project("idp-blank", (env) => env.replace(/^IDP_CLIENT_ID=.*$/m, "IDP_CLIENT_ID=").replace(/^IDP_CLIENT_SECRET=.*$/m, "IDP_CLIENT_SECRET="));
  const before = readFileSync(join(dir, ".env"), "utf8");
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("IDP_CLIENT_ID, IDP_CLIENT_SECRET are blank in .env. Run `bun run okta-setup` first");
  expect(arcade.requests).toEqual([]);
  expect(arcade.idpRequests).toBe(0);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
});

test("a dry run with the identity provider blank says a real run stops there, and still prints the requests", async () => {
  const dir = project("idp-blank-dry", (env) => env.replace(/^IDP_ISSUER=.*$/m, "IDP_ISSUER="));
  const dry = await setupArcade(dir, "--dry-run");
  expect(dry.code).toBe(0);
  expect(dry.stdout).toContain("IDP_ISSUER is blank: a real run stops here. Run `bun run okta-setup` first.");
  expect(dry.stdout).toMatch(/^ {2}POST \S+\/v1\/admin\/auth_providers$/m);
  expect(arcade.idpRequests).toBe(0);
});

test("the provider's endpoints are the ones IDP_ISSUER's discovery names, and its client is the Okta app's", async () => {
  const dir = project("idp-endpoints");
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const provider = arcade.requests.find((each) => each.method === "POST" && each.path === "/v1/admin/auth_providers")!.body as Json;
  expect(provider.oauth2.client_id).toBe(CLIENT_ID);
  expect(provider.oauth2.client_secret).toBe(CLIENT_SECRET);
  expect(provider.oauth2.authorize_request.endpoint).toBe(`${arcade.issuer}/v1/authorize`);
  expect(provider.oauth2.token_request.endpoint).toBe(`${arcade.issuer}/v1/token`);
  expect(provider.oauth2.user_info_request.endpoint).toBe(`${arcade.issuer}/v1/userinfo`);
  expect(arcade.timeline.filter((each) => each.startsWith("idp "))).toEqual(["idp GET /oauth2/default/.well-known/openid-configuration"]);
  expect(run.stdout).toContain(`identity      ${arcade.issuer}, client ${CLIENT_ID}`);
});

test("an issuer whose discovery does not answer stops the run before anything is sent to Arcade or written", async () => {
  const dir = project("idp-down");
  const before = readFileSync(join(dir, ".env"), "utf8");
  arcade.idp = { status: 503 };
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`reading ${arcade.issuer}/.well-known/openid-configuration failed`);
  expect(run.stderr).toContain("Is IDP_ISSUER the issuer `bun run okta-setup` wrote?");
  expect(arcade.requests).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
});

test("a shell that exports any IDP_* key .env does not hold stops the run too, managed or not, naming it and not its value (#54)", async () => {
  const dir = project("shell-idp-keys");
  const before = readFileSync(join(dir, ".env"), "utf8");
  const shell = { IDP_SCOPES: "openid email planted-scope", IDP_CLIENT_ID: "planted-older-client", IDP_ISSUER: "https://planted.okta.example/oauth2/default" };
  const run = await setupArcade(dir, { shell });
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("IDP_ISSUER, IDP_CLIENT_ID, IDP_SCOPES are exported in this shell with a value .env does not hold");
  expect(run.stderr).toContain("unset IDP_ISSUER IDP_CLIENT_ID IDP_SCOPES");
  for (const [key, value] of Object.entries(shell)) expect(`${run.stdout}${run.stderr}`, `the run printed ${key}'s value`).not.toContain(value);
  expect(arcade.requests).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
});
