# Observing, evaluating, and taking agents to production with LangSmith

**11:30 to 12:30. Owner: LangChain.** Tracing, dashboards, online evals, user feedback and
insights, on the runs you just made.

LangChain owns this block's content and slides. What this repo gives it is a deployment with
real traces on it: every run since the deploy in [`01-build.md`](./01-build.md) went through the agent
you deployed with `mda deploy`, and every governed tool call in it has a matching audit row.

## What you have to look at

- **One run, two records.** Open the Act 2 trace in LangSmith. The `LoanDesk_ApproveLoan` tool
  call's result is the hook's own sentence, ending in `[ref evt_…]`. The same reference is on
  the card at `/panel` and in `governance.db`'s audit log. The trace says what the model did;
  the audit row says what it was allowed to do.
- **Bob's run has no approval call to trace.** The access hook removed the tool before the
  model ran, so the trace shows a tool list without it, not a refusal.
- **Act 3's trace never held the account number.** Redaction ran in `/hooks/post`, before the
  output reached the model, so `[REDACTED]` is what the trace stores too.

## What LangChain walks through

Tracing and the trace view, dashboards, online evaluators over production runs, user feedback,
and insights, each on the loan desk deployment. The slides are LangChain's.

## Checkpoint

You can point at one tool call in a LangSmith trace and at its audit row on `/panel`, and say
which of the two decided it.
