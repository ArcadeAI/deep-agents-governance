# Module 2 — Govern every tool call (Arcade)

**Start from:** `git checkout start`, with module 1 done. **Owner:** Arcade. **45 minutes.**

You leave with the four acts running on your own build: a loan officer asks for a
$95K loan and "double-check your work", four things go wrong, and the control plane
catches all four while the model never gets a vote. Give the agent a real model first: set
`MODEL_ID` and the room's model key in `agent/.env` (`agent/README.md`), and restart `mda dev`.

## What you build

1. Add the rest of the cast: Bob the credit analyst with no clearance, Charlie the VP Credit at $250,000,
   Michael the chief credit officer at $5,000,000:

       bun run users seed-demo --alice <your-email> --charlie <the approver email the host announces> --bob bob@example.com --michael michael@example.com

   Charlie's email is the one thing that has to be real: the escalation finds the approver in
   Slack by it. In the room, everyone's Charlie is the host's address, so every DM lands with
   the host and every request is posted in `#deal-desk-approvals`. Approving is still yours:
   Charlie signs in to *your* app at your Okta org, with the password the seed printed, in a second browser
   profile. Nobody else's Charlie is involved.
2. Confirm the hooks are on: `/hooks/health` reports `status: healthy` and `setup-arcade`
   printed *hooks: … status active (read back)*. Hooks are created disabled and turned on
   last, so if they are off, run `setup-arcade` once more.
3. Run the four acts, in the words `README.md` → Try it out uses:
   - **Act 1.** Run `ask.py`, sign in as Bob and ask for the approval. `LoanDesk_ApproveLoan` is not in his
     tool list. Nothing was refused; the tool was never offered.
   - **Act 2.** As Alice: *"Approve the loan for Northwind at $95K and double-check your
     work."* `/hooks/pre` refuses, the denial names `LoanDesk_RequestApproval`, the agent
     calls it, Charlie gets a Slack DM from Alice's own account and the request appears in
     `#deal-desk-approvals` with the link and no buttons, Alice's turn ends. Charlie approves
     on the signed-in page; Alice asks again and her retry passes on a single-use grant.
   - **Act 3.** As Alice: *"Read LN-2291 and quote its bank account number and tax ID."* Both
     come back `[REDACTED]`. As Charlie they come through.
   - **Act 4.** Any read of LN-2291 strips the pasted instruction from `underwriter_notes` before the
     model sees it, for everyone. `INJECTION_DETECTION=off` shows what was prevented.
4. Edit a rule live. Raise Alice's clearance with `bun run users set-clearance` and watch the
   same prompt pass within one policy poll, with no restart.

## What to look at

- `gate/policies/governance.json`: every rule, keyed on `Toolkit.Tool` with
  the model-facing sentence in `Toolkit_Tool` spelling. The catalogue is a closed world.
- `gate/engine/src/policy-engine.ts` and `redaction-engine.ts`: pure, no
  domain words, the same engine for every act.
- `/panel`: one card per hook decision, with the audit row's reference on it.

## Checkpoint

All four acts on your own deployment, and one rule edited live.

## If you are behind

Still `git checkout start`. Module 2 is Arcade state, not code: users, hooks on, Slack.
`bun run reset` puts the loan book and the control plane back between attempts.
