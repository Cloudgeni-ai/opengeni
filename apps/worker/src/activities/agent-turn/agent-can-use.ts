import {
  agentToolPermissionRuleFor,
  type AgentToolPermission,
  type AgentToolPermissionRule,
} from "@opengeni/contracts";
import type { ConnectorActionAgentRule, ConnectorActionToolCall } from "@opengeni/runtime";
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
export type AgentCanUseRuleSet = {
  /** The agent the rules belong to, named when one of them decides a call. */
  agent: { id: string; name: string } | null;
  rules: readonly AgentToolPermissionRule[];
};

export type AgentCanUse = {
  ruleSets: readonly AgentCanUseRuleSet[];
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
  /** Per agent; a plain rule list has no agent to name. */
  ruleSets: readonly (AgentCanUseRuleSet | readonly AgentToolPermissionRule[])[];
  bindings:
    | readonly { serverId: string; canonicalServerId: string; providerDomain?: string | null }[]
    | null
    | undefined;
  servers: readonly {
    id: string;
    connectionRef?: { providerDomain?: string | null } | null | undefined;
  }[];
}): AgentCanUse | null {
  const ruleSets = input.ruleSets
    .map((set): AgentCanUseRuleSet => ("rules" in set ? set : { agent: null, rules: set }))
    .filter((set) => set.rules.length > 0);
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
  return agentCanUseMatch(canUse, call)?.rule.permission ?? null;
}

/**
 * The strictest agent's deciding rule for one call, with that agent; the
 * first agent of the chain on a tie. Null when no rule names the call.
 */
export function agentCanUseMatch(
  canUse: AgentCanUse,
  call: Pick<ConnectorActionToolCall, "serverId" | "toolName">,
): { agent: AgentCanUseRuleSet["agent"]; rule: AgentToolPermissionRule } | null {
  let strictest: { agent: AgentCanUseRuleSet["agent"]; rule: AgentToolPermissionRule } | null =
    null;
  for (const set of canUse.ruleSets) {
    const rule = ruleSetDecision(canUse, set.rules, call);
    if (
      rule !== null &&
      (strictest === null || STRICTNESS[rule.permission] > STRICTNESS[strictest.rule.permission])
    ) {
      strictest = { agent: set.agent, rule };
    }
  }
  return strictest;
}

function ruleSetDecision(
  canUse: AgentCanUse,
  rules: readonly AgentToolPermissionRule[],
  call: Pick<ConnectorActionToolCall, "serverId" | "toolName">,
): AgentToolPermissionRule | null {
  const route = canUse.routes.get(call.serverId);
  const serverId = route?.canonicalServerId ?? call.serverId;
  const providerDomain = route?.providerDomain ?? canUse.providerDomains.get(serverId) ?? null;
  return (
    agentToolPermissionRuleFor(rules, { serverId, providerDomain, toolName: call.toolName }) ??
    // A rule may name the route itself.
    (serverId !== call.serverId
      ? agentToolPermissionRuleFor(rules, {
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
  const match = agentCanUseMatch(canUse, call);
  const decision = match?.rule.permission ?? null;
  if (match === null || decision === null || decision === "allow") return call;
  // A stricter floor the call already had keeps its own reason.
  const agentDecides = !(call.minimumDecision === "block" && decision === "ask");
  const by: ConnectorActionAgentRule | null =
    agentDecides && match.agent
      ? {
          agentId: match.agent.id,
          agentName: match.agent.name,
          connector: match.rule.connector,
          tool: match.rule.tool,
          permission: decision,
        }
      : null;
  return {
    ...call,
    minimumDecision: call.minimumDecision === "block" ? "block" : decision,
    ...(by ? { minimumDecisionBy: by } : {}),
    ...(call.connectionId?.trim() ? {} : { connectionId: `agent-can-use:${call.serverId}` }),
  };
}
