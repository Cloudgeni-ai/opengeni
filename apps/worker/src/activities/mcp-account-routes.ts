import type { Settings } from "@opengeni/config";
import type {
  McpConnectionAccountBinding,
  ToolRef,
  ToolAuthNeededPayload,
} from "@opengeni/contracts";
import type { ApiIntegrationRuntime } from "@opengeni/db";

export function accountRouteAuthNeededPayload(
  payload: ToolAuthNeededPayload,
  bindings: readonly McpConnectionAccountBinding[] | null | undefined,
): ToolAuthNeededPayload {
  const binding = bindings?.find((candidate) => candidate.serverId === payload.serverId);
  return binding ? { ...payload, canonicalServerId: binding.canonicalServerId } : payload;
}

/** Expand only after canonical tool-policy admission. Aliases are execution
 * identities, never an alternate way to gain admission to a connector. */
export function expandMcpAccountRoutes(input: {
  settings: Settings;
  tools: ToolRef[];
  bindings: readonly McpConnectionAccountBinding[] | null | undefined;
}): { settings: Settings; tools: ToolRef[]; accountLabels: ReadonlyMap<string, string> } {
  // Only historical work has no binding snapshot. A present empty snapshot is
  // an explicit lack of account authority, never a request for current defaults.
  if (input.bindings == null) {
    return { settings: input.settings, tools: input.tools, accountLabels: new Map() };
  }
  const configured = new Map(input.settings.mcpServers.map((server) => [server.id, server]));
  const byCanonical = new Map<string, McpConnectionAccountBinding[]>();
  const routes = new Set<string>();
  const accounts = new Set<string>();
  for (const binding of input.bindings) {
    const account = JSON.stringify([binding.canonicalServerId, binding.connectionId]);
    if (
      routes.has(binding.serverId) ||
      accounts.has(account) ||
      configured.has(binding.serverId) ||
      (binding.subjectScope === "subject") !== (binding.ownerSubjectId !== null) ||
      binding.connectionRef.authoritySource === "host" ||
      binding.connectionRef.connectionId !== binding.connectionId ||
      binding.connectionRef.subjectScope !== binding.subjectScope ||
      binding.connectionRef.providerDomain !== binding.providerDomain ||
      binding.connectionRef.kind !== binding.kind
    ) {
      throw new Error("Invalid accepted MCP account route");
    }
    routes.add(binding.serverId);
    accounts.add(account);
    const siblings = byCanonical.get(binding.canonicalServerId) ?? [];
    siblings.push(binding);
    byCanonical.set(binding.canonicalServerId, siblings);
  }
  const servers: Settings["mcpServers"] = [];
  const tools: ToolRef[] = [];
  const accountLabels = new Map<string, string>();
  for (const tool of input.tools) {
    const bindings = byCanonical.get(tool.id);
    if (!bindings) {
      if (!configured.get(tool.id)?.connectionRef) tools.push(tool);
      continue;
    }
    const canonical = configured.get(tool.id);
    if (!canonical?.connectionRef) {
      throw new Error("Accepted MCP account route has no canonical connection configuration");
    }
    for (const binding of bindings) {
      if (
        canonical.connectionRef.authoritySource === "host" ||
        canonical.connectionRef.providerDomain !== binding.providerDomain ||
        (canonical.connectionRef.kind && canonical.connectionRef.kind !== binding.kind)
      ) {
        throw new Error("Accepted MCP account route does not match canonical provider");
      }
      // Static headers can belong to the formerly selected account. Credentials
      // for account-qualified routes come exclusively from the native resolver.
      const { headers: _headers, ...config } = canonical;
      const label = `${canonical.name ?? canonical.id} — ${binding.subjectScope === "subject" ? "Personal" : "Workspace"}: ${binding.accountLabel}`;
      servers.push({
        ...config,
        id: binding.serverId,
        name: label,
        connectionRef: structuredClone(binding.connectionRef),
      });
      tools.push({ ...tool, id: binding.serverId });
      accountLabels.set(binding.serverId, label);
    }
  }
  return {
    settings: {
      ...input.settings,
      mcpServers: [
        ...input.settings.mcpServers.filter((server) => !server.connectionRef),
        ...servers,
      ],
    },
    tools,
    accountLabels,
  };
}

/** Each adapter closes over its own immutable credential ref and authority
 * generation. Sharing a provider transport never shares a credential resolver. */
export function expandApiIntegrationAccountRoutes(input: {
  integrations: readonly ApiIntegrationRuntime[];
  bindings: readonly McpConnectionAccountBinding[] | null | undefined;
  tools: readonly ToolRef[];
}): ApiIntegrationRuntime[] {
  const selected = new Set(input.tools.map((tool) => tool.id));
  if (input.bindings == null)
    return input.integrations.filter((item) => selected.has(item.serverId));
  const acceptedBindings = input.bindings;
  return input.integrations.flatMap((integration) => {
    const bindings = acceptedBindings.filter(
      (binding) => binding.canonicalServerId === integration.serverId,
    );
    if (bindings.length === 0)
      return !integration.connectionRef && selected.has(integration.serverId) ? [integration] : [];
    return bindings
      .filter((binding) => selected.has(binding.serverId))
      .map((binding) => {
        if (binding.connectionAuthorityGeneration === undefined) {
          throw new Error("Accepted API integration account route has no authority generation");
        }
        return {
          ...integration,
          serverId: binding.serverId,
          connectionRef: structuredClone(binding.connectionRef),
          connectionAuthorityGeneration: binding.connectionAuthorityGeneration,
        };
      });
  });
}
