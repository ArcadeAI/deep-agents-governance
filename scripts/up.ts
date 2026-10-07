/**
 * `bun run up`: the app and the tunnel, one command, one Ctrl-C.
 *
 * Starts `bun run dev` (the app, with the gate, the loan API and the identity
 * provider inside it) and `ngrok http --url=<APP_PUBLIC_HOST> <PORT>` side by
 * side, prefixes each one's output, and stops both when either exits or when
 * you press Ctrl-C. Nothing else: `bun run dev` alone still works, and so
 * does running ngrok yourself.
 *
 * `APP_PUBLIC_HOST` and `PORT` come from `.env`, the way `bun run dev` reads
 * them (`bun run` injects `.env` into this process). A host that is not an
 * ngrok domain, or no host at all, is an error here rather than a tunnel to
 * the wrong place.
 */

import { spawn, type ChildProcess } from "node:child_process";

const host = process.env.APP_PUBLIC_HOST?.trim() ?? "";
const port = process.env.PORT?.trim() || "3000";

if (host === "") {
  console.error("up: APP_PUBLIC_HOST is not set in .env. Run `bun run setup-arcade <your-ngrok-host>` first.");
  process.exit(64);
}
if (!/\.ngrok(-free)?\.(app|dev)$/.test(host) && !/\.ngrok\.io$/.test(host)) {
  console.error(`up: APP_PUBLIC_HOST is ${host}, which is not an ngrok domain; start your own tunnel and use \`bun run dev\`.`);
  process.exit(64);
}

const children: ChildProcess[] = [];
let stopping = false;

function start(label: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const relay = (stream: NodeJS.ReadableStream | null, write: (s: string) => void) => {
    let rest = "";
    stream?.on("data", (chunk: Buffer) => {
      rest += chunk.toString();
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) write(`[${label}] ${line}\n`);
    });
  };
  relay(child.stdout, (s) => process.stdout.write(s));
  relay(child.stderr, (s) => process.stderr.write(s));
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[up] ${label} exited (${signal ?? code}); stopping the other.`);
    stop(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`[up] could not start ${label}: ${error.message}${label === "ngrok" ? " — is ngrok installed? https://ngrok.com/download" : ""}`);
    stop(1);
  });
  children.push(child);
  return child;
}

function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log(`[up] app on http://localhost:${port}, tunnel https://${host} → ${port}. Ctrl-C stops both.`);
start("app", "bun", ["scripts/next.ts", "dev"]);
start("ngrok", "ngrok", ["http", `--url=${host}`, port, "--log=stdout", "--log-format=term"]);
