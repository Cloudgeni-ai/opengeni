import { publishStartupProgress } from "./model-usage";
import { userSetupCardPoster } from "./user-setup-card";
import { withAppActionConfirmation } from "./app-action-confirmation";
import {
  githubRepositoryAttachUri,
  withRepositoryAttachApproval,
} from "./repository-attach-approval";
import {
  PERSONAL_SLACK_SEND_TOOL_NAME,
  personalSlackSendTargets,
  slackBotSendHasPerson,
  strictestDecision,
  withSlackBotSendApproval,
} from "./slack-bot-send-approval";
import {
  firstPartyToolsForAttendance,
  sessionStartedUnattended,
  sessionUnattendedNow,
} from "./unattended";
import {
  resolveAppActionTargets,
  savedAppActionApprovalCard,
} from "@opengeni/db/app-action-targets";
import {
  resolveInitiatingHuman,
  buildSlackApiRateLimiter,
  beginConnectorActionExecution,
  getExternalLinkTurnAuthorization,
  getSessionTurnForAttempt,
  getWorkspaceVideoGenerationPolicy,
  listSkillDescriptors,
  completeConnectorActionExecution,
  persistAttemptToolCatalog,
  requireWorkspace,
  prepareConnectorActionApproval,
  recordUsageEvent,
  previewConnectorActionApproval,
  readPreparedBotMessage,
  resolveAttemptConnectorToolDecision,
  getSessionChainRoot,
  getSessionRepositoryMembershipForAuthority,
  sessionRepositoryRemoved,
  resolveSessionAppActionAuthority,
  namedSubjectHasLiveWorkspaceAuthority,
  updateSessionTitleWithEvent,
  subscriptionCoreCodexAppsRequestAuth,
  getSessionTitleOperation,
  listSandboxGroupRepositoryResources,
  settleSessionRepositoryCleanup,
  sessionHasToolRouterHistory,
  recordNangoUsageEvent,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import {
  type OpenGeniRuntime,
  type RunMcpCredentials,
  selectedSessionRemoteMcpTargets,
  type ConnectorAttachmentMaterializationRequest,
  type ConnectorActionPolicyHooks,
  createFirstPartyInteractionAttemptToolDefinitions,
  createFirstPartyInteractionRequestTargetReader,
  mcpToolDisplayMetadata,
  sideFeatureRouteRunnable,
  skillInstructionsBody,
  toolFamilyForCatalogIdentity,
} from "@opengeni/runtime";
import { connectionTokenResolverForTurn } from "../mcp-credentials";
import {
  accountRouteAuthNeededPayload,
  apiIntegrationAccountLabels,
  expandApiIntegrationAccountRoutes,
  expandMcpAccountRoutes,
} from "../mcp-account-routes";
import { createMcpOperationPersistence } from "@opengeni/db/mcp-operations";
import { createMcpOperationReadStore } from "../mcp-operation-store";
import { createMcpOperationObserverResolver } from "../mcp-operation-observer";
import { readMcpOperation } from "../mcp-operation-reader";
import { createOperationReadAttemptToolDefinition } from "./mcp-operation-read-tool";
import { buildGitHubRestMcpForTurn } from "../../github-rest-mcp";
import { materializeConnectorAttachmentsInChannel } from "../connector-attachments";
import {
  materializeConnectorFile,
  materializeGmailFile,
  readGmailFileFromChannel,
} from "../gmail-files";
import { objectStorageForSandboxDownloads } from "./file-resources";
import {
  allowedFirstPartyMcpToolsForSession,
  resolveSessionFirstPartyMcpTools,
  type Settings,
} from "@opengeni/config";
import { CodemodeAttemptDispatcher } from "../codemode-dispatcher";
import { mergeResourceRefs } from "../common";
import {
  workspaceSessionToolPolicyDefaultServers,
  buildApiIntegrationMcpServers,
  resolveCatalogSettings,
  resolveWorkspaceModelSelection,
  loadWorkspaceModelSelectionInput,
  withFrozenPersonalConnectionDelegations,
  resolveTurnToolPolicy,
  scheduledTurnMcpServerIds,
  scheduledTurnFirstPartyMcpTools,
  hasPermission,
  requireExplicitPermissionDelegation,
  createWebSearchBilling,
  pendingSessionRepositoryCleanup,
  withoutRemovedRepositories,
  connectionReconnectDay,
  connectionsNeedingReconnectFor,
  listConnectionsNeedingReconnect,
  nangoBackendsFor,
  postConnectionNeedsReauthNotice,
  type ConnectionNeedingReconnect,
} from "@opengeni/core";
import { withFirstPartyTools } from "../goals";
import type { TurnActivityServices as ActivityServices, RunAgentTurnInput } from "../types";
import {
  recordSkillCheckout,
  recordSkillRead,
  recordToolPreparationPhase,
  recordTurnStartupPhase,
} from "../../observability-metrics";
import { ToolResultSpill, spilledToolResultReadersForTurn } from "./tool-result-spill";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { promptToolAvailabilityForTurn } from "./prompt-tool-availability";
import { turnToolRouterExpected } from "./tool-router-expectation";
import { SandboxChannelAService } from "@opengeni/runtime/sandbox";
import { decisionModelProcessingResidency, videoGenerationRoute } from "./side-feature-gates";
import {
  bundledSkillSelectionForAgentConfig,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  resolveAgentToolFamilies,
  type AgentLearningDefaults,
  type ResourceRef,
  type Permission,
  type ToolAuthNeededPayload,
} from "@opengeni/contracts";

import { rollingSafeToolAuthNeededPayload, shouldPublishToolAuthNeededForTurn } from "./admission";
import {
  unavailableMcpConnectorReasonText,
  unavailableMcpOperationalContext,
  type McpConnectorAccountNeedingReconnect,
  type UnavailableMcpConnector,
} from "./errors";
import { runtimeResourcesForTurn } from "./file-resources";
import { waitForTurnOperation } from "./sandbox-provision";
import { shouldDeferNonEagerToolPreparation } from "./tool-policy";
import type { ClaimTurnOk } from "./claim";
import type { GovernanceModelOk } from "./governance-model";
import type { SandboxTurnRuntime } from "./sandbox-runtime";
import type { sandboxArtifactRuntimeAdmission } from "./sandbox-route";
import type {
  AttemptIdentityState,
  EventingState,
  RenewalState,
  SandboxRuntimeState,
} from "./turn-context";
import {
  createSessionTitleAttemptToolDefinition,
  routeAllowsSessionTitleRequests,
  sessionTitleToolPlan,
  shouldRequestMissingSessionTitle,
} from "./session-title";
import { resolveTurnSandboxAccess } from "./turn-sandbox-access";
import { createListModelsAttemptToolDefinition } from "./list-models";
import {
  createPrivacyFactsAttemptToolDefinition,
  loadPrivacyFactsLive,
  privacyFactsRouteForTurn,
} from "./privacy-facts";
import { createRefreshCredentialsAttemptToolDefinition } from "./refresh-credentials";
import { codeSearchToolDefinitions, codeSearchWorkspaceFromChannel } from "./code-search";
import { turnWebSearchPlan, webSearchToolDefinitions } from "./web-search";
import {
  createWorkspaceSkillTools,
  sessionShadowedSkillNames,
  withoutSessionShadowedSkills,
} from "./skill-tools";
import { loadConfiguredBundledSkills } from "./skill-selection";
import { guardSkillFilesystem } from "./skill-transfer";
import { turnCredentialRestriction } from "./credential-restriction";
import { attemptSecretResolver, type AttemptVaultAccess } from "./secret-resolver";

/**
 * The largest personal SKILL.md the Skill index reads for showing in full: a
 * description of up to 1,024 characters plus a body within the index's own
 * inline bound. Larger Skills are never transferred just to build the index.
 */
const PERSONAL_SKILL_MARKDOWN_MAX_BYTES = 8 * 1024;

/** A linked turn's immutable policy must survive array and token boundaries. */
export function linkedTurnFirstPartyPermissions(
  selected: Permission[] | null,
  linked: { permissions: Permission[]; permissionMode?: "legacy" | "explicit" } | null,
): Permission[] | null {
  if (!linked) return selected;
  const permissions = (selected ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS).filter((permission) =>
    hasPermission(linked.permissions, permission, linked.permissionMode),
  );
  requireExplicitPermissionDelegation(linked, permissions);
  return permissions;
}

export type PrepareTurnToolPolicyDeps = {
  input: RunAgentTurnInput;
  db: ActivityServices["db"];
  cancellationSignal: AbortSignal | undefined;
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  fileAuthoritySubjectId: ClaimTurnOk["fileAuthoritySubjectId"];
  capabilitySettings: ClaimTurnOk["capabilitySettings"];
  runSettings: GovernanceModelOk["runSettings"];
  rigVersion: GovernanceModelOk["rigVersion"];
};

export type PrepareTurnToolRuntimeDeps = {
  independentSessionTitles?: boolean;
  /** Connected-vault providers and the shared read budget for this attempt. */
  vaultAccess: AttemptVaultAccess;
  input: RunAgentTurnInput;
  catalogSourceSettings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  runtime: ActivityServices["runtime"];
  objectStorage: ActivityServices["objectStorage"];
  observability: ActivityServices["observability"];
  cancellationSignal: AbortSignal | undefined;
  eventing: EventingState;
  attempt: AttemptIdentityState;
  sandboxState: SandboxRuntimeState;
  media: ReturnType<typeof createTurnMediaArtifacts>;
  toolResultSpill: ToolResultSpill;
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  fileAuthoritySubjectId: ClaimTurnOk["fileAuthoritySubjectId"];
  capabilitySettings: ClaimTurnOk["capabilitySettings"];
  installedApiIntegrations: ClaimTurnOk["installedApiIntegrations"];
  capabilityServerCategories?: ClaimTurnOk["capabilityServerCategories"];
  codexAppsCoreConnectionId?: ClaimTurnOk["codexAppsCoreConnectionId"];
  turnExecutionPolicy: ClaimTurnOk["turnExecutionPolicy"];
  trigger: ClaimTurnOk["trigger"];
  runSettings: GovernanceModelOk["runSettings"];
  resolvedModel: GovernanceModelOk["resolvedModel"];
  lazyToolTransport: GovernanceModelOk["lazyToolTransport"];
  /** The workspace allows Opengeni credits; paid web tools are omitted when not. */
  workspaceCreditModelsAllowed: GovernanceModelOk["workspaceCreditModelsAllowed"];
  /** Hosted paid tools would run on Opengeni's bill; provider web tools replace hosted search. */
  hostedToolsBillCredits: GovernanceModelOk["hostedToolsBillCredits"];
  turnTools: ReturnType<typeof withFirstPartyTools>;
  /** Configured connectors the tool policy already left out of this turn. */
  unavailableMcpConnectors: PrepareTurnToolPolicyOk["unavailableMcpConnectors"];
  connectionScope: { accountId: string; workspaceId: string };
  sandboxArtifactRuntime: ReturnType<typeof sandboxArtifactRuntimeAdmission>;
  activeSandboxBackend: Settings["sandboxBackend"] | undefined;
  groupBoxBackend: Settings["sandboxBackend"];
  routingOn: boolean;
  runtimeCancellationSignal: AbortSignal | undefined;
  credentialSubjectId: ClaimTurnOk["credentialSubjectId"];
  interactionInterventionResume: ClaimTurnOk["interactionInterventionResume"];
  runWorkspaceMutationForSandbox: SandboxTurnRuntime["runWorkspaceMutationForSandbox"];
  /** Deployment and workspace allow the Jev-backed code_search tool. */
  codeSearchEnabled: boolean;
  /**
   * False for an optional repository that sits this turn out after losing
   * access (dropUnavailableOptionalRepositories), so no tool surface offers it.
   */
  retainsOptionalRepository?: (resource: ResourceRef) => boolean;
  throwIfWorkerShuttingDown: () => void;
  throwIfTurnCancelled: () => void;
  /** Present when this turn resolves host-managed run credentials. */
  runCredentialRenewals?: RenewalState | undefined;
  runMcpCredentials?: RunMcpCredentials;
  /** The accepted turn's frozen effective learning modes (instructions rendering only). */
  learningModes?: AgentLearningDefaults | undefined;
};

export async function prepareTurnToolPolicy(deps: PrepareTurnToolPolicyDeps) {
  const { input, db, turn, session, fileAuthoritySubjectId, capabilitySettings, runSettings } =
    deps;

  // A repository a person removed from the chat stays out of every later
  // turn: a turn queued before the removal never restores it from its own
  // resource snapshot. The record lasts until a person attaches it again.
  const turnResources = withoutRemovedRepositories(
    mergeResourceRefs(session.resources, turn.resources),
    session,
  );
  // Repositories remain durable workspace inputs. File attachments do not:
  // only files attached to this exact turn enter the sandbox manifest and
  // eager materialization path. Historical file ids remain in canonical
  // history/session metadata and are recoverable through the Files MCP.
  const runtimeResources = withoutRemovedRepositories(
    runtimeResourcesForTurn(session.resources, turn.resources),
    session,
  );
  // The folders and credential bindings of newly removed repositories are
  // removed from the sandbox before the agent runs. Child sessions share
  // their parent's box by default: the cleanup keeps any folder or binding
  // another session in the box still uses.
  const pendingCleanup = pendingSessionRepositoryCleanup(session);
  const repositoryRemoval =
    pendingCleanup.length > 0
      ? {
          removed: pendingCleanup.map((entry) => entry.resource),
          retained: await listSandboxGroupRepositoryResources(
            db,
            input.workspaceId,
            session.sandboxGroupId,
            input.sessionId,
          ),
          // Settles exactly these removals; a later removal stays pending.
          onCleaned: async () =>
            await settleSessionRepositoryCleanup(
              db,
              input.workspaceId,
              input.sessionId,
              pendingCleanup.map((entry) => entry.id),
            ),
        }
      : null;
  // Attach the first-party MCP server to EVERY turn, regardless of how/when
  // the session was created (API, scheduled task, or a pre-existing session
  // whose stored tools predate this). The server registration is then
  // narrowed by the session's exact firstPartyMcpTools selection and
  // authorization. Idempotent: mergeToolRefs dedupes if already present.
  // Resolve the durable policy at the turn boundary. Workspace-default
  // sessions follow the current configured MCP set,
  // while explicit, inherited-fixed, and legacy sessions remain narrowed
  // to their stored materialized allow-list.
  const scheduledMcpServerIds = scheduledTurnMcpServerIds(turn);
  const workspaceDefaults =
    scheduledMcpServerIds === null && session.toolPolicy.mode === "workspace_default"
      ? await workspaceSessionToolPolicyDefaultServers(
          db,
          input.workspaceId,
          capabilitySettings,
          fileAuthoritySubjectId ?? undefined,
        )
      : [];
  const resolvedToolPolicy = resolveTurnToolPolicy({
    toolPolicy: session.toolPolicy,
    session,
    turn,
    availableMcpServerIds: runSettings.mcpServers.map((server) => server.id),
    defaultMcpServerIds: workspaceDefaults.map((server) => server.id),
  });
  const families = resolveAgentToolFamilies(session.agent, {
    productServerIds: new Set([
      ...session.mcpServers.map((server) => server.id),
      ...(session.toolPolicy.mode !== "workspace_default"
        ? session.tools.map((tool) => tool.id)
        : []),
    ]),
  });
  const effectivePolicyTools = resolvedToolPolicy.toolRefs.filter(
    (tool) => tool.kind !== "mcp" || families.allowsMcpServer(tool.id),
  );
  const unavailableMcpConnectors = unavailableMcpConnectorsForPolicy({
    session,
    scheduledMcpServerIds,
    workspaceDefaults,
    availableMcpServerIds: runSettings.mcpServers.map((server) => server.id),
    droppedIds: resolvedToolPolicy.effectivePolicy.droppedIds,
    droppedCount: resolvedToolPolicy.effectivePolicy.counts.dropped,
    allowsMcpServer: (id) => families.allowsMcpServer(id),
  });
  const turnTools = withFirstPartyTools(runSettings, effectivePolicyTools);
  // Nothing user-defined is injected into the sandbox environment. User
  // secrets reach a command only through `{{secret:…}}` references resolved at
  // the exec boundary.
  const connectionScope = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
  };
  return {
    turnResources,
    runtimeResources,
    repositoryRemoval,
    unavailableMcpConnectors,
    turnTools,
    connectionScope,
  };
}

