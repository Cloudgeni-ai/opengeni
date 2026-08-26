import {
  materializeRigVersionForAttempt,
  getWorkspaceModelPolicy,
  getWorkspace,
  resolveCompanyBrainContextSelection,
  getGeneratedVideoArtifact,
  listSessionSystemUpdatesForTurn,
  getOrCreateCompanyProfileSnapshot,
  getOrCreatePreferenceRegistrySnapshot,
  getOrCreateWorkspaceInstructionPolicySnapshot,
  PreferenceRegistryInitiatorError,
  resolveSessionAttemptPersonalResources,
} from "@opengeni/db";
import {
  projectHistoryForProvider,
  restoreGenericDispatchHistoryItems,
  projectModelInputForCapabilities,
  hasActiveWorkspaceInstructionPolicy,
  renderWorkspaceGovernanceContext,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { settingsWithResolvedModelContext, type Settings } from "@opengeni/config";
import { settingsWithSessionMcpServersForRun } from "../capabilities";
import { resolveRigProviderImageForRun } from "@opengeni/core";
import {
  resolveWorkspacePackRuntime,
  resolveWorkspaceInstalledSkillRuntime,
  settingsWithPackSandboxImage,
} from "../packs";
import { createModelHistoryAttachmentProjector } from "../run-input";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import {
  buildCompanyBrainContributionReceipt,
  summarizeCompanyBrainContributions,
} from "../../model-context-contributions";
import {
  collectGeneratedImageReceipts,
  projectGeneratedImageHistoryForModel,
} from "../generated-images";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { retryWhileMissing } from "@opengeni/storage";
import { WorkspaceModelPolicyBlockedError } from "@opengeni/runtime";
import {
  evaluateWorkspaceModelPolicy,
  resolveWorkspaceAgentHumanInputEnabled,
  type MediaGenerationResult,
} from "@opengeni/contracts";

import { assertWorkspaceHumanInputAllowed } from "./admission";
import {
  lazyToolTransportForTurn,
  openAiHostedImageProviderBindingForTurn,
  modelAttachmentInputPolicyForTurn,
} from "./tool-policy";

import type { ClaimTurnOk } from "./claim";
import type { EventingState, WorkspaceRefState } from "./turn-context";

export type GovernanceModelDeps = {
  input: RunAgentTurnInput;
  db: ActivityServices["db"];
  runtime: ActivityServices["runtime"];
  objectStorage: ActivityServices["objectStorage"];
  eventing: EventingState;
  workspaceRefs: WorkspaceRefState;
  media: ReturnType<typeof createTurnMediaArtifacts>;
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  capabilitySettings: ClaimTurnOk["capabilitySettings"];
  fileAuthoritySubjectId: ClaimTurnOk["fileAuthoritySubjectId"];
  humanInputResume: ClaimTurnOk["humanInputResume"];
  turnExecutionPolicy: ClaimTurnOk["turnExecutionPolicy"];
  requiredGeneratedVideoFiles: Array<{
    operationId: string;
    artifactId: string;
    fileId: string;
    objectKey: string;
    sizeBytes: number;
    sha256: string;
    filename: string;
  }>;
};

export type GovernanceModelOk = {
  runtimePreparationStartedAt: number;
  packRuntime: Awaited<ReturnType<typeof resolveWorkspacePackRuntime>>;
  installedSkillRuntime: Awaited<ReturnType<typeof resolveWorkspaceInstalledSkillRuntime>>;
  rigVersion:
    | NonNullable<Awaited<ReturnType<typeof materializeRigVersionForAttempt>>>["version"]
    | null;
  rigName: string | null;
  agentHumanInputEnabled: boolean;
  workspaceAgentInstructions: string | null | undefined;
  workspaceGovernance: ReturnType<typeof renderWorkspaceGovernanceContext>;
  structuredWorkspacePolicyActive: boolean;
  workspaceMemory: string | null | undefined;
  buildCompanyBrainContributionReceiptFor: (
    skillActivations: Parameters<
      typeof buildCompanyBrainContributionReceipt
    >[0]["skillActivations"],
  ) => ReturnType<typeof buildCompanyBrainContributionReceipt>;
  logicalSandboxSettings: Settings;
  verifiedRigProviderImageId: string | undefined;
  runSettings: Settings;
  resolvedModel: ReturnType<OpenGeniRuntime["resolveTurnModel"]>;
  providerApi:
    | NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["provider"]["api"]
    | "responses";
  nativeImageProviderBinding: ReturnType<typeof openAiHostedImageProviderBindingForTurn>;
  lazyToolTransport: ReturnType<typeof lazyToolTransportForTurn>;
  modelInputPolicy: ReturnType<typeof modelAttachmentInputPolicyForTurn>;
  supportsImageInput: boolean;
  modelHistoryProjector: (
    items: Array<Record<string, unknown>>,
    projectionOptions?: Parameters<ReturnType<typeof createModelHistoryAttachmentProjector>>[1],
  ) => Promise<Array<Record<string, unknown>>>;
  generatedImageHistoryProjector: (
    items: Array<Record<string, unknown>>,
  ) => Promise<Array<Record<string, unknown>>>;
  compactionModelHistoryProjector: (
    items: Array<Record<string, unknown>>,
  ) => Promise<Array<Record<string, unknown>>>;
};

export type GovernanceModelOutcome = { exit: RunAgentTurnResult } | { ok: GovernanceModelOk };

export async function prepareGovernanceAndModel(
  deps: GovernanceModelDeps,
): Promise<GovernanceModelOutcome> {
  const {
    input,
    db,
    runtime,
    objectStorage,
    eventing,
    workspaceRefs,
    media,
    turn,
    session,
    capabilitySettings,
    fileAuthoritySubjectId,
    humanInputResume,
    turnExecutionPolicy,
    requiredGeneratedVideoFiles,
  } = deps;

  const runtimePreparationStartedAt = performance.now();

  // Personal Rig/Variable Set authority is revalidated immediately before
  // any direct resource read. The database function is a zero-row no-op for
  // sessions with no personal resources, preserving the legacy workspace path.
  await resolveSessionAttemptPersonalResources(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: fileAuthoritySubjectId,
    attemptId: input.attemptId,
  });

  const governanceClaims = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: turn.id,
    attemptId: input.attemptId,
    executionGeneration: turn.executionGeneration,
  };
  // Independent workspace reads after the personal-resource fence. Pack,
  // installed skills, frozen rig, governance snapshots, and model policy do
  // not depend on each other. Company-brain selection still waits on the
  // snapshots below so its receipt stays exact.
  const [
    packRuntime,
    installedSkillRuntime,
    rigMaterialization,
    [workspace, companyProfileSnapshot, instructionPolicySnapshot, preferenceSnapshot],
    workspaceModelPolicy,
  ] = await Promise.all([
    resolveWorkspacePackRuntime(db, input.workspaceId),
    resolveWorkspaceInstalledSkillRuntime(db, input.workspaceId),
    session.rigId && session.rigVersionId
      ? (async () =>
          await materializeRigVersionForAttempt(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: fileAuthoritySubjectId,
            sessionId: input.sessionId,
            turnId: turn.id,
            attemptId: input.attemptId,
            executionGeneration: turn.executionGeneration,
          }))()
      : Promise.resolve(null),
    Promise.all([
      getWorkspace(db, input.workspaceId),
      getOrCreateCompanyProfileSnapshot(db, governanceClaims),
      getOrCreateWorkspaceInstructionPolicySnapshot(db, governanceClaims),
      getOrCreatePreferenceRegistrySnapshot(db, governanceClaims).catch((error) => {
        if (error instanceof PreferenceRegistryInitiatorError) return null;
        throw error;
      }),
    ]),
    getWorkspaceModelPolicy(db, input.workspaceId),
  ]);
  const rigVersion = rigMaterialization?.version ?? null;
  // Rig display name for the doctrine block + setup events/errors (only on a
  // rig-bound turn; null-safe fallback keeps the turn alive if the rig row is
  // gone). Loaded once here alongside the version.
  const rigName = rigVersion ? (rigMaterialization?.rigName ?? "rig") : null;
  // Telemetry: stamp the frozen rig binding (empty for a rig-less turn).
  workspaceRefs.rigId = session.rigId ?? "";
  workspaceRefs.rigVersionId = session.rigVersionId ?? "";
  if (!workspace) throw new Error(`Workspace not found: ${input.workspaceId}`);
  const agentHumanInputEnabled = resolveWorkspaceAgentHumanInputEnabled(workspace.settings);
  const contextSelection = await resolveCompanyBrainContextSelection(db, governanceClaims);
  const workspaceAgentInstructions = contextSelection.legacyWorkspaceInstructions;
  const memoryPromptMode = contextSelection.receipt.memoryPromptMode;
  assertWorkspaceHumanInputAllowed(agentHumanInputEnabled, "resume", humanInputResume !== null);
  const companyProfileIncluded = contextSelection.receipt.companyProfileIncluded;
  const workspaceGovernance = renderWorkspaceGovernanceContext(
    {
      companyProfile: companyProfileSnapshot,
      instructionPolicy: instructionPolicySnapshot,
      preferences: preferenceSnapshot,
    },
    {
      includeCompanyProfile: companyProfileIncluded,
    },
  );
  const structuredWorkspacePolicyActive =
    hasActiveWorkspaceInstructionPolicy(instructionPolicySnapshot);
  const workspaceMemory = contextSelection.workspaceMemory;
  const buildCompanyBrainContributionReceiptFor = (
    skillActivations: Parameters<
      typeof buildCompanyBrainContributionReceipt
    >[0]["skillActivations"],
  ) =>
    buildCompanyBrainContributionReceipt({
      contextSelectionReceiptId: contextSelection.receipt.id,
      attemptId: input.attemptId,
      turnId: turn.id,
      nestedAgentDepth: session.nestedAgentDepth,
      memoryPromptMode,
      instructionPolicy: instructionPolicySnapshot,
      workspaceAgentInstructions,
      preferences: preferenceSnapshot,
      companyProfile: companyProfileSnapshot,
      companyProfileIncluded,
      workspaceMemory,
      skillActivations,
    });
  try {
    // Portable operator compaction runs before tool/skill preparation, so its
    // exact Company Brain prefix contains governance and standing memory but
    // no runtime skill catalog. Later compaction paths replace this summary
    // after the complete skill activation set is resolved.
    eventing.companyBrainContextContributions = summarizeCompanyBrainContributions(
      buildCompanyBrainContributionReceiptFor([]),
    );
  } catch {
    // Contribution telemetry must never change model execution semantics.
  }
  // A Rig is always a setup/check layer over the deployment platform sandbox.
  // The pre-v2 Pack image path remains only for rig-less compatibility sessions.
  const logicalSandboxSettings = rigVersion
    ? capabilitySettings
    : settingsWithPackSandboxImage(
        capabilitySettings,
        packRuntime.sandboxImage,
        packRuntime.sandboxProviderImages,
      );
  const providerImageSelection = await resolveRigProviderImageForRun(
    logicalSandboxSettings,
    rigVersion,
    turn.sandboxBackend,
  );
  const providerImageSettings = providerImageSelection.settings;
  const verifiedRigProviderImageId =
    providerImageSelection.reason === "selected"
      ? (providerImageSelection.imageId ?? undefined)
      : undefined;
  const baseRunSettings = {
    // IMAGE PRECEDENCE: a Rig uses the deployment platform base; a rig-less
    // pre-v2 Pack may retain its compatibility image. A matching verified
    // provider-native ID is then applied only to fresh creation without
    // changing the logical lease image.
    ...providerImageSettings,
    openaiModel: turn.model,
    openaiReasoningEffort: turn.reasoningEffort,
    sandboxBackend: turn.sandboxBackend,
  };
  const runSettings = await settingsWithSessionMcpServersForRun(
    db,
    input.workspaceId,
    input.sessionId,
    input.attemptId,
    baseRunSettings,
  );

  // Multi-provider per-turn routing → the provider gating (compaction mode,
  // hosted web search, encrypted reasoning, context window) the agent and
  // compaction summarizer must use; null falls back to the legacy global
  // client. Resolve against `capabilitySettings` (whose openaiModel is the
  // deployment default), NOT `runSettings`: runSettings.openaiModel is the
  // turn's model, so for a turn ON a registry model the built-in provider
  // would otherwise claim that id (configuredModels builds the built-in's
  // models from openaiModel) and shadow the registry entry — resolving the
  // turn to the built-in (Azure) gating while the global model router routes
  // the name to its registry provider. That mismatch attaches web_search to
  // a chat-only Fireworks model. Resolving against the default-model settings
  // keeps gating consistent with the router. Cost accounting covers registry
  // models via configuredModelPricing.
  const resolvedModel = runtime.resolveTurnModel(
    capabilitySettings,
    turnExecutionPolicy.productModelId,
  );
  const providerApi = resolvedModel?.provider.api ?? "responses";
  const nativeImageProviderBinding =
    providerApi === "responses"
      ? openAiHostedImageProviderBindingForTurn(capabilitySettings, resolvedModel)
      : null;
  const lazyToolTransport = lazyToolTransportForTurn(resolvedModel);
  const modelInputPolicy = modelAttachmentInputPolicyForTurn(resolvedModel);
  // Use the proven wire capability, not the catalogue modality alone. Chat
  // providers may advertise vision, but OpenGeni intentionally has no typed
  // image transport for that wire yet; exposing view_image there would turn
  // pixels into a multi-megabyte text/base64 function result.
  const supportsImageInput = modelInputPolicy.supportsImageInput;
  media.modelCanReceiveRetainedSessionImages = supportsImageInput;
  const attachmentProjector = createModelHistoryAttachmentProjector(
    modelInputPolicy,
    objectStorage
      ? async (file) => {
          const object = await retryWhileMissing(async () =>
            objectStorage.getObjectBytes(file.objectKey),
          );
          if (!object) throw new Error("attachment object is missing");
          return object.bytes;
        }
      : undefined,
  );
  const modelHistoryProjector = async (
    items: Array<Record<string, unknown>>,
    projectionOptions?: Parameters<typeof attachmentProjector>[1],
  ) =>
    projectModelInputForCapabilities(
      await attachmentProjector(items, projectionOptions),
      modelInputPolicy,
    );
  const generatedImageHistoryProjector = async (
    items: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> => {
    collectGeneratedImageReceipts(items, media.generatedImageReceiptsByProviderItemId);
    return projectGeneratedImageHistoryForModel(items);
  };
  const compactionModelHistoryProjector = async (items: Array<Record<string, unknown>>) =>
    await modelHistoryProjector(
      projectHistoryForProvider(
        await generatedImageHistoryProjector(restoreGenericDispatchHistoryItems(items)),
        providerApi,
      ),
    );
  // Bind the provider/model catalog's context policy to every model-facing
  // path for this turn. In particular, Codex subscription turns must not
  // inherit the deployment's OpenAI/Azure mode or 1.05M context defaults:
  // raw window, effective ceiling, and auto-compact limit are distinct live
  // catalog values and must reach pre-turn compaction, history guards, and
  // every model call together.
  eventing.modelRunSettings = resolvedModel
    ? settingsWithResolvedModelContext(runSettings, resolvedModel.configured)
    : runSettings;
  // WORKSPACE MODEL POLICY — the authoritative hard gate. Runs immediately
  // after resolution and BEFORE any model call (the compaction summarizer
  // and the main run both come later in this scope), so a blocked
  // provider/model can never be reached through ANY stamp path: explicit
  // turn model, inherited session default, goal-continuation inheritance,
  // or the legacy null-resolution fallback. The frozen execution policy is
  // the attribution source even if an injected test runtime returns no
  // concrete resolved model. Fail-loud, never a silent remap.
  {
    if (workspaceModelPolicy) {
      const verdict = evaluateWorkspaceModelPolicy(workspaceModelPolicy, {
        providerId: turnExecutionPolicy.providerId,
        modelId: turnExecutionPolicy.productModelId,
      });
      if (!verdict.allowed) {
        throw new WorkspaceModelPolicyBlockedError(
          turnExecutionPolicy.productModelId,
          turnExecutionPolicy.providerId,
          verdict.reason,
        );
      }
    }
  }
  // A recovered asynchronous video completion is model-visible only after
  // its durable File is present at the exact sandbox path carried by the
  // receipt. Resolve and verify the claimed update before sandbox policy is
  // chosen so this turn cannot remain lazy and expose an absent path.
  for (const update of await listSessionSystemUpdatesForTurn(
    db,
    input.workspaceId,
    input.sessionId,
    turn.id,
  )) {
    const payload = update.payload as MediaGenerationResult;
    if (payload.type !== "media_generation_result" || payload.status !== "ready") continue;
    const retained = await getGeneratedVideoArtifact(
      db,
      input.workspaceId,
      payload.receipt.artifact.artifactId,
    );
    if (
      !retained ||
      retained.artifact.deletedAt ||
      retained.file.status !== "ready" ||
      retained.file.contentType !== "video/mp4" ||
      retained.file.sizeBytes !== payload.receipt.artifact.originalBytes ||
      retained.file.sha256 !== payload.receipt.artifact.sha256 ||
      retained.artifact.sandboxFilename !== `generated-video-${retained.artifact.id}.mp4`
    ) {
      throw new Error("Generated video completion does not match its retained File");
    }
    requiredGeneratedVideoFiles.push({
      operationId: payload.operationId,
      artifactId: retained.artifact.id,
      fileId: retained.file.id,
      objectKey: retained.file.objectKey,
      sizeBytes: retained.file.sizeBytes,
      sha256: retained.file.sha256,
      filename: retained.artifact.sandboxFilename,
    });
  }

  return {
    ok: {
      runtimePreparationStartedAt,
      packRuntime,
      installedSkillRuntime,
      rigVersion,
      rigName,
      agentHumanInputEnabled,
      workspaceAgentInstructions,
      workspaceGovernance,
      structuredWorkspacePolicyActive,
      workspaceMemory,
      buildCompanyBrainContributionReceiptFor,
      logicalSandboxSettings,
      verifiedRigProviderImageId,
      runSettings,
      resolvedModel,
      providerApi,
      nativeImageProviderBinding,
      lazyToolTransport,
      modelInputPolicy,
      supportsImageInput,
      modelHistoryProjector,
      generatedImageHistoryProjector,
      compactionModelHistoryProjector,
    },
  };
}
