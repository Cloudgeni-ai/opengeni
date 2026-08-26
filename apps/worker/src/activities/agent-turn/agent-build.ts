import {
  selectXaiCredentialForUse,
  materializeXaiCredentialForRun,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  getXaiSessionAccountPin,
  setXaiSessionAccountPin,
  getWorkspaceVideoGenerationPolicy,
  loadWorkspaceVercelAiGatewayCredentialLease,
  beginConnectorActionExecution,
  completeConnectorActionExecution,
  prepareConnectorActionApproval,
} from "@opengeni/db";
import {
  type AttemptConnectorActionBinding,
  type BuildAgentOptions,
  type ConnectorActionPolicyHooks,
  type SandboxFileDownload,
  type TurnSandboxCommandSession,
} from "@opengeni/runtime";
import {
  serviceTierForLatencyMode,
  environmentsEncryptionKeyBytes,
  WORKSPACE_GATEWAY_PROVIDER_ID,
  resolveModelProvider,
  type Settings,
} from "@opengeni/config";
import { type CodexRequestContext } from "@opengeni/codex";
import { executeXaiSubscriptionImageGeneration } from "../xai-image-generation";
import { rigProviderImageContentHash, videoGenerationCapabilitiesForPolicy } from "@opengeni/core";
import {
  admitVideoGenerationRequest,
  managedVideoGenerationCredentialLease,
  xaiVideoGenerationCredentialLease,
  type VideoGenerationCredentialLease,
} from "../video-generation-admission";
import { VideoReferenceInputError } from "../video-reference-staging";
import { rigProviderImageSourceImage } from "../packs";
import type { TurnActivityServices as ActivityServices, RunAgentTurnInput } from "../types";
import { recordTurnStartupPhase } from "../../observability-metrics";
import {
  modelVisibleCompanyBrainSkillActivations,
  summarizeCompanyBrainContributions,
} from "../../model-context-contributions";
import { createTurnCredentialLeases } from "./credential-leases";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { executeGatewayImageGeneration } from "../gateway-image-generation";
import { executeCodexImageGeneration } from "../codex-image-generation";
import { resolveImageGenerationReferences } from "../image-generation-references";
import { SandboxChannelAService, type ChannelASession } from "@opengeni/runtime/sandbox";
import { sandboxRunAs } from "@opengeni/runtime";
import { VideoGenerationRejectedResult } from "@opengeni/contracts";

import {
  computerToolModeForTurn,
  structuredToolTransportForTurn,
  hostedWebSearchForTurn,
  connectedSubscriptionImageGenerationAuthority,
} from "./tool-policy";
import type { ClaimTurnOk } from "./claim";
import type { GovernanceModelOk } from "./governance-model";
import type { CompactionPrepOk } from "./compaction-prep";
import type { SandboxTurnRuntime } from "./sandbox-runtime";
import type { runtimeResourcesForTurn } from "./file-resources";
import type { sandboxArtifactRuntimeAdmission } from "./sandbox-route";
import type {
  loadWorkspaceEnvironmentForRunWithCredentials,
  sandboxEnvironmentForRun,
} from "../environment";
import type {
  AttemptIdentityState,
  EventingState,
  ProviderTurnState,
  RecordingState,
  SandboxRuntimeState,
} from "./turn-context";
import { SESSION_TITLE_MODEL_TOOL_NAME } from "./session-title";

