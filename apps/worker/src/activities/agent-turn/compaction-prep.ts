import { hasPendingSteerAfterContextCompaction, isSessionCompactionRequested } from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import {
  appendSessionInstructions,
  appendWorkspaceGovernance,
  appendWorkspaceMemory,
  composeAgentInstructions,
  requestRemoteCompactionV2,
  serializedToolsForRemoteCompaction,
  EmptyCompactionSummaryError,
  SUMMARY_BUFFER_TOKENS,
  type ModelResponseUsage,
} from "@opengeni/runtime";
import { type Settings } from "@opengeni/config";
import { maybeCompactContext, settleFailedContextCompactionLandmark } from "../context-compaction";
import type { CompactionSummarizer, RemoteCompactionV2Requester } from "../context-compaction";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import {
  recordContextCompaction,
  recordContextCompactionStarted,
} from "../../observability-metrics";
import { createTurnCredentialLeases } from "./credential-leases";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { type SessionEvent } from "@opengeni/contracts";

import { acceptsPromptCacheKeyForTurn } from "./codex";
import {
  safeErrorDiagnostic,
  compactionFailureReasonFromError,
  isCompactionSummaryFailure,
  shouldRecoverCompactionProviderFailure,
} from "./errors";
import {
  createCompactionModelUsageEventState,
  processCompactionModelUsageEvent,
} from "./model-usage";
import { waitForTurnOperation } from "./sandbox-provision";

import type { ClaimTurnOk } from "./claim";
import type { GovernanceModelOk } from "./governance-model";
import type {
  AttemptIdentityState,
  BillingState,
  ClaimedResult,
  EventingState,
  ProviderTurnState,
  TurnControlState,
} from "./turn-context";

export type RemoteCompactionPrefix = {
  tools: Awaited<ReturnType<typeof serializedToolsForRemoteCompaction>>;
  instructions: string;
  toolsReady: boolean;
  agent: Parameters<typeof serializedToolsForRemoteCompaction>[0] | null;
};

export type CompactionPrepDeps = {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  observability: ActivityServices["observability"];
  cancellationSignal: AbortSignal | undefined;
  control: TurnControlState;
  attempt: AttemptIdentityState;
  billingState: BillingState;
  eventing: EventingState & {
    publish: NonNullable<EventingState["publish"]>;
    settle: NonNullable<EventingState["settle"]>;
  };
  providerTurn: ProviderTurnState;
  leases: ReturnType<typeof createTurnCredentialLeases>;
  media: ReturnType<typeof createTurnMediaArtifacts>;
  claimedResult: ClaimedResult;
  claimedModelUsageSourceKeys: Set<string>;
  emittedModelUsageSourceKeys: Set<string>;
  modelUsageDispatchId: string;
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  turnExecutionPolicy: ClaimTurnOk["turnExecutionPolicy"];
  resolvedModel: GovernanceModelOk["resolvedModel"];
  workspaceAgentInstructions: GovernanceModelOk["workspaceAgentInstructions"];
  workspaceGovernance: GovernanceModelOk["workspaceGovernance"];
  structuredWorkspacePolicyActive: GovernanceModelOk["structuredWorkspacePolicyActive"];
  workspaceMemory: GovernanceModelOk["workspaceMemory"];
  rigVersion: GovernanceModelOk["rigVersion"];
  rigName: GovernanceModelOk["rigName"];
  compactionModelHistoryProjector: GovernanceModelOk["compactionModelHistoryProjector"];
  summarizeContextForCompaction: ActivityServices["summarizeContextForCompaction"];
  withProviderRequestContext: <T>(fn: () => Promise<T>) => Promise<T>;
  withCodexRemoteCompaction: <T>(fn: () => Promise<T>) => Promise<T>;
};

export type CompactionPrepOk = {
  promptCacheKey: string | undefined;
  remotePrefix: RemoteCompactionPrefix;
  remoteCompactionRequester: RemoteCompactionV2Requester | undefined;
  publishCompactionLiveEvents: (events: SessionEvent[]) => Promise<void>;
  publishCompactionOutcomeEvents: (events: SessionEvent[]) => Promise<void>;
  compactionModeOptions: NonNullable<Parameters<typeof maybeCompactContext>[5]>;
  compactionOnlyTurn: boolean;
  compactionSummarizerFor: (systemInstructions?: string) => CompactionSummarizer;
  settleDeferredSteerAfterCompaction: () => Promise<RunAgentTurnResult | null>;
};

