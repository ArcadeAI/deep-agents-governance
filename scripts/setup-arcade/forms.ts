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
 * There is no User Source form and no gateway form: the agent calls the
 * Engine directly with the project key (DESIGN.md → Integration).
 */
import { healthCheckUrl, HOOKS_NAME, HOOK_POINTS } from "./arcade.ts";

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
export function nextSteps({ host, origin, port, hooks, deployed, appRunning = false, oktaRerun = false }: NextSteps): string {
  const steps = [
    ...(oktaRerun
      ? ['Allowlist the provider\'s callback on the Okta app: OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- bun run okta-setup']
      : []),
    ...(appRunning
      ? []
      : ["Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.", `Start the tunnel: ngrok http --url=${host} ${port}`]),
    ...(deployed ? [] : ["Deploy the toolkits (their secrets are set above): arcade deploy, in mcp."]),
    ...(hooks === "form" ? ["Fill in the contextual access hooks form above. Arcade checks /hooks/health through the tunnel."] : []),
    `Open ${origin}, never localhost, and sign in.`,
  ];
  return ["Then:", ...steps.map((step, index) => `  ${index + 1}. ${step}`)].join("\n");
}
