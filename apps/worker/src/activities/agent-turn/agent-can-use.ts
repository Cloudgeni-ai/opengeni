import {
  agentToolPermissionFor,
  type AgentToolPermission,
  type AgentToolPermissionRule,
} from "@opengeni/contracts";
import type { ConnectorActionToolCall } from "@opengeni/runtime";
import {
  GITHUB_REST_MCP_APP_SERVER_ID,
  GITHUB_REST_MCP_PERSONAL_SERVER_ID,
} from "@opengeni/runtime/github-rest-mcp";

/**
 * An agent's Can use (docs/agents.md) applied to one attempt's connector
 * calls: native connectors, MCP servers and gateway connections all reach
 * the same policy hooks, so one floor covers every connection type. Rules
 * only make a call stricter than the connection's own settings: Ask first
 * asks the person, Block refuses, Allow follows the connection. A chat
 * running under several agents (one delegated to another) gets the
 * strictest choice of any of them.
 */
export type AgentCanUse = {
  ruleSets: readonly (readonly AgentToolPermissionRule[])[];
  /** Account-route server ids to the connector they route, with its provider. */
  routes: ReadonlyMap<string, { canonicalServerId: string; providerDomain: string | null }>;
  /** Provider domains of configured servers, by canonical id. */
  providerDomains: ReadonlyMap<string, string>;
};

/**
 * Opengeni's own GitHub tools (`github_app`, `github_personal`) have no
 * connection reference; a `github.com` rule names them too.
 */
const BUILT_IN_PROVIDER_DOMAINS: ReadonlyMap<string, string> = new Map([
  [GITHUB_REST_MCP_APP_SERVER_ID, "github.com"],
  [GITHUB_REST_MCP_PERSONAL_SERVER_ID, "github.com"],
]);

const STRICTNESS: Record<AgentToolPermission, number> = { allow: 0, ask: 1, block: 2 };

export function agentCanUseFor(input: {
  ruleSets: readonly (readonly AgentToolPermissionRule[])[];
  bindings:
    | readonly { serverId: string; canonicalServerId: string; providerDomain?: string | null }[]
    | null
    | undefined;
  servers: readonly {
    id: string;
    connectionRef?: { providerDomain?: string | null } | null | undefined;
  }[];
}): AgentCanUse | null {
  const ruleSets = input.ruleSets.filter((rules) => rules.length > 0);
  if (ruleSets.length === 0) return null;
  const routes = new Map<string, { canonicalServerId: string; providerDomain: string | null }>();
  const providerDomains = new Map<string, string>(BUILT_IN_PROVIDER_DOMAINS);
  for (const binding of input.bindings ?? []) {
    routes.set(binding.serverId, {
      canonicalServerId: binding.canonicalServerId,
      providerDomain: binding.providerDomain ?? null,
    });
    if (binding.providerDomain) {
      providerDomains.set(binding.canonicalServerId, binding.providerDomain);
    }
  }
  for (const server of input.servers) {
    const domain = server.connectionRef?.providerDomain;
    if (domain && !providerDomains.has(server.id)) providerDomains.set(server.id, domain);
  }
  return { ruleSets, routes, providerDomains };
}

/** The strictest agent's choice for one call, or null when no rule names it. */
export function agentCanUseDecision(
  canUse: AgentCanUse,
  call: Pick<ConnectorActionToolCall, "serverId" | "toolName">,
): AgentToolPermission | null {
  let strictest: AgentToolPermission | null = null;
  for (const rules of canUse.ruleSets) {
    const decision = ruleSetDecision(canUse, rules, call);
    if (decision !== null && (strictest === null || STRICTNESS[decision] > STRICTNESS[strictest])) {
      strictest = decision;
    }
  }
  return strictest;
}

function ruleSetDecision(
  canUse: AgentCanUse,
  rules: readonly AgentToolPermissionRule[],
  call: Pick<ConnectorActionToolCall, "serverId" | "toolName">,
): AgentToolPermission | null {
  const route = canUse.routes.get(call.serverId);
  const serverId = route?.canonicalServerId ?? call.serverId;
  const providerDomain = route?.providerDomain ?? canUse.providerDomains.get(serverId) ?? null;
  return (
    agentToolPermissionFor(rules, { serverId, providerDomain, toolName: call.toolName }) ??
    // A rule may name the route itself.
    (serverId !== call.serverId
      ? agentToolPermissionFor(rules, {
          serverId: call.serverId,
          providerDomain,
          toolName: call.toolName,
        })
      : null)
  );
}

/**
 * The call with the agent's floor: unchanged for Allow or no rule. A call
 * without a connection identity gets the agent's own, so its Ask or Block
 * still has a ledger record to wait on or refuse with.
 */
export function withAgentCanUse<Call extends ConnectorActionToolCall>(
  canUse: AgentCanUse | null,
  call: Call,
): Call {
  if (!canUse) return call;
  const decision = agentCanUseDecision(canUse, call);
  if (decision === null || decision === "allow") return call;
  return {
    ...call,
    minimumDecision: call.minimumDecision === "block" ? "block" : decision,
    ...(call.connectionId?.trim() ? {} : { connectionId: `agent-can-use:${call.serverId}` }),
  };
}
