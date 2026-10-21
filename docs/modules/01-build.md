# Step 13 / 18: Start your agent

**Build it · Hands-on. Owner: LangChain.** The Deep Agent from the repository, wired to your
project and serving on your laptop, with a real model through the LangSmith LLM Gateway and
every run traced in your LangSmith workspace.

The agent in `agent/` is a LangChain Deep Agent: a model in a loop with tools and a few built-in
habits. It plans with a todo list, reads and writes files, and can load a skill, a file of
instructions for one kind of task. This one gets its tools through Arcade's LangChain
integration, `langchain_arcade`, vendored in `agent/langchain_arcade/`. In the agent it is one
middleware, `ArcadeMiddleware`: for each request it asks Arcade for the tools that fit the task,
and runs each call through Arcade as you. You run only the agent. Everything it talks to runs in
your own Arcade project: the Loan Desk server you hosted, the identity you registered, and the
policy on your tenant.

`mda` is the Managed Deep Agents command line. `mda dev` builds the agent and serves it on your
laptop. `mda deploy`, in Module 04, puts the same build on LangSmith's managed runtime. Either
way the agent is four files: `agent.py`, which defines it; `instructions.md`, what it is told;
`skills/`, what it can load; and `.env`, where it signs in.

## What to do

**Item 1: Check out the start tag and go into the agent.** In the repository you checked out
on step 2, fetch the latest `start` tag (it moves when the workshop team fixes something),
check it out, and go into the agent.

    $ cd deep-agents-governance
    $ git fetch --tags --force
    $ git checkout start
    $ cd agent

**Item 2: Open `agent/agent.py`.** The agent is `define_deep_agent` with one middleware,
`ArcadeMiddleware`: that is the whole of the Arcade integration. No tools are listed in code.
The six loan desk tools come from your project's tool list on every selection, and Tool
Recommendation adds the rest from the catalog, so it may offer an unrelated tool too. The
hooks on your tenant govern every call either way. `agent/instructions.md` is what the agent
is told: it describes the tools and carries no limits.

**Item 3: Fill in `agent/.env` with the block below.** `LANGSMITH_API_KEY` is your own key
from step 2, `ARCADE_API_KEY` the project key you created on step 3, and the three `IDP_`
values are from step 4. The last three lines are the model: no model key goes on your laptop.
The two gateway lines send every model call through the LangSmith LLM Gateway with the gateway
key from step 2, which is LangChain's and scoped to a workshop workspace that holds the model
key. Your own key, the first line, is where your traces and your deployment go. `mda deploy`
forwards every line to the deployment.

    LANGSMITH_API_KEY=<your LangSmith key, from step 2>
    ARCADE_API_KEY=<the project key you created on the Arcade account step>
    IDP_ISSUER=<from the identity step>
    IDP_CLIENT_ID=<from the identity step>
    IDP_CLIENT_SECRET=<from the identity step>
    MODEL_ID=openai:gpt-5.5
    LANGSMITH_GATEWAY=true
    LANGSMITH_GATEWAY_API_KEY=<the gateway key, from step 2>

The client secret is the workshop identity provider app's, shared by everyone in your org; it
is hidden until you show it so a shared screen does not give it away, and Copy includes it.

**Item 4: Serve the agent on your laptop, and leave it running.**
`--no-browser` keeps LangGraph Studio from opening: the agent takes only tokens from the
workshop identity provider, which `ask.py` gets for you on the next item, so Studio could not
connect to it anyway.

    $ uv sync
    $ uv run mda dev . --no-browser

The terminal ends with `API: http://127.0.0.1:2024`. If it says port 2024 is already in use,
an agent from earlier is still running, and the next items would talk to that one: stop it and
start again.

    $ lsof -ti :2024 | xargs kill
    $ uv run mda dev . --no-browser

YOU SHOULD SEE: Your agent serving on your laptop at port 2024, with no errors.

**Item 5: Ask it one question, as you.** In a second terminal, in `agent`:

    $ uv run --env-file .env python ask.py "Introduce yourself. What can you do for me, and as whom?"

The first time, `ask.py` opens the workshop identity provider's sign-in in your browser: sign
in with your workshop username and password from step 4. It keeps that sign-in for an hour
and prints `Asking as <email>` on every run; if that is not you (somebody else used this
laptop before), run it again with `--sign-in`. The ID token goes to the agent as a bearer, and
`agent/identity.py` accepts only tokens the workshop identity provider issued for the app: the
`email` claim is who every tool call runs as. Then open smith.langchain.com, your workspace:
the run is a trace there, with the model call inside it, and the gateway's own record of that
call is in the `gateway` tracing project next to it, with its cost.

YOU SHOULD SEE: An answer in the terminal, a trace in your workspace, and the same call in the
`gateway` project with its cost.

**Item 6: Give it a skill.** A skill is a directory under `agent/skills/` with a `SKILL.md`: a
name and a description the agent matches against the task, then the instructions. It is
mounted read-only at `/skills/`. From `agent`:

    $ mkdir -p skills/credit-memo && cat > skills/credit-memo/SKILL.md <<'SKILL'
    ---
    name: credit-memo
    description: Write a one-page credit memo for one loan application.
    ---
    # Credit memo

    Read the application with `LoanDesk_GetLoan`, then write the memo in this order, one short
    paragraph each:

    1. Borrower: name, years in business, annual revenue.
    2. Request: amount, purpose, submission date.
    3. Credit: credit score and the underwriter's notes as the record holds them.
    4. Decisions so far, oldest first.
    5. Recommendation: approve, deny or escalate, with the amount, and who has to approve it
       when it is above the asker's authority.

    Quote amounts and ids exactly. Never include a bank account number or tax id, even when
    the record shows one.
    SKILL

Restart `mda dev` so it picks up `skills/`, and ask:

    $ uv run --env-file .env python ask.py "Write a credit memo for the Northwind Bakery loan."

The transcript shows the skill read, then `LoanDesk_SearchLoans` and `LoanDesk_GetLoan`, then
the memo. Those are your first calls through your project's hooks: they show up in the live
activity on step 8. If the result is a link to authorize instead, open it, allow it, and ask
again. Two fields of the record come back as `[REDACTED]` and the memo leaves them out; the
"Make it safer" step is about why.

YOU SHOULD SEE: The memo, with the account number and tax id left out, and two loan desk
calls in your tenant's live activity.

## You should see

Your agent serving on your laptop and `ask.py` answering from it, as you. The skill at
`agent/skills/credit-memo/SKILL.md`, and the memo for the Northwind loan with two fields left
out. The trace of every ask in your workspace, with the model calls in the `gateway` project.
The steps that follow, Slack, the Loan Desk's tools, End to end and Make it safer, run against
this agent, and Module 04 reads their traces back, scores the agent, and deploys it.

**Check-off:** My agent is running.

## Short on time

Items 1 to 5 are the floor: the agent serving on your laptop with a real model. Item 6 is one
file, and the memo it writes is what "Make it safer" and Module 04 look at.
