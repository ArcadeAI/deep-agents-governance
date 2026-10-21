# Module 00, the LangSmith items: for portal step 2, "Check your access"

**Owner: LangChain.** This is the text for three items of the portal's step 2. Items 1, 2 and
4 (git, uv and Python 3.12; the repository; `agent/.env` from the example file and `uv sync`)
stay as they are, with one change to item 4: the sync is `uv sync --group evals`,
so the model's package and the Module 04 notebook are on the laptop before the day and nothing
downloads in the room. Item 3 and item 5 are replaced by the two below, and item 6 goes:
Module 01 is the "Start your agent" step now, after the Arcade setup, so nothing from the
LangChain half runs before step 3.

## Item 3: No model key. The gateway.

FROM LANGCHAIN · THE MODEL YOUR AGENT THINKS WITH, PAID FOR BY THE WORKSHOP

The agent runs a scripted model until you give it one. You do not get a model key. Your agent's
model calls go through the LangSmith LLM Gateway: two lines in `agent/.env`, which the "Start
your agent" step's block has, send every call to the gateway with the room's key, below. The
key is LangChain's, one for the whole room. It is scoped to one workshop workspace that holds
the model key in its secrets and a spend cap, and it expires the week after the workshop. The
model key never leaves that workspace. This key goes in `agent/.env` as
`LANGSMITH_GATEWAY_API_KEY`.

    <the room's gateway key>

YOU SHOULD SEE: A key that starts with `lsv2_`, ready for `agent/.env`. Your own LangSmith key
is the next item.

## Item 5: LangSmith

FROM LANGCHAIN · WHERE YOU DEPLOY YOUR AGENT AND FOLLOW ITS RUNS

LangSmith is where your agent is deployed and where every run of it lands as a trace. Make
your account through the link below. It gives you a workspace of your own with Managed Deep
Agents turned on, and it mints your API key. That key goes in `agent/.env` as
`LANGSMITH_API_KEY`. The workspace is yours, and everything the day puts in it stays yours: the
traces, the deployment, the dataset and the experiments from Module 04.

    <the LangSmith Workshop Studio link, from LangChain>

YOU SHOULD SEE: A second key that starts with `lsv2_`, ready for `agent/.env`, and your
workspace at smith.langchain.com.

## Item 6: removed

"Modules 00 and 01 from the LangChain half" no longer runs before the Arcade steps. The agent
first serves on the "Start your agent" step, with every value `agent/.env` needs.
