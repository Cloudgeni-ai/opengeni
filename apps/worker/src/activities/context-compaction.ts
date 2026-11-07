import { readReasoningConfiguration } from "@opengeni/codex";
import {
  applyContextCompaction,
  getFiles,
  readActiveSessionHistory,
  recordSkippedContextCompaction,
  recordStartedContextCompaction,
  type Database,
} from "@opengeni/db";
import {
  EmptyCompactionSummaryError,
  REMOTE_COMPACTION_V2_IMPLEMENTATION,
  compactionSummaryOutputTokens,
  buildSummaryItem,
  buildCompactionPromptInput,
  fitCompactionPrefix,
  ANTHROPIC_REQUEST_MAX_BYTES,
  AnthropicSizeRecoveryExhaustedError,
  type AnthropicRequestSize,
  omitOpaqueArtifactsFromPortableCompactionHistory,
  buildCompactionReplacement,
  buildRemoteV2Replacement,
  buildTrimmedCompactionReplacement,
  buildTrimmedContextCheckpointItem,
  CompactionProviderResponseError,
  compactionAttachmentFileIds,
  compactionProviderRejection,
  compactionThresholdTokens,
  compactionReplacementFingerprint,
  decideCompaction,
  DETERMINISTIC_TRIM_COMPACTION_IMPLEMENTATION,
  estimateTokens,
  isCompactionSummary,
  isRemoteCompactionItem,
  PORTABLE_MODEL_SWITCH_COMPACTION_IMPLEMENTATION,
  portableSwitchTranscriptStart,
  latestCompactionReplacementFingerprint,
  prepareCompactionPromptInput,
  projectRemoteCompactionOverflowRetryInput,
  sanitizeHistoryItemsForModel,
  summarizeForCompaction,
  type AttachmentUploadTimes,
  type CompactionItem,
  type CompactionProviderRejection,
} from "@opengeni/runtime";
import { contextInputBudgetTokens, type Settings } from "@opengeni/config";
import { latestAgentInstructionsContext, type SessionEvent } from "@opengeni/contracts";
import { projectRejectedProviderArtifacts } from "./run-input";
import { TurnAttemptFencedError } from "./turn-attempt-fenced";
import {
  compactionTrimFallbackReason,
  type CompactionTrimFallbackReason,
} from "./agent-turn/compaction-trim-fallback";

export type MaybeCompactResult =
  | {
      compacted: false;
      reason: string;
      events: SessionEvent[];
      requestConsumed: boolean;
    }
  | {
      compacted: true;
      supersededFrom: number;
      summaryPosition: number;
      signalTokens: number;
      thresholdTokens: number;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
      replacementFingerprint: string;
      events: SessionEvent[];
    };

/** The worker log sink compaction uses; fields stay content-free. */
export type CompactionObservability = {
  warn(message: string, fields?: Record<string, unknown>): void;
};

/**
 * A portable checkpoint whose summary failed terminally and was replaced by a
 * trimmed history: the newest requests and platform context, with a
 * deterministic note instead of a summary. No other model is asked.
 */
type CompactionTrimFallback = { reason: CompactionTrimFallbackReason; error: unknown };

/**
 * The `fallback` record on `session.context.compacted`. The provider's message
 * is kept here, in the session's own events, so the people who can read the
 * conversation can see why its model refused; logs never carry it.
 */
function compactionTrimFallbackPayload(fallback: CompactionTrimFallback): Record<string, unknown> {
  const rejection = compactionProviderRejection(fallback.error);
  const providerMessage =
    fallback.error instanceof CompactionProviderResponseError
      ? fallback.error.providerMessage
      : null;
  return {
    reason: fallback.reason,
    ...(rejection ? { providerRejection: rejection } : {}),
    ...(providerMessage ? { providerMessage } : {}),
  };
}

