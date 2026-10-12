# gate/ — the contextual-access policies, and the service that enforces them

One command starts it:

    bun run gate

That prints every rule the service will enforce, then starts the app, which the
service is a module of (`gate/service/`, mounted at `/hooks/access`, `/hooks/pre` and
`/hooks/post`). Arcade calls those three URLs on every tool call in the project,
and what they answer is decided here, by code in this repo, against rows in a SQLite
file on your disk. There is no hosted policy store and nothing to sign up for.

| | |
|---|---|
| `policies/governance.json` | The workshop's three policies, and the demo cast. Read once, when `governance.db` has no schema; after that the rows in the database are the policy. |
| `service/approval-guards.json` | The approval's own guards and the injected-instruction strip. Seeded with the policies; not something the workshop edits. |
| `service/` | The webhook service: policy cache, the three handlers, the audit log, the event stream the panel watches, the approvals store. |
| `engine/` | `@cg/governance-core`: the policy compiler and evaluator, redaction, audit. Knows nothing about loans. |
| `schema/` | `@cg/policy-schema`: the zod types for rules, hook payloads and events, shared by the service, the tools' tests and the panel. |

## The three policies

`policies/governance.json` holds exactly three rules, one per hook, keyed on `$TOOLKIT`, which
`ARCADE_TOOLKIT` fills in (`LoanDesk`):

1. **`/hooks/access` — `access.analysts-cannot-see-approve`.** A credit analyst does not see
   `ApproveLoan` in the tool list at all. A tool that is not offered cannot be called,
   and the model never has to be told not to.
2. **`/hooks/pre` — `pre.approve-within-clearance`.** A loan officer with $50K of
   authority asking to approve $95K is refused before the call runs, and the refusal tells
   the model what to do instead: `LoanDesk_RequestApproval`. That is act 2.
3. **`/hooks/post` — `post.redact-borrower-identifiers`.** The bank account number and tax
   id come out of every loan file before the model reads it, for anyone with less than
   $250K of clearance, so Alice and Bob never read them and Charlie does. The tool ran either way.

The service seeds five more from `service/approval-guards.json`. Four `pre.decide-*` rules
decide who may answer an approval request: never the requester, only within clearance, only
while it is pending. `post.strip-injected-instructions` takes a planted instruction out of a
loan file before the model reads it. `bun run gate` lists all eight, the three first.

## Editing a rule live

`governance.db` is the policy once seeded. Edit a row and the cache picks it up within
`POLICY_POLL_MS`; a rule that no longer compiles takes the whole policy down and every
hook fails closed, loudly, which is the point (DESIGN.md → fail closed). `bun run reset`
puts the seed back. The panel at `/panel` shows every decision as it is made.
