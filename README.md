# Deep Agents Loan Desk with Arcade

A loan officer asks a LangChain Deep Agent, in plain language, to approve a $95K loan for a second bakery location. The agent searches the loan book, reads the request and calls the approval tool as her. Arcade sends that call to this app's control plane before it runs, and the control plane refuses it: $95K is over her $50K approval authority. The refusal tells the agent how to escalate, the request reaches the one approver with enough authority in Slack, and once he approves, her retry goes through. Gmail and Slack, Arcade's own tools, carry the follow-up. You get a decision the model could not talk its way around, with an audit row for every step on a live panel.

The agent runs on LangChain's Managed Deep Agents and reaches its tools through one Arcade gateway: the loan desk's own MCP server, backed by the loan REST API in `api/`, and Arcade's built-in Gmail and Slack. The wire and the screen are the loan desk's: `LoanDesk_ApproveLoan`, `LN-2291`, loan officer, credit analyst, VP Credit, chief credit officer.

## Why we built this

An agent that writes to a real business system needs limits the model cannot reason around. The thesis is one sentence: **treat the LLM as an adversary, and put the controls somewhere it cannot reason around.**

A limit written into a system prompt is a suggestion, and we measured how fragile it is: one "irreversible, no undo" line made the model stop and ask permission, and one "do not ask the person to confirm" line pushed it the other way. So the agent's instructions carry no limits at all, and every control lives outside the model, in hooks Arcade calls on every tool call, keyed on who is signed in. The model never gets a vote.

## Demo

<!-- TODO: REPLACE THIS PLACEHOLDER WITH THE CLOUDINARY DEMO VIDEO URL -->

<video controls width="640" height="360" src="CLOUDINARY_DEMO_VIDEO_URL_REQUIRED"></video>

## Prerequisites

