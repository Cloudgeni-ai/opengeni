/**
 * The readiness check for ready-made agents, apps and guided setups
 * (docs/agents.md#enable): whether each connection an item declares in its
 * `setup` is on among the connections the viewer can already use, and
 * whether the viewer may connect the ones that aren't. It reads the same
 * capability catalog and the same setup rule the Connect pages use, so
 * "Ask an admin" matches what the server allows.
 *
 * GitHub isn't a catalog item: it counts as connected when the workspace has
 * the GitHub App installed or the viewer has their own GitHub connected (as
 * the agent tools decide), and the viewer can connect it with `github:manage`
 * or when the deployment lets people connect their own GitHub.
 *
 * Every way a trigger is created or turned on (the API, Opengeni's own tools,
 * app sync) goes through `createValidatedScheduledTask` or
 * `validatedScheduledTaskUpdate`, which call `requireAgentTriggerReady`.
 */
import { HTTPException } from "hono/http-exception";
import {
  evaluateSetupReadiness,
  type AccessGrant,
  type CapabilityCatalogItem,
  type ReadyMadeSetup,
  type SetupConnection,
  type SetupConnectionFacts,
  type SetupMissing,
  type SetupReadiness,
} from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import { getAgent, listGitHubInstallationIdsForWorkspace, type Database } from "@opengeni/db";
import { withOrganizationIntegrationPolicyFence } from "@opengeni/db/organization-integration-policy";

import {
  hasIntegrationAdminPermission,
  hasIntegrationSetupPermission,
  hasPermission,
} from "../access";
import { agentTemplateByKey } from "../agent-templates";
import { buildCapabilityCatalog } from "./capabilities";
import { activePersonalGitHubConnection } from "./personal-github-reader";

type ReadinessDeps = { db: Database; settings: Settings };

/** The provider a template names for GitHub. */
export const GITHUB_SETUP_PROVIDER = "github.com";

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

/** GitHub for the viewer: connected here, and whether they can connect it. */
export type GitHubSetupFacts = { connected: boolean; canConnect: boolean };

/**
 * Whether the viewer may connect this item here: the Connect pages' rule.
 * Admins may; members may add what isn't on yet when their organization lets
 * them; anyone may sign in their own account to an item that is on; the
 * workspace GitHub App needs `github:manage`. An organization's connector
 * that is unavailable here is the organization admins' to fix.
 */
export function viewerCanConnectItem(
  item: CapabilityCatalogItem,
  rights: SetupViewerRights,
): boolean {
  if (item.surfaceType === "first_party_github") return rights.githubManage;
  if (item.lifecycle.managedBy === "organization" && item.lifecycle.readiness === "unavailable")
    return false;
  if (rights.integrationAdmin) return true;
  if (item.enabled) return item.actions.includes("connect") || item.actions.includes("repair");
  return rights.memberSetup;
}

/** The facts for one connection from the viewer's catalog, and GitHub's own facts. */
export function setupConnectionFacts(
  items: readonly CapabilityCatalogItem[],
  connection: SetupConnection,
  rights: SetupViewerRights,
  github: GitHubSetupFacts | null = null,
): SetupConnectionFacts {
  const matches = catalogItemsForConnection(items, connection);
  const ready = matches.find(catalogItemReady);
  if (ready) return { connected: true, canConnect: true, catalogItemId: ready.id };
  if (github && withinDomain(connection.provider.toLowerCase(), GITHUB_SETUP_PROVIDER)) {
    return { connected: github.connected, canConnect: github.canConnect, catalogItemId: null };
  }
  const connectable = matches.find((item) => viewerCanConnectItem(item, rights));
  return {
    connected: false,
    canConnect: connectable !== undefined,
    catalogItemId: (connectable ?? matches[0])?.id ?? null,
  };
}