/** Opengeni's own servers are not connectors a person configures. */
const BUILT_IN_SESSION_MCP_SERVER_IDS = new Set(["opengeni", "files", "docs"]);

/**
 * Configured connectors the tool policy leaves out of this turn because they
 * are not in its registry: a selected connector that is gone (`droppedIds`),
 * and a workspace default (or a scheduled run's frozen connector) that this
 * turn's registry lacks although it is configured for the chat. The second
 * used to vanish without a word, because defaults absent from the registry
 * never entered the effective selection. Connectors the agent configuration
 * itself does not allow are not reported: they were never meant to be here.
 */
export function unavailableMcpConnectorsForPolicy(input: {
  session: Pick<ClaimTurnOk["session"], "toolPolicy" | "mcpServers">;
  scheduledMcpServerIds: readonly string[] | null;
  workspaceDefaults: readonly { id: string; name: string | undefined }[];
  availableMcpServerIds: readonly string[];
  droppedIds: readonly string[];
  droppedCount: number;
  allowsMcpServer: (id: string) => boolean;
}): { connectors: UnavailableMcpConnector[]; omittedCount: number } {
  const available = new Set(input.availableMcpServerIds);
  const names = new Map<string, string | undefined>([
    ...input.workspaceDefaults.map((server) => [server.id, server.name] as const),
    ...input.session.mcpServers.map((server) => [server.id, server.name ?? undefined] as const),
  ]);
  const policy = input.session.toolPolicy;
  const excluded = new Set(policy.mode === "workspace_default" ? policy.excludedMcpServerIds : []);
  const missingDefaults =
    policy.mode === "workspace_default"
      ? (input.scheduledMcpServerIds ?? input.workspaceDefaults.map((server) => server.id)).filter(
          (id) => !available.has(id) && !excluded.has(id),
        )
      : [];
  const connectors = new Map<string, UnavailableMcpConnector>();
  for (const id of [...input.droppedIds, ...missingDefaults]) {
    if (BUILT_IN_SESSION_MCP_SERVER_IDS.has(id) || !input.allowsMcpServer(id)) continue;
    connectors.set(id, { id, name: names.get(id), reason: "not_available" });
  }
  return {
    connectors: [...connectors.values()],
    omittedCount: Math.max(0, input.droppedCount - input.droppedIds.length),
  };
}

