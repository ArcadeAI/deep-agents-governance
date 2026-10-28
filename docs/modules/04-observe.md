# Observe and evaluate your agent, then deploy it

**Build it · Hands-on. Owner: LangChain.** Portal steps 18 and 19, after "Make it safer" (17),
before the wrap-up (20). Step 18 is one notebook. Step 19 is the terminal.

You built an agent and governed it. Now see what it did, score it, and watch the score move
when the policy does. Nothing in Arcade's code or policy changes. The one thing that changes
between the two experiments is your approval threshold, which you set yourself on step 8.

## Step 18: Observe and evaluate your agent

One notebook, `agent/evals/04_observe.ipynb`, run top to bottom. Each item below is one of its
parts. The code it uses is next to it: `evals/examples.py` is the dataset, `evals/target.py`
the agent as the eval runs it, `evals/checks.py` the evaluators.

### What to do

**Item 1: Open the notebook.** `agent/.env` already has the two eval lines from step 3: set
`EVAL_LOAN_OFFICER` to your own email, the one `ask.py` signs in as. If your shell had
LangSmith variables before today, clear them first, or the notebook reads the wrong workspace.
In `agent`:

    $ unset LANGSMITH_API_KEY LANGSMITH_PROJECT LANGSMITH_TRACING LANGSMITH_ENDPOINT LANGSMITH_WORKSPACE_ID
    $ uv sync --group evals
    $ uv run --group evals --env-file .env jupyter lab evals/04_observe.ipynb

YOU SHOULD SEE: JupyterLab open, and the first cell printing your keys as set,
`loan-desk-local` as the project, and the org your links open in.

**Item 2: Tracing.** Part 1. Every ask this morning is a trace: the question, each tool call
and its result, the model calls with their cost. The cells pull them back by code: the refusal
from step 17, which you match by its time to a row in live activity on step 8; the tools each
run called, in order; and the `LoanDesk_GetLoan` results, redacted before the model saw them.
The refusal also states your threshold, and the cell reads it off. If Northwind went through
with no refusal, your threshold is above $95,000: set it to $50,000 on step 8 before item 5.

YOU SHOULD SEE: The refusal in a trace, the same call as a row in your live activity, and the
threshold the refusal states.

**Item 3: Dataset.** Part 2. Eight requests as you, each with the tool calls a correct run
makes and a one-sentence rubric: plain requests, three escalations the policy should stop, and
two traps. The rows that decide a loan use the three loans the morning left pending,
Harborline, Kestrel and Meridian. The cell reads your book, writes your ids in, and sets aside
any row whose loan is already decided. Then add one row of your own.

YOU SHOULD SEE: Your ids with their status, and `loan-desk-governance` in your workspace with
your row in it.

**Item 4: Evaluators.** Part 3. The notebook runs the same agent as `agent.py`, as you. The
approval request and the email are answered locally, so nothing leaves it; the loan desk calls
still go through your hooks. Then four evaluators from `evals/checks.py`: three in code, where
the question has one right answer, and one LLM judge, told in code whether an approval was
recorded so it cannot be talked into one. Score one run by hand.

YOU SHOULD SEE: One transcript, and four scores with comments.

**Item 5: Experiment A.** Part 4. On step 8, read your threshold: it must be $50,000. Higher,
and the escalations are approved instead of refused, which decides those loans for both
experiments; the cell says so if it happens. Run the cell: every row, every evaluator, saved as
an experiment. Two to three minutes. Nothing in the book changes.

YOU SHOULD SEE: `clearance-50000-…` on the dataset, every row scored.

**Item 6: Experiment B, and the comparison.** On step 8, raise your threshold to $250,000. Run
the next cell: same agent, same dataset. Then open the dataset, tick both experiments, Compare,
and answer the notebook's four questions: what moved, what did not, and why. Set the threshold
back to $50,000 after.

YOU SHOULD SEE: Three escalation rows moving, honesty and discipline flat, and a comment on
every row.

## Step 19: Deploy it, and score every run

The same four files on LangSmith's managed runtime instead of your laptop. `mda deploy`
forwards every line of `agent/.env`, so the deployment signs in to Arcade and reaches the model
the same way. Then the judge from step 18 goes on every run the deployment makes. Everything
here is the terminal: use the one from step 18, or run its `unset` line first.

### What to do

**Item 1: Deploy it.** In `agent`:

    $ uv run mda deploy .

It builds the agent, uploads it, and prints its URL. Keep the URL. Open Deployments in
LangSmith: yours is there, with a tracing project named after it.

YOU SHOULD SEE: The URL in the terminal, and the deployment in LangSmith.

**Item 2: Ask it once, as you.** The same `ask.py`, pointed at the deployment instead of your
laptop. The sign-in from this morning is kept, so no browser unless it expired.

    $ uv run --env-file .env python ask.py --agent <the deployment's URL> "Which loan applications are pending?"

YOU SHOULD SEE: The answer in the terminal, and the run as a trace in the deployment's project,
with the model call in the `gateway` project beside it.

**Item 3: Give the judge its key.** The judge runs on LangSmith's side, so it cannot read
`.env`. In LangSmith: Settings, Integrations, Provider Secrets, Add. Provider: Custom. Name:
`LANGSMITH_GATEWAY_API_KEY`. Value: the room's gateway key from step 2.

YOU SHOULD SEE: The secret listed under Provider Secrets.

**Item 4: Score every run.**

    $ uv run --group evals --env-file .env python evals/production.py --agent <the deployment's URL>

It asks the deployment once more, as you, to find its tracing project. It puts the judge on that
project as a rule named `loan-desk-honest-outcome`. Then, with your threshold back at $50,000,
it asks the over-limit request for Meridian and waits for the score, up to three minutes. If your experiments already decided
Meridian, the agent says so, and the judge scores that report. If it says your shell's key is
not the one in `.env`, run the `unset` line from step 18 in this terminal and run it again.

YOU SHOULD SEE: The rule's link, then `honest_outcome` 1 with the judge's comment, and a link
to the run.

## You should see

One refusal in a trace and its row in live activity. A dataset written for your book, two
experiments on it, and a comparison that shows the policy moved and the agent did not. Your
deployment under Deployments, with the judge scoring every run it makes.

**Check-off:** My agent is evaluated. My agent is in production.

## Short on time

Step 18 items 1 to 5 are the block. Item 6 and step 19 go on the instructors' screen if the
clock is short.
