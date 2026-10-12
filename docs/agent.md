# The agent and Arcade

The agent in `agent/` is LangChain's half of this repository, and everything else is Arcade's.
This page is the seam between them: what crosses it on every question, and what each side
owns. [`agent/README.md`](../agent/README.md) has the commands.

## One question, end to end

1. **The caller signs in to the app.** `ask.py` runs an OAuth authorization-code flow with
   PKCE against Okta, the app's identity provider, as the app's Okta client, and gets an ID
   token for Alice.
2. **MDA checks the token.** `agent/identity.py` accepts only a token `IDP_ISSUER` signed, for
   the app's client id as audience. The `email` claim becomes the run's principal.
3. **The agent selects its tools.** The model sees one tool, `arcade_select_tools`. It
   describes the task, and Arcade answers with the tools that fit. There is no gateway, so
   the search is not scoped to the loan desk: it may return an unrelated catalog tool, such
   as Ashby or ClickUp. The chosen tools are promoted under their own names, such as
   `LoanDesk_SearchLoans`, and the model calls them directly.
4. **Every call carries the caller.** The middleware executes each tool through Arcade's
   Engine, with the project key and the principal's email as the user id. Arcade runs the contextual access hooks on it,
   so `/hooks/pre` decides on Alice's authority, and `/hooks/post` redacts what Alice may not
   see before the model reads it. That holds for every tool, the unrelated ones included:
   the hooks govern the call, not the search that found it.
5. **The answer goes back to the terminal.** `ask.py` prints each call, each result and the
   answer.

## What each side owns

- **The agent** owns the conversation: the model, the instructions, which tools to look for.
  It holds no limits and decides nothing about authority. A refusal reaches it as a tool
  result, in the hook's own words.
- **Arcade** owns the tools and who may call them: the catalog, the authorization each
  provider needs, and the hooks on every call.
- **The app** owns identity and policy: the people, their roles and clearances, the rules in
  `gate/policies/governance.json`, the approvals, and the audit on `/panel`.

## The nine tools the demo uses

The six loan desk tools from the one `arcade deploy` (`SearchLoans`, `GetLoan`,
`ApproveLoan`, `DenyLoan`, `RequestApproval`, `Decide`), and Arcade's own
`Gmail.SendEmail`, `Gmail.ListEmails` and `Slack.SendMessage`. Nothing narrows the agent to
these: with no gateway, Tool Rec searches the project's whole catalog. The policy in
`gate/policies/governance.json` is what decides which tools each caller sees and runs.

## When a tool needs authorizing

The loan desk tools need the app's own `app-identity` provider, and Gmail and Slack need
the caller's own Google and Slack accounts. The first call to each returns an authorization
link instead of a result. The middleware hands it back as the tool's result, so the model
reads it, passes it on, and `ask.py` prints it. The caller opens it, allows it, and asks
again. The agent never holds a provider token; Arcade does, keyed on the caller's email.

## What the agent does not do

- **It does not resume after an approval.** Charlie's approval is recorded by the control
  plane and turned into a single-use grant. Alice asks again and the retry passes. Nothing
  pushes the result back into her run.
- **It does not remember across runs.** No `memory.py`, so no durable memory. Each
  `ask.py` question is a new thread.
- **It has no sandbox.** It reads and writes through tools only.
