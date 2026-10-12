/**
 * The pure parts of identity: OIDC discovery (`auth/discovery.ts`) and the
 * rules `bun run users` applies before it asks Okta to make somebody
 * (`scripts/okta/people.ts`). No network: discovery is handed a fetch.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { discover, DiscoveryError, discoveryUrl, forgetDiscovery } from "../auth/discovery.ts";
import { generatePassword, passwordProblem, splitName } from "../scripts/okta/people.ts";

const ISSUER = "https://org.example/oauth2/default";
const documentFor = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/v1/authorize`,
  token_endpoint: `${issuer}/v1/token`,
  userinfo_endpoint: `${issuer}/v1/userinfo`,
  jwks_uri: `${issuer}/v1/keys`,
});

function counted(answer: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return answer();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("discover", () => {
  afterEach(() => forgetDiscovery());

  test("reads the document at $issuer/.well-known/openid-configuration once, and reuses it", async () => {
    const { calls, fetchImpl } = counted(() => Response.json(documentFor(ISSUER)));
    const first = await discover(`${ISSUER}/`, fetchImpl);
    const second = await discover(ISSUER, fetchImpl);
    expect(first.userinfo_endpoint).toBe(`${ISSUER}/v1/userinfo`);
    expect(second).toBe(first);
    expect(calls).toEqual([discoveryUrl(ISSUER)]);
    expect(discoveryUrl(`${ISSUER}/`)).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  test("a document naming another issuer fails by name: the org URL where the auth server's belongs", async () => {
    const { fetchImpl } = counted(() => Response.json(documentFor(ISSUER)));
    const failed = discover("https://org.example", fetchImpl);
    await expect(failed).rejects.toBeInstanceOf(DiscoveryError);
    await expect(failed).rejects.toThrow(`names its issuer ${ISSUER}, not https://org.example`);
  });

  test("a missing endpoint, a non-JSON body and an error status each say what went wrong", async () => {
    const { jwks_uri: _dropped, ...noKeys } = documentFor(ISSUER);
    await expect(discover(ISSUER, counted(() => Response.json(noKeys)).fetchImpl)).rejects.toThrow("has no jwks_uri");
    forgetDiscovery();
    await expect(discover(ISSUER, counted(() => new Response("<html>")).fetchImpl)).rejects.toThrow("did not answer JSON");
    forgetDiscovery();
    await expect(discover(ISSUER, counted(() => new Response("", { status: 503 })).fetchImpl)).rejects.toThrow("answered 503");
    await expect(discover("", counted(() => Response.json({})).fetchImpl)).rejects.toThrow("IDP_ISSUER is not set");
  });

  test("a failed read is not kept: the next call tries again", async () => {
    let up = false;
    const { calls, fetchImpl } = counted(() => (up ? Response.json(documentFor(ISSUER)) : new Response("", { status: 502 })));
    await expect(discover(ISSUER, fetchImpl)).rejects.toThrow("answered 502");
    up = true;
    expect((await discover(ISSUER, fetchImpl)).issuer).toBe(ISSUER);
    expect(calls).toHaveLength(2);
  });

  test("forgetDiscovery drops what was kept", async () => {
    const { calls, fetchImpl } = counted(() => Response.json(documentFor(ISSUER)));
    await discover(ISSUER, fetchImpl);
    forgetDiscovery();
    await discover(ISSUER, fetchImpl);
    expect(calls).toHaveLength(2);
  });
});

describe("Okta's default password policy, as bun run users checks it", () => {
  const email = "rowan.quill@example.com";

  test("a password the policy takes", () => {
    expect(passwordProblem("Granite-Harbor-42", email)).toBeNull();
    expect(passwordProblem("Ledger-Desk-2026", "alice@demo.test")).toBeNull();
  });

  test("each rule, refused by name", () => {
    expect(passwordProblem("Short-1", email)).toBe("must be 8 to 72 characters");
    expect(passwordProblem(`A1${"a".repeat(71)}`, email)).toBe("must be 8 to 72 characters");
    expect(passwordProblem("ALL-UPPER-42", email)).toBe("needs a lowercase letter");
    expect(passwordProblem("correct-horse-battery", email)).toBe("needs an uppercase letter");
    expect(passwordProblem("No-Digits-Here", email)).toBe("needs a number");
  });

  test("no part of the username, three characters or more, split the way Okta splits it", () => {
    expect(passwordProblem("Rowan-Harbor-42", email)).toBe('must not contain part of the username ("rowan")');
    expect(passwordProblem("Harbor-Quill-42", email)).toBe('must not contain part of the username ("quill")');
    expect(passwordProblem("Example-Gate-42", email)).toBe('must not contain part of the username ("example")');
    expect(passwordProblem("Demo-Desk-2026", "alice@demo.test")).toBe('must not contain part of the username ("demo")');
    // "com" is a part too; two-letter parts are not.
    expect(passwordProblem("Comet-Trail-42", email)).toBe('must not contain part of the username ("com")');
    expect(passwordProblem("Bo-Granite-42", "bo@x.io")).toBeNull();
  });

  test("a generated password is 20 alphanumerics the policy takes, different every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const password = generatePassword(email);
      expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
      expect(passwordProblem(password, email)).toBeNull();
      seen.add(password);
    }
    expect(seen.size).toBe(50);
  });
});

describe("splitName", () => {
  test("the last word is the last name", () => {
    expect(splitName("Rowan Quill")).toEqual({ firstName: "Rowan", lastName: "Quill" });
    expect(splitName("  Mary Ann  de Vries ")).toEqual({ firstName: "Mary Ann de", lastName: "Vries" });
  });

  test("a one-word name, as the demo cast has, gets Loan Desk as its last name", () => {
    expect(splitName("Alice")).toEqual({ firstName: "Alice", lastName: "Loan Desk" });
  });
});