export async function setupViewerRights(
  deps: Pick<ReadinessDeps, "db">,
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

/** GitHub here: the workspace's App installation, or the viewer's own GitHub. */
export async function githubSetupFacts(
  deps: ReadinessDeps,
  grant: AccessGrant,
  rights: Pick<SetupViewerRights, "githubManage">,
): Promise<GitHubSetupFacts> {
  const appConfigured = Boolean(
    deps.settings.githubAppId?.trim() && deps.settings.githubAppPrivateKey?.trim(),
  );
  const [installed, personal] = await Promise.all([
    appConfigured
      ? listGitHubInstallationIdsForWorkspace(deps.db, grant.workspaceId)
          .then((ids) => ids.length > 0)
          .catch(() => false)
      : false,
    grant.subjectId
      ? activePersonalGitHubConnection(deps, {
          workspaceId: grant.workspaceId,
          subjectId: grant.subjectId,
        })
          .then((connection) => connection !== null)
          .catch(() => false)
      : false,
  ]);
  return {
    connected: installed || personal,
    canConnect:
      (appConfigured && rights.githubManage) || deps.settings.githubPersonalOauthEnabled === true,
  };
}

type Setup = Pick<ReadyMadeSetup, "connections"> | null | undefined;

function needsGitHub(setups: readonly Setup[]): boolean {
  return setups.some((setup) =>
    (setup?.connections ?? []).some((connection) =>
      withinDomain(connection.provider.toLowerCase(), GITHUB_SETUP_PROVIDER),
    ),
  );
}

/**
 * The readiness of several items for the viewer, reading the catalog once
 * (the Agents list). An item that declares nothing is ready.
 */
export async function setupReadinessForMany(
  deps: ReadinessDeps,
  grant: AccessGrant,
  setups: readonly Setup[],
): Promise<SetupReadiness[]> {
  const declared = (setup: Setup) => Boolean(setup && setup.connections.length > 0);
  if (!setups.some(declared)) return setups.map((setup) => readyWithoutConnections(setup));
  const rights = await setupViewerRights(deps, grant);
  const [catalog, github] = await Promise.all([
    buildCapabilityCatalog({
      db: deps.db,
      workspaceId: grant.workspaceId,
      settings: deps.settings,
      subjectId: grant.subjectId,
      accountId: grant.accountId,
    }),
    needsGitHub(setups) ? githubSetupFacts(deps, grant, rights) : null,
  ]);
  return setups.map((setup) =>
    declared(setup)
      ? evaluateSetupReadiness(setup, (connection) =>
          setupConnectionFacts(catalog.items, connection, rights, github),
        )
      : readyWithoutConnections(setup),
  );
}

function readyWithoutConnections(setup: Setup): SetupReadiness {
  return evaluateSetupReadiness(setup, () => ({
    connected: true,
    canConnect: true,
    catalogItemId: null,
  }));
}

/** The readiness of one item for the viewer. */
export async function setupReadinessFor(
  deps: ReadinessDeps,
  grant: AccessGrant,
  setup: Setup,
): Promise<SetupReadiness> {
  const [readiness] = await setupReadinessForMany(deps, grant, [setup]);
  return readiness!;
}

/** The refusal's `cause`, which the API turns into `details`. */
export type AgentSetupIncompleteCause = {
  code: "agent_setup_incomplete";
  missing: SetupMissing[];
};

export function isAgentSetupIncompleteCause(value: unknown): value is AgentSetupIncompleteCause {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === "agent_setup_incomplete" &&
    Array.isArray((value as { missing?: unknown }).missing)
  );
}

/**
 * Whether an edit turns a trigger on for an agent: it becomes active, or an
 * active one now starts another agent. Only then is readiness checked.
 */
export function agentTriggerTurnsOn(input: {
  previousStatus: string;
  previousAgentId: string | null | undefined;
  nextStatus: string;
  nextAgentId: string | null | undefined;
}): boolean {
  return (
    input.nextStatus === "active" &&
    (input.previousStatus !== "active" ||
      (input.nextAgentId ?? null) !== (input.previousAgentId ?? null))
  );
}

/**
 * Keeps a ready-made agent's triggers off until its required connections are
 * on for the person turning one on: refuses with the reason in words (409,
 * `agent_setup_incomplete`). Only the template's required connections count;
 * an agent with no template, or a check that can't be read, never blocks.
 */
export async function requireAgentTriggerReady(
  deps: ReadinessDeps,
  grant: AccessGrant,
  agentId: string | null | undefined,
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
  const cause: AgentSetupIncompleteCause = {
    code: "agent_setup_incomplete",
    missing: readiness.missing,
  };
  throw new HTTPException(409, {
    message: readiness.reason ?? "This agent isn't ready to turn on yet.",
    cause,
  });
}