/** One content-free log line per fallback: identifiers and classifications only. */
function logCompactionTrimFallback(
  observability: CompactionObservability | undefined,
  scope: { sessionId: string; turnId: string; attemptId: string },
  trigger: string | undefined,
  fallback: CompactionTrimFallback,
  outcome: string,
): void {
  const error = fallback.error;
  const diagnostics =
    error instanceof CompactionProviderResponseError || error instanceof EmptyCompactionSummaryError
      ? error.diagnostics
      : {};
  const pick = (key: string) => {
    const value = diagnostics[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? value
      : undefined;
  };
  const fields: Record<string, string | number | boolean | undefined> = {
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    attemptId: scope.attemptId,
    trigger: trigger ?? "auto",
    fallbackReason: fallback.reason,
    outcome,
    errorName: error instanceof Error ? error.name : typeof error,
    httpStatus: pick("httpStatus"),
    providerErrorType: pick("type"),
    providerErrorCode: pick("code"),
    providerErrorParam: pick("param"),
    providerRequestId: pick("requestId"),
    outputCapRetried: pick("outputCapRetried"),
    stage: pick("stage"),
    reason: pick("reason"),
  };
  observability?.warn(
    outcome === "trimmed"
      ? "context compaction summary failed; history was trimmed instead"
      : "context compaction summary failed and trimming could not reduce history",
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
  );
}

/**
 * Durable context compaction.
 *
 * Portable path: Codex CLI local plaintext checkpoint for every provider and
 * for Codex sessions frozen on `portable`.
 * When the chat's own model cannot produce a summary there, the history is
 * trimmed deterministically instead (see {@link CompactionTrimFallback}).
 *
 * Remote v2 path: when the session is frozen on `remote_v2` and the turn is
 * Codex, call Codex `/codex/responses` with `compaction_trigger` and persist the
 * opaque compaction item. Fail closed — never silently fall back to portable.
 */
export type CompactionSummarizer = ((
  settings: Settings,
  input: CompactionItem[],
) => Promise<string>) & {
  /** Model-visible instructions and tool schemas outside the history estimate. */
  estimatePrefixTokens?: () => number;
  /** Exact provider wire size, with the same projection as the checkpoint call. */
  measureInputBytes?: (settings: Settings, input: CompactionItem[]) => Promise<number>;
  /**
   * The exact history of the ordinary request withheld at this model boundary
   * because compaction became due. When it fits, the checkpoint sends it
   * unchanged plus its prompt, so the request extends the previous ordinary
   * request byte for byte and reads its warm prompt cache.
   */
  withheldWireHistory?: () => CompactionItem[] | undefined;
};

/** Returns the opaque Codex remote compaction v2 item. */
export type RemoteCompactionV2Requester = ((
  settings: Settings,
  input: CompactionItem[],
) => Promise<CompactionItem>) & {
  /** Same contract as {@link CompactionSummarizer.withheldWireHistory}. */
  withheldWireHistory?: () => CompactionItem[] | undefined;
};

/**
 * Present only when compaction read the bounded recovery view of an active
 * history over its materialization guard: how many of the oldest rows were
 * left out of the compaction input, and in how many rows inline base64
 * payloads were replaced by a content-free note.
 */
type CompactionInputRecoveryPayload = {
  compactionInputHistoryRowsOmitted?: number;
  compactionInputInlinePayloadRowsElided?: number;
  /** A model switch: oldest transcript items too large for one summary request. */
  modelSwitchEarlierItemsOmitted?: number;
};

/**
 * A chat bound to an agent revision (`sessions.agent_prompt_revision`).
 * Compaction drops the agent instruction edit items it summarizes and folds
 * the newest revision they showed into the system prompt from the next turn
 * on, atomically with the replacement.
 */
export type AgentPromptCompaction = {
  /** `sessions.agent_prompt_revision` as this attempt read it. */
  revision: number;
  /**
   * Only when this turn continues after compaction: the revision its system
   * prompt shows, or null when its prompt has no agent layer (deleted agent).
   * A newer edit is then re-added to the rebuilt history for the rest of the
   * turn, whose system prompt cannot change.
   */
  inPrompt?: number | null;
};

function agentPromptTurnContext(agentPrompt: AgentPromptCompaction | undefined): {
  agentPromptRevision?: number | null;
} {
  return agentPrompt?.inPrompt !== undefined ? { agentPromptRevision: agentPrompt.inPrompt } : {};
}

/** The newest revision the summarized items showed, when it is not already in the prompt. */
function foldedAgentPromptRevision(
  summarized: readonly CompactionItem[],
  agentPrompt: AgentPromptCompaction | undefined,
): { agentPromptRevision?: number } {
  if (!agentPrompt) return {};
  const latest = latestAgentInstructionsContext(summarized);
  return latest?.context.kind === "revision" && latest.context.revision !== agentPrompt.revision
    ? { agentPromptRevision: latest.context.revision }
    : {};
}

export async function maybeCompactContext(
  db: Database,
  settings: Settings,
  scope: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  },
  lastInputTokens: number | null,
  // Injectable for tests; defaults to the real provider-aware model call.
  summarize: CompactionSummarizer = (s, m) =>
    summarizeForCompaction(s, m, {
      maxOutputTokens: compactionSummaryOutputTokens(s.contextWindowTokens),
    }),
  // Operator-forced (the /compact command): bypass the budget trigger and
  // compact now if there is anything to summarize. Structural guards still hold.
  options: {
    force?: boolean;
    clearRequestedCompaction?: boolean;
    trigger?: "auto" | "operator" | "proactive" | "overflow";
    /** Frozen session mode; remote_v2 selects the Codex opaque path. */
    codexCompactionMode?: "remote_v2" | "portable";
    /** True when this turn's resolved provider is codex-subscription. */
    isCodexSubscriptionTurn?: boolean;
    /** Injected remote requester; required for the remote_v2 branch. */
    requestRemoteCompactionV2?: RemoteCompactionV2Requester;
    /**
     * Live fanout for the attempt-fenced `compaction.started` event so the
     * timeline can show progress before the provider call returns. Must never
     * append again — the event is already durable.
     */
    publishLiveEvents?: (events: SessionEvent[]) => Promise<void>;
    /** Observe the durable start immediately after its attempt-fenced commit. */
    onCompactionStarted?: (trigger: "auto" | "operator" | "proactive" | "overflow") => void;
    /** Materialize retained screenshot receipts only in the attempt-local model view. */
    materializeHistory?: (items: CompactionItem[]) => Promise<CompactionItem[]>;
    /** Turn-scoped attachment/modality view; canonical persisted rows stay untouched. */
    projectModelInput?: (items: CompactionItem[]) => Promise<CompactionItem[]>;
    /** A typed pre-dispatch size rejection parks the newest complete work unit. */
    requestSizeRecovery?: { maxBytes: number; size: AnthropicRequestSize };
    /** Agent chats only; see {@link AgentPromptCompaction}. */
    agentPrompt?: AgentPromptCompaction;
    /**
     * The attempt's cancellation signal. A summary cut short by it never
     * falls back to trimming; the cancellation keeps propagating.
     */
    cancellationSignal?: AbortSignal;
    /** Content-free worker logs (identifiers and classifications only). */
    observability?: CompactionObservability;
  } = {},
): Promise<MaybeCompactResult> {
  if (options.codexCompactionMode === "remote_v2" && options.isCodexSubscriptionTurn !== true) {
    // Fail closed: a V2-locked session must never silently take the portable path
    // (mixed history shapes). Admission should have blocked this already.
    throw new Error(
      "session is locked to Codex remote compaction v2 but this turn is not a Codex subscription turn",
    );
  }
  const useRemoteV2 = options.codexCompactionMode === "remote_v2";

  // An automatic check below the provider-accounted threshold cannot compact.
  // Avoid loading and projecting the same complete history that the ordinary
  // model-input path will load immediately afterward. Operator requests still
  // load history so their durable requested/skipped semantics stay unchanged.
  if (!options.force && !options.clearRequestedCompaction) {
    const providerInputTokens =
      typeof lastInputTokens === "number" && lastInputTokens > 0 ? lastInputTokens : 0;
    if (providerInputTokens < compactionThresholdTokens(settings)) {
      return {
        compacted: false,
        reason: "below_threshold",
        events: [],
        requestConsumed: false,
      };
    }
  }

  // Preserve the complete ordered transcript while bounding each Postgres
  // driver result frame beside the decoded history already held by this turn.
  // Over the materialization guard, compaction is the way out: it reads the
  // bounded recovery view (oldest inline payloads, then oldest rows, left out
  // in PostgreSQL) and checkpoints from that instead of failing permanently.
  let activeHistory = await readActiveSessionHistory(db, scope.workspaceId, scope.sessionId, {
    overLimit: "bounded_recovery",
  });
  // A chat that switched from Codex remote compaction to another model still
  // holds Codex's opaque checkpoint, which no other model can read. Rebuild
  // the portable context from the stored transcript instead: the rows that
  // checkpoint replaced are retained, only superseded.
  const portableModelSwitch =
    !useRemoteV2 && activeHistory.items.some((row) => isRemoteCompactionItem(row.item));
  if (portableModelSwitch) {
    activeHistory = await readActiveSessionHistory(db, scope.workspaceId, scope.sessionId, {
      overLimit: "bounded_recovery",
      rows: "stored_transcript",
    });
  }
  const active = portableModelSwitch
    ? activeHistory.items.filter(
        (row) => !isRemoteCompactionItem(row.item) && !isCompactionSummary(row.item),
      )
    : activeHistory.items;
  let recoveryPayload: CompactionInputRecoveryPayload = activeHistory.recovery
    ? {
        compactionInputHistoryRowsOmitted: activeHistory.recovery.omittedRows,
        compactionInputInlinePayloadRowsElided: activeHistory.recovery.elidedRows,
      }
    : {};
  if (portableModelSwitch && active.length === 0) {
    // Nothing readable to rebuild from: fail the turn rather than hand the
    // Codex checkpoint to another model. The chat stays remote_v2 and the
    // next turn on another model asks again.
    throw new EmptyCompactionSummaryError({
      stage: "portable_model_switch",
      reason: "no_history",
    });
  }
  if (active.length === 0) {
    let requestConsumed = false;
    if (options.clearRequestedCompaction) {
      const skipped = await recordSkippedContextCompaction(db, {
        ...scope,
        expectedExecutionGeneration: scope.executionGeneration,
        expectedAttemptId: scope.attemptId,
        reason: "no_history",
      });
      if (!skipped.recorded) {
        throw new TurnAttemptFencedError(
          "turn attempt was fenced while consuming an empty context compaction request",
        );
      }
      requestConsumed = true;
      return {
        compacted: false,
        reason: "no_history",
        events: skipped.events,
        requestConsumed,
      };
    }
    return {
      compacted: false,
      reason: "no_history",
      events: [],
      requestConsumed,
    };
  }

  // Keep the turn that wrote each row beside its projected item, so a retained
  // request is paired only with its own turn's reply and keeps its turn.
  const canonicalItems: CompactionItem[] = [];
  const canonicalTurnIds: (string | null)[] = [];
  for (const row of active) {
    for (const item of projectRejectedProviderArtifacts([row])) {
      canonicalItems.push(item as CompactionItem);
      canonicalTurnIds.push(row.turnId ?? null);
    }
  }
  if (portableModelSwitch) {
    // Keep the newest complete work units that the new model's summarizer can
    // read in one request; older ones are left out rather than deferred.
    const start = portableSwitchTranscriptStart(
      canonicalItems,
      portableSwitchSummaryBudgetTokens(settings, summarize),
    );
    canonicalItems.splice(0, start);
    canonicalTurnIds.splice(0, start);
    if (start > 0) recoveryPayload = { ...recoveryPayload, modelSwitchEarlierItemsOmitted: start };
  }
  const projectForWire = async (input: CompactionItem[]): Promise<CompactionItem[]> => {
    const materialized = options.materializeHistory
      ? await options.materializeHistory(input)
      : input;
    return sanitizeHistoryItemsForModel(
      options.projectModelInput ? await options.projectModelInput(materialized) : materialized,
      settings.modelToolOutputTruncationTokens,
    ) as CompactionItem[];
  };
  const items = await projectForWire(canonicalItems);
  const decision = decideCompaction({
    items,
    lastInputTokens,
    contextWindowTokens: settings.contextWindowTokens,
    contextReservedOutputTokens: settings.contextReservedOutputTokens,
    contextAutoCompactThresholdTokens: settings.contextAutoCompactThresholdTokens,
    contextCompactionThresholdRatio: settings.contextCompactionThresholdRatio,
    ...(options.force || portableModelSwitch ? { force: true } : {}),
  });
  if (!decision.shouldCompact) {
    if (portableModelSwitch)
      throw new EmptyCompactionSummaryError({
        stage: "portable_model_switch",
        reason: decision.reason,
      });
    return {
      compacted: false,
      reason: decision.reason,
      events: [],
      requestConsumed: false,
    };
  }

  const trigger = options.trigger ?? "auto";
  const estimatedTokensBefore = estimateTokens(items);
  const started = await recordStartedContextCompaction(db, {
    ...scope,
    expectedExecutionGeneration: scope.executionGeneration,
    expectedAttemptId: scope.attemptId,
    trigger,
    estimatedTokensBefore,
    ...(options.requestSizeRecovery
      ? { requestSizeRecovery: options.requestSizeRecovery.size }
      : {}),
    ...(useRemoteV2
      ? { implementation: REMOTE_COMPACTION_V2_IMPLEMENTATION }
      : portableModelSwitch
        ? { implementation: PORTABLE_MODEL_SWITCH_COMPACTION_IMPLEMENTATION }
        : {}),
  });
  if (!started.recorded) {
    if (started.reason === "request_size_recovery_exhausted")
      throw new AnthropicSizeRecoveryExhaustedError();
    throw new TurnAttemptFencedError(
      `turn attempt was fenced while recording context compaction start: ${started.reason}`,
    );
  }
  options.onCompactionStarted?.(trigger);
  await options.publishLiveEvents?.(started.events);

  if (useRemoteV2) {
    const outcome = await compactContextRemoteV2(
      db,
      settings,
      scope,
      canonicalItems,
      canonicalTurnIds,
      items,
      decision,
      { ...options, inputRecoveryPayload: recoveryPayload },
      projectForWire,
    );
    return prependCompactionEvents(started.events, outcome);
  }

  const outcome = await compactContextPortable(
    db,
    settings,
    scope,
    canonicalItems,
    canonicalTurnIds,
    items,
    decision,
    summarize,
    { ...options, inputRecoveryPayload: recoveryPayload, portableModelSwitch },
    projectForWire,
  );
  if (portableModelSwitch && !outcome.compacted) {
    // Never reached: a switch rebuild throws instead of settling skipped, so
    // the caller settles the landmark once. Fail closed all the same.
    throw new EmptyCompactionSummaryError({
      stage: "portable_model_switch",
      reason: outcome.reason,
    });
  }
  return prependCompactionEvents(started.events, outcome);
}

