/**
 * What `bun run setup-arcade` prints for the one registration it cannot make
 * by API, and the steps left after a run (#9, #28, #30).
 *
 * - **The contextual access hooks**, only when the run found no Arcade org and
 *   project to register them in (`context.ts`). With one, they go through the
 *   API (`arcade.ts`, #30). The hooks form carries the live swagger's field
 *   names (`schemas.CreatePluginRequest`, its `webhook_config`, and
 *   `schemas.CreateHookRequest`'s `hook_point`), because nobody has read the
 *   dashboard's own labels yet.
 *
 * Two more are printed only under `--gateway`, when the run has no Arcade org
 * and project to register in, or the Coordinator refused:
 *
 * - **The User Source**, with the fields docs.arcade.dev lists under "Operate →
 *   Identity → User Sources": Name, Description, Issuer URL, Client ID, Client
 *   Secret, and under Advanced, Scopes and Subject Claim.
 * - **The gateway**, which authenticates through the User Source, so it comes
 *   right after it. Its fields are from docs.arcade.dev "MCP Gateways → Create
 *   via dashboard", under the slug the run picked for `ARCADE_GATEWAY_ID`.
 *
 * Without `--gateway` neither is printed: the agent calls the Engine directly
 * with the project key (DESIGN.md → Integration), and the gateway is only for
 * an MCP client (`docs/modules/05-mcp-client.md`).
 */
import { gatewayUrl, healthCheckUrl, HOOKS_NAME, HOOK_POINTS } from "./arcade.ts";

export interface UserSourceForm {
  /** `IDP_ISSUER`. */
  issuer: string;
  /** `IDP_CLIENT_ID`. */
  clientId: string;
}

/** The client secret is `.env`'s `IDP_CLIENT_SECRET`, named here and never printed, like the hooks' bearer below. */
export function userSourceForm({ issuer, clientId }: UserSourceForm): string {
  return [
    "┌─ Arcade dashboard → your project → User Sources → Create User Source",
    "│  Name            Loans Approval Limits",
    "│  Description     The app's sign-in, through its identity provider (hop 1)",
    `│  Issuer URL      ${issuer}`,
    `│  Client ID       ${clientId}`,
    "│  Client Secret   IDP_CLIENT_SECRET from .env (not shown here)",
    "│  Advanced → Scopes          openid profile email",
    "│  Advanced → Subject Claim   email          ← not the default `sub`",
    "│",
    "│  Its callback, https://cloud.arcade.dev/oauth2/intermediate_callback, is already",
    "│  allowlisted on the app's Okta client by `bun run okta-setup`.",
    "└─",
  ].join("\n");
}

export interface GatewayForm {
  slug: string;
  toolkit: string;
  /** The User Source already registered, when the run got that far and the gateway failed. */
  userSourceId?: string;
}

export function gatewayForm({ slug, toolkit, userSourceId }: GatewayForm): string {
  const through = userSourceId === undefined ? "(the User Source above)" : `(${userSourceId}, already registered)`;
  return [
    "┌─ Arcade dashboard → your project → MCP Gateways → Create Gateway",
    "│  Name              Loans Approval Limits",
    "│  Description       The loan officer's agent",
    `│  Slug              ${slug}        ← .env's ARCADE_GATEWAY_ID`,
    "│  LLM Instructions  (leave empty)",
    "│  Allowed Tools     these nine, and no others:",
    `│                    ${toolkit}: SearchLoans, GetLoan, ApproveLoan, DenyLoan`,
    `│                    ${toolkit}: RequestApproval, Decide`,
    "│                    Gmail: SendEmail, ListEmails    Slack: SendMessage",
    "│  Authentication    Who are the users of this Gateway? → Non-Arcade Users → User Source",
    `│                    → Loans Approval Limits ${through}. Never Arcade Headers.`,
    "│",
    "│  If the dashboard says the slug is taken, use another, and set ARCADE_GATEWAY_ID in .env to it.",
    "└─",
  ].join("\n");
}

/**
 * The bearer Arcade presents on every `/hooks` call is `.env`'s
 * `ARCADE_HOOK_SIGNING_SECRET`, named here and never printed: this output is
 * kept for the dashboard step and ends up in terminals and scrollback.
 */
