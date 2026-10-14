# Welcome and setup

**9:00 to 9:15. Joint.** The agenda, the people, and a laptop that can run the rest.

You leave with the agent on your laptop, pointed at the room's loan desk, and signed in to it
as Alice. Everything after this is one of the two products doing its part on that build.

In the room, nobody registers anything. The host runs one deployment of the whole repo: the
loan desk app behind its tunnel, one Okta org as its identity provider, one Arcade project
with the tools, the verifier and the hooks in it. You run only the agent, `agent/`, against
that deployment, with the values the host hands out. The Okta sign-in is a shared persona:
you are one of several Alices. Your Gmail and Slack are your own. Running the whole thing
yourself, with your own Okta org and Arcade project, is the README's Quickstart, for after
the day.

## Before the workshop

Three signups, all with the **same email**:

- An [Arcade](https://api.arcade.dev/dashboard) account. The host invites this email to the
  room's project before the day, and it is the address you pass to `ask.py --as`: Gmail and
  Slack are authorized as this account, in your name, not Alice's.
- The Slack invite the host sent, to the workshop workspace. Accept it with the same email. The
  escalation in [`03-govern.md`](./03-govern.md) is sent from your own Slack account, so you
  have to be in the workspace.
- A LangSmith workspace with Managed Deep Agents beta access, and its API key.

No model key is needed to start: the agent runs a scripted model until you give it one. The
host shares a model key in the room.

## What you get from the host

Four values for `agent/.env`, and two sign-ins:

- `ARCADE_API_KEY`: a key of the room's Arcade project.
- `IDP_ISSUER`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`: the room's Okta org and the loan desk's
  app in it. `ask.py` signs in through this app, which is why it needs the secret.
- Alice's and Bob's email and password at that Okta org. Alice is the loan officer you work
  as; Bob is the credit analyst with no approval authority, for [`02-connect.md`](./02-connect.md).

The key and the secret are shared with the room for the day, and the host rotates both after
it. They go in `agent/.env`, which is gitignored, and nowhere else.

## What you build

1. Clone and install: `git clone`, `git checkout start`, then `cd agent`, `cp .env.example
   .env` and `uv sync`. Nothing in the root of the repo needs to run on your laptop.
2. Fill in `agent/.env`: the four values from the host, your LangSmith key, and
   `CONNECTED_APPS_USER=<your email>`, the Arcade email from the signups, so you do not have
   to pass `--as` on every call.
3. Check the sign-in: open the app's URL the host shared and sign in as Alice. The sign-in page
   is the room's Okta org. The home page shows you signed in as Alice.

## Checkpoint

The app's home page shows you as Alice, and `agent/.env` has six values in it.

## If you are behind

`git checkout start` is the whole state; nothing here changes code. The values in `agent/.env`
are all there is to set up: check them against the host's handout.