/**
 * Token budget for the stored transcript a model switch summarizes: what one
 * checkpoint request on the new model can read, with headroom for the wire
 * projection (attachments, tool disclosures) the local estimate does not see.
 */
function portableSwitchSummaryBudgetTokens(
  settings: Settings,
  summarize: CompactionSummarizer,
): number {
  const outputReserve = compactionSummaryOutputTokens(settings.contextWindowTokens);
  const structuralBudget = Math.min(
    contextInputBudgetTokens(settings) || settings.contextWindowTokens - outputReserve,
    settings.contextWindowTokens - outputReserve,
  );
  const prefixTokens = Math.max(0, Math.ceil(summarize.estimatePrefixTokens?.() ?? 0));
  return Math.max(0, Math.floor((structuralBudget - prefixTokens) * 0.8));
}

/**
 * After `compaction.started`, record a visible skip so the timeline cannot
 * stick on "Compacting…". Used when the provider/summarizer throws a terminal
 * (non-retryable) failure — including auto/overflow paths that never set
 * `compactRequested`.
 */
export async function settleFailedContextCompactionLandmark(
  db: Database,
  scope: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  },
  options: {
    clearRequestedCompaction?: boolean;
    publishLiveEvents?: (events: SessionEvent[]) => Promise<void>;
    /**
     * Closed identifier record of a definitive provider rejection. Carried on
     * the visible `compaction.skipped` landmark so the timeline can name the
     * rejected field instead of offering a retry that cannot succeed.
     */
    providerRejection?: CompactionProviderRejection | null;
    /**
     * The provider's own error message, bounded. It goes only on this
     * session's landmark event, so the conversation's readers can see why
     * the provider refused; logs never carry it.
     */
    providerMessage?: string | null;
  } = {},
): Promise<Extract<MaybeCompactResult, { compacted: false }>> {
  const settled = await settleSkippedAfterStart(db, scope, options, "summarization_failed");
  await options.publishLiveEvents?.(settled.events);
  return settled;
}

