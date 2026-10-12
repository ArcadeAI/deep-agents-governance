/**
 * The loan module's copy of the HOST-form check.
 *
 * The measurement behind it is #59: the stage demo's deployment derived the
 * identity provider's address from its host's service references, and what
 * arrived was the bare service name `cg-idp-or5b` rather than its FQDN. Every
 * userinfo call went to a name DNS cannot resolve and the API answered 503 "the
 * identity provider could not be reached": true of the URL, false of the
 * provider.
 *
 * Since the move to Okta the loan module reads no host at all. It is given
 * `IDP_ISSUER`, a full URL, and finds userinfo through discovery. The check
 * stays here because it is one of three byte-identical copies
 * (`app-test/public-host.test.ts` diffs them) and `scripts/loans.ts` still
 * routes its config through `orExitConfig`. The table below is shared,
 * verbatim, with `app-test/control-plane/public-host.test.ts` and
 * `app-test/public-host.test.ts`.
 */
import { expect, test } from "bun:test";

import { assertPublicHost, publicHost, PublicHostError } from "../../api/public-host.ts";

/** Values a consumer can actually reach, or is free to leave unset. */
const ACCEPTED = [
  "localhost",
  "localhost:8083",
  "localhost:8082",
  "  localhost:8083  ",
  "127.0.0.1:1234",
  "127.0.0.1:4413",
  "127.0.0.53",
  "[::1]",
  "[::1]:9000",
  "[::1]:4413",
  "cg-idp-or5b.example.com",
  "cg-web-sa31.example.com",
  "cg-hooks.example.com:443",
  "example.test",
];

/**
 * Nothing here is reachable. The first five are bare service names — what
 * a derived service reference produced (#59), and what a hand-typed key
 * produces again.
 *
 * The rest are round 1 of #67. The first cut of this check let any value
 * through once bracket-stripping left a colon in it, so `[::2]` — no dot, not
 * loopback — booted the loan API and served `/health` on it. `cg-loan-app:bad`
 * and `foo:bar` got in the same way. A dotless non-loopback host is refused
 * whatever punctuation it carries, and a port that is not a port number is
 * refused too.
 */
const REFUSED = [
  "cg-idp",
  "cg-idp-or5b",
  "cg-loan-app",
  "cg-web-sa31",
  "cg-loan-app:8080",
  "[::2]",
  "::2",
  "[fe80::1]",
  "cg-loan-app:bad",
  "foo:bar",
  "localhost:bad",
  "localhost:0",
  "localhost:65536",
  "cg-hooks.example.com:bad",
  "https://cg-hooks.example.com",
];

test.each(ACCEPTED)("%p is a host something can resolve", (value) => {
  expect(() => assertPublicHost("APP_PUBLIC_HOST", value)).not.toThrow();
});

test.each([undefined, "", "   "])("%p is not an error; consumers have defaults", (value) => {
  expect(() => assertPublicHost("APP_PUBLIC_HOST", value)).not.toThrow();
  expect(publicHost("APP_PUBLIC_HOST", value, "localhost:8083")).toBe("localhost:8083");
});

test.each(REFUSED)("%p is refused: it is a service name, not a hostname", (value) => {
  expect(() => assertPublicHost("APP_PUBLIC_HOST", value)).toThrow(PublicHostError);
});

test("the refusal names the variable, its value, and where the real one comes from", () => {
  // The whole worth of this check is the message: whoever reads it is about to
  // go and find the right string, and the right string is the app's own public host.
  try {
    assertPublicHost("APP_PUBLIC_HOST", "cg-idp-or5b");
    throw new Error("expected a refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(PublicHostError);
    const { message } = cause as Error;
    expect(message).toContain("APP_PUBLIC_HOST=cg-idp-or5b");
    expect(message).toContain("the host part of its public URL");
    expect(message).toContain("Never derive or guess it");
  }
});

test("a good value wins over the default, and is trimmed", () => {
  expect(publicHost("APP_PUBLIC_HOST", "  cg-idp-or5b.example.com ", "localhost:8083")).toBe(
    "cg-idp-or5b.example.com",
  );
});

