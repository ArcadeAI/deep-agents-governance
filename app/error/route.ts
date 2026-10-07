/**
 * `/error`: where the identity provider sends an authorize request it cannot
 * send back to the client, with `error` and `error_description` (#54). Until
 * #54 nothing served it, so a sign-in with a stale `IDP_CLIENT_ID` ended on a
 * 404 and the provider's explanation was only in the address bar.
 *
 * Served by the identity module (`auth/provider/`), in-process, since
 * #6 folded `apps/idp` into the app. Every method goes to the provider, which
 * answers what it does not serve itself; when it did not boot, every one of
 * them is a 503 naming why (`instance.ts`).
 */
import { serve } from "../../auth/provider/instance.ts";

export const dynamic = "force-dynamic";

export const GET = serve;
export const POST = serve;
export const OPTIONS = serve;
