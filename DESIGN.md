# Deep Agents Loan Desk with Arcade

**This repository is a fork of the Mastra partnership template below, with the agent
replaced** (2026-10-06)**, the bundled identity provider replaced by Okta** (2026-10-09) **and
the gateway removed** (2026-10-09). Read this section first: it supersedes every decision further down
that names Mastra, Studio, the chat, `lib/agent`, `src/mastra`, `memory.db`, Anthropic or
Elasticsearch, and every one that names hop 1, the User Source, the MCP gateway, the Coordinator
API or a gateway token. Those decisions are kept as the record of why the template is shaped the way it
is, and none of them describes this repository's agent.

| Decision | This repository |
|---|---|
| **The agent** | A LangChain Deep Agent on Managed Deep Agents, in `agent/` (Python, `uv`). Its tools come through Arcade's LangChain middleware (`agent/langchain_arcade`, vendored), which calls the Engine directly with the project key and runs every tool as the signed-in caller. [`docs/agent.md`](./docs/agent.md). |
| **No chat, no Studio** | The web app has no chat route and no Mastra runtime. A question goes from `agent/ask.py`, which signs the caller in at Okta and sends the ID token, to the agent. `agent/identity.py` verifies the token against the keys Okta's discovery document names. |
| **Identity provider: Okta** (2026-10-09) | **The app has no identity provider of its own.** The bundled Better Auth provider (`auth/provider/`, `idp.db`, `BETTER_AUTH_SECRET`, the login and consent pages, `IDENTITY_HOST`, the identity reset and `bun run reset --hard`) is deleted. Okta is the one IdP: `IDP_ISSUER` is an Okta custom authorization server (`https://<org>.okta.com/oauth2/default`), and the app (`auth/oidc.ts`), the loan API (`api/actor.ts`), the agent (`agent/identity.py`, `ask.py`) and `setup-arcade` are ordinary OIDC clients of it that read every endpoint from its discovery document (`auth/discovery.ts`), so an Auth0 or Keycloak issuer works with no code change. One Okta app serves the app's sign-in, `ask.py` and hop 2's `app-identity` provider, with three redirect URIs (`scripts/okta/setup.ts`). `bun run okta-setup` makes it, and `bun run users` creates each person in Okta through the Management API with an `SSWS` token that reaches it only through `op run`. Roles and clearances stay in `governance.db`; `user_id` stays `$.email`. This supersedes every decision further down that names Better Auth, `auth/provider/`, `idp.db`, `BETTER_AUTH_SECRET`, the identity module, its reset, or "the app's own" provider, issuer or sign-in. [`docs/okta.md`](./docs/okta.md). |
| **The model** | Scripted by default (`agent/scripted.py`), so the wiring runs with no model key. `MODEL_ID` picks a real one through `init_chat_model`. No `ANTHROPIC_API_KEY` in the app. |
| **Tools** | The six `LoanDesk` tools from the one `arcade deploy`, and Arcade's own `Gmail.SendEmail`, `Gmail.ListEmails` and `Slack.SendMessage`. |
| **Integration: direct, no gateway** (2026-10-09) | **The agent calls Arcade's Engine directly: the project API key, and the signed-in caller's email as `user_id` (`agent/agent.py`, which drops any `ARCADE_GATEWAY_ID` an older `.env` still sets).** There is no hop 1, no User Source, no MCP gateway and no Coordinator call; `setup-arcade` neither creates nor checks one, and creates the hooks plugin active. The cost: Tool Rec is not scoped to a gateway, so it searches the whole catalog and may suggest an unrelated tool, such as Ashby or ClickUp. Nothing relies on search to hide a tool: the project's hooks govern every call, whichever tool it is, and `/hooks/access` still filters the list each caller sees. Hop 2 (the `app-identity` provider and the custom verifier), the hooks, the `arcade deploy` and the tool secrets are unchanged. Supersedes the **Two hops**, **Gateway token storage**, **Registration** and **Integration** rows below. |
| **Two identities per run** (2026-10-14) | **The loan desk tools and discovery run as the persona, the email in the Okta ID token; Gmail and Slack run as the address the run names in `config.configurable.connected_apps_user` (`agent/ask.py --as`, `agent/agent.py` `SplitIdentityProvider`), and as the persona when it names none.** For the workshop room, agreed with Thanh-Ha the same day: everyone signs in to Okta as one of four shared personas (the free Integrator org holds ten users), and each attendee's Gmail and Slack are their own. The split is per toolkit, not per run, because the two grants are verified differently: the loan API's grant goes through the app's custom verifier, which confirms whoever is signed in to the app and answers `user_mismatch` to any other address; Gmail and Slack go through Arcade's own verifier, which binds the grant to the Arcade account that opens the link. So the `--as` address is caller-asserted and safe: a wrong one gets no grant. It must be an Arcade project member and a registered subject, `bun run users add <email> … --no-identity` (subject only, nothing in Okta), or the hooks deny the Gmail call as an unknown user. An unverified run is refused before the address is read. The catalogue now lists `Gmail.ListEmails` and `Slack.SendMessage` beside `Gmail.SendEmail`: the **Tools** row named them, and a toolkit absent from the catalogue is denied wholesale, so the Slack DM in `02-connect.md` could never have run. |
| **Loans, not a deal desk** | Back to the template's own loan domain (2026-10-07), as the architecture sketch from the 2026-10-06 call has it: a Loan MCP over a Loan REST API. The toolkit is `LoanDesk`, so a project that also holds the Elastic workshop's `DealDesk` keeps both apart. |
| **No Elasticsearch** | The Elastic module, its toolkit tools, its seed and its rules are removed. |
| **No resume** | After an approval the requester asks again; nothing pushes the grant into a running turn. |

## The template this was cut from

The Mastra partnership template for Arcade's contextual governance: an agent does real
work in a real business system, and Arcade enforces deterministic control on every tool
call. It is cut from the stage demo `ArcadeAI-labs/mastra-contextual-governance` at
`26b0cc9`, with the same thesis, the same four control points and the same policies. It is
reshaped into **one TypeScript app plus the two Python toolkits**, so a developer can run it
from Mastra's Quickstart.