export function hooksForm({ origin }: { origin: string }): string {
  return [
    "┌─ Contextual access hooks: Arcade dashboard → your project → create a webhook plugin",
    "│  The fields carry the names of Arcade's API (schemas.CreatePluginRequest); the dashboard's",
    "│  labels may read differently.",
    `│  name                  ${HOOKS_NAME}`,
    "│  description           The Loans Approval Limits control plane",
    "│  plugin_type           webhook",
    "│  status                active",
    ...HOOK_POINTS.flatMap(({ point, hookPoint, phase }) => [
      `│  webhook_config.endpoints.${point}   (hook_point ${hookPoint})`,
      `│    url                 ${origin}/hooks/${point}`,
      `│    phase               ${phase}`,
      "│    failure_mode        fail_closed",
      "│    status              active",
    ]),
    `│  webhook_config.health_check_path   ${healthCheckUrl(origin)}`,
    "│  webhook_config.auth.type           bearer",
    "│  webhook_config.auth.token          the value of ARCADE_HOOK_SIGNING_SECRET in .env (not printed here)",
    "│",
    "│  Arcade checks /hooks/health, so the app has to be reachable through the tunnel first.",
    "│  Fail closed on all three: an unreachable control plane refuses a call rather than permitting it.",
    "└─",
  ].join("\n");
}

export interface NextSteps {
  host: string;
  origin: string;
  port: string;
  /**
   * Where the hooks stand after this run: registered and on (`on`), or a
   * dashboard form, because no org and project were found (`form`).
   */
  hooks: "on" | "form";
  /** False under `--skip-deploy`: the toolkits still have to be deployed. */
  deployed: boolean;
  /**
   * Under `--gateway`: the gateway's slug and the Engine's URL, once the
   * gateway exists (`created`) and when it is still a dashboard form
   * (`form`). Absent without the flag, where no step names it.
   */
  gateway?: { slug: string; apiUrl: string; state: "created" | "form" };
  /** True when the app answered through the tunnel after this run wrote .env: starting it is not a step left. */
  appRunning?: boolean;
  /**
   * True when Okta does not allowlist the provider's callback yet: this run
   * wrote a new `ARCADE_PROVIDER_CALLBACK`, and `bun run okta-setup` adds it.
   */
  oktaRerun?: boolean;
}

/**
 * What is left once the run has registered everything it can, in the README
 * Quickstart's order, which `app-test/setup-arcade.test.ts` pins against the
 * README itself (#11). Okta has to allowlist the provider's callback before
 * anybody grants hop 2, and the app has to answer through the tunnel before
 * Arcade can call the hooks.
 */
export function nextSteps({ host, origin, port, hooks, deployed, gateway, appRunning = false, oktaRerun = false }: NextSteps): string {
  const steps = [
    ...(oktaRerun
      ? ['Allowlist the provider\'s callback on the Okta app: OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- bun run okta-setup']
      : []),
    ...(appRunning
      ? []
      : ["Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.", `Start the tunnel: ngrok http --url=${host} ${port}`]),
    ...(deployed ? [] : ["Deploy the toolkits (their secrets are set above): arcade deploy, in mcp."]),
    ...(hooks === "form" ? ["Fill in the contextual access hooks form above. Arcade checks /hooks/health through the tunnel."] : []),
    ...(gateway?.state === "form" ? ["Fill in the User Source form and then the gateway form above: the gateway authenticates through the User Source."] : []),
    `Open ${origin}, never localhost, and sign in.`,
    ...(gateway === undefined ? [] : [mcpClientStep(gateway)]),
  ];
  return ["Then:", ...steps.map((step, index) => `  ${index + 1}. ${step}`)].join("\n");
}

/**
 * The one step the gateway adds: connect an MCP client to it. Claude Code is
 * the one the module walks through (`docs/modules/05-mcp-client.md`); `/mcp`
 * there signs in at Okta through the User Source, and from then on every call
 * passes the same hooks the agent's do.
 */
export function mcpClientStep({ slug, apiUrl }: { slug: string; apiUrl: string }): string {
  return `Connect an MCP client to the gateway: claude mcp add --transport http loan-desk ${gatewayUrl(apiUrl, slug)}, then /mcp in Claude Code to sign in at Okta.`;
}
