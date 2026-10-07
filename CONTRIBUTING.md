# Contributing

This repo is a workshop: a LangChain Deep Agent on a loan desk, governed through Arcade.
Fixes that make the workshop easier to follow are the most useful contribution, from
a step that did not work as written to a confusing error to a doc that names the wrong file.

## Reporting a problem

Open a GitHub issue with:

- the module and step you were on (`docs/modules/`), or the README Quickstart step;
- the command you ran and what it printed, with your host, keys and emails taken out;
- what `https://<APP_PUBLIC_HOST>/health` reports, if the app was running.

Never paste a key, a token, or the contents of a `.env` file into an issue, even an
expired one.

## Making a change

1. Fork, and branch from `main`.
2. Make the change, and the test that pins it. Most behavior here has one: the policies,
   the hooks, the setup script's requests, the `auth-config/` bodies, and the README's own
   structure.
3. Run the three suites, and the typecheck:

   ```sh
   bun install
   bun run typecheck
   bun test                                    # the app, the gate, the docs
   (cd mcp && uv run --extra dev pytest)       # the LoanDesk tools
   (cd agent && uv run --group dev pytest)     # the Deep Agent
   ```

   None of them needs an Arcade key, a model key or a network connection.
4. Open a pull request against `main` that says what changed and why. CI runs the same
   suites.

## Where things live

| You want to change | Edit | Kept honest by |
|---|---|---|
| A policy or a limit | `gate/policies/governance.json`, then `bun run reset` | `bun run gate` prints what is live; `/health` reports drift |
| A loan tool | `mcp/loan_desk/` | `mcp/tests/` |
| The loan data | `api/fixtures/loans.json` | `app-test/loans/` |
| What gets registered at Arcade | `scripts/setup-arcade/`, and `auth-config/` to match | `app-test/auth-config.test.ts` |
| How the agent behaves | `agent/instructions.md` | a run against a real model |
| The workshop's steps | `docs/modules/`, `README.md` | `test/readme.test.ts`, `test/docs-links.test.ts` |

`gate/service/approval-guards.json` holds the approval flow's own guards. They are
part of the mechanism rather than the policy you would tune, so change them only alongside
`gate/service/`.

## Style

Docs are plain and specific: name the file, the command and the value. Code comments
explain why, not what. Match the file you are in.
