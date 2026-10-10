# How the template works

The internals behind the [Quickstart](../README.md#quickstart-): the four control points Arcade gives every tool call, the two places Arcade establishes who you are, and where each part lives in the repo.

## How the controls work

Arcade gives every tool call four control points, each keyed on the signed-in person. The model sits inside all of them:

| # | Layer | Keyed on | Mechanism |
|---|---|---|---|
| 1 | Whether you can see the tool | identity | `/hooks/access` → `deny` list |
| 2 | Whether you hold the credential to call it at all | identity | per-tool auth requirement, OAuth scopes |
| 3 | Whether you have the authority for *this* call | identity + policy | `/hooks/pre` → `CHECK_FAILED` |
| 4 | What comes back | policy | `/hooks/post` → `override.output` |

Layers 1, 3 and 4 are HTTP endpoints this app serves under `/hooks`, and Arcade calls them. Layer 2 is Arcade's own.

**Layer 2 is invisible to the control plane, and that constrains what you can stage.** Arcade evaluates auth requirements before `/hooks/pre`, so a refusal there fires no hook, writes no audit row and shows nothing on the panel. If something you expected to see is missing, check the OAuth registration before you suspect the control plane.

**Two spellings of one tool name, and they are not interchangeable.** MCP advertises `LoanDesk_GetLoan`, which is what the model can call. Hook payloads, audit rows and policy rules use `LoanDesk.GetLoan`. Key rules the dot way, and write the underscore spelling in any text addressed to the model, such as a denial's remediation sentence. A rule keyed on `get_loan` matches nothing, and a rule that matches nothing is indistinguishable from a rule that permits.

Two claims are enforced by tests rather than asserted:

- **The business system does not know it is governed.** `app-test/loans/knows-nothing-about-governance.test.ts` fails if governance vocabulary (`policy`, `role`, `limit`, `redact`, `authority`, `approver`, `permission`) appears in `api/`, or if it imports a `@cg/*` package. The pull to add "just one guard" there is real, and that test is the thing that says no.
- **`gate/engine` depends on no app.** `gate/engine/test/no-app-dependencies.test.ts` fails if it declares a dependency on an app package or imports from one.

A control that silently does nothing is worse than no control. Every identifier in the policy is measured off a real deployment rather than derived, and every `/hooks/post` pattern is proved to fire against a corpus.

## Two OAuth hops, two mechanisms

Conflating them cost a day. The full diagram is in [`DESIGN.md`](../DESIGN.md#identity-and-oauth).

| | hop | mechanism |
|---|---|---|
| **1** | the agent → Arcade's Engine | the **project API key**, with the caller's email as `user_id`, which the agent takes from the Okta ID token it verified. No gateway, no User Source |
| **2** | tool → the loan API | the `app-identity` auth provider, plus a **custom user verifier** route in the app, `/api/arcade/verify` |
| **2** | `LoanDesk_RequestApproval` → Slack | Arcade's stock Slack provider, which goes through **Arcade's own verifier**: the requester must be a member of the Arcade project |

Neither mechanism moves the other. Arcade's default verifier demands an Arcade account that is a project member. For the loan tools your users need none, because the custom verifier binds the grant to the signed-in person; without it, a user verified against the wrong account binds the grant to the wrong user and the tool re-challenges forever. The custom verifier covers custom providers only. Arcade sends its built-in providers, Slack among them, through its own verifier, so anyone who requests an approval must be invited to the Arcade project under their email. `bun run setup-arcade` sets the custom verifier and reads it back through the admin API, which is the check to trust rather than a dashboard label.

**Email is the join key.** Arcade's `user_id`, the OAuth subject and the actor the loan module records are the same string, lowercase. If they diverge, `governance.db` and `loans.db` describe different people and the audit trail is fiction. The loan module takes the actor from the token, never from a request parameter, because an actor passed as an argument is an actor the model can forge.

## Project layout

One TypeScript app at the repo root (Next.js, running on Bun), one Python MCP server and one Python agent:

```
agent/                     The LangChain Deep Agent, on Managed Deep Agents. It calls Arcade's Engine
                           directly with the project key; it holds no limits. agent/README.md and docs/agent.md.
gate/service/              /hooks/access, /hooks/pre, /hooks/post: the policy engine, audit log and event
                           stream. Owns governance.db. The policies are gate/policies/governance.json.
                           `bun run gate` starts it (with the rest of the app) and prints the rules.
api/                       The loan REST API, the bank's system of record, served under /bank.
                           Owns loans.db. No MCP, no Arcade, no governance.
auth/                      Sign-in as an OIDC client of Okta (IDP_ISSUER, by discovery), sessions
                           and the custom verifier. No identity provider of its own.
auth-config/               What to register at Arcade, one copy-paste JSON body each, as
                           setup-arcade sends it.
app/                       The pages: the bank at /, the loan board at /loans, the panel at /panel,
                           approval pages at /approvals/<id>, readiness at /health.

mcp/                       One arcade-mcp server, one toolkit (LoanDesk), one `arcade deploy`:
  loan_desk/loans.py         SearchLoans, GetLoan, ApproveLoan, DenyLoan.
                             A stateless client of /bank, via APP_PUBLIC_HOST.
  loan_desk/approvals.py     RequestApproval, Decide (+ approvals_*.py helpers).

gate/engine                Hook framework, policy engine, audit, event bus. No loan references.
gate/schema                Shared zod types for policy, events and hook payloads.
```

`api/` is not an MCP server on purpose. Banks have APIs, not MCP servers, and keeping the tool layer in `mcp/loan_desk/loans.py` means pointing a thin toolkit at an API you already have. The toolkits are Python because `arcade-mcp`, the tool-authoring framework, is Python-only. The agent is Python because Managed Deep Agents and Arcade's LangChain middleware are. Nothing else in the repo is Python.

The toolkits have their own READMEs: [`mcp/loan_desk/loans.py`](../mcp/LOANS.md) and [`mcp/loan_desk/approvals.py`](../mcp/APPROVALS.md).
