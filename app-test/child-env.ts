/**
 * The environment a process spawned by a test gets: an **allowlist**, never the
 * parent's minus the variables somebody thought of.
 *
 * `.orca/project.md` has the measurement behind it (#5): a stub that inherited
 * a host variable from an exported `.env.local` listened on the wrong port and
 * failed a review. The list of variables that change what a child does is
 * long — `APP_PUBLIC_HOST`, every `IDP_*`, every `*_DB_PATH`, `SESSION_SECRET` — so a child gets
 * what it needs to run at all, and everything else from the test that spawns
 * it, by name.
 */
const KEEP = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL", "SHELL", "CG_CHROME_BIN"] as const;

export function childEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of KEEP) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...extra };
}
