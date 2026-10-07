# Capstone — All four acts, end to end

**Start from:** `git checkout capstone`. **20 minutes, then show and tell.**

Run the whole story on your own build, end to end, from `ask.py`:

> Approve the loan for Northwind at $95K and double-check your work.

Watch the panel. Access hid a tool from Bob earlier; pre refuses Alice and routes to
Charlie; post masks the identifiers and strips the note. Then ask Alice's agent to email
the borrower the outcome, through Gmail on the same gateway and under the same hooks. Then edit one rule on stage — `bun run users set-clearance`, or an
`UPDATE output_rules` in `governance.db` — and run the prompt again.

## Fork it

`docs/DOMAIN-SWAP.md` is the walk from this loan desk to your own system of record. Replace
`api`, `mcp/loan_desk/loans.py` and the seed fixtures; keep `packages/` and the control plane;
keep the test that fails if the business system learns the word "policy".

## The tags, for later

| tag | state |
|---|---|
| `start` | The Deep Agent, the gateway and the control plane. Modules 1 and 2 run here. |
| `capstone` | Plus these docs and `/walkthrough`. |

The tags still point at the Mastra template's commits; they are re-cut on this repository
before the workshop.