**The story is act 2.** A loan officer asks the agent to approve a $95K loan. The control
plane refuses it as over her limit and routes it to the one approver with enough authority,
who approves in Slack, and her retry succeeds. The model never gets a vote. Acts 1, 3 and 4
still run, and every policy that drives them stays in force. They are not what the README,
the Studio first run or the demo video lead with.

The goal and its order are tracked on issue #1. The decision trail is on the stage demo's
#186, #187, #188 and #190.

## Thesis

Treat the LLM as an adversary. Controls it cannot reason around must live outside it.
Arcade provides **four** identity-keyed control points on every tool call, and the model
sits inside all of them:

| # | Layer | Keyed on | Mechanism | Act |
|---|---|---|---|---|
| 1 | Whether you can see the tool | identity | `/access` → `deny` list | 1 |
| 2 | Whether you hold the credential to call it at all | identity | per-tool auth requirement, OAuth scopes | — |
| 3 | Whether you have the authority for *this* call | identity + policy | `/pre` → `CHECK_FAILED` | 2 |
| 4 | What comes back | policy | `/post` → `override.output` | 3, 4 |

Layer 2 was added on #32. It is not a gap in governance — it is a cheaper, earlier gate on
the same identity, and defence in depth is the point. **It has one consequence the other
three do not:** Arcade evaluates auth requirements *before* `/pre`, so a refusal there fires
no hook, writes no audit row, and shows nothing on the panel (measured, spike #2). Never
stage a beat we want to *show* as a layer-2 refusal. See open risk 2.

## The four acts

| # | Beat | Control | Mechanism |
|---|------|---------|-----------|
| 1 | Bob (analyst) literally cannot see `approve_loan` | Access | `POST /access` → `deny` list |
| 2 | Alice's $95K exceeds her $50K authority → blocked → routed to Charlie → retry succeeds | Pre | `POST /pre` → `CHECK_FAILED` + remediation message |
| 3 | `get_loan` returns a bank account number → redacted before it reaches the model | Post | `POST /post` → `override.output` |
| 4 | Seeded underwriter note contains an injected instruction → stripped | Post | `POST /post` → regex scanner |

**Measured on #14 (2026-09-12), and it reorders the build:** acts 2 and 4 share `LN-2291`.
Until `/post` strips the injected note (act 4's control, #16/#17), the model reads it, refuses
it, and about two runs in three ends the turn asking the officer whether to proceed, so
`ApproveLoan` is never called and `/pre` never fires. The same prompt on a clean over-limit
loan (`LN-2299`) reaches the hook 12 of 12. Act 4's control therefore lands **before** act 2 is
rehearsed, and #16 re-measures the $95K rate with `/post` live (#91). Act 2's second half
additionally needs the agent to hold `Approvals_*` and the remediation text to name the tool
as the wire spells it (#89). No prompt steering is an acceptable fix for either.

## Decisions

| Area | Decision |
|---|---|
| Format | **A Mastra partnership template.** The Mastra site builds the template page from `README.md`, which follows Mastra's outline exactly: title `# Loans Approval Limits with Arcade`, a Demo placeholder until Mastra gives us a Cloudinary URL, and a Quickstart through `npx create-mastra@latest --template`. The aim is for people to work with Arcade as much as possible. |
| **Shape** | **One TypeScript app: Next.js plus `src/mastra/index.ts`.** Mastra Studio and the web UI run the same agent. The control plane and the loan API are modules of the app, not services. Decided 2026-09-23. Studio's instance also has thread memory in `memory.db`; the chat route's has none, because the browser sends its own history (#36, `lib/agent/memory.ts`). |
| Topology | **Arcade Cloud reaches the developer's machine through one ngrok host.** Hooks, the loan API and the OAuth endpoints are all on it. The tunnel is a Prerequisite, and a static ngrok domain keeps the host fixed across restarts. This reverses the demo's "no tunnels", on purpose. Decided 2026-09-23. |
| Integration | Mastra `MCPClient` (`@mastra/mcp` 2) → `https://api.arcade.dev/mcp/{gateway}`, with `protocolVersion: "legacy"` pinned so the handshake stays `initialize` and never probes `server/discover`. Elicitation handlers are passed as `inputRequests` at construction (#187). |
| Model | Claude Sonnet 5 via `@ai-sdk/anthropic`, temperature 0, model id from env |
| **Tool layer** | **Both toolkits are Python `arcade-mcp`, shipped with `arcade deploy` into one Arcade project and exposed through one gateway. `arcade-mcp` is the tool-authoring framework; it is Python-only, which is why the TS-everywhere rule does not reach the toolkits. Decided on #32, confirmed in session.** |
| **Business system** | **The loan module is the bank's system of record: a plain HTTP API under the app, owning `loans.db`. It is not an MCP server and knows nothing about Arcade or governance. `mcp/loan_desk/loans.py` is a stateless client of it, reaching it through `APP_PUBLIC_HOST`.** The demo split this into its own service to make "governance is outside the business system" literal. The template keeps that claim as a **module** boundary enforced by a test (see **Services**), not a process boundary. The bank UI's loan cards and `/loans` board read the loan module directly as the signed-in person, never through the gateway (#157 in the demo), so every MCP call still originates in the chat. |
| **Identity** | **Every person who uses the app is a user of the app's own Better Auth, with a real email, added from the terminal with `bun run users` (#31). A fresh start seeds nobody, and the demo cast is opt-in with `bun run users seed-demo` (#33).** Every user gets a role: `--role` is required (`scripts/users.ts`). There are no persona variables, and `.env` needs three values, `ANTHROPIC_API_KEY`, `ARCADE_API_KEY` and `APP_PUBLIC_HOST` (#33, `REQUIRED_KEYS` in `scripts/setup-arcade/env-file.ts`). The web UI signs in against it. Each person runs in their own browser profile, so there is no persona switcher (#176 in the demo). `context.user_id` on every hook payload is that email, lowercase. Users are *not* Arcade project members, unless the members-mode fallback is taken (below), **except requesters: see Slack and Arcade accounts.** |
| **Two hops, two mechanisms** | **Hop 1, MCP client → gateway: a User Source whose issuer is the app's own Better Auth.** Tried first because it already works in the demo. **The fallback is members mode**, taken only if the live sitting shows the User Source can't be set up easily: then the README asks for two Arcade accounts (Alice and Charlie) whose emails match the app's users. **Arcade Headers mode is ruled out and never proposed.** **Hop 2, tool-level OAuth: the Loans toolkit's `requires_auth` names the app's provider under a fixed generic id**, and a custom user verifier route in the app binds the signed-in email. Neither hop's mechanism moves the other. Decided 2026-09-23. **Amended the same day: build on the User Source without a sitting first, and verify with a real Arcade account once, at the end (#7).** |
| **Session storage** | *Superseded 2026-10-09: there is no gateway token any more. The sealed cookie holds the signed-in email and the IdP tokens, and nothing else; `auth/gateway.ts` is deleted.* **The app drives the gateway OAuth itself (`auth/gateway.ts`; Mastra's `MCPClient.authenticate()` refuses non-loopback redirects) and hands `MCPClient` a static token. The gateway access + refresh token and the signed-in email live in a sealed, HTTP-only, per-browser cookie (AES-GCM under `SESSION_SECRET`, chunked when over 4KB). One person per browser. No database holds a gateway token: the web UI keeps it in that cookie, and Studio in its process's memory (`lib/agent/studio.ts`). Refresh is server-side. Decided 2026-09-11.** `idp.db` does hold the tokens the app's own provider issues: sign-in sessions and the OAuth access and refresh tokens (`session`, `oauthAccessToken` and `oauthRefreshToken` in `auth/provider/schema.sql`). `memory.db` (#36) keeps Studio's conversations, never a credential: every message is written with its secrets withheld (`lib/agent/memory.ts`). |
| **Arcade config is read-only** | **The auth provider's advanced configuration is never edited; its `client_id`/`client_secret` request parameters stay. The app's Better Auth adapts instead (the demo's #79: Basic header plus identical body credentials accepted). Read provider config back through `GET /v1/admin/auth_providers/<id>`, not off dashboard labels.** |
| **Authorization** | **The loan tools require OAuth against the app's own provider, so they call the loan module on behalf of the user, not as a service account.** The loan module derives the actor from the token, never from a parameter. OAuth carries *identity*; hooks carry *authority*. **The provider is Better Auth inside the app**, which reverses the demo's #36. See **Identity and OAuth** for the objection that reverses, and what now answers it. |
| **One identity, not two** | **The Arcade `user_id`, the OAuth subject, and the actor the loan module records are the same person, joined on email. If these ever diverge, `governance.db` and `loans.db` describe different people and the audit trail is fiction.** |
| **Slack and Arcade accounts** | **Anyone who requests an approval is a member of the Arcade project, invited under their email. Decided 2026-09-26 (the human, at the gate on #7).** Measured by the human and undocumented by Arcade: Arcade routes its built-in OAuth providers through its own user verifier, which demands a project member, and not through the app's custom verifier, which covers custom providers such as `app-identity` only. `LoanDesk_RequestApproval` uses the stock Slack provider, so its requester must be a member; approvers and the loan tools need no Arcade account. **The alternative, also measured by the human:** registering your own Slack app as a custom OAuth provider routes Slack through the custom verifier, so nobody needs an Arcade account. It is not the default, because it asks every forker to create a Slack app; it is documented for teams that do not want their users to have Arcade accounts. |
| **Identity secret** | **`BETTER_AUTH_SECRET` is refused blank on any issuer that is not localhost or 127.0.0.1, because the development secret is published in the repo. `setup-arcade` generates it when `.env` has none and writes it to `.env` (`secretFor` in `scripts/setup-arcade.ts`), and an `idp.db` whose signing key the configured secret cannot open fails closed at boot rather than being re-keyed. Decided on #9 (the human's option 1).** `auth/provider/config.ts` (`publicHostWithoutSecret`), `auth/provider/auth.ts`. |
| **What the chat withholds** | **The stored gateway bearer is read only in `auth/handlers.ts`, the one token seam** (`liveGatewayToken` and `refreshedGatewayToken`, reached only through `gatewayToken()` in `lib/agent/gateway-token.ts`; `app-test/studio-entry.test.ts`, "only gatewayToken reaches the functions behind it" and "no module outside the identity module reads a stored gateway bearer"). **The IdP bearer in the same sealed session is read by `readLoanBook` in `lib/loan-context/read.ts`**, which sends it as the bearer when the home page and the loan board read the loan module as the signed-in person (`app/page.tsx`, `app/loans/page.tsx`, `app/api/loans/route.ts`), and renews it with its refresh token (`app-test/api-loans.test.ts`, "the bearer on the wire is the persona's own IdP token"; `app-test/loan-book-renewal.test.ts`). `withIdpToken` in `auth/session.ts` keeps the stored IdP refresh token when a renewal returns none; that branch is untested. `sessionSecrets()` in `auth/handlers.ts` reads all four session tokens so the chat can withhold them, and gives it nothing to present (`app-test/chat-leak-probes.test.ts`, "every token field of the sealed session is in it"). **`BETTER_AUTH_SECRET` is withheld by fingerprint (a length and a SHA-256, `lib/secret-fingerprints.ts`) and at runtime only the identity provider reads it: no app source outside `auth/provider/` does. Decided on #37.** `setup-arcade` reads and writes it in `.env` (see **Identity secret**). The secret's rule is held by `app-test/identity/only-identity-mints.test.ts`, and the fingerprint by `app-test/chat-leak-probes.test.ts`. |
| Policy source | Policy DB owned by the hook server. Editable live on stage. |
| HITL | Custom `request_approval` tool posts Block Kit to Slack; approval link carries **no authority** |
| Approval authz | `approvals.decide` is itself a governed tool call — pre-hook enforces role, limit, and requester ≠ approver |
| Approver routing | Deterministic minimum-sufficient-clearance, requester excluded. The LLM does not choose the approver. |
| The wait | Agent ends its turn; SSE `approval.granted` event auto-resumes it |
| Determinism | The **hook** writes the remediation instruction, not the system prompt |
| **No model-side controls** | **The agent's system prompt and every tool description carry no behavioural instruction in either direction: nothing about confirming, refusing, escalating, retrying, caution or irreversibility. Measured on #14: one "irreversible, no undo" line made Claude ask permission and `/pre` never fired; one "do not ask the person to confirm" line pushed it the other way. Both removed. The prompt states role, tools, how to resolve a loan named by amount, and how to report verbatim. `mcp/loan_desk/loans.py` descriptions follow (#90).** |
| **Readiness** | **The app answers `/health` with one field per capability and `status: ok\|degraded`, HTTP 200 either way, so a human can always read it. The fields are those the four demo services reported, under one response: `signin, gateway, verifier, agent, panel_stream, policy, loans, reset` (`gateway` went with the gateway, 2026-10-09). A missing capability is named; the home page and panel show it; nothing falls back silently. Decided across #81, #82, #14.** Since the identity fold it also carries `identity`, which answers `no_users` (degraded) until somebody is added, and `user_drift`, which names anyone who can sign in with no subject in `governance.db`, or has a subject and cannot sign in (#33, `app/health/route.ts`, `lib/user-drift.ts`). |
| Redaction | Declarative per-tool field rules + regex over free text |
| Database | The app's data is `bun:sqlite`, one file per owning module: `loans.db` (the loan module), `governance.db` (the control plane), `idp.db` (identity). One process, three owners; no module opens another's file. `bun run users` writes two of them, each through its owner's own code (`scripts/identity/people.ts` for `idp.db`, `gate/service/subjects.ts` for `governance.db`), and records every change in `governance.db`'s append-only `subject_changes` (#31). `add` and `seed-demo` write both halves or neither: the identity first, then the subject, and if the subject cannot be written the identity is taken back out (`createUser` in `scripts/users.ts`; `app-test/users-cli.test.ts`, "both halves or neither"). `remove` deletes the subject and then the identity, and nothing ties those two writes together. Studio's thread memory is a fourth file, `memory.db`: libsql, because Studio runs under Node, `MemoryLibSQL` only, owned by `lib/agent/memory.ts` and moved by `MEMORY_DB_PATH` (#36). |
| Durability | Data persists; resetting is something you deliberately run. The databases sit on local disk and seed their fixture's policy and loan book only when empty; no database seeds a person (#33). Reset is a script (#23), never a redeploy. Decided on #29. **Consequence measured 2026-09-14 (#106): a fixture change does not reach a live disk, and acts 3 and 4 were not live while `/health` said armed. Amended: `/health` reports `fixture_drift` as degraded whenever on-disk policy differs from the shipped fixture, and a presenter-only Reset control in the panel runs the reset. Policy stays durable; the silence does not.** **Reset contract, ratified at the #23 gate 2026-09-14 (aaccdc0):** every database-owning module exposes `POST /admin/reset` under its own mount (`/hooks/admin/reset`, `/bank/admin/reset`, `/identity/admin/reset`) behind one shared `RESET_TOKEN` — route absent (404) when the variable is unset, `/health` reports `reset: enabled\|disabled`, the response names what was not reset. The control plane takes `{policy\|demo}` and puts back only the demo cast's `subjects` rows that are on disk at the fixture's addresses, never adding an absent one and never touching anyone else; the loan module reseeds the loan book from the fixture inside the running image; identity clears sessions, tokens and consents, keeps every account with the password it already had, never touches the `oauthClient` row, and fails if the client id moved (#32, #33; `gate/service/policy-store.ts` `replacePolicy`, `auth/provider/reset.ts`). Neither scope deletes a user. A demo person removed with `bun run users remove` stays removed (#32). The root `bun run reset` is idempotent and exits non-zero on any refusal. It has no `--target`, and refuses the flag by name (#11, `scripts/reset.ts`). A redeploy is not a reset; a reset is not a re-registration. **Amended 2026-09-19 (#123, human's decision): the reset is two resets.** The default calls the control plane's `demo` → the loan module and **leaves identity alone**; `--hard` adds identity and is the list `#174`'s second panel button reuses (`servicesFor` in `scripts/reset.ts`). The split is argued on stage time rather than safety: a hard reset signs everyone out, costing each person a login plus an authorization card before the next take. *Not* a reason for the split: the #123 fault it was originally drawn to avoid, which does not reproduce — that was #100's replay revocation killing a fresh grant at `85e96b1`, fixed by `bbfb162` the same day. Measured separately and worth knowing: the hop-2 token is `expires_in` 3600 with no refresh token, so **any rehearsal longer than an hour costs one authorization card per person regardless of resets**. **Studio's memory (#36):** `bun run reset` also empties `memory.db` in place on both scopes, and `--hard` does nothing more to it. It has no route, because Studio is local only: the script empties it directly and refuses a `MEMORY_DB_PATH` that points at any other database. |
| Visualization | Hook server → SSE → live three-lane Access/Pre/Post panel at `/panel`, **full-screen and on its own**. The Access lane renders **one card per persona listing** (`tools/list`), naming the tools disabled for that person; grouping is presentation-only in the app (`lib/governance/grouping.ts`, #156). Amended 2026-09-18 from webinar rehearsal: decisions arriving one card at a time were too fast to narrate. |
| Design | Bank app deliberately boring enterprise UI; control plane unmistakably Arcade. **No split view** (reverses #22, 2026-09-18): the bank app is full-screen at `/`, the control plane full-screen at `/panel`, the loan board full-screen at `/loans`, and the presenter switches between them deliberately. Two panes updating at once could not be narrated on a webinar (#155). The panel visual is cut down for the back of the room (#158). |
| **Hosting** | **The developer's machine plus ngrok. one `arcade deploy`, `mcp`, carrying the Loans and Approvals toolkits.** `render.yaml` is gone (#11). What ships for hosting is the root `Dockerfile` and a platform-neutral "Deploying" note in the README; deploying is the forker's job. A deployment is recognised by `NODE_ENV=production` alone (`isDeployed` in `lib/governance/stream-url.ts`). |
| **Registration** | *Amended 2026-10-09: no User Source, no gateway and no Coordinator call. The run registers the provider, the tool secrets, the verifier and the hooks, created active (a disabled plugin is turned on and read back), then deploys. It does not wait for the app or the tunnel, writes no `ARCADE_GATEWAY_ID`, and names a leftover `ARCADE_GATEWAY_ID` or `ARCADE_USER_SOURCE_ID` as ignored. The setup order below is the record of the gateway era.* **`bun run setup-arcade <host>` registers the Arcade side by API, in the org and project of the Arcade CLI's active context (only its `org_id` and `project_id` are read), with `ARCADE_ORG_ID` and `ARCADE_PROJECT_ID` in `.env` overriding it. One read-only call checks that the key belongs to that project, and a mismatch stops the run before any write. Tool secrets are `PUT /v1/admin/secrets/{KEY}`; the hooks are a plugin under `/v1/orgs/{org}/projects/{project}/…`; `setup-arcade` runs `arcade deploy` in both toolkits. The live swagger was wrong about the secrets method, so only live calls count as proof. Decided across #26, #28 and #30** (`scripts/setup-arcade.ts`, `scripts/setup-arcade/context.ts`, `scripts/setup-arcade/arcade.ts`). **The setup order, decided 2026-09-28 in #52** (`scripts/setup-arcade.ts`, step 8; `scripts/setup-arcade/coordinator.ts`): one run. It registers everything above with the hooks created disabled, then waits for the forker to start `bun run dev` and the tunnel. On Enter it reads the issuer from the app's own discovery through the tunnel, byte for byte, and has Arcade check it (`POST …/user_sources/test_issuer`, which saves nothing; a 422 prints Arcade's reason and asks again). It then creates the User Source through the Coordinator API with the project key (`ARCADE_COORDINATOR_URL`, default `https://cloud.arcade.dev/api`, never experience.arcade.dev), reads it back by id (active, with this app's issuer and client), creates the gateway through it by API (`auth_type` `user_source`, never Arcade Headers, exactly the six tools), and turns the hooks on last. Each step is read back. A User Source that claims this app's issuer or client and differs stops the run with exit 1, no gateway, and the hooks as they were; it is never edited. A rerun is a no-op. **The fallback is #48's order, unchanged**, taken whenever the Coordinator answers anything the contract does not (a 401 or a 404 is said to be the key or the project), stdin is not a terminal, or the forker answers `n` at the wait: (1) the hooks stay disabled, no gateway is made, and the run prints the User Source form and then the Gateway form, with a warning that the gateway runs ungoverned until the second run; (2) the forker creates the User Source and then the Gateway by hand in the dashboard, and the gateway authenticates through that User Source, never Arcade Headers; (3) the second run enables the hooks, and only once it finds a gateway with the printed slug: with a wrong tool list, the hooks are enabled anyway, with a warning, and a gateway whose `auth_type` is not `user_source` is refused, with the hooks left as they were. Why this order: active hooks filter the tool list a gateway is made from, so the gateway comes before the hooks. Why a fallback: whether the Coordinator API stays stable for clients outside Arcade is not known. |
| **Toolkit configuration** | **One Arcade tool secret, `APP_PUBLIC_HOST`** (the ngrok host), replaces `LOAN_APP_PUBLIC_HOST`, `HOOKS_PUBLIC_HOST` and `WEB_PUBLIC_HOST`. A developer never edits tool code. The auth provider id is not configurable, because `OAuth2(id=...)` is read at import: it is a fixed generic id, `app-identity` (`ARCADE_PROVIDER_ID` in `auth/provider/client.ts`), and `setup-arcade` registers the provider under it. Decided 2026-09-23. |
| **Languages** | **TypeScript for the app and everything under `packages/`. Python for both `arcade-mcp` toolkits. The boundary is *tool authoring*, not *domain*.** |
| CI | `bun test` runs in four weighted shards, each `bun test --isolate` (#38, `.github/workflows/ci.yml`, `scripts/test-shards.ts`). **#38's criterion 3, one shared Next server per shard, is waived:** it would need a test-only runtime-reconfig path in the production app. Sharding plus `--isolate` ships, and #46 is the follow-up. |

## Services

**The folds have landed.** `apps/` is gone: the control plane is `gate/service/` (#4),
the loan module `api/` (#5) and identity `auth/` (#6), all served by the one app.

**The app lives at the repo root** (decided 2026-09-23, #3). The root `package.json` is
the app, with `src/mastra/` and the Next.js routes at the root, so Mastra's Quickstart and
`mastra dev` run from the top of a fresh clone. `packages/*` stay workspaces.

**The app runs on Bun** (decided 2026-09-23, #4): `bun:sqlite` does not load under Node, so
`next dev`, `next build` and the standalone server all run under `bun --bun`. Studio
(`mastra dev`) is a separate Node process, so the shared agent never imports a module that
opens `bun:sqlite`.

**TypeScript stays on 6** (decided 2026-09-24, #8): `mastra dev` bundles through
`typescript-paths`, which needs TypeScript's JS API, and TS 7 doesn't export it. This
reverses the TypeScript half of #2 (0b). A test boots `mastra dev` so a bump is caught.

**The control plane is mounted under `/hooks`** (decided 2026-09-23, #4). Arcade's hook
extension base URL is `<APP_PUBLIC_HOST>/hooks`, so Arcade calls `/hooks/access`,
`/hooks/pre`, `/hooks/post` and `/hooks/health`, and the last answers Arcade's
`healthy|degraded|unhealthy`. The app's own `/health` (see **Readiness**) keeps
`ok|degraded`, so neither contract bends. The approvals store API is `/api/approvals/*`.

    app (Next.js)
      gate/service     /access /pre /post, policy engine, audit, SSE, /approvals.
                       Owns governance.db. Policies: gate/policies/governance.json.
      api/             the loan REST API, the bank's system of record. Owns loans.db.
                       No MCP, no Arcade, no governance.
      auth/            Sign-in as an OIDC client of Okta (IDP_ISSUER), sessions, the custom
                       verifier. No identity provider and no database (2026-10-09).
      auth-config/     what to register at Arcade, one JSON body each, as setup-arcade sends it.

    mcp/  One Python arcade-mcp server, one toolkit (LoanDesk), one arcade deploy:
      loan_desk/loans.py          search_loans, get_loan, approve_loan, deny_loan.
                                  Stateless client of the loan API, via APP_PUBLIC_HOST.
      loan_desk/approvals.py      request_approval, decide.

    agent/         The LangChain Deep Agent on Managed Deep Agents (this fork). docs/agent.md.
    gate/engine    Hook framework, policy engine, audit, event bus. Zero loan references.
    gate/schema    Shared zod types for policy, events, hook payloads.

**One install, one zod (the demo's #187).** Every workspace is on zod 4.6.5, pinned exactly
in the root `overrides`, so a fresh clone needs one `bun install`. The old zod 3 pin was a
precaution, and it had become a blocker: `@mastra/mcp` 2 sits on `@modelcontextprotocol/*` 2,
which requires zod 4.2 or later. Better Auth was held at 1.7.2 in the demo because 1.7.5
drops `account.issuer` and would need a migration on a live disk (#188 there). Here
`idp.db` starts fresh, so the identity fold takes 1.7.5 with a fresh schema.

**The boundaries survive the fold; only the process boundary goes.** The demo argued that
separate processes *were* the proof that governance lives outside the business system. The
template makes the same claim with module boundaries, each enforced by a test that must
still bite after the fold. A slice that moves a service in has to show its boundary test
failing on a planted violation.

- **The loan module knows nothing about governance.** It declares `"cg": { "governed": true }`.
  `knows-nothing-about-governance.test.ts` fails if governance vocabulary or a `@cg/*`
  import appears in its source, and `policy-schema`'s workspace sweep exempts it. Both
  halves read the same flag, so they cannot drift apart (#33 in the demo).
- **`governance-core` depends on no app.** `no-app-dependencies.test.ts` holds.
- **Nothing in the app mints identity tokens** (2026-10-09). The rule used to be "only the
  identity module mints tokens"; with the provider gone, Okta mints every token the app,
  Arcade and the agent accept, and the app holds no signing key.

Forking means replacing the loan module, `mcp/loan_desk/loans.py` and the seed data, and touching
nothing under `packages/`.

## Identity and OAuth

There are **two authentication hops** with two different mechanisms. Conflating them
cost a day on #75.

    Alice, in her own browser profile
      → the app  "Sign in"  (OIDC code + PKCE against Okta, IDP_ISSUER; Alice
                    types her own password, and the page never names her)
        → sealed cookie { email, gateway tokens }
      → hop 1: the app drives the gateway OAuth against the template's User Source gateway (
               HTTPS redirect /api/arcade/callback, PKCE); Arcade renders its own
               consent screen once per persona per MCP client id
      → Mastra MCPClient → https://api.arcade.dev/mcp/<gateway>   bearer = gateway token
        → /access   hooks see user_id = alice@…            ← layer 1
        → auth requirement: does Alice hold the provider's token? ← layer 2 (no hook fires)
          first time: Arcade 303s the browser to the custom verifier
            GET /api/arcade/verify?flow_id=…   (the app)
              · session present → POST cloud.arcade.dev/api/v1/oauth/confirm_user
                {flow_id, user_id: <session email>} server-side, then fetch next_uri
                server-side exactly once, then send the browser to the app's own
                Authorized page, which links to / (never to Arcade's continuation;
                human decision at the #100 gate, landed #118 e23bf57). The grant does
                not store unless next_uri is fetched (measured, #75). Arcade's Location
                from that fetch is logged and otherwise ignored.
              · no session → park flow_id in a short-lived signed cookie, send the
                browser to sign-in, and complete the same two calls from the sign-in
                callback. The verifier never reads the persona from the query string.
          then Arcade exchanges the code at Okta (hop 2)
        → /pre      hooks see user_id = alice@…            ← layer 3
          → mcp/loan_desk/loans.py (arcade deploy) receives Alice's OAuth token
            → the loan module validates it, actor = alice@…
        → /post     hooks rewrite the output               ← layer 4

Arcade's default verifier demands an Arcade account that is a project member. Left to it, a
user is verified against whatever Arcade account the browser holds, which binds the grant to
the wrong user, and the tool re-challenges forever (observed 2026-09-11 15:40Z). For the
app's own provider, `app-identity`, the custom verifier replaces it, so the app's users need
no Arcade account for the loan tools. The custom verifier is what makes the
IdP-asserted email the identity on hop 2, exactly as the User Source makes it the identity
on hop 1. **It covers custom providers only.** Arcade routes its built-in providers through
its own verifier, so the stock Slack provider that `LoanDesk_RequestApproval` uses demands
an Arcade project member: anyone who requests an approval must be invited to the Arcade
project under their email (measured by the human, undocumented by Arcade, 2026-09-26; see
**Slack and Arcade accounts** under Decisions).

Three rules this has to hold to:

1. **The loan module derives the actor from the token, never from a request parameter.**
   An actor passed as an argument is an actor the model can forge, and act 4 is
   specifically about the model trying to.
2. **Scopes are not the governance gate.** A layer-2 refusal is invisible to the control
   plane. Every beat we intend to *show* is an `/access` or `/pre` decision.
3. **Email is the join key.** Arcade `user_id`, OAuth subject, and `loans.db`'s actor
   column are the same string.

**Superseded 2026-10-09: the provider is Okta, outside the app,** which answers the objection
below the way the demo's #36 did, with a process boundary, and more strongly: the app cannot
mint itself a token because it holds no signing key. The paragraphs that follow are the record
of the fold it replaces.

**The provider lives inside the app, and that reverses the demo's #36.** The demo kept
Better Auth in its own service, `apps/idp`, as a stand-in for the enterprise IdP. It refused
to fold it into `apps/web` because an enterprise audience would ask whether the web app
could mint itself a token, and the answer would be yes. Folding it into the loan app was
ruled out because Better Auth's own vocabulary trips the loan boundary test.

The template folds it into the app anyway, on the human's decision (2026-09-23): one app is
what makes a Mastra Quickstart possible. The objection is answered by a module boundary,
not a process one. **Only the identity module mints tokens,** and a test fails if any other
module imports its signing keys or issuance (see **Services**). The loan-module rule is
unchanged, and the identity module is never folded into the loan module.

A forker who has a real IdP replaces the identity module and points both hops at it.
`bun run users` keeps its control-plane half there (`gate/service/subjects.ts`) and
drops its identity half, because the real IdP owns the accounts (`docs/DOMAIN-SWAP.md` §4).

Arcade is an OAuth *client* here: it needs a client id and secret, an authorize URL, a
token URL, and its own generated redirect URI allowlisted on our side. It does not consume
OIDC discovery — endpoints are configured explicitly. It extracts the user's identity from
`/oauth2/userinfo` via a JSONPath expression, **which is what turns rule 3 from a
convention into a mechanism**.

Since 2026-10-09 `setup-arcade` does read the issuer's discovery document, and registers the
authorize, token and userinfo endpoints it names, so no Okta path is spelled in the repo.

⚠️ (Before 2026-10-09.) **Resetting `idp.db` must not rotate the OAuth client credentials. Rotating them silently breaks the
registration held in Arcade** at the authorize step, which fires no hook,
so the panel stays dark and nothing on screen explains why. The reset must leave the OAuth
client alone. Owned by the demo's #36. `auth/provider/reset.ts` reads the client ids
before and after the reset and fails on any difference.

## Tool surface

**loan** (Python, `arcade deploy`; reads `APP_PUBLIC_HOST`)
- `search_loans(status?, min_amount?, max_amount?)`
- `get_loan(loan_id)` → includes `bank_account_number`, `tax_id`, `underwriter_notes`
- `approve_loan(loan_id, amount)`
- `deny_loan(loan_id, reason)`

**approvals** (Python, `arcade deploy`; reads `APP_PUBLIC_HOST`)
- `request_approval(action, resource_id, amount, justification)` — routes deterministically, posts Block Kit
- `decide(request_id, decision, note?)` — called from the approval page as the clicker

**Names, as measured on the wire (#35, #82, #14).** Toolkits deploy as `Loans` and `Approvals`.
MCP advertises `LoanDesk_SearchLoans`, `LoanDesk_GetLoan`, `LoanDesk_ApproveLoan`, `LoanDesk_DenyLoan`,
`LoanDesk_RequestApproval`, `LoanDesk_Decide` (underscore). Hook payloads and audit rows name
the same tools with a dot: `LoanDesk.GetLoan`. Policy rules are keyed the dot way; remediation text
that tells the model which tool to call must use the underscore spelling the model actually
sees (#89). A gateway `tools/list` carries **eight** entries: the six above plus Arcade's
built-ins `System_ManageAuthorization` and `Arcade_ListApps`; the agent filters to the two
project toolkits (`ARCADE_TOOLKIT`, `ARCADE_TOOLKIT`).

## Cast

Presentation names are Alice, Bob, Charlie and Michael. The keys `dana`, `sam`, `riley` and
`morgan` are internal only (the fixture's `persona` keys) and never reach anything a reader
sees. The local fixture domain is `@bank.example`.

| Persona | Key | Role | Limit | Notes |
|---|---|---|---:|---|
| Alice | `dana` | Loan Officer | $50,000 | The protagonist of act 2 |
| Bob | `sam` | credit analyst | $0 | `approve_loan` hidden entirely: act 1 |
| Charlie | `riley` | VP Credit | $250,000 | The minimum-sufficient approver for $95K |
| Michael | `morgan` | Chief Credit Officer | $5,000,000 | Deliberately *not* bothered, which proves routing |

**The cast is the demo's, and it is opt-in (#33, the driver's option A).** A fresh start
seeds no people on either side: `idp.db` gets no accounts and `governance.db` no subjects.
`bun run users seed-demo` is the only way to get the demo cast. It adds the four with the
fixture's roles and clearances and a generated password each, printed once. Seeded at the
fixture's addresses they are the demo cast, which a reset puts back and `fixture_drift`
compares; seeded under your own (`--alice <email>` and so on) they are real users, which a
reset keeps as they are. Anyone else is added with `bun run users add`. **A missing demo
subject is not drift; an identity with no subject, or a subject with no identity, is**
(`user_drift`, `lib/user-drift.ts`).

A user who requests an approval (Alice) must also be a member of the Arcade project under
the same email, because the stock Slack provider goes through Arcade's own verifier
(2026-09-26); the others need no Arcade account unless the members-mode fallback is taken.
Each accepts Arcade's gateway consent screen once per browser profile per MCP client id.

Seed loan `LN-2291`, Northwind Bakery LLC, $95,000. Carries `bank_account_number` and
`tax_id` (act 3) and an `underwriter_notes` field containing an injected instruction (act 4).

## Event contract

Audit row and SSE frame (confirmed on the wire on #14; `redactions` added on #16, ca9e17f):

    { id, ts, execution_id, hook: 'access'|'pre'|'post',
      user_id, tool, decision: 'allow'|'deny'|'modify',
      reason, rule_id, redactions?: RedactionRecord[] }

    RedactionRecord = { path, rule_id, pattern_id, kind }     // where and why, never what

A `/post` `modify` says what it did through `redactions[]`, one record per thing removed:
JSONPath into the tool output, the rule and pattern that fired, and the strategy. **There is
no field for the removed value, and `before`/`after` are gone from the wire.** Both were the
obvious place to put the raw tool output, and this row is written to `audit_log` and streamed
on `GET /events`; a shape that *could* carry the account number eventually would, into the two
places most likely to be read aloud. The panel renders the mask from `redactions[]`. The
panel's fixture replay still emits the old `before`/`after` shape and `@cg/policy-schema`
still types it; #101 aligns both. Decided on #16 (driver option A), measured on the wire 2026-09-14.

What each layer answers, as measured:

- `POST /pre` denial: HTTP 200, `{ code: "CHECK_FAILED", error_message: "DENIED: … [ref evt_…]" }`;
  allow: `{ code: "OK" }`. The `[ref evt_…]` token is the correlation to the audit row (#6).
- Over MCP the denial flattens to `{ isError: true, content: [{ type: "text", text:
  "Tool execution was denied by an extension policy: DENIED: … [ref evt_…]" }] }`. Mastra
  surfaces it as a tool-error with the text in `payload.error.cause.message`.
- Layer 2 (no token yet) is the same `isError: true` envelope whose text is JSON carrying
  `authorization_url` and `llm_instructions`. No hook fires, no audit row. The chat renders
  it as an authorization link, never as a denial.
- The chat stream (`POST /api/chat`) is `application/x-ndjson`, one event per line, kinds
  `text`, `tool-call`, `tool-result`, `denied`, `fault`, `authorization`, `error`, `done`.
  `denied` requires positive evidence of a hook decision (Arcade's prefix, `CHECK_FAILED`,
  `CONTEXT_DENIED`, or the `[ref evt_…]` token); every other tool failure is `fault` and the
  UI says no decision was made. A control surface must never assert a control-plane action
  that did not happen (#14 review).

## Open risks

**Carried over from the demo, still true:**

1. **Layer-2 refusals are invisible to the control plane.** An unmet auth requirement returns
   `tool_requirements_not_met`, and no hook fires (spike #2). Never stage a beat we want to
   show as an auth failure.
2. **Identity could silently split.** The Arcade `user_id` and the OAuth subject must be the
   same email. The User Source binds it on hop 1 and the custom verifier on hop 2. With the
   verifier disabled, a browser signed into account.arcade.dev as someone else binds the
   grant to that someone. Check the verifier through the admin API, not the dashboard label.
3. **Arcade replays the authorization code once per flow.** Better Auth answers the replay
   `invalid_grant` but does not revoke the first exchange's tokens (the demo's #100 and
   #127). The identity fold must carry that guard over, with its test.
4. **The hop-2 token lasts an hour with no refresh token**, so any session over an hour
   costs each persona one authorization card (the demo's #164 is the fix).

**New with the template.** The slices design against Arcade's public docs, and the human's end-of-line test (#7) measures these with a real account. Every slice lists its assumptions on #7 (decided 2026-09-23):

5. **Studio versus hop 1.** The web UI gets its gateway token from a browser sign-in, and
   Studio has none. What token does the Studio agent use, without Headers mode? **Answered
   in code:** Studio runs hop 1 itself as a loopback MCP client (`/arcade/authorize` on
   `STUDIO_PORT`) and holds one grant per process, in memory (`lib/agent/studio.ts`). Whether
   Arcade accepts a dynamically registered `http://localhost` redirect is still for #7.
6. **The rule for hop 1.** A User Source if Arcade's API can create the provider, the User
   Source and the gateway (so one `setup-arcade <ngrok url>` does it), or if a setup page
   can print at most two paste-ready dashboard forms beyond the provider. Members mode
   otherwise. **Settled by the setup order decided 2026-09-28 in #52:** one
   `setup-arcade` run creates the User Source and the Gateway by API, with #48's two
   dashboard forms as its fallback, and hop 1 stays a User Source (see **Registration** under
   Decisions).
7. **The join key**, in members mode only. The pre-hook sees the Arcade account, and the
   loan module sees the app user. Measure what each receives, and write the must-match rule
   into the README.
8. **Registration by API.** This decides whether the Quickstart is about 5 steps or 8.
   **Answered:** everything is registered by API (#26, #28, #30, #52), and the User Source and
   the Gateway are dashboard forms only when that falls back (see **Registration**).
9. **The chat route on the production image under Turbopack is unverified** (the demo's
   #190). It needs `bun run verify:standalone` with Docker, or the first
   live run.

## Sequence

Tracked on issue #1.

0b. Apply the demo's #190 range `26b0cc9..4809b99` (Next 16 on Turbopack, TypeScript 7,
    React 19.3, `@types/bun`, `arcade-mcp-server` 1.32), with a fresh review. **Skip
    `55622c4`:** its `DESIGN.md` record is already in this document.
0c. Move `apps/web` to the repo root as the one app (#3), before the folds.
1. Fold `apps/hooks` into the app. It sets the contract Arcade calls, so it gates before merge.
2. Fold `apps/loan-app` into the loan module. Runs in parallel with 1.
3. Fold `apps/idp` into the identity module, with hop 1 as a User Source (or the fallback)
   and `APP_PUBLIC_HOST`. Hop 1 is the User Source; the live check is deferred to #7.
4. The Studio entry, `src/mastra/index.ts`. Its first run is Alice's $95K approval, refused.
5. Collapse setup: a minimal `.env.example`, one `dev` command, and `setup-arcade` if risk 8
   allows it.
6. The README in Mastra's exact outline.
7. Submission cleanup: what ships. Done by #11 (`render.yaml`, `docs/spikes` and
   `docs/evidence` removed), except `.orca/` and the harness, which are the last commit
   before submission, after #7.
8. The human records the 2 to 3 minute video and sends the repo to Alex Booker.

**Process (the human's rule, 2026-09-25):** fixes for live-test (#7) failures get no agent
review. The human tests the PR branch live, and it merges on their pass. Feature slices
keep agent review.
