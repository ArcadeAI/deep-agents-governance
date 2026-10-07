/**
 * The two pages a persona sees: sign in, then consent. Server-rendered HTML,
 * one stylesheet, no JavaScript. Legible from the back of a room, because
 * they are on screen the first time a persona authorizes during the demo.
 *
 * UI craft lives in `apps/web`. This is an enterprise login box.
 */

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #eef1f5; color: #1b1f24;
    font: 18px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { width: min(480px, calc(100vw - 32px)); }
  .brand {
    display: flex; align-items: center; gap: 12px; margin: 0 0 20px 4px;
    font-weight: 600; font-size: 20px; letter-spacing: 0.01em; color: #2b3644;
  }
  .brand .mark {
    width: 32px; height: 32px; border-radius: 8px; background: #2b3644;
    color: #fff; display: grid; place-items: center; font-size: 15px;
  }
  .card {
    background: #fff; border: 1px solid #d5dbe3; border-radius: 12px;
    padding: 36px 40px; box-shadow: 0 8px 24px rgba(27, 31, 36, 0.06);
  }
  h1 { margin: 0 0 8px; font-size: 28px; font-weight: 600; }
  p { margin: 0 0 24px; color: #4a5568; }
  label { display: block; font-weight: 600; margin: 18px 0 6px; }
  input[type=email], input[type=password] {
    width: 100%; font: inherit; padding: 14px 16px; border-radius: 8px;
    border: 1px solid #b7c0cc; background: #fff; color: inherit;
  }
  input:focus { outline: 3px solid #b5cdf5; border-color: #3b6fd1; }
  .actions { display: flex; gap: 12px; margin-top: 28px; }
  button {
    flex: 1; font: inherit; font-weight: 600; font-size: 19px;
    padding: 15px 18px; border-radius: 8px; border: 1px solid #2b3644;
    background: #2b3644; color: #fff; cursor: pointer;
  }
  button.secondary { background: #fff; color: #2b3644; }
  .error {
    background: #fdecec; border: 1px solid #f2b8b8; color: #8a1c1c;
    border-radius: 8px; padding: 12px 16px; margin-bottom: 8px;
  }
  .who {
    display: flex; align-items: center; gap: 14px; padding: 14px 16px;
    background: #f5f7fa; border-radius: 8px; margin-bottom: 20px;
  }
  .who .avatar {
    width: 44px; height: 44px; border-radius: 50%; background: #3b6fd1;
    color: #fff; display: grid; place-items: center; font-weight: 600;
  }
  .who .email { color: #4a5568; font-size: 16px; }
  ul.scopes { list-style: none; margin: 0 0 8px; padding: 0; }
  ul.scopes li {
    display: flex; gap: 12px; align-items: baseline; padding: 10px 0;
    border-top: 1px solid #e6eaf0;
  }
  ul.scopes li:first-child { border-top: 0; }
  ul.scopes code {
    font-size: 15px; background: #f0f3f7; padding: 2px 8px; border-radius: 6px;
  }
  .fixture {
    margin: 22px 4px 0; font-size: 14px; color: #6b7684; text-align: center;
  }
  .fixture code { font-size: 13px; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="brand"><span class="mark">ID</span> Enterprise Identity</div>
  ${body}
  <p class="fixture">Demo identity provider — a stand-in for the enterprise's real IdP.<br>
  Accounts are added with <code>bun run users</code>.</p>
</main>
</body>
</html>`;
}

export interface LoginPageInput {
  /** The signed authorize query the plugin redirected here with, verbatim. Empty outside an OAuth flow. */
  oauthQuery: string;
  clientName: string | null;
  error?: string | undefined;
  email?: string | undefined;
}

export function renderLoginPage({ oauthQuery, clientName, error, email }: LoginPageInput): string {
  const lead = clientName
    ? `<strong>${escape(clientName)}</strong> is asking you to sign in.`
    : "Sign in with your work email.";

  return page(
    "Sign in",
    `<form class="card" method="post" action="/login">
      <h1>Sign in</h1>
      <p>${lead}</p>
      ${error ? `<div class="error" role="alert">${escape(error)}</div>` : ""}
      <input type="hidden" name="oauth_query" value="${escape(oauthQuery)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus
             value="${escape(email ?? "")}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <div class="actions"><button type="submit">Sign in</button></div>
    </form>`,
  );
}

/** What each scope means, in words a person on stage can read out. */
const SCOPE_TEXT: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected without asking again",
};

export interface ConsentPageInput {
  oauthQuery: string;
  clientName: string;
  scopes: string[];
  user: { name: string; email: string };
}

export function renderConsentPage({ oauthQuery, clientName, scopes, user }: ConsentPageInput): string {
  const items = scopes
    .map(
      (scope) =>
        `<li><code>${escape(scope)}</code><span>${escape(SCOPE_TEXT[scope] ?? scope)}</span></li>`,
    )
    .join("");
  const initial = user.name.trim().charAt(0).toUpperCase() || "?";

  return page(
    "Allow access",
    `<form class="card" method="post" action="/consent">
      <h1>Allow access?</h1>
      <p><strong>${escape(clientName)}</strong> wants to act on your behalf.</p>
      <div class="who">
        <span class="avatar" aria-hidden="true">${escape(initial)}</span>
        <span><strong>${escape(user.name)}</strong><br><span class="email">${escape(user.email)}</span></span>
      </div>
      <ul class="scopes">${items}</ul>
      <input type="hidden" name="oauth_query" value="${escape(oauthQuery)}">
      <div class="actions">
        <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
        <button type="submit" name="decision" value="allow">Allow</button>
      </div>
    </form>`,
  );
}

export function renderMessagePage(title: string, text: string): string {
  return page(title, `<div class="card"><h1>${escape(title)}</h1><p>${escape(text)}</p></div>`);
}

/**
 * Hints for the codes a developer meets while setting up, keyed on the
 * plugin's own `error`. `invalid_client` is the #52 live test's: the app's
 * sign-in named a client `idp.db` does not hold.
 */
const ERROR_HINTS: Record<string, string> = {
  invalid_client:
    "The client_id this request named is not a client of this identity provider. For the app's own sign-in, " +
    "that is IDP_CLIENT_ID: check that the shell does not export an older one (`bun run dev` warns when it " +
    "does), then run `bun run setup-arcade <ngrok-host>`, which sets IDP_CLIENT_ID and IDP_CLIENT_SECRET " +
    "in .env to idp.db's web client, and restart `bun run dev`.",
  invalid_redirect:
    "The redirect_uri this request named is not on the client's allowlist in idp.db.",
};

/** Any other code, including one somebody typed into the URL. */
const UNKNOWN_ERROR_HINT = "Start the sign-in again from the app. If it stops here again, the code above is what the identity provider refused.";

/** `/error`: where the OAuth plugin sends a request it cannot send back to the client (#54). */
export function renderErrorPage(error: string | null, description: string | null): string {
  const code = error?.trim() || "unknown_error";
  // Own keys only: the code comes from the query string, and `constructor` or
  // `__proto__` would otherwise read Object.prototype and hand a function to
  // `escape`, a 500 (the #54 review).
  const hint = Object.hasOwn(ERROR_HINTS, code) ? ERROR_HINTS[code]! : UNKNOWN_ERROR_HINT;
  return page(
    "Sign-in stopped",
    `<div class="card">
      <h1>Sign-in stopped</h1>
      <p>The identity provider refused this request, and could not send it back to the app that made it.</p>
      <div class="error" role="alert"><code>${escape(code)}</code>${description?.trim() ? `: ${escape(description.trim())}` : ""}</div>
      <p>${escape(hint)}</p>
    </div>`,
  );
}
