import {
  getScheduledVariableSetExpectedGenerationForAttempt,
  getWorkspaceModelPolicy,
  listWorkspaceGatewayCustomModels,
  listWorkspaceOpenRouterCustomModels,
  persistAttemptToolCatalog,
  namedSubjectHasLiveWorkspaceAuthority,
  updateSessionTitleWithEvent,
  withCodexAppsRequestAuthorization,
  workspaceCodexSubscriptionActive,
  workspaceVercelAiGatewayConnectionActive,
  workspaceOpenRouterConnectionActive,
  workspaceXaiSubscriptionActiveForAuthority,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import {
  type OpenGeniRuntime,
  type AttemptConnectorActionBinding,
  type ConnectorAttachmentMaterializationRequest,
  createFirstPartyInteractionAttemptToolDefinitions,
} from "@opengeni/runtime";
import {
  authorizeGoogleDrivePublicationAttempt,
  createGoogleDrivePublicationAttemptTool,
  googleDrivePublicationConnectorCall,
  resolveGoogleDrivePublicationTarget,
} from "../google-drive-publication";
import { connectionTokenResolverForTurn } from "../mcp-credentials";
import { buildApiIntegrationServersForTurn } from "../api-integrations";
import { buildGitHubRestMcpForTurn } from "../../github-rest-mcp";
import { materializeConnectorAttachmentsInChannel } from "../connector-attachments";
import { allowedFirstPartyMcpToolsForSession, type Settings } from "@opengeni/config";
import { CodemodeAttemptDispatcher } from "../codemode-dispatcher";
import { buildCodexTokenResolver } from "../codex-auth";
import { CODEX_CLIENT_VERSION } from "@opengeni/codex";
import { mergeResourceRefs } from "../common";
import {
  defaultSessionMcpServerIds,
  loadRigDefaultVariableSetEnvironment,
  mergeRigDefaultVariableSetEnvironment,
  resolveCatalogSettings,
  resolveWorkspaceModelSelection,
  withFrozenPersonalConnectionDelegations,
  resolveSessionToolPolicy,
} from "@opengeni/core";
import { loadWorkspaceEnvironmentForRunWithCredentials } from "../environment";
import { withFirstPartyTools } from "../goals";
import type { TurnActivityServices as ActivityServices, RunAgentTurnInput } from "../types";
import { recordTurnStartupPhase } from "../../observability-metrics";
import { ToolResultSpill } from "./tool-result-spill";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { SandboxChannelAService } from "@opengeni/runtime/sandbox";
import { sandboxRunAs } from "@opengeni/runtime";
import { type ToolAuthNeededPayload } from "@opengeni/contracts";

import { shouldPublishToolAuthNeededForTurn, xaiCatalogReadinessAuthority } from "./admission";
import { unavailableMcpOperationalContext } from "./errors";
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
  SandboxRuntimeState,
  WorkspaceRefState,
} from "./turn-context";
import {
  createSessionTitleAttemptToolDefinition,
  sessionTitleToolPlan,
  shouldRequestMissingSessionTitle,
} from "./session-title";
import { resolveTurnSandboxAccess } from "./turn-sandbox-access";
import { createListModelsAttemptToolDefinition } from "./list-models";

export type PrepareTurnToolPolicyDeps = {
  input: RunAgentTurnInput;
  db: ActivityServices["db"];
  cancellationSignal: AbortSignal | undefined;
  connectionCredentials: ActivityServices["connectionCredentials"];
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  fileAuthoritySubjectId: ClaimTurnOk["fileAuthoritySubjectId"];
  capabilitySettings: ClaimTurnOk["capabilitySettings"];
  runSettings: GovernanceModelOk["runSettings"];
  rigVersion: GovernanceModelOk["rigVersion"];
  workspaceRefs: WorkspaceRefState;
};