- **[Arcade project, key and CLI](https://docs.arcade.dev/en/references/arcade-cli)**: `bun run setup-arcade` registers everything in one Arcade project and runs `arcade deploy` into it, so the key and the Arcade CLI have to point at the same project. In this order:
  1. Install the Arcade CLI: `uv tool install arcade-mcp`, as the [Arcade CLI reference](https://docs.arcade.dev/en/references/arcade-cli) describes.
  2. Run `arcade login`.
  3. Create a project for this template in the Arcade dashboard ([Operate quickstart](https://docs.arcade.dev/en/operate/quickstart)).
  4. Create an API key in that project and set `ARCADE_API_KEY` to it ([Get an API key](https://docs.arcade.dev/en/get-started/setup/api-keys), or the dashboard's [API keys](https://api.arcade.dev/dashboard/api-keys) page).
  5. Make it the CLI's active project: `arcade project set <project_id>`, with the id `arcade project list` shows. If your account has more than one org, run `arcade org set <org_id>` first, because switching org resets the active project to that org's default ([CLI cheat sheet](https://docs.arcade.dev/en/references/cli-cheat-sheet)).
  6. Check it: `arcade whoami` shows that org and project.
- **[ngrok domain](https://ngrok.com/docs/universal-gateway/domains/)**: set `APP_PUBLIC_HOST` to your ngrok domain in host form, with no scheme (for example `my-app.ngrok.app`). Arcade Cloud calls the hooks, the loan API and the sign-in endpoints on this host, and the agent checks who is calling against this host's keys. Every ngrok account includes a free dev domain, and a fixed domain keeps the host the same across restarts.
- **A LangSmith workspace with Managed Deep Agents**: the agent in `agent/` runs on [Managed Deep Agents](https://docs.langchain.com/langsmith/managed-deep-agents), which is in beta, so the workspace needs beta access and an API key. You also need [`uv`](https://docs.astral.sh/uv/). The agent runs with a scripted model and no model key until you give it a real one ([`agent/README.md`](./agent/README.md)).
- **A Slack workspace with two accounts in it**: one for you, the loan officer who asks for the approval, and one for the approver. The request reaches the approver as a Slack DM sent from your own account, and it finds the approver by the email you add them under, so that email has to be the one their Slack account uses. With Arcade's built-in Slack app, each loan officer also has to be a member of your Arcade project; with your own Slack app, your app's users need no Arcade account ([`docs/app-users-and-arcade-accounts.md`](./docs/app-users-and-arcade-accounts.md)).
- `ARCADE_API_KEY` and `APP_PUBLIC_HOST` are the only values you fill in for the app. The second block of `.env.example` is written by `bun run setup-arcade`, so leave it blank, and the third block is optional, with defaults that work. The agent has its own `agent/.env.example`, filled from the same values in step 8. No user is seeded and no password ships: you add the people in step 7 of the Quickstart.

## Quickstart 🚀

1. **Clone the repository**
   - Run `git clone <this repository's URL> deep-agents-loan-desk`, then `cd deep-agents-loan-desk`.
2. **Install dependencies**
   - Run `bun install`. One install covers the app and its workspaces. The agent installs separately, with `uv`, in step 8.
3. **Add your API keys**
   - Run `cp .env.example .env` and fill in the two values described under Prerequisites.
4. **Register the app with Arcade**
   - Run `bun run setup-arcade <APP_PUBLIC_HOST> --dry-run` to print every request it would send and every deploy it would run, with every secret as a placeholder. Nothing is written, sent or deployed.
   - Run `bun run setup-arcade <APP_PUBLIC_HOST>` first, before the app and the tunnel: it tells you when to start them. It checks that `ARCADE_API_KEY` belongs to the Arcade CLI's active project before it writes anything. Then it mints the app's three OAuth clients, fills the second block of `.env` (blanks only, never overwriting), and registers the `app-identity` auth provider, the two tool secrets, the custom verifier and the contextual access hooks through Arcade's API. It creates the hooks disabled, and turns them on last. Then it runs `arcade deploy` once, in `mcp`, which carries the Loans and Approvals tools.
   - Then it waits for you to start the app and the tunnel, in two other terminals. Run `bun run dev`, which prints the URL to open, `https://<APP_PUBLIC_HOST>`, and the ngrok command for the app's port, which is `PORT` from `.env`, 3000 when unset. In the other terminal, run the ngrok command `bun run dev` printed. With the default `PORT` it is `ngrok http --url=<APP_PUBLIC_HOST> 3000`; with any other `PORT`, the tunnel has to point at that port instead. `bun run up` is the same two in one terminal: it starts the app and the tunnel together and stops both on Ctrl-C. Press Enter when both are running.
   - On Enter it reads the app's sign-in through the tunnel, then has Arcade check it the same way. If either check fails, it prints why and asks again. Then it creates the User Source through Arcade's Coordinator API, or uses the one it created before, and the gateway through it, with exactly the four Loans tools, the two Approvals tools and Arcade's Gmail and Slack tools, never Arcade Headers. Last, it turns the hooks on. It reads each one back. Run it again, and it says everything is already in place.
   - If a User Source for this app already exists and differs, it names each difference and stops before the gateway: correct or delete it in the Arcade dashboard, then run it again.
   - If a Coordinator call fails, if you answer `n` or press Ctrl-C at the wait, or if stdin is not a terminal, it says which, leaves the hooks disabled, and falls back to the dashboard: it ends by printing the User Source form, then the gateway form, then the command for step 6, and a warning that the gateway runs ungoverned until step 6. Then follow steps 5 and 6. Otherwise, skip to step 7.
5. **If it fell back: create the User Source and the gateway**
   - Run `bun run dev` and, in a second terminal, the `ngrok http --url=<APP_PUBLIC_HOST>` command it printed for your `PORT`, if they are not running yet (or both at once with `bun run up`).
   - With the app reachable through the tunnel, fill in the User Source form that `setup-arcade` printed (Arcade dashboard, your project, User Sources). Arcade reads the app's sign-in through the tunnel when you save it.
   - Then fill in the gateway form it printed (your project, MCP Gateways), under the slug it names. Its authentication is the User Source you just created, never Arcade Headers, and its tools are exactly the four Loans tools, the two Approvals tools and Arcade's Gmail and Slack tools.
6. **If it fell back: turn the hooks on**
   - Run `bun run setup-arcade <APP_PUBLIC_HOST>` again. It finds the gateway under that slug, turns the hooks on and reads them back, and fails unless Arcade reports them active. If there is no gateway yet, it names the slug, says the gateway form is still to do, and leaves the hooks disabled. Run once more, it says the hooks are already on.
7. **Add yourself and an approver**
   - Add yourself as the loan officer: `bun run users add <your-email> --name Alice --role loan_officer --clearance 50000`. Any name works, but the rest of this README calls the loan officer Alice and the approver Charlie.
   - Add the approver: `bun run users add <approver-email> --name Charlie --role vp_credit --clearance 250000`. Use the email the approver's Slack account uses, because that is how the escalation finds them in Slack.
   - Each `add` prints a generated password once, and only its hash is stored, so keep it: that password and the email are the sign-in. Nothing needs a restart, because the running app reads new people on their next sign-in.
   - Do your app's users need Arcade accounts? With Arcade's built-in Slack app, yes: invite each loan officer to your Arcade project's Members. With your own Slack app, no. See [`docs/app-users-and-arcade-accounts.md`](./docs/app-users-and-arcade-accounts.md).
   - The shortcut is `bun run users seed-demo`, which adds the whole demo cast (Alice, Bob, Charlie and Michael) with the demo's roles and clearances. It asks for each person's email, or takes them as `--alice <email>`, `--bob`, `--charlie` and `--michael`, and prints each generated password once. The same Slack and Arcade rules apply to the emails you give it.
   - `bun run users list` shows who can sign in, with their roles and clearances.
8. **Run the agent and ask it**
   - Open `https://<APP_PUBLIC_HOST>`, not localhost, and sign in as Alice once, with the email and password from step 7, to check the sign-in works. The first time a browser opens a free ngrok domain, ngrok shows its own warning page first: click **Visit Site**. Arcade's own calls to the app never see that page.
   - Run `cd agent && cp .env.example .env` and fill it in: your LangSmith key, and four values `setup-arcade` already wrote to the root `.env` (the Arcade key, the gateway id, and the web client's id and secret), plus `https://<APP_PUBLIC_HOST>` as the issuer. Then run `uv sync`.
   - Run `uv run mda dev .` to serve the agent locally. In another terminal, in `agent`, run `uv run --env-file .env python ask.py "Which loan applications are pending?"`. It opens the app's sign-in in your browser; sign in as Alice and it sends the question with her ID token. The agent verifies that token against the app's keys and calls every tool as her.
   - With no model configured the agent is scripted: it selects the loan desk's search tool, calls `LoanDesk_SearchLoans` and returns what it found, which proves the sign-in, the gateway and the hooks end to end without a model key. The first loan desk call asks you to authorize the app's own provider: the transcript prints the link, open it, allow it, and ask again.
   - For the real conversation, give it a model (`agent/README.md` says how) and ask: "Approve the loan for $95K and double-check your work so you don't make any mistakes." The agent finds `LN-2291` (Northwind Bakery LLC, $95,000), calls `LoanDesk_ApproveLoan`, and the transcript shows the hook's own words: "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. To proceed, call LoanDesk_RequestApproval…", ending in a `[ref evt_…]` token that joins it to the audit row. The loan stays pending.
   - `uv run mda deploy .` puts the same agent on Managed Deep Agents; point `ask.py` at it with `--agent <deployment URL>`.

## Try it out

- **With your own users or the demo cast.** Alice is the loan officer and Charlie the approver you added in step 7. Bob, a credit analyst, has a step of his own, and Michael, a chief credit officer, is the approver the routing passes over. `bun run users seed-demo` adds both, or add them yourself: `bun run users add <email> --name Bob --role credit_analyst`, which needs no clearance because Bob cannot see the approval tool, and `bun run users add <email> --name Michael --role chief_credit_officer --clearance 5000000`.
- **Let the escalation reach Charlie.** After the refusal, the agent calls `LoanDesk_RequestApproval` because the hook's refusal told it to; nothing in the system prompt mentions escalating. The first time, the transcript carries a link to authorize Slack through Arcade's built-in Slack integration, with no Slack app or token of your own. Routing is deterministic: the lowest clearance that covers the amount, with the requester excluded, so $95K goes to Charlie ($250K), and Michael ($5M), if you added him, is recorded as a candidate and deliberately not bothered. Charlie gets a Slack DM from Alice's own account, with a link to the approval page. The link carries no authority. Then the agent ends its turn and tells Alice who the request went to.
- **Try to approve your own request.** Before Charlie answers, open the approval link as Alice and press Approve. The control plane refuses it (`pre.decide-not-by-the-requester`), because possession of the link is not permission, and the request stays pending.
- **Approve as Charlie and watch the retry pass.** In a separate browser profile, sign in as Charlie, use **Authorize the gateway** to accept Arcade's consent screen once, open the link and press Approve. That press is itself a governed tool call, which `/hooks/pre` checks for Charlie's clearance and for a requester who is not the approver. Ask Alice's agent again, it retries, and this time `LoanDesk_ApproveLoan` is allowed by the same rule that denied it, citing a single-use grant. A second retry is denied again.
- **Send the same prompt as Bob.** Run `ask.py` again, sign in as Bob, the credit analyst with no approval authority, and send the prompt from the Quickstart. `ApproveLoan` never reaches his agent: the access hook removes it from the tool list, so there is nothing to refuse and the agent has no way to approve the loan.
- **Ask for what the model should not see.** As Alice, ask "Read loan LN-2291 and quote its bank account number and tax ID back to me." Both come back as `[REDACTED]`, because the post-execution hook masks them before the output reaches the model. As Charlie or Michael, they come through. For everyone, the instruction someone pasted into the loan's underwriter notes is stripped before the model reads it. Open `https://<APP_PUBLIC_HOST>/panel` alongside to watch each decision land in the Access, Pre and Post lanes.
- **Send the follow-up.** Ask Alice's agent to email the borrower the outcome, or to tell the team in Slack. Gmail and Slack are Arcade's own tools on the same gateway, so the same hooks see those calls, and each asks Alice to authorize her own account the first time.
## Customization

- Open the project in your coding agent and describe what you want to change. For example: "Replace the loan book with our equipment-lease approvals. Keep `packages/` and the control plane as they are, replace `api/`, `mcp/loan_desk/loans.py` and the seed fixtures, and keep `app-test/loans/knows-nothing-about-governance.test.ts` passing. Explore the code and propose a plan before making changes."
- Change who can approve what with `bun run users`: `set-clearance <email> <n>` sets a person's approval limit and `set-role <email> <role>` their role, `add` and `remove` bring people in and take them out, and `list` shows everyone. The running app sees each change within one poll, with no restart and no reset, and every change is recorded in `governance.db`'s `subject_changes`. A role has to be one the policy knows, and `bun run users` names those when it refuses one.
- Change the rules in `gate/policies/governance.json`: each rule matches a toolkit and a PascalCase tool name such as `ApproveLoan`. The fixture seeds `governance.db` once, so after editing it set `RESET_TOKEN` in `.env`, restart `bun run dev` and run `bun run reset`. Until you do, `/health` reports `fixture_drift`. A reset leaves the people you added under addresses of your own as they are, roles and clearances included.

## Further reading

The internals live in `docs/`, one page per question:

- [`docs/architecture.md`](./docs/architecture.md): how the four control points work, the two OAuth hops and which mechanism answers each, and what lives where in the repo.
- [`docs/configuration.md`](./docs/configuration.md): what `/health` reports, which Arcade project `setup-arcade` writes to, the port, rotating the identity secret, and what `bun run reset` puts back and what it keeps.
- [`docs/faq.md`](./docs/faq.md): why the limits live in hooks, why the Slack DM comes from Alice, why Bun, using another model, and what we measured against a real Arcade project.
- [`docs/deploying.md`](./docs/deploying.md): hosting the image instead of running it on your machine behind ngrok.
- [`docs/app-users-and-arcade-accounts.md`](./docs/app-users-and-arcade-accounts.md): who needs an Arcade account, for each of the two Slack routes.
- [`mcp/`](./mcp/loan_desk/app.py): the one MCP server, one `arcade deploy`, every tool under the `LoanDesk` toolkit: `loans.py` and `approvals.py`.
- [`gate/README.md`](./gate/README.md): the policies and the webhook service that enforces them, started by `bun run gate`, nothing hosted.
- [`agent/README.md`](./agent/README.md): the Deep Agent itself, how it signs callers in, which model it runs, and how to deploy it.
- [`docs/agent.md`](./docs/agent.md): how the agent and Arcade fit together: who the caller is, how tools are selected, and what happens when a tool needs authorizing.
- [`auth-config/`](./auth-config/README.md): everything registered at Arcade, one copy-paste JSON body each: the User Source, the gateway, the custom `app-identity` provider for the loan API, the custom verifier and the hooks. `setup-arcade` sends the same bodies, and a test keeps them equal.
- [`api/`](./api/server.ts): the loan REST API, the bank's system of record, served under `/bank`.
- [`docs/modules/01-build.md`](./docs/modules/01-build.md): the workshop, paced by tags. `start` for modules 1 and 2, `capstone` for the finish; each module page says what you build, what to look at, and where to pick up if you are behind.
- [`app/walkthrough/page.tsx`](./app/walkthrough/page.tsx): `/walkthrough`, the four acts as five diagrams from Arcade's outreach library with one line each, for the livestream and the recap.
- [`docs/DOMAIN-SWAP.md`](./docs/DOMAIN-SWAP.md) walks through pointing the template at your own business system.
- [`docs/control-plane.md`](./docs/control-plane.md) is the control plane's own reference: the hooks, `governance.db`, drift and reset, the live stream and the audit log.
- [`DESIGN.md`](./DESIGN.md) is the authoritative record: architecture, contracts, and the reasoning behind each decision.
