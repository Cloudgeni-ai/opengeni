/**
 * The readiness check for ready-made agents, apps and guided setups
 * (docs/agents.md#enable): whether each connection an item declares in its
 * `setup` is on among the connections the viewer can already use, and
 * whether the viewer may connect the ones that aren't. Who may connect is
 * the Connect pages' own rule (`catalogItemConnectable` in contracts), so
 * "Ask an admin" matches what those pages offer.
 *
 * GitHub isn't a catalog item. For a trigger on GitHub events (a pull
 * request opened, an issue labelled, a mention) only the workspace's GitHub
 * App delivers them, so only the App counts. Anything else (a schedule, by
 * hand) also accepts the viewer's own GitHub. The App is connected by
 * `github:manage`; one's own GitHub when the deployment allows it.
 *
 * Every way a trigger is created or turned on (the API, Opengeni's own tools,
 * app sync, an admin's resume) goes through core functions that call
 * `requireAgentTriggerReady`.
 */
import { HTTPException } from "hono/http-exception";
import {
  evaluateSetupReadiness,
  type AccessGrant,
  type AgentTemplate,
  type CapabilityCatalogItem,
  type ReadyMadeSetup,
  type ScheduledTask,
  type SetupConnection,
  type SetupConnectionFacts,
  type SetupMissing,
  type SetupReadiness,
} from "@opengeni/contracts";
import {
  catalogItemConnectable,
  type MemberIntegrationSetup,
} from "@opengeni/contracts/personal-integration-setup";
import type { Settings } from "@opengeni/config";
import {
  getAgent,
  getEventSource,
  listScheduledTasks,
  hasAuditableGitHubInstallationAuthority,
  listGitHubInstallationAccessForWorkspace,
  type Database,
} from "@opengeni/db";
import { withOrganizationIntegrationPolicyFence } from "@opengeni/db/organization-integration-policy";
import type { Observability } from "@opengeni/observability";

import { hasPermission } from "../access";
import { agentTemplateByKey } from "../agent-templates";
import { buildCapabilityCatalog } from "./capabilities";
import { activePersonalGitHubConnection } from "./personal-github-reader";

type ReadinessDeps = {
  db: Database;
  settings: Settings;
  /**
   * Whether the workspace's GitHub App binding is active, read live the way
   * the GitHub integration page reads it (suspended or removed doesn't
   * count). The API passes it; without it, the stored binding is read.
   */
  githubAppBound?: ((workspaceId: string) => Promise<boolean>) | undefined;
};

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

function isGitHub(connection: Pick<SetupConnection, "provider">): boolean {
  return withinDomain(connection.provider.toLowerCase(), GITHUB_SETUP_PROVIDER);
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
  /** The viewer's grant, as the Connect pages read it. */
  grant: Pick<AccessGrant, "permissions" | "permissionMode">;
  /** The organization's member setup policy. */
  memberIntegrationSetup: MemberIntegrationSetup | undefined;
  /** `github:manage`, for the workspace's GitHub App. */
  githubManage: boolean;
};

/** GitHub for the viewer: what is connected here, and what they can connect. */
export type GitHubSetupFacts = {
  /** The workspace's GitHub App is installed. */
  appInstalled: boolean;
  /** The viewer has their own GitHub connected. */
  personalConnected: boolean;
  canConnectApp: boolean;
  canConnectPersonal: boolean;
};

/** What the check is for: a trigger on GitHub events needs the GitHub App. */
export type SetupCheckPurpose = { githubEvents?: boolean | undefined };

/**
 * Whether the viewer may connect this item here: the Connect pages' rule
 * (`catalogItemConnectable`), plus the workspace GitHub App, which needs
 * `github:manage`. An organization's connector that is unavailable here is
 * the organization admins' to fix.
 */
export function viewerCanConnectItem(
  item: CapabilityCatalogItem,
  rights: SetupViewerRights,
): boolean {
  if (item.surfaceType === "first_party_github") return rights.githubManage;
  if (item.lifecycle.managedBy === "organization" && item.lifecycle.readiness === "unavailable")
    return false;
  return catalogItemConnectable(rights.grant, item, rights.memberIntegrationSetup);
}