/**
 * Pair this chat's connection-backed connectors with the accounts of theirs
 * that stopped working. Matched by provider: a connector's address can be a
 * bridge to the same provider rather than the endpoint it was connected for.
 */
export function mcpAccountsNeedingReconnect(
  servers: readonly {
    id: string;
    name?: string | undefined;
    connectionRef?: { providerDomain: string } | undefined;
  }[],
  inventory: readonly ConnectionNeedingReconnect[],
): McpConnectorAccountNeedingReconnect[] {
  const accounts: McpConnectorAccountNeedingReconnect[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    if (!server.connectionRef) continue;
    for (const connection of connectionsNeedingReconnectFor(inventory, {
      providerDomain: server.connectionRef.providerDomain,
    })) {
      if (seen.has(connection.connectionId)) continue;
      seen.add(connection.connectionId);
      accounts.push({
        connector: { id: server.id, name: server.name },
        account: connection.account,
        ownership: connection.ownership,
        stoppedWorkingOn: connectionReconnectDay(connection.since),
        reconnectHere: connection.addedHere,
      });
    }
  }
  return accounts;
}

export async function prepareTurnToolRuntime(deps: PrepareTurnToolRuntimeDeps) {
  const {
    input,
    catalogSourceSettings,
    db,
    bus,
    runtime,
    observability,
    cancellationSignal,
    eventing,
    attempt,
    sandboxState,
    media,
    toolResultSpill,
    turn,
    session,
    installedApiIntegrations,
    capabilityServerCategories,
    codexAppsCoreConnectionId,
    turnExecutionPolicy,
    trigger,
    runSettings: canonicalRunSettings,
    resolvedModel,
    lazyToolTransport,
    workspaceCreditModelsAllowed,
    hostedToolsBillCredits,
    turnTools: canonicalTurnTools,
    sandboxArtifactRuntime,
    activeSandboxBackend,
    groupBoxBackend,
    routingOn,
    credentialSubjectId,
    interactionInterventionResume,
    runWorkspaceMutationForSandbox,
    codeSearchEnabled,
    retainsOptionalRepository,
    throwIfWorkerShuttingDown,
    throwIfTurnCancelled,
  } = deps;

  const accountRoutes = expandMcpAccountRoutes({
    settings: canonicalRunSettings,
    tools: canonicalTurnTools,
    bindings: turn.mcpAccountBindings,
    ...(capabilityServerCategories ? { categories: capabilityServerCategories } : {}),
  });
  const runSettings = accountRoutes.settings;
  const turnTools = accountRoutes.tools;
  // Every configured connector this turn runs without, named with its reason:
  // the policy's registry gaps, and connectors with no usable accepted account.
  const unavailableMcpConnectors: UnavailableMcpConnector[] = [
    ...deps.unavailableMcpConnectors.connectors,
    ...accountRoutes.unavailable,
  ];
  // Accounts of this chat's connectors that were connected but stopped
  // working, so the model can say so plainly and offer to reconnect them.
  const connectionBackedServers = canonicalRunSettings.mcpServers.filter(
    (server) => server.connectionRef,
  );
  const needsReconnect =
    connectionBackedServers.length === 0
      ? []
      : mcpAccountsNeedingReconnect(
          connectionBackedServers,
          await listConnectionsNeedingReconnect(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: turn.initiatingHumanSubjectId ?? null,
            integrationBackends: await nangoBackendsFor(db, runSettings),
          }).catch((error: unknown) => {
            observability.warn("Connections needing reconnect were not read", {
              error: error instanceof Error ? error.message : String(error),
            });
            return [];
          }),
        );
  const mcpAvailabilityNote = unavailableMcpOperationalContext({
    connectors: unavailableMcpConnectors,
    omittedCount: deps.unavailableMcpConnectors.omittedCount,
    needsReconnect,
  });
  // Tool discovery reports the same connectors beside runtime failures.
  const preparationUnavailableMcpServers = new Map(
    unavailableMcpConnectors.map((connector) => [
      connector.id,
      `not loaded this turn: ${unavailableMcpConnectorReasonText(connector.reason)}`,
    ]),
  );
  const credentialRestriction = turnCredentialRestriction(turnExecutionPolicy, session.metadata);
  const toolContextPreparationStartedAt = performance.now();
  throwIfWorkerShuttingDown();
  throwIfTurnCancelled();
  // Connection credentials and the optional Apps credential are resolved
  // independently. Inference auth is never an Apps fallback.
  const rawResolveCredential = connectionTokenResolverForTurn({
    db,
    settings: runSettings,
    canonicalMcpServerIds: canonicalRunSettings.mcpServers
      .filter((server) => server.connectionRef)
      .map((server) => server.id),
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    turn,
    // The owner hears once, on their inbox and phone, that it stopped working.
    onConnectionNeedsReauth: (broken) =>
      postConnectionNeedsReauthNotice({ db, bus, observability }, broken),
  });
  const personalConnectionDelegations = turn.personalConnectionDelegations;
  const delegatedMembershipChecks = new Map<string, Promise<boolean>>();
  // The canonical live-authority resolver, not a bare `workspace_memberships`
  // join: a managed human's personal workspace deliberately has no membership
  // row (migration 0219), so the bare join would revoke the owner's own frozen
  // personal connections for every turn that runs in their private workspace.
  const delegatedOwnerHasMembership = async (subjectId: string): Promise<boolean> => {
    const existing = delegatedMembershipChecks.get(subjectId);
    if (existing) return await existing;
    const check = namedSubjectHasLiveWorkspaceAuthority(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId,
    });
    delegatedMembershipChecks.set(subjectId, check);
    return await check;
  };
  const resolveCredential: typeof rawResolveCredential = withFrozenPersonalConnectionDelegations({
    resolveCredential: rawResolveCredential,
    settings: runSettings,
    personalConnectionDelegations,
    ownerHasWorkspaceMembership: delegatedOwnerHasMembership,
  });
  const connectorActionIdentity = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: turn.id,
    attemptId: input.attemptId,
    executionGeneration: attempt.executionGeneration,
    initiator: {
      kind: turn.initiator.kind,
      subjectId: turn.initiator.subjectId,
    },
  } as const;
  const publishToolAuthNeeded = async (payload: ToolAuthNeededPayload): Promise<void> => {
    if (!shouldPublishToolAuthNeededForTurn(payload, trigger, turn)) {
      return;
    }
    await eventing.publish!(
      [
        {
          type: "tool.auth_needed",
          payload: rollingSafeToolAuthNeededPayload(
            accountRouteAuthNeededPayload(payload, turn.mcpAccountBindings),
          ),
        },
      ],
      true,
    );
  };
  const apiIntegrationMcpServers = buildApiIntegrationMcpServers({
    settings: runSettings,
    integrations: expandApiIntegrationAccountRoutes({
      integrations: installedApiIntegrations,
      bindings: turn.mcpAccountBindings,
      tools: turnTools,
    }),
    authority: {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      rootSessionId: session.rootSessionId,
      turnId: turn.id,
      attemptId: input.attemptId,
      ...(credentialSubjectId ? { initiatingSubjectId: credentialSubjectId } : {}),
    },
    resolveCredential,
    onAuthNeeded: publishToolAuthNeeded,
  });
  const githubRestMcp = await buildGitHubRestMcpForTurn({
    db,
    settings: runSettings,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    turn,
    resources: mergeResourceRefs(session.resources, turn.resources).filter(
      (resource) => retainsOptionalRepository?.(resource) ?? true,
    ),
    tools: turnTools,
    resolveCredential,
    warn: (message, attributes) => observability.warn(message, attributes),
  });
  const localMcpServers = [...apiIntegrationMcpServers, ...githubRestMcp.localMcpServers];
  // Apps authorization is the exact core designation resolved at claim.
  const codexAppsAuth = codexAppsCoreConnectionId
    ? subscriptionCoreCodexAppsRequestAuth(db, runSettings, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        connectionId: codexAppsCoreConnectionId,
      })
    : undefined;
  const linkedAuthority = await getExternalLinkTurnAuthorization(
    db,
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
    },
    turn.id,
  );
  if (linkedAuthority && !linkedAuthority.authorized)
    throw new Error("Native identity link was revoked");
  const effectiveFirstPartyPermissions = linkedTurnFirstPartyPermissions(
    session.firstPartyMcpPermissions,
    linkedAuthority,
  );
  // Background-command tools need compute: the effective route of this turn,
  // a managed sandbox or an attached Connected Machine, not the durable home.
  // `goal_resume` follows the goal frozen with the turn, as the goal context
  // the model reads does, so a session that has never had a goal is not sent it.
  const toolFamilies = resolveAgentToolFamilies(session.agent, {
    sandboxAttached: (activeSandboxBackend ?? groupBoxBackend) !== "none",
    ...(turn.goalSnapshot ? { sessionGoal: turn.goalSnapshot.state !== "none" } : {}),
  });
  const bundledSkillIds = bundledSkillSelectionForAgentConfig(
    session.bundledSkillIds,
    session.agent,
  );
  const videoSkillSelected =
    bundledSkillIds === undefined || bundledSkillIds.includes("builtin:video-generation");
  // The tools follow how the chat started, so its tool list never changes
  // under earlier requests; refusing what would wait follows the current setting.
  const startedUnattended = sessionStartedUnattended(session);
  const unattended = sessionUnattendedNow(session);
  // These are independent metadata reads on separate pool scopes, after the
  // linked-identity guard. No selection, credential or authority is cached.
  // Join every scope before proceeding or failing; executable preparation and
  // the ordered, fenced history writes still happen at their original boundary.
  const [workspaceResult, skillConfigurationResult, sharedSkillsResult] = await Promise.allSettled([
    scheduledTurnMcpServerIds(turn) === null
      ? requireWorkspace(db, input.workspaceId)
      : Promise.resolve(null),
    toolFamilies.skills === false || !videoSkillSelected
      ? Promise.resolve(null)
      : getWorkspaceVideoGenerationPolicy(db, input.workspaceId),
    toolFamilies.skills === false
      ? Promise.resolve([])
      : listSkillDescriptors(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            ...(deps.fileAuthoritySubjectId ? { subjectId: deps.fileAuthoritySubjectId } : {}),
          },
          { personalSkillMarkdownMaxBytes: PERSONAL_SKILL_MARKDOWN_MAX_BYTES },
        ),
  ]);
  if (workspaceResult.status === "rejected") throw workspaceResult.reason;
  if (skillConfigurationResult.status === "rejected") throw skillConfigurationResult.reason;
  if (sharedSkillsResult.status === "rejected") throw sharedSkillsResult.reason;
  const skillConfiguration = skillConfigurationResult.value;
  const sharedSkillDescriptors = sharedSkillsResult.value;
  // A session that started unattended has no tool that waits for a person to act.
  const selectedFirstPartyMcpTools = firstPartyToolsForAttendance(
    toolFamilies.firstPartyTools(
      scheduledTurnMcpServerIds(turn) !== null
        ? allowedFirstPartyMcpToolsForSession(
            runSettings,
            scheduledTurnFirstPartyMcpTools(turn) ?? session.firstPartyMcpTools,
          )
        : resolveSessionFirstPartyMcpTools(runSettings, session, workspaceResult.value!.settings),
    ),
    startedUnattended,
  );
  // Frozen with the selection and ceiling above; instructions only.
  const promptToolAvailability = promptToolAvailabilityForTurn({
    agentConfig: session.agent,
    selectedFirstPartyMcpTools,
    firstPartyPermissions: effectiveFirstPartyPermissions,
    nestedAgentDepth: session.nestedAgentDepth,
    effectiveMaxNestedAgentDepth: session.effectiveMaxNestedAgentDepth,
    learning: deps.learningModes,
  });
  const needsTitle = shouldRequestMissingSessionTitle({
    agentConfig: session.agent,
    title: session.title,
    titleSource: session.titleSource,
    firstPartyMcpTools: selectedFirstPartyMcpTools,
    firstPartyMcpPermissions: effectiveFirstPartyPermissions,
  });
  const activeTitle =
    deps.independentSessionTitles && needsTitle
      ? await getSessionTitleOperation(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        })
      : null;
  const titleToolPlan = sessionTitleToolPlan({
    agentConfig: session.agent,
    tools: turnTools,
    selectedFirstPartyMcpTools,
    shouldRequestTitle: needsTitle && (!activeTitle || activeTitle.sourceTurnId === turn.id),
    parallelGenerationAvailable: typeof runtime.generateSessionTitle === "function",
    routeAllowsTitleRequests: routeAllowsSessionTitleRequests(resolvedModel),
  });
  const attemptConnectorActionBindings = [...githubRestMcp.connectorBindings];
  const appActionPolicy: ConnectorActionPolicyHooks = withAppActionConfirmation(
    {
      preview: async (call) =>
        await previewConnectorActionApproval(db, connectorActionIdentity, call),
      prepare: async (call) => {
        // Nobody can answer an approval here, so an Ask opens no request for
        // one: the call is refused (see the runtime) and nothing waits on it.
        if (unattended) {
          const preview = await previewConnectorActionApproval(db, connectorActionIdentity, call);
          if (preview.managed && preview.decision === "ask" && !preview.requestId) return preview;
        }
        return await prepareConnectorActionApproval(db, connectorActionIdentity, call);
      },
      begin: async (call) => await beginConnectorActionExecution(db, connectorActionIdentity, call),
      complete: async ({ requestId, outcome }) =>
        await completeConnectorActionExecution(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          requestId,
          attemptId: input.attemptId,
          outcome,
        }),
    },
    {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      settings: runSettings,
      // Live per change, the same check the API makes before running it.
      authority: async () => {
        const authority = await resolveSessionAppActionAuthority(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: turn.id,
        });
        return {
          kind: authority.kind,
          ...("subjectId" in authority ? { subjectId: authority.subjectId } : {}),
        };
      },
      // Names what a confirmed change touches, read as the person it asks.
      targets: async (args, reader) =>
        await resolveAppActionTargets(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: reader.subjectId,
            onLookupError: (error, parameter) =>
              console.warn("app action target lookup failed", {
                parameter,
                error: error instanceof Error ? error.message : String(error),
              }),
          },
          args,
        ),
      saved: async (approvalId) =>
        await savedAppActionApprovalCard(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: turn.id,
          approvalId,
        }),
      cards: eventing.appActionApprovalCards,
    },
  );
  // Whether a person can answer an approval in this chat: not in a scheduled
  // or unattended run, or a worker of one. Read once per attempt.
  let chatHasPerson: Promise<boolean> | undefined;
  const chatInteractive = () =>
    (chatHasPerson ??= slackBotSendHasPerson({
      scheduled: scheduledTurnMcpServerIds(turn) !== null,
      unattended,
      chainRoot: async () => {
        const root = await getSessionChainRoot(db, input.workspaceId, input.sessionId);
        return root
          ? {
              rootUnattended: root.rootUnattended,
              rootTurnScheduled:
                root.rootTurnMetadata !== null &&
                scheduledTurnMcpServerIds({ metadata: root.rootTurnMetadata }) !== null,
            }
          : null;
      },
    }));
  // A bot send where a person can answer follows the person's own Slack send
  // permission; scheduled and unattended runs, and workers of them, keep
  // sending at once.
  const slackBotSendPolicy: ConnectorActionPolicyHooks = withSlackBotSendApproval(appActionPolicy, {
    interactive: chatInteractive,
    personalSlackSendDecision: async () =>
      strictestDecision(
        await Promise.all(
          personalSlackSendTargets(turn.personalConnectionDelegations, runSettings).map(
            async (target) =>
              await resolveAttemptConnectorToolDecision(db, connectorActionIdentity, {
                ...target,
                toolName: PERSONAL_SLACK_SEND_TOOL_NAME,
              }),
          ),
        ),
      ),
    preparedMessage: async (messageId) =>
      await readPreparedBotMessage(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        id: messageId,
      }),
  });
  // An agent's request to attach a repository to this chat always waits for
  // a person; where nobody can answer it is refused.
  const connectorActionPolicy: ConnectorActionPolicyHooks = withRepositoryAttachApproval(
    slackBotSendPolicy,
    {
      interactive: chatInteractive,
      removedEarlier: async (repository) => {
        const uri = githubRepositoryAttachUri(repository);
        if (!uri) return false;
        const membership = await getSessionRepositoryMembershipForAuthority(
          db,
          input.workspaceId,
          input.sessionId,
        );
        return membership !== null && sessionRepositoryRemoved(membership, { uris: [uri] });
      },
    },
  );
  const bundledSkills =
    toolFamilies.skills === false
      ? []
      : loadConfiguredBundledSkills({
          // Rows that could not freeze the "none" default at create (scheduled
          // generated sessions, pre-existing rows) get the same rule here.
          bundledSkillIds,
          firstPartyTools: selectedFirstPartyMcpTools,
          videoGenerationEnabled:
            skillConfiguration !== null &&
            skillConfiguration.defaultModelId !== null &&
            skillConfiguration.enabledModelIds.length > 0 &&
            sideFeatureRouteRunnable(
              runSettings,
              videoGenerationRoute(skillConfiguration.fundingSource),
            ),
        });
  const selectedSkills = [
    ...bundledSkills,
    ...session.skills.map((skill) => ({
      id: `session:${session.id}:${skill.name}`,
      artifact: skill,
    })),
  ];
  const skillCatalog =
    toolFamilies.skills === false
      ? []
      : [
          ...withoutSessionShadowedSkills(
            sharedSkillDescriptors.filter((entry) => entry.activationMode === "workspace_managed"),
            sessionShadowedSkillNames(selectedSkills),
          ).map((entry) => {
            // A short personal Skill (a standing preference) is shown in full,
            // within the index's inline bounds, so it applies without a read.
            const instructions = entry.personalSkillMarkdown
              ? skillInstructionsBody(entry.personalSkillMarkdown)
              : null;
            return {
              id: entry.id,
              name: entry.title,
              description: entry.description,
              ...(instructions ? { instructions } : {}),
            };
          }),
          ...selectedSkills.map((entry) => ({
            id: entry.id,
            name: entry.artifact.name,
            description: entry.artifact.description || entry.artifact.name,
          })),
        ];
  const skillTools = createWorkspaceSkillTools({
    db,
    settings: runSettings,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    ...(deps.fileAuthoritySubjectId ? { subjectId: deps.fileAuthoritySubjectId } : {}),
    actor: {
      kind: "agent",
      sessionId: input.sessionId,
      turnId: turn.id,
      attemptId: input.attemptId,
      executionGeneration: attempt.executionGeneration,
    },
    selected: selectedSkills,
    modelToolOutputTruncationTokens: () =>
      eventing.modelRunSettings.modelToolOutputTruncationTokens,
    onSkillReadHistoryLookupFailed: () =>
      observability.warn("skill_read history lookup failed; returning the full Skill text", {
        errorCode: "skill_read_history_lookup_failed",
        origin: "worker",
      }),
    skillReadTelemetry: {
      // Set once agent build freezes this turn's model-visible Skill index.
      indexedSkillIds: () => eventing.modelVisibleSkillIds,
      observe: (observation) => recordSkillRead(observability, observation),
    },
    observeSkillCheckout: (observation) => recordSkillCheckout(observability, observation),
    filesystem: async () => {
      throwIfWorkerShuttingDown();
      throwIfTurnCancelled();
      const access = await resolveTurnSandboxAccess(
        sandboxState,
        media.sdkOwnedSandboxSession,
        "Skill checkout/publish requires a sandbox or Connected Machine.",
      );
      const machineRoot = sandboxState.machinePrimarySession?.workspaceRoot;
      const channel = new SandboxChannelAService({
        session: access.session,
        commandRunner: async (commandSession, args) => {
          const fence = eventing.toolCancellationFenceRef.current;
          if (!fence)
            throw new Error(
              "Skill filesystem execution requires the active turn cancellation controller.",
            );
          return await fence.runSandboxCommandSynchronous(commandSession, args);
        },
        workspaceRoot: machineRoot ?? "/workspace",
        ...(machineRoot ? { providerPathMode: "workspace-relative" as const } : {}),
        leaseEpoch: access.leaseEpoch,
        emit: async (events) => {
          await eventing.publish?.(events, true);
        },
      });
      return guardSkillFilesystem(channel, {
        assertActive: () => {
          throwIfWorkerShuttingDown();
          throwIfTurnCancelled();
        },
        runMutation: async (mutation) =>
          access.sandbox && !routingOn
            ? runWorkspaceMutationForSandbox(access.sandbox, "skillCheckout", mutation)
            : mutation(),
      });
    },
  });
  const operationRecoveryEnabled = githubRestMcp.settings.mcpServers.some(
    (server) =>
      server.operationRecovery &&
      Object.keys(server.operationRecovery).length > 0 &&
      githubRestMcp.tools.some((tool) => tool.kind === "mcp" && tool.id === server.id),
  );
  const operationAttempt = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: turn.id,
    attemptId: input.attemptId,
    executionGeneration: attempt.executionGeneration,
  };
  const operationPersistence = operationRecoveryEnabled
    ? createMcpOperationPersistence(db, operationAttempt)
    : undefined;
  const operationReadStore = operationRecoveryEnabled
    ? createMcpOperationReadStore(db, operationAttempt)
    : undefined;
  const operationObserver = createMcpOperationObserverResolver({
    settings: githubRestMcp.settings,
    workspaceId: input.workspaceId,
    ...(credentialSubjectId ? { credentialSubjectId } : {}),
    resolveCredential,
    assertAttempt: async () => {
      throwIfWorkerShuttingDown();
      throwIfTurnCancelled();
      const current = await getSessionTurnForAttempt(
        db,
        input.workspaceId,
        input.sessionId,
        input.attemptId,
      );
      if (
        !current ||
        current.id !== turn.id ||
        current.executionGeneration !== attempt.executionGeneration
      ) {
        throw new Error("MCP operation reader no longer owns the executing attempt");
      }
    },
    getEnvironment: async () => {
      const prepared = eventing.preparedTools;
      if (!prepared) return null;
      prepared.startDeferredPreparation?.();
      return ((await prepared.ready) ?? prepared).attemptToolEnvironment;
    },
  });
  const codeSearchTools = codeSearchToolDefinitions({
    enabled: codeSearchEnabled,
    settings: runSettings,
    backend: activeSandboxBackend ?? groupBoxBackend,
    machineWorkspaceRoot: sandboxState.machinePrimarySession?.workspaceRoot ?? null,
    observability,
    // The deployment's decision-model account pays whatever model billing the
    // workspace uses; record them per workspace so the cost stays visible.
    recordUsage: async (usage) => {
      const shared = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sourceResourceType: "code_search",
        sourceResourceId: usage.operationId,
        sessionId: input.sessionId,
        turnId: turn.id,
        turnAttemptId: input.attemptId,
        processingResidency: decisionModelProcessingResidency(runSettings, true),
      };
      if (usage.decisionInputTokens !== null)
        await recordUsageEvent(db, {
          ...shared,
          eventType: "code_search.decision_input_tokens",
          quantity: usage.decisionInputTokens,
          unit: "tokens",
          idempotencyKey: `usage:code_search.decision_input_tokens:${input.attemptId}:${usage.operationId}`,
        });
      const costEvent = usage.costSources.includes("estimate")
        ? "decision_estimated_cost"
        : "decision_cost";
      if (usage.decisionCostUsd !== null)
        await recordUsageEvent(db, {
          ...shared,
          eventType: `code_search.${costEvent}`,
          quantity: Math.round(usage.decisionCostUsd * 1_000_000),
          unit: "usd_micros",
          idempotencyKey: `usage:code_search.${costEvent}:${input.attemptId}:${usage.operationId}`,
        });
    },
    workspace: async () => {
      throwIfWorkerShuttingDown();
      throwIfTurnCancelled();
      const access = await resolveTurnSandboxAccess(
        sandboxState,
        media.sdkOwnedSandboxSession,
        "code_search requires a sandbox or Connected Machine.",
      );
      const machineRoot = sandboxState.machinePrimarySession?.workspaceRoot;
      return codeSearchWorkspaceFromChannel(
        new SandboxChannelAService({
          session: access.session,
          workspaceRoot: machineRoot ?? "/workspace",
          ...(machineRoot ? { providerPathMode: "workspace-relative" as const } : {}),
          leaseEpoch: access.leaseEpoch,
        }),
      );
    },
  });
  const attemptToolFamilies = resolveAgentToolFamilies(session.agent, {
    hasSkills: skillCatalog.length > 0,
  });
  // Provider web search: only where the turn has no hosted search (or the
  // operator chose `replace`, or hosted search would run on Opengeni's bill),
  // only when a provider is configured, and only when the session's agent
  // configuration allows web search (filtered below).
  const webSearchTools = webSearchToolDefinitions({
    settings: runSettings,
    tools: turnWebSearchPlan(
      resolvedModel,
      runSettings,
      workspaceCreditModelsAllowed,
      hostedToolsBillCredits,
    ).providerTools,
    scope: {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: turn.id,
      attemptId: input.attemptId,
      // A turn whose paid hosted tools bill credits pays its web tools from
      // the plan and grants covering its model first, like its Gateway images.
      ...(hostedToolsBillCredits ? { creditUsageModelId: turnExecutionPolicy.productModelId } : {}),
    },
    billing: createWebSearchBilling({ db, settings: runSettings }),
    observability,
  });
  const firstPartyInteractionInput = {
    settings: runSettings,
    ...(credentialRestriction ? { credentialRestriction } : {}),
    scope: {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: turn.id,
      attemptId: input.attemptId,
      executionGeneration: attempt.executionGeneration,
    },
    ...(effectiveFirstPartyPermissions ? { permissions: effectiveFirstPartyPermissions } : {}),
    selectedTools: selectedFirstPartyMcpTools,
    subjectId: "worker:first-party-mcp",
    subjectLabel: "Opengeni worker",
  };
  // A person-handoff request that leaves its generations out records the
  // target as it is when the turn pauses.
  eventing.interactionRequestTargetReader = createFirstPartyInteractionRequestTargetReader(
    firstPartyInteractionInput,
  );
  const attemptToolDefinitions = [
    ...(operationReadStore
      ? [
          createOperationReadAttemptToolDefinition({
            read: async (selector) =>
              await readMcpOperation(selector, {
                ...operationReadStore,
                resolveObserver: operationObserver,
              }),
          }),
        ]
      : []),
    ...skillTools,
    ...(deps.runCredentialRenewals
      ? [
          createRefreshCredentialsAttemptToolDefinition({
            refresh: async () => {
              const renewals = deps.runCredentialRenewals!;
              const controller = renewals.runCredentialRenewal;
              if (!controller) return "not_provisioned";
              renewals.runCredentialRenewalOutcome = null;
              await controller.refreshNow();
              return renewals.runCredentialRenewalOutcome ?? "completed";
            },
          }),
        ]
      : []),
    createListModelsAttemptToolDefinition({
      currentModelId: turnExecutionPolicy.productModelId,
      load: async () => {
        const currentCatalog = await resolveCatalogSettings(db, catalogSourceSettings);
        const currentSettings = currentCatalog.settings;
        const selectionInput = await loadWorkspaceModelSelectionInput(db, currentSettings, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: turn.initiatingHumanSubjectId ?? credentialSubjectId ?? "worker:model-access",
        });
        return {
          selections: resolveWorkspaceModelSelection(selectionInput),
          modelNotes: currentCatalog.modelNotes,
        };
      },
    }),
    createPrivacyFactsAttemptToolDefinition({
      route: privacyFactsRouteForTurn({
        settings: runSettings,
        policy: turnExecutionPolicy,
        resolved: resolvedModel,
      }),
      deployment: {
        privacyPolicyUrl: runSettings.legalPrivacyPolicyUrl ?? null,
        termsOfServiceUrl: runSettings.legalTermsOfServiceUrl ?? null,
        supportEmail: runSettings.supportEmail ?? null,
        subprocessorsUrl: runSettings.legalSubprocessorsUrl ?? null,
        dataHostingLocation: runSettings.dataHostingLocation ?? null,
        sandboxes: {
          backend: runSettings.sandboxBackend,
          regions: runSettings.modalRegions ?? null,
        },
        // Archiving needs object storage; without it the worker never archives.
        sessionArchiveIdleDays:
          runSettings.sessionArchiveEnabled && deps.objectStorage
            ? runSettings.sessionArchiveIdleDays
            : null,
        preservesProviderItemIds: runSettings.openaiProviderItemIds === "preserve",
      },
      loadLive: async () =>
        await loadPrivacyFactsLive({
          db,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          deploymentEuOnly: runSettings.requiredModelGeography === "eu",
        }),
    }),
    ...(titleToolPlan.promoteTitleTool
      ? [
          createSessionTitleAttemptToolDefinition({
            updateTitle: async (title) => {
              const result = await updateSessionTitleWithEvent(db, {
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                title,
                source: "agent",
              });
              await publishDurableSessionEvents(
                bus,
                input.workspaceId,
                input.sessionId,
                result.events,
              );
              return result;
            },
          }),
        ]
      : []),
    ...createFirstPartyInteractionAttemptToolDefinitions({
      ...firstPartyInteractionInput,
      ...(interactionInterventionResume
        ? { interventionResume: interactionInterventionResume }
        : {}),
      postSetupCard: userSetupCardPoster({
        db,
        bus,
        connectedMachinesEnabled: runSettings.sandboxSelfhostedEnabled,
        webBaseUrl: runSettings.webBaseUrl ?? runSettings.publicBaseUrl,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: turn.id,
        executionGeneration: attempt.executionGeneration,
        attemptId: input.attemptId,
      }),
    }),
    ...codeSearchTools,
    ...webSearchTools,
  ].filter((tool) => attemptToolFamilies.allowsFunctionTool(tool.modelName));
  // Frozen per turn: router history, the prepared refs, the first-party
  // selection and the function tools. Decides whether anything is deferred.
  const toolRouterInHistory = session.agent
    ? await sessionHasToolRouterHistory(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      })
    : false;
  const toolRouterExpected = turnToolRouterExpected({
    agentConfig: session.agent,
    routerInHistory: toolRouterInHistory,
    toolRefs: githubRestMcp.tools,
    mcpServers: githubRestMcp.settings.mcpServers,
    remoteFirstPartyTools: titleToolPlan.remoteFirstPartyMcpTools,
    functionToolNames: attemptToolDefinitions.map((tool) => tool.modelName),
    preparationIndependentToolNames: titleToolPlan.preparationIndependentToolNames,
    mediaTools: toolFamilies.media,
  });
  // With nothing else deferred, the deferred title tool alone would bring the
  // search router back on every titled turn; Opengeni titles the session itself.
  // Without a router to install the title tool sits in the request for free.
  const routerInstallable =
    toolRouterInHistory ||
    (lazyToolTransport === "codex_native"
      ? runSettings.codexToolSearchEnabled
      : runSettings.lazyToolSearchEnabled);
  const remoteFirstPartyMcpTools =
    toolRouterExpected || !routerInstallable
      ? titleToolPlan.remoteFirstPartyMcpTools
      : titleToolPlan.remoteFirstPartyMcpTools.filter((tool) => tool !== "set_session_title");
  recordTurnStartupPhase(observability, {
    phase: "tool_context_preparation",
    provider: turnExecutionPolicy.providerId,
    backend: activeSandboxBackend ?? groupBoxBackend,
    outcome: "completed",
    durationSeconds: (performance.now() - toolContextPreparationStartedAt) / 1_000,
    count: githubRestMcp.tools.length,
  });
  await publishStartupProgress(eventing, [
    {
      type: "turn.startup.phase.started",
      payload: { phase: "tools" },
    },
  ]);
  const toolPreparationStartedAt = performance.now();
  let toolPreparationOutcome: "completed" | "failed" = "completed";
  const progressiveDisclosureEnabled =
    lazyToolTransport === "codex_native"
      ? runSettings.codexToolSearchEnabled
      : runSettings.lazyToolSearchEnabled;
  const deferNonEagerToolPreparation = shouldDeferNonEagerToolPreparation({
    lazyToolTransport,
    progressiveDisclosureEnabled,
    artifactRuntimeAvailable: sandboxArtifactRuntime.available,
    triggerKind: input.trigger.kind,
    triggerType: trigger.type,
  });
  const materializeConnectorAttachments = async (
    request: ConnectorAttachmentMaterializationRequest,
  ) => {
    throwIfWorkerShuttingDown();
    throwIfTurnCancelled();
    const sandboxAccess = await resolveTurnSandboxAccess(
      sandboxState,
      media.sdkOwnedSandboxSession,
      "Connector attachment sandbox is unavailable",
    );
    const sandbox = sandboxAccess.sandbox;
    const machineRoot = sandboxState.machinePrimarySession?.workspaceRoot;
    const channel = new SandboxChannelAService({
      session: sandboxAccess.session,
      workspaceRoot: machineRoot ?? "/workspace",
      ...(machineRoot ? { providerPathMode: "workspace-relative" as const } : {}),
      leaseEpoch: sandboxAccess.leaseEpoch,
      emit: async (events) => {
        await eventing.publish?.(events, true);
      },
    });
    return await materializeConnectorAttachmentsInChannel(channel, request, {
      runMutation: async (mutation) => {
        if (sandbox && !routingOn) {
          return await runWorkspaceMutationForSandbox(
            sandbox,
            "connectorAttachmentMaterialization",
            mutation,
          );
        }
        return await mutation();
      },
    });
  };
  const connectorFileStaging = () => {
    if (!deps.objectStorage) throw new Error("Connector file delivery requires object storage");
    return {
      workspaceId: input.workspaceId,
      storage: deps.objectStorage,
      downloadStorage: objectStorageForSandboxDownloads(
        runSettings,
        deps.objectStorage,
        deps.activeSandboxBackend ?? deps.groupBoxBackend,
      ),
      materialize: materializeConnectorAttachments,
      onCleanupFailure: (key: string) =>
        console.warn("[connector-files] Temporary transfer cleanup requires operator retry", {
          objectKey: key,
        }),
    };
  };
  const initiatingHuman = await waitForTurnOperation(
    resolveInitiatingHuman(
      db,
      deps.connectionScope,
      turn.initiatingHumanSubjectId ?? null,
      turn.id,
    ),
    cancellationSignal,
    undefined,
  );
  // Read once per attempt: a backend flip reaches the next attempt, never a
  // tool call already in flight.
  const nangoIntegrationDefinitions = new Map(
    [...(await nangoBackendsFor(db, runSettings))].map(
      ([key, integration]) => [key, integration.definition] as const,
    ),
  );
  try {
    eventing.preparedTools = await waitForTurnOperation(
      runtime.prepareTools(githubRestMcp.settings, githubRestMcp.tools, {
        ...(credentialRestriction ? { credentialRestriction } : {}),
        inputWaitReplyGuard: async (request) =>
          (await eventing.inputWaitReplyGuard?.(request)) ?? null,
        // Integration routes are labelled like connector routes, so every
        // connected account names its connector to the model and in reviews.
        mcpAccountLabels: new Map([
          ...accountRoutes.accountLabels,
          ...apiIntegrationAccountLabels({
            integrations: installedApiIntegrations,
            bindings: turn.mcpAccountBindings,
            tools: turnTools,
          }),
        ]),
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        // Sign the calling turn into the first-party token so tools classify
        // the caller by its own identity (sacred-pause guard), not the racy
        // live active pointer.
        ...(attempt.turnId ? { turnId: attempt.turnId } : {}),
        attemptId: input.attemptId,
        executionGeneration: attempt.executionGeneration,
        subjectId: "worker:first-party-mcp",
        secretResolver: attemptSecretResolver({
          db,
          bus,
          settings: githubRestMcp.settings,
          agentConfig: session.agent,
          vaultAccess: deps.vaultAccess,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: turn.id,
          attemptId: input.attemptId,
          executionGeneration: attempt.executionGeneration,
        }),
        subjectLabel: "Opengeni worker",
        ...(credentialSubjectId ? { credentialSubjectId } : {}),
        initiatingHumanSubjectId: turn.initiatingHumanSubjectId ?? null,
        initiatingHumanExternalIdentity: initiatingHuman?.externalIdentity ?? null,
        sessionAttachedRemoteMcpTargets: selectedSessionRemoteMcpTargets(
          githubRestMcp.settings,
          session.mcpServers ?? [],
          githubRestMcp.tools,
          localMcpServers,
        ),
        ...(deps.runMcpCredentials ? { runMcpCredentials: deps.runMcpCredentials } : {}),
        ...(codexAppsAuth ? { codexAppsAuth } : {}),
        resolveCredential,
        slackRateLimit: buildSlackApiRateLimiter(db, githubRestMcp.settings),
        ...(operationPersistence ? { mcpOperationPersistence: operationPersistence } : {}),
        ...(linkedAuthority
          ? {
              authorizeAttemptExecution: async () => {
                const current = await getSessionTurnForAttempt(
                  db,
                  input.workspaceId,
                  input.sessionId,
                  input.attemptId,
                );
                if (
                  !current ||
                  current.id !== turn.id ||
                  current.executionGeneration !== attempt.executionGeneration
                )
                  throw new Error("The linked agent attempt is no longer authorized");
              },
            }
          : {}),
        onAuthNeeded: publishToolAuthNeeded,
        nangoIntegrationDefinitions,
        recordNangoUsage: (report) =>
          recordNangoUsageEvent(db, {
            ...report,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: credentialSubjectId ?? turn.initiatingHumanSubjectId ?? null,
          }),
        materializeConnectorAttachments,
        materializeGmailFile: async (request) => {
          throwIfWorkerShuttingDown();
          throwIfTurnCancelled();
          return await materializeGmailFile(request, connectorFileStaging());
        },
        materializeConnectorFile: async (request) => {
          throwIfWorkerShuttingDown();
          throwIfTurnCancelled();
          return await materializeConnectorFile(request, connectorFileStaging());
        },
        readGmailFile: async (request) => {
          throwIfWorkerShuttingDown();
          throwIfTurnCancelled();
          const access = await resolveTurnSandboxAccess(
            sandboxState,
            media.sdkOwnedSandboxSession,
            "Gmail attachment filesystem is unavailable",
          );
          const machineRoot = sandboxState.machinePrimarySession?.workspaceRoot;
          const channel = new SandboxChannelAService({
            session: access.session,
            workspaceRoot: machineRoot ?? "/workspace",
            ...(machineRoot ? { providerPathMode: "workspace-relative" as const } : {}),
            leaseEpoch: access.leaseEpoch,
          });
          return await readGmailFileFromChannel(channel, request);
        },
        refreshOwnedCommand: async (commandId) => {
          throwIfWorkerShuttingDown();
          throwIfTurnCancelled();
          // Read only the existing attempt-owned object. A retained read must
          // not provision a sandbox or follow an active-pointer change.
          const owned = (sandboxState.lazyOwnedSandbox?.session ??
            sandboxState.resolvedSandbox?.established.session ??
            media.sdkOwnedSandboxSession) as {
            refreshOwnedCommand?: (id: string) => Promise<boolean>;
          } | null;
          return (await owned?.refreshOwnedCommand?.(commandId)) ?? false;
        },
        spillOversizedModelToolResult: async ({ operationId, result }) =>
          await toolResultSpill.spill({
            operationId,
            result,
            readers: spilledToolResultReadersForTurn({
              tools: turnTools,
              mcpServers: runSettings.mcpServers,
              sandboxBackend: activeSandboxBackend ?? groupBoxBackend,
            }),
          }),
        modelToolOutputTruncationTokens: () =>
          eventing.modelRunSettings.modelToolOutputTruncationTokens,
        localMcpServers,
        ...(preparationUnavailableMcpServers.size > 0 ? { preparationUnavailableMcpServers } : {}),
        ...(deferNonEagerToolPreparation
          ? {
              deferNonEagerUntilToolDemand: true,
              deferredPreparationStart: "provider-dispatch" as const,
            }
          : {}),
        onPreparationPhase: (measurement) => {
          recordToolPreparationPhase(observability, {
            ...measurement,
            provider: turnExecutionPolicy.providerId,
            backend: activeSandboxBackend ?? groupBoxBackend,
          });
        },
        onAttemptToolCatalog: async (catalog) => {
          await persistAttemptToolCatalog(db, catalog);
        },
        // Manager-style sessions carry a creation-validated permission set
        // for their first-party MCP token; null keeps the fixed default.
        ...(effectiveFirstPartyPermissions
          ? { firstPartyPermissions: effectiveFirstPartyPermissions }
          : {}),
        firstPartyTools: remoteFirstPartyMcpTools,
        nestedAgentDepth: session.nestedAgentDepth,
        effectiveMaxNestedAgentDepth: session.effectiveMaxNestedAgentDepth,
        attemptToolDefinitions,
        connectorActionPolicy,
        attemptConnectorActionBindings,
      }),
      cancellationSignal,
      async (latePreparedTools) => await latePreparedTools.close().catch(() => undefined),
    );
  } catch (error) {
    toolPreparationOutcome = "failed";
    throw error;
  } finally {
    const toolPreparationDurationMs = performance.now() - toolPreparationStartedAt;
    recordTurnStartupPhase(observability, {
      phase: "tool_preparation",
      provider: turnExecutionPolicy.providerId,
      backend: activeSandboxBackend ?? groupBoxBackend,
      outcome: toolPreparationOutcome,
      durationSeconds: toolPreparationDurationMs / 1_000,
      count: githubRestMcp.tools.length,
    });
    await publishStartupProgress(eventing, [
      {
        type:
          toolPreparationOutcome === "completed"
            ? "turn.startup.phase.completed"
            : "turn.startup.phase.failed",
        payload: {
          phase: "tools",
          durationMs: Math.max(0, Math.round(toolPreparationDurationMs)),
        },
      },
    ]);
  }
  const postToolPreparationStartedAt = performance.now();
  const activatePreparedToolEnvironment = (
    tools: Awaited<ReturnType<OpenGeniRuntime["prepareTools"]>>,
  ): void => {
    if (
      eventing.toolPreparationClosing ||
      !attempt.turnId ||
      !tools.attemptToolEnvironment ||
      eventing.codemodeDispatcher
    ) {
      return;
    }
    eventing.codemodeDispatcher = new CodemodeAttemptDispatcher(
      db,
      bus,
      tools.attemptToolEnvironment,
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: attempt.turnId,
        attemptId: input.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
      cancellationSignal,
      undefined,
      {},
      (name) => mcpToolDisplayMetadata(tools.mcpServers, name),
      (entry) => toolFamilyForCatalogIdentity(entry, runSettings.mcpServers),
      tools.inputWaitYield,
      // Nobody answers an approval here: a call that needs one is refused.
      unattended,
    );
    eventing.codemodeDispatcher.start();
  };
  if (eventing.preparedTools.ready) {
    const toolPreparationReady = eventing.preparedTools.ready.then((tools) => {
      activatePreparedToolEnvironment(tools);
    });
    // The lazy runtime awaits and rethrows this exact failure when a model
    // attempts to use tools. Attach a handler immediately so an early MCP
    // rejection cannot become a process-level unhandled rejection first.
    void toolPreparationReady.catch(() => undefined);
    eventing.toolPreparationReady = toolPreparationReady;
  } else {
    activatePreparedToolEnvironment(eventing.preparedTools);
  }
  return {
    attemptConnectorActionBindings,
    connectorActionPolicy,
    mcpServers: runSettings.mcpServers,
    mcpAvailabilityNote,
    generateSessionTitleInParallel: titleToolPlan.generateTitleInParallel,
    postToolPreparationStartedAt,
    preparationIndependentToolNames: [
      ...titleToolPlan.preparationIndependentToolNames,
      "skill_read",
    ],
    codeSearchAvailable: codeSearchTools.length > 0,
    promptToolAvailability:
      promptToolAvailability && !toolRouterExpected
        ? { ...promptToolAvailability, toolSearchAbsent: true as const }
        : promptToolAvailability,
    toolRouterInHistory,
    toolRouterExpected,
    skillCatalog,
  };
}

export type PrepareTurnToolPolicyOk = Awaited<ReturnType<typeof prepareTurnToolPolicy>>;
export type PrepareTurnToolRuntimeOk = Awaited<ReturnType<typeof prepareTurnToolRuntime>>;
