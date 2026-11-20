/**
 * In-process requests the organization MCP server's `tool_call` makes for a
 * connected outside agent. Such a call may use an approval the same person
 * gave in the browser for this exact operation, from the link the agent
 * showed them, without the approval token (which only the browser saw). The
 * mark lives on the exact Request object in process memory; nothing a client
 * sends can set it.
 */
const claims = new WeakSet<Request>();

export function markStoredApprovalClaim(request: Request): void {
  claims.add(request);
}

export function claimsStoredApproval(request: Request): boolean {
  return claims.has(request);
}