export type CompactionPrepOutcome = { exit: RunAgentTurnResult } | { ok: CompactionPrepOk };

export type PostAgentCompactionDeps = CompactionPrepDeps & {
  remotePrefix: RemoteCompactionPrefix;
  remoteCompactionRequester: CompactionPrepOk["remoteCompactionRequester"];
  publishCompactionLiveEvents: CompactionPrepOk["publishCompactionLiveEvents"];
  publishCompactionOutcomeEvents: CompactionPrepOk["publishCompactionOutcomeEvents"];
  compactionModeOptions: CompactionPrepOk["compactionModeOptions"];
  compactionOnlyTurn: boolean;
  compactionSummarizerFor: CompactionPrepOk["compactionSummarizerFor"];
  settleDeferredSteerAfterCompaction: CompactionPrepOk["settleDeferredSteerAfterCompaction"];
  agent: ReturnType<ActivityServices["runtime"]["buildAgent"]>;
};

export type PostAgentCompactionOk = {
  compactSummarizer: ReturnType<CompactionPrepOk["compactionSummarizerFor"]>;
};

export type PostAgentCompactionOutcome =
  | { exit: RunAgentTurnResult }
  | { ok: PostAgentCompactionOk };

export async function prepareCompaction(deps: CompactionPrepDeps): Promise<CompactionPrepOutcome> {
  const {
    input,
    settings,
    db,
    bus,
    observability,
    cancellationSignal,
    control,
    attempt,
    billingState,
    eventing,
    providerTurn,
    leases,
    media,
    claimedResult,
    claimedModelUsageSourceKeys,
    emittedModelUsageSourceKeys,
    modelUsageDispatchId,
    turn,
    session,
    turnExecutionPolicy,
    resolvedModel,
    workspaceAgentInstructions,
    workspaceGovernance,
    structuredWorkspacePolicyActive,
    workspaceMemory,
    rigVersion,
    rigName,
    compactionModelHistoryProjector,
    summarizeContextForCompaction,
    withProviderRequestContext,
    withCodexRemoteCompaction,
  } = deps;

  const remotePrefix: RemoteCompactionPrefix = {
    tools: [],
    instructions: "",
    toolsReady: false,
    agent: null,
  };

  const promptCacheKey = acceptsPromptCacheKeyForTurn(resolvedModel) ? input.sessionId : undefined;
  const compactionUsageState = createCompactionModelUsageEventState(claimedModelUsageSourceKeys);
  const recordCompactionUsage = async (usage: ModelResponseUsage) => {
    await processCompactionModelUsageEvent({
      usage,
      state: compactionUsageState,
      dispatchId: modelUsageDispatchId,
      settings,
      db,
      observability,
      publish: eventing.publish,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: turn.id,
      provider: resolvedModel?.provider.id ?? settings.openaiProvider,
      providerApi: resolvedModel?.provider.api ?? "responses",
      model: resolvedModel?.configured.id ?? turn.model,
      externallyBilled: billingState.isExternallyBilledTurn,
      chargesOpenGeniCredits: billingState.chargesOpenGeniCredits,
      countsTowardTokenCap: billingState.countsTowardTokenCap,
      turnAttemptId: input.attemptId,
      servingCredentialId: providerTurn.effectiveCodexCredentialId,
      priorSessionCredentialId: providerTurn.priorSessionCodexCredentialId,
      emittedSourceKeys: emittedModelUsageSourceKeys,
      renewLease: () => leases.renewServing("model_usage"),
      leaseLost: leases.servingLost,
      leaseLostMessage: "Provider credential lease expired during context compaction",
      contextContributions: eventing.companyBrainContextContributions,
    });
  };
  const compactionSummarizerFor = (systemInstructions?: string) =>
    resolvedModel
      ? (s: Settings, m: Array<Record<string, unknown>>) =>
          withProviderRequestContext(() =>
            summarizeContextForCompaction(s, m, {
              client: resolvedModel.client,
              provider: resolvedModel.provider,
              api: resolvedModel.provider.api,
              model: turnExecutionPolicy.upstreamModelId,
              maxOutputTokens: SUMMARY_BUFFER_TOKENS,
              onUsage: recordCompactionUsage,
              ...(systemInstructions ? { systemInstructions } : {}),
              ...(promptCacheKey ? { promptCacheKey } : {}),
            }),
          )
      : (s: Settings, m: Array<Record<string, unknown>>) =>
          summarizeContextForCompaction(s, m, {
            model: turnExecutionPolicy.upstreamModelId,
            maxOutputTokens: SUMMARY_BUFFER_TOKENS,
            onUsage: recordCompactionUsage,
            ...(systemInstructions ? { systemInstructions } : {}),
            ...(promptCacheKey ? { promptCacheKey } : {}),
          });
  // Prompt-cache prefix for remote_v2 MUST match ordinary turns:
  // tools → instructions → history. Filled after buildAgent for every
  // compact path (including operator /compact, which now builds the agent
  // first so it does not send empty tools/instructions).
  const remoteCompactionRequester =
    resolvedModel && billingState.isCodexTurn
      ? (s: Settings, m: Array<Record<string, unknown>>) =>
          withCodexRemoteCompaction(async () => {
            // Lazily serialize tools here so EmptyCompactionSummaryError is
            // thrown inside the compaction try/settlement handlers, not as a
            // raw activity failure before maybeCompactContext runs.
            if (!remotePrefix.instructions.trim()) {
              throw new EmptyCompactionSummaryError({
                stage: "remote_v2_instructions",
                reason: "agent_missing_system_instructions",
              });
            }
            if (!remotePrefix.toolsReady) {
              if (!remotePrefix.agent) {
                throw new EmptyCompactionSummaryError({
                  stage: "remote_v2_tools",
                  reason: "agent_missing_for_tools",
                });
              }
              try {
                remotePrefix.tools = await serializedToolsForRemoteCompaction(remotePrefix.agent);
              } catch (error) {
                // Tool schemas sit before instructions in the cache prefix.
                // Failing open to [] would reintroduce a massive pre-compact
                // cache bust — fail closed so we never send a tools mismatch
                // on purpose.
                throw new EmptyCompactionSummaryError({
                  stage: "remote_v2_tools",
                  reason: "serialize_tools_failed",
                  error: String(error),
                });
              }
              remotePrefix.toolsReady = true;
            }
            return requestRemoteCompactionV2(s, m, {
              client: resolvedModel.client,
              provider: resolvedModel.provider,
              model: turnExecutionPolicy.upstreamModelId,
              systemInstructions: remotePrefix.instructions,
              onUsage: recordCompactionUsage,
              tools: remotePrefix.tools,
              ...(promptCacheKey ? { promptCacheKey } : {}),
            });
          })
      : undefined;
  const publishCompactionLiveEvents = async (events: SessionEvent[]) => {
    await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, events);
  };
  const publishCompactionOutcomeEvents = async (events: SessionEvent[]) => {
    // `compaction.started` was already fanout via publishCompactionLiveEvents.
    await publishDurableSessionEvents(
      bus,
      input.workspaceId,
      input.sessionId,
      events.filter((event) => event.type !== "session.context.compaction.started"),
    );
  };
  const compactionModeOptions = {
    codexCompactionMode: session.codexCompactionMode,
    isCodexSubscriptionTurn: billingState.isCodexTurn,
    onCompactionStarted: (trigger: "auto" | "operator" | "proactive" | "overflow") =>
      recordContextCompactionStarted(observability, trigger),
    publishLiveEvents: publishCompactionLiveEvents,
    ...(remoteCompactionRequester ? { requestRemoteCompactionV2: remoteCompactionRequester } : {}),
  } as const;

  // Operator /compact:
  // - portable (incl. Codex portable): early maintenance path — no
  //   prepareTools/sandbox; summarizer only needs composed instructions.
  // - remote_v2: fall through to prepareTools/buildAgent so the compact
  //   request reuses the ordinary tools→instructions cache prefix, then
  //   settle without inference. (Requester is also wired for Codex portable
  //   turns but unused there — gate on the frozen session mode.)
  const compactionOnlyTurn = turn.source === "compaction";
  const remoteV2CompactionNeedsAgentPrefix =
    Boolean(remoteCompactionRequester) && session.codexCompactionMode === "remote_v2";
  const settleDeferredSteerAfterCompaction = async (): Promise<RunAgentTurnResult | null> => {
    if (compactionOnlyTurn) return null;
    const pending = await hasPendingSteerAfterContextCompaction(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: turn.id,
      executionGeneration: attempt.executionGeneration,
      attemptId: input.attemptId,
    });
    if (!pending) return null;
    if (
      !(await eventing.settle({
        events: [
          {
            type: "turn.superseded",
            payload: { reason: "steer", deferredUntilCompaction: true },
          },
          { type: "session.status.changed", payload: { status: "queued" } },
        ],
        turnStatus: "superseded",
        sessionStatus: "queued",
        activeTurnId: null,
      }))
    ) {
      return claimedResult({ status: "cancelled" });
    }
    // Metrics currently group user-directed supersession with cancellation;
    // the durable turn outcome remains the precise `superseded` truth.
    control.turnMetricOutcome = "cancelled";
    control.activityStatus = "idle";
    return claimedResult({ status: "idle" });
  };
  if (compactionOnlyTurn && !remoteV2CompactionNeedsAgentPrefix) {
    const compactionInstructions = appendWorkspaceMemory(
      appendSessionInstructions(
        appendWorkspaceGovernance(
          composeAgentInstructions(
            structuredWorkspacePolicyActive
              ? eventing.modelRunSettings.agentInstructionsTemplate
              : (workspaceAgentInstructions ?? eventing.modelRunSettings.agentInstructionsTemplate),
            undefined,
            rigVersion && rigName ? { name: rigName, version: rigVersion.version } : undefined,
          ),
          workspaceGovernance ?? undefined,
        ),
        session.instructions ?? undefined,
      ),
      workspaceMemory ?? undefined,
    );
    const requested = await isSessionCompactionRequested(db, input.workspaceId, input.sessionId);
    let outcome: Awaited<ReturnType<typeof maybeCompactContext>> | null = null;
    if (requested) {
      try {
        outcome = await waitForTurnOperation(
          maybeCompactContext(
            db,
            eventing.modelRunSettings,
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turn.id,
              executionGeneration: attempt.executionGeneration,
              attemptId: input.attemptId,
            },
            session.lastInputTokens,
            compactionSummarizerFor(compactionInstructions),
            {
              force: true,
              clearRequestedCompaction: true,
              trigger: "operator",
              materializeHistory: media.materializeScreenshotHistory,
              projectModelInput: compactionModelHistoryProjector,
              ...compactionModeOptions,
            },
          ),
          cancellationSignal,
          undefined,
        );
      } catch (error) {
        // Codex retries retryable checkpoint-provider failures rather than
        // treating them as a semantic compaction result. Keep the operator
        // request pending and let the ordinary same-turn provider/capacity
        // recovery path re-dispatch this exact maintenance execution.
        if (shouldRecoverCompactionProviderFailure(error)) throw error;
        if (error instanceof TurnAttemptFencedError) throw error;
        // `compaction.started` may already be live — settle skipped before
        // failing the turn so the timeline cannot stick on Compacting…
        const landmark = await settleFailedContextCompactionLandmark(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: turn.id,
            executionGeneration: attempt.executionGeneration,
            attemptId: input.attemptId,
          },
          {
            clearRequestedCompaction: true,
            publishLiveEvents: publishCompactionLiveEvents,
          },
        );
        if (!isCompactionSummaryFailure(error)) throw error;
        const errorMessage = String(compactionFailureReasonFromError(error));
        if (
          !(await eventing.settle!({
            events: [
              {
                type: "turn.failed",
                payload: {
                  error: errorMessage,
                  code: "context_compaction_failed",
                  retryable: false,
                  recovery: "user_message",
                  compacted: false,
                },
              },
              {
                type: "session.status.changed",
                payload: { status: "idle" },
              },
            ],
            turnStatus: "failed",
            sessionStatus: "idle",
            activeTurnId: null,
            ...(landmark.requestConsumed ? {} : { consumeRequestedCompactionFailure: true }),
          }))
        ) {
          return { exit: claimedResult({ status: "cancelled" }) };
        }
        control.turnMetricOutcome = "failed";
        control.activityStatus = "idle";
        control.activityError = error;
        return { exit: claimedResult({ status: "idle" }) };
      }
      if (outcome.events.length > 0) {
        if (outcome.compacted) {
          recordContextCompaction(observability, "operator");
        }
        await publishCompactionOutcomeEvents(outcome.events);
      }
    }
    if (
      !(await eventing.settle!({
        events: [
          {
            type: "turn.completed",
            payload: {
              maintenance: "context_compaction",
              result: outcome?.compacted ? "compacted" : (outcome?.reason ?? "already_applied"),
            },
          },
          { type: "session.status.changed", payload: { status: "idle" } },
        ],
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
      }))
    ) {
      return { exit: claimedResult({ status: "cancelled" }) };
    }
    control.turnMetricOutcome = "completed";
    control.activityStatus = "idle";
    return { exit: claimedResult({ status: "idle" }) };
  }

  return {
    ok: {
      promptCacheKey,
      remotePrefix,
      remoteCompactionRequester,
      publishCompactionLiveEvents,
      publishCompactionOutcomeEvents,
      compactionModeOptions,
      compactionOnlyTurn,
      compactionSummarizerFor,
      settleDeferredSteerAfterCompaction,
    },
  };
}

