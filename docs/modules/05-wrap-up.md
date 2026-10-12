# Q&A and wrap-up

**12:30 to 1:00. Joint.** The whole story once more, end to end, and what you take home.

Run it on your own build, from `ask.py`, as Alice:

> Approve the loan for Northwind at $95K and double-check your work.

Watch the panel. Access hid a tool from Bob earlier; pre refuses Alice and routes to
Charlie; post masks the identifiers and strips the note. Once Charlie approves and the
retry lands, the agent emails the borrower the outcome from Alice's own Gmail, under the same
hooks. Then edit one rule on stage, with `bun run users set-clearance` or an
`UPDATE output_rules` in `governance.db`, and run the prompt again.

## What you take home

- The code base: this repository, with `start` checked out and your Arcade project and Okta org
  registered against it.
- The agent: deployed on Managed Deep Agents, with its traces in your LangSmith workspace.
- The MCP server: `mcp/loan_desk/`, deployed to your Arcade project, and the optional gateway
  in front of it from [`03-govern.md`](./03-govern.md#take-it-home-the-same-governance-from-an-mcp-client).

## Fork it

[`docs/DOMAIN-SWAP.md`](../DOMAIN-SWAP.md) is the walk from this loan desk to your own system of
record. Replace `api`, `mcp/loan_desk/loans.py` and the seed fixtures; keep `packages/` and the
control plane; keep the test that fails if the business system learns the word "policy".

## The tags, for later

| tag | state |
|---|---|
| `start` | The Deep Agent and the control plane. Every block runs here. |
| `capstone` | Plus these docs and `/walkthrough`. |

The tags still point at the Mastra template's commits; they are re-cut on this repository
before the workshop.