export type BuildTurnAgentDeps = {
  input: RunAgentTurnInput;
  db: ActivityServices["db"];
  runtime: ActivityServices["runtime"];
  objectStorage: ActivityServices["objectStorage"];
  observability: ActivityServices["observability"];
  cancellationSignal: AbortSignal | undefined;
  runtimeCancellationSignal: AbortSignal | undefined;
  eventing: EventingState;
  attempt: AttemptIdentityState;
  sandboxState: SandboxRuntimeState;
  recordingState: RecordingState;
  maybeStartOnTurnRecording: SandboxTurnRuntime["maybeStartOnTurnRecording"];
  providerTurn: ProviderTurnState;
  media: ReturnType<typeof createTurnMediaArtifacts>;
  leases: ReturnType<typeof createTurnCredentialLeases>;
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  fileAuthoritySubjectId: ClaimTurnOk["fileAuthoritySubjectId"];
  capabilitySettings: ClaimTurnOk["capabilitySettings"];
  humanInputResume: ClaimTurnOk["humanInputResume"];
  turnExecutionPolicy: ClaimTurnOk["turnExecutionPolicy"];
  runSettings: GovernanceModelOk["runSettings"];
  logicalSandboxSettings: GovernanceModelOk["logicalSandboxSettings"];
  verifiedRigProviderImageId: GovernanceModelOk["verifiedRigProviderImageId"];
  resolvedModel: GovernanceModelOk["resolvedModel"];
  nativeImageProviderBinding: GovernanceModelOk["nativeImageProviderBinding"];
  lazyToolTransport: GovernanceModelOk["lazyToolTransport"];
  modelInputPolicy: GovernanceModelOk["modelInputPolicy"];
  supportsImageInput: GovernanceModelOk["supportsImageInput"];
  agentHumanInputEnabled: GovernanceModelOk["agentHumanInputEnabled"];
  workspaceAgentInstructions: GovernanceModelOk["workspaceAgentInstructions"];
  workspaceGovernance: GovernanceModelOk["workspaceGovernance"];
  structuredWorkspacePolicyActive: GovernanceModelOk["structuredWorkspacePolicyActive"];
  workspaceMemory: GovernanceModelOk["workspaceMemory"];
  rigVersion: GovernanceModelOk["rigVersion"];
  rigName: GovernanceModelOk["rigName"];
  packRuntime: GovernanceModelOk["packRuntime"];
  installedSkillRuntime: GovernanceModelOk["installedSkillRuntime"];
  buildCompanyBrainContributionReceiptFor: GovernanceModelOk["buildCompanyBrainContributionReceiptFor"];
  promptCacheKey: CompactionPrepOk["promptCacheKey"];
  workspaceVariableSet: Awaited<ReturnType<typeof loadWorkspaceEnvironmentForRunWithCredentials>>;
  runtimeResources: ReturnType<typeof runtimeResourcesForTurn>;
  sandboxEnvironment: Record<string, string>;
  sandboxArtifactRuntime: ReturnType<typeof sandboxArtifactRuntimeAdmission>;
  sandboxGitToken: string | undefined;
  sandboxGitTokens: Record<string, string> | undefined;
  sandboxGitCredentialBindings: Awaited<
    ReturnType<typeof sandboxEnvironmentForRun>
  >["gitCredentialBindings"];
  sandboxCodemodeToken: string | undefined;
  fileResourceDownloads: SandboxFileDownload[];
  attemptConnectorActionBindings: readonly AttemptConnectorActionBinding[];
  connectorActionIdentity: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    initiator: Pick<ClaimTurnOk["turn"]["initiator"], "kind" | "subjectId">;
  };
  preparationIndependentToolNames: readonly string[];
  videoGenerationAcceptancesByCallId: Map<string, { operationId: string; requestDigest: string }>;
  activeSandboxBackend: Settings["sandboxBackend"] | undefined;
  groupBoxBackend: Settings["sandboxBackend"];
  postToolPreparationStartedAt: number;
  codexContext: CodexRequestContext | null;
};