/**
 * After `compaction.started`, record that the checkpoint request was cut short
 * by the attempt's own cancellation (graceful worker shutdown, or any other
 * activity cancellation) rather than by a provider or summarizer failure.
 *
 * Unlike {@link settleFailedContextCompactionLandmark}, this never consumes an
 * operator `/compact` request: the recovered attempt of the same turn
 * re-evaluates, exactly as when a Pause has already fenced the attempt. A
 * fence rejection is not an error here: the control that closed the attempt
 * owns the outcome, so the caller's cancellation must keep propagating.
 */
export async function settleInterruptedContextCompactionLandmark(
  db: Database,
  scope: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  },
  options: {
    publishLiveEvents?: (events: SessionEvent[]) => Promise<void>;
  } = {},
): Promise<{ recorded: boolean; events: SessionEvent[] }> {
  const skipped = await recordSkippedContextCompaction(db, {
    ...scope,
    expectedExecutionGeneration: scope.executionGeneration,
    expectedAttemptId: scope.attemptId,
    reason: "interrupted",
    requirePendingRequest: false,
    clearRequestedCompaction: false,
  });
  if (!skipped.recorded) return { recorded: false, events: [] };
  await options.publishLiveEvents?.(skipped.events);
  return { recorded: true, events: skipped.events };
}

function prependCompactionEvents(
  prefix: SessionEvent[],
  outcome: MaybeCompactResult,
): MaybeCompactResult {
  if (prefix.length === 0) return outcome;
  return { ...outcome, events: [...prefix, ...outcome.events] };
}

