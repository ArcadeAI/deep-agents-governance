# FAQ

Documentation could not answer several of these, so we measured them against a real Arcade project. [`DESIGN.md`](../DESIGN.md) records the reasoning behind each decision.

## Why are the limits enforced in hooks rather than in the agent's prompt?

A limit in the prompt is one more thing for the model to weigh, and one sentence of prompt was enough to move the result either way, as [Why we built this](../README.md#why-we-built-this) describes. So the system prompt and every tool description carry no behavioural instruction: nothing about confirming, refusing, escalating, retrying or caution. The hook writes the denial and the instruction to escalate, which is why the agent calls `LoanDesk_RequestApproval` with no mention of it in the prompt.

## Do the hooks fire for toolkits shipped with `arcade deploy`?

Yes. A spike measured `/access`, `/pre` and `/post` firing for a remote MCP server's tools, with a payload identical in shape to a hosted toolkit's. Arcade confirmed that the hooks apply to every tool wherever it is hosted, including `arcade deploy`'d toolkits, which is how both of this template's toolkits ship. The same spike found one exception. Arcade checks a tool's auth requirements before `/pre`, so a layer-2 refusal fires no hook and writes no audit row, as [How the controls work](./architecture.md#how-the-controls-work) explains.

## How do I tell a refusal from a failure?

By the evidence a hook decided. Every refusal the control plane writes carries `CHECK_FAILED` and a `[ref evt_…]` token, which survives Arcade all the way to the agent's tool result and joins it to its audit row on `/panel`. A tool failure without them is a fault, and no decision was made. The approval page keeps the same three outcomes apart, recorded, refused and failed, because a control surface must never claim a control-plane action that did not happen.

## Why does the $95K approval depend on stripping the note pasted into `LN-2291`?

Because the model reads the injected instruction, refuses it, and ends its turn asking whether to proceed, so it never calls `LoanDesk_ApproveLoan`. With the note visible, the $95K request reached `/hooks/pre` roughly 5 times in 17; with `/hooks/post` stripping the note first, 5 of 5, and 5 of 5 again on an independent re-measurement. The fix removed what the model was reading and did not steer the model. Those runs were measured on the Mastra agent this repository replaced, on Claude Sonnet 5 at temperature 0, and the Deep Agent has not been measured yet.

## Why does Charlie's Slack DM come from Alice and not from a bot?

Arcade's stock Slack provider issues a delegated user token, so the DM arrives under the requester's own name with no app badge. There is no custom Slack app and no bot fallback, which is why Alice authorizes Slack once through Arcade and nobody configures a Slack token. The toolkit asks for four scopes, `chat:write`, `im:write`, `users:read` and `users:read.email`, because Slack refuses an authorize request for `users:read.email` without `users:read`.

## Why two OAuth hops?

Because Arcade establishes who you are at two separate points. Hop 1, the agent reaching Arcade, is answered by the project key and the email from the Okta ID token the agent verified, with no gateway between them; hop 2, the loan tool calling the loan API as the signed-in person, is answered by the `app-identity` provider and a custom verifier. A spike measured that hop 1's identity does not carry into hop 2 (when hop 1 was still a User Source gateway), and without the custom verifier Arcade sends the user to its own account login, which requires an Arcade account that is a project member. The mechanisms are in [Two OAuth hops, two mechanisms](./architecture.md#two-oauth-hops-two-mechanisms).

## Can the control plane see an OAuth misconfiguration?

No. The two identity spikes hit four, among them a token request that carried the client credentials twice and a Client ID field holding a URL, and each one fired no hook and left the panel empty. Read the auth provider's configuration back through Arcade's admin API rather than off the dashboard, because a spike caught the dashboard's auth-method label disagreeing with what the provider sent. The two-hop design the spikes led to is in [`DESIGN.md`](../DESIGN.md#identity-and-oauth).

## Do my users need Arcade accounts?

With Arcade's built-in Slack app, the default, each loan officer who requests an approval has to be invited to your Arcade project's Members, under the email they sign in to the app with; approvers and the loan tools need no Arcade account. With your own Slack app, registered as your project's Slack auth provider, your app's users need none at all, as [`app-users-and-arcade-accounts.md`](./app-users-and-arcade-accounts.md) explains.

## Why does it need a public host when it runs on my machine?

Because Arcade Cloud makes the calls. Arcade calls the hooks, the deployed loans toolkit calls the loan API, and hop 2 reaches the app's custom verifier, all on `APP_PUBLIC_HOST`. The sign-in itself is at Okta. One ngrok domain carries all of them, and a fixed domain keeps that host the same across restarts, which matters because `bun run setup-arcade` registers it with Arcade. If you host the image instead, as [Deploying](./deploying.md) describes, `APP_PUBLIC_HOST` is the deployment's own host.

## Why Bun?

The three databases use `bun:sqlite`, which Node cannot load, so `next dev`, `next build` and the standalone server all run under Bun. The agent is Python, in its own process, and reaches the app only through Arcade and the app's public endpoints, so it never opens one of them.

## Which model does the agent run?

None, until you choose one. With `MODEL_ID` unset in `agent/.env`, the agent runs a scripted model that searches the loan book and answers, which proves the wiring with no model key. Set `MODEL_ID` to a `provider:model` id, such as `anthropic:claude-sonnet-5-5`, install that provider's package (`uv sync --extra anthropic` for Anthropic) and set its key, such as `ANTHROPIC_API_KEY`. `MODEL_ID` goes to LangChain's `init_chat_model`, so any provider it knows works with no code change. The 5-of-5 result above was measured on another agent and model, so measure it again on yours.
