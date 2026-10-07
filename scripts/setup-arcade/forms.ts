/**
 * What `bun run setup-arcade` prints for the registrations it cannot make by
 * API (#9, #28, #30, #48), which since #52 is the fallback of the one-click
 * path through the Coordinator API.
 *
 * - **The User Source** (hop 1), when the run fell back before it was
 *   registered. The fields are the ones docs.arcade.dev lists under "Operate →
 *   Identity → User Sources": Name, Description, Issuer URL, Client ID, Client
 *   Secret, and under Advanced, Scopes and Subject Claim.
 * - **The gateway**, whenever the run fell back, or the User Source was
 *   registered and the gateway create failed. It authenticates through the
 *   User Source, so the developer creates it in the dashboard, right after the
 *   User Source and while the hooks are still disabled: active hooks filter the
 *   tool list the gateway form shows.
 *   Its fields are from docs.arcade.dev "MCP Gateways → Create via dashboard",
 *   under a slug this script picks and writes as `ARCADE_GATEWAY_ID`.
 * - **The contextual access hooks**, only when the run found no Arcade org and
 *   project to register them in (`context.ts`). With one, they go through the
 *   API (`arcade.ts`, #30). The hooks form carries the live swagger's field
 *   names (`schemas.CreatePluginRequest`, its `webhook_config`, and
 *   `schemas.CreateHookRequest`'s `hook_point`), because nobody has read the
 *   dashboard's own labels yet.
 */
import { healthCheckUrl, HOOKS_NAME, HOOK_POINTS } from "./arcade.ts";

export interface UserSourceForm {
  origin: string;
  clientId: string;
  /** `null` when the client already existed and was not rotated on this run. */
  clientSecret: string | null;
}

export function userSourceForm({ origin, clientId, clientSecret }: UserSourceForm): string {
  return [
    "┌─ Arcade dashboard → your project → User Sources → Create User Source",
    "│  Name            Loans Approval Limits",
    "│  Description     The app's own sign-in (hop 1)",
    `│  Issuer URL      ${origin}`,
    `│  Client ID       ${clientId}`,
    `│  Client Secret   ${
      clientSecret ??
      "(unchanged, and not shown: it is stored hashed. If you have not created this User Source yet, run `bun run oauth-client --client arcade-user-source --rotate` and paste the secret it prints.)"
    }`,
    "│  Advanced → Scopes          openid profile email",
    "│  Advanced → Subject Claim   email          ← not the default `sub`",
    "│",
    "│  Its callback, https://cloud.arcade.dev/oauth2/intermediate_callback, is already",
    "│  allowlisted on the app's `arcade-user-source` client.",
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

export interface GatewayForm {
  slug: string;
  toolkit: string;
  /** The User Source already registered (#52), when the run got that far and the gateway failed. */
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
    `│  The form lists the ${toolkit} tools only while the hooks are disabled,`,
    "│  which is how this run left them.",
    "│  If the dashboard says the slug is taken, use another, and set ARCADE_GATEWAY_ID in .env to it.",
    "└─",
  ].join("\n");
}

export interface NextSteps {
  host: string;
  origin: string;
  port: string;
  /**
   * Where the gateway stands after this run: found, with the hooks turned on
   * behind it (`enabled`); still to be made in the dashboard, with the hooks
   * left disabled for the next run to turn on (`needs-gateway`); or a
   * dashboard form with the hooks, because no org and project were found (`form`).
   */
  gateway: "enabled" | "needs-gateway" | "form";
  /** False under `--skip-deploy`: the toolkits still have to be deployed before the gateway form lists them. */
  deployed: boolean;
  /** True when the User Source is registered already (#52), so its form is not a step left. */
  userSourceReady?: boolean;
  /** True when the app answered through the tunnel after this run wrote .env (#52): starting it is not a step left. */
  appRunning?: boolean;
}

/** The second run, which turns the hooks on once the gateway exists: the same command as the first. */
export function hooksOnCommand(host: string): string {
  return `bun run setup-arcade ${host}`;
}

/**
 * What is left once the run has registered everything it can, in the README
 * Quickstart's order (steps 5 and 6), which `app-test/setup-arcade.test.ts`
 * pins against the README itself (#11). The order is not a preference, and
 * since #48 it is the one the dashboard allows: Arcade reads the User Source's
 * issuer from the app, so the app and the tunnel are up before that form; the
 * gateway authenticates through the User Source, so it comes next; its form
 * lists the toolkits' tools only once they are deployed and while the hooks
 * are disabled; so the hooks are turned on last, by the second run.
 */
export function nextSteps({ host, origin, port, gateway, deployed, userSourceReady = false, appRunning = false }: NextSteps): string {
  const steps = [
    ...(appRunning
      ? []
      : ["Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.", `Start the tunnel: ngrok http --url=${host} ${port}`]),
    ...(deployed || gateway === "enabled"
      ? []
      : ["Deploy the toolkits (their secrets are set above): arcade deploy, in mcp."]),
    ...(gateway === "enabled"
      ? []
      : [
          ...(userSourceReady ? [] : ["With the app reachable through the tunnel, fill in the User Source form above."]),
          "Fill in the gateway form above. It authenticates through the User Source, and lists the toolkits' tools once they are deployed.",
        ]),
    ...(gateway === "needs-gateway" ? [`Turn the hooks on: run ${hooksOnCommand(host)} again.`] : []),
    ...(gateway === "form" ? ["Fill in the contextual access hooks form above. Arcade checks /hooks/health through the tunnel."] : []),
    `Open ${origin}, never localhost, and sign in.`,
  ];
  return ["Then:", ...steps.map((step, index) => `  ${index + 1}. ${step}`)].join("\n");
}