async function settleSkippedAfterStart(
  db: Database,
  scope: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  },
  options: {
    clearRequestedCompaction?: boolean;
    providerRejection?: CompactionProviderRejection | null;
    providerMessage?: string | null;
  },
  reason:
    | "no_history"
    | "replacement_not_smaller"
    | "replacement_exceeds_model_budget"
    | "replacement_unchanged"
    | "summarization_failed",
): Promise<Extract<MaybeCompactResult, { compacted: false }>> {
  const clearRequestedCompaction = options.clearRequestedCompaction === true;
  const skipped = await recordSkippedContextCompaction(db, {
    ...scope,
    expectedExecutionGeneration: scope.executionGeneration,
    expectedAttemptId: scope.attemptId,
    reason,
    // After `compaction.started`, always settle the landmark. Do not require
    // an operator `/compact` flag — auto/overflow never set one.
    requirePendingRequest: false,
    clearRequestedCompaction,
    ...(options.providerRejection ? { providerRejection: options.providerRejection } : {}),
    ...(options.providerMessage ? { providerMessage: options.providerMessage } : {}),
  });
  if (!skipped.recorded) {
    throw new TurnAttemptFencedError(
      `turn attempt was fenced while recording a context compaction skip (${reason}): ${skipped.reason}`,
    );
  }
  return {
    compacted: false,
    reason,
    events: skipped.events,
    requestConsumed: clearRequestedCompaction,
  };
}

async function compactContextRemoteV2(
  db: Database,
  settings: Settings,
  scope: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  },
  canonicalItems: CompactionItem[],
  canonicalTurnIds: readonly (string | null)[],
  items: CompactionItem[],
  decision: { signalTokens: number; thresholdTokens: number },
  options: {
    clearRequestedCompaction?: boolean;
    trigger?: "auto" | "operator" | "proactive" | "overflow";
    requestRemoteCompactionV2?: RemoteCompactionV2Requester;
    inputRecoveryPayload?: CompactionInputRecoveryPayload;
    agentPrompt?: AgentPromptCompaction;
  },
  projectForWire: (items: CompactionItem[]) => Promise<CompactionItem[]>,
): Promise<MaybeCompactResult> {
  if (!options.requestRemoteCompactionV2) {
    throw new EmptyCompactionSummaryError({
      stage: "remote_v2_requester",
      reason: "missing_requester",
    });
  }
  const estimatedTokensBefore = estimateTokens(items);
  // Codex remote_v2: on a valid compaction item, install and recompute usage.
  // No local "must shrink / must differ" gate — that is portable-only.
  // Fail closed on provider/extract failure — no portable fallback.
  let providerCalls = 1;
  let rewrittenToolOutputs = 0;
  let compactionItem: CompactionItem;
  // The withheld ordinary request is what the provider last cached (plus this
  // step's results); re-projecting durable items would diverge from it.
  const taken = options.requestRemoteCompactionV2.withheldWireHistory?.();
  const exact = taken && withheldHistoryCovers(taken, canonicalItems) ? taken : undefined;
  try {
    compactionItem = await options.requestRemoteCompactionV2(settings, exact ?? items);
  } catch (error) {
    if (!isExactContextLengthExceeded(error)) throw error;
    const retry = projectRemoteCompactionOverflowRetryInput(items);
    if (retry.rewrittenToolOutputs === 0) throw error;
    providerCalls = 2;
    rewrittenToolOutputs = retry.rewrittenToolOutputs;
    compactionItem = await options.requestRemoteCompactionV2(settings, retry.input);
  }
  const retainedTokens = await retentionTokenCounts(canonicalItems, projectForWire);
  const replacement = buildRemoteV2Replacement(
    canonicalItems,
    compactionItem,
    (item) => retainedTokens.get(item) ?? estimateTokens([item]),
    await attachmentUploadTimes(db, scope.workspaceId, canonicalItems),
    {
      itemTurnIds: canonicalTurnIds,
      activeTurnId: scope.turnId,
      ...agentPromptTurnContext(options.agentPrompt),
    },
  );
  const replacementHistory = replacement.history;
  const estimatedTokensAfter = estimateTokens(await projectForWire(replacementHistory));
  const replacementFingerprint = compactionReplacementFingerprint(replacementHistory);
  const summaryIndex =
    replacementHistory.length -
    (readReasoningConfiguration(replacementHistory.at(-1) ?? {}) ? 2 : 1);
  const tailItem = replacementHistory[summaryIndex];
  if (!tailItem) {
    throw new EmptyCompactionSummaryError({
      stage: "remote_v2_replacement",
      reason: "no_replacement_history",
    });
  }
  const applied = await applyContextCompaction(db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    expectedExecutionGeneration: scope.executionGeneration,
    expectedAttemptId: scope.attemptId,
    replacementItems: replacementHistory.slice(0, summaryIndex),
    replacementTurnIds: replacement.turnIds.slice(0, summaryIndex),
    ...(replacementHistory.length > summaryIndex + 1
      ? { trailingItems: replacementHistory.slice(summaryIndex + 1) }
      : {}),
    summaryItem: tailItem as Record<string, unknown>,
    ...(options.clearRequestedCompaction ? { clearRequestedCompaction: true } : {}),
    ...foldedAgentPromptRevision(canonicalItems, options.agentPrompt),
    eventPayload: {
      trigger: options.trigger ?? "auto",
      implementation: REMOTE_COMPACTION_V2_IMPLEMENTATION,
      estimatedTokensBefore,
      estimatedTokensAfter,
      compactionInputToolOutputsRewritten: rewrittenToolOutputs,
      compactionInputProviderCalls: providerCalls,
      ...options.inputRecoveryPayload,
    },
  });
  if (!applied.applied) {
    throw new TurnAttemptFencedError(
      `turn attempt was fenced during remote context compaction: ${applied.reason}`,
    );
  }
  return {
    compacted: true,
    supersededFrom: applied.supersededFrom,
    summaryPosition: applied.summaryPosition,
    signalTokens: decision.signalTokens,
    thresholdTokens: decision.thresholdTokens,
    estimatedTokensBefore,
    estimatedTokensAfter,
    replacementFingerprint,
    events: applied.events,
  };
}

