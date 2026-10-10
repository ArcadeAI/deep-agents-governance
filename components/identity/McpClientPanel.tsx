/**
 * "Connect your MCP client": how to reach the same tools, under the same
 * hooks, from Claude Code or another MCP client, through the gateway
 * `bun run setup-arcade --gateway` registered.
 *
 * Rendered only with `ARCADE_GATEWAY_ID` set (`app/page.tsx`), under the
 * assistant column: the agent in `agent/` does not use the gateway, it calls
 * the Engine directly, so without one this panel has nothing to say and says
 * nothing. The URL is the one `setup-arcade` printed (`lib/config.ts`
 * `gatewayUrl`), and signing in happens in the client (`/mcp` in Claude
 * Code), at Okta, through Arcade's User Source: the person is themselves
 * there too, and the hooks see the same email. `docs/modules/05-mcp-client.md`
 * walks through it.
 *
 * A server component with no state: nothing here reads the session or the
 * key. In `components/identity` because it is about who the client signs in
 * as, and the bank pane must not know a gateway exists (the fork seam,
 * `components/bank/BankPane.tsx`): it arrives there as an element.
 */
export function McpClientPanel({ url }: { url: string }) {
  return (
    <div className="bank-mcp-client">
      <h3 className="bank-panel-subtitle">Connect your MCP client</h3>
      <p>
        The same tools are on an MCP gateway, under the same hooks. In Claude Code, add it and sign
        in at Okta with <code>/mcp</code>:
      </p>
      <pre className="bank-mcp-command">
        <code>claude mcp add --transport http loan-desk {url}</code>
      </pre>
      <p>
        You are yourself there too: every call it makes is governed as the email you signed in with.
      </p>
    </div>
  );
}
