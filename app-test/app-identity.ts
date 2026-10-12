/**
 * The identity provider a real app signs in through, for a test that boots
 * Next.
 *
 * In production that is Okta: `IDP_ISSUER` is an authorization server, and
 * the app is an ordinary OIDC client of it with `IDP_CLIENT_ID` and
 * `IDP_CLIENT_SECRET`. Here it is the OIDC stand-in (`scripts/oidc-stand-in.ts`),
 * which serves the same discovery document, endpoints and Management API on a
 * loopback port, with the demo cast in it (#33) and one client whose redirect
 * URI is the booted app's callback. The client secret is freshly random per
 * call and gone with the stand-in.
 */
import { startOidcStandIn, type OidcStandIn } from "../scripts/oidc-stand-in.ts";
import { DEMO_PEOPLE, TEST_OKTA_TOKEN } from "./demo-cast.ts";

export interface AppIdentity {
  /** Spread into the booted app's environment. */
  env: Record<string, string>;
  clientId: string;
  clientSecret: string;
  standIn: OidcStandIn;
  stop(): void;
}

/** Every stand-in `appIdentityEnv` started, including a port attempt that lost its race (#9). */
const started: OidcStandIn[] = [];

/** Stop every identity provider this file started. For a suite's `finally` or `afterAll`. */
export function stopAppIdentities(): void {
  for (const standIn of started.splice(0)) standIn.stop();
}

export async function appIdentityEnv(
  origin: string,
  options: { extraRedirectUris?: string[]; devTokens?: boolean; cast?: boolean } = {},
): Promise<AppIdentity> {
  const clientId = "0oa-test-web";
  const clientSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  const standIn = await startOidcStandIn({
    people: (options.cast === false ? [] : DEMO_PEOPLE).map((person) => ({ name: person.name, email: person.email, password: person.password })),
    clients: [{ clientId, clientSecret, redirectUris: [`${origin}/api/auth/callback`, ...(options.extraRedirectUris ?? [])] }],
    managementToken: TEST_OKTA_TOKEN,
    devTokens: options.devTokens ?? false,
  });
  started.push(standIn);
  return {
    env: {
      APP_PUBLIC_HOST: new URL(origin).host,
      IDP_ISSUER: standIn.issuer,
      IDP_CLIENT_ID: clientId,
      IDP_CLIENT_SECRET: clientSecret,
    },
    clientId,
    clientSecret,
    standIn,
    stop: () => standIn.stop(),
  };
}