/**
 * The withheld ordinary request may stand in for the durable history only when
 * it covers it: every tool result and every user message the checkpoint will
 * mark as summarized must be in the request the summarizer reads. The ordinary
 * projection only adds request-local items (tool disclosures) and rewrites
 * contents in place, so anything durable it lacks arrived after the request was
 * prepared. The caller then falls back to projecting durable history.
 */
export function withheldHistoryCovers(
  withheld: readonly CompactionItem[],
  canonical: readonly CompactionItem[],
): boolean {
  const resultCallIds = (items: readonly CompactionItem[]) =>
    new Set(
      items.flatMap((item) =>
        item.type === "function_call_result" && typeof item.callId === "string"
          ? [item.callId]
          : [],
      ),
    );
  const userMessages = (items: readonly CompactionItem[]) =>
    items.filter((item) => item.type === "message" && item.role === "user").length;
  const covered = resultCallIds(withheld);
  for (const callId of resultCallIds(canonical)) if (!covered.has(callId)) return false;
  return userMessages(withheld) >= userMessages(canonical);
}

async function compactContextPortable(
  db: Database,
  settings: Settings,
  scope: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  },
  canonicalItems: CompactionItem[],
  canonicalTurnIds: readonly (string | null)[],
  items: CompactionItem[],
  decision: { signalTokens: number; thresholdTokens: number },
  summarize: CompactionSummarizer,
  options: {
    clearRequestedCompaction?: boolean;
    trigger?: "auto" | "operator" | "proactive" | "overflow";
    requestSizeRecovery?: { maxBytes: number };
    inputRecoveryPayload?: CompactionInputRecoveryPayload;
    /** Rebuilding a Codex remote_v2 chat's context from its stored transcript. */
    portableModelSwitch?: boolean;
    agentPrompt?: AgentPromptCompaction;
    cancellationSignal?: AbortSignal;
    observability?: CompactionObservability;
  },
  projectForWire: (items: CompactionItem[]) => Promise<CompactionItem[]>,
): Promise<MaybeCompactResult> {
  const estimatedTokensBefore = estimateTokens(items);
  const prefixTokens = Math.max(0, Math.ceil(summarize.estimatePrefixTokens?.() ?? 0));
  const outputReserve = compactionSummaryOutputTokens(settings.contextWindowTokens);
  const structuralBudget = Math.min(
    contextInputBudgetTokens(settings) || settings.contextWindowTokens - outputReserve,
    settings.contextWindowTokens - outputReserve,
  );
  let summarizedItems = canonicalItems;
  let deferredItems: CompactionItem[] = [];
  let summarized: Awaited<ReturnType<typeof summarizeWithCodexOverflowTrimming>> | null = null;
  let fallback: CompactionTrimFallback | null = null;
  try {
    if (summarize.measureInputBytes) {
      const budget = Math.max(0, structuralBudget - prefixTokens);
      const maxBytes = Math.min(
        ANTHROPIC_REQUEST_MAX_BYTES,
        options.requestSizeRecovery?.maxBytes ?? ANTHROPIC_REQUEST_MAX_BYTES,
      );
      const prepare = async (prefix: CompactionItem[]) =>
        buildCompactionPromptInput(
          omitOpaqueArtifactsFromPortableCompactionHistory(await projectForWire(prefix)),
        );
      const fits = async (projected: CompactionItem[]) =>
        estimateTokens(projected) <= budget &&
        (await summarize.measureInputBytes!(settings, projected)) <= maxBytes;
      // Prefer the exact ordinary request withheld at this boundary: it covers
      // the whole durable history and extends the previous request byte for
      // byte. Size recovery and oversized histories still cut a fitting prefix.
      // Always consume it, so a later compaction never sees a stale request.
      const taken = summarize.withheldWireHistory?.();
      // A model switch summarizes the stored transcript; the withheld request
      // still carries Codex's checkpoint and never stands in for it.
      const withheld =
        !options.requestSizeRecovery &&
        !options.portableModelSwitch &&
        taken &&
        withheldHistoryCovers(taken, canonicalItems)
          ? taken
          : undefined;
      const exact = withheld ? buildCompactionPromptInput(withheld) : undefined;
      const exactFits = exact ? await fits(exact) : false;
      const cut = exactFits
        ? canonicalItems.length
        : await fitCompactionPrefix(
            canonicalItems,
            async (prefix) => fits(await prepare(prefix)),
            Boolean(options.requestSizeRecovery),
          );
      if (cut === null)
        throw new EmptyCompactionSummaryError({
          stage: "portable_byte_budget",
          reason: "no_complete_prefix_fit",
        });
      summarizedItems = canonicalItems.slice(0, cut);
      deferredItems = canonicalItems.slice(cut);
      const projected = exactFits && exact ? exact : await prepare(summarizedItems);
      summarized = {
        summaryBody: await summarize(settings, projected),
        preparation: {
          input: projected,
          estimatedInputTokens: estimateTokens(projected),
          rewrittenToolOutputs: 0,
          droppedHistoryItems: 0,
        },
        providerCalls: 1,
      };
    } else summarized = await summarizeWithCodexOverflowTrimming(summarize, settings, items);
  } catch (error) {
    // The chat's own model could not summarize. Rather than fail the turn,
    // keep the newest requests and platform context exactly as a summarized
    // checkpoint would, with a deterministic note in place of the summary.
    // No other model is called, so no history leaves the chat's provider.
    const reason = compactionTrimFallbackReason(error, options.cancellationSignal);
    if (!reason) throw error;
    fallback = { reason, error };
    summarizedItems = canonicalItems;
    deferredItems = [];
  }
  const retainedTokens = await retentionTokenCounts(canonicalItems, projectForWire);
  const turnContext = {
    itemTurnIds: canonicalTurnIds.slice(0, summarizedItems.length),
    activeTurnId: scope.turnId,
    ...agentPromptTurnContext(options.agentPrompt),
  };
  const checkpointTokens = estimateTokens([
    summarized
      ? buildSummaryItem(summarized.summaryBody)
      : buildTrimmedContextCheckpointItem(summarizedItems, turnContext),
  ]);
  const retainedBudget = Math.min(
    outputReserve,
    Math.max(0, structuralBudget - prefixTokens - checkpointTokens),
  );
  const retainedItemTokens = (item: CompactionItem) =>
    retainedTokens.get(item) ?? estimateTokens([item]);
  const uploadTimes = await attachmentUploadTimes(db, scope.workspaceId, summarizedItems);
  const replacement = summarized
    ? buildCompactionReplacement(
        summarizedItems,
        summarized.summaryBody,
        retainedItemTokens,
        retainedBudget,
        uploadTimes,
        turnContext,
      )
    : buildTrimmedCompactionReplacement(
        summarizedItems,
        retainedItemTokens,
        retainedBudget,
        uploadTimes,
        turnContext,
      );
  // A trimmed checkpoint that would not help leaves history as it was, and
  // the turn fails with the summary's own error, as it did without the
  // fallback.
  const trimDidNotHelp = (outcome: string): never => {
    logCompactionTrimFallback(options.observability, scope, options.trigger, fallback!, outcome);
    throw fallback!.error;
  };
  const replacementHistory = replacement.history;
  const estimatedTokensAfter = estimateTokens(
    await projectForWire([...replacementHistory, ...deferredItems]),
  );
  if (estimatedTokensAfter + prefixTokens > structuralBudget) {
    if (fallback) trimDidNotHelp("replacement_exceeds_model_budget");
    // A model switch must not leave Codex's checkpoint in place. Throw rather
    // than settle: the caller settles the landmark and fails the turn.
    if (options.portableModelSwitch)
      throw new EmptyCompactionSummaryError({
        stage: "portable_model_switch",
        reason: "replacement_exceeds_model_budget",
      });
    return await settleSkippedAfterStart(db, scope, options, "replacement_exceeds_model_budget");
  }
  const replacementFingerprint = compactionReplacementFingerprint([
    ...replacementHistory,
    ...deferredItems,
  ]);
  const previousReplacementFingerprint = deferredItems.length
    ? compactionReplacementFingerprint(canonicalItems)
    : latestCompactionReplacementFingerprint(canonicalItems);
  const summaryIndex =
    replacementHistory.length -
    (readReasoningConfiguration(replacementHistory.at(-1) ?? {}) ? 2 : 1);
  const summaryItem = replacementHistory[summaryIndex];
  if (!summaryItem) {
    if (fallback) trimDidNotHelp("summarization_failed");
    // Started already fanout; settle visibly so the landmark cannot stick on
    // "Compacting…". This is not an operator-request clear path.
    if (options.portableModelSwitch)
      throw new EmptyCompactionSummaryError({
        stage: "portable_model_switch",
        reason: "summarization_failed",
      });
    return await settleSkippedAfterStart(db, scope, options, "summarization_failed");
  }
  // A model switch must replace Codex's checkpoint even when the rebuilt
  // context is no smaller than the transcript it summarizes.
  if (!options.portableModelSwitch) {
    if (previousReplacementFingerprint === replacementFingerprint) {
      if (fallback) trimDidNotHelp("replacement_unchanged");
      return await settleSkippedAfterStart(db, scope, options, "replacement_unchanged");
    }
    if (estimatedTokensAfter >= estimatedTokensBefore) {
      if (fallback) trimDidNotHelp("replacement_not_smaller");
      return await settleSkippedAfterStart(db, scope, options, "replacement_not_smaller");
    }
  }
  if (fallback) {
    logCompactionTrimFallback(options.observability, scope, options.trigger, fallback, "trimmed");
  }
  const applied = await applyContextCompaction(db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    expectedExecutionGeneration: scope.executionGeneration,
    expectedAttemptId: scope.attemptId,
    replacementItems: replacementHistory.slice(0, summaryIndex),
    replacementTurnIds: replacement.turnIds.slice(0, summaryIndex),
    ...(replacementHistory.length > summaryIndex + 1 || deferredItems.length > 0
      ? { trailingItems: [...replacementHistory.slice(summaryIndex + 1), ...deferredItems] }
      : {}),
    summaryItem: summaryItem as Record<string, unknown>,
    ...(options.clearRequestedCompaction ? { clearRequestedCompaction: true } : {}),
    ...(options.portableModelSwitch ? { switchToPortableCompaction: true } : {}),
    ...foldedAgentPromptRevision(summarizedItems, options.agentPrompt),
    eventPayload: {
      trigger: options.trigger ?? "auto",
      ...(fallback
        ? {
            implementation: DETERMINISTIC_TRIM_COMPACTION_IMPLEMENTATION,
            fallback: compactionTrimFallbackPayload(fallback),
            ...(options.portableModelSwitch ? { modelSwitch: true } : {}),
          }
        : options.portableModelSwitch
          ? { implementation: PORTABLE_MODEL_SWITCH_COMPACTION_IMPLEMENTATION }
          : {}),
      estimatedTokensBefore,
      estimatedTokensAfter,
      ...(summarized
        ? {
            compactionInputEstimatedTokens: summarized.preparation.estimatedInputTokens,
            compactionInputToolOutputsRewritten: summarized.preparation.rewrittenToolOutputs,
            compactionInputHistoryItemsDropped: summarized.preparation.droppedHistoryItems,
            compactionInputProviderCalls: summarized.providerCalls,
          }
        : {}),
      ...(summarize.measureInputBytes && summarized
        ? { compactionDeferredHistoryItems: deferredItems.length }
        : {}),
      ...options.inputRecoveryPayload,
    },
  });
  if (!applied.applied) {
    throw new TurnAttemptFencedError(
      `turn attempt was fenced during context compaction: ${applied.reason}`,
    );
  }

  return {
    compacted: true,
    supersededFrom: applied.supersededFrom,
    summaryPosition: applied.summaryPosition,
    signalTokens: decision.signalTokens,
    thresholdTokens: decision.thresholdTokens,
    estimatedTokensBefore,
    estimatedTokensAfter,
    replacementFingerprint,
    events: applied.events,
  };
}