export type PrepareTurnToolRuntimeDeps = {
  input: RunAgentTurnInput;
  catalogSourceSettings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  runtime: ActivityServices["runtime"];
  objectStorage: ActivityServices["objectStorage"];
  observability: ActivityServices["observability"];
  cancellationSignal: AbortSignal | undefined;
  connectionCredentials: ActivityServices["connectionCredentials"];
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
  codexAppsCredentialId: ClaimTurnOk["codexAppsCredentialId"];
  turnExecutionPolicy: ClaimTurnOk["turnExecutionPolicy"];
  trigger: ClaimTurnOk["trigger"];
  runSettings: GovernanceModelOk["runSettings"];
  lazyToolTransport: GovernanceModelOk["lazyToolTransport"];
  turnTools: ReturnType<typeof withFirstPartyTools>;
  connectionScope: { accountId: string; workspaceId: string };
  hostCredentialRootSessionId: string | null;
  sandboxArtifactRuntime: ReturnType<typeof sandboxArtifactRuntimeAdmission>;
  activeSandboxBackend: Settings["sandboxBackend"] | undefined;
  groupBoxBackend: Settings["sandboxBackend"];
  routingOn: boolean;
  runtimeCancellationSignal: AbortSignal | undefined;
  credentialSubjectId: ClaimTurnOk["credentialSubjectId"];
  interactionInterventionResume: ClaimTurnOk["interactionInterventionResume"];
  runWorkspaceMutationForSandbox: SandboxTurnRuntime["runWorkspaceMutationForSandbox"];
  throwIfWorkerShuttingDown: () => void;
  throwIfTurnCancelled: () => void;
};