export async function buildTurnAgent(deps: BuildTurnAgentDeps) {
  const {
    input,
    db,
    runtime,
    objectStorage,
    observability,
    cancellationSignal,
    runtimeCancellationSignal,
    eventing,
    sandboxState,
    recordingState,
    maybeStartOnTurnRecording,
    providerTurn,
    media,
    leases,
    turn,
    session,
    fileAuthoritySubjectId,
    capabilitySettings,
    humanInputResume,
    turnExecutionPolicy,
    runSettings,
    logicalSandboxSettings,
    verifiedRigProviderImageId,
    resolvedModel,
    nativeImageProviderBinding,
    lazyToolTransport,
    modelInputPolicy,
    supportsImageInput,
    agentHumanInputEnabled,
    workspaceAgentInstructions,
    workspaceGovernance,
    structuredWorkspacePolicyActive,
    workspaceMemory,
    rigVersion,
    rigName,
    packRuntime,
    installedSkillRuntime,
    buildCompanyBrainContributionReceiptFor,
    promptCacheKey,
    workspaceVariableSet,
    runtimeResources,
    sandboxEnvironment,
    sandboxArtifactRuntime,
    sandboxGitToken,
    sandboxGitTokens,
    sandboxGitCredentialBindings,
    sandboxCodemodeToken,
    fileResourceDownloads,
    attemptConnectorActionBindings,
    connectorActionIdentity,
    preparationIndependentToolNames,
    videoGenerationAcceptancesByCallId,
    activeSandboxBackend,
    groupBoxBackend,
    postToolPreparationStartedAt,
    codexContext,
  } = deps;
  const preparedTools = eventing.preparedTools!;

  const missingSessionTitleHint = preparationIndependentToolNames.includes(
    SESSION_TITLE_MODEL_TOOL_NAME,
  );
  // Clone-onto-real-disk hazard (Case B). A session keeps its CLOUD HOME
  // backend (runSettings.sandboxBackend, e.g. "modal") but its ACTIVE sandbox
  // may have been swapped to a connected machine (active_sandbox_id → a
  // selfhosted lease). buildAgent's repository-clone lifecycle hook keys off
  // the EFFECTIVE backend; if we let it default to the home backend it would
  // `git clone` a private GitHub-App repo onto the user's REAL disk. So pass
  // "selfhosted" through when the active sandbox is a connected machine;
  // otherwise leave it undefined so buildAgent defaults to the home backend
  // (byte-for-byte unchanged cloud behavior). `activeSandboxBackend` was
  // resolved ONCE at turn start (above) via resolveActiveSandboxBackend (the
  // tested gate) and is reused here — resolving once is correct because the
  // clone hook runs at beforeAgentStart, so a mid-turn swap can't affect it.
  // buildAgent's option key is `workspaceEnvironment` (internal runtime
  // symbol; the product concept is a variable set). Built as a TYPED const —
  // a direct literal assignment to Pick<BuildAgentOptions,...> IS excess-
  // property-checked, so a wrong key fails tsc. A bare conditional spread
  // inside the options literal is NOT checked, which is exactly how the M1
  // key regression (workspaceVariableSet vs workspaceEnvironment) slipped
  // through and silently dropped the variable-set instructions block.
  const workspaceEnvironmentOption: Pick<BuildAgentOptions, "workspaceEnvironment"> =
    workspaceVariableSet
      ? {
          workspaceEnvironment: {
            name: workspaceVariableSet.name,
            description: workspaceVariableSet.description,
            variableNames: Object.keys(workspaceVariableSet.values),
          },
        }
      : {};
  const hostedWebSearch = hostedWebSearchForTurn(resolvedModel, runSettings.webSearchEnabled);
  const resolveImageReferences = async (
    references: Parameters<typeof resolveImageGenerationReferences>[0]["references"],
  ) =>
    await resolveImageGenerationReferences({
      db,
      objectStorage: objectStorage!,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: fileAuthoritySubjectId,
      references,
      readSandboxFile: async (path, maxBytes) => {
        const imageReferenceSession = (sandboxState.setupBoxSession ??
          media.sdkOwnedSandboxSession) as ChannelASession | null;
        if (!imageReferenceSession) {
          throw new Error("Sandbox image reference is unavailable");
        }
        const relativePath = path.slice("/workspace/".length);
        const referenceRunAs = sandboxRunAs(eventing.modelRunSettings);
        const channel = new SandboxChannelAService({
          session: imageReferenceSession,
          workspaceRoot: "/workspace",
          leaseEpoch: sandboxState.resolvedSandbox?.leaseEpoch ?? 0,
          ...(referenceRunAs ? { runAs: referenceRunAs } : {}),
        });
        const read = await channel.fsRead({
          path: relativePath,
          encoding: "base64",
          maxBytes,
        });
        if (read.truncated) throw new Error("Sandbox image reference exceeds the byte limit");
        return Uint8Array.from(Buffer.from(read.content, "base64"));
      },
    });
  const imageGenerationOption: Pick<BuildAgentOptions, "imageGeneration"> = (() => {
    // Never expose a paid image operation unless its permanent artifact can
    // be committed. Failing after provider execution would leave an
    // unrecoverable outcome-unknown operation with no user-visible image.
    if (!objectStorage) return {};
    if (nativeImageProviderBinding) {
      media.nativeImageGenerationRetention = {
        ...nativeImageProviderBinding,
        sessionId: input.sessionId,
        turnId: turn.id,
        attemptId: input.attemptId,
      };
      return { imageGeneration: { kind: "native_hosted" } };
    }

    if (resolvedModel?.provider.kind === "codex-subscription") {
      const imageAuthority = connectedSubscriptionImageGenerationAuthority(
        codexContext,
        providerTurn.effectiveCodexCredentialId,
      );
      if (!imageAuthority) return {};
      return {
        imageGeneration: {
          kind: "provider_adapter",
          execute: async ({ prompt, references }, { toolCallId }) => {
            const resolvedReferences = await resolveImageReferences(references);
            const receipt = await executeCodexImageGeneration({
              db,
              objectStorage,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turn.id,
              attemptId: input.attemptId,
              toolCallId,
              prompt,
              references: resolvedReferences,
              credentialId: imageAuthority.credentialId,
              codexContext: imageAuthority.credentialContext,
              ...(runtimeCancellationSignal ? { abortSignal: runtimeCancellationSignal } : {}),
            });
            media.rememberGeneratedImageCreatedThisTurn(receipt);
            await media.materializeGeneratedImage(receipt);
            return receipt;
          },
        },
      };
    }

    if (resolvedModel?.provider.kind === "xai-subscription") {
      const imageAuthority = connectedSubscriptionImageGenerationAuthority(
        providerTurn.xaiRequestContext,
        providerTurn.effectiveXaiCredentialId,
      );
      if (!imageAuthority) return {};
      return {
        imageGeneration: {
          kind: "provider_adapter",
          execute: async ({ prompt, references }, { toolCallId }) => {
            const resolvedReferences = await resolveImageReferences(references);
            const receipt = await executeXaiSubscriptionImageGeneration({
              db,
              objectStorage,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turn.id,
              attemptId: input.attemptId,
              toolCallId,
              prompt,
              references: resolvedReferences,
              credentialId: imageAuthority.credentialId,
              xaiContext: imageAuthority.credentialContext,
              ...(runtimeCancellationSignal ? { abortSignal: runtimeCancellationSignal } : {}),
            });
            media.rememberGeneratedImageCreatedThisTurn(receipt);
            await media.materializeGeneratedImage(receipt);
            return receipt;
          },
        },
      };
    }

    const gatewayResolution = resolveModelProvider(
      capabilitySettings,
      WORKSPACE_GATEWAY_PROVIDER_ID,
    );
    const gateway = gatewayResolution?.provider;
    if (gateway?.kind !== "vercel-gateway-workspace" || !gateway.apiKey) return {};
    const gatewayApiKey = gateway.apiKey;
    return {
      imageGeneration: {
        kind: "provider_adapter",
        execute: async ({ prompt, references }, { toolCallId }) => {
          const resolvedReferences = await resolveImageReferences(references);
          const receipt = await executeGatewayImageGeneration({
            db,
            objectStorage,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: turn.id,
            attemptId: input.attemptId,
            apiKey: gatewayApiKey,
            modelId: capabilitySettings.imageGenerationModel,
            prompt,
            references: resolvedReferences,
            toolCallId,
            ...(runtimeCancellationSignal ? { abortSignal: runtimeCancellationSignal } : {}),
          });
          media.rememberGeneratedImageCreatedThisTurn(receipt);
          await media.materializeGeneratedImage(receipt);
          return receipt;
        },
      },
    };
  })();
  const videoGenerationPolicy = await getWorkspaceVideoGenerationPolicy(db, input.workspaceId);
  const videoGenerationEnabled =
    videoGenerationPolicy.defaultModelId !== null &&
    videoGenerationPolicy.enabledModelIds.length > 0;
  let videoGenerationCredential: VideoGenerationCredentialLease | null = null;
  if (objectStorage && videoGenerationEnabled) {
    if (videoGenerationPolicy.fundingSource === "opengeni_credits") {
      videoGenerationCredential = managedVideoGenerationCredentialLease(eventing.modelRunSettings);
    } else if (videoGenerationPolicy.fundingSource === "workspace_gateway") {
      const workspaceCredential = await loadWorkspaceVercelAiGatewayCredentialLease(
        db,
        eventing.modelRunSettings,
        input.workspaceId,
      );
      if (workspaceCredential) {
        videoGenerationCredential = {
          fundingSource: "workspace_gateway",
          ...workspaceCredential,
        };
      }
    } else if (videoGenerationPolicy.fundingSource === "supergrok_subscription") {
      const encryptionKey = environmentsEncryptionKeyBytes(eventing.modelRunSettings);
      const subjectId = leases.xai.subjectId ?? turn.initiatingHumanSubjectId;
      if (encryptionKey && subjectId) {
        const authoritySnapshot =
          providerTurn.xaiAuthoritySnapshot ??
          (await resolveXaiProviderAccountAuthoritySnapshotForAcceptance(db, {
            workspaceId: input.workspaceId,
            subjectId,
          }));
        const pin = await getXaiSessionAccountPin(db, {
          workspaceId: input.workspaceId,
          subjectId,
          sessionId: input.sessionId,
          authoritySnapshot,
        });
        const selected = providerTurn.effectiveXaiCredentialId
          ? {
              credentialId: providerTurn.effectiveXaiCredentialId,
              rotationEnabled: providerTurn.xaiRotationEnabled,
            }
          : await selectXaiCredentialForUse(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              subjectId,
              authoritySnapshot,
              shardKey: input.sessionId,
              pinnedCredentialId: pin?.pinnedCredentialId ?? null,
              pinSource:
                pin?.pinSource === "manual" || pin?.pinSource === "policy" ? pin.pinSource : null,
            });
        if (selected.credentialId) {
          if (
            selected.rotationEnabled &&
            pin?.pinSource !== "manual" &&
            pin?.pinnedCredentialId !== selected.credentialId
          ) {
            await setXaiSessionAccountPin(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              subjectId,
              sessionId: input.sessionId,
              authoritySnapshot,
              credentialId: selected.credentialId,
              pinSource: "policy",
              expectedVersion: pin?.version ?? null,
            }).catch((error: unknown) => {
              if (error instanceof Error && error.message === "xAI session pin changed") return;
              throw error;
            });
          }
          const credential = await materializeXaiCredentialForRun(db, {
            workspaceId: input.workspaceId,
            subjectId,
            credentialId: selected.credentialId,
            authoritySnapshot,
            encryptionKey,
          });
          videoGenerationCredential = xaiVideoGenerationCredentialLease({
            settings: eventing.modelRunSettings,
            credential,
            subjectId,
            authoritySnapshot,
          });
        }
      }
    }
  }
  const videoGenerationOption: Pick<BuildAgentOptions, "videoGeneration"> = (() => {
    if (
      !objectStorage ||
      eventing.modelRunSettings.sandboxBackend === "none" ||
      !videoGenerationCredential ||
      !videoGenerationEnabled
    ) {
      return {};
    }
    // Parse the frozen capability snapshot before advertising either tool.
    // Invalid or unsupported workspace policy therefore fails closed before
    // it can perturb the model's tool list.
    const capabilities = videoGenerationCapabilitiesForPolicy({
      policy: videoGenerationPolicy,
      credentialVersion: videoGenerationCredential.version,
    });
    return {
      videoGeneration: {
        capabilities: async () => capabilities,
        execute: async (toolInput, { toolCallId }) => {
          const sessionForReference =
            sandboxState.resolvedSandbox?.established.session ?? media.sdkOwnedSandboxSession;
          const fence = eventing.toolCancellationFenceRef.current;
          const runAs = sandboxRunAs(eventing.modelRunSettings);
          let accepted: Awaited<ReturnType<typeof admitVideoGenerationRequest>>;
          try {
            accepted = await admitVideoGenerationRequest({
              db,
              storage: objectStorage,
              settings: eventing.modelRunSettings,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turn.id,
              attemptId: input.attemptId,
              toolCallId,
              toolInput,
              policy: videoGenerationPolicy,
              credential: videoGenerationCredential,
              ...(sessionForReference && fence
                ? {
                    runCommand: async (command) =>
                      await fence.runSandboxCommandStructured(
                        sessionForReference as TurnSandboxCommandSession,
                        {
                          ...command,
                          ...(runAs ? { runAs } : {}),
                        },
                      ),
                  }
                : {}),
              ...(runtimeCancellationSignal ? { signal: runtimeCancellationSignal } : {}),
            });
          } catch (error) {
            if (error instanceof VideoReferenceInputError) {
              return VideoGenerationRejectedResult.parse({
                schemaVersion: 1,
                status: "rejected",
                code: error.code,
                message: error.message,
                operationCreated: false,
              });
            }
            throw error;
          }
          videoGenerationAcceptancesByCallId.set(toolCallId, {
            operationId: accepted.operationId,
            requestDigest: accepted.requestDigest,
          });
          return accepted.receipt;
        },
      },
    };
  })();
  const serviceTier = serviceTierForLatencyMode(
    turnExecutionPolicy.providerId,
    turnExecutionPolicy.latencyMode,
  );
  const connectorActionPolicy: ConnectorActionPolicyHooks = {
    prepare: async (call) =>
      await prepareConnectorActionApproval(db, connectorActionIdentity, call),
    begin: async (call) => await beginConnectorActionExecution(db, connectorActionIdentity, call),
    complete: async ({ requestId, outcome }) =>
      await completeConnectorActionExecution(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        requestId,
        attemptId: input.attemptId,
        outcome,
      }),
  };
  const runtimeSkillActivations = [
    ...installedSkillRuntime.activations,
    ...packRuntime.skillActivations,
    ...session.skills.map((skill) => ({
      source: "session" as const,
      id: `session:${session.id}:${skill.name}`,
      artifact: {
        name: skill.name,
        description: skill.description ?? null,
        files: skill.files.map((file) => ({
          path: file.path,
          content: file.content,
        })),
      },
      reason: "attached to session",
    })),
  ];
  const modelVisibleRuntimeSkillActivations = modelVisibleCompanyBrainSkillActivations(
    eventing.modelRunSettings.sandboxBackend,
    runtimeSkillActivations,
  );
  try {
    eventing.companyBrainContextContributions = summarizeCompanyBrainContributions(
      buildCompanyBrainContributionReceiptFor(modelVisibleRuntimeSkillActivations),
    );
  } catch {
    // Contribution telemetry must never change model execution semantics.
  }
  recordTurnStartupPhase(observability, {
    phase: "post_tool_preparation",
    provider: turnExecutionPolicy.providerId,
    backend: activeSandboxBackend ?? groupBoxBackend,
    outcome: "completed",
    durationSeconds: (performance.now() - postToolPreparationStartedAt) / 1_000,
  });
  const agent = (() => {
    const agentConstructionStartedAt = performance.now();
    let agentConstructionOutcome: "completed" | "failed" = "completed";
    try {
      return runtime.buildAgent(eventing.modelRunSettings, runtimeResources, {
        reasoningEffort: turn.reasoningEffort,
        latencyMode: turnExecutionPolicy.latencyMode,
        ...(serviceTier ? { serviceTier } : {}),
        ...(humanInputResume ? { humanInputResponse: humanInputResume } : {}),
        humanInputEnabled: agentHumanInputEnabled,
        missingSessionTitleHint,
        sandboxEnvironment,
        ...(preparedTools.attemptToolCatalog
          ? { attemptToolCatalog: preparedTools.attemptToolCatalog }
          : {}),
        ...(sandboxArtifactRuntime.available ? { artifactRuntimeAvailable: true } : {}),
        ...(cancellationSignal ? { turnCancellationSignal: cancellationSignal } : {}),
        onToolCancellationFence: (fence) => {
          eventing.toolCancellationFenceRef.current = fence;
        },
        // TOKEN-BROKER (B1): forward the per-turn git token OFF-MANIFEST as the clone
        // seed. ONLY when the effective backend is NOT selfhosted (the connected
        // machine uses its own git creds — mirrors the skipGitHubToken gate above)
        // AND the mint actually produced a token (repo resources present). The runtime
        // seeds it to the box's token file before the repository-clone runs; it never
        // touches the box/agent manifest env.
        ...(activeSandboxBackend !== "selfhosted" && sandboxGitTokens
          ? { gitTokenSeeds: sandboxGitTokens }
          : {}),
        ...(activeSandboxBackend !== "selfhosted" && sandboxGitCredentialBindings
          ? { gitCredentialBindings: sandboxGitCredentialBindings }
          : {}),
        ...(activeSandboxBackend !== "selfhosted" && !sandboxGitTokens && sandboxGitToken
          ? { gitTokenSeed: sandboxGitToken }
          : {}),
        ...(sandboxCodemodeToken ? { codemodeAvailable: true } : {}),
        // Managed boxes receive the bearer through their protected per-session
        // token file. Connected Machines use transient per-exec delivery above,
        // so they must not run the file-seeding lifecycle hook.
        ...(activeSandboxBackend !== "selfhosted" && sandboxCodemodeToken
          ? {
              codemodeTokenSeed: sandboxCodemodeToken,
              codemodeTokenSessionId: input.sessionId,
            }
          : {}),
        ...(activeSandboxBackend ? { activeSandboxBackend } : {}),
        ...(activeSandboxBackend === "selfhosted" && sandboxState.machinePrimarySession
          ? { sandboxWorkspaceRoot: sandboxState.machinePrimarySession.workspaceRoot }
          : {}),
        fileResourceDownloads,
        mcpServers: preparedTools.mcpServers,
        resolvedMcpConnectionIds: preparedTools.resolvedMcpConnectionIds,
        connectorActionPolicy,
        attemptConnectorActionBindings,
        // LIVE by-reference connector namespaces (fills during this turn's
        // codex_apps tools/list): the codex tool_search description reads it per
        // model call so the model sees the account's real connected sources.
        codexConnectorNamespaces: preparedTools.codexConnectorNamespaces,
        // Resolved-model routing + gating (legacy defaults when null). The model
        // is passed as the model *string* (agent.model = runSettings.openaiModel),
        // NOT a Model instance: an instance only survives the in-process
        // ("none") run, whereas the SandboxAgent/Modal path drops it and
        // re-resolves the model *name* through the global MultiProviderModelProvider
        // configureOpenAI installed — so registry models (Fireworks GLM) route to
        // their own client instead of 404ing against the built-in Azure/OpenAI
        // client. The gating still comes from the resolved provider: server-side
        // store/compaction follow the provider's compaction mode (registry
        // providers resolve to "client"); encrypted reasoning is only
        // round-tripped on the Responses wire API; hosted web search is attached
        // whenever the provider declares it runnable and is independent of the
        // session's MCP allow-list; the effective context window drives the
        // compaction threshold.
        hostedWebSearch,
        ...imageGenerationOption,
        ...videoGenerationOption,
        lazyToolTransport,
        ...(eventing.toolPreparationReady
          ? { toolPreparationReady: eventing.toolPreparationReady }
          : {}),
        preparationIndependentToolNames,
        supportsImageInput,
        inputFileMediaTypes: modelInputPolicy.inputFileMediaTypes,
        ...(resolvedModel
          ? {
              encryptedReasoning:
                resolvedModel.provider.api === "responses" &&
                runSettings.openaiReasoningEncryptedContent,
              contextWindowTokens:
                resolvedModel.configured.contextWindowTokens ?? runSettings.contextWindowTokens,
              // The ChatGPT/Codex backend rejects the SDK's HOSTED apply_patch
              // tool. Gateway Responses routes likewise expose ordinary function
              // tools, not OpenAI-hosted sandbox tools. Tell buildAgent to use
              // function apply_patch and wrap successful view_image results as
              // typed input_image content. Chat wires have no proven typed image
              // result transport and therefore receive no view_image tool.
              structuredToolTransport: structuredToolTransportForTurn(resolvedModel),
              // EXPLICIT computer-use tool transport. See {@link computerToolModeForTurn}.
              computerToolMode: computerToolModeForTurn(resolvedModel),
              ...(promptCacheKey ? { promptCacheKey } : {}),
            }
          : // LEGACY global-client fallback (resolveTurnModel returned null → the model
            // is not in the registry, served by the built-in OpenAI/Azure Responses
            // client). Pin computerToolMode to function-image EXPLICITLY rather than
            // leaving the runtime to sniff the instance.
            {
              computerToolMode: computerToolModeForTurn(null),
              promptCacheKey: input.sessionId,
            }),
        // Lazy computer-use seam: runtime first brings up :0 only after the model
        // selects a computer tool, then this hook begins the optional proof
        // recording. Shell/filesystem turns never invoke either operation.
        onComputerUseReady: async () => {
          if (!sandboxState.resolvedSandbox) {
            throw new Error("Computer-use display became ready without a resolved sandbox");
          }
          // This callback is the authoritative execution boundary. Record the
          // action before async ffmpeg startup so transport-event ordering cannot
          // make settlement misclassify a real computer turn as unused.
          recordingState.didComputerUse = true;
          await maybeStartOnTurnRecording(sandboxState.resolvedSandbox, activeSandboxBackend);
        },
        onRetainableSessionImageOutput: media.retainSessionImageAtToolBoundary,
        ...(runtimeSkillActivations.length > 0
          ? { skillActivations: runtimeSkillActivations }
          : {}),
        ...(!structuredWorkspacePolicyActive && workspaceAgentInstructions
          ? { instructionsTemplate: workspaceAgentInstructions }
          : {}),
        ...(workspaceGovernance ? { workspaceGovernance } : {}),
        ...(workspaceMemory ? { workspaceMemory } : {}),
        // Per-session persona tier (session > workspace > deployment default).
        // Composed system-level AFTER the workspace persona so it refines it for
        // this one session; absent ⇒ byte-identical to today's composition.
        ...(session.instructions ? { sessionInstructions: session.instructions } : {}),
        ...workspaceEnvironmentOption,
        // RIG RUNTIME (M3): the doctrine block, the setup-script hook (only when
        // the frozen version carries a non-empty script), and the rig credential
        // hooks. All absent for a rig-less turn (byte-for-byte today).
        ...(rigVersion && rigName
          ? {
              rig: { name: rigName, version: rigVersion.version },
              ...(rigVersion.setupScript && rigVersion.setupScript.trim().length > 0
                ? {
                    rigSetup: {
                      rigId: session.rigId!,
                      versionId: rigVersion.id,
                      rigName,
                      script: rigVersion.setupScript,
                      timeoutMs: runSettings.rigSetupTimeoutMs,
                      contentHash: rigProviderImageContentHash({
                        backend: turn.sandboxBackend,
                        sourceImage: rigProviderImageSourceImage(
                          logicalSandboxSettings,
                          turn.sandboxBackend,
                        ),
                        definition: rigVersion,
                      }),
                      ...(verifiedRigProviderImageId
                        ? { verifiedProviderImageId: verifiedRigProviderImageId }
                        : {}),
                    },
                  }
                : {}),
              ...(rigVersion.credentialHooks.length > 0
                ? { rigCredentialHookIds: rigVersion.credentialHooks }
                : {}),
            }
          : {}),
      });
    } catch (error) {
      agentConstructionOutcome = "failed";
      throw error;
    } finally {
      recordTurnStartupPhase(observability, {
        phase: "agent_construction",
        provider: turnExecutionPolicy.providerId,
        backend: activeSandboxBackend ?? groupBoxBackend,
        outcome: agentConstructionOutcome,
        durationSeconds: (performance.now() - agentConstructionStartedAt) / 1_000,
      });
    }
  })();
  const postAgentPreparationStartedAt = performance.now();
  if (
    eventing.modelRunSettings.sandboxBackend !== "none" &&
    eventing.toolCancellationFenceRef.current === null
  ) {
    throw new Error(
      "Sandbox agent construction did not install the mandatory turn tool cancellation fence",
    );
  }
  return {
    agent,
    modelVisibleRuntimeSkillActivations,
    postAgentPreparationStartedAt,
  };
}

export type BuildTurnAgentOk = Awaited<ReturnType<typeof buildTurnAgent>>;
