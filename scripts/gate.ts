/**
 * `bun run gate`: the gate, in one command.
 *
 * The gate is `gate/`: the three policies in `gate/policies/governance.json`, the
 * approval's own guards in `gate/service/approval-guards.json`, the
 * engine in `gate/engine`, the schema in `gate/schema`, and the webhook service
 * in `gate/service` that answers Arcade's /hooks/access, /hooks/pre and
 * /hooks/post. The service is a module of the app and runs inside `next dev`,
 * on the app's own port, so starting the gate is starting the app. Everything
 * it enforces is in this repo; nothing is fetched from a hosted policy store.
 *
 * What this adds over `bun run dev` is the summary first: the policies the
 * service will seed `governance.db` from (when it has none), rule by rule, so
 * the room can read what is about to be enforced before a tool call hits it.
 * Then it hands over to the same dev server `bun run dev` runs.
 */

import { spawn } from "node:child_process";

import policies from "../gate/policies/governance.json" with { type: "json" };
import { loadSeed } from "../gate/service/policy-store.ts";

const toolkit = process.env.ARCADE_TOOLKIT?.trim() || "LoanDesk";
const seed = loadSeed({ toolkit });

const workshop = new Set([...policies.policy_rules, ...policies.output_rules].map((rule) => rule.id));
const rules = [
  ...seed.policy_rules.map((rule) => ({ ...rule, hook: rule.hook as string })),
  ...seed.output_rules.map((rule) => ({ ...rule, hook: "post" })),
];
const line = (rule: { id: string; hook: string; match: { toolkit: string; tool: string } }) =>
  `    /hooks/${rule.hook.padEnd(6)} ${rule.id}  (${rule.match.toolkit}.${rule.match.tool})`;

console.log(`gate: ${rules.length} rules over ${Object.keys(seed.catalogue[toolkit] ?? {}).length} ${toolkit} tools`);
console.log(`  the workshop's policies, gate/policies/governance.json (${workshop.size})`);
for (const rule of rules.filter((each) => workshop.has(each.id))) console.log(line(rule));
console.log(`  the approval's own guards, gate/service/approval-guards.json (${rules.length - workshop.size})`);
for (const rule of rules.filter((each) => !workshop.has(each.id))) console.log(line(rule));
console.log("  governance.db is seeded from these files only when it has no schema; after that the rows are the policy.");
console.log("");

// The same dev server `bun run dev` starts: the gate is a module of it.
const child = spawn("bun", ["scripts/next.ts", "dev", ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