/** The facts for one connection from the viewer's catalog and GitHub's own facts. */
export function setupConnectionFacts(
  items: readonly CapabilityCatalogItem[],
  connection: SetupConnection,
  rights: SetupViewerRights,
  github: GitHubSetupFacts | null = null,
  purpose: SetupCheckPurpose = {},
): SetupConnectionFacts {
  const matches = catalogItemsForConnection(items, connection);
  const ready = matches.find(catalogItemReady);
  if (github && isGitHub(connection)) {
    if (purpose.githubEvents) {
      return {
        connected: github.appInstalled,
        canConnect: github.canConnectApp,
        catalogItemId: null,
        connectVia: github.canConnectApp ? "github_app" : null,
      };
    }
    if (github.appInstalled || github.personalConnected || ready) {
      return { connected: true, canConnect: true, catalogItemId: ready?.id ?? null };
    }
    return {
      connected: false,
      canConnect: github.canConnectApp || github.canConnectPersonal,
      catalogItemId: null,
      connectVia: github.canConnectApp
        ? "github_app"
        : github.canConnectPersonal
          ? "github_personal"
          : null,
    };
  }
  if (ready) return { connected: true, canConnect: true, catalogItemId: ready.id };
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
    grant,
    memberIntegrationSetup: policy === "admins" ? "admins" : policy ? "members" : undefined,
    githubManage: hasPermission(grant.permissions, "github:manage", grant.permissionMode),
  };
}

/**
 * The GitHub App is fully set up on this deployment: the same settings as
 * `githubAppMissingSettings` in `@opengeni/github` (a parity test keeps them
 * equal).
 */
export function githubAppConfigured(
  settings: Pick<
    Settings,
    | "githubAppId"
    | "githubClientId"
    | "githubClientSecret"
    | "githubAppSlug"
    | "githubAppPrivateKey"
  >,
): boolean {
  return [
    settings.githubAppId,
    settings.githubClientId,
    settings.githubClientSecret,
    settings.githubAppSlug,
    settings.githubAppPrivateKey,
  ].every((value) => Boolean(value?.trim()));
}

/** Without a live reader: a stored binding with its owner's proof and repositories. */
async function storedGitHubAppBound(db: Database, workspaceId: string): Promise<boolean> {
  const installations = await listGitHubInstallationAccessForWorkspace(db, workspaceId);
  return installations.some(hasAuditableGitHubInstallationAuthority);
}

