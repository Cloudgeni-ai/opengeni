import { describe, expect, mock, spyOn, test } from "bun:test";
import { ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import { RunRawModelStreamEvent, ToolCallError, Usage } from "@openai/agents-core";
import { ModelItem } from "@openai/agents-core/types";
import {
  withWorkspaceGatewayCredential,
  WORKSPACE_GATEWAY_MODEL_ID_PREFIX,
  WORKSPACE_GATEWAY_PROVIDER_ID,
  type Settings,
} from "@opengeni/config";
import { TurnExecutionPolicyV1, type ResourceRef } from "@opengeni/contracts";
import { createObservability } from "@opengeni/observability";
import * as opengeniDb from "@opengeni/db";
import {
  codexRequestStorage,
  codexSubscriptionFetch,
  type CodexRequestContext,
} from "@opengeni/codex";
import {
  XAI_SUBSCRIPTION_TRANSPORT_ERROR_HEADER,
  XaiSubscriptionHostedToolContinuationError,
  XaiSubscriptionReloginRequired,
  XaiSubscriptionStreamIdleTimeoutError,
  XaiSubscriptionStreamingTerminalError,
  type XaiSubscriptionRequestContext,
} from "@opengeni/xai-subscription";
import {
  ActiveSessionHistoryLimitExceededError,
  ApprovalRunStateLimitExceededError,
  interruptedToolCallResult,
  runIdempotentPersistenceTransaction,
  SandboxImageConflictError,
  SandboxLeaseRecoveryBlockedError,
  SandboxLeaseSupersededError,
  SandboxLeaseTransitionError,
  SandboxWorkspaceMutationFencedError,
  SessionEventPersistenceError,
} from "@opengeni/db";
import {
  CompactionNeededError,
  CompactionProviderResponseError,
  EmptyCompactionSummaryError,
  SandboxConfigError,
  SandboxExecReadinessError,
  UNKNOWN_MODEL_FINISH_REASON_CODE,
  UnknownModelFinishReasonError,
  WorkspaceArchiveIntegrityError,
  contextRobustnessFilterForSettings,
  modelResponseUsageFromResponse,
  mcpTransportErrorWithRetryMetadata,
  sanitizeHistoryItemsForModel,
} from "@opengeni/runtime";
import { guardedMcpFetch } from "@opengeni/runtime/mcp-network";
import { testSettings } from "@opengeni/testing";
import {
  acceptsPromptCacheKeyForTurn,
  agentRunFailurePayload,
  assertWorkspaceHumanInputAllowed,
  assertModelResponseLatencyMode,
  assertPhysicalToolQuiescenceForCancellation,
  assertSessionAttemptQuiescenceRecoveryDurable,
  classifyContextWindowOverflowError,
  classifySandboxLogicalProvisionFailure,
  classifyXaiCredentialFailure,
  credentialSubjectIdForTurnInitiator,
  xaiCatalogReadinessAuthority,
  classifyMcpTransportTimeoutError,
  clearAttemptCredentialsWithSettledFence,
  codexCredentialLeaseDeadlineExpired,
  completedToolCallFromSdkEvent,
  createCompactionModelUsageEventState,
  createModelResponseEventState,
  createSessionTitleModelUsageEventState,
  createTurnSandboxProvisioner,
  drainAttemptOwnedSandboxWriters,
  releaseTurnSandboxAfterWriterDrain,
  emitModelCallUsage,
  ensureTurnModalRegistryImage,
  escapedMcpTimeoutRecoveryFailure,
  filterUnmaterializedSandboxFileDownloads,
  finalizeDurableTurnOpStreams,
  connectedSubscriptionImageGenerationAuthority,
  historyRowsToAppend,
  hostedWebSearchForTurn,
  isLazySandboxProvisionRetryable,
  isTransientProviderError,
  isWorkerShutdownCancellation,
  legacyTurnExecutionPolicyInput,
  MandatoryHistoryPersistenceError,
  modelAttachmentInputPolicyForTurn,
  modelSupportsImageInputForTurn,
  openAiHostedImageProviderBindingForTurn,
  recordCompletedModelCallBeforeOwnershipFences,
  modelUsageSourceKey,
  modelResponseContextSignal,
  managedSandboxOwnershipForTurn,
  pendingToolCallFromSdkEvent,
  pointerReconcileReason,
  postClaimDatabaseRecoveryFailure,
  POST_COMPACTION_CONTINUATION_EMPTY_CODE,
  PostCompactionContinuationEmptyError,
  processCompactionModelUsageEvent,
  processModelResponseTerminalEvent,
  processSessionTitleModelUsageEvent,
  persistOrSignalSessionAttemptQuiescence,
  preClaimAdmissionFailure,
  PROVIDER_BACKPRESSURE_DELAY_MS,
  providerRecoveryCountAfterModelRequestPhase,
  providerRecoveryCountFromMetadata,
  sessionTitleCodexRequestContext,
  sessionTitleXaiRequestContext,
  providerRetryAfterMs,
  providerRecoveryResult,
  providerRecoveryExhaustedFailure,
  MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  requiresSignedFileResourceDownloads,
  objectStorageForSandboxDownloads,
  resolveActiveSandboxBackend,
  runtimeResourcesForTurn,
  runMandatoryHistoryPersistenceStep,
  sandboxEstablishPolicyDecision,
  sandboxFileMaterializationOutcome,
  safeErrorDiagnostic,
  sandboxArtifactRuntimeAdmission,
  sandboxDeadlineRotationRecoveryDelayMs,
  shouldEstablishSandboxForTurn,
  shouldPrefetchManagedSandbox,
  shouldDeferNonEagerToolPreparation,
  shouldRecoverCompactionProviderFailure,
  shouldRunTurnEndWorkspacePersistence,
  shouldStartPeriodicWorkspaceSnapshot,
  stableHumanInputRequestId,
  structuredToolTransportForTurn,
  toolCallProducesRetainableSessionImage,
  lazyToolTransportForTurn,
  turnExecutionPolicyBillingIdentity,
  turnOperationCancellationFailure,
  unavailableMcpOperationalContext,
  waitForTurnOperation,
  waitForTurnFinalizerStep,
  waitForTurnStreamCleanup,
  TurnOperationCancelledError,
  WorkspaceHumanInputDisabledError,
} from "../src/activities/agent-turn";
import {
  CodexCredentialLeaseLostError,
  CodexTurnLease,
} from "../src/activities/agent-turn/credential-leases";
import { preemptSandboxTurnForDeadlineRotation } from "../src/activities/agent-turn/sandbox-runtime";
import {
  SandboxExecReadinessTimeoutError,
  SandboxProvisionStageError,
  SandboxSiblingWarmingTimeoutError,
  sandboxLeaseHolderIdForAttempt,
} from "../src/sandbox-resume";
import { settingsWithPackSandboxImage } from "../src/activities/packs";
import { startGitCredentialRenewalLoop } from "../src/activities/git-credential-renewal";
import { attachPendingUpdatesBeforePreparingModelInput } from "../src/activities/agent-turn/stream-attempt";

const OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE = "openai-responses";

describe("approval RunState materialization boundary", () => {
  test("ordinary agent turns never read or decode the approval blob", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/run.ts", import.meta.url),
    ).text();
    const streamSource = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();

    expect(source).not.toContain("getLatestRunStateResumeMetadata(");
    expect(source).not.toMatch(/\bgetLatestRunState\s*\(/);
    expect(streamSource).not.toContain("getLatestRunStateResumeMetadata(");
    expect(streamSource).not.toMatch(/\bgetLatestRunState\s*\(/);
  });

  test("requires_action pause flushes paired history and attaches the open suffix", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();
    expect(source).toContain("attachOpenSuffixToPendingToolCalls");
    expect(source).toContain("OPEN_SUFFIX_RUN_STATE_BLOB");
    expect(source).toContain("historySink.reconcileConversationTruth({ requireDurable: true })");
    expect(source).toContain("settleOpenSuffixResumeIfNeeded");
  });

  test("resume attaches blocked machine input after the open suffix and before model input", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();
    const suffixAt = source.indexOf(
      "const openSuffixResume = await settleOpenSuffixResumeIfNeeded",
    );
    const preparationAt = source.indexOf(
      "await attachPendingUpdatesBeforePreparingModelInput",
      suffixAt,
    );
    const history = ["function_call", "function_call_result"];
    const eligiblePendingInput = ["PRE-BOUNDARY"];
    const laterPendingInput = "NEXT-TURN-ONLY";
    let modelInput: string[] = [];

    const prepared = await attachPendingUpdatesBeforePreparingModelInput({
      shouldAttach: true,
      attachPendingUpdates: async () => {
        history.push(...eligiblePendingInput.splice(0));
        return true;
      },
      prepareModelInput: async () => {
        modelInput = [...history];
      },
    });

    expect(suffixAt).toBeGreaterThan(-1);
    expect(preparationAt).toBeGreaterThan(suffixAt);
    expect(prepared).toBe(true);
    expect(modelInput).toEqual(["function_call", "function_call_result", "PRE-BOUNDARY"]);
    expect(modelInput.filter((item) => item === "PRE-BOUNDARY")).toHaveLength(1);
    expect(modelInput).not.toContain(laterPendingInput);
  });

  test("approval and human-input resume require open-suffix rows", async () => {
    const source = await Bun.file(
      new URL("../src/activities/run-input.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(/\bgetLatestRunState\s*\(/);
    expect(source).toContain("Open suffix resume has no interruption rows");
  });
});

describe("workspace structured human-input policy", () => {
  test("disabled policy rejects forged interruptions before requires-action settlement", () => {
    const settle = mock(() => undefined);
    const attemptSettlement = () => {
      assertWorkspaceHumanInputAllowed(false, "interruption", true);
      settle();
    };

    expect(attemptSettlement).toThrow(WorkspaceHumanInputDisabledError);
    expect(settle).not.toHaveBeenCalled();
  });

  test("disabled policy rejects stale resumes while enabled control preserves both paths", () => {
    expect(() => assertWorkspaceHumanInputAllowed(false, "resume", true)).toThrow(
      /policy rejects structured human-input resume/i,
    );
    expect(() => assertWorkspaceHumanInputAllowed(true, "resume", true)).not.toThrow();
    expect(() => assertWorkspaceHumanInputAllowed(true, "interruption", true)).not.toThrow();
    expect(() => assertWorkspaceHumanInputAllowed(false, "interruption", false)).not.toThrow();
  });

  // No-Claim: these pure boundary tests do not prove that a deployed worker has
  // reloaded a workspace setting or that an already-pending request was repaired.
});

describe("periodic workspace snapshot admission", () => {
  const ready = {
    firstProviderRequestStarted: true,
    snapshotInFlight: false,
    turnEndCaptureInProgress: false,
    deadlineRotationRequested: false,
  };

  test("keeps checkpoint maintenance off the first-request critical path", () => {
    expect(
      shouldStartPeriodicWorkspaceSnapshot({ ...ready, firstProviderRequestStarted: false }),
    ).toBe(false);
    expect(shouldStartPeriodicWorkspaceSnapshot(ready)).toBe(true);
  });

  test("retains the existing single-flight and turn-end gates", () => {
    expect(shouldStartPeriodicWorkspaceSnapshot({ ...ready, snapshotInFlight: true })).toBe(false);
    expect(shouldStartPeriodicWorkspaceSnapshot({ ...ready, turnEndCaptureInProgress: true })).toBe(
      false,
    );
    expect(
      shouldStartPeriodicWorkspaceSnapshot({ ...ready, deadlineRotationRequested: true }),
    ).toBe(false);
  });
});

describe("Connected Machine durable stream finalization", () => {
  test("finalizes every routed proxy once and does not bypass them for the raw fallback", async () => {
    const calls: string[] = [];
    const eagerProxy = {
      finalizeOpStreamOps: async () => {
        calls.push("eager");
      },
    };
    const lazyProxy = {
      finalizeOpStreamOps: async () => {
        calls.push("lazy");
        throw new Error("runner unreachable");
      },
    };
    const fallback = {
      finalizeOpStreamOps: async () => {
        calls.push("fallback");
      },
    };

    await finalizeDurableTurnOpStreams(
      [lazyProxy, eagerProxy, lazyProxy, null, { finalizeOpStreamOps: "not-a-function" }],
      fallback,
    );

    expect(calls).toEqual(["lazy", "eager"]);
  });

  test("uses the machine-primary fallback when no routing proxy exists", async () => {
    let finalized = 0;
    await finalizeDurableTurnOpStreams([null, undefined], {
      finalizeOpStreamOps: async () => {
        finalized += 1;
      },
    });
    expect(finalized).toBe(1);
  });
});

describe("disconnected MCP operational context", () => {
  test("warns the model without exposing an unbounded unavailable registry", () => {
    expect(
      unavailableMcpOperationalContext({
        droppedIds: ["cap-linear", "cap-slack"],
        droppedCount: 4,
      }),
    ).toBe(
      'MCP capability availability for this turn: the following session-selected server(s) are disconnected or no longer registered and were skipped: "cap-linear", "cap-slack", plus 2 additional unavailable server(s). Do not claim to have read or updated those systems. If the task depends on one as a source of truth, explain the limitation and ask the user to reconnect it or select another authoritative source; continue with unaffected work only when safe.',
    );
  });

  test("is absent when no selected server was dropped", () => {
    expect(unavailableMcpOperationalContext({ droppedIds: [], droppedCount: 0 })).toBeUndefined();
  });

  test("keeps a generic warning when legacy ids cannot be projected safely", () => {
    expect(unavailableMcpOperationalContext({ droppedIds: [], droppedCount: 1 })).toContain(
      "1 unavailable server(s)",
    );
  });
});

// Item shapes mirror the SDK history representation persisted into
// session_history_items (type discriminator, camelCase callId).
function userMessage(text: string) {
  return { type: "message", role: "user", content: text };
}
function functionCall(callId: string) {
  return {
    type: "function_call",
    callId,
    name: "tool",
    arguments: "{}",
    status: "completed",
  };
}
function functionResult(callId: string) {
  return {
    type: "function_call_result",
    callId,
    status: "completed",
    output: { type: "text", text: "ok" },
  };
}

function citedAssistantMessage() {
  return {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: "OpenGeni is documented here [1].",
        providerData: {
          annotations: [
            {
              type: "url_citation",
              start_index: 28,
              end_index: 31,
              url: "https://docs.opengeni.example/search",
              title: "OpenGeni search documentation",
            },
          ],
        },
      },
    ],
  };
}

describe("turn credential subject authority", () => {
  test("passes only a direct human/API turn to broad personal connection resolution", () => {
    expect(
      credentialSubjectIdForTurnInitiator({
        source: "user",
        initiator: { kind: "subject", subjectId: "subject-alice" },
        initiatorContext: {},
      }),
    ).toBe("subject-alice");
    expect(
      credentialSubjectIdForTurnInitiator({
        source: "goal",
        initiator: { kind: "service", subjectId: "goal-continuation" },
        initiatorContext: {},
      }),
    ).toBeUndefined();
    expect(
      credentialSubjectIdForTurnInitiator({
        source: "system",
        initiator: { kind: "subject", subjectId: "subject-alice" },
        initiatorContext: { via: [{ sessionId: crypto.randomUUID() }] },
      }),
    ).toBeUndefined();
  });
});

describe("structured human-input identity", () => {
  test("is stable for one logical tool call and distinct across calls or turns", () => {
    const first = stableHumanInputRequestId("session-1", "turn-1", "call-1");
    expect(stableHumanInputRequestId("session-1", "turn-1", "call-1")).toBe(first);
    expect(stableHumanInputRequestId("session-1", "turn-1", "call-2")).not.toBe(first);
    expect(stableHumanInputRequestId("session-1", "turn-2", "call-1")).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

async function actualCodexStreamingFailure(event: Record<string, unknown>): Promise<{
  calls: number;
  error: unknown;
  forwarded: string;
}> {
  let calls = 0;
  const token = {
    accessToken: "worker-test-token",
    chatgptAccountId: "worker-test-account",
    isFedramp: false,
  };
  const context: CodexRequestContext = {
    clientVersion: "largeoutput-worker-test",
    getToken: async () => token,
    refresh: async () => token,
    resolveModel: (model) => model,
  };
  const response = await codexRequestStorage.run(context, () =>
    codexSubscriptionFetch(async () => {
      calls += 1;
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    })("https://chatgpt.com/backend-api/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, model: "gpt-5.6-sol", input: [] }),
    }),
  );

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let forwarded = "";
  let error: unknown;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      forwarded += decoder.decode(chunk.value, { stream: true });
    }
    forwarded += decoder.decode();
  } catch (streamError) {
    error = streamError;
  }
  return { calls, error, forwarded };
}

async function actualCodexNullBodyFailure(): Promise<{ calls: number; error: unknown }> {
  let calls = 0;
  const token = {
    accessToken: "worker-test-token",
    chatgptAccountId: "worker-test-account",
    isFedramp: false,
  };
  const context: CodexRequestContext = {
    clientVersion: "largeoutput-worker-test",
    getToken: async () => token,
    refresh: async () => token,
    resolveModel: (model) => model,
  };
  const response = await codexRequestStorage.run(context, () =>
    codexSubscriptionFetch(async () => {
      calls += 1;
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    })("https://chatgpt.com/backend-api/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true, model: "gpt-5.6-sol", input: [] }),
    }),
  );

  let error: unknown;
  try {
    await response.text();
  } catch (streamError) {
    error = streamError;
  }
  return { calls, error };
}

/**
 * Drive a sequence of reconcile passes the way the live worker does: each
 * element is the SDK's computed `state.history` at one reconcile point, and the
 * watermark carries forward. Returns every row that would have been persisted,
 * in position order, after onConflictDoNothing-on-position is applied (a
 * position is frozen by the first row written to it).
 */
