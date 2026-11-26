/**
 * The readiness check for ready-made agents, apps and guided setups
 * (docs/agents.md#enable): whether each connection an item declares in its
 * `setup` is on among the connections the viewer can already use, and
 * whether the viewer may connect the ones that aren't. It reads the same
 * capability catalog and the same setup rule the Connect pages use, so
 * "Ask an admin" matches what the server allows.
 */
import {
  evaluateSetupReadiness,
  type AccessGrant,
  type CapabilityCatalogItem,
  type ReadyMadeSetup,
  type SetupConnection,
  type SetupConnectionFacts,
  type SetupReadiness,
} from "@opengeni/contracts";
import {
  buildCapabilityCatalog,
  agentTemplateByKey,
  hasIntegrationAdminPermission,
  hasIntegrationSetupPermission,
  hasPermission,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getAgent } from "@opengeni/db";
import { withOrganizationIntegrationPolicyFence } from "@opengeni/db/organization-integration-policy";

import { ApiHttpError } from "./http/api-error";

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizedUrl(url: string | null | undefined): string {
  return (url ?? "").trim().replace(/\/+$/u, "").toLowerCase();
}

function withinDomain(host: string | null, domain: string): boolean {
  return host !== null && (host === domain || host.endsWith(`.${domain}`));
}

/** Catalog items that are this connection: its MCP address, or any item of its provider's domain. */
export function catalogItemsForConnection(
  items: readonly CapabilityCatalogItem[],
  connection: Pick<SetupConnection, "provider" | "mcpUrl">,
): CapabilityCatalogItem[] {
  const wantedUrl = connection.mcpUrl ? normalizedUrl(connection.mcpUrl) : null;
  return items.filter(
    (item) =>
      (wantedUrl !== null && normalizedUrl(item.mcpUrl ?? item.endpointUrl) === wantedUrl) ||
      withinDomain(item.providerDomain?.toLowerCase() ?? null, connection.provider) ||
      withinDomain(hostOf(item.mcpUrl ?? item.endpointUrl), connection.provider),
  );
}

export function catalogItemReady(item: CapabilityCatalogItem): boolean {
  return item.enabled && item.lifecycle.readiness === "ready";
}

export type SetupViewerRights = {
  /** `capabilities:manage`. */
  integrationAdmin: boolean;
  /** Members' setup permission, with the organization's member setup policy applied. */
  memberSetup: boolean;
  /** `github:manage`, for the workspace's GitHub App. */
  githubManage: boolean;
};

/**
 * Whether the viewer may connect this item here: the Connect pages' rule.
 * Admins may; members may add what isn't on yet when their organization lets
 * them; anyone may sign in their own account to an item that is on; the
 * workspace GitHub App needs `github:manage`.
 */
export function viewerCanConnectItem(
  item: CapabilityCatalogItem,
  rights: SetupViewerRights,
): boolean {
  if (item.surfaceType === "first_party_github") return rights.githubManage;
  if (rights.integrationAdmin) return true;
  if (item.enabled) return item.actions.includes("connect") || item.actions.includes("repair");
  return rights.memberSetup;
}

/** The facts for one connection from the viewer's catalog. */
export function setupConnectionFacts(
  items: readonly CapabilityCatalogItem[],
  connection: SetupConnection,
  rights: SetupViewerRights,
): SetupConnectionFacts {
  const matches = catalogItemsForConnection(items, connection);
  const ready = matches.find(catalogItemReady);
  if (ready) return { connected: true, canConnect: true, catalogItemId: ready.id };
  const connectable = matches.find((item) => viewerCanConnectItem(item, rights));
  return {
    connected: false,
    canConnect: connectable !== undefined,
    catalogItemId: (connectable ?? matches[0])?.id ?? null,
  };
}

export async function setupViewerRights(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
): Promise<SetupViewerRights> {
  const policy = await withOrganizationIntegrationPolicyFence(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    async (_tx, value) => value.personalIntegrationSetup,
  ).catch(() => undefined);
  return {
    integrationAdmin: hasIntegrationAdminPermission(grant),
    memberSetup: hasIntegrationSetupPermission(grant) && policy !== "admins",
    githubManage: hasPermission(grant.permissions, "github:manage", grant.permissionMode),
  };
}

/** The readiness of an item for the viewer. An item that declares nothing is ready. */
export async function setupReadinessFor(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  grant: AccessGrant,
  setup: Pick<ReadyMadeSetup, "connections"> | null | undefined,
): Promise<SetupReadiness> {
  if (!setup || setup.connections.length === 0)
    return evaluateSetupReadiness(setup, () => ({
      connected: true,
      canConnect: true,
      catalogItemId: null,
    }));
  const [catalog, rights] = await Promise.all([
    buildCapabilityCatalog({
      db: deps.db,
      workspaceId: grant.workspaceId,
      settings: deps.settings,
      subjectId: grant.subjectId,
      accountId: grant.accountId,
    }),
    setupViewerRights(deps, grant),
  ]);
  return evaluateSetupReadiness(setup, (connection) =>
    setupConnectionFacts(catalog.items, connection, rights),
  );
}

/** The agent a create or update request's trigger starts, when it names one. */
export function triggerAgentIdOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const config = (payload as { agentConfig?: unknown }).agentConfig;
  if (!config || typeof config !== "object") return null;
  const agentId = (config as { agentId?: unknown }).agentId;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : null;
}

/**
 * Keeps a ready-made agent's triggers off until its required connections are
 * on for the person turning one on: refuses with the reason in words. Only
 * the template's required connections count; an agent with no template, or a
 * check that can't be read, never blocks.
 */
export async function requireAgentTriggerReady(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  grant: AccessGrant,
  agentId: string | null,
): Promise<void> {
  if (!agentId) return;
  let readiness: SetupReadiness;
  try {
    const agent = await getAgent(
      deps.db,
      { accountId: grant.accountId, workspaceId: grant.workspaceId },
      agentId,
    );
    const setup = agent?.templateKey ? agentTemplateByKey(agent.templateKey)?.setup : null;
    if (!setup || !setup.connections.some((connection) => connection.required)) return;
    readiness = await setupReadinessFor(deps, grant, setup);
  } catch {
    return;
  }
  if (readiness.ready) return;
  throw new ApiHttpError(409, {
    code: "conflict",
    message: readiness.reason ?? "This agent isn't ready to turn on yet.",
    retryable: false,
    details: { code: "agent_setup_incomplete", missing: readiness.missing },
  });
}