/** GitHub here: the workspace's App installation, and the viewer's own GitHub. */
export async function githubSetupFacts(
  deps: ReadinessDeps,
  grant: AccessGrant,
  rights: Pick<SetupViewerRights, "githubManage">,
): Promise<GitHubSetupFacts> {
  const appConfigured = githubAppConfigured(deps.settings);
  const [appInstalled, personalConnected] = await Promise.all([
    appConfigured
      ? (deps.githubAppBound
          ? deps.githubAppBound(grant.workspaceId)
          : storedGitHubAppBound(deps.db, grant.workspaceId)
        ).catch(() => false)
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
    appInstalled,
    personalConnected,
    canConnectApp: appConfigured && rights.githubManage,
    canConnectPersonal: deps.settings.githubPersonalOauthEnabled === true,
  };
}

/**
 * Whether a ready-made agent's trigger runs on GitHub events: the named
 * suggested trigger, or the one Enable turns on by default (its first
 * one-click suggestion, else its first).
 */
export function templateTriggerUsesGitHubEvents(
  template: Pick<AgentTemplate, "suggestedTriggers">,
  triggerName?: string | null,
): boolean {
  const trigger = triggerName
    ? template.suggestedTriggers.find((entry) => entry.name === triggerName)
    : (template.suggestedTriggers.find((entry) => entry.oneClick) ?? template.suggestedTriggers[0]);
  return (trigger?.triggers ?? []).some((entry) => entry.source.kind === "github");
}

type Setup = Pick<ReadyMadeSetup, "connections"> | null | undefined;

function needsGitHub(setups: readonly Setup[]): boolean {
  return setups.some((setup) => (setup?.connections ?? []).some(isGitHub));
}

/**
 * The readiness of several items for the viewer, reading the catalog once
 * (the Agents list). An item that declares nothing is ready.
 */
export async function setupReadinessForMany(
  deps: ReadinessDeps,
  grant: AccessGrant,
  setups: readonly Setup[],
  purposes: readonly SetupCheckPurpose[] = [],
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
  return setups.map((setup, index) =>
    declared(setup)
      ? evaluateSetupReadiness(setup, (connection) =>
          setupConnectionFacts(catalog.items, connection, rights, github, purposes[index]),
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
  purpose: SetupCheckPurpose = {},
): Promise<SetupReadiness> {
  const [readiness] = await setupReadinessForMany(deps, grant, [setup], [purpose]);
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Whether a trigger's event triggers include GitHub events. A requested
 * trigger names its source by id (a ready source's key is never GitHub); a
 * stored one carries the source's kind.
 */
export async function eventTriggersUseGitHub(
  db: Database,
  workspaceId: string,
  triggers: readonly { sourceId: string; sourceKind?: string | undefined }[] | null | undefined,
): Promise<boolean> {
  for (const trigger of triggers ?? []) {
    if (trigger.sourceKind !== undefined) {
      if (trigger.sourceKind === "github") return true;
      continue;
    }
    if (!UUID.test(trigger.sourceId)) continue;
    const source = await getEventSource(db, workspaceId, trigger.sourceId);
    if (source?.kind === "github") return true;
  }
  return false;
}

/**
 * What each agent's readiness is for: GitHub events when any of its own
 * triggers here runs on them; with no trigger yet, the one Enable turns on
 * by default. So a Bug fixer with only a schedule and the person's own
 * GitHub reads as ready. One read of the workspace's triggers for all.
 */
export async function agentsReadinessPurposes(
  db: Database,
  workspaceId: string,
  viewerSubjectId: string | null,
  agents: readonly { id: string; templateKey?: string | null | undefined }[],
): Promise<SetupCheckPurpose[]> {
  const templated = agents.filter((agent) => agent.templateKey);
  if (templated.length === 0) return agents.map(() => ({ githubEvents: false }));
  const wanted = new Set(templated.map((agent) => agent.id));
  const tasks =
    templated.length === 1
      ? await listScheduledTasks(db, workspaceId, 100, 0, undefined, viewerSubjectId, {
          agentId: templated[0]!.id,
        })
      : await listScheduledTasks(db, workspaceId, 500, 0, undefined, viewerSubjectId);
  const triggersByAgent = new Map<string, ScheduledTask[]>();
  for (const task of tasks) {
    const agentId = task.agentConfig.agentId;
    if (!agentId || !wanted.has(agentId)) continue;
    triggersByAgent.set(agentId, [...(triggersByAgent.get(agentId) ?? []), task]);
  }
  return await Promise.all(
    agents.map(async (agent) => {
      const template = agent.templateKey ? agentTemplateByKey(agent.templateKey) : undefined;
      if (!template) return { githubEvents: false };
      const own = triggersByAgent.get(agent.id);
      if (!own?.length) return { githubEvents: templateTriggerUsesGitHubEvents(template) };
      for (const task of own) {
        if (await eventTriggersUseGitHub(db, workspaceId, task.events?.triggers))
          return { githubEvents: true };
      }
      return { githubEvents: false };
    }),
  );
}

/** Counts readiness checks that couldn't run, so an outage shows (the API wires it). */
let uncheckedSink: Pick<Observability, "incrementCounter"> | null = null;
export function setSetupReadinessMetricsSink(
  sink: Pick<Observability, "incrementCounter"> | null,
): void {
  uncheckedSink = sink;
}

function recordUncheckedTrigger(agentId: string, error: unknown): void {
  console.warn("[agents] setup readiness check failed; the trigger was not held back", {
    agentId,
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    uncheckedSink?.incrementCounter({
      name: "opengeni_agent_setup_readiness_unchecked_total",
      help: "Agent triggers turned on without a readiness check because the check failed.",
    });
  } catch {
    // Telemetry never changes an outcome.
  }
}

/**
 * Keeps a ready-made agent's triggers off until its required connections are
 * on for the person turning one on: refuses with the reason in words (409,
 * `agent_setup_incomplete`). Only the template's required connections count;
 * an agent with no template never blocks. A check that can't run doesn't
 * block either: it is logged and counted.
 */
export async function requireAgentTriggerReady(
  deps: ReadinessDeps,
  grant: AccessGrant,
  agentId: string | null | undefined,
  options: { githubEvents?: () => Promise<boolean> } = {},
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
    const githubEvents =
      setup.connections.some(isGitHub) && options.githubEvents
        ? await options.githubEvents()
        : false;
    readiness = await setupReadinessFor(deps, grant, setup, { githubEvents });
  } catch (error) {
    recordUncheckedTrigger(agentId, error);
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
