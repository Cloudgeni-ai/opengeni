import type { AccessGrant } from "@opengeni/contracts";

/** The chat whose route reaches a browser or Desktop on Connected Machine
 * `machineId`: the chat that opened it while that chat works there, or else
 * the agent chat now using it from that machine (a child given its parent's
 * browser or Desktop, say). Null when neither works there. */
export function connectedInteractionRouteSession<S extends { activeSandboxId?: string | null }>(
  machineId: string,
  source: S | null,
  caller: S | null,
): S | null {
  if (source?.activeSandboxId === machineId) return source;
  if (caller?.activeSandboxId === machineId) return caller;
  return null;
}

/** The agent chat a grant acts for, or null for a person or service. */
export function agentCallerSessionId(grant: AccessGrant): string | null {
  if (grant.principalKind !== "agent_attempt") return null;
  const sessionId = grant.metadata?.["sessionId"];
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}
