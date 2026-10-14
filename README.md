# Deep Agents Loan Desk with Arcade

A loan officer asks a LangChain Deep Agent, in plain language, to approve a $95K loan for a second bakery location. The agent searches the loan book, reads the request and calls the approval tool as her. Arcade sends that call to this app's control plane before it runs, and the control plane refuses it: $95K is over her $50K approval authority. The refusal tells the agent how to escalate, the request reaches the one approver with enough authority in Slack, and once he approves, her retry goes through and the agent emails the borrower the outcome from her own Gmail. You get a decision the model could not talk its way around, with an audit row for every step on a live panel.

The agent runs on LangChain's Managed Deep Agents and calls Arcade's Engine directly, with the project API key and the signed-in person's email, with no MCP gateway in between. Its tools are the loan desk's own MCP server, backed by the loan REST API in `api/`, and Arcade's built-in Gmail and Slack. Arcade's tool recommendations are not scoped to those, so it may suggest an unrelated catalog tool, and the hooks govern every call whichever tool it is. The wire and the screen are the loan desk's: `LoanDesk_ApproveLoan`, `LN-2291`, loan officer, credit analyst, VP Credit, chief credit officer.

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
  3. Use the default project Arcade made when you signed up. There is no CLI or API to create a project, and you do not need one: `arcade login` already makes the default project the CLI's active one. (Using another project instead: `arcade project set <project_id>`, with the id `arcade project list` shows, after `arcade org set <org_id>` if you have more than one org.)
  4. Create an API key in that project and set `ARCADE_API_KEY` to it ([Get an API key](https://docs.arcade.dev/en/get-started/setup/api-keys), or the dashboard's [API keys](https://api.arcade.dev/dashboard/api-keys) page). This is the one dashboard step.
  5. Check it: `arcade whoami` shows that org and project.
- **An Okta org**: Okta is the identity provider. Everyone signs in to the app, the agent and Arcade with their Okta login, and `bun run users` creates each person there. Okta's free Integrator plan works, and so does a Workforce Identity trial. The one thing you make by hand is an API token: in the org's Admin Console, under Security → API → Tokens, create one as a Super Administrator and keep it in 1Password, never in `.env`. `bun run okta-setup` makes everything else in step 3. [`docs/okta.md`](./docs/okta.md) walks through the org, and the same setup in the Admin Console if you would rather click.
- **[ngrok domain](https://ngrok.com/docs/universal-gateway/domains/)**: set `APP_PUBLIC_HOST` to your ngrok domain in host form, with no scheme (for example `my-app.ngrok.app`). Arcade Cloud calls the hooks, the loan API and the custom verifier on this host, and the agent checks who is calling against this host's keys. Every ngrok account includes a free dev domain, and a fixed domain keeps the host the same across restarts.
- **A LangSmith workspace with Managed Deep Agents**: the agent in `agent/` runs on [Managed Deep Agents](https://docs.langchain.com/langsmith/managed-deep-agents), which is in beta, so the workspace needs beta access and an API key. You also need [`uv`](https://docs.astral.sh/uv/). The agent runs with a scripted model and no model key until you give it a real one ([`agent/README.md`](./agent/README.md)).
- **A Slack workspace with two accounts in it**: one for you, the loan officer who asks for the approval, and one for the approver. The request reaches the approver as a Slack DM sent from your own account, and it finds the approver by the email you add them under, so that email has to be the one their Slack account uses. With Arcade's built-in Slack app, each loan officer also has to be a member of your Arcade project; with your own Slack app, your app's users need no Arcade account ([`docs/app-users-and-arcade-accounts.md`](./docs/app-users-and-arcade-accounts.md)).
- `ARCADE_API_KEY` and `APP_PUBLIC_HOST` are the only values you fill in for the app. The second block of `.env.example` is written by `bun run okta-setup` and the third by `bun run setup-arcade`, so leave both blank, and the fourth block is optional, with defaults that work. The agent has its own `agent/.env.example`, filled from the same values in step 7. No user is seeded and no password ships: you add the people in step 6 of the Quickstart.

## Quickstart 🚀

1. **Clone the repository**
   - Run `git clone <this repository's URL> deep-agents-loan-desk`, then `cd deep-agents-loan-desk`.
2. **Install dependencies**
   - Run `bun install`. One install covers the app and its workspaces. The agent installs separately, with `uv`, in step 7.
3. **Add your API keys**
   - Run `cp .env.example .env` and fill in the two values described under Prerequisites.
   - Set up Okta with your API token from 1Password: `OKTA_ORG_URL=https://<org>.okta.com OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run -- bun run okta-setup`. It makes the app's one OIDC Web app in your org with its redirect URIs, assigns it to Everyone, lets it have tokens from the `default` authorization server, and writes `OKTA_ORG_URL`, `IDP_ISSUER`, `IDP_CLIENT_ID` and `IDP_CLIENT_SECRET` to `.env`. It prints the client id and never the secret. Run it again, and it changes nothing.
4. **Register the app with Arcade**
   - Run `bun run setup-arcade <APP_PUBLIC_HOST> --dry-run` to print every request it would send and every deploy it would run, with every secret as a placeholder. Nothing is written, sent or deployed.
   - Run `bun run setup-arcade <APP_PUBLIC_HOST>`. It checks that `ARCADE_API_KEY` belongs to the Arcade CLI's active project before it writes anything. Then it fills the third block of `.env` (blanks only, never overwriting), and registers the `app-identity` auth provider, which signs in through your Okta app, the two tool secrets, the custom verifier and the contextual access hooks through Arcade's API, with the hooks on. It reads each one back. Then it runs `arcade deploy` once, in `mcp`, which carries the Loans and Approvals tools. Run it again, and it says everything is already in place.
   - The agent needs no User Source and no MCP gateway: it calls the Engine directly with the project key, and the hooks see every call in the project. To reach the same tools from Claude Code or another MCP client, add `--gateway`: it also registers a User Source for your Okta app and an MCP gateway through it, and writes the gateway's slug to `.env` as `ARCADE_GATEWAY_ID`. [`docs/modules/03-govern.md`](./docs/modules/03-govern.md#take-it-home-the-same-governance-from-an-mcp-client) is that path, and the agent ignores the variable.
   - If Arcade cannot reach the app's hooks health check when it registers them, it says so: start the app and the tunnel as in step 5, then run it again.
5. **Start the app and the tunnel**
   - In one terminal, run `bun run dev`. It prints the URL to use, `https://<APP_PUBLIC_HOST>`, and the ngrok command for the app's port, which is `PORT` from `.env`, 3000 when unset.
   - In a second terminal, run the ngrok command `bun run dev` printed. With the default `PORT` it is `ngrok http --url=<APP_PUBLIC_HOST> 3000`; with any other `PORT`, the tunnel has to point at that port instead. `bun run up` is the same two in one terminal: it starts the app and the tunnel together and stops both on Ctrl-C.
6. **Add yourself and an approver**

   - First run the `bun run okta-setup` command from step 3 once more. `setup-arcade` wrote the callback Arcade made for the `app-identity` provider to `.env` as `ARCADE_PROVIDER_CALLBACK`, and this run adds it to the Okta app's redirect URIs. Until it does, authorizing the loan desk's own provider stops at Okta with a redirect URI error.
   - Add yourself as the loan officer: `bun run users add <your-email> --name Alice --role loan_officer --clearance 50000`. Any name works, but the rest of this README calls the loan officer Alice and the approver Charlie.
   - Add the approver: `bun run users add <approver-email> --name Charlie --role vp_credit --clearance 250000`. Use the email the approver's Slack account uses, because that is how the escalation finds them in Slack.
   - `bun run users` creates each person in Okta, so it needs the API token the same way: put `OKTA_API_TOKEN="op://<vault>/<item>/<field>" op run --` in front of `add`, `remove` and `seed-demo`. The roles and clearances stay in the app's `governance.db`.
   - Each `add` prints a generated password once, and Okta keeps only its hash, so keep it: that password and the email are the sign-in. A password of your own goes in with `--password`, and has to meet Okta's default policy: 8 characters or more, with a lowercase letter, an uppercase letter and a number, and no part of the email. Someone already in your org keeps the password they have. Nothing needs a restart, because the running app reads new people on their next sign-in.
   - Do your app's users need Arcade accounts? With Arcade's built-in Slack app, yes: invite each loan officer to your Arcade project's Members. With your own Slack app, no. See [`docs/app-users-and-arcade-accounts.md`](./docs/app-users-and-arcade-accounts.md).
   - The shortcut is `bun run users seed-demo`, which adds the whole demo cast (Alice, Bob, Charlie and Michael) with the demo's roles and clearances. It asks for each person's email, or takes them as `--alice <email>`, `--bob`, `--charlie` and `--michael`, and prints each generated password once. The same Slack and Arcade rules apply to the emails you give it.
   - `bun run users list` shows who can sign in, with their roles and clearances.
7. **Run the agent and ask it**
   - Open `https://<APP_PUBLIC_HOST>`, not localhost, and sign in as Alice once, at Okta, with the email and password from step 6, to check the sign-in works. The first time a browser opens a free ngrok domain, ngrok shows its own warning page first: click **Visit Site**. Arcade's own calls to the app never see that page.
   - Run `cd agent && cp .env.example .env` and fill it in: your LangSmith key, and four values the setup commands already wrote to the root `.env`: the Arcade key and the Okta issuer, client id and secret. Then run `uv sync`.
   - Run `uv run mda dev .` to serve the agent locally. In another terminal, in `agent`, run `uv run --env-file .env python ask.py "Which loan applications are pending?"`. It opens Okta's sign-in in your browser; sign in as Alice and it sends the question with her ID token. The agent verifies that token against Okta's keys and calls every tool as her. When several people share Alice's sign-in, `ask.py --as <your email>` keeps the loan desk as Alice and runs Gmail and Slack as you (`docs/modules/02-connect.md`).
   - With no model configured the agent is scripted: it selects the loan desk's search tool, calls `LoanDesk_SearchLoans` and returns what it found, which proves the sign-in, the direct Engine call and the hooks end to end without a model key. The first loan desk call asks you to authorize the app's own provider: the transcript prints the link, open it, allow it, and ask again.
   - For the real conversation, give it a model (`agent/README.md` says how) and ask: "Approve the loan for $95K and double-check your work so you don't make any mistakes." The agent finds `LN-2291` (Northwind Bakery LLC, $95,000), calls `LoanDesk_ApproveLoan`, and the transcript shows the hook's own words: "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. To proceed, call LoanDesk_RequestApproval…", ending in a `[ref evt_…]` token that joins it to the audit row. The loan stays pending.
   - `uv run mda deploy .` puts the same agent on Managed Deep Agents; point `ask.py` at it with `--agent <deployment URL>`.

## Try it out

- **With your own users or the demo cast.** Alice is the loan officer and Charlie the approver you added in step 6. Bob, a credit analyst, has a step of his own, and Michael, a chief credit officer, is the approver the routing passes over. `bun run users seed-demo` adds both, or add them yourself: `bun run users add <email> --name Bob --role credit_analyst`, which needs no clearance because Bob cannot see the approval tool, and `bun run users add <email> --name Michael --role chief_credit_officer --clearance 5000000`.
- **Let the escalation reach Charlie.** After the refusal, the agent calls `LoanDesk_RequestApproval` because the hook's refusal told it to; nothing in the system prompt mentions escalating. The first time, the transcript carries a link to authorize Slack through Arcade's built-in Slack integration, with no Slack app or token of your own. Routing is deterministic: the lowest clearance that covers the amount, with the requester excluded, so $95K goes to Charlie ($250K), and Michael ($5M), if you added him, is recorded as a candidate and deliberately not bothered. Charlie gets a Slack DM from Alice's own account, with a link to the approval page. The link carries no authority. Then the agent ends its turn and tells Alice who the request went to.
- **Try to approve your own request.** Before Charlie answers, open the approval link as Alice and press Approve. The control plane refuses it (`pre.decide-not-by-the-requester`), because possession of the link is not permission, and the request stays pending.
- **Approve as Charlie and watch the retry pass.** In a separate browser profile, sign in as Charlie, open the link and press Approve. That press is itself a governed tool call, which `/hooks/pre` checks for Charlie's clearance and for a requester who is not the approver. Ask Alice's agent again, it retries, and this time `LoanDesk_ApproveLoan` is allowed by the same rule that denied it, citing a single-use grant. A second retry is denied again.
- **The borrower hears back.** Once the approval is recorded, the agent emails the outcome to the `contact_email` on the loan's record, through Arcade's own Gmail tool, so the same hooks see that call too. The first time, the transcript asks Alice to authorize her own Google account. The seeded addresses use the reserved `.example` domain, so nothing is delivered anywhere: the email shows up in Alice's Sent folder.
- **Send the same prompt as Bob.** Run `ask.py` again, sign in as Bob, the credit analyst with no approval authority, and send the prompt from the Quickstart. `ApproveLoan` never reaches his agent: the access hook removes it from the tool list, so there is nothing to refuse and the agent has no way to approve the loan.
- **Ask for what the model should not see.** As Alice, ask "Read loan LN-2291 and quote its bank account number and tax ID back to me." Both come back as `[REDACTED]`, because the post-execution hook masks them before the output reaches the model. As Charlie or Michael, they come through. For everyone, the instruction someone pasted into the loan's underwriter notes is stripped before the model reads it. Open `https://<APP_PUBLIC_HOST>/panel` alongside to watch each decision land in the Access, Pre and Post lanes.
- **Tell the team.** Ask Alice's agent to post the outcome in Slack. It is Arcade's own Slack tool, under the same hooks, sent as Alice.

## Customization

- Open the project in your coding agent and describe what you want to change. For example: "Replace the loan book with our equipment-lease approvals. Keep `packages/` and the control plane as they are, replace `api/`, `mcp/loan_desk/loans.py` and the seed fixtures, and keep `app-test/loans/knows-nothing-about-governance.test.ts` passing. Explore the code and propose a plan before making changes."
- Change who can approve what with `bun run users`: `set-clearance <email> <n>` sets a person's approval limit and `set-role <email> <role>` their role, `add` and `remove` bring people in and take them out, and `list` shows everyone. The running app sees each change within one poll, with no restart and no reset, and every change is recorded in `governance.db`'s `subject_changes`. A role has to be one the policy knows, and `bun run users` names those when it refuses one.
- Change the rules in `gate/policies/governance.json`: each rule matches a toolkit and a PascalCase tool name such as `ApproveLoan`. The fixture seeds `governance.db` once, so after editing it set `RESET_TOKEN` in `.env`, restart `bun run dev` and run `bun run reset`. Until you do, `/health` reports `fixture_drift`. A reset leaves the people you added under addresses of your own as they are, roles and clearances included.

## Further reading

The internals live in `docs/`, one page per question:

- [`docs/architecture.md`](./docs/architecture.md): how the four control points work, the two OAuth hops and which mechanism answers each, and what lives where in the repo.
- [`docs/configuration.md`](./docs/configuration.md): what `/health` reports, which Arcade project `setup-arcade` writes to, the port, rotating the session secret, and what `bun run reset` puts back and what it keeps.
- [`docs/faq.md`](./docs/faq.md): why the limits live in hooks, why the Slack DM comes from Alice, why Bun, using another model, and what we measured against a real Arcade project.
- [`docs/okta.md`](./docs/okta.md): creating the Okta org, what `bun run okta-setup` makes in it, the same setup in the Admin Console, and using another OIDC provider.
- [`docs/deploying.md`](./docs/deploying.md): hosting the image instead of running it on your machine behind ngrok.
- [`docs/app-users-and-arcade-accounts.md`](./docs/app-users-and-arcade-accounts.md): who needs an Arcade account, for each of the two Slack routes.
- [`mcp/`](./mcp/loan_desk/app.py): the one MCP server, one `arcade deploy`, every tool under the `LoanDesk` toolkit: `loans.py` and `approvals.py`.
- [`gate/README.md`](./gate/README.md): the policies and the webhook service that enforces them, started by `bun run gate`, nothing hosted.
- [`agent/README.md`](./agent/README.md): the Deep Agent itself, how it signs callers in, which model it runs, and how to deploy it.
- [`docs/agent.md`](./docs/agent.md): how the agent and Arcade fit together: who the caller is, how tools are selected, and what happens when a tool needs authorizing.
- [`auth-config/`](./auth-config/README.md): everything registered at Arcade, one copy-paste JSON body each: the custom `app-identity` provider for the loan API, the custom verifier and the hooks, and the optional User Source and gateway. `setup-arcade` sends the same bodies, and a test keeps them equal.
- [`api/`](./api/server.ts): the loan REST API, the bank's system of record, served under `/bank`.
- [`docs/modules/00-setup.md`](./docs/modules/00-setup.md): the workshop, one page per block of the agenda: setup, build (LangChain), connect and govern (Arcade), observe (LangChain), wrap-up. Every block runs on `start`; each page says what you build, what to look at, and where to pick up if you are behind.
- [`docs/modules/03-govern.md`](./docs/modules/03-govern.md#take-it-home-the-same-governance-from-an-mcp-client): optional. The same tools and the same hooks from Claude Code, through an MCP gateway `setup-arcade --gateway` registers.
- [`app/walkthrough/page.tsx`](./app/walkthrough/page.tsx): `/walkthrough`, the four acts as five diagrams from Arcade's outreach library with one line each, for the livestream and the recap.
- [`docs/DOMAIN-SWAP.md`](./docs/DOMAIN-SWAP.md) walks through pointing the template at your own business system.
- [`docs/control-plane.md`](./docs/control-plane.md) is the control plane's own reference: the hooks, `governance.db`, drift and reset, the live stream and the audit log.
- [`DESIGN.md`](./DESIGN.md) is the authoritative record: architecture, contracts, and the reasoning behind each decision.
