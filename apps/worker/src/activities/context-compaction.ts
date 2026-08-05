import {
  applyContextCompaction,
  getActiveSessionHistoryItems,
  recordSkippedContextCompaction,
  recordStartedContextCompaction,
  type Database,
} from "@opengeni/db";
import {
  EmptyCompactionSummaryError,
  REMOTE_COMPACTION_V2_IMPLEMENTATION,
  SUMMARY_BUFFER_TOKENS,
  buildCompactionReplacementHistory,
  buildRemoteV2ReplacementHistory,
  compactionReplacementFingerprint,
  decideCompaction,
  estimateTokens,
  latestCompactionReplacementFingerprint,
  prepareCompactionPromptInput,
  sanitizeHistoryItemsForModel,
  summarizeForCompaction,
  type CompactionItem,
} from "@opengeni/runtime";
import { contextInputBudgetTokens, type Settings } from "@opengeni/config";
import type { SessionEvent } from "@opengeni/contracts";
import { projectRejectedProviderArtifacts } from "./run-input";
import { TurnAttemptFencedError } from "./turn-attempt-fenced";

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

/**
 * Durable context compaction.
 *
 * Portable path: Codex CLI local plaintext checkpoint for every provider and
 * for Codex sessions frozen on `portable`.
 *
 * Remote v2 path: when the session is frozen on `remote_v2` and the turn is
 * Codex, call Codex `/codex/responses` with `compaction_trigger` and persist the
 * opaque compaction item. Fail closed — never silently fall back to portable.
 */
export type CompactionSummarizer = (settings: Settings, input: CompactionItem[]) => Promise<string>;