export async function summarizeWithCodexOverflowTrimming(
  summarize: CompactionSummarizer,
  settings: Settings,
  activeHistory: CompactionItem[],
): Promise<{
  summaryBody: string;
  preparation: ReturnType<typeof prepareCompactionPromptInput>;
  providerCalls: number;
}> {
  // Codex's estimator is intentionally coarse. Keep the explicit checkpoint
  // request below both the effective input window and the raw window minus the
  // requested summary. Preserve the full portable history copy on the first
  // call whenever it fits; only trim further after an actual provider overflow.
  // Durable active history remains untouched until applyContextCompaction.
  const summaryAwareBudget = Math.max(
    0,
    settings.contextWindowTokens - compactionSummaryOutputTokens(settings.contextWindowTokens),
  );
  const configuredInputBudget = contextInputBudgetTokens(settings);
  const structuralBudget = Math.min(
    configuredInputBudget > 0 ? configuredInputBudget : summaryAwareBudget,
    summaryAwareBudget,
  );
  const prefixTokens = Math.max(0, Math.ceil(summarize.estimatePrefixTokens?.() ?? 0));
  const initialBudget = Math.max(0, structuralBudget - prefixTokens);
  let preparation = prepareCompactionPromptInput(activeHistory, initialBudget);
  // A checkpoint prompt without source history cannot summarize that history.
  // Do not let a plausible-sounding reply replace durable active context.
  const requireHistory = () => {
    if (activeHistory.length > 0 && preparation.input.length === 1) {
      throw new EmptyCompactionSummaryError({
        stage: "portable_input_budget",
        reason: "no_history_fit",
      });
    }
  };
  requireHistory();
  try {
    return {
      summaryBody: await summarize(settings, preparation.input),
      preparation,
      providerCalls: 1,
    };
  } catch (error) {
    if (!isContextWindowExceeded(error)) throw error;
    // The provider is more authoritative than the byte/4 estimate. Refit once
    // to 40% of both the available target and the actual prepared estimate;
    // then fail terminally with prior history intact. Never issue one failing
    // request per oldest item. The retry is bounded, not a guarantee: the
    // provider can count slightly more than twice the byte/4 estimate. The
    // prepared prefix has already been reserved from the available budget.
    const retryBudget = Math.floor(
      Math.min(initialBudget * 0.4, preparation.estimatedInputTokens * 0.4),
    );
    preparation = prepareCompactionPromptInput(activeHistory, retryBudget);
    requireHistory();
    return {
      summaryBody: await summarize(settings, preparation.input),
      preparation,
      providerCalls: 2,
    };
  }
}