export async function runPostAgentCompaction(
  deps: PostAgentCompactionDeps,
): Promise<PostAgentCompactionOutcome> {
  const {
    input,
    db,
    observability,
    cancellationSignal,
    control,
    attempt,
    eventing,
    claimedResult,
    turn,
    session,
    remotePrefix,
    remoteCompactionRequester,
    publishCompactionLiveEvents,
    publishCompactionOutcomeEvents,
    compactionModeOptions,
    compactionOnlyTurn,
    compactionSummarizerFor,
    settleDeferredSteerAfterCompaction,
    compactionModelHistoryProjector,
    media,
    agent,
  } = deps;

  const agentInstructions = typeof agent.instructions === "string" ? agent.instructions : "";
  const compactSummarizer = compactionSummarizerFor(
    agentInstructions.trim() ? agentInstructions : undefined,
  );
  if (remoteCompactionRequester) {
    // Exact byte match with the ordinary turn prefix (CLI base_instructions).
    // Tools serialize lazily inside the requester so setup failures settle as
    // compaction failures rather than raw activity crashes.
    remotePrefix.instructions = agentInstructions;
    remotePrefix.agent = agent;
  }

  if (compactionOnlyTurn) {
    const requested = await isSessionCompactionRequested(db, input.workspaceId, input.sessionId);
    let outcome: Awaited<ReturnType<typeof maybeCompactContext>> | null = null;
    if (requested) {
      try {
        outcome = await waitForTurnOperation(
          maybeCompactContext(
            db,
            eventing.modelRunSettings,
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turn.id,
              executionGeneration: attempt.executionGeneration,
              attemptId: input.attemptId,
            },
            session.lastInputTokens,
            compactSummarizer,
            {
              force: true,
              clearRequestedCompaction: true,
              trigger: "operator",
              projectModelInput: compactionModelHistoryProjector,
              ...compactionModeOptions,
            },
          ),
          cancellationSignal,
          undefined,
        );
      } catch (error) {
        // Codex retries retryable checkpoint-provider failures rather than
        // treating them as a semantic compaction result. Keep the operator
        // request pending and let the ordinary same-turn provider/capacity
        // recovery path re-dispatch this exact maintenance execution.
        if (shouldRecoverCompactionProviderFailure(error)) throw error;
        if (error instanceof TurnAttemptFencedError) throw error;
        const landmark = await settleFailedContextCompactionLandmark(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: turn.id,
            executionGeneration: attempt.executionGeneration,
            attemptId: input.attemptId,
          },
          {
            clearRequestedCompaction: true,
            publishLiveEvents: publishCompactionLiveEvents,
          },
        );
        if (!isCompactionSummaryFailure(error)) throw error;
        const errorMessage = String(compactionFailureReasonFromError(error));
        if (
          !(await eventing.settle!({
            events: [
              {
                type: "turn.failed",
                payload: {
                  error: errorMessage,
                  code: "context_compaction_failed",
                  retryable: false,
                  recovery: "user_message",
                  compacted: false,
                },
              },
              {
                type: "session.status.changed",
                payload: { status: "idle" },
              },
            ],
            turnStatus: "failed",
            sessionStatus: "idle",
            activeTurnId: null,
            ...(landmark.requestConsumed ? {} : { consumeRequestedCompactionFailure: true }),
          }))
        ) {
          return { exit: claimedResult({ status: "cancelled" }) };
        }
        control.turnMetricOutcome = "failed";
        control.activityStatus = "idle";
        control.activityError = error;
        return { exit: claimedResult({ status: "idle" }) };
      }
      if (outcome.events.length > 0) {
        if (outcome.compacted) {
          recordContextCompaction(observability, "operator");
        }
        await publishCompactionOutcomeEvents(outcome.events);
      }
    }
    if (
      !(await eventing.settle!({
        events: [
          {
            type: "turn.completed",
            payload: {
              maintenance: "context_compaction",
              result: outcome?.compacted ? "compacted" : (outcome?.reason ?? "already_applied"),
            },
          },
          { type: "session.status.changed", payload: { status: "idle" } },
        ],
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
      }))
    ) {
      return { exit: claimedResult({ status: "cancelled" }) };
    }
    control.turnMetricOutcome = "completed";
    control.activityStatus = "idle";
    return { exit: claimedResult({ status: "idle" }) };
  }

  // Pre-turn durable context compaction. When the single Codex-parity
  // threshold is crossed, this summarizes active history and rebuilds active
  // history as [user messages..., summary] BEFORE the model input is read.
  // Summarizer context overflows drop one oldest summarizer-input item and
  // retry, exactly like Codex. Other failures end this turn honestly.
  // Run before every fresh inference. Approval resumes replay their frozen
  // RunState verbatim and recovering attempts already compacted, if needed,
  // before the first attempt's model boundary.
  if (attempt.triggerType === "user.message" || attempt.triggerType === "system.update.delivered") {
    let forced = false;
    try {
      // Operator /compact (the slash command) sets a durable request flag;
      // observe it without consuming it so a failed/stale attempt cannot
      // lose the request. The replacement transaction clears it on success.
      forced = await isSessionCompactionRequested(db, input.workspaceId, input.sessionId);
      const outcome = await waitForTurnOperation(
        maybeCompactContext(
          db,
          eventing.modelRunSettings,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: attempt.turnId!,
            executionGeneration: attempt.executionGeneration,
            attemptId: input.attemptId,
          },
          session.lastInputTokens,
          // Provider-aware summarizer: when the turn's model resolved to a
          // registry provider, summarize on THAT provider's client + wire API
          // (a chat provider can't summarize through OpenAI/Azure). Null
          // resolution uses the built-in Responses summarizer with the same
          // session prompt-cache key as the main model calls.
          compactSummarizer,
          forced
            ? {
                force: true,
                clearRequestedCompaction: true,
                trigger: "operator",
                materializeHistory: media.materializeScreenshotHistory,
                projectModelInput: compactionModelHistoryProjector,
                ...compactionModeOptions,
              }
            : {
                trigger: "auto",
                materializeHistory: media.materializeScreenshotHistory,
                projectModelInput: compactionModelHistoryProjector,
                ...compactionModeOptions,
              },
        ),
        cancellationSignal,
        undefined,
      );
      if (outcome.events.length > 0) {
        if (outcome.compacted) {
          const compactionTrigger = forced ? "operator" : undefined;
          recordContextCompaction(observability, compactionTrigger ?? "auto");
        }
        await publishCompactionOutcomeEvents(outcome.events);
      }
      if (
        outcome.events.some(
          (event) =>
            event.type === "session.context.compacted" ||
            event.type === "session.context.compaction.skipped",
        )
      ) {
        const deferredSteer = await settleDeferredSteerAfterCompaction();
        if (deferredSteer) return { exit: deferredSteer };
      }
    } catch (compactError) {
      if (shouldRecoverCompactionProviderFailure(compactError)) throw compactError;
      if (compactError instanceof TurnAttemptFencedError) throw compactError;
      const landmark = await settleFailedContextCompactionLandmark(
        db,
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: attempt.turnId!,
          executionGeneration: attempt.executionGeneration,
          attemptId: input.attemptId,
        },
        {
          clearRequestedCompaction: forced,
          publishLiveEvents: publishCompactionLiveEvents,
        },
      );
      if (!isCompactionSummaryFailure(compactError)) throw compactError;
      const deferredSteer = await settleDeferredSteerAfterCompaction();
      if (deferredSteer) return { exit: deferredSteer };
      const errorMessage = String(compactionFailureReasonFromError(compactError));
      observability.error("context compaction failed", {
        sessionId: input.sessionId,
        turnId: attempt.turnId,
        ...safeErrorDiagnostic(compactError),
      });
      if (
        !(await eventing.settle!({
          events: [
            {
              type: "turn.failed",
              payload: {
                error: errorMessage,
                code: "context_compaction_failed",
                retryable: false,
                recovery: "user_message",
                compacted: false,
              },
            },
            { type: "session.status.changed", payload: { status: "idle" } },
          ],
          turnStatus: "failed",
          sessionStatus: "idle",
          activeTurnId: null,
          ...(forced && !landmark.requestConsumed
            ? { consumeRequestedCompactionFailure: true }
            : {}),
        }))
      ) {
        return { exit: claimedResult({ status: "cancelled" }) };
      }
      control.turnMetricOutcome = "failed";
      control.activityStatus = "idle";
      control.activityError = compactError;
      return { exit: claimedResult({ status: "idle" }) };
    }
  }

  return { ok: { compactSummarizer } };
}