export async function prepareTurnToolPolicy(deps: PrepareTurnToolPolicyDeps) {
  const {
    input,
    db,
    cancellationSignal,
    connectionCredentials,
    turn,
    session,
    fileAuthoritySubjectId,
    capabilitySettings,
    runSettings,
    rigVersion,
    workspaceRefs,
  } = deps;

  const turnResources = mergeResourceRefs(session.resources, turn.resources);
  // Repositories remain durable workspace inputs. File attachments do not:
  // only files attached to this exact turn enter the sandbox manifest and
  // eager materialization path. Historical file ids remain in canonical
  // history/session metadata and are recoverable through the Files MCP.
  const runtimeResources = runtimeResourcesForTurn(session.resources, turn.resources);
  // Attach the first-party MCP server to EVERY turn, regardless of how/when
  // the session was created (API, scheduled task, or a pre-existing session
  // whose stored tools predate this). The server registration is then
  // narrowed by the session's exact firstPartyMcpTools selection and
  // authorization. Idempotent: mergeToolRefs dedupes if already present.
  // Resolve the durable policy at the turn boundary. Workspace-default
  // sessions follow the current configured MCP set,
  // while explicit, inherited-fixed, and legacy sessions remain narrowed
  // to their stored materialized allow-list.
  const scheduledEffectiveMcpServerIds = (() => {
    const value =
      turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
        ? (turn.metadata as Record<string, unknown>).scheduledEffectiveMcpServerIds
        : null;
    return Array.isArray(value) && value.every((id) => typeof id === "string")
      ? [...new Set(value)].sort()
      : null;
  })();
  const currentMcpServerIds = new Set(runSettings.mcpServers.map((server) => server.id));
  const resolvedToolPolicy = resolveSessionToolPolicy({
    toolPolicy: session.toolPolicy,
    sessionTools: scheduledEffectiveMcpServerIds ? turn.tools : session.tools,
    availableMcpServerIds: scheduledEffectiveMcpServerIds
      ? scheduledEffectiveMcpServerIds.filter((id) => currentMcpServerIds.has(id))
      : [...currentMcpServerIds],
    defaultMcpServerIds:
      scheduledEffectiveMcpServerIds ?? defaultSessionMcpServerIds(capabilitySettings.mcpServers),
  });
  const mcpAvailabilityNote = unavailableMcpOperationalContext({
    droppedIds: resolvedToolPolicy.effectivePolicy.droppedIds,
    droppedCount: resolvedToolPolicy.effectivePolicy.counts.dropped,
  });
  const effectivePolicyTools = resolvedToolPolicy.toolRefs;
  const turnTools = withFirstPartyTools(runSettings, effectivePolicyTools);
  // §7.6 connection-credential provider — load (and decrypt) selected Variable Sets via the
  // host `sandboxSecrets` provider when bound; unset → today's local decrypt. Preserve the
  // legacy null-attachment fast path: turns with neither a session set nor rig defaults perform
  // no Variable Set work. Organization/workspace sets use the exact turn actor; personal sets
  // additionally require the causal human frozen into the admitted turn.
  const connectionScope = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
  };
  const rigDefaultVariableSetIds = rigVersion?.defaultVariableSetIds ?? [];
  const sessionVariableSetIds = session.variableSetIds;
  let workspaceVariableSet: Awaited<
    ReturnType<typeof loadWorkspaceEnvironmentForRunWithCredentials>
  > = null;
  const explicitEnvironmentValues: Record<string, string> = {};
  const rigDefaultEnvironmentValues: Record<string, string> = {};
  if (sessionVariableSetIds.length > 0 || rigDefaultVariableSetIds.length > 0) {
    const variableSetAuthority = {
      sessionId: input.sessionId,
      turnId: turn.id,
      attemptId: input.attemptId,
      executionGeneration: turn.executionGeneration,
      initiator: turn.initiator,
      initiatingHumanSubjectId: fileAuthoritySubjectId,
    };
    // A scheduled attempt may materialize only the exact generation frozen
    // on its accepted occurrence; ordinary turns resolve to null.
    const expectedVariableSetGeneration = async (
      candidateVariableSetId: string,
    ): Promise<number | null> =>
      await getScheduledVariableSetExpectedGenerationForAttempt(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: fileAuthoritySubjectId ?? turn.initiator.subjectId,
        initiatingHumanSubjectId: fileAuthoritySubjectId,
        sessionId: input.sessionId,
        turnId: turn.id,
        attemptId: input.attemptId,
        executionGeneration: turn.executionGeneration,
        variableSetId: candidateVariableSetId,
      });
    for (const variableSetId of sessionVariableSetIds) {
      const selected = await waitForTurnOperation(
        (async () =>
          loadWorkspaceEnvironmentForRunWithCredentials(
            db,
            runSettings,
            connectionScope,
            variableSetId,
            variableSetAuthority,
            connectionCredentials?.sandboxSecrets,
            connectionCredentials?.sandboxSecrets
              ? { expectedGeneration: await expectedVariableSetGeneration(variableSetId) }
              : {},
          ))(),
        cancellationSignal,
        undefined,
      );
      if (!selected) continue;
      Object.assign(explicitEnvironmentValues, selected.values);
      // Preserve the legacy single-set metadata view as the final,
      // highest-precedence explicit selection while its values represent the
      // complete ordered explicit layer.
      workspaceVariableSet = { ...selected, values: { ...explicitEnvironmentValues } };
    }
    // RIG DEFAULT VARIABLE SETS (M3): decrypt the frozen rig version's default
    // variable sets and layer them BELOW the session's own set — the session's
    // values WIN on any key collision. Loaded through the SAME host-secrets
    // provider path as the session set (embedded-topology parity). Precedence
    // WITHIN the rig defaults is listed order (a later set overrides an earlier
    // one), then the session set overrides all. STABLE-ENV INVARIANT: the rig
    // VERSION is frozen per session, so the SET of default variable sets is
    // fixed for the session's life — the merged manifest env is therefore stable
    // across the session's turns (the same guarantee the session's own variable
    // set already relies on), keeping validateNoEnvironmentDelta empty.
    Object.assign(
      rigDefaultEnvironmentValues,
      await loadRigDefaultVariableSetEnvironment(
        rigDefaultVariableSetIds,
        async (rigDefaultVariableSetId) =>
          await waitForTurnOperation(
            (async () =>
              loadWorkspaceEnvironmentForRunWithCredentials(
                db,
                runSettings,
                connectionScope,
                rigDefaultVariableSetId,
                variableSetAuthority,
                connectionCredentials?.sandboxSecrets,
                connectionCredentials?.sandboxSecrets
                  ? {
                      expectedGeneration:
                        await expectedVariableSetGeneration(rigDefaultVariableSetId),
                    }
                  : {},
              ))(),
            cancellationSignal,
            undefined,
          ),
      ),
    );
  }
  workspaceRefs.variableSetId = workspaceVariableSet?.id ?? "";
  // Session set wins collisions with the rig defaults (explicit precedence).
  const sandboxWorkspaceEnvironmentValues = mergeRigDefaultVariableSetEnvironment(
    rigDefaultEnvironmentValues,
    explicitEnvironmentValues,
  );
  return {
    turnResources,
    runtimeResources,
    mcpAvailabilityNote,
    turnTools,
    connectionScope,
    workspaceVariableSet,
    sandboxWorkspaceEnvironmentValues,
  };
}