export function isContextWindowExceeded(error: unknown, seen = new WeakSet<object>()): boolean {
  if (!error || typeof error !== "object") return false;
  if (seen.has(error)) return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const message =
    typeof record.message === "string"
      ? record.message.toLowerCase()
      : error instanceof Error
        ? error.message.toLowerCase()
        : "";
  const direct =
    code === "context_length_exceeded" ||
    code === "context_window_exceeded" ||
    message.includes("context window") ||
    message.includes("maximum context length") ||
    message.includes("too many tokens");
  return (
    direct ||
    isContextWindowExceeded(record.cause, seen) ||
    isContextWindowExceeded(record.error, seen) ||
    isContextWindowExceeded(record.diagnostics, seen)
  );
}

export function isExactContextLengthExceeded(
  error: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (!error || typeof error !== "object") return false;
  if (seen.has(error)) return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  if (record.code === "context_length_exceeded") {
    return true;
  }
  return (
    isExactContextLengthExceeded(record.cause, seen) ||
    isExactContextLengthExceeded(record.error, seen) ||
    isExactContextLengthExceeded(record.diagnostics, seen)
  );
}

/**
 * Upload times for the files a new attachment catalog may list. They are
 * immutable file facts, frozen into the catalog text when it is created.
 */
async function attachmentUploadTimes(
  db: Database,
  workspaceId: string,
  items: readonly CompactionItem[],
): Promise<AttachmentUploadTimes> {
  const fileIds = compactionAttachmentFileIds(items);
  if (fileIds.length === 0) return new Map();
  const files = await getFiles(db, workspaceId, fileIds);
  return new Map(files.map((file) => [file.id, file.createdAt]));
}

/** Charge retained uploads by their projected image context, not reference text. */
async function retentionTokenCounts(
  items: CompactionItem[],
  project: (items: CompactionItem[]) => Promise<CompactionItem[]>,
): Promise<Map<CompactionItem, number>> {
  const counts = new Map<CompactionItem, number>();
  for (const item of items) {
    if (item.role === "user" || item.role === "developer") {
      counts.set(item, estimateTokens(await project([item])));
    }
  }
  return counts;
}
