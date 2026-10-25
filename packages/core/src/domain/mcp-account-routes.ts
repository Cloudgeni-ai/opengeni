import type { Settings } from "@opengeni/config";
import type {
  McpAccountRouteLabel,
  McpConnectionAccountBinding,
  ToolRef,
} from "@opengeni/contracts";
import type { ApiIntegrationRuntime } from "@opengeni/db";
import { integrationDefinitionCategory } from "./capabilities";

const ACCOUNT_SCOPE_SUFFIX = / · (?:Only me|This workspace)$/u;

/**
 * The kind of need an account serves: its connector's catalog category. The
 * catalog's default category ("integrations") and the one every custom server
 * gets ("custom") say where a server came from, not what it is for, so they
 * are no kind.
 */
export function connectedAccountKind(category: string | null | undefined): string | undefined {
  return category && category !== "integrations" && category !== "custom" ? category : undefined;
}

/** "alice@example.com · Only me" → "alice@example.com". */
export function accountIdentity(binding: McpConnectionAccountBinding): string {
  return binding.accountLabel.replace(ACCOUNT_SCOPE_SUFFIX, "") || binding.accountLabel;
}

/**
 * The labels of one connector's accounts in a turn. People only need the
 * account to tell several apart. Two accounts with the same identity (personal
 * and workspace) keep their scope to stay distinct.
 */
function accountRouteLabels(
  connector: string,
  bindings: readonly McpConnectionAccountBinding[],
  kind?: string,
): McpAccountRouteLabel[] {
  const identities = bindings.map(accountIdentity);
  return bindings.map((binding, index) => {
    const identity = identities[index]!;
    const account =
      bindings.length < 2
        ? undefined
        : identities.indexOf(identity) === identities.lastIndexOf(identity)
          ? identity
          : binding.accountLabel;
    return {
      model: `${connector} — ${binding.subjectScope === "subject" ? "Personal" : "Workspace"}: ${binding.accountLabel}`,
      connector,
      providerDomain: binding.providerDomain,
      ...(account ? { account } : {}),
      ...(kind ? { kind } : {}),
    };
  });
}

/** Expand only after canonical tool-policy admission. Aliases are execution
 * identities, never an alternate way to gain admission to a connector. */
export function expandMcpAccountRoutes(input: {
  settings: Settings;
  tools: ToolRef[];
  bindings: readonly McpConnectionAccountBinding[] | null | undefined;
  /** Catalog categories by canonical server ID, naming the need each connector serves. */
  categories?: ReadonlyMap<string, string>;
}): {
  settings: Settings;
  tools: ToolRef[];
  accountLabels: ReadonlyMap<string, McpAccountRouteLabel>;
} {
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
  const accountLabels = new Map<string, McpAccountRouteLabel>();
  for (const tool of input.tools) {
    const bindings = byCanonical.get(tool.id);
    const canonical = configured.get(tool.id);
    // A connector reconfigured after acceptance (removed, made public, or moved
    // to another provider) drops its frozen account routes. The route is
    // never rebound to the new configuration, and the rest of the turn keeps
    // its other tools instead of failing on one stale connector.
    if (!bindings || !canonical?.connectionRef) {
      if (!canonical?.connectionRef) tools.push(tool);
      continue;
    }
    const usable = bindings.filter(
      (binding) =>
        canonical.connectionRef!.authoritySource !== "host" &&
        canonical.connectionRef!.providerDomain === binding.providerDomain &&
        (!canonical.connectionRef!.kind || canonical.connectionRef!.kind === binding.kind),
    );
    const connector = canonical.name ?? canonical.id;
    const labels = accountRouteLabels(
      connector,
      usable,
      connectedAccountKind(input.categories?.get(canonical.id)),
    );
    for (const [index, binding] of usable.entries()) {
      // Static headers can belong to the formerly selected account. Credentials
      // for account-qualified routes come exclusively from the native resolver.
      const { headers: _headers, ...config } = canonical;
      const label = labels[index]!;
      servers.push({
        ...config,
        id: binding.serverId,
        name: label.model,
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

/**
 * Account labels for the API integration routes `expandApiIntegrationAccountRoutes`
 * selects, keyed by route server ID, labelled the same way as connector routes.
 */
export function apiIntegrationAccountLabels(input: {
  integrations: readonly ApiIntegrationRuntime[];
  bindings: readonly McpConnectionAccountBinding[] | null | undefined;
  tools: readonly ToolRef[];
}): ReadonlyMap<string, McpAccountRouteLabel> {
  const labels = new Map<string, McpAccountRouteLabel>();
  if (input.bindings == null) return labels;
  const selected = new Set(input.tools.map((tool) => tool.id));
  for (const integration of input.integrations) {
    const usable = input.bindings.filter(
      (binding) =>
        binding.canonicalServerId === integration.serverId && selected.has(binding.serverId),
    );
    const routeLabels = accountRouteLabels(
      integration.name,
      usable,
      connectedAccountKind(
        integration.definitionProvenance === "curated"
          ? integrationDefinitionCategory(integration.definitionId)
          : undefined,
      ),
    );
    for (const [index, binding] of usable.entries())
      labels.set(binding.serverId, routeLabels[index]!);
  }
  return labels;
}