export async function prepareTurnToolRuntime(deps: PrepareTurnToolRuntimeDeps) {
  const {
    input,
    catalogSourceSettings,
    db,
    bus,
    runtime,
    objectStorage,
    observability,
    cancellationSignal,
    connectionCredentials,
    eventing,
    attempt,
    sandboxState,
    media,
    toolResultSpill,
    turn,
    session,
    installedApiIntegrations,
    codexAppsCredentialId,
    turnExecutionPolicy,
    trigger,
    runSettings,
    lazyToolTransport,
    turnTools,
    hostCredentialRootSessionId,
    sandboxArtifactRuntime,
    activeSandboxBackend,
    groupBoxBackend,
    routingOn,
    runtimeCancellationSignal,
    credentialSubjectId,
    interactionInterventionResume,
    runWorkspaceMutationForSandbox,
    throwIfWorkerShuttingDown,
    throwIfTurnCancelled,
  } = deps;

  const toolContextPreparationStartedAt = performance.now();
  throwIfWorkerShuttingDown();
  throwIfTurnCancelled();
  const mcpCredentialRootSessionId =
    connectionCredentials?.mcpCredentials && hostCredentialRootSessionId
      ? hostCredentialRootSessionId
      : input.sessionId;
  // Connection credentials and the optional Apps credential are resolved
  // independently. Inference auth is never an Apps fallback.
  const rawResolveCredential = connectionTokenResolverForTurn({
    db,
    settings: runSettings,
    connectionCredentials: connectionCredentials ?? null,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    rootSessionId: mcpCredentialRootSessionId,
    attemptId: input.attemptId,
    turn,
    observability,
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
  const resolveFrozenCredential = withFrozenPersonalConnectionDelegations({
    resolveCredential: rawResolveCredential,
    settings: runSettings,
    personalConnectionDelegations,
    ownerHasWorkspaceMembership: delegatedOwnerHasMembership,
  });
  const resolveCredential: typeof rawResolveCredential = async (request) => {
    const result = await resolveFrozenCredential(request);
    if (result.status === "ok") {
    }
    return result;
  };
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
  const googleDrivePublicationTarget = objectStorage
    ? await resolveGoogleDrivePublicationTarget(
        db,
        { accountId: input.accountId, workspaceId: input.workspaceId },
        personalConnectionDelegations,
      )
    : null;
  const googleDrivePublicationTool =
    objectStorage && googleDrivePublicationTarget
      ? createGoogleDrivePublicationAttemptTool({
          db,
          objectStorage,
          identity: connectorActionIdentity,
          subjectId: googleDrivePublicationTarget.ownerSubjectId,
          target: googleDrivePublicationTarget,
          resolveCredential,
          ...(runtimeCancellationSignal ? { signal: runtimeCancellationSignal } : {}),
        })
      : null;
  const publishToolAuthNeeded = async (payload: ToolAuthNeededPayload): Promise<void> => {
    if (!shouldPublishToolAuthNeededForTurn(payload, trigger, turn)) {
      return;
    }
    await eventing.publish!([{ type: "tool.auth_needed", payload }], true);
  };
  const selectedApiIntegrationServerIds = new Set(turnTools.map((tool) => tool.id));
  const apiIntegrationMcpServers = buildApiIntegrationServersForTurn({
    settings: runSettings,
    integrations: installedApiIntegrations.filter((integration) =>
      selectedApiIntegrationServerIds.has(integration.serverId),
    ),
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
    resources: mergeResourceRefs(session.resources, turn.resources),
    tools: turnTools,
    resolveCredential,
  });
  const localMcpServers = [...apiIntegrationMcpServers, ...githubRestMcp.localMcpServers];
  const codexAppsAuth = codexAppsCredentialId
    ? (() => {
        const resolver = buildCodexTokenResolver(
          db,
          runSettings,
          input.workspaceId,
          codexAppsCredentialId,
        );
        return {
          clientVersion: CODEX_CLIENT_VERSION,
          withAuthorization: async <T>(
            use: (token: { accessToken: string; chatgptAccountId: string | null }) => Promise<T>,
          ): Promise<T> => {
            const snapshot = await resolver.getToken();

            return await withCodexAppsRequestAuthorization(
              db,
              {
                workspaceId: input.workspaceId,
                credentialId: codexAppsCredentialId,
              },
              async () => await use(snapshot),
            );
          },
        };
      })()
    : undefined;
  const selectedFirstPartyMcpTools = allowedFirstPartyMcpToolsForSession(
    runSettings,
    session.firstPartyMcpTools,
  );
  const titleToolPlan = sessionTitleToolPlan({
    tools: turnTools,
    selectedFirstPartyMcpTools,
    shouldRequestTitle: shouldRequestMissingSessionTitle({
      title: session.title,
      titleSource: session.titleSource,
      firstPartyMcpTools: selectedFirstPartyMcpTools,
      firstPartyMcpPermissions: session.firstPartyMcpPermissions,
    }),
  });
  const googleDrivePublicationAllowed =
    selectedFirstPartyMcpTools.includes("editable_artifact_export") &&
    selectedFirstPartyMcpTools.includes("editable_artifact_export_status") &&
    (!session.firstPartyMcpPermissions?.length ||
      (session.firstPartyMcpPermissions.includes("artifacts:read") &&
        session.firstPartyMcpPermissions.includes("artifacts:publish")));
  const googleDriveConnectorBindings: readonly AttemptConnectorActionBinding[] =
    googleDrivePublicationTool && googleDrivePublicationTarget && googleDrivePublicationAllowed
      ? [
          {
            modelName: googleDrivePublicationTool.modelName,
            call: (approvalId, arguments_) =>
              googleDrivePublicationConnectorCall(
                googleDrivePublicationTarget,
                arguments_,
                approvalId,
              ),
          },
        ]
      : [];
  const attemptToolDefinitions = [
    createListModelsAttemptToolDefinition({
      currentModelId: turnExecutionPolicy.productModelId,
      load: async () => {
        const currentCatalog = await resolveCatalogSettings(db, catalogSourceSettings);
        const currentSettings = currentCatalog.settings;
        const xaiReadinessAuthority = xaiCatalogReadinessAuthority(turn, credentialSubjectId);
        const [
          policy,
          codexSubscriptionActive,
          xaiSubscriptionActive,
          workspaceGatewayConnectionActive,
          workspaceGatewayCustomModels,
          openRouterConnectionActive,
          workspaceOpenRouterCustomModels,
        ] = await Promise.all([
          getWorkspaceModelPolicy(db, input.workspaceId),
          workspaceCodexSubscriptionActive(db, currentSettings, input.workspaceId),
          xaiReadinessAuthority && currentSettings.supergrokSubscriptionEnabled
            ? workspaceXaiSubscriptionActiveForAuthority(db, currentSettings, {
                workspaceId: input.workspaceId,
                ...xaiReadinessAuthority,
              })
            : false,
          workspaceVercelAiGatewayConnectionActive(db, input.workspaceId),
          listWorkspaceGatewayCustomModels(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
          }),
          workspaceOpenRouterConnectionActive(db, input.workspaceId),
          listWorkspaceOpenRouterCustomModels(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
          }),
        ]);
        return {
          selections: resolveWorkspaceModelSelection({
            settings: currentSettings,
            policy,
            codexSubscriptionActive,
            xaiSubscriptionActive,
            workspaceGatewayConnectionActive,
            workspaceGatewayCustomModels,
            workspaceOpenRouterConnectionActive: openRouterConnectionActive,
            workspaceOpenRouterCustomModels,
          }),
          modelNotes: currentCatalog.modelNotes,
        };
      },
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
      settings: runSettings,
      scope: {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: turn.id,
        attemptId: input.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
      ...(session.firstPartyMcpPermissions?.length
        ? { permissions: session.firstPartyMcpPermissions }
        : {}),
      selectedTools: selectedFirstPartyMcpTools,
      subjectId: "worker:first-party-mcp",
      subjectLabel: "OpenGeni worker",
      ...(interactionInterventionResume
        ? { interventionResume: interactionInterventionResume }
        : {}),
    }),
    ...(googleDrivePublicationTool && googleDrivePublicationAllowed
      ? [googleDrivePublicationTool]
      : []),
  ];
  recordTurnStartupPhase(observability, {
    phase: "tool_context_preparation",
    provider: turnExecutionPolicy.providerId,
    backend: activeSandboxBackend ?? groupBoxBackend,
    outcome: "completed",
    durationSeconds: (performance.now() - toolContextPreparationStartedAt) / 1_000,
    count: githubRestMcp.tools.length,
  });
  await eventing.publish!([
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
    const runAs = sandboxRunAs(runSettings);
    const channel = new SandboxChannelAService({
      session: sandboxAccess.session,
      workspaceRoot: "/workspace",
      leaseEpoch: sandboxAccess.leaseEpoch,
      emit: async (events) => {
        await eventing.publish?.(events, true);
      },
      ...(runAs ? { runAs } : {}),
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
  try {
    eventing.preparedTools = await waitForTurnOperation(
      runtime.prepareTools(githubRestMcp.settings, githubRestMcp.tools, {
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
        subjectLabel: "OpenGeni worker",
        ...(credentialSubjectId ? { credentialSubjectId } : {}),
        ...(codexAppsAuth ? { codexAppsAuth } : {}),
        resolveCredential,
        onAuthNeeded: publishToolAuthNeeded,
        materializeConnectorAttachments,
        spillOversizedModelToolResult: async ({ operationId, result }) =>
          await toolResultSpill.spill({ operationId, result }),
        localMcpServers,
        ...(deferNonEagerToolPreparation ? { deferNonEagerUntilToolDemand: true } : {}),
        onPreparationPhase: (measurement) => {
          recordTurnStartupPhase(observability, {
            phase: `tool_${measurement.phase}`,
            provider: turnExecutionPolicy.providerId,
            backend: activeSandboxBackend ?? groupBoxBackend,
            outcome: measurement.outcome,
            durationSeconds: measurement.durationSeconds,
            count: githubRestMcp.tools.length,
          });
        },
        onAttemptToolCatalog: async (catalog) => {
          await persistAttemptToolCatalog(db, catalog);
        },
        // Manager-style sessions carry a creation-validated permission set
        // for their first-party MCP token; null keeps the fixed default.
        ...(session.firstPartyMcpPermissions?.length
          ? { firstPartyPermissions: session.firstPartyMcpPermissions }
          : {}),
        firstPartyTools: titleToolPlan.remoteFirstPartyMcpTools,
        nestedAgentDepth: session.nestedAgentDepth,
        effectiveMaxNestedAgentDepth: session.effectiveMaxNestedAgentDepth,
        attemptToolDefinitions,
        ...((googleDrivePublicationTarget && googleDrivePublicationAllowed) ||
        githubRestMcp.authorizeCodemodeCall
          ? {
              attemptToolAuthorize: async (authorization) => {
                const { call } = authorization;
                if (
                  googleDrivePublicationTarget &&
                  googleDrivePublicationAllowed &&
                  call.caller.kind === "codemode" &&
                  call.identity.serverId === "google-drive-publishing" &&
                  call.identity.toolName === "google_drive_publish_file"
                ) {
                  await authorizeGoogleDrivePublicationAttempt({
                    db,
                    identity: connectorActionIdentity,
                    target: googleDrivePublicationTarget,
                    approvalId: call.operationId,
                    arguments: call.arguments,
                  });
                }
                await githubRestMcp.authorizeCodemodeCall?.(authorization);
              },
            }
          : {}),
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
    await eventing.publish!([
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
  // Genesis turn = the first user turn (no assistant history reconciled
  // yet). Durable Postgres state (countSessionHistoryItems includes
  // superseded rows after compaction), NOT a workflow counter (turnsThisRun
  // resets on continueAsNew). Drives the one-shot title hint appended to the
  // agent's instructions; later attempts and goal continuations never match.
  return {
    attemptConnectorActionBindings: [
      ...googleDriveConnectorBindings,
      ...githubRestMcp.connectorBindings,
    ],
    connectorActionIdentity,
    postToolPreparationStartedAt,
    preparationIndependentToolNames: titleToolPlan.preparationIndependentToolNames,
  };
}

export type PrepareTurnToolPolicyOk = Awaited<ReturnType<typeof prepareTurnToolPolicy>>;
export type PrepareTurnToolRuntimeOk = Awaited<ReturnType<typeof prepareTurnToolRuntime>>;
