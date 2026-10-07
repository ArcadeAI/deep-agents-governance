import type { NextConfig } from "next";

import { allowedDevOrigins } from "./lib/dev-origins.ts";

const config: NextConfig = {
  // The root Dockerfile runs this app; standalone keeps the runtime
  // image to the server plus only the dependencies it actually traced.
  output: "standalone",
  // A second build directory, for a test that boots its own `next dev` while a
  // developer's is running (#4). Next allows one dev server per `distDir` — it
  // holds `<distDir>/lock` — so `app-test/control-plane-app.test.ts` points
  // this under `.next/` (gitignored) and gets a server of its own. Unset
  // everywhere else, which is Next's own `.next`.
  ...(process.env.CG_NEXT_DIST_DIR ? { distDir: process.env.CG_NEXT_DIST_DIR } : {}),
  // `next dev` only: the loopback address (#190) and the host of
  // `APP_PUBLIC_HOST` (#30), and nothing else. Next 16 answers 403 to a
  // `/_next/*` request from any origin but `localhost`, so a page opened at
  // `http://127.0.0.1:<port>` or at `https://<APP_PUBLIC_HOST>` through the
  // tunnel never gets its dev resources and never hydrates. Every browser test
  // in `app-test/` opens the app at the first, and the Quickstart at the
  // second. Next 15 only warned. The production server (`server.js`) ignores
  // this option. `app-test/dev-origins.test.ts` boots `next dev` behind both.
  allowedDevOrigins: allowedDevOrigins(),
  // No generated agent rules (#9). Next 16's `next dev` writes `AGENTS.md` and
  // `CLAUDE.md` at the root whenever it detects a coding agent in its
  // environment (`AI_AGENT`, `CLAUDECODE` and others). They are gitignored,
  // but a forker's agent would still read instructions nobody wrote for this
  // project. `app-test/agent-rules.test.ts` boots `next dev` as an agent would.
  agentRules: false,
  // The build's type check leaves out the tests, which the Docker builder cannot
  // resolve. The reason is in tsconfig.build.json (#190).
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // The monorepo root, so tracing picks up files linked from packages/. Since
  // #3 that is this app's own directory, named anyway so Turbopack does not
  // have to infer it.
  outputFileTracingRoot: new URL("./", import.meta.url).pathname,
  // `public/**/*` on `/`, because the standalone tree does not carry it either
  // (#177). Next's own docs say to copy `public` beside `.next/static` in the
  // Dockerfile, and that is the obvious fix — but it puts the deployable
  // artifact somewhere only Docker can assemble it, and this repo has already
  // paid for that once: #92 was a standalone gap that every local check was
  // blind to because none of them ran the artifact. Carrying `public` in the
  // trace instead means `bun run build` emits a **complete**
  // `.next/standalone`, and the runner stage copies that one tree — so the
  // thing `app-test/public-assets.test.ts` boots on a socket and the thing the
  // image serves are the same tree, and a fast test can hold it.
  //
  // The glob is relative to this package, so it lands at
  // `.next/standalone/public/` — where `server.js` looks, because
  // `outputFileTracingRoot` makes the standalone tree mirror the monorepo, and
  // since #3 the app is the monorepo's root. It
  // is the whole directory rather than the wordmark `app/Frame.tsx` names:
  // the next file added to `public/` must not be able to go missing in
  // production the way the wordmarks once did.
  //
  // Measured, not assumed. Before this line, `NODE_ENV=production node
  // apps/web/server.js` on the built tree answered `/` with 200 and both
  // the frame's wordmarks with 404 — the co-brand frame with its marks
  // missing, on a projector.
  outputFileTracingIncludes: {
    "/": ["./public/**/*"],
  },
};

export default config;