function persistAcrossReconciles(snapshots: Array<Array<Record<string, unknown>>>) {
  const persistedByPosition = new Map<number, Record<string, unknown>>();
  let watermark = 0;
  for (const snapshot of snapshots) {
    const { rows, nextWatermark } = historyRowsToAppend(snapshot, watermark);
    for (const row of rows) {
      if (!persistedByPosition.has(row.position)) {
        persistedByPosition.set(row.position, row.item);
      }
    }
    watermark = nextWatermark;
  }
  return [...persistedByPosition.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
}

describe("turn exact-content boundaries", () => {
  const syntheticValue = ["synthetic", "turn", "value", "123456"].join("-");

  test("preserves current history exactly before durable append", () => {
    const item = userMessage(`tool output ${syntheticValue}`);
    const result = historyRowsToAppend([item], 0);

    expect(result.rows).toEqual([{ position: 0, item }]);
    expect(JSON.stringify(result.rows)).toContain(syntheticValue);
  });

  test("preserves provider citations in the structured durable assistant item", () => {
    const cited = citedAssistantMessage();
    const result = historyRowsToAppend([cited], 0);

    expect(result.rows).toEqual([{ position: 0, item: cited }]);
    expect(
      (
        (result.rows[0]!.item.content as Array<Record<string, unknown>>)[0]!.providerData as {
          annotations: Array<Record<string, unknown>>;
        }
      ).annotations[0],
    ).toMatchObject({
      type: "url_citation",
      url: "https://docs.opengeni.example/search",
      title: "OpenGeni search documentation",
    });
  });

  test("persists hosted SDK tool calls as protocol JSON when optional output is undefined", () => {
    const hostedToolCall = {
      type: "hosted_tool_call",
      id: "ws_123",
      name: "web_search_call",
      status: "completed",
      output: undefined,
      providerData: {
        type: "web_search_call",
        id: "ws_123",
        status: "completed",
        action: { type: "search", query: "OpenGeni" },
      },
    };

    const result = historyRowsToAppend([hostedToolCall], 0);

    expect(hostedToolCall).toHaveProperty("output", undefined);
    expect(result.rows).toEqual([
      {
        position: 0,
        item: {
          type: "hosted_tool_call",
          id: "ws_123",
          name: "web_search_call",
          status: "completed",
          providerData: hostedToolCall.providerData,
        },
      },
    ]);
    expect(Object.hasOwn(hostedToolCall, "output")).toBe(true);
  });

  test("normalizes pending SDK tool calls before the lossless receipt write", () => {
    const rawItem = {
      type: "function_call",
      callId: "call_pending_undefined",
      name: "example_tool",
      arguments: "{}",
      status: undefined,
      providerData: {
        traceId: "trace-1",
        optional: undefined,
      },
    };

    const pending = pendingToolCallFromSdkEvent({
      type: "run_item_stream_event",
      item: { type: "tool_call_item", rawItem },
    });

    expect(pending).toEqual({
      callId: "call_pending_undefined",
      callType: "function_call",
      callName: "example_tool",
      callItem: {
        type: "function_call",
        callId: "call_pending_undefined",
        name: "example_tool",
        arguments: "{}",
        providerData: { traceId: "trace-1" },
      },
    });
    expect(Object.hasOwn(pending!.callItem, "status")).toBe(false);
    expect(Object.hasOwn(pending!.callItem.providerData as object, "optional")).toBe(false);
    expect(Object.hasOwn(rawItem, "status")).toBe(true);
    expect(Object.hasOwn(rawItem.providerData, "optional")).toBe(true);
  });

  test("does not register a hosted image as a pending function call", () => {
    expect(
      pendingToolCallFromSdkEvent({
        type: "run_item_stream_event",
        item: {
          type: "tool_call_item",
          rawItem: {
            type: "hosted_tool_call",
            id: "ig_1",
            name: "image_generation_call",
            status: "completed",
            output: "opaque",
          },
        },
      }),
    ).toBeNull();
  });

  test("retains intentional screenshot and view-image outputs, not incidental action frames", () => {
    expect(toolCallProducesRetainableSessionImage("computer_screenshot")).toBe(true);
    expect(toolCallProducesRetainableSessionImage("view_image")).toBe(true);
    expect(toolCallProducesRetainableSessionImage("interaction__computer_observe")).toBe(true);
    expect(toolCallProducesRetainableSessionImage("computer_click")).toBe(false);
    expect(toolCallProducesRetainableSessionImage("computer_scroll")).toBe(false);
  });

  test("normalizes completed SDK tool results before the lossless receipt write", () => {
    const rawItem = {
      type: "function_call_result",
      callId: "call_result_undefined",
      status: "completed",
      output: {
        type: "text",
        text: "done",
        optional: undefined,
      },
      providerData: undefined,
    };

    const completed = completedToolCallFromSdkEvent({
      type: "run_item_stream_event",
      item: { type: "tool_call_output_item", rawItem },
    });

    expect(completed).toEqual({
      callId: "call_result_undefined",
      resultItem: {
        type: "function_call_result",
        callId: "call_result_undefined",
        status: "completed",
        output: { type: "text", text: "done" },
      },
    });
    expect(Object.hasOwn(completed!.resultItem, "providerData")).toBe(false);
    expect(Object.hasOwn(completed!.resultItem.output as object, "optional")).toBe(false);
    expect(Object.hasOwn(rawItem, "providerData")).toBe(true);
    expect(Object.hasOwn(rawItem.output, "optional")).toBe(true);
  });

  test("correlates native tool-search results whose id only survives in provider data", () => {
    const rawItem = {
      type: "tool_search_output",
      tools: [{ name: "matching_tool" }],
      providerData: { call_id: "tool-search-provider-id" },
    };

    expect(
      completedToolCallFromSdkEvent({
        type: "run_item_stream_event",
        item: { type: "tool_search_output_item", rawItem },
      }),
    ).toEqual({
      callId: "tool-search-provider-id",
      resultItem: rawItem,
    });
  });

  test("keeps non-object undefined values fail-closed at the pending receipt boundary", () => {
    expect(() =>
      pendingToolCallFromSdkEvent({
        type: "run_item_stream_event",
        item: {
          type: "tool_call_item",
          rawItem: {
            type: "function_call",
            callId: "call_invalid_array",
            name: "example_tool",
            arguments: "{}",
            providerData: { values: ["ok", undefined] },
          },
        },
      }),
    ).toThrow(
      'Protocol JSON value at $["item"]["rawItem"]["providerData"]["values"][1] cannot contain undefined',
    );
  });

  test("public diagnostics exclude arbitrary bodies while internal failure events remain exact", () => {
    const error = Object.assign(new Error(`request rejected; detail=${syntheticValue}`), {
      status: 401,
      name: syntheticValue,
      code: syntheticValue,
      cause: { responseBody: syntheticValue },
    });
    const diagnostic = safeErrorDiagnostic(error);

    expect(diagnostic).toEqual({
      errorClass: "WorkerOperationError",
      errorCode: "worker_operation_failed",
      status: 401,
      origin: "worker",
    });
    expect(agentRunFailurePayload(error).error).toBe(`request rejected; detail=${syntheticValue}`);
    expect(diagnostic).not.toHaveProperty("stack");
    expect(diagnostic).not.toHaveProperty("cause");
    expect(JSON.stringify(diagnostic)).not.toContain(syntheticValue);
  });

  test("public worker status projection tolerates hostile proxies", () => {
    const source = new Error(`worker status getter ${syntheticValue}`);
    const hostile = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "status" || property === "statusCode") {
          throw new Error(`hostile worker status ${syntheticValue}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(safeErrorDiagnostic(hostile)).toEqual({
      errorClass: "WorkerOperationError",
      errorCode: "worker_operation_failed",
      origin: "worker",
    });
    expect(source.message).toContain(syntheticValue);
    expect(JSON.stringify(safeErrorDiagnostic(hostile))).not.toContain(syntheticValue);
  });

  test("mandatory history failure keeps exact internal content and exposes only a safe stage", async () => {
    const source = Object.assign(new Error(`history write rejected; detail=${syntheticValue}`), {
      status: 503,
      responseBody: syntheticValue,
    });
    const error = await runMandatoryHistoryPersistenceStep("history_append", async () => {
      throw source;
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(MandatoryHistoryPersistenceError);
    expect((error as MandatoryHistoryPersistenceError).cause).toBe(source);
    const failure = agentRunFailurePayload(error);
    expect(failure).toEqual({
      error: `history write rejected; detail=${syntheticValue}`,
      historyPersistenceStage: "history_append",
    });
    const diagnostic = safeErrorDiagnostic(error);
    expect(diagnostic).toEqual({
      errorClass: "WorkerOperationError",
      errorCode: "worker_operation_failed",
      status: 503,
      origin: "worker",
      historyPersistenceStage: "history_append",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(syntheticValue);
  });

  test("mandatory history barriers precede completion and terminal failure emits no completion", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();
    const streamCompletionAuthority = source.indexOf(
      "await assertSuccessfulAgentStreamCompletion({",
    );
    const postCompactionRecovery = source.indexOf(
      "throw new PostCompactionContinuationEmptyError();",
      streamCompletionAuthority,
    );
    const cancelledStreamGuard = source.indexOf(
      "assertAgentStreamNotCancelled(eventing.stream.cancelled);",
      postCompactionRecovery,
    );
    const interruptionPath = source.indexOf(
      "if (eventing.stream.interruptions.length > 0)",
      cancelledStreamGuard,
    );
    const completionPath = source.indexOf(
      "String(requireAgentStreamFinalOutput(eventing.stream.finalOutput))",
      interruptionPath,
    );
    const mandatoryBarrier = source.indexOf(
      "await historySink.reconcileConversationTruth({ requireDurable: true });",
      completionPath,
    );
    const successCompletion = source.indexOf('type: "turn.completed"', mandatoryBarrier);
    expect(streamCompletionAuthority).toBeGreaterThan(-1);
    expect(postCompactionRecovery).toBeGreaterThan(streamCompletionAuthority);
    expect(cancelledStreamGuard).toBeGreaterThan(postCompactionRecovery);
    expect(interruptionPath).toBeGreaterThan(cancelledStreamGuard);
    expect(completionPath).toBeGreaterThan(interruptionPath);
    expect(mandatoryBarrier).toBeGreaterThan(completionPath);
    expect(successCompletion).toBeGreaterThan(mandatoryBarrier);

    const failureSource = await Bun.file(
      new URL("../src/activities/agent-turn/failure-settlement.ts", import.meta.url),
    ).text();
    const failureClassifier = failureSource.indexOf("let failure = agentRunFailurePayload(error");
    const terminalFailureStart = failureSource.indexOf(
      'control.activityStatus = "failed";',
      failureClassifier,
    );
    const terminalFailureEnd = failureSource.indexOf(
      'control.turnMetricOutcome = "failed";',
      terminalFailureStart,
    );
    const terminalFailureBlock = failureSource.slice(terminalFailureStart, terminalFailureEnd);
    expect(terminalFailureStart).toBeGreaterThan(failureClassifier);
    expect(terminalFailureEnd).toBeGreaterThan(terminalFailureStart);
    expect(terminalFailureBlock).toContain('type: "turn.failed"');
    expect(terminalFailureBlock).not.toContain('type: "turn.completed"');
  });
});

describe("accepted turn execution identity", () => {
  test("separates external billing from the exact Codex allocator identity", () => {
    const base = TurnExecutionPolicyV1.parse({
      schemaVersion: 1,
      productModelId: "xai/grok-4.5",
      requestedModelId: null,
      modelSource: "session",
      reasoningEffort: "high",
      reasoningSource: "session",
      providerId: "xai",
      upstreamModelId: "grok-4.5",
      wireApi: "responses",
      credentialSource: { kind: "workspace_connection", mechanism: "api_key" },
      billing: { upstreamPayer: "workspace", metering: "external" },
      definitionVersion: `sha256:${"a".repeat(64)}`,
    });
    expect(turnExecutionPolicyBillingIdentity(base)).toEqual({
      externallyBilled: true,
      countsTowardTokenCap: false,
      codexSubscription: false,
      xaiSubscription: false,
    });
    expect(
      turnExecutionPolicyBillingIdentity({
        ...base,
        productModelId: "codex/gpt-5.6-sol",
        providerId: "codex-subscription",
        upstreamModelId: "gpt-5.6-sol",
        credentialSource: { kind: "connected_subscription", provider: "codex" },
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
      }),
    ).toEqual({
      externallyBilled: true,
      countsTowardTokenCap: false,
      codexSubscription: true,
      xaiSubscription: false,
    });
    expect(
      turnExecutionPolicyBillingIdentity({
        ...base,
        productModelId: "supergrok/grok-4.6",
        providerId: "supergrok-subscription",
        upstreamModelId: "grok-4.6",
        credentialSource: { kind: "connected_subscription", provider: "xai" },
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
      }),
    ).toEqual({
      externallyBilled: true,
      countsTowardTokenCap: false,
      codexSubscription: false,
      xaiSubscription: true,
    });
    expect(
      turnExecutionPolicyBillingIdentity({
        ...base,
        credentialSource: { kind: "deployment", mechanism: "api_key" },
        billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
      }),
    ).toEqual({
      externallyBilled: false,
      countsTowardTokenCap: true,
      codexSubscription: false,
      xaiSubscription: false,
    });
  });

  test("classifies only legacy user/API turns as explicit policy requests", () => {
    for (const source of ["user", "api"] as const) {
      expect(
        legacyTurnExecutionPolicyInput({
          source,
          model: "xai/grok-4.5",
          reasoningEffort: "high",
          latencyMode: "fast",
        }),
      ).toMatchObject({
        requestedModelId: "xai/grok-4.5",
        modelSource: "explicit",
        reasoningSource: "explicit",
        latencyMode: "fast",
        latencyModeSource: "explicit",
      });
    }
    for (const source of ["goal", "system", "compaction"] as const) {
      expect(
        legacyTurnExecutionPolicyInput({
          source,
          model: "codex/gpt-5.6-sol",
          reasoningEffort: "xhigh",
          latencyMode: "fast",
        }),
      ).toMatchObject({
        requestedModelId: null,
        modelSource: "continuation",
        reasoningSource: "continuation",
        latencyMode: "fast",
        latencyModeSource: "continuation",
      });
    }
  });

  test("uses frozen initiating-human xAI authority for service-originated catalog reads", () => {
    const authoritySnapshot = {
      version: 1 as const,
      scope: "user" as const,
      authorityGeneration: 7,
    };
    expect(
      xaiCatalogReadinessAuthority(
        {
          initiatingHumanSubjectId: "human-subject",
          xaiProviderAccountAuthoritySnapshot: authoritySnapshot,
        },
        undefined,
      ),
    ).toEqual({ subjectId: "human-subject", authoritySnapshot });
    expect(
      xaiCatalogReadinessAuthority(
        {
          initiatingHumanSubjectId: null,
          xaiProviderAccountAuthoritySnapshot: authoritySnapshot,
        },
        "direct-subject",
      ),
    ).toEqual({ subjectId: "direct-subject", authoritySnapshot });
  });
});

describe("conversation-truth reconcile (orphaned tool output guard)", () => {
  test("does not treat a reverse-completing parallel call batch as an append-only history", () => {
    const user = userMessage("run A and B in parallel");
    const callA = functionCall("call_a");
    const callB = functionCall("call_b");
    const resultA = functionResult("call_a");
    const resultB = functionResult("call_b");

    // B completes first. The SDK's computed history temporarily drops A, then
    // inserts A back before the already-visible B pair once A completes. A
    // scalar length watermark cannot represent that prefix insertion.
    const unsafe = persistAcrossReconciles([
      [user],
      [user, callB, resultB],
      [user, callA, callB, resultB, resultA],
    ]);
    expect(unsafe).not.toEqual([user, callA, callB, resultB, resultA]);

    // The live worker's durable receipt gate deliberately skips the partial B
    // snapshot (the response batch is not settled) and reconciles only after both
    // raw results exist, when the SDK history is stable again.
    const persisted = persistAcrossReconciles([[user], [user, callA, callB, resultB, resultA]]);
    expect(persisted).toEqual([user, callA, callB, resultB, resultA]);
  });

  test("interrupted tool results are valid SDK model items without invented computer state", () => {
    const cases = [
      {
        callType: "function_call",
        callId: "function-1",
        callItem: {
          type: "function_call",
          callId: "function-1",
          name: "mutate",
          arguments: "{}",
          status: "in_progress",
        },
      },
      {
        callType: "shell_call",
        callId: "shell-1",
        callItem: {
          type: "shell_call",
          callId: "shell-1",
          status: "in_progress",
          action: { commands: ["do-something"] },
        },
      },
      {
        callType: "apply_patch_call",
        callId: "patch-1",
        callItem: {
          type: "apply_patch_call",
          callId: "patch-1",
          status: "in_progress",
          operation: { type: "delete_file", path: "gone.txt" },
        },
      },
      {
        callType: "tool_search_call",
        callId: "search-1",
        callItem: {
          type: "tool_search_call",
          callId: "search-1",
          execution: "client",
          status: "in_progress",
          arguments: { query: "mail" },
        },
      },
    ];
    for (const entry of cases) {
      const result = interruptedToolCallResult({
        ...entry,
        reason: "worker_shutdown",
      });
      expect(result).not.toBeNull();
      const pair = [entry.callItem, result!] as Array<Record<string, unknown>>;
      expect(ModelItem.array().parse(pair)).toEqual(pair);
      expect(sanitizeHistoryItemsForModel(pair)).toEqual(pair);
    }

    expect(
      interruptedToolCallResult({
        callType: "computer_call",
        callId: "computer-1",
        callItem: {
          type: "computer_call",
          callId: "computer-1",
          status: "in_progress",
          action: { type: "screenshot" },
        },
        reason: "worker_shutdown",
      }),
    ).toBeNull();
  });

  test("settles native tool_search identity retained only in providerData", () => {
    const callId = "call_native_search_1";
    const call = {
      id: "tsc_provider_item_1",
      type: "tool_search_call",
      status: "in_progress",
      arguments: { query: "mail" },
      providerData: { call_id: callId, execution: "client" },
    };
    const result = interruptedToolCallResult({
      callType: "tool_search_call",
      callId,
      callItem: call,
      reason: "worker_shutdown",
    });

    expect(result).toEqual({
      type: "tool_search_output",
      providerData: { call_id: callId, execution: "client" },
      status: "incomplete",
      tools: [],
    });
    const pair = [call, result!] as Array<Record<string, unknown>>;
    expect(ModelItem.array().parse(pair)).toEqual(pair);
    expect(sanitizeHistoryItemsForModel(pair)).toEqual(pair);
  });

  test("never persists a function_call_result whose function_call was pruned mid-batch", () => {
    // Reproduces the live orphan: a parallel tool-call batch where the SDK's
    // computed history is non-monotonic across reconciles, then an abnormal
    // turn end (goal-pause / interrupt) settles only part of the batch. The old
    // blind length watermark could freeze a position and later persist a result
    // whose call had been pruned away in an earlier slice.
    //
    // Snapshot 1: model emitted two parallel calls; neither has a result yet,
    // so the SDK's dropOrphanToolCalls prunes BOTH from state.history.
    const snap1 = [userMessage("do A and B")];
    // Snapshot 2: tool A settled; A's call+result are now present, B still
    // pending and pruned. History grew but at DIFFERENT positions than a naive
    // append-only view assumed.
    const snap2 = [userMessage("do A and B"), functionCall("call_a"), functionResult("call_a")];
    // Snapshot 3 (abnormal end): the goal paused; B was cancelled mid-batch and
    // never produced a result, so B stays pruned. Final history is A's settled
    // pair only.
    const snap3 = [userMessage("do A and B"), functionCall("call_a"), functionResult("call_a")];

    const persisted = persistAcrossReconciles([snap1, snap2, snap3]);

    // Every persisted result has its call earlier in the persisted rows.
    const callIds = new Set(
      persisted.filter((item) => item.type === "function_call").map((item) => item.callId),
    );
    for (const item of persisted) {
      if (item.type === "function_call_result") {
        expect(callIds.has(item.callId)).toBe(true);
      }
    }
    // No trace of the cancelled call B leaked through (neither orphaned result
    // nor dangling call).
    expect(persisted.some((item) => item.callId === "call_b")).toBe(false);
    // The settled A pair is intact and ordered.
    expect(persisted).toEqual([
      userMessage("do A and B"),
      functionCall("call_a"),
      functionResult("call_a"),
    ]);
  });

  test("defers a dangling call until its result lands, then persists the pair together", () => {
    // A trailing call with no result yet must NOT be persisted alone (it would
    // dangle and 400). It is deferred and the next reconcile writes call+result.
    const snapWithDanglingCall = [userMessage("go"), functionCall("call_x")];
    // The SDK prunes the dangling call, so the reconcile persists only the user
    // message and the watermark stays at 1.
    const first = historyRowsToAppend(snapWithDanglingCall, 0);
    expect(first.rows.map((row) => row.item)).toEqual([userMessage("go")]);
    expect(first.nextWatermark).toBe(1);
    // Next reconcile: the result arrived; call and result persist together.
    const snapSettled = [userMessage("go"), functionCall("call_x"), functionResult("call_x")];
    const second = historyRowsToAppend(snapSettled, first.nextWatermark);
    expect(second.rows.map((row) => row.item)).toEqual([
      functionCall("call_x"),
      functionResult("call_x"),
    ]);
    expect(second.nextWatermark).toBe(3);
  });

  test("holds steady when prior rows already exceed the sanitized length (legacy orphans)", () => {
    // A session already carrying orphan rows from before the fix: the watermark
    // (DB row count) can exceed the sanitized history length. Nothing new is
    // appended and the watermark does not move backward or rewrite rows.
    const sanitizedShorter = [userMessage("hi")];
    const result = historyRowsToAppend(sanitizedShorter, 5);
    expect(result.rows).toEqual([]);
    expect(result.nextWatermark).toBe(5);
  });

  test("appends at fresh absolute positions after a compaction (slice index decoupled from position)", () => {
    // Post-compaction, the in-memory history is the SHORT active set
    // [summary, ...tail] whose slice index (2) is far below the next free
    // absolute position. The summary sits at a fractional position (e.g. 5.5)
    // and the last superseded prefix tops out at 9, so the next whole-number
    // position is 10 — NOT the slice index. New items must land at 10, 11, ...
    // (never colliding with superseded prefix rows nor the fractional summary).
    const sanitized = [
      userMessage("[summary] folded prefix"), // slice idx 0 — already persisted at 5.5
      userMessage("recent turn"), // slice idx 1 — already persisted at 6
      userMessage("brand new turn"), // slice idx 2 — NEW
      functionCall("call_z"), // slice idx 3 — NEW
      functionResult("call_z"), // slice idx 4 — NEW
    ];
    const result = historyRowsToAppend(
      sanitized,
      /* persistedHistoryCount */ 2,
      /* nextPosition */ 10,
    );
    expect(result.rows.map((row) => row.position)).toEqual([10, 11, 12]);
    expect(result.rows.map((row) => row.item)).toEqual([
      userMessage("brand new turn"),
      functionCall("call_z"),
      functionResult("call_z"),
    ]);
    // Slice watermark advances to the in-memory length; the next absolute
    // position advances past the rows just written.
    expect(result.nextWatermark).toBe(5);
    expect(result.nextPosition).toBe(13);
  });

  test("default nextPosition preserves contiguous-from-zero appends (uncompacted path)", () => {
    // When callers omit nextPosition (the common, never-compacted path) the
    // absolute position equals the slice index, exactly as before this change.
    const sanitized = [userMessage("a"), userMessage("b"), userMessage("c")];
    const result = historyRowsToAppend(sanitized, 1);
    expect(result.rows.map((row) => row.position)).toEqual([1, 2]);
    expect(result.nextPosition).toBe(3);
  });

  test("keeps a pre-persisted machine batch while excluding attempt-local system notices", () => {
    const durableMachineBatch = {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "Durable machine input batch" }],
    };
    const attemptLocalNotice = {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "Recovery diagnostic for this attempt only" }],
    };
    const assistant = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Handled the durable input." }],
    };

    const result = historyRowsToAppend(
      [durableMachineBatch, attemptLocalNotice, assistant],
      /* persistedHistoryCount */ 1,
      /* nextPosition */ 1,
    );

    expect(result.rows).toEqual([{ position: 1, item: assistant }]);
    expect(result.nextWatermark).toBe(3);
    expect(result.nextPosition).toBe(2);
  });
});

describe("reconcile seed watermark (issue-61 skew: raw vs sanitized active count)", () => {
  // The seed the live worker computes at turn start. The fix is to seed from the
  // SANITIZED active length (what prepareRunInput actually puts into
  // state.history), NOT the raw active-row count.
  const sanitizedSeed = (activeRows: Array<Record<string, unknown>>) =>
    sanitizeHistoryItemsForModel(activeRows).length;

  test("a K-orphan legacy active history seeds K-too-high under the raw count and strands a new item", () => {
    // A legacy-corrupted session: its stored ACTIVE rows carry K=1 orphaned
    // function_call_result (call_legacy has no preceding function_call). The raw
    // active-row count is 3; sanitization drops the orphan, so state.history this
    // turn is seeded from only 2 items.
    const activeRows = [
      userMessage("earlier turn"),
      functionResult("call_legacy"), // K=1 orphan: no matching call. Dropped by sanitizer.
      userMessage("another earlier turn"),
    ];
    const rawActiveCount = activeRows.length; // 3 — the OLD seed
    const seed = sanitizedSeed(activeRows); // 2 — the FIXED seed
    expect(rawActiveCount).toBe(3);
    expect(seed).toBe(2);

    // This turn the model produced a fresh tool-call pair after the trigger. The
    // SDK's state.history is the sanitized prior history + the new trigger +
    // generated items (the orphan is already gone from the in-memory copy).
    const stateHistory = [
      userMessage("earlier turn"),
      userMessage("another earlier turn"),
      userMessage("new trigger"),
      functionCall("call_new"),
      functionResult("call_new"),
    ];

    // OLD behavior (raw seed = 3): the slice starts 1 item too late and skips the
    // genuinely-new "new trigger" item; worse, on a multi-step turn it can skip a
    // function_call while later persisting its function_call_result alone.
    const old = historyRowsToAppend(stateHistory, rawActiveCount);
    expect(old.rows.map((row) => row.item)).not.toContainEqual(userMessage("new trigger"));

    // FIXED behavior (sanitized seed = 2): the slice starts exactly at the first
    // genuinely-new item; every new item is persisted and no result is stranded.
    const fixed = historyRowsToAppend(stateHistory, seed);
    expect(fixed.rows.map((row) => row.item)).toEqual([
      userMessage("new trigger"),
      functionCall("call_new"),
      functionResult("call_new"),
    ]);
  });

  test("raw seed can persist a function_call_result whose function_call was in the skipped region", () => {
    // The session-bricking variant. K=2 orphans inflate the raw count so the
    // slice skips the new function_call but NOT its trailing result.
    const activeRows = [
      functionResult("orphan_1"), // K orphan
      functionResult("orphan_2"), // K orphan
      userMessage("prior turn"),
    ];
    const rawActiveCount = activeRows.length; // 4? no — 3
    const seed = sanitizedSeed(activeRows); // 1 (only the user message survives)
    expect(seed).toBe(1);

    // state.history seeded from the 1 surviving item, then this turn appended a
    // new call+result pair.
    const stateHistory = [
      userMessage("prior turn"),
      functionCall("call_new"),
      functionResult("call_new"),
    ];

    // OLD (raw seed = 3): slice(3) keeps only the trailing result — the orphan
    // the API 400s on. historyRowsToAppend re-sanitizes, so a single call here is
    // dropped as dangling; but had the call sat below the slice boundary in a
    // longer history its result would persist alone. Assert the FIXED seed never
    // produces that skip.
    const oldRows = historyRowsToAppend(stateHistory, rawActiveCount);
    expect(oldRows.rows).toEqual([]); // raw seed >= sanitized length: nothing new captured, the real new pair is lost

    const fixedRows = historyRowsToAppend(stateHistory, seed);
    const persisted = fixedRows.rows.map((row) => row.item);
    const callIds = new Set(
      persisted.filter((item) => item.type === "function_call").map((item) => item.callId),
    );
    for (const item of persisted) {
      if (item.type === "function_call_result") {
        expect(callIds.has(item.callId)).toBe(true);
      }
    }
    expect(persisted).toEqual([functionCall("call_new"), functionResult("call_new")]);
  });

  test("orphan-free active history: sanitized seed equals raw count (common path unchanged)", () => {
    const activeRows = [userMessage("hi"), functionCall("c1"), functionResult("c1")];
    expect(sanitizedSeed(activeRows)).toBe(activeRows.length);
  });
});

describe("model usage source key (re-dispatch charge stability)", () => {
  test("uses the provider responseId verbatim when present (stable + unique)", () => {
    expect(
      modelUsageSourceKey({
        responseId: "resp_abc",
        dispatchId: "act-1",
        positionalKey: "response-1",
      }),
    ).toBe("resp_abc");
    // The responseId path ignores the dispatch id, so a true activity retry
    // that re-emits the SAME responseId produces the SAME key and dedupes the
    // charge (no double-bill).
    expect(
      modelUsageSourceKey({
        responseId: "resp_abc",
        dispatchId: "act-2",
        positionalKey: "response-1",
      }),
    ).toBe("resp_abc");
  });

  test("positional fallback is unique per dispatch so a re-dispatch does not collide", () => {
    // The bug: without a responseId the old key was purely positional, so the
    // first model call of dispatch A and of dispatch B both keyed "response-1"
    // -> the second charge deduped away (undercharge). Folding the per-execution
    // dispatch id in keeps them distinct.
    const dispatchAFirst = modelUsageSourceKey({
      responseId: null,
      dispatchId: "act-A",
      positionalKey: "response-1",
    });
    const dispatchBFirst = modelUsageSourceKey({
      responseId: null,
      dispatchId: "act-B",
      positionalKey: "response-1",
    });
    expect(dispatchAFirst).not.toBe(dispatchBFirst);
    expect(dispatchAFirst).toBe("act-A:response-1");
    expect(dispatchBFirst).toBe("act-B:response-1");

    // The aggregate fallback (no per-response usage at all) has the same hazard
    // and the same fix.
    const aggA = modelUsageSourceKey({
      responseId: null,
      dispatchId: "act-A",
      positionalKey: "aggregate",
    });
    const aggB = modelUsageSourceKey({
      responseId: null,
      dispatchId: "act-B",
      positionalKey: "aggregate",
    });
    expect(aggA).not.toBe(aggB);
  });

  test("within one dispatch the positional fallback stays stable per call (in-dispatch dedupe)", () => {
    // Same dispatch id + same positional slot -> same key, so a retried record
    // within the one execution still dedupes (idempotent), while distinct calls
    // (response-1 vs response-2) stay distinct.
    expect(
      modelUsageSourceKey({
        responseId: null,
        dispatchId: "act-A",
        positionalKey: "response-1",
      }),
    ).toBe(
      modelUsageSourceKey({
        responseId: null,
        dispatchId: "act-A",
        positionalKey: "response-1",
      }),
    );
    expect(
      modelUsageSourceKey({
        responseId: null,
        dispatchId: "act-A",
        positionalKey: "response-1",
      }),
    ).not.toBe(
      modelUsageSourceKey({
        responseId: null,
        dispatchId: "act-A",
        positionalKey: "response-2",
      }),
    );
  });

  test("degrades to the bare positional key when no dispatch id is available", () => {
    // Outside a Temporal activity context (local/test) there is no activityId;
    // the key falls back to the positional value rather than throwing.
    expect(
      modelUsageSourceKey({
        responseId: null,
        dispatchId: null,
        positionalKey: "aggregate",
      }),
    ).toBe("aggregate");
  });

  test("keeps title usage distinct from compaction when a provider omits responseId", async () => {
    const expectedSourceKey = "act-A:session-title-1";
    const state = createSessionTitleModelUsageEventState(new Set([expectedSourceKey]));
    const result = await processSessionTitleModelUsageEvent({
      usage: { usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
      state,
      dispatchId: "act-A",
      settings: testSettings(),
      db: {} as any,
      observability: createObservability(testSettings(), { component: "worker" }),
      publish: null,
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
      provider: "openai",
      providerApi: "responses",
      model: "gpt-5",
      externallyBilled: true,
      servingCredentialId: null,
      priorSessionCredentialId: null,
      emittedSourceKeys: new Set(),
      renewLease: async () => undefined,
      leaseLost: () => false,
      leaseLostMessage: "lease lost",
    });

    expect(result).toEqual({ status: "duplicate", sourceKey: expectedSourceKey });
  });
});

describe("sandbox lease holder identity", () => {
  test("does not collide when sibling workflows reuse the same Temporal activity id", () => {
    const siblingAttemptA = sandboxLeaseHolderIdForAttempt("11111111-1111-4111-8111-111111111111");
    const siblingAttemptB = sandboxLeaseHolderIdForAttempt("22222222-2222-4222-8222-222222222222");

    expect(siblingAttemptA).not.toBe(siblingAttemptB);
    expect(siblingAttemptA).toBe("turn-attempt:11111111-1111-4111-8111-111111111111");
  });

  test("is stable for an activity retry of the same durable attempt", () => {
    const attemptId = "33333333-3333-4333-8333-333333333333";
    expect(sandboxLeaseHolderIdForAttempt(attemptId)).toBe(
      sandboxLeaseHolderIdForAttempt(attemptId),
    );
  });

  test("rejects a missing durable attempt identity", () => {
    expect(() => sandboxLeaseHolderIdForAttempt("  ")).toThrow(
      "Sandbox lease holder requires a turn attempt id",
    );
  });
});

describe("completed model-call metering at ownership fences", () => {
  test("records already-spent usage before surfacing a lost lease", async () => {
    const order: string[] = [];
    await expect(
      recordCompletedModelCallBeforeOwnershipFences({
        renewLease: async () => {
          order.push("renew");
        },
        recordUsage: async () => {
          order.push("meter");
        },
        leaseLost: () => true,
        leaseLostMessage: "lease lost",
      }),
    ).rejects.toThrow("lease lost");
    expect(order).toEqual(["renew", "meter"]);
  });

  test("returns only after renewal and metering when the lease remains held", async () => {
    const order: string[] = [];
    await recordCompletedModelCallBeforeOwnershipFences({
      renewLease: async () => {
        order.push("renew");
      },
      recordUsage: async () => {
        order.push("meter");
      },
      leaseLost: () => false,
      leaseLostMessage: "lease lost",
    });
    expect(order).toEqual(["renew", "meter"]);
  });

  test("persists usage before an attempt-owned signal rejects a replaced attempt", async () => {
    const order: string[] = [];
    await expect(
      recordCompletedModelCallBeforeOwnershipFences({
        renewLease: async () => {
          order.push("renew");
        },
        recordUsage: async () => {
          order.push("meter");
        },
        leaseLost: () => false,
        leaseLostMessage: "lease lost",
        recordAttemptSignals: async () => {
          order.push("attempt-signal");
          throw new Error("attempt replaced");
        },
      }),
    ).rejects.toThrow("attempt replaced");
    expect(order).toEqual(["renew", "meter", "attempt-signal"]);
  });
});

describe("production model-response usage callback authority", () => {
  test("fails Fast turns when the raw provider response omits or downgrades service_tier", () => {
    const terminal = (serviceTier?: string) =>
      new RunRawModelStreamEvent({
        type: "model",
        providerData: { rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE },
        event: {
          type: "response.completed",
          response: {
            id: "resp-fast",
            ...(serviceTier ? { service_tier: serviceTier } : {}),
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      } as any);

    expect(() =>
      assertModelResponseLatencyMode({
        event: terminal("priority"),
        requested: "fast",
        model: "gpt-5.6-sol",
      }),
    ).not.toThrow();
    expect(() =>
      assertModelResponseLatencyMode({
        event: terminal(),
        requested: "fast",
        model: "gpt-5.6-sol",
      }),
    ).toThrow(/service_tier=missing/);
    expect(() =>
      assertModelResponseLatencyMode({
        event: terminal("default"),
        requested: "fast",
        model: "gpt-5.6-sol",
      }),
    ).toThrow(/service_tier=default/);
    // Codex ChatGPT auth: response service_tier is not an end-to-end honor signal.
    expect(() =>
      assertModelResponseLatencyMode({
        event: terminal("default"),
        requested: "fast",
        model: "codex/gpt-5.6-luna",
        providerId: "codex-subscription",
      }),
    ).not.toThrow();
  });

  test("claims the pinned SDK terminal pair once and cannot bind stale usage after restart", async () => {
    const response = {
      id: "resp-sdk-terminal-pair",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        // The provider total is internally inconsistent. The callback must use
        // the canonical input+output total for both context and billing.
        total_tokens: 0,
        input_tokens_details: { cached_tokens: 80, cache_write_tokens: 5 },
      },
    };
    // These are the exact two terminal event shapes emitted, in order, by the
    // repository-pinned @openai/agents-openai 0.14.3 stream implementation.
    const normalizedTerminal = new RunRawModelStreamEvent({
      type: "response_done",
      response: {
        id: response.id,
        output: [],
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 0,
          inputTokensDetails: { cached_tokens: 80, cache_write_tokens: 5 },
        },
      },
    } as any);
    const rawTerminal = new RunRawModelStreamEvent({
      type: "model",
      providerData: { rawModelEventSource: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE },
      event: { type: "response.completed", response },
    } as any);

    const observability = createObservability(testSettings(), { component: "worker" });
    const billingRows = new Map<string, Record<string, unknown>>();
    const recordUsageSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        if (!billingRows.has(input.idempotencyKey)) {
          billingRows.set(input.idempotencyKey, input as unknown as Record<string, unknown>);
        }
      },
    );
    try {
      const durableUsageSourceKeys = new Set<string>();
      const publish = async (batch: any[]) => ({
        accepted: true,
        events: batch.map((event) => {
          const sourceKey = event.payload?.sourceKey as string;
          const duplicate = durableUsageSourceKeys.has(sourceKey);
          durableUsageSourceKeys.add(sourceKey);
          return {
            ...event,
            id: crypto.randomUUID(),
            turnAssociation: duplicate ? ("duplicate" as const) : ("current" as const),
            ...(duplicate
              ? {
                  duplicateOfEventId: crypto.randomUUID(),
                  duplicateReason: "duplicate_provider_response_usage",
                }
              : {}),
          };
        }),
      });
      const fencedInputs: Array<number | null> = [];
      const state = createModelResponseEventState();
      const emittedSourceKeys = new Set<string>();
      const process = (event: any, targetState = state, dispatchId = "activity-A") =>
        processModelResponseTerminalEvent({
          event,
          state: targetState,
          dispatchId,
          settings: testSettings(),
          db: {} as any,
          observability,
          publish: publish as any,
          accountId: "acct-1",
          workspaceId: "ws-1",
          sessionId: "sess-1",
          turnId: "turn-1",
          turnAttemptId: "attempt-1",
          provider: "codex-subscription",
          providerApi: "responses",
          model: "codex/gpt-5.6-sol",
          metricProvider: "codex-subscription",
          externallyBilled: true,
          servingCredentialId: "credential-1",
          priorSessionCredentialId: "credential-1",
          emittedSourceKeys,
          renewLease: async () => undefined,
          leaseLost: () => false,
          leaseLostMessage: "lease lost",
          setLastInputTokens: async (tokens) => {
            fencedInputs.push(tokens);
          },
        });

      const filter = contextRobustnessFilterForSettings(
        testSettings({
          contextWindowTokens: 20_000,
          contextAutoCompactThresholdTokens: 10_000,
        }),
        {
          throwOnCompactionNeeded: true,
          contextCompactionSignal: () => modelResponseContextSignal(state),
        },
      );
      const first = [{ type: "message", role: "user", content: "start" }] as any;
      await filter({ modelData: { input: first, instructions: "system" }, agent: {} as any });
      const second = [
        ...first,
        { type: "message", role: "assistant", content: "first response" },
        { type: "message", role: "user", content: "continue" },
      ] as any;
      await filter({ modelData: { input: second, instructions: "system" }, agent: {} as any });

      expect((await process(normalizedTerminal)).status).toBe("processed");
      expect((await process(rawTerminal)).status).toBe("duplicate");
      expect(state.responseCount).toBe(1);
      expect(state.contextSignal).toEqual({ revision: 1, totalTokens: 120 });
      expect(fencedInputs).toEqual([100]);
      expect(durableUsageSourceKeys).toEqual(new Set([response.id]));
      expect([...billingRows.values()]).toEqual([
        expect.objectContaining({
          eventType: "model.cost",
          quantity: 0,
          idempotencyKey: `usage:model.cost:turn-1:${response.id}`,
        }),
      ]);

      const metricsAfterPair = await observability.prometheusMetrics();
      expect(metricsAfterPair).toMatch(
        /opengeni_model_input_tokens_count\{[^}]*provider="codex-subscription"[^}]*\} 1\b/,
      );
      expect(metricsAfterPair).toMatch(
        /opengeni_model_cached_tokens_total\{[^}]*provider="codex-subscription"[^}]*\} 80\b/,
      );
      expect(metricsAfterPair).toMatch(
        /opengeni_model_cache_write_tokens_total\{[^}]*provider="codex-subscription"[^}]*\} 5\b/,
      );

      // The duplicate terminal callback must not advance the old response to
      // revision 2. Revision 1 cannot bind to request 2, and an unbound local
      // estimate must not force compaction.
      const third = [
        ...second,
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "x".repeat(48_000) }],
        },
        { type: "message", role: "user", content: "continue again" },
      ] as any;
      await expect(
        filter({ modelData: { input: third, instructions: "system" }, agent: {} as any }),
      ).resolves.toMatchObject({ input: third });

      // A worker restart/re-dispatch rebuilds local state. The stable provider
      // response id reaches the durable fences again, but duplicate authority
      // prevents every local metric/context/fenced-input effect and the DB-level
      // idempotency key keeps one billing row.
      const restartedState = createModelResponseEventState();
      const restartedInputsBefore = fencedInputs.length;
      const restartedEmittedSourceKeys = new Set<string>();
      const restarted = await processModelResponseTerminalEvent({
        event: normalizedTerminal as any,
        state: restartedState,
        dispatchId: "activity-B",
        settings: testSettings(),
        db: {} as any,
        observability,
        publish: publish as any,
        accountId: "acct-1",
        workspaceId: "ws-1",
        sessionId: "sess-1",
        turnId: "turn-1",
        turnAttemptId: "attempt-2",
        provider: "codex-subscription",
        providerApi: "responses",
        model: "codex/gpt-5.6-sol",
        metricProvider: "codex-subscription",
        externallyBilled: true,
        servingCredentialId: "credential-1",
        priorSessionCredentialId: "credential-1",
        emittedSourceKeys: restartedEmittedSourceKeys,
        renewLease: async () => undefined,
        leaseLost: () => false,
        leaseLostMessage: "lease lost",
        setLastInputTokens: async (tokens) => {
          fencedInputs.push(tokens);
        },
      });
      expect(restarted).toMatchObject({
        status: "processed",
        authoritative: false,
        sourceKey: response.id,
      });
      expect(restartedState.responseCount).toBe(1);
      expect(restartedState.contextSignal).toBeNull();
      expect(fencedInputs).toHaveLength(restartedInputsBefore);
      expect(billingRows).toHaveLength(1);
      const metricsAfterRestart = await observability.prometheusMetrics();
      expect(metricsAfterRestart).toMatch(
        /opengeni_model_input_tokens_count\{[^}]*provider="codex-subscription"[^}]*\} 1\b/,
      );
    } finally {
      recordUsageSpy.mockRestore();
    }
  });

  test("persists unpinned workspace Gateway endpoint authority before a soft fact-write failure", async () => {
    const upstreamModelId = "anthropic/claude-sonnet-4.6";
    const model = `${WORKSPACE_GATEWAY_MODEL_ID_PREFIX}${upstreamModelId}`;
    const settings = withWorkspaceGatewayCredential(
      testSettings({ billingMode: "stripe", usageLimitsMode: "managed" }),
      "vck_workspace_test",
      [{ upstreamModelId }],
    );
    const event = new RunRawModelStreamEvent({
      type: "response_done",
      response: {
        id: "resp-workspace-gateway",
        output: [],
        providerMetadata: {
          gateway: {
            routing: { finalProvider: "anthropic" },
            inferenceCost: "0.00000325",
          },
        },
        usage: { inputTokens: 9, outputTokens: 8, totalTokens: 17 },
      },
    } as any);
    const usageRows: Array<Record<string, unknown>> = [];
    const eventPayloads: Array<Record<string, unknown>> = [];
    const facts: Array<Record<string, unknown>> = [];
    const usageSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        usageRows.push(input as unknown as Record<string, unknown>);
      },
    );
    const factSpy = spyOn(opengeniDb, "recordModelCallFact").mockImplementation(
      async (_db, input) => {
        facts.push(input as unknown as Record<string, unknown>);
        throw new Error("fact writer unavailable");
      },
    );
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async () => {
        throw new Error("workspace Gateway usage must not debit OpenGeni credits");
      },
    );
    try {
      const result = await processModelResponseTerminalEvent({
        event,
        state: createModelResponseEventState(),
        dispatchId: "activity-workspace-gateway",
        settings,
        db: {} as any,
        observability: createObservability(settings, { component: "worker" }),
        publish: (async (batch: any[]) => ({
          accepted: true,
          events: batch.map((entry) => {
            eventPayloads.push(entry.payload as Record<string, unknown>);
            return {
              ...entry,
              id: crypto.randomUUID(),
              turnAssociation: "current" as const,
            };
          }),
        })) as any,
        accountId: "acct-1",
        workspaceId: "ws-1",
        sessionId: "sess-workspace-gateway",
        turnId: "turn-workspace-gateway",
        turnAttemptId: "attempt-workspace-gateway",
        provider: WORKSPACE_GATEWAY_PROVIDER_ID,
        providerApi: "responses",
        model,
        metricProvider: WORKSPACE_GATEWAY_PROVIDER_ID,
        externallyBilled: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: false,
        servingCredentialId: null,
        priorSessionCredentialId: null,
        emittedSourceKeys: new Set<string>(),
        renewLease: async () => undefined,
        leaseLost: () => false,
        leaseLostMessage: "lease lost",
        setLastInputTokens: async () => undefined,
      });

      expect(result).toMatchObject({
        status: "processed",
        authoritative: true,
        sourceKey: "resp-workspace-gateway",
      });
      expect(usageRows).toEqual([
        expect.objectContaining({ eventType: "model.cost", quantity: 0 }),
      ]);
      expect(eventPayloads).toEqual([
        expect.objectContaining({
          provider: WORKSPACE_GATEWAY_PROVIDER_ID,
          upstreamProvider: "anthropic",
          billingPath: "external",
        }),
      ]);
      expect(facts).toEqual([
        expect.objectContaining({
          provider: "anthropic",
          model,
          billingPath: "external",
          pricedCostMicros: 0,
          estimatedProviderCostMicros: 4,
          pricingSource: "gateway_reported",
        }),
      ]);
      expect(debitSpy).not.toHaveBeenCalled();
    } finally {
      usageSpy.mockRestore();
      factSpy.mockRestore();
      debitSpy.mockRestore();
    }
  });

  test("clears missing usage and uses the same response ordinal when usage resumes", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const recordUsageSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async () => undefined,
    );
    try {
      const state = createModelResponseEventState();
      const fencedInputs: Array<number | null> = [];
      const emittedSourceKeys = new Set<string>();
      const publish = async (batch: any[]) => ({
        accepted: true,
        events: batch.map((event) => ({
          ...event,
          id: crypto.randomUUID(),
          turnAssociation: "current" as const,
        })),
      });
      const process = (event: RunRawModelStreamEvent) =>
        processModelResponseTerminalEvent({
          event,
          state,
          dispatchId: "activity-missing-usage",
          settings: testSettings(),
          db: {} as any,
          observability,
          publish: publish as any,
          accountId: "acct-1",
          workspaceId: "ws-1",
          sessionId: "sess-1",
          turnId: "turn-1",
          turnAttemptId: "attempt-1",
          provider: "codex-subscription",
          providerApi: "responses",
          model: "codex/gpt-5.6-sol",
          metricProvider: "codex-subscription",
          externallyBilled: true,
          servingCredentialId: "credential-1",
          priorSessionCredentialId: "credential-1",
          emittedSourceKeys,
          renewLease: async () => undefined,
          leaseLost: () => false,
          leaseLostMessage: "lease lost",
          setLastInputTokens: async (tokens) => {
            fencedInputs.push(tokens);
          },
        });
      const filter = contextRobustnessFilterForSettings(
        testSettings({
          contextWindowTokens: 20_000,
          contextAutoCompactThresholdTokens: 10_000,
        }),
        {
          throwOnCompactionNeeded: true,
          contextCompactionSignal: () => modelResponseContextSignal(state),
        },
      );

      const first = [{ type: "message", role: "user", content: "start" }] as any;
      await filter({ modelData: { input: first, instructions: "system" }, agent: {} as any });
      const missingUsage = new RunRawModelStreamEvent({
        type: "response_done",
        response: { id: "resp-1", output: [] },
      } as any);
      expect(await process(missingUsage)).toMatchObject({
        status: "processed",
        authoritative: true,
      });
      expect(state).toMatchObject({
        responseCount: 1,
        contextSignal: null,
      });
      expect(fencedInputs).toEqual([null]);

      const second = [
        ...first,
        { type: "message", role: "assistant", content: "first response" },
        { type: "message", role: "user", content: "continue" },
      ] as any;
      await filter({ modelData: { input: second, instructions: "system" }, agent: {} as any });
      const validUsage = new RunRawModelStreamEvent({
        type: "response_done",
        response: {
          id: "resp-2",
          output: [],
          usage: { inputTokens: 11_000, outputTokens: 1_000, totalTokens: 12_000 },
        },
      } as any);
      expect(await process(validUsage)).toMatchObject({
        status: "processed",
        authoritative: true,
      });
      expect(state).toMatchObject({
        responseCount: 2,
        contextSignal: { revision: 2, totalTokens: 12_000 },
      });
      expect(fencedInputs).toEqual([null, 11_000]);

      const third = [
        ...second,
        { type: "message", role: "assistant", content: "second response" },
        { type: "message", role: "user", content: "continue again" },
      ] as any;
      await expect(
        filter({ modelData: { input: third, instructions: "system" }, agent: {} as any }),
      ).rejects.toBeInstanceOf(CompactionNeededError);
    } finally {
      recordUsageSpy.mockRestore();
    }
  });

  test("keeps no-id response ordinals unique across an in-activity compaction retry", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const billingRows = new Map<string, Record<string, unknown>>();
    const recordUsageSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        if (!billingRows.has(input.idempotencyKey)) {
          billingRows.set(input.idempotencyKey, input as unknown as Record<string, unknown>);
        }
      },
    );
    try {
      const durableUsageSourceKeys = new Set<string>();
      const publish = async (batch: any[]) => ({
        accepted: true,
        events: batch.map((event) => {
          const sourceKey = event.payload?.sourceKey as string;
          const duplicate = durableUsageSourceKeys.has(sourceKey);
          durableUsageSourceKeys.add(sourceKey);
          return {
            ...event,
            id: crypto.randomUUID(),
            turnAssociation: duplicate ? ("duplicate" as const) : ("current" as const),
          };
        }),
      });
      const terminal = (inputTokens: number, outputTokens: number) =>
        new RunRawModelStreamEvent({
          type: "response_done",
          response: {
            output: [],
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            },
          },
        } as any);
      const state = createModelResponseEventState();
      const emittedSourceKeys = new Set<string>();
      const process = (event: RunRawModelStreamEvent) =>
        processModelResponseTerminalEvent({
          event,
          state,
          dispatchId: "activity-A",
          settings: testSettings(),
          db: {} as any,
          observability,
          publish: publish as any,
          accountId: "acct-1",
          workspaceId: "ws-1",
          sessionId: "sess-1",
          turnId: "turn-1",
          turnAttemptId: "attempt-1",
          provider: "codex-subscription",
          providerApi: "responses",
          model: "codex/gpt-5.6-sol",
          metricProvider: "codex-subscription",
          externallyBilled: true,
          servingCredentialId: "credential-1",
          priorSessionCredentialId: "credential-1",
          emittedSourceKeys,
          renewLease: async () => undefined,
          leaseLost: () => false,
          leaseLostMessage: "lease lost",
          setLastInputTokens: async () => undefined,
        });

      const beforeCompaction = await process(terminal(100, 20));
      // The compaction retry re-enters the stream callback with this same
      // activity-wide state rather than resetting responseCount.
      const afterCompaction = await process(terminal(200, 30));

      expect(beforeCompaction).toMatchObject({
        status: "processed",
        sourceKey: "activity-A:response-1",
        authoritative: true,
      });
      expect(afterCompaction).toMatchObject({
        status: "processed",
        sourceKey: "activity-A:response-2",
        authoritative: true,
      });
      expect(state.responseCount).toBe(2);
      expect(durableUsageSourceKeys).toEqual(
        new Set(["activity-A:response-1", "activity-A:response-2"]),
      );
      expect([...billingRows.values()]).toEqual([
        expect.objectContaining({
          eventType: "model.cost",
          quantity: 0,
          idempotencyKey: "usage:model.cost:turn-1:activity-A:response-1",
        }),
        expect.objectContaining({
          eventType: "model.cost",
          quantity: 0,
          idempotencyKey: "usage:model.cost:turn-1:activity-A:response-2",
        }),
      ]);
    } finally {
      recordUsageSpy.mockRestore();
    }
  });

  test("claims compaction usage before retry side effects and defers restart authority to durable usage", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const billingRows = new Map<string, Record<string, unknown>>();
    const factRows: Array<Record<string, unknown>> = [];
    const recordUsageSpy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(
      async (_db, input) => {
        if (!billingRows.has(input.idempotencyKey)) {
          billingRows.set(input.idempotencyKey, input as unknown as Record<string, unknown>);
        }
      },
    );
    const recordFactSpy = spyOn(opengeniDb, "recordModelCallFact").mockImplementation(
      async (_db, input) => {
        factRows.push(input as unknown as Record<string, unknown>);
      },
    );
    try {
      const durableUsageSourceKeys = new Set<string>();
      const publish = async (batch: any[]) => ({
        accepted: true,
        events: batch.map((event) => {
          const sourceKey = event.payload?.sourceKey as string;
          const duplicate = durableUsageSourceKeys.has(sourceKey);
          durableUsageSourceKeys.add(sourceKey);
          return {
            ...event,
            id: crypto.randomUUID(),
            turnAssociation: duplicate ? ("duplicate" as const) : ("current" as const),
          };
        }),
      });
      const usage = {
        responseId: "resp-compaction-retry",
        usage: {
          inputTokens: 200,
          outputTokens: 10,
          totalTokens: 210,
          inputTokensDetails: { cached_tokens: 150 },
        },
      };
      let leaseRenewals = 0;
      const state = createCompactionModelUsageEventState();
      const emittedSourceKeys = new Set<string>();
      const process = (
        targetState = state,
        targetEmittedSourceKeys = emittedSourceKeys,
        dispatchId = "activity-A",
      ) =>
        processCompactionModelUsageEvent({
          usage,
          state: targetState,
          dispatchId,
          settings: testSettings(),
          db: {} as any,
          observability,
          publish: publish as any,
          accountId: "acct-1",
          workspaceId: "ws-1",
          sessionId: "sess-1",
          turnId: "turn-1",
          turnAttemptId: "attempt-1",
          provider: "codex-subscription",
          providerApi: "responses",
          model: "codex/gpt-5.6-sol",
          externallyBilled: true,
          servingCredentialId: "credential-1",
          priorSessionCredentialId: "credential-1",
          emittedSourceKeys: targetEmittedSourceKeys,
          renewLease: async () => {
            leaseRenewals += 1;
          },
          leaseLost: () => false,
          leaseLostMessage: "lease lost",
          contextContributions: [
            {
              source: "workspace_instruction_policy",
              items: 1,
              utf8Bytes: 40,
              estimatedTokens: 10,
            },
          ],
        });

      expect(await process()).toMatchObject({
        status: "processed",
        sourceKey: usage.responseId,
        authoritative: true,
      });
      expect(await process()).toEqual({ status: "duplicate", sourceKey: usage.responseId });
      expect(state.usageCount).toBe(1);
      expect(leaseRenewals).toBe(1);
      expect(billingRows.size).toBe(1);

      const restartedState = createCompactionModelUsageEventState();
      expect(await process(restartedState, new Set<string>(), "activity-B")).toMatchObject({
        status: "processed",
        sourceKey: usage.responseId,
        authoritative: false,
      });
      expect(restartedState.usageCount).toBe(1);
      expect(leaseRenewals).toBe(2);
      expect(billingRows.size).toBe(1);
      expect(durableUsageSourceKeys).toEqual(new Set([usage.responseId]));
      expect(factRows).toEqual([
        expect.objectContaining({
          sourceKey: usage.responseId,
          contextContributions: [
            {
              source: "workspace_instruction_policy",
              items: 1,
              utf8Bytes: 40,
              estimatedTokens: 10,
            },
          ],
        }),
      ]);

      const metrics = await observability.prometheusMetrics();
      expect(metrics).toMatch(
        /opengeni_model_cached_tokens_total\{[^}]*provider="codex-subscription"[^}]*\} 150\b/,
      );
    } finally {
      recordFactSpy.mockRestore();
      recordUsageSpy.mockRestore();
    }
  });
});

describe("model call usage observability", () => {
  test("logs and emits normalized cache/reasoning usage fields", async () => {
    const infos: Array<Record<string, unknown>> = [];
    const events: Array<{ type: string; payload: unknown }> = [];
    const observability = {
      info: (_message: string, attributes: Record<string, unknown>) => infos.push(attributes),
      warn: mock(),
    };

    await emitModelCallUsage({
      observability: observability as any,
      publish: async (batch) => {
        events.push(
          ...batch.map((event) => ({
            type: event.type,
            payload: event.payload,
          })),
        );
        return {
          accepted: true,
          events: batch.map((event) => ({
            ...event,
            id: crypto.randomUUID(),
            turnAssociation: "current" as const,
          })) as any,
        };
      },
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      provider: "openai",
      providerApi: "responses",
      model: "gpt-5.6-sol",
      sourceKey: "resp-1",
      usage: {
        responseId: "resp-1",
        usage: {
          inputTokens: 1200,
          outputTokens: 100,
          totalTokens: 1300,
          inputTokensDetails: { cached_tokens: 1024, cache_write_tokens: 256 },
          outputTokensDetails: { reasoning_tokens: 12 },
        },
      },
    });

    expect(infos[0]).toMatchObject({
      provider: "openai",
      providerApi: "responses",
      model: "gpt-5.6-sol",
      inputTokens: 1200,
      outputTokens: 100,
      cachedTokens: 1024,
      cacheWriteTokens: 256,
      reasoningTokens: 12,
    });
    expect(infos[0]).not.toHaveProperty("accountId");
    expect(infos[0]).not.toHaveProperty("workspaceId");
    expect(infos[0]).not.toHaveProperty("sessionId");
    expect(infos[0]).not.toHaveProperty("turnId");
    expect(infos[0]).not.toHaveProperty("sourceKey");
    expect(events).toEqual([
      {
        type: "agent.model.usage",
        payload: expect.objectContaining({
          provider: "openai",
          providerApi: "responses",
          model: "gpt-5.6-sol",
          sourceKey: "resp-1",
          inputTokens: 1200,
          outputTokens: 100,
          cachedTokens: 1024,
          cacheWriteTokens: 256,
          reasoningTokens: 12,
        }),
      },
    ]);
    // The account-switch dimensions are LOG-ONLY (the research hypothesis) and
    // must NEVER leak into the durable event payload.
    expect(infos[0]).not.toHaveProperty("servingAccountHash");
    expect(events[0]?.payload).not.toHaveProperty("servingAccountHash");
    expect(events[0]?.payload).not.toHaveProperty("accountChangedFromPrevCall");
  });

  test("logs the opaque serving-account tag and account-switch flag when provided", async () => {
    const infos: Array<Record<string, unknown>> = [];
    const observability = {
      info: (_message: string, attributes: Record<string, unknown>) => infos.push(attributes),
      warn: mock(),
    };

    await emitModelCallUsage({
      observability: observability as any,
      publish: async (batch) => ({
        accepted: true,
        events: batch.map((event) => ({
          ...event,
          id: crypto.randomUUID(),
          turnAssociation: "current" as const,
        })) as any,
      }),
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      provider: "codex-subscription",
      providerApi: "responses",
      model: "codex/gpt-5.6",
      sourceKey: "resp-1",
      usage: {
        responseId: "resp-1",
        usage: {
          inputTokens: 1200,
          inputTokensDetails: { cached_tokens: 200 },
        },
      },
      servingAccountHash: "abc123def456",
      accountChangedFromPrevCall: true,
    });

    expect(infos[0]).toMatchObject({
      inputTokens: 1200,
      cachedTokens: 200,
      servingAccountHash: "abc123def456",
      accountChangedFromPrevCall: true,
    });
    expect(infos[0]).not.toHaveProperty("accountId");
    expect(infos[0]).not.toHaveProperty("workspaceId");
    expect(infos[0]).not.toHaveProperty("sessionId");
    expect(infos[0]).not.toHaveProperty("turnId");
    expect(infos[0]).not.toHaveProperty("sourceKey");
  });

  test("does not log a duplicate usage observation as authoritative", async () => {
    const infos: Array<Record<string, unknown>> = [];
    const observability = createObservability(testSettings(), { component: "worker" });
    observability.info = (_message: string, attributes: Record<string, unknown>) =>
      infos.push(attributes);
    observability.warn = mock();
    await emitModelCallUsage({
      observability,
      publish: async (batch) => ({
        accepted: true,
        events: batch.map((event) => ({
          ...event,
          id: crypto.randomUUID(),
          turnAssociation: "duplicate" as const,
          duplicateOfEventId: crypto.randomUUID(),
          duplicateReason: "duplicate_provider_response_usage",
        })) as any,
      }),
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      provider: "openai",
      providerApi: "responses",
      model: "gpt-5.6-sol",
      sourceKey: "resp-duplicate",
      usage: { usage: { inputTokens: 10, outputTokens: 1 } },
    });

    expect(infos).toEqual([]);
    const metrics = await observability.prometheusMetrics();
    expect(metrics).not.toMatch(/opengeni_model_cache_read_telemetry_total/);
    expect(metrics).not.toMatch(/opengeni_model_cached_tokens_total/);
  });

  test("wires raw response cache writes through the authoritative production metric path", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const responseUsage = modelResponseUsageFromResponse({
      id: "resp-write",
      usage: {
        input_tokens: 1200,
        output_tokens: 100,
        total_tokens: 1300,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 250 },
      },
    });
    expect(responseUsage).not.toBeNull();

    await emitModelCallUsage({
      observability,
      publish: async (batch) => ({
        accepted: true,
        events: batch.map((event) => ({
          ...event,
          id: crypto.randomUUID(),
          turnAssociation: "current" as const,
        })) as any,
      }),
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      provider: "openai",
      providerApi: "responses",
      model: "gpt-5.6-sol",
      sourceKey: "resp-write",
      usage: responseUsage,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_cached_tokens_total\{[^}]*provider="openai"[^}]*\} 800\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_cache_write_tokens_total\{[^}]*provider="openai"[^}]*\} 250\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_cache_read_telemetry_total\{[^}]*provider="openai"[^}]*status="reported"[^}]*\} 1\b/,
    );
  });

  test("sums SDK aggregate retries once and dedupes an authoritative source key", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const aggregate = new Usage();
    aggregate.add(
      new Usage({
        inputTokens: 1000,
        outputTokens: 10,
        totalTokens: 1010,
        inputTokensDetails: { cached_tokens: 100, cache_write_tokens: 200 },
        outputTokensDetails: { reasoning_tokens: 5 },
      }),
    );
    aggregate.add(
      new Usage({
        inputTokens: 2000,
        outputTokens: 20,
        totalTokens: 2020,
        inputTokensDetails: { cached_tokens: 300, cacheWriteTokens: 400 },
        outputTokensDetails: { reasoning_tokens: 7 },
      }),
    );
    const sourceKeys = new Set<string>();
    const payloads: Array<Record<string, unknown>> = [];
    let publishCount = 0;
    const publish = async (batch: any[]) => {
      publishCount += 1;
      payloads.push(batch[0]?.payload as Record<string, unknown>);
      return {
        accepted: true,
        events: batch.map((event) => ({
          ...event,
          id: crypto.randomUUID(),
          turnAssociation: "current" as const,
        })) as any,
      };
    };
    const input = {
      observability,
      publish,
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      provider: "codex-subscription",
      providerApi: "responses" as const,
      model: "codex/gpt-5.6-sol",
      sourceKey: "aggregate-1",
      usage: { usage: aggregate },
      emittedSourceKeys: sourceKeys,
    };

    await emitModelCallUsage(input);
    await emitModelCallUsage(input);

    expect(publishCount).toBe(1);
    expect(payloads[0]).toMatchObject({
      inputTokens: 3000,
      outputTokens: 30,
      cachedTokens: 400,
      cacheWriteTokens: 600,
      reasoningTokens: 12,
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_cached_tokens_total\{[^}]*provider="codex-subscription"[^}]*\} 400\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_cache_write_tokens_total\{[^}]*provider="codex-subscription"[^}]*\} 600\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_cache_read_telemetry_total\{[^}]*provider="codex-subscription"[^}]*status="reported"[^}]*\} 1\b/,
    );
  });

  test("keeps malformed provider usage out of durable payloads and emits bounded diagnostics", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const info = mock();
    const warn = mock();
    observability.info = info;
    observability.warn = warn;
    const payloads: Array<Record<string, unknown>> = [];
    const responseUsage = modelResponseUsageFromResponse({
      id: "resp-malformed",
      usage: {
        input_tokens: 1.5,
        output_tokens: Number.POSITIVE_INFINITY,
        input_tokens_details: {
          cached_tokens: Number.NaN,
          cache_write_tokens: Number.MAX_SAFE_INTEGER,
        },
      },
    });
    expect(responseUsage).not.toBeNull();

    await emitModelCallUsage({
      observability,
      publish: async (batch) => {
        payloads.push(batch[0]?.payload as Record<string, unknown>);
        return {
          accepted: true,
          events: batch.map((event) => ({
            ...event,
            id: crypto.randomUUID(),
            turnAssociation: "current" as const,
          })) as any,
        };
      },
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      provider: "openai",
      providerApi: "responses",
      model: "gpt-5.6-sol",
      sourceKey: "resp-malformed",
      usage: responseUsage,
    });

    expect(payloads[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    expect(Object.values(payloads[0] ?? {})).not.toContain(Number.POSITIVE_INFINITY);
    expect(info).toHaveBeenCalledWith(
      "model call usage",
      expect.objectContaining({ cacheWriteTokens: null }),
    );
    expect(warn).toHaveBeenCalledWith(
      "model call usage fields rejected",
      expect.objectContaining({
        rejectedFields: expect.stringContaining("inputTokensDetails.cache_write_tokens"),
      }),
    );
    const rejectedFields = (warn.mock.calls[0]?.[1] as Record<string, unknown>)
      ?.rejectedFields as string;
    expect(rejectedFields).not.toContain("9007199254740991");

    const metrics = await observability.prometheusMetrics();
    expect(metrics).not.toMatch(/opengeni_model_cached_tokens_total/);
    expect(metrics).not.toMatch(/opengeni_model_cache_write_tokens_total/);
    expect(metrics).toMatch(
      /opengeni_model_cache_read_telemetry_total\{[^}]*provider="openai"[^}]*status="missing"[^}]*\} 1\b/,
    );
  });
});

describe("active sandbox backend resolution (Case B: clone-onto-real-disk gate)", () => {
  const selfhostedPointer = async () => ({ activeSandboxId: "sbx_machine" });
  const selfhostedKind = async () => "selfhosted";

  test("returns 'selfhosted' when an active swap points at a connected machine", async () => {
    // Home backend stays cloud (e.g. modal) but the active sandbox is a BYO
    // machine — buildAgent must be told "selfhosted" so the repository clone hook
    // is skipped (never `git clone` onto the user's real disk).
    expect(await resolveActiveSandboxBackend(true, selfhostedPointer, selfhostedKind)).toBe(
      "selfhosted",
    );
  });

  test("returns undefined when routing is off (flag gated; home backend default)", async () => {
    // The active pointer is only meaningful when the selfhosted feature is on; with
    // it off we never even query, and the cloud home backend governs unchanged.
    let queried = false;
    const backend = await resolveActiveSandboxBackend(
      false,
      async () => {
        queried = true;
        return { activeSandboxId: "sbx_machine" };
      },
      selfhostedKind,
    );
    expect(backend).toBeUndefined();
    expect(queried).toBe(false);
  });

  test("returns undefined when there is no active swap (null pointer == cloud group box)", async () => {
    expect(
      await resolveActiveSandboxBackend(true, async () => null, selfhostedKind),
    ).toBeUndefined();
    expect(
      await resolveActiveSandboxBackend(
        true,
        async () => ({ activeSandboxId: null }),
        selfhostedKind,
      ),
    ).toBeUndefined();
  });

  test("returns undefined when the active swap target is itself a cloud (modal) box", async () => {
    // A swap to a sibling cloud box is still cloud — the clone hook stays enabled.
    expect(
      await resolveActiveSandboxBackend(true, selfhostedPointer, async () => "modal"),
    ).toBeUndefined();
  });

  test("never throws: a pointer-load failure falls back to the home backend default", async () => {
    const backend = await resolveActiveSandboxBackend(
      true,
      async () => {
        throw new Error("db unreachable");
      },
      selfhostedKind,
    );
    expect(backend).toBeUndefined();
  });

  test("never throws: a sandbox-kind-load failure falls back to the home backend default", async () => {
    const backend = await resolveActiveSandboxBackend(true, selfhostedPointer, async () => {
      throw new Error("db unreachable");
    });
    expect(backend).toBeUndefined();
  });

  test("reuse contract (Stage D hoist): pre-loaded pointer + record memoized closures are each read at most once", async () => {
    // The activity loads the active pointer + its sandbox row ONCE at turn start and
    // threads memoized closures into resolveActiveSandboxBackend, so the SAME values
    // also feed the machine-primary establish branch (enrollmentId/epoch/workingDir)
    // with no double read / no read-skew. This pins that single-read reuse contract:
    // the gate reads each pre-loaded value at most once and still resolves selfhosted.
    let pointerReads = 0;
    let kindReads = 0;
    const pointer = { activeSandboxId: "sbx_machine", activeEpoch: 3 };
    const backend = await resolveActiveSandboxBackend(
      true,
      async () => {
        pointerReads += 1;
        return pointer;
      },
      async () => {
        kindReads += 1;
        return "selfhosted";
      },
    );
    expect(backend).toBe("selfhosted");
    expect(pointerReads).toBe(1);
    expect(kindReads).toBe(1);
  });
});

describe("machine-primary sandbox ownership isolation", () => {
  test("establishes an attached Connected Machine even when the session has no home sandbox", () => {
    expect(shouldEstablishSandboxForTurn(true, "none", true)).toBe(true);
    expect(shouldEstablishSandboxForTurn(true, "none", false)).toBe(false);
  });

  test("does not acquire the managed-home lease for a Connected Machine turn", () => {
    expect(managedSandboxOwnershipForTurn(true, "attempt-1", "cloud-home-group")).toBeNull();
  });

  test("keeps managed sandbox turns on their exact attempt-derived holder", () => {
    expect(managedSandboxOwnershipForTurn(false, "attempt-1", "cloud-home-group")).toEqual({
      holderId: sandboxLeaseHolderIdForAttempt("attempt-1"),
      sandboxGroupId: "cloud-home-group",
    });
  });
});

describe("turn-start pointer reconcile classification (issue #341 invariant B)", () => {
  test("an absent sandbox row (deleted target) → stale_pointer", () => {
    expect(pointerReconcileReason(null)).toBe("stale_pointer");
  });

  test("a non-group Modal sibling → unsupported_backend_context (Shape 1)", () => {
    expect(pointerReconcileReason({ kind: "modal", enrollmentId: null })).toBe(
      "unsupported_backend_context",
    );
  });

  test("an unknown backend kind → unsupported_backend_context", () => {
    expect(pointerReconcileReason({ kind: "daytona", enrollmentId: null })).toBe(
      "unsupported_backend_context",
    );
  });

  test("a selfhosted sandbox with no enrollment id → offline_enrollment", () => {
    expect(pointerReconcileReason({ kind: "selfhosted", enrollmentId: null })).toBe(
      "offline_enrollment",
    );
  });

  test("an enrolled machine is LEFT IN PLACE (null) even if momentarily offline — never reconciled", () => {
    // The user's explicit machine target is not abandoned for a transient control-
    // plane blip; the machine may recover mid-turn and surfaces agent_offline lazily.
    expect(pointerReconcileReason({ kind: "selfhosted", enrollmentId: "enroll-1" })).toBeNull();
  });
});

describe("turn-time Modal private-registry warm", () => {
  test("warms the pack-resolved Modal image ref before sandbox creation", async () => {
    const packImage = "acr.example.com/cloudgeni/f4c-gecko@sha256:abc";
    const runSettings = settingsWithPackSandboxImage(
      testSettings({
        sandboxBackend: "modal",
        modalImageRef: undefined,
        modalImageRegistrySecret: "acr-credentials-gecko",
      }),
      packImage,
    );
    const ensureRegistryImage = mock(async (_settings: Settings) => undefined);

    await ensureTurnModalRegistryImage(runSettings, "modal", ensureRegistryImage);

    expect(ensureRegistryImage).toHaveBeenCalledTimes(1);
    expect(ensureRegistryImage.mock.calls[0]?.[0].modalImageRef).toBe(packImage);
    expect(ensureRegistryImage.mock.calls[0]?.[0].modalImageRegistrySecret).toBe(
      "acr-credentials-gecko",
    );
  });

  test("keeps non-modal or public-image turns on the no-op path", async () => {
    const ensureRegistryImage = mock(async (_settings: Settings) => undefined);
    await ensureTurnModalRegistryImage(
      testSettings({
        sandboxBackend: "docker",
        modalImageRef: "acr.example.com/cloudgeni/f4c-gecko@sha256:abc",
        modalImageRegistrySecret: "acr-credentials-gecko",
      }),
      "docker",
      ensureRegistryImage,
    );
    await ensureTurnModalRegistryImage(
      testSettings({
        sandboxBackend: "modal",
        modalImageRef: "ghcr.io/cloudgeni/public:latest",
        modalImageRegistrySecret: undefined,
      }),
      "modal",
      ensureRegistryImage,
    );
    await ensureTurnModalRegistryImage(
      testSettings({
        sandboxBackend: "modal",
        modalImageRef:
          "acr.example.com/[redacted:MODAL_PROFILE]/f4c-gecko@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        modalImageId: "im-1234567890123456789012",
        modalImageRegistrySecret: "acr-credentials-gecko",
      }),
      "modal",
      ensureRegistryImage,
    );
    expect(ensureRegistryImage).not.toHaveBeenCalled();
  });
});

describe("sandbox artifact runtime admission", () => {
  test("admits the configured Docker base image and injects only fixed image paths", () => {
    const settings = testSettings({
      sandboxBackend: "docker",
      dockerImage: "opengeni-sandbox:local-0123456789ab",
      sandboxArtifactRuntimeEnabled: true,
    });

    expect(sandboxArtifactRuntimeAdmission(settings, settings, "docker")).toEqual({
      available: true,
      environment: {
        OPENGENI_ARTIFACT_RUNTIME_MANIFEST: "/opt/opengeni/artifact-runtime/installation.json",
        OPENGENI_ARTIFACT_TOOL_ENTRY: "/opt/opengeni/artifact-runtime/skill-facade-entry.mjs",
      },
    });
  });

  test("admits exact digest-pinned production Docker and Modal base images", () => {
    const docker = testSettings({
      sandboxBackend: "docker",
      dockerImage: `ghcr.io/cloudgeni-ai/opengeni-sandbox@sha256:${"a".repeat(64)}`,
      sandboxArtifactRuntimeEnabled: true,
    });
    expect(
      sandboxArtifactRuntimeAdmission(docker, docker, "docker", { production: true }).available,
    ).toBe(true);

    const modal = testSettings({
      sandboxBackend: "modal",
      modalImageRef: `ghcr.io/cloudgeni-ai/opengeni-sandbox@sha256:${"b".repeat(64)}`,
      modalImageId: "im-1234567890123456789012",
      sandboxArtifactRuntimeEnabled: true,
    });
    expect(
      sandboxArtifactRuntimeAdmission(modal, modal, "modal", { production: true }).available,
    ).toBe(true);
  });

  test("fails closed for disabled, custom-image, missing-Modal-image, and machine turns", () => {
    const disabled = testSettings({
      sandboxBackend: "docker",
      sandboxArtifactRuntimeEnabled: false,
    });
    expect(sandboxArtifactRuntimeAdmission(disabled, disabled, "docker").available).toBe(false);

    const modal = testSettings({
      sandboxBackend: "modal",
      modalImageRef: `ghcr.io/cloudgeni-ai/opengeni-sandbox@sha256:${"a".repeat(64)}`,
      sandboxArtifactRuntimeEnabled: true,
    });
    const custom = {
      ...modal,
      modalImageRef: `ghcr.io/example/custom-sandbox@sha256:${"b".repeat(64)}`,
    };
    expect(sandboxArtifactRuntimeAdmission(modal, custom, "modal").available).toBe(false);
    expect(
      sandboxArtifactRuntimeAdmission(
        { ...modal, modalImageRef: undefined },
        { ...modal, modalImageRef: undefined },
        "modal",
      ).available,
    ).toBe(false);
    expect(sandboxArtifactRuntimeAdmission(modal, modal, "selfhosted").available).toBe(false);

    const mutableProduction = testSettings({
      sandboxBackend: "docker",
      dockerImage: "opengeni-sandbox:local-0123456789ab",
      sandboxArtifactRuntimeEnabled: true,
    });
    expect(
      sandboxArtifactRuntimeAdmission(mutableProduction, mutableProduction, "docker", {
        production: true,
      }).available,
    ).toBe(false);
  });
});

describe("lazy sandbox provisioner single-flight", () => {
  test("closes logical provision before fallible post-establish setup", async () => {
    const order: string[] = [];
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        order.push("box-established");
        return "ready";
      },
      {
        beforeCompleted: async (_result, settlement) => {
          order.push(`provision-completed:${settlement.internalAttempts}`);
          await Promise.resolve();
          order.push("rig-and-repository-setup");
        },
        onCompleted: () => {
          order.push("operation-released");
        },
      },
    );

    await expect(provisioner.get()).resolves.toBe("ready");
    expect(order).toEqual([
      "box-established",
      "provision-completed:1",
      "rig-and-repository-setup",
      "operation-released",
    ]);
  });

  test("durably starts model preparation before native runStream and binds generic dispatch to fetch", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();
    const runStreamOnceAt = source.indexOf("const runStreamOnce = async");
    const modelPreparationStartedAt = source.indexOf(
      'type: "turn.startup.phase.started"',
      runStreamOnceAt,
    );
    const runtimeRunStreamAt = source.indexOf("return await runtime.runStream(", runStreamOnceAt);
    const codexLeaseAssertionAt = source.indexOf("leases.codex.assertUsable()", runStreamOnceAt);
    const providerInvocationAt = source.indexOf(
      "eventing.stream = await withProviderRequestContext(runStreamOnce)",
      runStreamOnceAt,
    );
    const genericWireHookAt = source.indexOf(
      "onModelTransportStarted: recordFallbackProviderDispatchAtWire",
      runtimeRunStreamAt,
    );

    expect(runStreamOnceAt).toBeGreaterThan(-1);
    expect(modelPreparationStartedAt).toBeGreaterThan(runStreamOnceAt);
    expect(codexLeaseAssertionAt).toBeGreaterThan(runStreamOnceAt);
    expect(codexLeaseAssertionAt).toBeLessThan(providerInvocationAt);
    expect(runtimeRunStreamAt).toBeGreaterThan(modelPreparationStartedAt);
    expect(genericWireHookAt).toBeGreaterThan(runtimeRunStreamAt);
  });

  test("file materialization metrics fail when any download fails softly", () => {
    expect(sandboxFileMaterializationOutcome([])).toBe("completed");
    expect(
      sandboxFileMaterializationOutcome([
        {
          fileId: "file-1",
          filename: "input.pdf",
          path: "/workspace/input.pdf",
          reason: "provider returned unavailable",
        },
      ]),
    ).toBe("failed");
  });

  test("establish policy reports the first bounded eager reason", () => {
    const base = {
      lazyEnabled: true,
      machinePrimary: false,
      sandboxBackend: "docker" as const,
      hasRunCredentialResolver: false,
      generatedVideoFileCount: 0,
      hasSignedFileResources: false,
    };

    expect(sandboxEstablishPolicyDecision(base)).toEqual({
      policy: "on-demand",
      reason: "eligible",
    });
    expect(sandboxEstablishPolicyDecision({ ...base, lazyEnabled: false })).toEqual({
      policy: "eager",
      reason: "lazy_disabled",
    });
    expect(sandboxEstablishPolicyDecision({ ...base, machinePrimary: true })).toEqual({
      policy: "eager",
      reason: "machine_primary",
    });
    expect(sandboxEstablishPolicyDecision({ ...base, sandboxBackend: "none" })).toEqual({
      policy: "eager",
      reason: "backend_none",
    });
    expect(sandboxEstablishPolicyDecision({ ...base, hasRunCredentialResolver: true })).toEqual({
      policy: "on-demand",
      reason: "initial_run_credentials_deferred",
    });
    expect(sandboxEstablishPolicyDecision({ ...base, generatedVideoFileCount: 1 })).toEqual({
      policy: "eager",
      reason: "generated_video_files",
    });
    expect(sandboxEstablishPolicyDecision({ ...base, hasSignedFileResources: true })).toEqual({
      policy: "eager",
      reason: "signed_file_resources",
    });
    expect(
      sandboxEstablishPolicyDecision({
        ...base,
        hasRunCredentialResolver: true,
        generatedVideoFileCount: 1,
      }),
    ).toEqual({ policy: "eager", reason: "generated_video_files" });
    expect(
      sandboxEstablishPolicyDecision({
        ...base,
        hasRunCredentialResolver: true,
        hasSignedFileResources: true,
      }),
    ).toEqual({ policy: "eager", reason: "signed_file_resources" });
  });

  test("managed-box prefetch is only for on-demand repository turns", () => {
    const base = {
      establishPolicy: "on-demand" as const,
      machinePrimary: false,
      groupBoxBackend: "modal" as const,
      hasRepositoryResources: true,
    };

    expect(shouldPrefetchManagedSandbox(base)).toBe(true);
    expect(shouldPrefetchManagedSandbox({ ...base, groupBoxBackend: "docker" })).toBe(true);
    expect(shouldPrefetchManagedSandbox({ ...base, establishPolicy: "eager" })).toBe(false);
    expect(shouldPrefetchManagedSandbox({ ...base, machinePrimary: true })).toBe(false);
    expect(shouldPrefetchManagedSandbox({ ...base, groupBoxBackend: "none" })).toBe(false);
    expect(shouldPrefetchManagedSandbox({ ...base, groupBoxBackend: "selfhosted" })).toBe(false);
    expect(shouldPrefetchManagedSandbox({ ...base, hasRepositoryResources: false })).toBe(false);
  });

  test("credential-bearing lazy turns resolve context once and materialize at the first shared operation", async () => {
    const steps: string[] = [];
    let resolves = 0;
    let materializations = 0;
    const initialMaterial = await (async () => {
      resolves += 1;
      steps.push("credential-resolved");
      return { available: true };
    })();
    const provisioner = createTurnSandboxProvisioner(async () => {
      await Bun.sleep(5);
      if (initialMaterial.available) {
        materializations += 1;
        steps.push("credential-materialized");
      }
      return {
        exec: async () => {
          steps.push("provider-operation");
        },
      };
    });

    // Model preparation resolves the exact attempt once so auth-needed state
    // can be model-visible, but a model-only turn still owns no sandbox write,
    // renewal loop, lease, box, or exact-generation cleanup.
    expect(resolves).toBe(1);
    expect(materializations).toBe(0);
    expect(steps).toEqual(["credential-resolved"]);

    const boxes = await Promise.all(Array.from({ length: 8 }, () => provisioner.get()));
    await boxes[0]!.exec();

    expect(resolves).toBe(1);
    expect(materializations).toBe(1);
    expect(steps).toEqual(["credential-resolved", "credential-materialized", "provider-operation"]);
  });

  test("activity prepares credential model context before turn input and reuses it lazily", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/run.ts", import.meta.url),
    ).text();
    const credentialSource = await Bun.file(
      new URL("../src/activities/agent-turn/run-credentials.ts", import.meta.url),
    ).text();
    const streamSource = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();
    const establishSource = await Bun.file(
      new URL("../src/activities/agent-turn/sandbox-establish.ts", import.meta.url),
    ).text();
    const resolutionAt = credentialSource.indexOf(
      "const initialRunCredentialMaterial = runCredentialResolver",
    );
    const modelNoteAt = credentialSource.indexOf(
      "const runCredentialsNote = initialRunCredentialMaterial",
      resolutionAt,
    );
    const credentialsCallAt = source.indexOf("const runCredentials = await prepareRunCredentials(");
    const streamCallAt = source.indexOf("return await runTurnStreamAttempt(", credentialsCallAt);
    const turnInputAt = streamSource.indexOf("const prepared = await turnInput(");
    const provisionerAt = establishSource.indexOf(
      "sandboxState.turnSandboxProvisioner = createTurnSandboxProvisioner<ResumedTurnSandbox>",
    );
    const lazyCredentialAttachAt = establishSource.indexOf(
      "await attachRunCredentialRenewal(",
      provisionerAt,
    );
    const lazyProvisionerPrefix = establishSource.slice(
      provisionerAt,
      lazyCredentialAttachAt + 500,
    );
    const lazyBindAt = source.indexOf("await bindLazySandboxProvisioner(", credentialsCallAt);

    expect(resolutionAt).toBeGreaterThan(-1);
    expect(modelNoteAt).toBeGreaterThan(resolutionAt);
    expect(credentialsCallAt).toBeGreaterThan(-1);
    expect(streamCallAt).toBeGreaterThan(credentialsCallAt);
    expect(turnInputAt).toBeGreaterThan(-1);
    expect(provisionerAt).toBeGreaterThan(-1);
    expect(lazyBindAt).toBeGreaterThan(credentialsCallAt);
    expect(streamCallAt).toBeGreaterThan(lazyBindAt);
    expect(lazyCredentialAttachAt).toBeGreaterThan(provisionerAt);
    expect(lazyProvisionerPrefix).not.toContain("runCredentialResolver.resolve(");
    expect(lazyProvisionerPrefix).toContain("initialRunCredentialMaterial");
  });

  test("runtime preparation overlaps independent workspace reads after the personal-resource fence", async () => {
    const governanceSource = await Bun.file(
      new URL("../src/activities/agent-turn/governance-model.ts", import.meta.url),
    ).text();
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/run.ts", import.meta.url),
    ).text();
    const credentialsSource = await Bun.file(
      new URL("../src/activities/agent-turn/run-credentials.ts", import.meta.url),
    ).text();
    const authorize = governanceSource.indexOf("await resolveSessionAttemptPersonalResources(db");
    const overlappedReads = governanceSource.indexOf(
      "Independent workspace reads after the personal-resource fence",
      authorize,
    );
    const packRead = governanceSource.indexOf(
      "resolveWorkspacePackRuntime(db, input.workspaceId)",
      overlappedReads,
    );
    const rigRead = governanceSource.indexOf(
      "await materializeRigVersionForAttempt(db",
      overlappedReads,
    );
    const policyRead = governanceSource.indexOf(
      "getWorkspaceModelPolicy(db, input.workspaceId)",
      overlappedReads,
    );
    const governanceCall = source.indexOf("const governance = await prepareGovernanceAndModel({");
    const credentialsCall = source.indexOf(
      "const runCredentials = await prepareRunCredentials(",
      governanceCall,
    );
    const imageEnsure = credentialsSource.indexOf(
      "ensureTurnModalRegistryImage(runSettings, sandboxCreationBackend)",
    );
    const gitAssert = credentialsSource.indexOf("assertGitHubResourcesRemainAuthorized(");
    expect(authorize).toBeGreaterThan(0);
    expect(overlappedReads).toBeGreaterThan(authorize);
    expect(packRead).toBeGreaterThan(overlappedReads);
    expect(rigRead).toBeGreaterThan(packRead);
    expect(policyRead).toBeGreaterThan(rigRead);
    expect(governanceCall).toBeGreaterThan(-1);
    expect(credentialsCall).toBeGreaterThan(governanceCall);
    expect(imageEnsure).toBeGreaterThan(-1);
    expect(gitAssert).toBeGreaterThan(imageEnsure);
    expect(credentialsSource.slice(imageEnsure - 80, gitAssert)).toContain("Promise.all");
  });

  test("lazy git token mint starts before the box establish returns", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/sandbox-establish.ts", import.meta.url),
    ).text();
    const provisionerAt = source.indexOf(
      "sandboxState.turnSandboxProvisioner = createTurnSandboxProvisioner<ResumedTurnSandbox>",
    );
    const resumeAt = source.indexOf(
      "const provisioned = await (sandboxState.prefetchedManagedBox ??",
      provisionerAt,
    );
    const mintStartAt = source.lastIndexOf("startRunGitCredentialsMint();", resumeAt);
    const mintAwaitAt = source.indexOf("await startRunGitCredentialsMint()", resumeAt);
    expect(provisionerAt).toBeGreaterThan(-1);
    expect(resumeAt).toBeGreaterThan(provisionerAt);
    expect(mintStartAt).toBeGreaterThan(provisionerAt);
    expect(mintStartAt).toBeLessThan(resumeAt);
    expect(mintAwaitAt).toBeGreaterThan(resumeAt);
  });

  test("repository on-demand turns prefetch managed-box create before tools", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/run.ts", import.meta.url),
    ).text();
    const establishSource = await Bun.file(
      new URL("../src/activities/agent-turn/sandbox-establish.ts", import.meta.url),
    ).text();
    const onDemandAt = establishSource.indexOf('} else if (establishPolicy === "on-demand")');
    const prefetchAt = establishSource.indexOf("shouldPrefetchManagedSandbox({", onDemandAt);
    const establishCallAt = source.indexOf("await establishTurnSandbox({");
    const toolsCallAt = source.indexOf(
      "const toolRuntime = await prepareTurnToolRuntime(",
      establishCallAt,
    );
    const lazyBindAt = source.indexOf("await bindLazySandboxProvisioner(", toolsCallAt);
    const toolsSource = await Bun.file(
      new URL("../src/activities/agent-turn/tool-environment.ts", import.meta.url),
    ).text();
    const toolsAt = toolsSource.indexOf('phase: "tools"');
    const provisionerAt = establishSource.indexOf(
      "sandboxState.turnSandboxProvisioner = createTurnSandboxProvisioner<ResumedTurnSandbox>",
    );
    const joinAt = establishSource.indexOf(
      "const provisioned = await (sandboxState.prefetchedManagedBox ??",
      provisionerAt,
    );
    const prefetchMintAt = establishSource.indexOf("startRunGitCredentialsMint();", prefetchAt);
    const prefetchResumeAt = establishSource.indexOf(
      "sandboxState.resumeManagedGroupBox()",
      prefetchMintAt,
    );

    expect(onDemandAt).toBeGreaterThan(-1);
    expect(prefetchAt).toBeGreaterThan(onDemandAt);
    expect(establishCallAt).toBeGreaterThan(-1);
    expect(toolsCallAt).toBeGreaterThan(establishCallAt);
    expect(lazyBindAt).toBeGreaterThan(toolsCallAt);
    expect(toolsAt).toBeGreaterThan(-1);
    expect(provisionerAt).toBeGreaterThan(-1);
    expect(joinAt).toBeGreaterThan(provisionerAt);
    expect(prefetchMintAt).toBeGreaterThan(prefetchAt);
    expect(prefetchMintAt).toBeLessThan(prefetchResumeAt);
    // The whole establish phase runs before tool preparation, so the on-demand
    // branch must not await the managed box anywhere before the lazy binder.
    const lazyBinderDefinitionAt = establishSource.indexOf(
      "export async function bindLazySandboxProvisioner(",
    );
    expect(lazyBinderDefinitionAt).toBeGreaterThan(onDemandAt);
    const onDemandEstablishBody = establishSource.slice(onDemandAt, lazyBinderDefinitionAt);
    expect(onDemandEstablishBody).not.toContain("await sandboxState.resumeManagedGroupBox()");
    expect(onDemandEstablishBody).not.toContain("await resumeBoxForTurn(");
    expect(establishSource).toContain(
      "onSandboxLost: publishSandboxLost,\n                objectStorage,",
    );
  });

  test("personal-connection membership uses named live-authority, not a bare grant join", async () => {
    const toolsSource = await Bun.file(
      new URL("../src/activities/agent-turn/tool-environment.ts", import.meta.url),
    ).text();
    expect(toolsSource).toContain("namedSubjectHasLiveWorkspaceAuthority");
    expect(toolsSource).not.toContain("getWorkspaceGrant");
    expect(toolsSource).toMatch(
      /resolveGoogleDrivePublicationTarget\(\s*db,\s*\{\s*accountId: input\.accountId,\s*workspaceId: input\.workspaceId\s*\}/,
    );
  });

  test("lazy tool readiness installs its rejection handler before publishing the promise", async () => {
    const toolsSource = await Bun.file(
      new URL("../src/activities/agent-turn/tool-environment.ts", import.meta.url),
    ).text();
    const readinessAt = toolsSource.indexOf(
      "const toolPreparationReady = eventing.preparedTools.ready.then",
    );
    const handledAt = toolsSource.indexOf(
      "void toolPreparationReady.catch(() => undefined)",
      readinessAt,
    );
    const publishedAt = toolsSource.indexOf(
      "eventing.toolPreparationReady = toolPreparationReady",
      handledAt,
    );

    expect(readinessAt).toBeGreaterThan(-1);
    expect(handledAt).toBeGreaterThan(readinessAt);
    expect(publishedAt).toBeGreaterThan(handledAt);
  });

  test("deadline rotation uses only short anti-churn pacing", () => {
    expect(
      sandboxDeadlineRotationRecoveryDelayMs({
        sandboxLeaseReaperPeriodMs: 30_000,
      }),
    ).toBe(5_000);
  });

  test("concurrent callers share one establish promise", async () => {
    let establishes = 0;
    const provisioner = createTurnSandboxProvisioner(async () => {
      establishes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, attempt: establishes };
    });

    const results = await Promise.all(Array.from({ length: 12 }, () => provisioner.get()));

    expect(establishes).toBe(1);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(results[0]).toEqual({ ok: true, attempt: 1 });
  });

  test("terminal failure rejects all waiters once and remains memoized for the turn", async () => {
    let establishes = 0;
    let failures = 0;
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        establishes += 1;
        throw new SandboxImageConflictError("group-1", "old", "new");
      },
      {
        onFailed: () => {
          failures += 1;
        },
      },
    );

    const first = await Promise.allSettled(Array.from({ length: 5 }, () => provisioner.get()));
    expect(first.every((result) => result.status === "rejected")).toBe(true);
    expect(establishes).toBe(1);
    expect(failures).toBe(1);

    await expect(provisioner.get()).rejects.toThrow(SandboxImageConflictError);
    expect(establishes).toBe(1);
    expect(failures).toBe(1);
  });

  test("exhausted retryable failure releases the memo for a later operation", async () => {
    let establishes = 0;
    let failures = 0;
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        establishes += 1;
        throw new SandboxLeaseSupersededError("group-1", establishes);
      },
      {
        maxRetries: 0,
        onFailed: () => {
          failures += 1;
        },
      },
    );

    await expect(provisioner.get()).rejects.toThrow(SandboxLeaseSupersededError);
    await expect(provisioner.get()).rejects.toThrow(SandboxLeaseSupersededError);
    expect(establishes).toBe(2);
    expect(failures).toBe(2);
  });

  test("transient supersession retries inside the single-flight", async () => {
    let establishes = 0;
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        establishes += 1;
        if (establishes === 1) {
          throw new SandboxLeaseSupersededError("group-1", 7);
        }
        return "ready";
      },
      { backoffMs: 1 },
    );

    await expect(provisioner.get()).resolves.toBe("ready");
    expect(establishes).toBe(2);
  });

  test("command-readiness timeout creates at most one sandbox for the turn", async () => {
    let establishes = 0;
    let failures = 0;
    const timeout = new SandboxExecReadinessTimeoutError("modal", 60_000, {
      sandboxGroupId: "group-1",
      instanceId: "sb-1",
    });
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        establishes += 1;
        throw timeout;
      },
      {
        onFailed: () => {
          failures += 1;
        },
      },
    );

    const first = await Promise.allSettled(Array.from({ length: 5 }, () => provisioner.get()));
    expect(first.every((result) => result.status === "rejected")).toBe(true);
    await expect(provisioner.get()).rejects.toBe(timeout);
    expect(establishes).toBe(1);
    expect(failures).toBe(1);
    expect(isLazySandboxProvisionRetryable(timeout)).toBe(false);
  });

  test("image conflict is actionable and not retried", async () => {
    expect(
      isLazySandboxProvisionRetryable(new SandboxImageConflictError("group-1", "old", "new")),
    ).toBe(false);
    expect(
      isLazySandboxProvisionRetryable(
        new SandboxLeaseRecoveryBlockedError(
          "group-1",
          1,
          "restore_degraded",
          {} as ConstructorParameters<typeof SandboxLeaseRecoveryBlockedError>[3],
        ),
      ),
    ).toBe(false);
    expect(isLazySandboxProvisionRetryable(new SandboxLeaseSupersededError("group-1", 1))).toBe(
      true,
    );
    expect(
      isLazySandboxProvisionRetryable(
        new SandboxLeaseTransitionError(
          "group-1",
          1,
          "capture_in_progress",
          "modal",
          "sb-1",
          "draining",
        ),
      ),
    ).toBe(true);
    expect(
      isLazySandboxProvisionRetryable(
        new WorkspaceArchiveIntegrityError(
          "workspace_fingerprint_unavailable",
          "fingerprint unavailable",
          { retryable: true, cause: Object.assign(new Error("transport"), { code: "EAI_AGAIN" }) },
        ),
      ),
    ).toBe(true);
    expect(
      isLazySandboxProvisionRetryable(
        new WorkspaceArchiveIntegrityError(
          "workspace_fingerprint_mismatch",
          "fingerprint mismatch",
        ),
      ),
    ).toBe(false);
    expect(isLazySandboxProvisionRetryable(new Error("ECONNRESET during sandbox create"))).toBe(
      false,
    );
  });

  test("classifies the closed logical provision failure taxonomy from typed structure", () => {
    expect(
      classifySandboxLogicalProvisionFailure(
        "modal",
        new SandboxExecReadinessTimeoutError("modal", 60_000, {
          sandboxGroupId: "group-1",
          instanceId: "sb-1",
        }),
      ),
    ).toMatchObject({
      category: "exec_readiness",
      stage: "exec_readiness",
      code: "sandbox_exec_readiness_timeout",
    });
    expect(
      classifySandboxLogicalProvisionFailure(
        "modal",
        new SandboxExecReadinessError("modal", "exec_probe_failed", 60_000, 1, "sb-1"),
      ),
    ).toMatchObject({ category: "exec_readiness", code: "exec_probe_failed" });
    expect(
      classifySandboxLogicalProvisionFailure(
        "modal",
        new SandboxSiblingWarmingTimeoutError("modal", 600_000, {
          sandboxGroupId: "group-1",
        }),
      ),
    ).toMatchObject({ category: "sibling_warming", stage: "sibling_warming" });
    expect(
      classifySandboxLogicalProvisionFailure(
        "modal",
        new SandboxLeaseSupersededError("group-1", 4),
      ),
    ).toMatchObject({
      category: "lease_superseded",
      stage: "lease_admission",
      expected: true,
      retryable: true,
    });
    expect(
      classifySandboxLogicalProvisionFailure(
        "modal",
        new SandboxLeaseTransitionError(
          "group-1",
          4,
          "capture_in_progress",
          "modal",
          "sb-1",
          "draining",
        ),
      ),
    ).toMatchObject({
      category: "drain_capture_wait",
      stage: "lifecycle_wait",
      code: "capture_in_progress",
      expected: true,
    });
    expect(
      classifySandboxLogicalProvisionFailure(
        "modal",
        new WorkspaceArchiveIntegrityError("archive_hydration_failed", "archive restore rejected"),
      ),
    ).toMatchObject({
      category: "archive_recovery",
      stage: "archive_recovery",
      code: "archive_hydration_failed",
    });
    expect(
      classifySandboxLogicalProvisionFailure(
        "modal",
        new SandboxProvisionStageError("create", new SandboxConfigError("modal", "missing token")),
      ),
    ).toMatchObject({ category: "configuration", stage: "create", code: "sandbox_config" });

    const transport = Object.assign(new Error("provider request failed"), {
      code: "ENOTFOUND",
    });
    expect(
      classifySandboxLogicalProvisionFailure(
        "modal",
        new SandboxProvisionStageError("resume", transport),
      ),
    ).toMatchObject({
      category: "provider_transport",
      stage: "resume",
      code: "code=ENOTFOUND",
      retryable: false,
    });
    expect(
      classifySandboxLogicalProvisionFailure(
        "modal",
        new SandboxProvisionStageError("create", new Error("typed boundary without subtype")),
      ),
    ).toMatchObject({ category: "create", stage: "create", code: "create_failed" });
    expect(
      classifySandboxLogicalProvisionFailure("modal", new Error("unstructured failure")),
    ).toMatchObject({ category: "unknown", stage: "unknown", code: "unknown" });
  });

  test("one logical correlation records internal retries separately from its terminal result", async () => {
    let establishes = 0;
    const attempts: Array<{ provisionId: string; attempt: number; outcome: string }> = [];
    const completed: Array<{ provisionId: string; internalAttempts: number }> = [];
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        establishes += 1;
        if (establishes === 1) {
          throw new SandboxLeaseSupersededError("group-1", 2);
        }
        return "ready";
      },
      {
        backoffMs: 1,
        provisionIdFactory: () => "11111111-1111-4111-8111-111111111111",
        onAttemptSettled: ({ provisionId, attempt, outcome }) => {
          attempts.push({ provisionId, attempt, outcome });
        },
        onCompleted: (_result, settlement) => {
          completed.push(settlement);
        },
      },
    );

    await expect(provisioner.get()).resolves.toBe("ready");
    expect(attempts).toEqual([
      {
        provisionId: "11111111-1111-4111-8111-111111111111",
        attempt: 1,
        outcome: "retrying",
      },
      {
        provisionId: "11111111-1111-4111-8111-111111111111",
        attempt: 2,
        outcome: "completed",
      },
    ]);
    expect(completed).toEqual([
      {
        provisionId: "11111111-1111-4111-8111-111111111111",
        internalAttempts: 2,
        durationMs: expect.any(Number),
      },
    ]);
  });

  test("fallible pre-terminal completion work records only the failed logical outcome", async () => {
    let establishes = 0;
    let disposed = 0;
    const terminal: string[] = [];
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        establishes += 1;
        return "ready";
      },
      {
        provisionIdFactory: () => "11111111-1111-4111-8111-111111111111",
        beforeCompleted: () => {
          throw new Error("generated image materialization failed");
        },
        onCompleted: () => {
          terminal.push("completed");
        },
        onFailed: (_error, settlement) => {
          terminal.push(`failed:${settlement.provisionId}`);
        },
        disposeResult: () => {
          disposed += 1;
        },
      },
    );

    await expect(provisioner.get()).rejects.toThrow("generated image materialization failed");
    await expect(provisioner.get()).rejects.toThrow("generated image materialization failed");
    expect(establishes).toBe(1);
    expect(disposed).toBe(1);
    expect(terminal).toEqual(["failed:11111111-1111-4111-8111-111111111111"]);
  });

  test("cancellation during pre-terminal completion emits no terminal outcome", async () => {
    const controller = new AbortController();
    let establishes = 0;
    let completed = 0;
    let failed = 0;
    let disposed = 0;
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        establishes += 1;
        return "ready";
      },
      {
        signal: controller.signal,
        beforeCompleted: () => {
          controller.abort(new Error("STEER"));
        },
        onCompleted: () => {
          completed += 1;
        },
        onFailed: () => {
          failed += 1;
        },
        disposeResult: () => {
          disposed += 1;
        },
      },
    );

    await expect(provisioner.get()).rejects.toBeInstanceOf(TurnOperationCancelledError);
    expect(establishes).toBe(1);
    expect(disposed).toBe(1);
    expect(completed).toBe(0);
    expect(failed).toBe(0);
  });

  test("an exhausted expected transition settles one logical id before a later re-read", async () => {
    let sequence = 0;
    const failures: Array<{ provisionId: string; internalAttempts: number }> = [];
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        throw new SandboxLeaseTransitionError(
          "group-1",
          3,
          "provider_recovery_in_progress",
          "modal",
          "sb-1",
          "draining",
        );
      },
      {
        maxRetries: 0,
        provisionIdFactory: () => `provision-${++sequence}`,
        onFailed: (_error, settlement) => failures.push(settlement),
      },
    );

    await expect(provisioner.get()).rejects.toThrow(SandboxLeaseTransitionError);
    await expect(provisioner.get()).rejects.toThrow(SandboxLeaseTransitionError);
    expect(failures).toEqual([
      { provisionId: "provision-1", internalAttempts: 1, durationMs: expect.any(Number) },
      { provisionId: "provision-2", internalAttempts: 1, durationMs: expect.any(Number) },
    ]);
  });

  test("Steer/Pause cancels a pending provision immediately and disposes its late lease", async () => {
    const controller = new AbortController();
    let resolveEstablish!: (value: { lease: string }) => void;
    const establish = new Promise<{ lease: string }>((resolve) => {
      resolveEstablish = resolve;
    });
    let completed = 0;
    let failed = 0;
    let disposed = 0;
    let resolveDisposed!: () => void;
    const disposal = new Promise<void>((resolve) => {
      resolveDisposed = resolve;
    });
    const provisioner = createTurnSandboxProvisioner(() => establish, {
      signal: controller.signal,
      onCompleted: () => {
        completed += 1;
      },
      onFailed: () => {
        failed += 1;
      },
      disposeResult: () => {
        disposed += 1;
        resolveDisposed();
      },
    });

    const pending = provisioner.get();
    await Bun.sleep(0);
    const cancelledAt = performance.now();
    controller.abort(new Error("STEER"));

    await expect(pending).rejects.toBeInstanceOf(TurnOperationCancelledError);
    expect(performance.now() - cancelledAt).toBeLessThan(100);
    expect(await provisioner.waitForSettled(30_000)).toBeNull();
    expect(completed).toBe(0);
    expect(failed).toBe(0);

    resolveEstablish({ lease: "late" });
    await disposal;
    expect(disposed).toBe(1);
  });

  test("eager provisioning returns at the cancellation boundary and disposes its late lease", async () => {
    const controller = new AbortController();
    let resolveEstablish!: (value: { release: () => void }) => void;
    const establish = new Promise<{ release: () => void }>((resolve) => {
      resolveEstablish = resolve;
    });
    let releases = 0;
    const pending = waitForTurnOperation(establish, controller.signal, async (late) =>
      late.release(),
    );

    const temporalCancellation = new CancelledFailure("CANCELLED");
    const cancelledAt = performance.now();
    controller.abort(temporalCancellation);

    const wrapped = await pending.catch((error: unknown) => error);
    expect(wrapped).toBeInstanceOf(TurnOperationCancelledError);
    expect(turnOperationCancellationFailure(wrapped)).toBe(temporalCancellation);
    expect(performance.now() - cancelledAt).toBeLessThan(100);

    resolveEstablish({ release: () => (releases += 1) });
    await Bun.sleep(0);
    expect(releases).toBe(1);
  });

  test("a non-Temporal provisioning abort still becomes an activity cancellation", () => {
    const wrapped = new TurnOperationCancelledError(new Error("STEER"));
    const cancellation = turnOperationCancellationFailure(wrapped);

    expect(cancellation).toBeInstanceOf(CancelledFailure);
    expect(cancellation?.message).toBe("TURN_SANDBOX_PROVISION_CANCELLED");
    expect(turnOperationCancellationFailure(new Error("provider failed"))).toBeNull();
  });

  test("a committed control outranks a same-checkpoint provider failure", async () => {
    const controller = new AbortController();
    const temporalCancellation = new CancelledFailure("CANCELLED");
    controller.abort(temporalCancellation);

    const error = await waitForTurnOperation(
      Promise.reject(new Error("provider connection reset")),
      controller.signal,
      undefined,
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(TurnOperationCancelledError);
    expect(turnOperationCancellationFailure(error)).toBe(temporalCancellation);
  });
});

describe("worker shutdown preemption", () => {
  test("classifies only WORKER_SHUTDOWN cancellations as graceful preemption", () => {
    expect(isWorkerShutdownCancellation(new CancelledFailure("WORKER_SHUTDOWN"))).toBe(true);
    // Workflow-requested Pause/Steer cancellation keeps its control path.
    expect(isWorkerShutdownCancellation(new CancelledFailure("CANCELLED"))).toBe(false);
    // Server-side heartbeat timeout after a hard kill must stay terminal.
    expect(isWorkerShutdownCancellation(new CancelledFailure("TIMED_OUT"))).toBe(false);
    expect(isWorkerShutdownCancellation(new Error("WORKER_SHUTDOWN"))).toBe(false);
    expect(isWorkerShutdownCancellation(undefined)).toBe(false);
  });

  test("skips slow workspace housekeeping for every physical cancellation boundary", () => {
    expect(
      shouldRunTurnEndWorkspacePersistence({
        activityStatus: "cancelled",
        cancellationRequested: false,
      }),
    ).toBe(false);
    expect(
      shouldRunTurnEndWorkspacePersistence({
        activityStatus: "recovering",
        cancellationRequested: true,
      }),
    ).toBe(false);
    expect(
      shouldRunTurnEndWorkspacePersistence({
        activityStatus: "idle",
        cancellationRequested: false,
      }),
    ).toBe(true);
    expect(
      shouldRunTurnEndWorkspacePersistence({
        activityStatus: "recovering",
        cancellationRequested: false,
        deadlineRotationRequested: true,
      }),
    ).toBe(false);
  });

  test("provider-deadline rotation preempts immediately without waiting for a snapshot", async () => {
    const controller = new AbortController();
    const sandboxState = { deadlineRotationRequested: false };

    expect(
      preemptSandboxTurnForDeadlineRotation({
        controller,
        sandboxState,
        sandboxGroupId: "group-deadline",
        leaseEpoch: 17,
      }),
    ).toBe(true);
    expect(sandboxState.deadlineRotationRequested).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({
      name: "SandboxDeadlineRotationError",
      sandboxGroupId: "group-deadline",
      leaseEpoch: 17,
    });

    const runtimeSource = await Bun.file(
      new URL("../src/activities/agent-turn/sandbox-runtime.ts", import.meta.url),
    ).text();
    const rotationStart = runtimeSource.indexOf("const beginRotationPreemption");
    const rotationEnd = runtimeSource.indexOf("const startLeaseHeartbeat", rotationStart);
    const rotationSource = runtimeSource.slice(rotationStart, rotationEnd);
    expect(rotationSource).toContain("preemptSandboxTurnForDeadlineRotation");
    expect(rotationSource.indexOf("stopLeaseHeartbeat();")).toBeLessThan(
      rotationSource.indexOf("preemptSandboxTurnForDeadlineRotation"),
    );
    expect(rotationSource).not.toContain("snapshotInFlight");
    expect(rotationSource).not.toContain("persistSandboxDeadlineRotationCheckpoint");
  });

  test("joins a periodic provider capture before every proof-bearing holder release", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/finalization.ts", import.meta.url),
    ).text();
    const finalReleaseStart = source.lastIndexOf("} finally {");
    const finalReleaseSource = source.slice(finalReleaseStart);
    const stopHeartbeatAt = finalReleaseSource.indexOf("stopLeaseHeartbeat();");
    const rotationJoinAt = finalReleaseSource.indexOf("rotationPreemptionInFlight.catch");
    const snapshotJoinAt = finalReleaseSource.indexOf("await drainInFlightWarmSnapshot();");
    const proofReleaseAt = finalReleaseSource.indexOf("releaseTurnSandboxAfterWriterDrain");

    expect(stopHeartbeatAt).toBeGreaterThan(-1);
    expect(rotationJoinAt).toBeGreaterThan(stopHeartbeatAt);
    expect(snapshotJoinAt).toBeGreaterThan(rotationJoinAt);
    expect(proofReleaseAt).toBeGreaterThan(snapshotJoinAt);
  });

  test("turns an unconfirmed physical tool fence into a hard failure", () => {
    const fenceFailure = new Error("remote process identity could not be verified");
    expect(() =>
      assertPhysicalToolQuiescenceForCancellation({
        acknowledgeQuiescence: true,
        physicalToolQuiescenceConfirmed: false,
        failure: fenceFailure,
      }),
    ).toThrow(fenceFailure);
    expect(() =>
      assertPhysicalToolQuiescenceForCancellation({
        acknowledgeQuiescence: true,
        physicalToolQuiescenceConfirmed: true,
        failure: fenceFailure,
      }),
    ).not.toThrow();
    expect(() =>
      assertPhysicalToolQuiescenceForCancellation({
        acknowledgeQuiescence: false,
        physicalToolQuiescenceConfirmed: false,
        failure: fenceFailure,
      }),
    ).not.toThrow();
  });

  test("requires a durable receipt or exact proof after the physical fence", () => {
    const persistenceFailure = new Error("receipt and proof delivery failed");
    expect(() =>
      assertSessionAttemptQuiescenceRecoveryDurable({
        acknowledgeQuiescence: true,
        physicalToolQuiescenceConfirmed: true,
        receiptOrProofDurable: false,
        failure: persistenceFailure,
      }),
    ).toThrow(persistenceFailure);
    expect(() =>
      assertSessionAttemptQuiescenceRecoveryDurable({
        acknowledgeQuiescence: true,
        physicalToolQuiescenceConfirmed: true,
        receiptOrProofDurable: true,
        failure: persistenceFailure,
      }),
    ).not.toThrow();
  });

  test("does not publish quiescence until tool and credential writers physically drain", async () => {
    const steps: string[] = [];
    let releaseTools!: () => void;
    let releaseGitWrite!: () => void;
    let releaseCodemodeWrite!: () => void;
    let releaseRunCredentialWrite!: () => void;
    const toolsDrained = new Promise<void>((resolve) => {
      releaseTools = resolve;
    });
    const gitWriteDrained = new Promise<void>((resolve) => {
      releaseGitWrite = resolve;
    });
    const codemodeWriteDrained = new Promise<void>((resolve) => {
      releaseCodemodeWrite = resolve;
    });
    const runCredentialWriteDrained = new Promise<void>((resolve) => {
      releaseRunCredentialWrite = resolve;
    });
    const gitRenewal = startGitCredentialRenewalLoop({
      expectedProviders: ["github"],
      mint: async () => ({ gitTokens: { github: "test-token" }, expiresAt: {} }),
      write: async () => {
        steps.push("git-write-started");
        await gitWriteDrained;
        steps.push("git-write-drained");
      },
      schedule: () => ({ testTimer: true }),
      clearSchedule: () => undefined,
    });
    const gitRefresh = gitRenewal.refreshNow();
    await Bun.sleep(0);
    expect(steps).toEqual(["git-write-started"]);

    let receipts = 0;
    const boundary = drainAttemptOwnedSandboxWriters({
      toolCancellationFence: {
        cancel: () => steps.push("tools-cancelled"),
        waitForQuiescence: async () => {
          steps.push("tools-draining");
          await toolsDrained;
          steps.push("tools-drained");
        },
      },
      cancellationReason: new Error("STEER"),
      gitCredentialRenewals: [gitRenewal],
      codemodeTokenRenewal: {
        stop: async () => {
          steps.push("codemode-draining");
          await codemodeWriteDrained;
          steps.push("codemode-drained");
        },
      },
      runCredentialRenewal: {
        stop: async () => {
          steps.push("run-credentials-draining");
          await runCredentialWriteDrained;
          steps.push("run-credentials-drained");
        },
      },
    }).then(() => {
      receipts += 1;
      steps.push("receipt");
    });

    await Bun.sleep(0);
    expect(steps).toEqual(["git-write-started", "tools-cancelled", "tools-draining"]);
    expect(receipts).toBe(0);

    releaseTools();
    await Bun.sleep(0);
    expect(steps).toEqual([
      "git-write-started",
      "tools-cancelled",
      "tools-draining",
      "tools-drained",
    ]);
    expect(receipts).toBe(0);

    releaseGitWrite();
    await Bun.sleep(0);
    expect(steps.at(-1)).toBe("codemode-draining");
    expect(receipts).toBe(0);

    releaseCodemodeWrite();
    await Bun.sleep(0);
    expect(steps.at(-1)).toBe("run-credentials-draining");
    expect(receipts).toBe(0);

    releaseRunCredentialWrite();
    await Promise.all([boundary, gitRefresh]);
    expect(steps.at(-1)).toBe("receipt");
    expect(receipts).toBe(1);
  });

  test("retries the proof-bearing turn release outside Temporal cancellation", async () => {
    const proofFlags: boolean[] = [];
    const delays: number[] = [];
    await releaseTurnSandboxAfterWriterDrain(
      {
        release: async (options) => {
          proofFlags.push(options?.workspaceWritersQuiesced === true);
          if (proofFlags.length < 3) throw new Error("rollout connection reset");
        },
      },
      {
        maxAttempts: 3,
        retryDelayMs: 25,
        wait: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );
    expect(proofFlags).toEqual([true, true, true]);
    expect(delays).toEqual([25, 50]);
  });

  test("retries one immutable quiescence proof after receipt exhaustion", async () => {
    const proof = {
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attemptId: "attempt-1",
      workflowId: "workflow-1",
      workflowRunId: "run-1",
      activityId: "activity-1",
    };
    const signals: Array<typeof proof> = [];
    const sleeps: number[] = [];
    const heartbeats: Array<{ attempt: number; delayMs: number }> = [];
    let signalAttempts = 0;
    expect(
      await persistOrSignalSessionAttemptQuiescence({
        proof,
        persistReceipt: async () => {
          throw new Error("three DB attempts exhausted");
        },
        publishEvents: async () => {
          throw new Error("unreachable publish");
        },
        signalProof: async (delivered) => {
          signals.push(delivered);
          signalAttempts += 1;
          if (signalAttempts < 3) throw new Error("Temporal unavailable");
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        heartbeat: (attempt, delayMs) => {
          heartbeats.push({ attempt, delayMs });
        },
      }),
    ).toBe("signal");
    expect(signals).toEqual([proof, proof, proof]);
    expect(sleeps).toEqual([250, 500]);
    expect(heartbeats).toEqual([
      { attempt: 1, delayMs: 250 },
      { attempt: 2, delayMs: 500 },
    ]);
  });

  test("a live-fanout failure cannot masquerade as receipt loss", async () => {
    let signalCalls = 0;
    let publishFailures = 0;
    expect(
      await persistOrSignalSessionAttemptQuiescence({
        proof: {
          accountId: "account-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          attemptId: "attempt-1",
          workflowId: "workflow-1",
          workflowRunId: "run-1",
          activityId: "activity-1",
        },
        persistReceipt: async () => ({ events: [], workflowWake: null }),
        publishEvents: async () => {
          throw new Error("NATS unavailable");
        },
        signalProof: async () => {
          signalCalls += 1;
        },
        onPublishFailure: () => {
          publishFailures += 1;
        },
      }),
    ).toBe("receipt");
    expect(signalCalls).toBe(0);
    expect(publishFailures).toBe(1);
  });

  test("delivers the exact committed wake before best-effort event fanout", async () => {
    const order: string[] = [];
    const wake = {
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      temporalWorkflowId: "workflow-1",
      wakeRevision: 17,
      interruptionRequested: false,
    };
    let signalCalls = 0;
    let wakeFailures = 0;
    expect(
      await persistOrSignalSessionAttemptQuiescence({
        proof: {
          accountId: "account-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          attemptId: "attempt-1",
          workflowId: "workflow-1",
          workflowRunId: "run-1",
          activityId: "activity-1",
        },
        persistReceipt: async () => ({ events: [], workflowWake: wake }),
        deliverWorkflowWake: async (delivered) => {
          order.push("wake");
          expect(delivered).toEqual(wake);
          throw new Error("Temporal unavailable");
        },
        publishEvents: async () => {
          order.push("fanout");
        },
        signalProof: async () => {
          signalCalls += 1;
        },
        onWakeFailure: () => {
          wakeFailures += 1;
        },
      }),
    ).toBe("receipt");
    expect(order).toEqual(["wake", "fanout"]);
    expect(signalCalls).toBe(0);
    expect(wakeFailures).toBe(1);
  });

  test("receipt exhaustion fails closed when the proof signaler is missing", async () => {
    await expect(
      persistOrSignalSessionAttemptQuiescence({
        proof: {
          accountId: "account-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          attemptId: "attempt-1",
          workflowId: "workflow-1",
          workflowRunId: "run-1",
          activityId: "activity-1",
        },
        persistReceipt: async () => {
          throw new Error("DB unavailable");
        },
        publishEvents: async () => undefined,
        signalProof: null,
      }),
    ).rejects.toThrow(/signaler is unavailable/);
  });

  test("a cancelled activity never waits for a hung idempotent finalizer step", async () => {
    const controller = new AbortController();
    let rejectLate: ((error: Error) => void) | undefined;
    const hung = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const startedAt = performance.now();
    const waiting = waitForTurnFinalizerStep(hung, controller.signal);
    controller.abort(new Error("STEER"));
    await expect(waiting).resolves.toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(100);
    rejectLate?.(new Error("late cleanup failure"));
    await Bun.sleep(0);
  });

  test("a completed activity never waits forever for hung finalizer housekeeping", async () => {
    let rejectLate: ((error: Error) => void) | undefined;
    const hung = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const startedAt = performance.now();
    await expect(waitForTurnFinalizerStep(hung, undefined, 10)).resolves.toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(100);
    rejectLate?.(new Error("late cleanup failure"));
    await Bun.sleep(0);
  });

  test("a cancelled activity detaches both hung batch flush and provider completion", async () => {
    const controller = new AbortController();
    let rejectFlush: ((error: Error) => void) | undefined;
    let rejectProvider: ((error: Error) => void) | undefined;
    const flush = new Promise<never>((_resolve, reject) => {
      rejectFlush = reject;
    });
    const providerCompleted = new Promise<never>((_resolve, reject) => {
      rejectProvider = reject;
    });
    const startedAt = performance.now();
    const cleanup = waitForTurnStreamCleanup(flush, providerCompleted, controller.signal);
    controller.abort(new Error("STEER"));
    await expect(cleanup).resolves.toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(100);
    rejectFlush?.(new Error("late batch failure"));
    rejectProvider?.(new Error("late provider failure"));
    await Bun.sleep(0);
  });
});

describe("settled run-credential finalization", () => {
  test("drains active tools before submitting terminal credential cleanup", async () => {
    const source = await Bun.file(
      new URL("../src/activities/agent-turn/finalization.ts", import.meta.url),
    ).text();
    const drainAt = source.indexOf("await drainAttemptOwnedSandboxWriters({");
    const credentialClearAt = source.indexOf(
      "await clearAttemptCredentialsWithSettledFence({",
      drainAt,
    );
    const receiptAt = source.indexOf(
      "const proof: SessionAttemptQuiescenceProof",
      credentialClearAt,
    );

    expect(drainAt).toBeGreaterThan(-1);
    expect(credentialClearAt).toBeGreaterThan(drainAt);
    expect(receiptAt).toBeGreaterThan(credentialClearAt);
  });

  for (const activityStatus of ["idle", "failed", "cancelled"] as const) {
    test(`retries exact attempt cleanup after ${activityStatus} terminal settlement`, async () => {
      const calls: string[] = [];
      const fence = new SandboxWorkspaceMutationFencedError(
        "attempt_fenced",
        "terminal settlement closed the attempt",
      );

      await clearAttemptCredentialsWithSettledFence({
        activityStatus,
        runWorkspaceFencedClear: async () => {
          calls.push("workspace-fenced");
          throw fence;
        },
        onSettledAttemptFence: () => calls.push("observed"),
        clearExactAttempt: async () => {
          calls.push("exact-attempt-clear");
        },
      });

      expect(calls).toEqual(["workspace-fenced", "observed", "exact-attempt-clear"]);
    });
  }

  for (const [label, error, activityStatus] of [
    ["wrong error name", Object.assign(new Error("fenced"), { code: "attempt_fenced" }), "idle"],
    [
      "wrong fence code",
      new SandboxWorkspaceMutationFencedError("holder_fenced", "holder changed"),
      "idle",
    ],
    [
      "nonterminal activity",
      new SandboxWorkspaceMutationFencedError("attempt_fenced", "attempt changed"),
      "recovering",
    ],
  ] as const) {
    test(`keeps ${label} fail-closed`, async () => {
      let directClears = 0;
      const caught = await clearAttemptCredentialsWithSettledFence({
        activityStatus,
        runWorkspaceFencedClear: async () => {
          throw error;
        },
        onSettledAttemptFence: () => {
          throw new Error("unexpected settled-fence callback");
        },
        clearExactAttempt: async () => {
          directClears += 1;
        },
      }).catch((failure: unknown) => failure);

      expect(caught).toBe(error);
      expect(directClears).toBe(0);
    });
  }

  test("keeps a direct exact-attempt deletion failure fail-closed", async () => {
    const deletionFailure = new Error("exact credential deletion failed");
    let settledFences = 0;
    const caught = await clearAttemptCredentialsWithSettledFence({
      activityStatus: "idle",
      runWorkspaceFencedClear: async () => {
        throw new SandboxWorkspaceMutationFencedError(
          "attempt_fenced",
          "terminal settlement closed the attempt",
        );
      },
      onSettledAttemptFence: () => {
        settledFences += 1;
      },
      clearExactAttempt: async () => {
        throw deletionFailure;
      },
    }).catch((failure: unknown) => failure);

    expect(caught).toBe(deletionFailure);
    expect(settledFences).toBe(1);
  });
});

describe("Codex credential lease deadline fence", () => {
  test("an expired confirmed deadline marks the lease lost before dispatch", () => {
    const lease = new CodexTurnLease({
      db: {},
      observability: {
        incrementCounter: () => undefined,
        warn: () => undefined,
      },
      accountId: "account-1",
      workspaceId: "workspace-1",
      codexWorkspaceKey: "workspace-key",
      getTurnId: () => "turn-1",
    } as never);
    lease.held = true;
    lease.holderId = "holder-1";
    lease.generation = 1;
    lease.confirmedUntilMs = performance.now() - 1;

    expect(() => lease.assertUsable()).toThrow(CodexCredentialLeaseLostError);
    expect(lease.lost).toBe(true);
    expect(lease.lossReason).toBe("deadline");
  });

  test("fails closed at the last database-confirmed expiry, including a missing deadline", () => {
    const now = Date.parse("2026-07-10T08:00:00.000Z");
    expect(codexCredentialLeaseDeadlineExpired(null, now)).toBe(true);
    expect(codexCredentialLeaseDeadlineExpired(Number.NaN, now)).toBe(true);
    expect(codexCredentialLeaseDeadlineExpired(now, now)).toBe(true);
    expect(codexCredentialLeaseDeadlineExpired(now - 1, now)).toBe(true);
    expect(codexCredentialLeaseDeadlineExpired(now + 1, now)).toBe(false);
  });

  test("does not accept a successful heartbeat that returns after the prior deadline", async () => {
    let resolveHeartbeat!: (value: Date | null) => void;
    const heartbeat = spyOn(opengeniDb, "heartbeatCodexCredentialLeaseUntil").mockImplementation(
      () =>
        new Promise<Date | null>((resolve) => {
          resolveHeartbeat = resolve;
        }),
    );
    try {
      const lease = new CodexTurnLease({
        db: {},
        observability: {
          incrementCounter: () => undefined,
          warn: () => undefined,
        },
        accountId: "account-1",
        workspaceId: "workspace-1",
        codexWorkspaceKey: "workspace-key",
        getTurnId: () => "turn-1",
      } as never);
      lease.held = true;
      lease.holderId = "holder-1";
      lease.generation = 1;
      const priorDeadline = performance.now() + 1;
      lease.confirmedUntilMs = priorDeadline;

      const renewal = lease.renew("timer");
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 25));
      resolveHeartbeat(new Date());
      await renewal;

      expect(lease.lost).toBe(true);
      expect(lease.lossReason).toBe("deadline");
      expect(lease.confirmedUntilMs).toBe(priorDeadline);
    } finally {
      heartbeat.mockRestore();
    }
  });

  test("transport dispatch fence preserves typed lease loss and skips the provider", async () => {
    const lease = new CodexTurnLease({
      db: {},
      observability: {
        incrementCounter: () => undefined,
        warn: () => undefined,
      },
      accountId: "account-1",
      workspaceId: "workspace-1",
      codexWorkspaceKey: "workspace-key",
      getTurnId: () => "turn-1",
    } as never);
    lease.held = true;
    lease.holderId = "holder-1";
    lease.generation = 1;
    lease.confirmedUntilMs = performance.now() + 10_000;
    lease.markLost("not_found");

    let providerCalls = 0;
    await expect(
      codexRequestStorage.run(
        {
          clientVersion: "test",
          getToken: async () => ({
            accessToken: "token",
            chatgptAccountId: "account-1",
            isFedramp: false,
          }),
          refresh: async () => ({
            accessToken: "token",
            chatgptAccountId: "account-1",
            isFedramp: false,
          }),
          resolveModel: (model) => model,
          beforeProviderDispatch: lease.assertUsable,
        },
        () =>
          codexSubscriptionFetch(async () => {
            providerCalls += 1;
            return new Response(null, { status: 200 });
          })("https://chatgpt.com/backend-api/responses", {
            method: "POST",
            body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
          }),
      ),
    ).rejects.toBeInstanceOf(CodexCredentialLeaseLostError);
    expect(providerCalls).toBe(0);
  });
});

describe("sandbox file materialization note", () => {
  test("keeps repositories durable but admits only current-turn file attachments", () => {
    const repository: ResourceRef = {
      kind: "repository",
      provider: "github",
      repositoryId: "123",
      uri: "https://github.com/cloudgeni-ai/opengeni",
      ref: "main",
      mountPath: "opengeni",
    };
    const historicalFile: ResourceRef = {
      kind: "file",
      fileId: "00000000-0000-4000-8000-000000000071",
    };
    const currentFile: ResourceRef = {
      kind: "file",
      fileId: "00000000-0000-4000-8000-000000000072",
    };

    expect(runtimeResourcesForTurn([repository, historicalFile], [currentFile])).toEqual([
      repository,
      currentFile,
    ]);
  });

  test("uses the active backend when deciding whether attachments need signed delivery", () => {
    const modalHome = testSettings({
      sandboxBackend: "modal",
      objectStorageBackend: "s3-compatible",
    });
    expect(requiresSignedFileResourceDownloads(modalHome, "modal")).toBe(false);
    expect(requiresSignedFileResourceDownloads(modalHome, "selfhosted")).toBe(true);
    expect(requiresSignedFileResourceDownloads(modalHome, "docker")).toBe(true);
    expect(requiresSignedFileResourceDownloads(modalHome, "none")).toBe(false);
  });

  test("filters downloads already materialized on the current box", () => {
    const downloads = [
      {
        fileId: "file-1",
        mountPath: "files/file-1",
        filename: "one.txt",
        url: "https://example.com/1",
      },
      {
        fileId: "file-2",
        mountPath: "files/file-2",
        filename: "two.txt",
        url: "https://example.com/2",
      },
    ];

    expect(filterUnmaterializedSandboxFileDownloads(downloads, new Set(["file-1"]))).toEqual([
      downloads[1],
    ]);
    expect(filterUnmaterializedSandboxFileDownloads(downloads, new Set())).toBe(downloads);
  });
});

describe("context window overflow classifier", () => {
  test("matches OpenAI/Azure context-window variants", () => {
    const byCode = Object.assign(new Error("Bad Request"), {
      code: "context_length_exceeded",
      status: 400,
    });
    expect(classifyContextWindowOverflowError(byCode)?.code).toBe("context_length_exceeded");

    expect(
      classifyContextWindowOverflowError(
        new Error("Your input exceeds the context window of this model"),
      )?.message,
    ).toContain("exceeds the context window");

    expect(
      classifyContextWindowOverflowError(
        new Error("This model's maximum context length is 128000 tokens"),
      )?.message,
    ).toContain("maximum context length");

    const nested = {
      status: 400,
      error: {
        code: "BadRequest",
        message: "The request failed because the input exceeds the context window.",
      },
    };
    expect(classifyContextWindowOverflowError(nested)?.detail).toContain(
      "exceeds the context window",
    );
  });

  test("does not match unrelated provider failures", () => {
    expect(classifyContextWindowOverflowError(new Error("Too Many Requests"))).toBeNull();
    expect(
      classifyContextWindowOverflowError(
        Object.assign(new Error("invalid tool call"), { status: 400 }),
      ),
    ).toBeNull();
    expect(
      classifyContextWindowOverflowError({
        code: "rate_limit_exceeded",
        message: "rate limit",
      }),
    ).toBeNull();
  });
});

describe("escaped MCP transport timeout classifier", () => {
  test("matches the production -32001 request-timeout shape and nested transport errors", () => {
    const exact = new Error("MCP error -32001: Request timed out");
    expect(classifyMcpTransportTimeoutError(exact)?.message).toBe(exact.message);

    const sdkTimeoutMessages = [
      "Request timed out",
      "MCP error -32001: Request timed out",
      "Maximum total timeout exceeded",
      "MCP error -32001: Maximum total timeout exceeded",
    ];
    for (const message of sdkTimeoutMessages) {
      const classified = mcpTransportErrorWithRetryMetadata(
        Object.assign(new Error(message), {
          name: "McpError",
          code: -32_001,
        }),
      );
      expect(classifyMcpTransportTimeoutError(classified)?.message).toBe(classified.message);
      expect(agentRunFailurePayload(classified)).toEqual({
        error:
          "An MCP server request timed out. Any completed tool output was checkpointed; the session can continue safely.",
        code: "mcp_transport_timeout",
        retryable: true,
        detail: message,
      });
    }

    const nested = {
      error: { message: "MCP transport request timeout while listing tools" },
    };
    expect(classifyMcpTransportTimeoutError(nested)?.detail).toContain("MCP transport");

    expect(agentRunFailurePayload(exact)).toEqual({
      error:
        "An MCP server request timed out. Any completed tool output was checkpointed; the session can continue safely.",
      code: "mcp_transport_timeout",
      retryable: true,
      detail: exact.message,
    });

    for (const message of [
      "MCP error -32001: Session not found",
      "MCP error -32001: operator cancelled this request",
    ]) {
      const ambiguous = mcpTransportErrorWithRetryMetadata(
        Object.assign(new Error(message), {
          name: "McpError",
          code: -32_001,
        }),
      );
      expect(classifyMcpTransportTimeoutError(ambiguous)).toBeNull();
    }
  });

  test("does not absorb auth-needed or unrelated timeout failures", () => {
    expect(
      classifyMcpTransportTimeoutError(
        new Error("MCP error -32001: Authentication required - a connection link was posted"),
      ),
    ).toBeNull();
    expect(classifyMcpTransportTimeoutError(new Error("sandbox creation timed out"))).toBeNull();
    expect(classifyMcpTransportTimeoutError(new Error("Too Many Requests"))).toBeNull();
  });

  test("recovers an exact nested MCP connection refusal with typed retry metadata", () => {
    const raw = new Error("MCP connect failed for https://private.example/token-value");
    raw.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), {
      code: "ECONNREFUSED",
    });
    const classified = mcpTransportErrorWithRetryMetadata(raw);

    expect(classifyMcpTransportTimeoutError(classified)).toBeNull();
    expect(agentRunFailurePayload(classified)).toEqual({
      error:
        "A required MCP server was temporarily unreachable. The same turn will retry after a short delay.",
      code: "mcp_transport_unavailable",
      retryable: true,
      detail: raw.message,
    });
    expect(
      providerRecoveryResult({
        failureCode: "mcp_transport_unavailable",
        attemptNumber: 1,
      }),
    ).toEqual({
      status: "recovering",
      continueDelayMs: 2_000,
    });
    expect(classified).toBe(raw);
    expect(classified.message).toBe(raw.message);
    expect(classified.cause).toMatchObject({
      message: "connect ECONNREFUSED 127.0.0.1:8000",
      code: "ECONNREFUSED",
    });
    expect(agentRunFailurePayload(classified).detail).toContain("private.example");
  });

  test("persists the exact failed MCP request phase and cause chain for recovery", async () => {
    const socketFailure = Object.assign(new Error("connect ECONNREFUSED 10.0.0.8:443"), {
      code: "ECONNREFUSED",
    });
    const source = new TypeError("Unable to connect. Is the computer able to access the url?", {
      cause: socketFailure,
    });
    const guarded = guardedMcpFetch(
      testSettings,
      async () => {
        throw source;
      },
      {
        dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
        pinResolvedDestination: false,
      },
    );

    let observed: unknown;
    try {
      await guarded("https://example.test/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    } catch (error) {
      observed = error;
    }
    const classified = mcpTransportErrorWithRetryMetadata(
      new Error("MCP SDK request failed", { cause: observed }),
    );

    expect(agentRunFailurePayload(classified)).toEqual({
      error:
        "A required MCP server was temporarily unreachable. The same turn will retry after a short delay.",
      code: "mcp_transport_unavailable",
      retryable: true,
      detail: "MCP SDK request failed",
      mcpTransportDiagnostic: {
        httpMethod: "POST",
        rpcMethod: "tools/list",
        causeChain: [
          {
            kind: "error",
            name: "TypeError",
            message: "Unable to connect. Is the computer able to access the url?",
          },
          {
            kind: "error",
            name: "Error",
            message: "connect ECONNREFUSED 10.0.0.8:443",
            code: "ECONNREFUSED",
          },
        ],
        causeChainComplete: true,
      },
    });
  });

  test("persists transport request diagnostics for retryable MCP timeouts", async () => {
    const source = Object.assign(new Error("MCP error -32001: Request timed out"), {
      name: "McpError",
      code: -32_001,
    });
    const guarded = guardedMcpFetch(
      testSettings,
      async () => {
        throw source;
      },
      {
        dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
        pinResolvedDestination: false,
      },
    );

    await expect(
      guarded("https://example.test/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    ).rejects.toBe(source);

    expect(agentRunFailurePayload(mcpTransportErrorWithRetryMetadata(source))).toEqual({
      error:
        "An MCP server request timed out. Any completed tool output was checkpointed; the session can continue safely.",
      code: "mcp_transport_timeout",
      retryable: true,
      detail: "MCP error -32001: Request timed out",
      mcpTransportDiagnostic: {
        httpMethod: "POST",
        rpcMethod: "initialize",
        causeChain: [
          {
            kind: "error",
            name: "McpError",
            message: "MCP error -32001: Request timed out",
            code: -32_001,
          },
        ],
        causeChainComplete: true,
      },
    });
  });

  test("keeps exact MCP client and ambiguous failures terminal", () => {
    const rejected = mcpTransportErrorWithRetryMetadata(
      Object.assign(new Error("request rejected with secret body"), {
        status: 401,
        cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      }),
    );
    const ambiguous = mcpTransportErrorWithRetryMetadata(
      Object.assign(new Error("policy refused the connection"), {
        code: "CONNECTION_REFUSED_BY_POLICY",
      }),
    );

    expect(agentRunFailurePayload(rejected)).toEqual({
      error: "request rejected with secret body",
    });
    expect(agentRunFailurePayload(ambiguous)).toEqual({
      error: "policy refused the connection",
    });
  });

  test("recovers rollout-safe first-party setup loss but keeps auth and typed defects terminal", () => {
    const routeNotReady = mcpTransportErrorWithRetryMetadata(
      Object.assign(new Error("temporary first-party route"), { status: 404 }),
      { recoverySafeSetup: true },
    );
    const statusless = mcpTransportErrorWithRetryMetadata(new Error("fetch failed"), {
      recoverySafeSetup: true,
    });
    const authRejected = mcpTransportErrorWithRetryMetadata(
      Object.assign(new Error("authentication failed"), { status: 401 }),
      { recoverySafeSetup: true },
    );
    const typedProtocolFailure = mcpTransportErrorWithRetryMetadata(
      new TypeError("invalid response"),
      {
        recoverySafeSetup: true,
      },
    );

    expect(agentRunFailurePayload(routeNotReady)).toEqual({
      error:
        "A required MCP server was temporarily unreachable. The same turn will retry after a short delay.",
      code: "mcp_transport_unavailable",
      retryable: true,
      detail: "temporary first-party route",
    });
    expect(agentRunFailurePayload(statusless)).toEqual({
      error:
        "A required MCP server was temporarily unreachable. The same turn will retry after a short delay.",
      code: "mcp_transport_unavailable",
      retryable: true,
      detail: "fetch failed",
    });
    expect(agentRunFailurePayload(authRejected)).toEqual({
      error: "authentication failed",
    });
    expect(agentRunFailurePayload(typedProtocolFailure)).toEqual({
      error: "invalid response",
    });
  });

  test("emits a typed workflow recovery obligation only before a generation-2 model request", () => {
    const detail = {
      turnId: "turn-2",
      triggerEventId: "trigger-1",
      executionGeneration: 2,
      providerRecoveryCount: 1,
      continueDelayMs: 2_000,
    };
    const escaped = escapedMcpTimeoutRecoveryFailure({
      failureCode: "mcp_transport_timeout",
      modelRequestStarted: false,
      detail,
    });
    expect(escaped).toBeInstanceOf(ApplicationFailure);
    expect(escaped).toMatchObject({
      type: "EscapedMcpTimeoutRecoveryFailure",
      nonRetryable: true,
      details: [detail],
    });

    expect(
      escapedMcpTimeoutRecoveryFailure({
        failureCode: "mcp_transport_timeout",
        modelRequestStarted: false,
        detail: { ...detail, executionGeneration: 1 },
      }),
    ).toBeNull();
    expect(
      escapedMcpTimeoutRecoveryFailure({
        failureCode: "mcp_transport_timeout",
        modelRequestStarted: false,
        detail: { ...detail, providerRecoveryCount: MAX_AUTOMATIC_PROVIDER_RECOVERIES + 1 },
      }),
    ).toBeNull();
    expect(
      escapedMcpTimeoutRecoveryFailure({
        failureCode: "mcp_transport_timeout",
        modelRequestStarted: true,
        detail,
      }),
    ).toBeNull();
    expect(
      escapedMcpTimeoutRecoveryFailure({
        failureCode: "provider_unavailable",
        modelRequestStarted: false,
        detail,
      }),
    ).toBeNull();
  });
});

describe("Codex response timeout fail-closed settlement", () => {
  test("recognizes the production OpenAI timeout only inside a confirmed Codex turn", () => {
    const legacy = Object.assign(new Error("Request timed out."), {
      name: "APIConnectionTimeoutError",
    });
    expect(agentRunFailurePayload(legacy).retryable).toBeUndefined();
    expect(agentRunFailurePayload(legacy, { isCodexTurn: true })).toMatchObject({
      code: "codex_response_timeout",
      retryable: false,
      timeoutClass: "headers",
      responseObserved: false,
    });
  });

  test("preserves structured partial-stream timeout evidence without same-turn replay", () => {
    const structured = Object.assign(new Error("Codex response idle stream timed out"), {
      name: "CodexResponseTimeoutError",
      type: "opengeni_codex_response_timeout",
      timeoutClass: "idle_stream",
      requestId: "dispatch-7:3",
      responseObserved: true,
    });
    expect(agentRunFailurePayload(structured)).toMatchObject({
      code: "codex_response_timeout",
      retryable: false,
      timeoutClass: "idle_stream",
      responseObserved: true,
      requestId: "dispatch-7:3",
    });
  });

  test("recovers timeout metadata from the buffered OpenAI APIError body shape", () => {
    const apiError = Object.assign(new Error("504 Codex response timed out"), {
      status: 504,
      error: {
        type: "opengeni_codex_response_timeout",
        timeout_class: "whole_request",
        response_observed: false,
        request_id: "dispatch-9:2",
      },
    });
    expect(agentRunFailurePayload(apiError)).toMatchObject({
      code: "codex_response_timeout",
      retryable: false,
      timeoutClass: "whole_request",
      responseObserved: false,
      requestId: "dispatch-9:2",
    });
  });
});

// A model-provider 5xx / overload / dropped connection is transient backpressure,
// not a session fault. It must classify retryable so the turn routes into the idle +
// goal-continuation recovery instead of a terminal session.failed — the gap that
// hard-failed a fleet of prod sessions during a provider degradation window.
describe("transient provider error classifier", () => {
  test("an empty post-compaction continuation recovers the same compacted turn", () => {
    expect(agentRunFailurePayload(new PostCompactionContinuationEmptyError())).toEqual({
      error:
        "Context compaction completed, but the continuation ended before a new model response. The same turn will retry from the compacted checkpoint.",
      code: POST_COMPACTION_CONTINUATION_EMPTY_CODE,
      retryable: true,
    });
    expect(
      providerRecoveryResult({
        failureCode: POST_COMPACTION_CONTINUATION_EMPTY_CODE,
        attemptNumber: 1,
      }),
    ).toEqual({ status: "recovering", continueDelayMs: 2_000 });
  });

  test("an unknown Chat Completions finish reason recovers the same accepted turn", () => {
    expect(agentRunFailurePayload(new UnknownModelFinishReasonError())).toEqual({
      error:
        "The model provider ended its response ambiguously. Partial output was not accepted as complete; the same turn will retry from durable history.",
      code: UNKNOWN_MODEL_FINISH_REASON_CODE,
      retryable: true,
    });
  });

  test("a null accepted Codex stream settles terminally without same-turn recovery", async () => {
    const observed = await actualCodexNullBodyFailure();
    expect(observed.calls).toBe(1);
    expect(agentRunFailurePayload(observed.error)).toEqual({
      error: "The Codex response stream ended without a terminal response",
      code: "invalid_sse_terminal",
      retryable: false,
    });

    const wrapped = new CompactionProviderResponseError(
      { httpStatus: 502, code: "invalid_sse_terminal", type: "invalid_sse_terminal" },
      observed.error,
    );
    expect(agentRunFailurePayload(wrapped)).toEqual({
      error: "The Codex response stream ended without a terminal response",
      code: "invalid_sse_terminal",
      retryable: false,
    });
    expect(shouldRecoverCompactionProviderFailure(wrapped)).toBe(false);
  });

  test("an actual streamed Codex server failure preserves exact detail during same-turn recovery", async () => {
    const observed = await actualCodexStreamingFailure({
      type: "response.failed",
      response: {
        id: "resp_worker_server",
        status: "failed",
        error: {
          type: "server_error",
          code: "server_error",
          message: "SECRET worker server provider detail",
        },
      },
    });

    expect(observed.calls).toBe(1);
    expect(observed.forwarded).toBe("");
    const payload = agentRunFailurePayload(observed.error);
    expect(payload).toEqual({
      error: "SECRET worker server provider detail",
      code: "provider_unavailable",
      retryable: true,
    });
    expect(JSON.stringify({ error: observed.error, payload })).toContain(
      "SECRET worker server provider detail",
    );
    expect(
      providerRecoveryResult({ failureCode: "provider_unavailable", attemptNumber: 1 }),
    ).toEqual({
      status: "recovering",
      continueDelayMs: 2_000,
    });
  });

  test("an actual streamed Codex context failure remains exact and nonretryable", async () => {
    const observed = await actualCodexStreamingFailure({
      type: "response.failed",
      response: {
        id: "resp_worker_context",
        status: "failed",
        error: {
          type: "invalid_request_error",
          code: "context_length_exceeded",
          message: "SECRET worker context provider detail",
        },
      },
    });

    expect(observed.calls).toBe(1);
    expect(observed.forwarded).toBe("");
    expect(classifyContextWindowOverflowError(observed.error)?.code).toBe(
      "context_length_exceeded",
    );
    const payload = agentRunFailurePayload(observed.error);
    expect(payload).toEqual({ error: "SECRET worker context provider detail" });
    expect(payload.retryable).toBeUndefined();
    expect(JSON.stringify({ error: observed.error, payload })).toContain(
      "SECRET worker context provider detail",
    );
  });

  test("actual streamed Codex rate and usage terminals keep distinct truthful settlement", async () => {
    const rate = await actualCodexStreamingFailure({
      type: "error",
      code: "rate_limit_exceeded",
      message: "SECRET worker rate provider detail",
    });
    expect(rate.calls).toBe(1);
    expect(rate.forwarded).toBe("");
    expect(agentRunFailurePayload(rate.error)).toEqual({
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      detail: "SECRET worker rate provider detail",
    });

    const usage = await actualCodexStreamingFailure({
      type: "response.failed",
      response: {
        id: "resp_worker_usage",
        status: "failed",
        error: {
          type: "usage_limit_reached",
          code: "usage_limit_reached",
          message: "SECRET worker usage provider detail",
        },
      },
    });
    expect(usage.calls).toBe(1);
    expect(usage.forwarded).toBe("");
    const usagePayload = agentRunFailurePayload(usage.error);
    expect(usagePayload.code).toBe("codex_usage_limit_reached");
    expect(usagePayload.retryable).toBe(false);
    expect(JSON.stringify({ rate, usage, usagePayload })).toContain(
      "SECRET worker usage provider detail",
    );
  });

  test("classifies nested database truth without retrying provider work", () => {
    const error = new SessionEventPersistenceError({
      code: "db_deadlock",
      sqlState: "40P01",
      stage: "session_events.append_for_turn_attempt",
      eventTypes: ["agent.model.usage"],
      correlationId: "corr-safe",
      attempts: 3,
      retryOutcome: "exhausted",
      database: {
        table: "session_events",
        constraint: "session_events_workspace_session_sequence_idx",
      },
    });
    const payload = agentRunFailurePayload(error);
    expect(payload).toEqual({
      error: "Database deadlock while persisting agent.model.usage",
      code: "db_deadlock",
      detail: "The idempotent persistence transaction failed after 3 attempts.",
      correlationId: "corr-safe",
      stage: "session_events.append_for_turn_attempt",
      sqlState: "40P01",
      attempts: 3,
      retryOutcome: "exhausted",
      database: {
        table: "session_events",
        constraint: "session_events_workspace_session_sequence_idx",
      },
    });
    expect(payload.retryable).toBeUndefined();

    const mandatory = new MandatoryHistoryPersistenceError("sandbox_envelope", error);
    expect(agentRunFailurePayload(mandatory)).toEqual({
      ...payload,
      historyPersistenceStage: "sandbox_envelope",
    });
    expect(agentRunFailurePayload(mandatory).retryable).toBeUndefined();
  });

  test("exports only retry-safe admission truth to Temporal history", () => {
    const deadlock = new SessionEventPersistenceError({
      code: "db_deadlock",
      sqlState: "40P01",
      stage: "session_attempts.claim",
      eventTypes: ["session.turn.attempt_claimed"],
      correlationId: "corr-preclaim",
      attempts: 3,
      retryOutcome: "exhausted",
      database: { table: "session_turn_attempts" },
    });
    expect(preClaimAdmissionFailure(deadlock)).toMatchObject({
      type: "OpenGeniPreClaimFailure",
      nonRetryable: true,
      details: [{ disposition: "retryable", code: "db_deadlock" }],
    });
    const connectionLoss = new SessionEventPersistenceError({
      code: "db_failure",
      sqlState: "08006",
      stage: "session_attempts.claim",
      eventTypes: ["session.turn.attempt_claimed"],
      correlationId: "corr-connection-loss",
      attempts: 1,
      retryOutcome: "not_retryable",
      database: {},
    });
    expect(preClaimAdmissionFailure(connectionLoss)).toMatchObject({
      details: [{ disposition: "retryable", code: "db_failure" }],
    });
    const rawConnectionLoss = Object.assign(new Error("SECRET socket detail"), {
      code: "CONNECTION_CLOSED",
      errno: "CONNECTION_CLOSED",
    });
    expect(preClaimAdmissionFailure(rawConnectionLoss)).toMatchObject({
      details: [{ disposition: "retryable", code: "db_failure" }],
    });
    expect(JSON.stringify(preClaimAdmissionFailure(rawConnectionLoss))).not.toContain("SECRET");
    expect(
      preClaimAdmissionFailure(
        Object.assign(new Error("SECRET nested socket detail"), {
          cause: { code: "ECONNRESET" },
        }),
      ),
    ).toMatchObject({
      details: [{ disposition: "retryable", code: "db_failure" }],
    });
    const constraint = new SessionEventPersistenceError({
      code: "db_failure",
      sqlState: "23505",
      stage: "session_attempts.claim",
      eventTypes: ["session.turn.attempt_claimed"],
      correlationId: "corr-constraint",
      attempts: 1,
      retryOutcome: "not_retryable",
      database: { constraint: "session_turn_attempts_pkey" },
    });
    expect(preClaimAdmissionFailure(constraint)).toMatchObject({
      details: [{ disposition: "retryable", code: "db_failure" }],
    });
    const authorizationGuard = new SessionEventPersistenceError({
      code: "db_failure",
      sqlState: "42501",
      stage: "session_attempts.claim",
      eventTypes: ["session.turn.attempt_claimed"],
      correlationId: "corr-authorization-guard",
      attempts: 1,
      retryOutcome: "not_retryable",
      database: {},
    });
    expect(preClaimAdmissionFailure(authorizationGuard)).toMatchObject({
      details: [{ disposition: "retryable", code: "db_failure" }],
    });
    expect(preClaimAdmissionFailure(new Error("SECRET malformed metadata"))).toMatchObject({
      type: "OpenGeniPreClaimFailure",
      nonRetryable: true,
      message: "Agent turn admission failed before attempt claim.",
      details: [{ disposition: "permanent", code: "claim_invariant" }],
    });
    expect(
      JSON.stringify(preClaimAdmissionFailure(new Error("SECRET malformed metadata"))),
    ).not.toContain("SECRET");
  });

  test("exports exact post-claim recovery truth only for operational database failures", () => {
    const identity = {
      turnId: "turn-claimed",
      triggerEventId: "trigger-claimed",
      executionGeneration: 3,
    };
    const deadlock = new SessionEventPersistenceError({
      code: "db_deadlock",
      sqlState: "40P01",
      stage: "session_turns.start",
      eventTypes: ["turn.started"],
      correlationId: "corr-postclaim",
      attempts: 3,
      retryOutcome: "exhausted",
      database: { table: "session_turns" },
    });
    expect(
      postClaimDatabaseRecoveryFailure({
        error: deadlock,
        ...identity,
        providerRecovery: {
          failureCode: "mcp_transport_unavailable",
          providerRecoveryCount: 2,
        },
      }),
    ).toMatchObject({
      type: "OpenGeniPostClaimDatabaseRecovery",
      nonRetryable: true,
      details: [
        {
          ...identity,
          code: "db_deadlock",
          providerFailureCode: "mcp_transport_unavailable",
          providerRecoveryCount: 2,
        },
      ],
    });
    expect(
      postClaimDatabaseRecoveryFailure({
        error: Object.assign(new Error("SECRET connection detail"), { code: "ECONNRESET" }),
        ...identity,
      }),
    ).toMatchObject({
      details: [{ ...identity, code: "db_failure" }],
    });
    const constraint = new SessionEventPersistenceError({
      code: "db_failure",
      sqlState: "23505",
      stage: "session_turns.start",
      eventTypes: ["turn.started"],
      correlationId: "corr-postclaim-constraint",
      attempts: 1,
      retryOutcome: "not_retryable",
      database: { constraint: "session_turns_pkey" },
    });
    expect(postClaimDatabaseRecoveryFailure({ error: constraint, ...identity })).toBeNull();
    expect(
      postClaimDatabaseRecoveryFailure({ error: new Error("SECRET invariant"), ...identity }),
    ).toBeNull();
    expect(
      postClaimDatabaseRecoveryFailure({
        error: deadlock,
        ...identity,
        providerRecovery: {
          failureCode: "unsafe provider code",
          providerRecoveryCount: 2,
        },
      }),
    ).toBeNull();
  });

  test("retains an exact database cause internally but sanitizes the session payload", async () => {
    const syntheticValue = ["synthetic", "worker", "db", "123456"].join("-");
    const source = Object.assign(new Error(`Failed query containing ${syntheticValue}`), {
      query: "insert into session_events values ($1)",
      params: [syntheticValue],
      driverError: {
        table_name: "session_events",
        detail: syntheticValue,
      },
    });
    const error = await runIdempotentPersistenceTransaction(
      {
        stage: "session_events.append_for_turn_attempt",
        eventTypes: ["agent.model.usage"],
        correlationId: "corr-unknown-exact",
      },
      async () => {
        throw source;
      },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(SessionEventPersistenceError);
    expect((error as SessionEventPersistenceError).cause).toBe(source);
    const payload = agentRunFailurePayload(error);
    expect(payload).toEqual({
      error: "Database failure while persisting agent.model.usage",
      code: "db_failure",
      detail: "The database rejected the idempotent persistence transaction.",
      correlationId: "corr-unknown-exact",
      stage: "session_events.append_for_turn_attempt",
      sqlState: null,
      attempts: 1,
      retryOutcome: "not_retryable",
      database: { table: "session_events" },
    });
    expect(JSON.stringify(payload)).not.toContain(syntheticValue);
    expect(JSON.stringify(payload)).not.toContain(source.query);
    expect((error as SessionEventPersistenceError).cause).toBe(source);
  });

  test("classifies 5xx status codes as transient (status is authoritative)", () => {
    for (const status of [500, 502, 503, 504, 529]) {
      const err = Object.assign(new Error("Service failure"), { status });
      expect(isTransientProviderError(err)).toBe(true);
    }
  });

  test("classifies the observed provider transient messages when no status survives", () => {
    // The exact bodies that hard-failed prod sessions, thrown as bare Errors.
    expect(
      isTransientProviderError(
        new Error(
          "An error occurred while processing your request. You can retry your request, " +
            "or contact us through our help center. Please include the request ID abc123.",
        ),
      ),
    ).toBe(true);
    expect(
      isTransientProviderError(
        new Error("Our servers are currently overloaded. Please try again later."),
      ),
    ).toBe(true);
    expect(isTransientProviderError(new Error("Connection error."))).toBe(true);
  });

  test("classifies the exact fresh no-rig pre-model connectivity failure as typed recovery", () => {
    const observed = new Error("Unable to connect. Is the computer able to access the url?");

    expect(isTransientProviderError(observed)).toBe(true);
    expect(agentRunFailurePayload(observed)).toEqual({
      error:
        "OpenGeni could not reach an upstream service. The same turn will retry after a short delay.",
      code: "upstream_connectivity_unavailable",
      retryable: true,
    });
    expect(
      providerRecoveryResult({
        failureCode: "upstream_connectivity_unavailable",
        attemptNumber: 1,
      }),
    ).toEqual({
      status: "recovering",
      continueDelayMs: 2_000,
    });

    // HTTP status remains authoritative: a request-owned 4xx with the same body
    // must not be mistaken for platform connectivity and retried forever.
    const rejectedRequest = Object.assign(new Error(observed.message), { status: 400 });
    expect(isTransientProviderError(rejectedRequest)).toBe(false);
    expect(agentRunFailurePayload(rejectedRequest)).toEqual({ error: observed.message });

    for (const nearMatch of [
      `Authentication failed: ${observed.message}`,
      `${observed.message} Unexpected suffix`,
    ]) {
      expect(isTransientProviderError(new Error(nearMatch))).toBe(false);
      expect(agentRunFailurePayload(new Error(nearMatch))).toEqual({ error: nearMatch });
    }
  });

  test("classifies exact Modal TaskExecStart DNS failure as typed same-turn recovery", () => {
    const details =
      "Name resolution failed for target dns:task-72zioucmtnmt4av4osz7bk19t.w.modal.host:443";
    const clientError = Object.assign(
      new Error(
        `/modal.task_command_router.TaskCommandRouter/TaskExecStart UNAVAILABLE: ${details}`,
      ),
      {
        name: "ClientError",
        path: "/modal.task_command_router.TaskCommandRouter/TaskExecStart",
        code: 14,
        details,
      },
    );
    const wrapped = new ToolCallError("Failed to run function tools", clientError);

    expect(isTransientProviderError(wrapped)).toBe(false);
    expect(agentRunFailurePayload(wrapped)).toEqual({
      error:
        "The managed sandbox command transport was temporarily unreachable before the command started. The same turn will retry after a short delay.",
      code: "sandbox_command_start_unavailable",
      retryable: true,
    });
    expect(
      providerRecoveryResult({
        failureCode: "sandbox_command_start_unavailable",
        attemptNumber: 1,
      }),
    ).toEqual({ status: "recovering", continueDelayMs: 2_000 });
  });

  test("keeps status-tagged, mixed-sibling, and shutdown Modal failures terminal", () => {
    const path = "/modal.task_command_router.TaskCommandRouter/TaskExecStart";
    const details =
      "Name resolution failed for target dns:task-72zioucmtnmt4av4osz7bk19t.w.modal.host:443";
    const clientError = (overrides: Record<string, unknown> = {}) =>
      Object.assign(new Error(`${path} UNAVAILABLE: ${details}`), {
        name: "ClientError",
        path,
        code: 14,
        details,
        ...overrides,
      });
    const statusTagged = new ToolCallError(
      "Failed to run function tools",
      clientError({ status: 503 }),
    );
    const mixed = new AggregateError(
      [
        new ToolCallError("DNS tool failed", clientError()),
        new Error("another tool may have started"),
      ],
      "parallel tools failed",
    );
    const shutdownDetails = "Modal Sandbox is shutting down";
    const shutdown = new ToolCallError(
      "Failed to run function tools",
      clientError({
        code: 9,
        details: shutdownDetails,
        message: `${path} FAILED_PRECONDITION: ${shutdownDetails}`,
      }),
    );

    for (const terminal of [statusTagged, mixed, shutdown]) {
      expect(isTransientProviderError(terminal)).toBe(false);
      expect(agentRunFailurePayload(terminal)).toEqual({ error: terminal.message });
    }
  });

  test("classifies node/undici network fault codes as transient", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"]) {
      expect(isTransientProviderError(Object.assign(new Error("socket"), { code }))).toBe(true);
    }
  });

  test("does NOT treat 4xx request faults or usage caps as transient", () => {
    expect(isTransientProviderError(Object.assign(new Error("Bad Request"), { status: 400 }))).toBe(
      false,
    );
    expect(
      isTransientProviderError(Object.assign(new Error("Unprocessable Entity"), { status: 422 })),
    ).toBe(false);
    expect(isTransientProviderError(Object.assign(new Error("Not Found"), { status: 404 }))).toBe(
      false,
    );
    // A 429 is handled by the dedicated rate-limit / usage-cap branches, never here.
    expect(
      isTransientProviderError(Object.assign(new Error("Too Many Requests"), { status: 429 })),
    ).toBe(false);
  });

  test("HTTP status is authoritative: a non-5xx status short-circuits, transient body or not", () => {
    // The Bugbot catch: a KNOWN 4xx whose body happens to read like a transient
    // fault must NOT fall through to the message heuristics and auto-retry forever.
    expect(
      isTransientProviderError(
        Object.assign(new Error("Connection error. (from a validation-rejected request)"), {
          status: 400,
        }),
      ),
    ).toBe(false);
    expect(
      isTransientProviderError(
        Object.assign(new Error("Our servers are currently overloaded."), {
          status: 404,
        }),
      ),
    ).toBe(false);
    // The mirror case: the SAME "connection error" body with NO status survives is
    // a genuine network fault and IS transient — the heuristics apply only here.
    expect(isTransientProviderError(new Error("Connection error."))).toBe(true);
  });

  test("agentRunFailurePayload marks transient provider errors retryable, keeping the body", () => {
    const overloaded = Object.assign(
      new Error("Our servers are currently overloaded. Please try again later."),
      { status: 503 },
    );
    expect(agentRunFailurePayload(overloaded)).toEqual({
      error: "Our servers are currently overloaded. Please try again later.",
      code: "provider_unavailable",
      retryable: true,
    });

    const generic500 = Object.assign(
      new Error(
        "An error occurred while processing your request. You can retry your request. " +
          "Please include the request ID 8afe928d.",
      ),
      { status: 500 },
    );
    const payload = agentRunFailurePayload(generic500);
    expect(payload.retryable).toBe(true);
    expect(payload.code).toBe("provider_unavailable");
    expect(payload.error).toContain("request ID 8afe928d");
  });

  test("agentRunFailurePayload still hard-fails a non-transient 4xx (no retryable marker)", () => {
    const validation = Object.assign(new Error("Invalid 'input': expected a string"), {
      status: 400,
    });
    const payload = agentRunFailurePayload(validation);
    expect(payload.retryable).toBeUndefined();
    expect(payload.code).toBeUndefined();
    expect(payload.error).toBe("Invalid 'input': expected a string");
  });

  test("agentRunFailurePayload reports the active-history envelope as deterministic", () => {
    expect(
      agentRunFailurePayload(new ActiveSessionHistoryLimitExceededError(2_048, 1_024)),
    ).toEqual({
      error:
        "The session's active conversation history exceeds the worker's safe materialization envelope. Clear the session context before retrying; an oversized history cannot be compacted safely in a serving worker.",
      code: "active_history_too_large",
      retryable: false,
      detail:
        "Active session history is 2048 UTF-8 JSON bytes, exceeding the 1024-byte materialization limit.",
    });
  });

  test("agentRunFailurePayload reports the approval RunState envelope as deterministic", () => {
    expect(
      agentRunFailurePayload(new ApprovalRunStateLimitExceededError("json_properties", 101, 100)),
    ).toEqual({
      error:
        "The saved approval state exceeds the worker's safe materialization envelope. Clear the pending approval context before retrying.",
      code: "approval_run_state_too_large",
      retryable: false,
      detail:
        "Approval run state has 101 decoded JSON object properties; the materialization limit is 100.",
    });
  });

  test("only transient provider compaction failures use same-turn recovery", () => {
    expect(
      shouldRecoverCompactionProviderFailure(
        new CompactionProviderResponseError({ httpStatus: 503, code: "server_error" }),
      ),
    ).toBe(true);
    expect(
      shouldRecoverCompactionProviderFailure(
        new CompactionProviderResponseError({
          httpStatus: 429,
          code: "rate_limit_exceeded",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRecoverCompactionProviderFailure(
        new CompactionProviderResponseError({
          httpStatus: 400,
          code: "context_length_exceeded",
        }),
      ),
    ).toBe(false);
    expect(shouldRecoverCompactionProviderFailure(new EmptyCompactionSummaryError())).toBe(false);
  });

  test("a 503 recovers the same turn after backpressure pacing, independent of goal state", () => {
    // Classifier → retryable, then the retryable turn-failure branch recovers the
    // accepted turn itself. No goal lookup or synthetic continuation is involved.
    const failure = agentRunFailurePayload(
      Object.assign(new Error("Our servers are currently overloaded. Please try again later."), {
        status: 503,
      }),
    );
    expect(failure.retryable).toBe(true); // enters the recovery branch (not the terminal one)
    expect(
      providerRecoveryResult({ failureCode: "provider_unavailable", attemptNumber: 1 }),
    ).toEqual({
      status: "recovering",
      continueDelayMs: 2_000,
    });
  });

  test("provider recovery backs off connectivity failures and honors rate-limit hints", () => {
    const expectedConnectivityBackoff = [
      { status: "recovering", continueDelayMs: 2_000 },
      { status: "recovering", continueDelayMs: 5_000 },
      { status: "recovering", continueDelayMs: 15_000 },
      { status: "recovering", continueDelayMs: 30_000 },
      { status: "recovering", continueDelayMs: 60_000 },
    ];
    for (const failureCode of [
      "provider_unavailable",
      "upstream_connectivity_unavailable",
      "sandbox_command_start_unavailable",
      "mcp_transport_timeout",
      "mcp_transport_unavailable",
      POST_COMPACTION_CONTINUATION_EMPTY_CODE,
    ]) {
      expect(
        [1, 2, 3, 4, 5].map((attemptNumber) =>
          providerRecoveryResult({ failureCode, attemptNumber }),
        ),
      ).toEqual(expectedConnectivityBackoff);
    }
    const exhausted = providerRecoveryResult({
      failureCode: "provider_unavailable",
      attemptNumber: MAX_AUTOMATIC_PROVIDER_RECOVERIES + 1,
    });
    expect(exhausted).toEqual({
      status: "exhausted",
      providerRecoveryCount: MAX_AUTOMATIC_PROVIDER_RECOVERIES,
      maxProviderRecoveryCount: MAX_AUTOMATIC_PROVIDER_RECOVERIES,
    });
    if (exhausted.status !== "exhausted") throw new Error("expected recovery exhaustion");
    expect(
      providerRecoveryExhaustedFailure(
        {
          error: "A required MCP server was temporarily unreachable.",
          code: "mcp_transport_unavailable",
          retryable: true,
        },
        exhausted,
      ),
    ).toMatchObject({
      code: "mcp_transport_unavailable",
      retryable: false,
      recoveryExhausted: true,
      providerRecoveryCount: MAX_AUTOMATIC_PROVIDER_RECOVERIES,
      maxProviderRecoveryCount: MAX_AUTOMATIC_PROVIDER_RECOVERIES,
      lastRetryableError: "A required MCP server was temporarily unreachable.",
    });
    expect(
      providerRecoveryResult({
        failureCode: "provider_rate_limited",
        attemptNumber: 1,
      }),
    ).toEqual({ status: "recovering", continueDelayMs: PROVIDER_BACKPRESSURE_DELAY_MS });
    expect(
      providerRecoveryResult({
        failureCode: "provider_rate_limited",
        attemptNumber: 1,
        retryAfterMs: 12_000,
      }),
    ).toEqual({ status: "recovering", continueDelayMs: 12_000 });
    expect(
      providerRecoveryResult({
        failureCode: "provider_unavailable",
        attemptNumber: 1,
        retryAfterMs: 7_000,
      }),
    ).toEqual({ status: "recovering", continueDelayMs: 7_000 });
    expect(
      providerRetryAfterMs(
        Object.assign(new Error("rate limited"), {
          headers: new Headers({ "retry-after": "7" }),
        }),
      ),
    ).toBe(7_000);
    expect(
      providerRetryAfterMs(
        Object.assign(new Error("gateway rate limited"), {
          responseHeaders: { "Retry-After": "9" },
        }),
      ),
    ).toBe(9_000);
    expect(providerRecoveryCountFromMetadata({})).toBe(0);
    expect(providerRecoveryCountFromMetadata({ providerRecoveryCount: 3 })).toBe(3);
    expect(providerRecoveryCountFromMetadata({ providerRecoveryCount: -1 })).toBe(0);
    expect(providerRecoveryCountAfterModelRequestPhase(4, "failed")).toBe(4);
    expect(providerRecoveryCountAfterModelRequestPhase(4, "first_byte")).toBe(4);
    expect(providerRecoveryCountAfterModelRequestPhase(4, "completed")).toBe(0);
  });

  test("isolates session-title subscription requests from main-turn lifecycle callbacks", () => {
    const getCodexToken = mock(async () => ({ accessToken: "codex-token", accountId: "acct" }));
    const refreshCodexToken = mock(async () => ({
      accessToken: "codex-token-2",
      accountId: "acct",
    }));
    const beforeProviderDispatch = mock(() => undefined);
    const codexContext: CodexRequestContext = {
      clientVersion: "test",
      sessionId: "session-id",
      getToken: getCodexToken,
      refresh: refreshCodexToken,
      resolveModel: (model) => model,
      onUsageHeaders: () => undefined,
      beforeProviderDispatch,
      onRequestPreparationDiagnostic: () => undefined,
      onModelRequestDiagnostic: () => undefined,
      onModelRequestEvent: () => undefined,
      onRequestOpaqueArtifacts: () => undefined,
      nextRequestId: () => "main-request",
      betaFeatures: ["main-only"],
      turnMetadata: { request_kind: "agent_turn" },
    };
    const titleCodexContext = sessionTitleCodexRequestContext(codexContext, () => "title-request");

    expect(titleCodexContext.getToken).toBe(getCodexToken);
    expect(titleCodexContext.refresh).toBe(refreshCodexToken);
    expect(titleCodexContext.nextRequestId?.()).toBe("title-request");
    expect(titleCodexContext.turnMetadata).toEqual({ request_kind: "session_title" });
    expect(titleCodexContext.onUsageHeaders).toBe(codexContext.onUsageHeaders);
    expect(titleCodexContext.beforeProviderDispatch).toBe(beforeProviderDispatch);
    expect(titleCodexContext.onRequestPreparationDiagnostic).toBeUndefined();
    expect(titleCodexContext.onModelRequestDiagnostic).toBeUndefined();
    expect(titleCodexContext.onModelRequestEvent).toBeUndefined();
    expect(titleCodexContext.onRequestOpaqueArtifacts).toBeUndefined();
    expect(titleCodexContext.betaFeatures).toBeUndefined();

    const getXaiToken = mock(async () => ({ accessToken: "xai-token", userId: "user" }));
    const refreshXaiToken = mock(async () => ({ accessToken: "xai-token-2", userId: "user" }));
    const xaiContext: XaiSubscriptionRequestContext = {
      clientVersion: "test",
      sessionId: "session-id",
      turnId: "turn-id",
      getToken: getXaiToken,
      refresh: refreshXaiToken,
      resolveModel: (model) => model,
      hostedSearch: { webSearch: true, xSearch: true },
      onFinalContextUsage: () => undefined,
      onModelRequestDiagnostic: () => undefined,
      onModelRequestEvent: () => undefined,
      nextRequestId: () => "main-xai-request",
      streamIdleTimeoutMs: 30_000,
    };
    const titleXaiContext = sessionTitleXaiRequestContext(xaiContext, () => "title-xai-request");

    expect(titleXaiContext.getToken).toBe(getXaiToken);
    expect(titleXaiContext.refresh).toBe(refreshXaiToken);
    expect(titleXaiContext.nextRequestId?.()).toBe("title-xai-request");
    expect(titleXaiContext.streamIdleTimeoutMs).toBe(30_000);
    expect(titleXaiContext.hostedSearch).toBeUndefined();
    expect(titleXaiContext.onFinalContextUsage).toBeUndefined();
    expect(titleXaiContext.onModelRequestDiagnostic).toBeUndefined();
    expect(titleXaiContext.onModelRequestEvent).toBeUndefined();
  });

  test("classifies only definitive marked SuperGrok account refusals for rotation", () => {
    const marked = (status: number, headers: HeadersInit = {}) =>
      Object.assign(new Error(`xAI request failed (${status})`), {
        status,
        headers: new Headers({
          ...Object.fromEntries(new Headers(headers).entries()),
          [XAI_SUBSCRIPTION_TRANSPORT_ERROR_HEADER]: "1",
        }),
      });
    expect(classifyXaiCredentialFailure(new XaiSubscriptionReloginRequired())).toEqual({
      kind: "auth",
      cooldownMs: null,
    });
    expect(classifyXaiCredentialFailure(marked(401))).toEqual({
      kind: "auth",
      cooldownMs: null,
    });
    expect(classifyXaiCredentialFailure(marked(403))).toEqual({
      kind: "forbidden",
      cooldownMs: null,
    });
    expect(classifyXaiCredentialFailure(marked(429, { "retry-after": "12" }))).toEqual({
      kind: "rate_limit",
      cooldownMs: 12_000,
    });
    expect(classifyXaiCredentialFailure(marked(503))).toBeNull();
    expect(
      classifyXaiCredentialFailure(Object.assign(new Error("unrelated 401"), { status: 401 })),
    ).toBeNull();
    expect(
      classifyXaiCredentialFailure(
        new XaiSubscriptionStreamingTerminalError({
          message:
            "The model is currently at capacity due to high demand. Please try again in a few minutes.",
          code: "response_error",
          eventType: "error",
          status: 502,
        }),
      ),
    ).toEqual({
      kind: "rate_limit",
      cooldownMs: 60_000,
    });
    expect(
      classifyXaiCredentialFailure(
        new XaiSubscriptionStreamingTerminalError({
          message: "Our servers are currently overloaded. Please try again later.",
          code: "response_error",
          eventType: "error",
          status: 502,
        }),
      ),
    ).toBeNull();
  });

  test("surfaces a stalled hosted-search continuation without unsafe replay", () => {
    expect(agentRunFailurePayload(new XaiSubscriptionHostedToolContinuationError())).toEqual({
      error:
        "SuperGrok stopped responding after its hosted search completed. Partial output was preserved; automatic replay is disabled because the accepted response may still have provider-side effects.",
      code: "xai_hosted_tool_continuation_stalled",
      retryable: false,
    });
  });

  test("persists the exact SuperGrok SSE terminal diagnostic on turn.failed", () => {
    const terminal = new XaiSubscriptionStreamingTerminalError({
      message: "SECRET context overflow after tool results",
      code: "invalid_request",
      eventType: "error",
      requestId: "req-secret",
      status: 400,
    });
    expect(agentRunFailurePayload(terminal)).toEqual({
      error: "SECRET context overflow after tool results",
      code: "invalid_request",
      retryable: false,
      lastEventType: "error",
      requestId: "req-secret",
    });
    expect(
      agentRunFailurePayload(
        Object.assign(new Error("Responses request terminated unsuccessfully (error)."), {
          cause: terminal,
        }),
      ),
    ).toMatchObject({
      error: "SECRET context overflow after tool results",
      code: "invalid_request",
    });
    expect(
      agentRunFailurePayload(
        new XaiSubscriptionStreamingTerminalError({
          message: "SECRET rate limited",
          code: "rate_limit_exceeded",
          eventType: "error",
          status: 429,
        }),
      ),
    ).toMatchObject({
      error: "SECRET rate limited",
      code: "rate_limit_exceeded",
      retryable: true,
    });
    expect(
      agentRunFailurePayload(
        new XaiSubscriptionStreamingTerminalError({
          message:
            "The model is currently at capacity due to high demand. Please try again in a few minutes.",
          code: "rate_limit_exceeded",
          eventType: "error",
          status: 429,
        }),
      ),
    ).toMatchObject({
      error:
        "The model is currently at capacity due to high demand. Please try again in a few minutes.",
      code: "rate_limit_exceeded",
      retryable: true,
      lastEventType: "error",
    });
  });

  test("surfaces a stalled SuperGrok stream with bounded correlation facts and no replay", () => {
    expect(
      agentRunFailurePayload(
        new XaiSubscriptionStreamIdleTimeoutError(
          "request-1",
          true,
          7,
          "response.output_text.delta",
          300_012,
        ),
      ),
    ).toEqual({
      error:
        "SuperGrok stopped sending valid response events. Partial output was preserved; automatic replay is disabled because the accepted response may still have provider-side effects.",
      code: "xai_response_stream_idle_timeout",
      retryable: false,
      responseObserved: true,
      eventCount: 7,
      silenceDurationMs: 300_012,
      requestId: "request-1",
      lastEventType: "response.output_text.delta",
    });
  });

  test("recognizes SDK statusCode when status is not present", () => {
    const transient = Object.assign(new Error("provider unavailable"), { statusCode: 503 });
    expect(isTransientProviderError(transient)).toBe(true);
    expect(agentRunFailurePayload(transient)).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
    expect(
      isTransientProviderError(
        Object.assign(new Error("invalid provider request"), { statusCode: 400 }),
      ),
    ).toBe(false);
  });

  test("agentRunFailurePayload keeps a ChatGPT/Codex usage cap non-retryable (429 that won't clear)", () => {
    // A usage cap is also a 429; the cap classifier runs BEFORE this transient
    // branch and must win, staying retryable:false. Shape mirrors the real
    // upstream payload (see codex-usage-limit.test.ts).
    const cap = Object.assign(new Error("429 You have hit your usage limit"), {
      status: 429,
      type: "usage_limit_reached",
      error: { type: "usage_limit_reached", resets_in_seconds: 7200 },
    });
    const payload = agentRunFailurePayload(cap);
    expect(payload.retryable).toBe(false);
    expect(payload.code).toBe("codex_usage_limit_reached");
  });
});

describe("structuredToolTransportForTurn", () => {
  const resolved = (
    kind: RegistryProviderKind,
    api: ModelProviderApi = "responses",
    options: {
      id?: string;
      wireProfile?: "openai" | "azure-openai";
      builtin?: boolean;
      baseUrl?: string;
    } = {},
  ) =>
    ({
      provider: {
        id: options.id ?? "registry",
        kind,
        api,
        wireProfile: options.wireProfile ?? "openai",
        builtin: options.builtin ?? false,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      },
    }) as Parameters<typeof structuredToolTransportForTurn>[0];

  test("keeps OpenAI-hosted tool types off connected subscriptions and Gateway paths", () => {
    expect(structuredToolTransportForTurn(resolved("codex-subscription"))).toBe(false);
    expect(structuredToolTransportForTurn(resolved("xai-subscription"))).toBe(false);
    expect(structuredToolTransportForTurn(resolved("vercel-gateway-managed"))).toBe(false);
    expect(structuredToolTransportForTurn(resolved("vercel-gateway-workspace"))).toBe(false);
  });

  test("keeps hosted sandbox tools off every Chat Completions provider", () => {
    expect(structuredToolTransportForTurn(resolved("anonymous", "chat"))).toBe(false);
    expect(structuredToolTransportForTurn(resolved("api-key", "chat"))).toBe(false);
  });

  test("preserves hosted tool types only for native OpenAI/Azure Responses providers", () => {
    expect(
      structuredToolTransportForTurn(
        resolved("api-key", "responses", { id: "openai", builtin: true }),
      ),
    ).toBe(true);
    expect(
      structuredToolTransportForTurn(
        resolved("api-key", "responses", { wireProfile: "azure-openai" }),
      ),
    ).toBe(true);
    expect(structuredToolTransportForTurn(null)).toBe(true);
  });

  test("keeps hosted apply_patch off OpenAI-compatible Responses endpoints", () => {
    expect(structuredToolTransportForTurn(resolved("anonymous"))).toBe(false);
    expect(structuredToolTransportForTurn(resolved("api-key"))).toBe(false);
    expect(
      structuredToolTransportForTurn(
        resolved("api-key", "responses", {
          id: "openai",
          builtin: true,
          baseUrl: "https://proxy.example.test/v1",
        }),
      ),
    ).toBe(false);
  });
});

describe("lazyToolTransportForTurn", () => {
  const resolved = (
    kind: RegistryProviderKind,
    api: ModelProviderApi,
    options: {
      id?: string;
      wireProfile?: "openai" | "azure-openai";
      builtin?: boolean;
      baseUrl?: string;
    } = {},
  ) =>
    ({
      provider: {
        id: options.id ?? "registry",
        kind,
        api,
        wireProfile: options.wireProfile ?? "openai",
        builtin: options.builtin ?? false,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      },
    }) as Parameters<typeof lazyToolTransportForTurn>[0];

  test("keeps Codex on its pristine native transport", () => {
    expect(lazyToolTransportForTurn(resolved("codex-subscription", "responses"))).toBe(
      "codex_native",
    );
  });

  test("uses native client search for direct OpenAI and every Azure Responses resource", () => {
    expect(
      lazyToolTransportForTurn(resolved("api-key", "responses", { id: "openai", builtin: true })),
    ).toBe("openai_native");
    expect(
      lazyToolTransportForTurn(
        resolved("api-key", "responses", {
          id: "azure",
          wireProfile: "azure-openai",
          builtin: true,
          baseUrl: "https://example.openai.azure.com/openai/v1",
        }),
      ),
    ).toBe("openai_native");
    expect(
      lazyToolTransportForTurn(
        resolved("api-key", "responses", {
          id: "azure-secondary",
          wireProfile: "azure-openai",
          baseUrl: "https://secondary.openai.azure.com/openai/v1",
        }),
      ),
    ).toBe("openai_native");
    expect(lazyToolTransportForTurn(null)).toBe("openai_native");
  });

  test("contains a built-in OpenAI custom endpoint behind generic dispatch", () => {
    expect(
      lazyToolTransportForTurn(
        resolved("api-key", "responses", {
          id: "openai",
          builtin: true,
          baseUrl: "https://proxy.example.test/v1",
        }),
      ),
    ).toBe("generic_dispatch");
  });

  test("contains Gateway and other providers behind generic dispatch", () => {
    expect(lazyToolTransportForTurn(resolved("xai-subscription", "responses"))).toBe(
      "generic_dispatch",
    );
    expect(lazyToolTransportForTurn(resolved("vercel-gateway-managed", "responses"))).toBe(
      "generic_dispatch",
    );
    expect(lazyToolTransportForTurn(resolved("vercel-gateway-workspace", "responses"))).toBe(
      "generic_dispatch",
    );
    expect(lazyToolTransportForTurn(resolved("anonymous", "chat"))).toBe("generic_dispatch");
    expect(lazyToolTransportForTurn(resolved("api-key", "chat"))).toBe("generic_dispatch");
  });
});

describe("shouldDeferNonEagerToolPreparation", () => {
  const eligible = {
    lazyToolTransport: "codex_native" as const,
    progressiveDisclosureEnabled: true,
    artifactRuntimeAvailable: false,
    triggerKind: "next" as const,
    triggerType: "user.message" as const,
  };

  test("overlaps only a brand-new lazy-capable turn", () => {
    expect(shouldDeferNonEagerToolPreparation(eligible)).toBe(true);
    expect(
      shouldDeferNonEagerToolPreparation({
        ...eligible,
        triggerType: "system.update.delivered",
      }),
    ).toBe(true);
  });

  test("keeps approval resumes and disabled disclosure eager while artifacts share the wait", () => {
    expect(shouldDeferNonEagerToolPreparation({ ...eligible, triggerKind: "approval" })).toBe(
      false,
    );
    expect(
      shouldDeferNonEagerToolPreparation({ ...eligible, artifactRuntimeAvailable: true }),
    ).toBe(true);
    expect(
      shouldDeferNonEagerToolPreparation({
        ...eligible,
        progressiveDisclosureEnabled: false,
      }),
    ).toBe(false);
  });
});

describe("hostedWebSearchForTurn (provider support)", () => {
  const resolved = (hostedWebSearch: boolean) =>
    ({ configured: { hostedWebSearch } }) as Parameters<typeof hostedWebSearchForTurn>[0];

  test("enables a supported provider without consulting the session MCP policy", () => {
    expect(hostedWebSearchForTurn(resolved(true), true)).toBe(true);
  });

  test("does not invent a fallback for an unsupported resolved provider", () => {
    expect(hostedWebSearchForTurn(resolved(false), true)).toBe(false);
  });

  test("applies the deployment capability gate to the legacy built-in path", () => {
    expect(hostedWebSearchForTurn(null, true)).toBe(true);
    expect(hostedWebSearchForTurn(null, false)).toBe(false);
  });
});

describe("connectedSubscriptionImageGenerationAuthority", () => {
  test("omits the optional tool when delegated model authority has no connected credential", () => {
    expect(connectedSubscriptionImageGenerationAuthority({}, null)).toBeNull();
    expect(connectedSubscriptionImageGenerationAuthority(null, "credential-id")).toBeNull();
  });

  test("exposes the optional tool only with both execution context and credential identity", () => {
    const context = { getToken: true };
    expect(connectedSubscriptionImageGenerationAuthority(context, "credential-id")).toEqual({
      credentialContext: context,
      credentialId: "credential-id",
    });
  });
});

describe("openAiHostedImageProviderBindingForTurn", () => {
  const direct = {
    provider: {
      id: "openai",
      kind: "api-key" as const,
      builtin: true,
      baseUrl: undefined,
    },
    configured: {
      capabilities: { hostedTools: { imageGeneration: { runnable: true } } },
    },
  };

  test("enables only the first-party OpenAI Responses endpoint", () => {
    const settings = testSettings({
      openaiProvider: "openai",
      openaiApiKey: "direct-key",
      openaiBaseUrl: undefined,
    });
    const binding = openAiHostedImageProviderBindingForTurn(settings, direct);
    expect(binding?.providerId).toBe("openai");
    expect(binding?.providerBindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      openAiHostedImageProviderBindingForTurn(
        { ...settings, openaiBaseUrl: "https://api.openai.com/v1/" },
        {
          provider: { ...direct.provider, baseUrl: "https://api.openai.com/v1" },
          configured: direct.configured,
        },
      ),
    ).toEqual(binding);
    expect(
      openAiHostedImageProviderBindingForTurn(settings, {
        provider: { ...direct.provider, baseUrl: "https://proxy.example/v1" },
        configured: direct.configured,
      }),
    ).toBeNull();
  });

  test("fails closed when the selected text model does not declare the hosted image tool", () => {
    const settings = testSettings({
      openaiProvider: "openai",
      openaiApiKey: "direct-key",
      openaiBaseUrl: undefined,
    });
    expect(
      openAiHostedImageProviderBindingForTurn(settings, {
        ...direct,
        configured: {
          capabilities: { hostedTools: { imageGeneration: { runnable: false } } },
        },
      }),
    ).toBeNull();
    expect(openAiHostedImageProviderBindingForTurn(settings, null)).toBeNull();
  });

  test("never assumes a custom legacy base URL supports the hosted image tool", () => {
    expect(
      openAiHostedImageProviderBindingForTurn(
        testSettings({
          openaiProvider: "openai",
          openaiApiKey: "direct-key",
          openaiBaseUrl: "https://proxy.example/v1",
        }),
        null,
      ),
    ).toBeNull();
  });
});

describe("modelAttachmentInputPolicyForTurn", () => {
  const resolved = (api: ModelProviderApi, image: boolean, files: string[] = []) =>
    ({
      provider: { api },
      configured: {
        capabilities: {
          inputModalities: image ? ["text", "image"] : ["text"],
          inputFileMediaTypes: files,
        },
      },
    }) as Parameters<typeof modelAttachmentInputPolicyForTurn>[0];

  test("never inlines document bytes as input_file", () => {
    expect(
      modelAttachmentInputPolicyForTurn(resolved("responses", true, ["application/pdf"])),
    ).toEqual({ supportsImageInput: true, inputFileMediaTypes: [] });
    expect(
      modelAttachmentInputPolicyForTurn(resolved("responses", false, ["application/pdf"])),
    ).toEqual({ supportsImageInput: false, inputFileMediaTypes: [] });
  });

  test("keeps chat-completions typed attachments on the sandbox-path fallback", () => {
    expect(modelAttachmentInputPolicyForTurn(resolved("chat", true, ["application/pdf"]))).toEqual({
      supportsImageInput: false,
      inputFileMediaTypes: [],
    });
  });
});

describe("objectStorageForSandboxDownloads", () => {
  const ambient = { kind: "ambient" } as const;
  const settings = testSettings({
    sandboxBackend: "docker",
    objectStorageBackend: "s3-compatible",
    objectStorageEndpoint: "http://127.0.0.1:9000",
    objectStorageSandboxEndpoint: "http://minio:9000",
    objectStorageAccessKeyId: "test",
    objectStorageSecretAccessKey: "test",
  });

  test("active selfhosted keeps the public endpoint even when session home is docker", () => {
    expect(objectStorageForSandboxDownloads(settings, ambient as never, "selfhosted")).toBe(
      ambient,
    );
  });

  test("docker rewrites s3-compatible signatures onto the sandbox MinIO host", () => {
    expect(objectStorageForSandboxDownloads(settings, ambient as never, "docker")).not.toBe(
      ambient,
    );
  });
});

describe("modelSupportsImageInputForTurn", () => {
  const resolved = (inputModalities: string[]) =>
    ({ configured: { capabilities: { inputModalities } } }) as Parameters<
      typeof modelSupportsImageInputForTurn
    >[0];

  test("derives image support only from the model capability contract", () => {
    expect(modelSupportsImageInputForTurn(null)).toBe(true);
    expect(modelSupportsImageInputForTurn(resolved(["text", "image"]))).toBe(true);
    expect(modelSupportsImageInputForTurn(resolved(["text"]))).toBe(false);
  });
});

describe("acceptsPromptCacheKeyForTurn", () => {
  const resolved = (kind: RegistryProviderKind, api: ModelProviderApi, builtin = false) =>
    ({ provider: { kind, api, builtin } }) as Parameters<typeof acceptsPromptCacheKeyForTurn>[0];

  test("accepts the legacy built-in OpenAI/Azure fallback", () => {
    expect(acceptsPromptCacheKeyForTurn(null)).toBe(true);
  });

  test("accepts built-in OpenAI/Azure providers and the codex backend", () => {
    expect(acceptsPromptCacheKeyForTurn(resolved("api-key", "responses", true))).toBe(true);
    expect(acceptsPromptCacheKeyForTurn(resolved("codex-subscription", "responses"))).toBe(true);
  });

  test("excludes registry providers such as Fireworks or Z.AI/GLM", () => {
    expect(acceptsPromptCacheKeyForTurn(resolved("api-key", "chat"))).toBe(false);
    expect(acceptsPromptCacheKeyForTurn(resolved("api-key", "responses"))).toBe(false);
  });
});

type RegistryProviderKind =
  | "api-key"
  | "codex-subscription"
  | "vercel-gateway-managed"
  | "vercel-gateway-workspace";
type ModelProviderApi = "responses" | "chat";