/** Returns the opaque Codex remote compaction v2 item. */
export type RemoteCompactionV2Requester = (
  settings: Settings,
  input: CompactionItem[],
) => Promise<CompactionItem>;

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
      maxOutputTokens: SUMMARY_BUFFER_TOKENS,
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
    /** Materialize retained screenshot receipts only in the attempt-local model view. */
    materializeHistory?: (items: CompactionItem[]) => Promise<CompactionItem[]>;
    /** Turn-scoped attachment/modality view; canonical persisted rows stay untouched. */
    projectModelInput?: (items: CompactionItem[]) => Promise<CompactionItem[]>;
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

  const active = await getActiveSessionHistoryItems(db, scope.workspaceId, scope.sessionId);
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

  const canonicalItems = projectRejectedProviderArtifacts(active) as CompactionItem[];
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
    ...(options.force ? { force: true } : {}),
  });
  if (!decision.shouldCompact) {
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
    ...(useRemoteV2 ? { implementation: REMOTE_COMPACTION_V2_IMPLEMENTATION } : {}),
  });
  if (!started.recorded) {
    throw new TurnAttemptFencedError(
      `turn attempt was fenced while recording context compaction start: ${started.reason}`,
    );
  }
  await options.publishLiveEvents?.(started.events);

  if (useRemoteV2) {
    const outcome = await compactContextRemoteV2(
      db,
      settings,
      scope,
      canonicalItems,
      items,
      decision,
      options,
      projectForWire,
    );
    return prependCompactionEvents(started.events, outcome);
  }

  const outcome = await compactContextPortable(
    db,
    settings,
    scope,
    canonicalItems,
    items,
    decision,
    summarize,
    options,
    projectForWire,
  );
  return prependCompactionEvents(started.events, outcome);
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
  } = {},
): Promise<Extract<MaybeCompactResult, { compacted: false }>> {
  const settled = await settleSkippedAfterStart(db, scope, options, "summarization_failed");
  await options.publishLiveEvents?.(settled.events);
  return settled;
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
  },
  reason:
    | "no_history"
    | "replacement_not_smaller"
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
  items: CompactionItem[],
  decision: { signalTokens: number; thresholdTokens: number },
  options: {
    clearRequestedCompaction?: boolean;
    trigger?: "auto" | "operator" | "proactive" | "overflow";
    requestRemoteCompactionV2?: RemoteCompactionV2Requester;
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
  const compactionItem = await options.requestRemoteCompactionV2(settings, items);
  const replacementHistory = buildRemoteV2ReplacementHistory(canonicalItems, compactionItem);
  const estimatedTokensAfter = estimateTokens(await projectForWire(replacementHistory));
  const replacementFingerprint = compactionReplacementFingerprint(replacementHistory);
  const tailItem = replacementHistory.at(-1);
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
    replacementItems: replacementHistory.slice(0, -1),
    summaryItem: tailItem as Record<string, unknown>,
    ...(options.clearRequestedCompaction ? { clearRequestedCompaction: true } : {}),
    eventPayload: {
      trigger: options.trigger ?? "auto",
      implementation: REMOTE_COMPACTION_V2_IMPLEMENTATION,
      estimatedTokensBefore,
      estimatedTokensAfter,
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
  items: CompactionItem[],
  decision: { signalTokens: number; thresholdTokens: number },
  summarize: CompactionSummarizer,
  options: {
    clearRequestedCompaction?: boolean;
    trigger?: "auto" | "operator" | "proactive" | "overflow";
  },
  projectForWire: (items: CompactionItem[]) => Promise<CompactionItem[]>,
): Promise<MaybeCompactResult> {
  const estimatedTokensBefore = estimateTokens(items);
  const summarized = await summarizeWithCodexOverflowTrimming(summarize, settings, items);
  const summaryBody = summarized.summaryBody;
  const replacementHistory = buildCompactionReplacementHistory(canonicalItems, summaryBody);
  const estimatedTokensAfter = estimateTokens(await projectForWire(replacementHistory));
  const replacementFingerprint = compactionReplacementFingerprint(replacementHistory);
  const previousReplacementFingerprint = latestCompactionReplacementFingerprint(canonicalItems);
  const summaryItem = replacementHistory.at(-1);
  if (!summaryItem) {
    // Started already fanout; settle visibly so the landmark cannot stick on
    // "Compacting…". This is not an operator-request clear path.
    return await settleSkippedAfterStart(db, scope, options, "summarization_failed");
  }
  if (previousReplacementFingerprint === replacementFingerprint) {
    return await settleSkippedAfterStart(db, scope, options, "replacement_unchanged");
  }
  if (estimatedTokensAfter >= estimatedTokensBefore) {
    return await settleSkippedAfterStart(db, scope, options, "replacement_not_smaller");
  }
  const applied = await applyContextCompaction(db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    expectedExecutionGeneration: scope.executionGeneration,
    expectedAttemptId: scope.attemptId,
    replacementItems: replacementHistory.slice(0, -1),
    summaryItem: summaryItem as Record<string, unknown>,
    ...(options.clearRequestedCompaction ? { clearRequestedCompaction: true } : {}),
    eventPayload: {
      trigger: options.trigger ?? "auto",
      estimatedTokensBefore,
      estimatedTokensAfter,
      compactionInputEstimatedTokens: summarized.preparation.estimatedInputTokens,
      compactionInputToolOutputsRewritten: summarized.preparation.rewrittenToolOutputs,
      compactionInputHistoryItemsDropped: summarized.preparation.droppedHistoryItems,
      compactionInputProviderCalls: summarized.providerCalls,
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

async function summarizeWithCodexOverflowTrimming(
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
  // requested summary, then leave 15% estimator headroom. This changes only the
  // temporary summarizer input; durable active history remains untouched until
  // applyContextCompaction succeeds under the attempt fence.
  const summaryAwareBudget = Math.max(0, settings.contextWindowTokens - SUMMARY_BUFFER_TOKENS);
  const configuredInputBudget = contextInputBudgetTokens(settings);
  const structuralBudget = Math.min(
    configuredInputBudget > 0 ? configuredInputBudget : summaryAwareBudget,
    summaryAwareBudget,
  );
  const initialBudget = Math.floor(structuralBudget * 0.85);
  let preparation = prepareCompactionPromptInput(activeHistory, initialBudget);
  try {
    return {
      summaryBody: await summarize(settings, preparation.input),
      preparation,
      providerCalls: 1,
    };
  } catch (error) {
    if (!isContextWindowExceeded(error)) throw error;
    // The provider is more authoritative than the byte/4 estimate. Refit once
    // to 70% of both the configured target and the actual prepared estimate;
    // then fail terminally with prior history intact. Never issue one failing
    // request per oldest item. The production incident proved that the
    // provider can count slightly more than twice the byte/4 estimate, so a
    // half-size retry is the smallest honest bound for that observed skew.
    const retryBudget = Math.floor(
      Math.min(initialBudget * 0.5, preparation.estimatedInputTokens * 0.5),
    );
    preparation = prepareCompactionPromptInput(activeHistory, retryBudget);
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
