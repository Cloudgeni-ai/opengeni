import {
  applySessionTurnSettlement,
  requestSessionTurnRecovery,
  claimSessionWorkForAttempt,
  applyCreditDebitUpToBalance,
  getBillingBalance,
  getRigName,
  getRigVersion,
  getSandbox,
  readActiveSandbox,
  setActiveSandbox,
  requireFile,
  getSessionEvent,
  getSessionRootId,
  getSessionGoal,
  getLatestRunState,
  getHumanInputResumeForEvent,
  getSessionHumanInputRequest,
  isCodexBilledTurn,
  workspaceCodexSubscriptionActive,
  acquireCodexCredentialLease,
  armCodexCapacityWait,
  heartbeatCodexCredentialLeaseUntil,
  releaseCodexCredentialLease,
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  getCodexRotationSettings,
  getWorkspaceModelPolicy,
  listCodexAccountStatuses,
  fetchCodexUsageForAccount,
  getSessionCodexState,
  recordSessionActiveCodexCredential,
  setSessionCodexPin,
  recordCodexAccountUsageWithWakeTargets,
  recordCodexAccountConnectors,
  quarantineCodexCredentialForLease,
  setActiveCodexCredential,
  resolveWorkspaceMemoryBlock,
  setCodexCredentialExhaustedWithWakeTargets,
  withCodexCapacityMutation,
  countConsecutiveReactiveRotations,
  requireSession,
  recordUsageEvent,
  registerPendingSessionToolCall,
  recordPendingSessionToolCallResult,
  clearDurablePendingSessionToolCalls,
  appendSessionHistoryItems,
  isSessionCompactionRequested,
  countSessionHistoryItems,
  getActiveSessionHistoryItems,
  nextSessionHistoryPosition,
  settleCodexCredentialLeaseLoss,
  settleCodexCredentialFailover,
  upsertSandboxSessionEnvelope,
  setSessionLastInputTokensForTurnAttempt,
  sumUsageQuantity,
  heartbeatLeaseHolder,
  accrueWarmSeconds,
  getMaterializedSandboxFileResources,
  markSandboxFileResourcesMaterialized,
  areGitHubRepositoriesAllowedForWorkspace,
  SandboxLeaseSupersededError,
  SandboxImageConflictError,
  isSessionEventPersistenceError,
  getEnrollment,
  abandonRecordingForTurnAttempt,
  markSessionAttemptQuiesced,
  type AppendEventInput,
  type ActiveSandboxPointer,
  type SandboxRecord,
  type CodexCredentialLeaseResult,
  type CodexCredentialLeaseSelectionContext,
  type ApplySessionTurnSettlementInput,
  type SessionTurnRecordingSettlement,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced, publishDurableSessionEvents } from "@opengeni/events";
import {
  sandboxStateEntryFromRunState,
  maxTurnsExceededRunState,
  modelCallUsageTelemetry,
  modelResponseUsageFromSdkEvent,
  normalizeSdkEvent,
  sanitizeHistoryItemsForModel,
  isEphemeralInternalContext,
  appendPersistentSessionSettings,
  appendSessionInstructions,
  appendWorkspaceMemory,
  composeAgentInstructions,
  summarizeForCompaction,
  CompactionProviderResponseError,
  EmptyCompactionSummaryError,
  ensureModalRegistryImage,
  findCompactionNeededError,
  materializeSandboxFileDownloads,
  materializeRunCredentials,
  clearRunCredentials,
  clearRunCredentialsForAttempt,
  withRunCredentialsSession,
  refreshGitCredentialBindingTokenFiles,
  refreshToolspaceTokenFile,
  toolspaceTokenFileFromEnvironment,
  sandboxFileDownloadFailureNote,
  SUMMARY_BUFFER_TOKENS,
  runOwnedSandboxSetup,
  swapTargetEstablishability,
  type SandboxFileDownload,
  type SandboxFileDownloadFailure,
  type OpenGeniRuntime,
  type ComputerToolMode,
  type ModelResponseUsage,
  type BuildAgentOptions,
  type TurnToolCancellationFence,
  type BackendUnresolvableCode,
  type EstablishedSandboxSession,
  type GitCredentialTokenWriterSession,
  type NormalizedRunCredentialMaterial,
  type RunCredentialCommandSession,
  type ToolspaceTokenWriterSession,
  deleteRecordingArtifacts,
  stopRecording as stopRecordingOnBox,
} from "@opengeni/runtime";
import { connectionTokenResolverForTurn } from "./mcp-credentials";
import {
  builtinProviderId,
  calculateModelUsageCostMicros,
  configuredModelPricing,
  configuredStaticUsageLimits,
  sandboxWarmRateMicrosPerSecond,
  settingsWithResolvedModelContext,
  type ModelUsageInput,
  type ModelProviderApi,
  type RegistryProviderKind,
  type Settings,
} from "@opengeni/config";
import { CancelledFailure } from "@temporalio/activity";
import {
  settingsWithCodexCredential,
  settingsWithEnabledCapabilityMcpServers,
  settingsWithSessionMcpServersForRun,
} from "./capabilities";
import {
  CODEX_USAGE_EXHAUSTED_PCT,
  authoritativeCodexCapacityResetAt,
  chooseRotationActive,
  classifyCodexPin,
  computeIdleDelayMs,
  computeReactiveRotationResume,
  shardCredentialForSession,
  earliestCodexReset,
  isCodexCredentialEligible,
  selectCodexCredentialLeaseForTurn,
  type CodexRotationStrategy,
  type RotationDecision,
} from "./codex-rotation";
import type { CodexAccountStatus } from "@opengeni/db";
import { buildCodexTokenResolver } from "./codex-auth";
import {
  refreshCodexUsageAndRepairCapacityWaiters,
  signalCodexCapacityWakeTargets,
  signalPendingCodexCapacityWakeTargets,
} from "./codex-capacity";
import {
  buildModelResolver,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  CodexReloginRequired,
  classifyCodexUsageLimitError,
  codexRequestStorage,
  isCodexTransportError,
  type CodexRequestContext,
  type CodexUsageHeaderSnapshot,
} from "@opengeni/codex";
import { mergeResourceRefs, mergeToolRefs } from "./common";
import { maybeCompactContext } from "./context-compaction";
import { TurnAttemptFencedError } from "./turn-attempt-fenced";
import {
  gitCredentialAuthorityForTurn,
  gitHubTokenMintSelections,
  loadWorkspaceEnvironmentForRunWithCredentials,
  mintSandboxToolspaceToken,
  mintRunGitCredentials,
  mintRunGitCredentialBinding,
  sandboxEnvironmentForRun,
  type GitHubTokenMintAuthorization,
  type MintedRunGitCredentials,
} from "./environment";
import {
  startGitCredentialRenewalLoop,
  type GitCredentialRenewalController,
} from "./git-credential-renewal";
import {
  RUN_CREDENTIAL_EXPIRY_LEAD_MS,
  startRunCredentialRenewalLoop,
  type RunCredentialRenewalController,
} from "./run-credential-renewal";
import {
  TOOLSPACE_TOKEN_EXPIRY_LEAD_MS,
  startToolspaceTokenRenewalLoop,
  type ToolspaceTokenRenewalController,
} from "./toolspace-token-renewal";
import {
  bindRunCredentialResolver,
  runCredentialAuthNeededPayloads,
  runCredentialModelNote,
} from "./run-credentials";
import { withCodexAppsTool, withFirstPartyTools } from "./goals";
import {
  mergeRigDefaultVariableSetEnvironment,
  resolveWorkspaceAgentInstructions,
  resolveWorkspacePackRuntime,
  settingsWithPackSandboxImage,
  settingsWithRigImage,
} from "./packs";
import { deliverFailedChildTurnToParent } from "./parent-wake";
import { createSecretRedactor, identityRedactor, type SecretForRedaction } from "./redaction";
import { applyCodexHistoryStrip, turnInput, type TurnCodexAccount } from "./run-input";
import {
  createRuntimeBatcher,
  currentActivityContext,
  nextStreamEvent,
  startActivityHeartbeat,
} from "./streaming";
import type {
  ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
  SessionAttemptQuiescenceProof,
} from "./types";
import {
  resumeBoxForTurn,
  acquireSelfhostedLeaseForTurn,
  sandboxLeaseHolderIdForAttempt,
  maybePersistWarmWorkspaceSnapshot,
  waitForWarmSnapshot,
  SandboxWarmingTimeoutError,
  type ResumedTurnSandbox,
  type TurnSandboxLeaseHolderId,
} from "../sandbox-resume";
import {
  wrapTurnBoxWithRouting,
  wrapLazyTurnBoxWithRouting,
  establishSelfhostedTurnSession,
  routingEnabled,
  lazyProvisionEnabled,
} from "../sandbox-routing";
import { makeTurnOpJournal, type TurnHeartbeatDetails } from "../op-journal";
import {
  makeMachineOpObserver,
  modelCallAccountContext,
  recordBatchFlush,
  recordContextCompaction,
  recordCreditMicros,
  recordModelCacheTokens,
  recordModelInputTokens,
  runtimeMetricsHooksForObservability,
  StreamTimingMetrics,
  turnLifecycleMetricsFor,
  type TurnOutcome,
} from "../observability-metrics";
import {
  beginRecording,
  discardUnpublishedRecording,
  prepareRecordingForSettlement,
  type ActiveRecording,
} from "./recording";
import { captureWorkspaceRevision } from "./workspace-capture";
import type { ChannelASession } from "@opengeni/runtime/sandbox";
import { createObjectStorage, type ObjectStorage } from "@opengeni/storage";
import {
  desktopCapableBackend,
  sandboxRunAs,
  WorkspaceModelPolicyBlockedError,
} from "@opengeni/runtime";
import {
  CAPABILITY_DESCRIPTORS,
  evaluateWorkspaceModelPolicy,
  type ResourceRef,
  type SessionEvent,
  type SessionEventType,
  type SessionStatus,
} from "@opengeni/contracts";
import { createHash, randomUUID } from "node:crypto";

// How long the session workflow holds the loop after a retryable provider
// failure before the goal continuation re-enters the model. Azure/OpenAI TPM
// throttling is minute-granular; anything shorter mostly burns continuation
// budget against the same window.
export const PROVIDER_BACKPRESSURE_DELAY_MS = 60_000;

/** A retryable provider fault recovers the accepted turn itself. Goal state is
 * irrelevant: autonomous continuation and infrastructure recovery are separate
 * concerns. */
export function providerRecoveryResult(): {
  status: "recovering";
  continueDelayMs: number;
} {
  return {
    status: "recovering",
    continueDelayMs: PROVIDER_BACKPRESSURE_DELAY_MS,
  };
}

/**
 * Resolve which Codex account a turn runs on (multi-account P1): session-pin >
 * workspace-active. No rotation in P1. The selected id must still be in the
 * connected set — a disconnected pin was FK-nulled, so a stale id can't appear,
 * but we guard anyway. Returns null when there is no usable account (the turn
 * then fails with the existing relogin error path).
 */
export function selectCodexCredentialForTurn(args: {
  sessionPinnedCredentialId: string | null;
  activeCredentialId: string | null;
  connectedIds: Set<string>;
}): string | null {
  const { sessionPinnedCredentialId: pin, activeCredentialId: active, connectedIds } = args;
  if (pin && connectedIds.has(pin)) {
    return pin;
  }
  if (active && connectedIds.has(active)) {
    return active;
  }
  return null;
}

export function filterUnmaterializedSandboxFileDownloads(
  downloads: SandboxFileDownload[],
  materializedFileIds: Set<string>,
): SandboxFileDownload[] {
  if (downloads.length === 0 || materializedFileIds.size === 0) {
    return downloads;
  }
  return downloads.filter((download) => !materializedFileIds.has(download.fileId));
}

/** Fixed-length one-way tenant correlation for metrics/alerts; never a raw id. */
export function codexWorkspaceMetricKey(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
}

/** Stable public request identity across partial resumes and activity retries. */
export function stableHumanInputRequestId(
  sessionId: string,
  turnId: string,
  toolCallId: string,
): string {
  const hex = createHash("sha256")
    .update("opengeni-human-input-v1\0")
    .update(sessionId)
    .update("\0")
    .update(turnId)
    .update("\0")
    .update(toolCallId)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * True when this activity attempt was cancelled because its hosting worker is
 * shutting down gracefully (SIGTERM during a deploy), as opposed to a
 * workflow-requested Pause/Steer cancellation or a server-side timeout.
 */
export function isWorkerShutdownCancellation(error: unknown): boolean {
  return error instanceof CancelledFailure && error.message === "WORKER_SHUTDOWN";
}

/**
 * Review captures and protective snapshots are cache/persistence housekeeping,
 * never part of cancellation correctness. A control-fenced or Temporal-cancelled
 * attempt must release its physical activity promptly so Steer/Pause can advance.
 */
export function shouldRunTurnEndWorkspacePersistence(input: {
  activityStatus: RunAgentTurnResult["status"] | "unknown";
  cancellationRequested: boolean;
}): boolean {
  return input.activityStatus !== "cancelled" && !input.cancellationRequested;
}

/**
 * Temporal cancellation is delivery/transport state, never proof that the
 * dying activity crossed its mandatory sandbox-tool fence. If that fence
 * fails, surface the fence failure instead of retaining a misleading typed
 * cancellation; replacement admission remains closed because no durable
 * quiescence receipt was written.
 */
export function assertPhysicalToolQuiescenceForCancellation(input: {
  acknowledgeQuiescence: boolean;
  physicalToolQuiescenceConfirmed: boolean;
  failure: unknown;
}): void {
  if (!input.acknowledgeQuiescence || input.physicalToolQuiescenceConfirmed) return;
  if (input.failure instanceof Error) throw input.failure;
  throw new Error("Physical sandbox-tool quiescence could not be confirmed", {
    cause: input.failure,
  });
}

/** A physically drained attempt must leave one durable recovery producer. The
 * direct Postgres receipt is preferred; after its bounded retries exhaust, an
 * exact Temporal proof signal is sufficient because the workflow persists it
 * through an independently retrying DB-only control activity. */
export function assertSessionAttemptQuiescenceRecoveryDurable(input: {
  acknowledgeQuiescence: boolean;
  physicalToolQuiescenceConfirmed: boolean;
  receiptOrProofDurable: boolean;
  failure: unknown;
}): void {
  if (
    !input.acknowledgeQuiescence ||
    !input.physicalToolQuiescenceConfirmed ||
    input.receiptOrProofDurable
  ) {
    return;
  }
  if (input.failure instanceof Error) throw input.failure;
  throw new Error("Physical quiescence had no durable receipt or recovery proof", {
    cause: input.failure,
  });
}

const QUIESCENCE_PROOF_SIGNAL_INITIAL_RETRY_MS = 250;
const QUIESCENCE_PROOF_SIGNAL_MAX_RETRY_MS = 5_000;

/** Persist the authoritative receipt or durably hand the exact physical proof
 * to Temporal. This retries signal delivery, not DB eligibility or workflow
 * state. The proof object never changes between attempts. */
export async function persistOrSignalSessionAttemptQuiescence(input: {
  proof: SessionAttemptQuiescenceProof;
  persistReceipt: () => Promise<SessionEvent[]>;
  publishEvents: (events: SessionEvent[]) => Promise<unknown>;
  signalProof: ActivityServices["signalSessionAttemptQuiesced"];
  sleep?: (ms: number) => Promise<void>;
  heartbeat?: (attempt: number, delayMs: number) => void;
  onReceiptFailure?: (error: unknown) => void;
  onPublishFailure?: (error: unknown) => void;
  onSignalFailure?: (error: unknown, attempt: number, delayMs: number) => void;
}): Promise<"receipt" | "signal"> {
  let events: SessionEvent[];
  try {
    events = await input.persistReceipt();
  } catch (receiptError) {
    input.onReceiptFailure?.(receiptError);
    if (!input.signalProof) {
      throw new Error("Session-attempt quiescence proof signaler is unavailable", {
        cause: receiptError,
      });
    }
    const delay = input.sleep ?? sleep;
    let retryMs = QUIESCENCE_PROOF_SIGNAL_INITIAL_RETRY_MS;
    let attempt = 1;
    for (;;) {
      try {
        await input.signalProof(input.proof);
        return "signal";
      } catch (signalError) {
        input.onSignalFailure?.(signalError, attempt, retryMs);
        try {
          input.heartbeat?.(attempt, retryMs);
        } catch {
          // Heartbeat telemetry is not proof delivery and cannot replace or
          // interrupt the exact signal retry loop.
        }
        await delay(retryMs);
        retryMs = Math.min(retryMs * 2, QUIESCENCE_PROOF_SIGNAL_MAX_RETRY_MS);
        attempt += 1;
      }
    }
  }

  try {
    await input.publishEvents(events);
  } catch (publishError) {
    // Postgres already committed quiesced_at, the queue event, and the wake.
    // NATS is live fanout only; never misclassify its failure as receipt loss.
    input.onPublishFailure?.(publishError);
  }
  return "receipt";
}

/**
 * Await a finalizer operation only while this Temporal activity still owns its
 * execution window. Once Pause/Steer cancellation arrives, the operation keeps
 * its own rejection handler and may finish its idempotent, attempt-scoped
 * cleanup in the background, but it cannot pin activity terminalization or
 * delay the separately receipt-gated replacement dispatch.
 */
export async function waitForTurnFinalizerStep<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (!signal) return await operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return undefined;
  }

  let resolveCancellation: (() => void) | undefined;
  const cancelled = new Promise<undefined>((resolve) => {
    resolveCancellation = () => resolve(undefined);
  });
  const cancel = (): void => {
    void operation.catch(() => undefined);
    resolveCancellation?.();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * Flush provider-facing stream state while the attempt still owns its activity
 * window. On Pause/Steer, both promises are detached with rejection handlers:
 * neither a runtime batcher nor an uncooperative provider completion promise
 * may pin the activity behind cancellation after durable writes are fenced.
 */
export async function waitForTurnStreamCleanup(
  batcherFlush: Promise<unknown>,
  providerCompleted: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  await waitForTurnFinalizerStep(batcherFlush, signal);
  await waitForTurnFinalizerStep(providerCompleted, signal);
}

function turnFinalizerCancellationSignal(
  temporalSignal: AbortSignal | undefined,
  activityStatus: RunAgentTurnResult["status"] | "unknown",
): AbortSignal | undefined {
  if (activityStatus !== "cancelled" || temporalSignal?.aborted) return temporalSignal;
  const fenced = new AbortController();
  fenced.abort(new Error("TURN_ATTEMPT_FENCED"));
  return fenced.signal;
}

function compactionFailureReason(reason: string): string {
  return reason.startsWith("compaction summarization failed:")
    ? reason
    : `compaction summarization failed: ${reason}`;
}

function compactionFailureReasonFromError(error: unknown): string {
  if (
    error instanceof CompactionProviderResponseError ||
    error instanceof EmptyCompactionSummaryError
  ) {
    return compactionFailureReason(error.message);
  }
  const errorName = error instanceof Error && error.name ? error.name : "unknown error";
  return compactionFailureReason(`unexpected ${errorName}`);
}

function isCompactionSummaryFailure(error: unknown): boolean {
  return (
    error instanceof CompactionProviderResponseError || error instanceof EmptyCompactionSummaryError
  );
}

export function shouldRecoverCompactionProviderFailure(error: unknown): boolean {
  if (!(error instanceof CompactionProviderResponseError)) return false;
  if (isCodexTransportError(error) && classifyCodexUsageLimitError(error)) return true;
  return agentRunFailurePayload(error).retryable === true;
}

export function classifyContextWindowOverflowError(
  error: unknown,
): { message: string; code?: string; detail?: string } | null {
  const fields = collectErrorStrings(error);
  const matched = fields.find(
    (value) =>
      /context[_\s-]*length[_\s-]*exceeded/i.test(value) ||
      /exceeds?\s+(?:the\s+)?context\s+window/i.test(value) ||
      /maximum\s+context\s+length/i.test(value) ||
      /context\s+window[^.]*exceed/i.test(value),
  );
  if (!matched) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = fields.find((value) => /context[_\s-]*length[_\s-]*exceeded/i.test(value));
  return {
    message,
    ...(code ? { code } : {}),
    ...(matched && matched !== message ? { detail: matched } : {}),
  };
}

/**
 * Recognize an MCP transport/request timeout that escaped the SDK's per-tool
 * `mcpConfig.errorFunction` boundary. A thrown tool invocation is normally
 * converted to an `{isError:true}` tool output; however, connect/tools-list or
 * next-loop transport work can reject the stream iterator after a prior tool
 * output was already published. That is transient external backpressure, not a
 * terminal session error. Match MCP-qualified timeout text only: an unrelated
 * sandbox/model timeout and MCP's `-32001 Authentication required` signal must
 * retain their existing semantics.
 */
export function classifyMcpTransportTimeoutError(
  error: unknown,
): { message: string; detail?: string } | null {
  const fields = collectErrorStrings(error);
  const matched = fields.find(
    (value) =>
      /\bmcp\b/i.test(value) &&
      /(?:request\s+timed\s+out|request\s+timeout|\btimed\s+out\b|\btimeout\b|ETIMEDOUT)/i.test(
        value,
      ) &&
      !/authentication\s+required/i.test(value),
  );
  if (!matched) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    ...(matched !== message ? { detail: matched } : {}),
  };
}

function collectErrorStrings(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  const out: string[] = [];
  const record = value as Record<string, unknown>;
  for (const key of ["message", "code", "type", "name", "param"]) {
    const field = record[key];
    if (typeof field === "string" && field.length > 0) {
      out.push(field);
    }
  }
  for (const key of ["error", "cause", "response", "data"]) {
    out.push(...collectErrorStrings(record[key], seen));
  }
  return out;
}

/**
 * Compute the conversation-truth rows a reconcile pass should append, given the
 * SDK's current `state.history` and the count already persisted.
 *
 * `state.history` is a computed getter that runs the SDK's orphan-tool-call
 * pruning on every access, so it is non-monotonic: a `function_call` with no
 * settling result yet is transiently absent and a later access yields a
 * different, possibly shorter/reordered list. The old code sliced this list by
 * a blind length watermark and appended at fixed positions with
 * onConflictDoNothing, which could freeze a position with one shape and later
 * persist a `function_call_result` whose `function_call` had been pruned away in
 * an earlier slice — the orphaned tool output that 400s the Responses API and
 * bricks the session on every replay.
 *
 * Defending: sanitize the full current history into an API-valid sequence (the
 * same pure rules the read path uses), then append only the new tail beyond the
 * watermark. A trailing dangling call is dropped here and re-evaluated next
 * pass once its result lands, so a call and its result are written together at
 * consecutive positions and a result is never persisted without its call. The
 * watermark advances to the sanitized length — never past anything unwritten —
 * so a non-monotonic history can never desync it. When previously-persisted
 * rows already exceed the sanitized length (e.g. legacy orphans written before
 * this fix), nothing new is appended and the watermark holds steady.
 */
/**
 * Stable+unique usage source key for one model call, used to build the per-call
 * idempotency key (`usage:model.tokens:${turnId}:${sourceKey}`). The turnId is
 * shared across a new attempt of the SAME turn (recovery, approval
 * rerun, activity retry), so the sourceKey alone must distinguish calls.
 *
 * - A provider responseId is globally stable+unique, so reuse it verbatim: a
 *   true activity retry that re-emits the same responseId correctly DEDUPES
 *   (one charge), while two distinct calls get distinct ids.
 * - Without a responseId the old synthesized key was only POSITIONAL ("response-1",
 *   "aggregate"), which collides across a re-dispatch — dispatch B's first
 *   call reuses dispatch A's "response-1" key and its charge is silently
 *   dropped (undercharge). Qualifying the synthesized key with the
 *   per-execution dispatch id (the Temporal activityId, unique per scheduled
 *   execution) makes re-dispatched calls distinct while still deduping a
 *   same-execution retry.
 */
export function modelUsageSourceKey(input: {
  responseId?: string | null | undefined;
  dispatchId: string | null;
  positionalKey: string;
}): string {
  if (input.responseId) {
    return input.responseId;
  }
  return input.dispatchId ? `${input.dispatchId}:${input.positionalKey}` : input.positionalKey;
}

export function providerContextTokens(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | null
    | undefined,
): number | null {
  const total = usage?.totalTokens;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) {
    return total;
  }
  const input = usage?.inputTokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return null;
  }
  const output = usage?.outputTokens;
  return input + (typeof output === "number" && Number.isFinite(output) && output > 0 ? output : 0);
}

/**
 * A provider call has already consumed tokens by the time its usage frame is
 * available. Losing the Codex credential lease at the renewal checkpoint must
 * stop the result from becoming authoritative, but it must not erase accounting
 * truth for the call that already happened. Meter first, then surface the lost
 * lease, then write attempt-owned token/context signals. A replaced attempt can
 * reject those signals without erasing the provider usage already incurred.
 */
export async function recordCompletedModelCallBeforeOwnershipFences(input: {
  renewLease: () => Promise<void>;
  recordUsage: () => Promise<void>;
  leaseLost: () => boolean;
  leaseLostMessage: string;
  recordAttemptSignals?: () => Promise<void>;
}): Promise<void> {
  await input.renewLease();
  await input.recordUsage();
  if (input.leaseLost()) {
    throw new Error(input.leaseLostMessage);
  }
  await input.recordAttemptSignals?.();
}

type TurnEventPublisher = (
  events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>,
  immediate?: boolean,
) => Promise<{ events: SessionEvent[]; accepted: boolean }>;

export async function emitModelCallUsage(input: {
  observability: ActivityServices["observability"];
  publish: TurnEventPublisher | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  provider: string;
  providerApi: ModelProviderApi;
  model: string;
  sourceKey: string;
  usage: ModelResponseUsage | { usage?: unknown | null } | null;
  // Prompt-cache research dimensions (log-only; NEVER on a metric label or a
  // durable event). The opaque serving-account tag and whether it changed since
  // the session's previous call — the account-switch hypothesis for cache misses.
  servingAccountHash?: string;
  accountChangedFromPrevCall?: boolean;
  emittedSourceKeys?: Set<string>;
}): Promise<void> {
  const usage =
    input.usage && typeof input.usage === "object" && "usage" in input.usage
      ? (input.usage as { usage?: unknown }).usage
      : null;
  if (!usage || typeof usage !== "object") {
    return;
  }
  if (input.emittedSourceKeys?.has(input.sourceKey)) return;
  const telemetry = modelCallUsageTelemetry(usage as Parameters<typeof modelCallUsageTelemetry>[0]);
  const appended = await input.publish?.(
    [
      {
        type: "agent.model.usage",
        payload: {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          provider: input.provider,
          providerApi: input.providerApi,
          model: input.model,
          sourceKey: input.sourceKey,
          ...telemetry,
        },
      },
    ],
    true,
  );
  input.emittedSourceKeys?.add(input.sourceKey);
  const authoritative = appended?.events.some(
    (event) =>
      event.type === "agent.model.usage" &&
      event.turnAssociation === "current" &&
      event.payload !== null &&
      typeof event.payload === "object" &&
      (event.payload as Record<string, unknown>).sourceKey === input.sourceKey,
  );
  if (!authoritative) return;
  try {
    input.observability.info("model call usage", {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      provider: input.provider,
      providerApi: input.providerApi,
      model: input.model,
      sourceKey: input.sourceKey,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      cachedTokens: telemetry.cachedTokens,
      reasoningTokens: telemetry.reasoningTokens,
      ...(input.servingAccountHash !== undefined
        ? { servingAccountHash: input.servingAccountHash }
        : {}),
      ...(input.accountChangedFromPrevCall !== undefined
        ? { accountChangedFromPrevCall: input.accountChangedFromPrevCall }
        : {}),
    });
  } catch {
    // Durable event + billing already committed; logging is best-effort only.
  }
}

export function historyRowsToAppend(
  rawHistory: Array<Record<string, unknown>>,
  // How many items of the CURRENT in-memory history are already persisted (the
  // slice index into `sanitized`). This is the in-memory history length, NOT the
  // total persisted-row count: after a compaction the in-memory history is the
  // short [summary, ...tail, ...new] list, far shorter than the total rows in
  // the table (which still hold the superseded prefix).
  persistedHistoryCount: number,
  // Next free WHOLE-NUMBER absolute position to write at. Decoupled from the
  // slice index because compaction inserts a fractional summary position, so the
  // total-row count no longer equals max(position)+1. Defaults to
  // persistedHistoryCount to preserve the pre-compaction behaviour (contiguous
  // positions from 0) when callers do not pass an explicit next position.
  nextPosition: number = persistedHistoryCount,
  toolOutputTruncationTokens?: number,
): {
  rows: Array<{ position: number; item: Record<string, unknown> }>;
  nextWatermark: number;
  nextPosition: number;
} {
  const sanitized = sanitizeHistoryItemsForModel(rawHistory, toolOutputTruncationTokens).filter(
    (item) => !isEphemeralInternalContext(item),
  );
  if (sanitized.length <= persistedHistoryCount) {
    return { rows: [], nextWatermark: persistedHistoryCount, nextPosition };
  }
  const rows = sanitized.slice(persistedHistoryCount).map((item, offset) => ({
    position: nextPosition + offset,
    item: item as Record<string, unknown>,
  }));
  return {
    rows,
    nextWatermark: sanitized.length,
    nextPosition: nextPosition + rows.length,
  };
}

function isModelOrToolProgressHistoryItem(item: Record<string, unknown>): boolean {
  if (item.type === "message") {
    return item.role === "assistant";
  }
  if (item.type === "reasoning" || item.type === "compaction") {
    return true;
  }
  if (typeof item.type === "string") {
    return item.type !== "message";
  }
  return false;
}

/**
 * Seed the turn-end reconcile watermark (`persistedHistoryCount`) from EXACTLY the
 * view `state.history` was seeded from, so the model-input length and the watermark
 * can NEVER disagree. The watermark is the slice index the reconcile cuts the
 * (re-sanitized) `state.history` at to find this turn's genuinely-new items, so it
 * must equal the length of `state.history`'s already-persisted leading prefix.
 *
 * The cross-account reasoning strip drops foreign reasoning items, so the prefix
 * length is PATH-DEPENDENT, captured by `modelHistoryFromItems`:
 *
 *  - items read path (`modelHistoryFromItems === true`) — `state.history` was seeded
 *    from the cross-account-STRIPPED active items (foreign reasoning DROPPED), so it
 *    starts K shorter than the raw active-row count. Seed from the SAME strip
 *    (HOLE D); seeding from the un-stripped count would slice K genuinely-new items
 *    off the reconcile and silently lose them (incl. the user's switch-turn message).
 *
 *  - approval RunState path (`modelHistoryFromItems === false`) — `state.history` was seeded
 *    from the blob, where foreign reasoning is NEUTRALIZED-IN-PLACE (the item is
 *    KEPT, only its id/encrypted_content go — see resumeRunStateForCodexAccount), so
 *    the blob's history length still COUNTS those items. Applying the strip here
 *    under-counts by K and the reconcile re-appends K already-persisted items at
 *    fresh positions — HOLE E. So the blob path must NOT strip: count the raw
 *    sanitized active length, which mirrors the blob's completed prefix.
 *
 * On a same-account / non-codex turn the strip is a no-op, so both branches reduce
 * to the same raw sanitized count (byte-identical to the pre-strip behaviour).
 * Pure; exported for unit testing the D/E seed invariant.
 */
export function reconcileSeedCount(
  activeSeedRows: ReadonlyArray<{
    item: Record<string, unknown>;
    producerCodexCredentialId: string | null;
  }>,
  modelHistoryFromItems: boolean,
  current: TurnCodexAccount,
): number {
  return sanitizeHistoryItemsForModel(
    modelHistoryFromItems
      ? applyCodexHistoryStrip(activeSeedRows, current)
      : activeSeedRows.map((row) => row.item),
  ).length;
}

/**
 * Resolve the EFFECTIVE/active compute backend a turn should gate
 * filesystem-touching agent lifecycle hooks on (today: the repository clone).
 *
 * WHY (Case B — clone-onto-real-disk hazard): a session keeps its CLOUD HOME
 * backend (`settings.sandboxBackend`, e.g. "modal") but its ACTIVE sandbox may
 * have been swapped to a connected machine (`active_sandbox_id` → a selfhosted
 * lease). `runtime.buildAgent`'s repository-clone hook keys off the backend it is
 * told; if the worker passes nothing it defaults to the HOME backend and the hook
 * would `git clone` a private GitHub-App repo onto the user's REAL disk — a
 * bring-your-own machine owns its own filesystem and must NEVER be cloned onto. So
 * we look at where the agent ACTUALLY runs, not where the session was created.
 *
 * Returns "selfhosted" ONLY when the selfhosted feature is on AND the session has
 * a non-null active pointer whose sandbox `kind` is "selfhosted". Otherwise
 * returns undefined so buildAgent falls back to the home backend — byte-for-byte
 * unchanged cloud behavior.
 *
 * Total + best-effort by contract: it NEVER throws (a lookup failure is logged and
 * falls back to the home default), so wiring it at turn start can't fail the turn.
 * The DB I/O is injected (the real call site passes readActiveSandbox + getSandbox,
 * the same helpers wrapTurnBoxWithRouting reuses) so the gate/decision/safety
 * contract is unit-testable without a live database.
 */
export async function resolveActiveSandboxBackend(
  routingOn: boolean,
  loadPointer: () => Promise<{ activeSandboxId: string | null } | null>,
  loadSandboxKind: (sandboxId: string) => Promise<string | null>,
): Promise<Settings["sandboxBackend"] | undefined> {
  // The active pointer + swap tools only exist when selfhosted routing is on; with
  // the flag off there is nothing to resolve and we keep the home-backend default.
  if (!routingOn) {
    return undefined;
  }
  try {
    const pointer = await loadPointer();
    // A null pointer (no swap) means "use the session's own cloud group box" — the
    // home backend already governs that path, so leave the override unset.
    if (!pointer?.activeSandboxId) {
      return undefined;
    }
    const kind = await loadSandboxKind(pointer.activeSandboxId);
    return kind === "selfhosted" ? "selfhosted" : undefined;
  } catch (error) {
    console.error(
      "active sandbox backend resolution failed (turn proceeds on home backend)",
      error,
    );
    return undefined;
  }
}

/**
 * Classify a persisted active-sandbox pointer for TURN-START RECONCILE (issue #341
 * invariant B). Returns the typed reason to RESET the pointer to the session HOME,
 * or null to leave it in place. STRUCTURAL unestablishability only:
 *   - no record → the pointed-at sandbox row is gone (`stale_pointer`);
 *   - an unestablishable kind (a non-group Modal sibling, or an unknown backend) per
 *     the SHARED `swapTargetEstablishability` predicate (`unsupported_backend_context`);
 *   - a selfhosted sandbox with no enrollment id to address (`offline_enrollment`).
 * A selfhosted sandbox WITH an enrollment is deliberately left in place even when it
 * is momentarily offline: the machine may recover mid-turn and its ops surface
 * agent_offline lazily, so the user's explicit machine target is never abandoned for
 * a transient control-plane blip (that is #339's concern, not this one).
 */
export function pointerReconcileReason(
  record: { kind: string; enrollmentId: string | null } | null,
): BackendUnresolvableCode | null {
  if (!record) {
    return "stale_pointer";
  }
  const establishable = swapTargetEstablishability({
    kind: record.kind,
    isSessionGroup: false,
  });
  if (!establishable.ok) {
    return establishable.code;
  }
  if (record.kind === "selfhosted" && !record.enrollmentId) {
    return "offline_enrollment";
  }
  return null;
}

/** The active pointer + its sandbox row, loaded once at turn start and threaded
 *  through the reconcile so the establish branch reads the SAME (possibly reset)
 *  values with no second query. */
export type LoadedActivePointer = {
  pointer: ActiveSandboxPointer | null;
  record: SandboxRecord | null;
};

/**
 * TURN-START RECONCILE (issue #341 invariant B / Shapes 1+2). If the persisted pointer's
 * target is STRUCTURALLY unestablishable ({@link pointerReconcileReason}) reset the pointer
 * to the session HOME (null) under the epoch fence, emit a VISIBLE `session.route.reconciled`
 * event, and return the reconciled pointer/record so the rest of the turn runs on home. NEVER
 * a silent downgrade. Bounded to ONE attempt: a lost CAS means a concurrent user swap won a
 * higher epoch, so re-read + honor it rather than clobber a newer, user-directed pointer. The
 * event publish is best-effort — a publish failure never fails the turn.
 *
 * FAIL-OPEN on a lookup failure (issue #341 review): the sandbox row is fetched HERE via the
 * caller's NON-swallowing `loadRecord`, so a null decision means the row is genuinely absent,
 * never a suppressed transient DB error. If `loadRecord` THROWS, reconciliation is skipped
 * entirely this turn — the pointer is left UNTOUCHED (record null → the turn runs
 * machinePrimary:false on the group box exactly as before reconcile existed), no CAS, no
 * event — and the next turn retries. A TRANSIENT LOOKUP FAILURE MUST NEVER MUTATE THE POINTER.
 */
export async function reconcileActiveSandboxPointer(
  db: ActivityServices["db"],
  ids: { accountId: string; workspaceId: string; sessionId: string },
  pointer: ActiveSandboxPointer | null,
  loadRecord: (sandboxId: string) => Promise<SandboxRecord | null>,
  publish?: (events: Array<{ type: SessionEventType; payload: unknown }>) => Promise<void> | void,
): Promise<LoadedActivePointer> {
  if (!pointer?.activeSandboxId) {
    return { pointer, record: null };
  }
  // Re-fetch the row WITHOUT error swallowing. A throw here (a transient DB blip) is NOT
  // "row absent": fail open — skip reconciliation, leave the pointer untouched.
  let record: SandboxRecord | null;
  try {
    record = await loadRecord(pointer.activeSandboxId);
  } catch {
    return { pointer, record: null };
  }
  const reason = pointerReconcileReason(record);
  if (!reason) {
    return { pointer, record };
  }
  const fromEpoch = pointer.activeEpoch;
  const reset = await setActiveSandbox(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sessionId: ids.sessionId,
    targetSandboxId: null,
    expectedEpoch: fromEpoch,
  }).catch(
    () => ({ swapped: false, pointer: null }) as Awaited<ReturnType<typeof setActiveSandbox>>,
  );
  if (reset.swapped && reset.pointer) {
    await Promise.resolve(
      publish?.([
        {
          type: "session.route.reconciled",
          payload: { reason, fromEpoch, toEpoch: reset.pointer.activeEpoch },
        },
      ]),
    ).catch(() => undefined);
    return { pointer: reset.pointer, record: null };
  }
  // The fence was lost: a concurrent higher-epoch swap won. Honor the newer pointer; its
  // record is re-fetched fail-open too (a transient failure leaves record null, never a
  // mutation — we already did not win the CAS).
  const reread = await readActiveSandbox(db, ids.workspaceId, ids.sessionId).catch(() => null);
  if (!reread) {
    return { pointer, record: null };
  }
  let rereadRecord: SandboxRecord | null = null;
  if (reread.activeSandboxId) {
    try {
      rereadRecord = await loadRecord(reread.activeSandboxId);
    } catch {
      rereadRecord = null;
    }
  }
  return { pointer: reread, record: rereadRecord };
}

/**
 * Warm the Modal private-registry image for the image ref this turn actually
 * resolved, not only the deployment-global OPENGENI_MODAL_IMAGE_REF warmed at
 * worker boot. Packs can override `modalImageRef` per workspace/turn, so a
 * private pack image must be resolved before sandbox creation or Modal falls
 * back to the unauthenticated `fromTag` path.
 */
export async function ensureTurnModalRegistryImage(
  runSettings: Settings,
  sandboxCreationBackend: Settings["sandboxBackend"] | undefined,
  ensureRegistryImage: (settings: Settings) => Promise<void> = ensureModalRegistryImage,
): Promise<void> {
  if (sandboxCreationBackend !== "modal") {
    return;
  }
  if (!runSettings.modalImageRegistrySecret || !runSettings.modalImageRef) {
    return;
  }
  await ensureRegistryImage(runSettings);
}

/**
 * Decide whether the first actual computer action may start a proof recording.
 *
 * On-turn recording runs ffmpeg/x11grab INSIDE the box and reads the .mp4 back
 * out of the box's /tmp — plumbing that exists only for OpenGeni-operated cloud
 * boxes (the Modal desktop backend). A turn whose EFFECTIVE backend is a connected
 * machine ("selfhosted") runs on the user's REAL computer, which has none of that
 * capture plumbing (and the platform must never shell ffmpeg onto a user's machine
 * — the same reason the runtime skips its setup hooks for selfhosted). Left ungated
 * it films nothing, finds no /tmp file, and emits recording.started followed by
 * recording.failed{box-death} on EVERY machine-primary turn — misleading timeline
 * noise + wasted work. So gate it off, exactly like a recording-disabled deployment:
 * skip silently, emit nothing (no new event shape).
 *
 * `effectiveBackend` is the resolved ACTIVE backend for the turn
 * (resolveActiveSandboxBackend) — NOT the session's home backend. A modal-home
 * session actively swapped onto a machine resolves to "selfhosted" here and
 * correctly skips; a machine-home turn that degraded back to its cloud group box
 * (swap-away / flag-off) resolves to undefined and records as before.
 *
 * EDGE — mid-turn swap: this is evaluated once when computer-use first runs. A swap
 * after recording starts is deliberately ignored; the partial recording already has
 * defined failure semantics, so there is no stop/restart machinery.
 */
export function shouldStartOnTurnRecording(params: {
  recordingEnabled: boolean;
  desktopEnabled: boolean;
  establishedBackendId: string;
  effectiveBackend: Settings["sandboxBackend"] | undefined;
}): boolean {
  return (
    params.recordingEnabled &&
    params.desktopEnabled &&
    desktopCapableBackend(params.establishedBackendId) &&
    params.effectiveBackend !== "selfhosted"
  );
}

/**
 * Decide the EXPLICIT computer-use tool transport for THIS turn.
 *
 * The runtime's SDK-mirrored capability would otherwise pick hosted-vs-function
 * tools by string-sniffing the bound model instance's constructor name for
 * "ChatCompletions" (supportsStructuredToolOutputTransport). That is fragile: a
 * wrapped / proxied / minified model instance defeats the sniff and a
 * chat-completions provider would silently get the HOSTED `computer_use_preview`
 * tool it 400s on every turn. So the mode is decided HERE — the worker's model
 * resolution is the ONE place a provider's true wire identity is authoritative —
 * and threaded to the runtime as an explicit flag (buildAgent → computerToolMode):
 *   • codex-subscription → "function-image": the ChatGPT/Codex backend rejects
 *     hosted tool types but SEES structured `input_image` tool results.
 *   • a "chat" (OpenAIChatCompletionsModel wire) provider → "function-text": it takes
 *     function tools but can't read structured image results, so screenshots render
 *     as a text data-URL.
 *   • everything else — built-in Azure/OpenAI responses, registry "responses"
 *     providers, AND the LEGACY global-client fallback (resolveTurnModel returned
 *     null) — → "hosted": real Responses hosted-tool support.
 *
 * Pure + exported so the mapping is unit-testable without a live turn.
 */
export function computerToolModeForTurn(
  resolvedModel: {
    provider: { kind: RegistryProviderKind; api: ModelProviderApi };
  } | null,
): ComputerToolMode {
  if (!resolvedModel) {
    return "hosted"; // legacy built-in Responses client — real hosted support
  }
  if (resolvedModel.provider.kind === "codex-subscription") {
    return "function-image";
  }
  if (resolvedModel.provider.api === "chat") {
    return "function-text";
  }
  return "hosted";
}

export type TurnSandboxProvisioner<T> = {
  get(): Promise<T>;
  hasStarted(): boolean;
  waitForSettled(timeoutMs: number): Promise<T | null>;
};

export class TurnOperationCancelledError extends Error {
  readonly name = "TurnOperationCancelledError";

  constructor(readonly reason: unknown) {
    super("Turn operation was cancelled with its owning turn", {
      ...(reason instanceof Error ? { cause: reason } : {}),
    });
  }
}

/**
 * Normalize a preparation/provisioning cancellation race back to the Temporal
 * cancellation that owns the activity. Several provider APIs expose no portable
 * abort primitive, so the worker stops awaiting them and disposes any late
 * resource. The wrapper error must never fall through as an ordinary turn
 * failure: doing so would omit the quiescence receipt and strand a committed
 * Steer/Pause behind `control-pending`.
 */
export function turnOperationCancellationFailure(error: unknown): CancelledFailure | null {
  if (error instanceof CancelledFailure) return error;
  if (!(error instanceof TurnOperationCancelledError)) return null;
  return error.reason instanceof CancelledFailure
    ? error.reason
    : new CancelledFailure("TURN_SANDBOX_PROVISION_CANCELLED", [], error);
}

function throwIfTurnOperationCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new TurnOperationCancelledError(signal.reason);
  }
}

export async function waitForTurnOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  disposeLateResult: ((result: T) => Promise<void> | void) | undefined,
): Promise<T> {
  if (!signal) return await operation;

  let rejectCancellation: ((error: TurnOperationCancelledError) => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (): void => {
    rejectCancellation?.(new TurnOperationCancelledError(signal.reason));
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();

  try {
    const result = await Promise.race([operation, cancelled]);
    // Cancellation owns an exact turn boundary even when the provider result
    // and AbortSignal settle in the same microtask checkpoint. Never let a
    // just-resolved lease escape after the control was already committed.
    if (signal.aborted) {
      throw new TurnOperationCancelledError(signal.reason);
    }
    return result;
  } catch (error) {
    if (signal.aborted) {
      // The provider establish call has no universal cancellation seam. It may
      // finish after the Temporal activity has correctly stopped; dispose its
      // late lease instead of letting a cancelled turn resurrect a holder/box.
      void operation
        .then(async (result) => await disposeLateResult?.(result))
        .catch(() => undefined);
      // A provider failure may settle in the same checkpoint as the committed
      // control. The control is authoritative; retain its cancellation shape
      // so the activity publishes quiescence instead of looking like an
      // unrelated turn failure.
      if (!(error instanceof TurnOperationCancelledError)) {
        throw new TurnOperationCancelledError(signal.reason);
      }
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isLazySandboxProvisionRetryable(error: unknown): boolean {
  if (error instanceof SandboxImageConflictError) {
    return false;
  }
  if (error instanceof SandboxLeaseSupersededError || error instanceof SandboxWarmingTimeoutError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:capacity|create|creation|provider|sandbox).*(?:timeout|timed out)|(?:timeout|timed out).*(?:capacity|create|creation|provider|sandbox)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|temporar/i.test(
    message,
  );
}

export function createTurnSandboxProvisioner<T>(
  establish: () => Promise<T>,
  options: {
    maxRetries?: number;
    backoffMs?: number;
    signal?: AbortSignal;
    onStarted?: () => Promise<void> | void;
    onCompleted?: (result: T) => Promise<void> | void;
    onFailed?: (error: unknown) => Promise<void> | void;
    disposeResult?: (result: T) => Promise<void> | void;
  } = {},
): TurnSandboxProvisioner<T> {
  const maxRetries = options.maxRetries ?? 2;
  const backoffMs = options.backoffMs ?? 250;
  let memo: Promise<T> | null = null;

  const run = async (): Promise<T> => {
    let attempt = 0;
    while (true) {
      try {
        throwIfTurnOperationCancelled(options.signal);
        const operation = establish();
        return await waitForTurnOperation(operation, options.signal, options.disposeResult);
      } catch (error) {
        if (
          error instanceof TurnOperationCancelledError ||
          attempt >= maxRetries ||
          !isLazySandboxProvisionRetryable(error)
        ) {
          throw error;
        }
        attempt += 1;
        await sleep(backoffMs * attempt);
      }
    }
  };

  return {
    get(): Promise<T> {
      if (!memo) {
        memo = (async () => {
          throwIfTurnOperationCancelled(options.signal);
          await options.onStarted?.();
          throwIfTurnOperationCancelled(options.signal);
          let result: T | undefined;
          let hasResult = false;
          try {
            result = await run();
            hasResult = true;
            throwIfTurnOperationCancelled(options.signal);
            await options.onCompleted?.(result);
            return result;
          } catch (error) {
            if (hasResult) {
              await options.disposeResult?.(result as T);
            }
            if (!(error instanceof TurnOperationCancelledError)) {
              await options.onFailed?.(error);
            }
            throw error;
          }
        })().catch((error) => {
          memo = null;
          throw error;
        });
      }
      return memo;
    },
    hasStarted(): boolean {
      return memo !== null;
    },
    async waitForSettled(timeoutMs: number): Promise<T | null> {
      if (!memo) {
        return null;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          memo.catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}

function sdkBackendIdForSandboxBackend(backend: Settings["sandboxBackend"]): string {
  return backend === "local" ? "unix_local" : backend;
}

/**
 * Decide whether THIS turn may send OpenAI's `prompt_cache_key` request field.
 *
 * Accepted transports:
 *   - legacy/built-in OpenAI or Azure Responses fallback (resolvedModel null);
 *   - resolved built-in OpenAI/Azure providers;
 *   - ChatGPT/Codex subscription backend (its strict allowlist permits the field).
 *
 * Registry API-key providers are intentionally excluded. Fireworks' prompt-cache
 * docs prescribe `user` or `x-session-affinity`, not `prompt_cache_key`; Z.AI/GLM
 * documents automatic context caching plus `user_id`. Sending OpenAI-only fields
 * to unknown OpenAI-compatible providers risks unsupported-parameter 400s.
 */
export function acceptsPromptCacheKeyForTurn(
  resolvedModel: {
    provider: { kind: RegistryProviderKind; builtin?: boolean };
  } | null,
): boolean {
  if (!resolvedModel) {
    return true;
  }
  return (
    resolvedModel.provider.builtin === true || resolvedModel.provider.kind === "codex-subscription"
  );
}

/**
 * SELF-HEAL helper for the all-capped rotation idle (invariant 4: BOUNDED, no thrash).
 * The turn hot path never refreshes Codex usage — only the usage API route does — so a
 * window that has actually reset still reads OVER-threshold from the stale cache, which
 * would idle-loop forever. Before idling, refresh LIVE usage for every connected account
 * the cache marks exhausted (bounded to the account count), which re-writes the
 * cache columns, then return the re-read rows so the ranker can pick up a genuinely-reset
 * window THIS turn. A refresh/read failure is swallowed (fall back to the pre-refresh rows
 * + the bounded idle). Cooling (429'd) accounts are NOT refreshed: their exhaustedUntil
 * cooldown is authoritative, and refreshing them would burn a provider call for nothing.
 */
async function refreshCappedCodexUsageRows(
  db: ActivityServices["db"],
  settings: Settings,
  workspaceId: string,
  accounts: CodexAccountStatus[],
  capacitySignals: {
    signalCodexCapacityWorkflow?: ActivityServices["signalCodexCapacityWorkflow"] | undefined;
    wakeSessionWorkflow: ActivityServices["wakeSessionWorkflow"];
  },
): Promise<CodexAccountStatus[]> {
  const stale = accounts.filter(
    (a) =>
      a.status === "active" &&
      ((a.primaryUsedPercent ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT ||
        (a.secondaryUsedPercent ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT),
  );
  if (stale.length === 0) {
    return accounts;
  }
  await refreshCodexUsageAndRepairCapacityWaiters(
    stale.map((account) => () => fetchCodexUsageForAccount(db, settings, workspaceId, account.id)),
    () => signalPendingCodexCapacityWakeTargets({ db, ...capacitySignals }, workspaceId),
  );
  return listCodexAccountStatuses(db, workspaceId).catch(() => accounts);
}

/**
 * True once the lifetime last confirmed by Postgres is no longer trustworthy.
 * A missing or malformed deadline fails closed for a holder that claims to be
 * leased; callers check this before accepting an in-flight heartbeat promise.
 */
export function codexCredentialLeaseDeadlineExpired(
  confirmedUntilMs: number | null,
  nowMs: number = performance.now(),
): boolean {
  return (
    confirmedUntilMs === null || !Number.isFinite(confirmedUntilMs) || confirmedUntilMs <= nowMs
  );
}

export function createRunAgentTurnActivity(services: () => Promise<ActivityServices>) {
  return async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const {
      settings,
      db,
      bus,
      runtime,
      objectStorage,
      observability,
      wakeSessionWorkflow,
      signalSessionAttemptQuiesced,
      signalCodexCapacityWorkflow,
      entitlements,
      connectionCredentials,
    } = await services();
    const activityContext = currentActivityContext();
    const cancellationSignal = activityContext?.cancellationSignal;
    let cancellationRequestedAt: number | null = cancellationSignal?.aborted
      ? performance.now()
      : null;
    const noteCancellationRequested = (): void => {
      cancellationRequestedAt ??= performance.now();
    };
    cancellationSignal?.addEventListener("abort", noteCancellationRequested, {
      once: true,
    });
    const dispatchId = activityContext?.info.activityId ?? randomUUID();
    const activityStarted = performance.now();
    const activitySpan = observability.startSpan("worker.run_agent_segment", {
      "opengeni.session_id": input.sessionId,
      "opengeni.workflow_id": input.workflowId,
      "opengeni.trigger_kind": input.trigger.kind,
    });
    let activityStatus: RunAgentTurnResult["status"] | "unknown" = "unknown";
    let turnMetricOutcome: TurnOutcome | null = null;
    let activityError: unknown;
    let acknowledgeQuiescence = false;
    const acknowledgeLostAttemptOwnership = (): void => {
      // A stale terminal/recovery settlement can lose either to a benign
      // successor or to Pause/Steer closing this exact attempt. Only the
      // receipt transaction can distinguish those cases after the hard tool
      // fence: allowUninterrupted makes the benign case an event-free no-op.
      acknowledgeQuiescence = true;
      noteCancellationRequested();
    };
    let turnId: string | undefined;
    let triggerEventId: string | undefined;
    const claimedResult = (
      result: Omit<
        Extract<RunAgentTurnResult, { status: Exclude<RunAgentTurnResult["status"], "unclaimed"> }>,
        "turnId" | "attemptId"
      >,
    ): RunAgentTurnResult => {
      if (!turnId) throw new Error("Claimed activity result produced before turn admission");
      return {
        ...result,
        turnId,
        attemptId: input.attemptId,
      } as RunAgentTurnResult;
    };
    // The Connected Machine op observer for this turn: meters every op AND buffers
    // the eventable ones (infra failures + healed recoveries) as machine.op.* session
    // events, drained (awaited) at turn end in the finally below. ONE instance shared
    // by the machine-primary establish + both routing wraps.
    const machineOpObserver = makeMachineOpObserver(
      runtimeMetricsHooksForObservability(observability),
    );
    let isCodexTurn = false;
    let executionGeneration = 0;
    // Still required by credential-loss/capacity settlements, whose own
    // recovery transactions fence against worker-death redispatches.
    let redispatchesAtDispatch = 0;
    const setLastInputTokensFenced = async (lastInputTokens: number): Promise<void> => {
      if (!turnId || executionGeneration <= 0) {
        throw new Error("Turn attempt was not initialized before token accounting");
      }
      if (
        !(await setSessionLastInputTokensForTurnAttempt(db, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          expectedExecutionGeneration: executionGeneration,
          expectedAttemptId: input.attemptId,
          lastInputTokens,
        }))
      ) {
        throw new TurnAttemptFencedError("turn attempt was fenced while recording input tokens");
      }
    };
    let heartbeatTimer: ReturnType<typeof startActivityHeartbeat> | undefined;
    // credential allocator: one workspace-local idempotent credential holder per running
    // Codex turn. The DB row is the cross-replica fairness primitive; this timer
    // only extends its short TTL. A killed worker stops heartbeating and the
    // holder self-expires. Other workspaces never see or share this holder.
    let codexLeaseHeld = false;
    let codexLeaseLost = false;
    let codexLeaseHolderId: string | null = null;
    let codexLeaseGeneration: number | null = null;
    // Monotonic worker deadline, not a comparison between the Postgres and
    // worker wall clocks. It is advanced only after a database renewal confirms,
    // from the request START + TTL; slow queries therefore shorten (never extend)
    // the conservative ownership window.
    let codexLeaseConfirmedUntilMs: number | null = null;
    let codexLeaseHeartbeatInFlight = false;
    let codexLeaseHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const codexWorkspaceKey = codexWorkspaceMetricKey(input.workspaceId);
    const markCodexLeaseLost = (reason: "deadline" | "not_found"): void => {
      if (codexLeaseLost) return;
      codexLeaseLost = true;
      observability.incrementCounter({
        name: "opengeni_codex_lease_renewals_total",
        help: "Codex lease renewal checkpoints by outcome and reason.",
        labels: { workspace_key: codexWorkspaceKey, outcome: "lost", reason },
      });
      observability.warn("Codex credential lease was lost during an active turn", {
        workspaceId: input.workspaceId,
        turnId,
        reason,
      });
    };
    const renewCodexLease = async (reason: "timer" | "runtime_event" | "model_usage") => {
      if (
        !turnId ||
        !codexLeaseHeld ||
        !codexLeaseHolderId ||
        codexLeaseGeneration === null ||
        codexLeaseLost
      )
        return;
      // Check the last expiry the database actually returned BEFORE the
      // single-flight guard. A hung heartbeat must not make later model/runtime
      // checkpoints trust a lease whose last proven lifetime already elapsed.
      if (codexCredentialLeaseDeadlineExpired(codexLeaseConfirmedUntilMs)) {
        markCodexLeaseLost("deadline");
        return;
      }
      if (codexLeaseHeartbeatInFlight) return;
      codexLeaseHeartbeatInFlight = true;
      const renewalStartedAtMs = performance.now();
      try {
        const renewedUntil = await heartbeatCodexCredentialLeaseUntil(
          db,
          input.accountId,
          input.workspaceId,
          turnId,
          codexLeaseHolderId,
          codexLeaseGeneration,
          CODEX_CREDENTIAL_LEASE_TTL_MS,
        );
        if (!renewedUntil) {
          markCodexLeaseLost("not_found");
        } else {
          codexLeaseConfirmedUntilMs = renewalStartedAtMs + CODEX_CREDENTIAL_LEASE_TTL_MS;
          observability.incrementCounter({
            name: "opengeni_codex_lease_renewals_total",
            help: "Codex lease renewal checkpoints by outcome and reason.",
            labels: {
              workspace_key: codexWorkspaceKey,
              outcome: "completed",
              reason,
            },
          });
        }
      } catch (error) {
        // A transient DB failure does not immediately abandon a still-live row,
        // but it also cannot extend the last database-confirmed deadline.
        if (codexCredentialLeaseDeadlineExpired(codexLeaseConfirmedUntilMs)) {
          markCodexLeaseLost("deadline");
          return;
        }
        observability.warn("Codex credential lease heartbeat failed", {
          workspaceId: input.workspaceId,
          turnId,
          reason,
          errorName: error instanceof Error ? error.name : "unknown",
        });
        observability.incrementCounter({
          name: "opengeni_codex_lease_renewals_total",
          help: "Codex lease renewal checkpoints by outcome and reason.",
          labels: {
            workspace_key: codexWorkspaceKey,
            outcome: "error",
            reason,
          },
        });
      } finally {
        codexLeaseHeartbeatInFlight = false;
      }
    };
    const startCodexLeaseHeartbeat = (): void => {
      if (!turnId || codexLeaseHeartbeatTimer) return;
      codexLeaseHeartbeatTimer = setInterval(() => {
        void renewCodexLease("timer");
      }, 60_000);
      codexLeaseHeartbeatTimer.unref?.();
    };
    // P1.2 ownership inversion: when sandboxOwnershipEnabled, the turn resolves
    // the one box by id from the group lease and injects it NON-OWNED into the
    // run. null when the flag is off (byte-for-byte the legacy build-and-discard
    // path) OR when the backend is "none". Released + dropped in `finally`.
    let resolvedSandbox: ResumedTurnSandbox | null = null;
    // The machine-primary SelfhostedSession (the UNWRAPPED backend, not the
    // routing proxy): held so the turn's completion can final-ack this turn's
    // settled op-stream ops AFTER the results are durably persisted.
    let machinePrimarySession: import("@opengeni/runtime").SelfhostedSession | null = null;
    let lazyOwnedSandbox: EstablishedSandboxSession | null = null;
    let turnSandboxProvisioner: TurnSandboxProvisioner<ResumedTurnSandbox> | null = null;
    // The UN-PROXIED established box session, captured BEFORE wrapTurnBoxWithRouting.
    // Platform setup (beforeAgentStart hooks + file materialization) execs against
    // THIS handle so a mid-turn sandbox_swap can never re-route those execs onto a
    // connected machine (the user's real computer).
    let setupBoxSession: unknown = null;
    // The globally unique durable turn-attempt holder id + the group id,
    // captured so the lease heartbeat can refresh the lease TTL epoch-fenced
    // (a superseded owner self-evicts) and finally can release.
    let sandboxHolderId: TurnSandboxLeaseHolderId | null = null;
    let sandboxGroupId: string | null = null;
    // Lease-TTL refresh timer (parallels the activity heartbeat): while the turn
    // runs it refreshes expires_at epoch-fenced so a legit multi-day turn is
    // never TTL-reaped. Cleared in finally. Only set when the flag resolved a box.
    let leaseHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
    // credential-renewal policy: the worker, not the model, owns renewal of run-scoped Git
    // credentials for a multi-day turn. The controller is attached only after
    // the initial seed reached a real cloud box and is drained before capture.
    let gitCredentialRenewals: GitCredentialRenewalController[] = [];
    let gitCredentialRenewalClosed = false;
    // Generic host-owned run material has its own attempt-scoped renewal and
    // write handle. It is always drained and wiped before workspace capture.
    let runCredentialRenewal: RunCredentialRenewalController | null = null;
    let runCredentialRenewalClosed = false;
    let runCredentialSession: RunCredentialCommandSession | null = null;
    // The delegated Toolspace bearer has a one-hour TTL. Renewal is attempt-
    // owned and attaches only after the initial token file reached a real
    // sandbox session; finalization drains an in-flight replacement.
    let toolspaceTokenRenewal: ToolspaceTokenRenewalController | null = null;
    let toolspaceTokenRenewalClosed = false;
    // MID-SESSION snapshot single-flight guard: the heartbeat tick fires every
    // 10s but a Modal filesystem snapshot can take longer — never overlap two
    // captures on one box. The in-flight capture's promise is held so the
    // turn-end persist can await it (its capture predates the turn's final
    // writes; landing after the fresher turn-end capture started would make
    // the atomic DB throttle discard the fresher one). Interval throttling
    // itself lives in maybePersistWarmWorkspaceSnapshot / persistWarmSnapshot.
    let snapshotInFlight: Promise<void> | null = null;
    // Computer-use-only recording. Ordinary shell/filesystem turns leave this
    // null; the first actual computer action starts it after :0 is ready.
    let activeRecording: ActiveRecording | null = null;
    let computerUseRecordingStart: Promise<void> | null = null;
    // P4.3 recording gate: flips true in `onComputerUseReady`, the runtime's
    // execution-time callback for the first real computer action. It must flip
    // BEFORE awaiting recording startup: the SDK tool-call stream item can arrive
    // before ffmpeg has finished starting. A plain text turn ("hey"/"continue")
    // never invokes the callback, so settlement performs no storage PUT.
    let didComputerUse = false;
    const abandonActiveRecording = async (
      reason: string,
      disposition: "failed" | "discard" = "failed",
    ): Promise<void> => {
      const recording = activeRecording as ActiveRecording | null;
      if (!recording) return;
      activeRecording = null;
      if (resolvedSandbox) {
        await stopRecordingOnBox(resolvedSandbox.established.session, recording.proc).catch(
          () => undefined,
        );
      }
      if (!turnId || executionGeneration <= 0) return;
      await abandonRecordingForTurnAttempt(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId,
        executionGeneration,
        attemptId: input.attemptId,
        recordingId: recording.recordingId,
        disposition,
        reason,
      }).catch(() => undefined);
    };
    let batcher: ReturnType<typeof createRuntimeBatcher> | null = null;
    const flushRuntimeBatcher = async () => {
      const current = batcher as ReturnType<typeof createRuntimeBatcher> | null;
      await current?.flush().catch(() => undefined);
    };
    let preparedTools: Awaited<ReturnType<OpenGeniRuntime["prepareTools"]>> | null = null;
    const toolCancellationFenceRef: {
      current: TurnToolCancellationFence | null;
    } = {
      current: null,
    };
    let publish: TurnEventPublisher | null = null;
    let settle:
      | ((input: {
          events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>;
          turnStatus:
            | "queued"
            | "running"
            | "completed"
            | "failed"
            | "cancelled"
            | "requires_action";
          sessionStatus: SessionStatus;
          activeTurnId: string | null;
          consumeRequestedCompactionFailure?: boolean;
          runState?: ApplySessionTurnSettlementInput["runState"];
        }) => Promise<boolean>)
      | null = null;
    let turnStartedPublished = false;
    let stream: Awaited<ReturnType<OpenGeniRuntime["runStream"]>> | undefined;
    // Reconciliation is declared before provider routing so every turn-end path
    // can share one closure. It cannot run until `stream` exists, by which time
    // this value has been rebound to the turn's resolved model policy.
    let modelRunSettings: Settings = settings;
    const publishSandboxLifecycleEvents = async (sandbox: ResumedTurnSandbox): Promise<void> => {
      const established = sandbox.established;
      if (publish && established.origin && established.origin !== "resumed") {
        const lifecycleEvents: Array<{
          type: "sandbox.box.lost" | "sandbox.box.created";
          payload: unknown;
        }> = [];
        if (established.lostInstanceId) {
          lifecycleEvents.push({
            type: "sandbox.box.lost",
            payload: { sandboxId: established.lostInstanceId },
          });
        }
        lifecycleEvents.push({
          type: "sandbox.box.created",
          payload: {
            sandboxId: established.instanceId,
            hydrated: established.origin === "restored" ? "archive" : "none",
          },
        });
        await publish(lifecycleEvents).catch(() => undefined);
      }
    };
    const publishSandboxLost = async (lostSandbox: { instanceId: string }): Promise<void> => {
      if (!publish) return;
      await publish([
        {
          type: "sandbox.box.lost",
          payload: { sandboxId: lostSandbox.instanceId },
        },
      ]).catch((publishError) => {
        // The lease transition is already authoritative. A fenced/failed audit
        // append must not prevent the same logical turn from recovering.
        console.error("sandbox box lost event publish failed", publishError);
      });
    };
    const startLeaseHeartbeat = (
      sandbox: ResumedTurnSandbox,
      warmBackend: Settings["sandboxBackend"] | undefined,
    ): void => {
      if (!sandboxHolderId || !sandboxGroupId) {
        return;
      }
      // Refresh the lease TTL on the activity-heartbeat cadence (10s, well
      // inside the 90s lease TTL). EPOCH-FENCED: a superseded owner's refresh
      // is rejected (returns false) and we stop refreshing — the box rides the
      // provider idle-timeout and the next dispatch re-establishes it. Best-
      // effort: a transient DB error must never fail the turn.
      const heartbeatEpoch = sandbox.leaseEpoch;
      const heartbeatHolderId = sandboxHolderId;
      const heartbeatGroupId = sandboxGroupId;
      // P2.1 warm-meter (tick A): while a turn runs, the heartbeat is also the
      // warm-seconds tick. GROUP+epoch+tick keyed (one box = one stream, shared
      // box metered once); epoch-fenced (a stale tick no-ops). Warm-cost is
      // metered when a per-backend rate is configured. Best-effort: a metering
      // failure must never fail the turn.
      //
      // Keyed off the EFFECTIVE backend (Stage D): a machine-primary turn has NO
      // Modal box, so it must accrue ZERO cloud warm-seconds — `selfhosted` has no
      // configured warm rate (0). Keying off turn.sandboxBackend (modal) would bill
      // cloud seconds for a box that does not exist (a real money bug). Non-machine
      // turns fall back to groupBoxBackend (the REAL box that ran): for a machine-
      // home turn that degraded to the cloud group box (swap-away / flag-off), that
      // is the deployment default (modal), so the fallback box is warm-metered at
      // the cloud rate instead of selfhosted's rate-0 (which would under-bill).
      const warmRate = sandboxWarmRateMicrosPerSecond(
        settings,
        warmBackend ?? (sandbox.established.backendId as Settings["sandboxBackend"]),
      );
      leaseHeartbeatTimer = setInterval(() => {
        void heartbeatLeaseHolder(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: heartbeatGroupId,
          kind: "turn",
          holderId: heartbeatHolderId,
          leaseTtlMs: settings.sandboxLeaseTtlMs,
          expectedEpoch: heartbeatEpoch,
        }).catch(() => undefined);
        void accrueWarmSeconds(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: heartbeatGroupId,
          expectedEpoch: heartbeatEpoch,
          warmRateMicrosPerSecond: warmRate,
          subjectId: input.sessionId,
        })
          .then((result) => recordCreditMicros(observability, "usage", result.costMicros))
          .catch(() => undefined);
        // MID-SESSION snapshot (sandbox-file-persistence): while the turn holds
        // the box, fold a fresh /workspace snapshot onto the lease every
        // sandboxSnapshotIntervalMs, so a box death the reaper never sees
        // (Modal hard timeout mid-busy, OOM, infra) costs at most one interval
        // of work — a legit multi-day turn is otherwise completely unprotected
        // (the reaper only drain-persists IDLE leases). Uses the UN-proxied box
        // session (setupBoxSession): the routing veneer could swap mid-op and a
        // selfhosted target has no persistWorkspace anyway. Best-effort +
        // single-flight; throttling lives in the helper.
        const snapshotSession = setupBoxSession;
        const snapshotTurnId = turnId;
        if (snapshotSession && snapshotTurnId && !snapshotInFlight) {
          snapshotInFlight = maybePersistWarmWorkspaceSnapshot(
            { db, settings },
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: snapshotTurnId,
              attemptId: input.attemptId,
              sandboxGroupId: heartbeatGroupId,
            },
            snapshotSession,
            heartbeatEpoch,
            activityContext?.cancellationSignal,
          )
            .then(async (persisted) => {
              if (persisted && publish) {
                await publish([
                  {
                    type: "sandbox.box.snapshot",
                    payload: { trigger: "heartbeat" },
                  },
                ]);
              }
            })
            .catch(() => undefined)
            .finally(() => {
              snapshotInFlight = null;
            });
        }
      }, 10_000);
      if ("unref" in leaseHeartbeatTimer && typeof leaseHeartbeatTimer.unref === "function") {
        leaseHeartbeatTimer.unref();
      }
    };
    const maybeStartOnTurnRecording = async (
      sandbox: ResumedTurnSandbox,
      effectiveBackend: Settings["sandboxBackend"] | undefined,
    ): Promise<void> => {
      if (activeRecording) {
        return;
      }
      if (computerUseRecordingStart) {
        await computerUseRecordingStart;
        return;
      }
      // Called only by the runtime's first-computer-action hook. Plain sandbox
      // operations never start ffmpeg and never boot a display merely to record
      // an unused desktop. Recording failure never fails the computer action.
      if (
        shouldStartOnTurnRecording({
          recordingEnabled: settings.recordingEnabled,
          desktopEnabled: settings.sandboxDesktopEnabled,
          establishedBackendId: sandbox.established.backendId,
          // EFFECTIVE (active) backend, not the session home: a machine-primary turn
          // resolves to "selfhosted" and skips; a swap back to the cloud group box
          // resolves to undefined and records as before.
          effectiveBackend,
        })
      ) {
        computerUseRecordingStart = (async () => {
          let begun: Awaited<ReturnType<typeof beginRecording>> | null = null;
          try {
            begun = await beginRecording({
              settings,
              db,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turnId!,
              recordingId: randomUUID(),
              mode: "on-turn",
              session: sandbox.established.session,
              runAs: sandboxRunAs(settings),
              reason: null,
            });
            if (!publish) {
              throw new Error("recording started before the turn event publisher was ready");
            }
            await publish([{ type: "recording.started", payload: begun.started }]);
            activeRecording = begun.active;
          } catch (recordingError) {
            activeRecording = null;
            if (begun) {
              await discardUnpublishedRecording({
                db,
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                active: begun.active,
                session: sandbox.established.session,
              });
            }
            console.error(
              "computer-use recording start failed (action outcome unaffected)",
              recordingError,
            );
          }
        })();
        await computerUseRecordingStart;
      }
    };
    // Dual-write of conversation truth (issue #35): completed items are
    // reconciled into session_history_items after every model response and at
    // every turn-end path (idempotent on position), and the sandbox recovery
    // envelope is upserted alongside. Best-effort by design: persistence
    // problems must never fail the run.
    //
    // Orphaned-tool-output guard: `stream.state.history` is NOT a plain
    // append-only array — it is a computed getter
    // (`getTurnInput(originalInput, generatedItems)`) that runs the SDK's
    // `dropOrphanToolCalls` on every access, so a `function_call` with no
    // settling result yet is transiently ABSENT from history and a later
    // reconcile sees a DIFFERENT, shorter/reordered list. A blind length
    // watermark with onConflictDoNothing-on-position then freezes the first
    // shape of a position and can persist a `function_call_result` at a tail
    // position while its `function_call` was pruned away in an earlier slice
    // and never written — the orphan that bricks the session. We defend against
    // it at the stream boundary with the turn-scoped pending-tool ledger. A
    // partial parallel batch records raw results but does not call this
    // reconciler. Once every registered call has a result, the SDK history is
    // stable and this scalar append watermark is valid again. The sanitizer
    // remains the final call/result pairing guard for every other reconcile.
    let persistedHistoryCount = 0;
    // Next free WHOLE-NUMBER absolute position to append at. Tracked separately
    // from persistedHistoryCount (the in-memory slice index) because a compaction
    // inserts a fractional summary position, so total rows no longer equal
    // max(position)+1 and the slice index can no longer double as the position.
    let nextHistoryPosition = 0;
    const reconcileConversationTruth = async (
      options: { skipInputOnlyRows?: boolean; requireDurable?: boolean } = {},
    ) => {
      if (!stream || !turnId) {
        return;
      }
      try {
        const rawHistory = (stream.state as { history?: unknown[] }).history;
        if (Array.isArray(rawHistory)) {
          const { rows, nextWatermark, nextPosition } = historyRowsToAppend(
            rawHistory as Array<Record<string, unknown>>,
            persistedHistoryCount,
            nextHistoryPosition,
            modelRunSettings.modelToolOutputTruncationTokens,
          );
          const hasModelOrToolProgress = rows.some((row) =>
            isModelOrToolProgressHistoryItem(row.item),
          );
          const shouldAppendRows =
            rows.length > 0 && (!options.skipInputOnlyRows || hasModelOrToolProgress);
          if (shouldAppendRows) {
            const appended = await appendSessionHistoryItems(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              expectedExecutionGeneration: executionGeneration,
              expectedAttemptId: input.attemptId,
              // Tag each row with the codex account that produced it (null on the
              // non-codex path). Resolved at line ~504 before any reconcile pass
              // runs, so this is the turn's effective account. The read path uses
              // it to strip cross-account reasoning.encrypted_content next turn.
              producerCodexCredentialId: effectiveCodexCredentialId,
              modelToolOutputTruncationTokens: modelRunSettings.modelToolOutputTruncationTokens,
              items: rows,
            });
            if (!appended) {
              throw new TurnAttemptFencedError(
                "turn execution generation was fenced while saving conversation history",
              );
            }
          }
          if (shouldAppendRows || !options.skipInputOnlyRows) {
            persistedHistoryCount = nextWatermark;
            nextHistoryPosition = nextPosition;
          }
        }
        const envelope = sandboxStateEntryFromRunState(stream.state);
        if (envelope) {
          await upsertSandboxSessionEnvelope(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            envelope,
          });
        }
      } catch (persistError) {
        console.error("session history dual-write failed (run unaffected)", persistError);
        if (options.requireDurable) throw persistError;
      }
    };
    // Reassigned after the variable set loads; the publish closure is
    // created (and used for turn.started) before the variableSet is available.
    let redact: (payload: unknown) => unknown = identityRedactor;
    const secretRedactions = new Map<string, string>();
    const publishedRunCredentialNotices = new Set<string>();
    const registerSecretRedactions = (secrets: SecretForRedaction[]): void => {
      for (const secret of secrets) {
        if (!secretRedactions.has(secret.value)) secretRedactions.set(secret.value, secret.name);
      }
      redact = createSecretRedactor(
        [...secretRedactions].map(([value, name]) => ({ name, value })),
      );
    };
    let variableSetId = "";
    // Rig telemetry (M3): set once the session loads; empty string for a rig-less
    // turn (mirrors variableSetId). Read by the activity span's finally block.
    let rigId = "";
    let rigVersionId = "";
    // The Codex account this turn runs on (pin > workspace active), resolved once
    // a codex-billed turn is confirmed and threaded into the token resolver below.
    let effectiveCodexCredentialId: string | null = null;
    // The session's Codex credential BEFORE this turn resolved its own — captured
    // before recordSessionActiveCodexCredential overwrites the durable pointer, so
    // a per-call usage log can report whether the serving account CHANGED since the
    // session's previous call (the prompt-cache account-switch hypothesis).
    let priorSessionCodexCredentialId: string | null = null;
    // Multi-account P4 (Part A): the latest usage-header snapshot scraped FOR FREE
    // off this turn's `/codex/responses` responses (a turn issues many model calls;
    // latest wins). Flushed ONCE into the P2 usage cache for the serving account in
    // the `finally` — cheaper than a /wham/usage poll AND it self-heals P3 rotation
    // (the proactive + 429 rankers read these exact columns). null ⇒ nothing scraped.
    // Hoisted to activity scope so the finally flush (below) sees it. The sink is
    // wired into codexContext.onUsageHeaders inside the try.
    let latestCodexUsage: CodexUsageHeaderSnapshot | null = null;
    // Hoisted for same-turn recovery: an approval-decision rerun must
    // re-enter through the approval resume path (its frozen mid-flight state
    // only exists in the RunState blob), never through a swapped trigger.
    let triggerType: string | null = null;
    try {
      const mcpSettings = await settingsWithEnabledCapabilityMcpServers(
        db,
        input.workspaceId,
        settings,
      );
      // Read the active-credential flag ONCE (P2-b) and thread it through both the
      // routing overlay (settingsWithCodexCredential) and the billed-turn predicate
      // (isCodexBilledTurn below), so a concurrent disconnect/reconnect cannot make
      // provider-injection and billing disagree about whether this is a codex turn.
      const codexSubscriptionActive = await workspaceCodexSubscriptionActive(
        db,
        mcpSettings,
        input.workspaceId,
      );
      const capabilitySettings = await settingsWithCodexCredential(
        db,
        input.workspaceId,
        mcpSettings,
        codexSubscriptionActive,
      );
      runtime.configure(capabilitySettings);
      const session = await requireSession(db, input.workspaceId, input.sessionId);
      const claim = await claimSessionWorkForAttempt(db, input.workspaceId, {
        sessionId: input.sessionId,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        attemptId: input.attemptId,
        dispatchId,
        trigger: input.trigger,
      });
      if (claim.action === "unclaimed") {
        activityStatus = "unclaimed";
        return { status: "unclaimed", reason: claim.reason };
      }
      const turn = claim.turn;
      turnId = turn.id;
      triggerEventId = turn.triggerEventId;
      const trigger = await getSessionEvent(db, input.workspaceId, triggerEventId);
      if (!trigger) {
        throw new Error(`Trigger event not found: ${triggerEventId}`);
      }
      const humanInputResume = await getHumanInputResumeForEvent(
        db,
        input.workspaceId,
        input.sessionId,
        trigger,
      );
      triggerType = trigger.type;
      executionGeneration = turn.executionGeneration;
      const latestTurnState = await getLatestRunState(db, input.workspaceId, input.sessionId);
      const continuationCodexCredentialId =
        latestTurnState?.turnId === turnId ? latestTurnState.frozenCodexCredentialId : null;
      redispatchesAtDispatch = Number(
        (turn.metadata as { workerDeathRedispatches?: number } | null)?.workerDeathRedispatches ??
          0,
      );
      turnLifecycleMetricsFor(observability).start(turnId);
      // Canonical codex-billed predicate (codex/<slug> + feature enabled + active
      // workspace credential). Computed once and threaded through every billing
      // gate + the usage recorder so a turn paid by the user's ChatGPT/Codex plan
      // consumes ZERO OpenGeni credits and never feeds an OpenGeni cap. Resolved
      // here (before resolvedModel at the routing step) because the pre-turn gate
      // below needs it; mirrors the same active-credential read the codex provider
      // overlay uses, so billing and routing agree on what "codex" is.
      isCodexTurn = await isCodexBilledTurn({
        db,
        settings,
        workspaceId: input.workspaceId,
        model: turn.model,
        active: codexSubscriptionActive,
      });
      // §7.5 P3 — pass BOTH the codex predicate (codex-plan turns bypass the gate)
      // AND the optional host `entitlements` port (when bound, its admitRun replaces
      // the local credit read). Unset port → today's local-ledger path.
      await waitForTurnOperation(
        ensureRunAllowed(
          settings,
          db,
          input.accountId,
          input.workspaceId,
          isCodexTurn,
          entitlements,
        ),
        cancellationSignal,
        undefined,
      );
      // Setup (variableSet load, MCP connects, sandbox restore) does not
      // stream and so never observes cancellation on its own; these explicit
      // checks let a graceful shutdown checkpoint the turn before the worker is
      // force-killed instead of riding the setup to a heartbeat timeout.
      const throwIfWorkerShuttingDown = () => {
        const reason = activityContext?.cancellationSignal.reason;
        if (isWorkerShutdownCancellation(reason)) {
          throw reason;
        }
      };
      const throwIfTurnCancelled = () => throwIfTurnOperationCancelled(cancellationSignal);
      // ONE shared details object for every heartbeat this activity sends (each
      // site spreads it + its own phase), so cross-site fields — the op-stream
      // settled roster in particular — survive last-write-wins instead of being
      // clobbered by whichever site heartbeated most recently.
      const heartbeatDetails: TurnHeartbeatDetails = {
        phase: "running",
        sessionId: input.sessionId,
        turnId,
        opAcks: {},
      };
      const opJournal = makeTurnOpJournal(activityContext, heartbeatDetails);
      heartbeatTimer = startActivityHeartbeat(activityContext, heartbeatDetails);
      let producerSeq = 0;
      // One producer per activity execution, not per turn: a turn can run
      // again on the same workflow (recovery, approval rerun), and
      // each execution restarts producerSeq at 1 — a shared producer id would
      // trip the per-producer uniqueness constraint on the event log. The
      // Temporal activity id is unique per scheduled execution.
      const producerId = `${input.workflowId}:${turnId}${activityContext ? `:${activityContext.info.activityId}` : ""}`;
      // Unique per scheduled activity execution (Temporal activityId). Folded
      // into positional usage source keys so a re-dispatch of this turn does
      // not collide its model-call charges with the prior dispatch's. A genuine
      // activity retry reuses the same activityId, so its re-emitted calls keep
      // deduping (no double charge).
      // Local/tests have no Temporal activity id; still generate an execution-
      // unique holder so a second dispatch of the same durable turn fences this
      // one exactly like production.
      codexLeaseHolderId = dispatchId;
      const modelUsageDispatchId = activityContext?.info.activityId ?? dispatchId;
      const emittedModelUsageSourceKeys = new Set<string>();
      publish = async (
        events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>,
        immediate = false,
      ) => {
        const inputs = events.map((event) => ({
          ...event,
          payload: redact(event.payload),
          turnId: turnId!,
          producerId,
          producerSeq: ++producerSeq,
        }));
        const appended = await appendAndPublishTurnEventsFenced(
          db,
          bus,
          input.workspaceId,
          input.sessionId,
          turnId!,
          executionGeneration,
          input.attemptId,
          inputs,
        );
        if (inputs.length > 0 && !appended.accepted) {
          throw new TurnAttemptFencedError("turn execution generation was fenced");
        }
        activityContext?.heartbeat({
          ...heartbeatDetails,
          phase: "events_published",
          producerSeq,
        });
        if (immediate) {
          await Bun.sleep(0);
        }
        return appended;
      };
      settle = async (inputSettlement) => {
        const attemptClosing = ["completed", "failed", "cancelled", "requires_action"].includes(
          inputSettlement.turnStatus,
        );
        const recordingForSettlement =
          attemptClosing && activeRecording && resolvedSandbox
            ? (activeRecording as ActiveRecording)
            : null;
        const preparedRecording = recordingForSettlement
          ? await prepareRecordingForSettlement({
              settings,
              objectStorage,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              active: recordingForSettlement,
              session: resolvedSandbox!.established.session,
              didComputerUse,
            })
          : null;
        let recordingMutation: SessionTurnRecordingSettlement | undefined;
        if (preparedRecording) {
          const mutation = preparedRecording.mutation;
          recordingMutation =
            mutation.action === "discard"
              ? mutation
              : {
                  ...mutation,
                  producerId,
                  producerSeq: ++producerSeq,
                };
        }
        const compactionRequestFailure = inputSettlement.consumeRequestedCompactionFailure
          ? {
              reason: "summarization_failed" as const,
              producerId,
              producerSeq: ++producerSeq,
            }
          : undefined;
        const inputs = inputSettlement.events.map((event) => ({
          ...event,
          payload: redact(event.payload),
          turnId: turnId!,
          producerId,
          producerSeq: ++producerSeq,
        }));
        const result = await applySessionTurnSettlement(db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: turnId!,
          triggerEventId: triggerEventId!,
          attemptId: input.attemptId,
          turnStatus: inputSettlement.turnStatus,
          sessionStatus: inputSettlement.sessionStatus,
          activeTurnId: inputSettlement.activeTurnId,
          events: inputs,
          ...(inputSettlement.runState ? { runState: inputSettlement.runState } : {}),
          ...(recordingMutation ? { recording: recordingMutation } : {}),
          ...(compactionRequestFailure ? { compactionRequestFailure } : {}),
        });
        if (result.action === "stale") {
          // The terminal write can lose to a control transaction before the
          // workflow delivers Temporal cancellation. That control may settle
          // the already-closed attempt as rejected_stale, so returning without
          // this flag would strand its replacement behind quiesced_at forever.
          // Enter the same hard tool-fence/receipt path as an explicit
          // TurnAttemptFencedError. If ownership was lost for an unrelated
          // reason, allowUninterrupted makes the receipt transaction a no-op.
          acknowledgeLostAttemptOwnership();
          if (recordingForSettlement) {
            await abandonActiveRecording(
              "recording settlement lost attempt ownership",
              preparedRecording?.mutation.action === "discard" ? "discard" : "failed",
            );
          }
          activityStatus = "cancelled";
          turnMetricOutcome = "cancelled";
          return false;
        }
        if (recordingForSettlement && preparedRecording) {
          if (result.recordingMutationApplied) {
            activeRecording = null;
            if (preparedRecording.deleteArtifactsAfterCommit) {
              await deleteRecordingArtifacts(
                resolvedSandbox!.established.session,
                recordingForSettlement.proc,
              );
            }
          } else {
            await abandonActiveRecording("recording row was unavailable during turn settlement");
          }
        }
        await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, result.events);
        activityContext?.heartbeat({
          ...heartbeatDetails,
          phase: "events_published",
          producerSeq,
        });
        return true;
      };
      activityContext?.heartbeat({
        ...heartbeatDetails,
        phase: "turn_started",
      });

      // A shutdown that landed during claim/billing setup stops before the turn
      // visibly starts: nothing ran yet, so the same inference starts cleanly
      // on a healthy worker.
      throwIfWorkerShuttingDown();
      throwIfTurnCancelled();
      if (
        !(await settle({
          events: [
            { type: "session.status.changed", payload: { status: "running" } },
            {
              type: "turn.started",
              payload: { triggerEventId },
            },
          ],
          turnStatus: "running",
          sessionStatus: "running",
          activeTurnId: turnId,
        }))
      ) {
        return claimedResult({ status: "cancelled" });
      }
      turnStartedPublished = true;

      // Multi-account (P1): resolve the effective Codex account for this turn
      // (session-pin > workspace active) and stamp it on the session so the
      // in-session "Running on:" indicator reflects reality. Emit a switch event
      // when it changed from the prior run's account so the pill flips live.
      // Gated on the codex-billed predicate — non-codex turns never touch this.
      if (isCodexTurn) {
        const sessionCodex = await getSessionCodexState(db, input.workspaceId, input.sessionId);
        const sessionPin = sessionCodex?.pinnedCredentialId ?? null;
        const sessionPinSource = sessionCodex?.pinSource ?? null;
        const selectForTurn = (context: CodexCredentialLeaseSelectionContext) =>
          selectCodexCredentialLeaseForTurn({
            context,
            leasingEnabled: settings.codexCredentialLeasingEnabled,
            sessionId: input.sessionId,
            sessionPinnedCredentialId: sessionPin,
            sessionPinSource,
            sessionLastCredentialId: sessionCodex?.lastCredentialId ?? null,
            continuationCredentialId: continuationCodexCredentialId,
            now: new Date(),
          });

        // Rollout/rollback path is intentionally table-inert. With the flag off,
        // old and new workers both use legacy pin > active-pointer selection and
        // neither reads nor writes the additive lease/cursor schema.
        let leased: CodexCredentialLeaseResult<RotationDecision>;
        let leaseAcquisitionStartedAtMs: number | null = null;
        if (settings.codexCredentialLeasingEnabled) {
          leaseAcquisitionStartedAtMs = performance.now();
          leased = await acquireCodexCredentialLease(
            db,
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              turnId,
              holderId: codexLeaseHolderId,
              advanceActivePointer: sessionPin === null,
              continuationCredentialId: continuationCodexCredentialId,
            },
            selectForTurn,
          );
        } else {
          const [rotation, accounts] = await Promise.all([
            getCodexRotationSettings(db, input.workspaceId),
            listCodexAccountStatuses(db, input.workspaceId),
          ]);
          const leaseAccounts = accounts.map((account) => ({
            ...account,
            activeLeaseCount: 0,
            selectionCount: 0,
            lastSelectedAt: null,
          }));
          const activeCredentialId = rotation?.activeCredentialId ?? null;
          const selected = selectForTurn({
            accounts: leaseAccounts,
            activeCredentialId,
            rotationEnabled: rotation?.rotationEnabled ?? false,
            leaseRotationEnabled: false,
            rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
            existingCredentialId: null,
            policyScope: null,
            unavailableDiagnostics: [],
          });
          leased = {
            ...selected,
            accounts: leaseAccounts,
            activeCredentialId,
            rotationEnabled: rotation?.rotationEnabled ?? false,
            rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
            reused: false,
            holderId: null,
            generation: null,
            leasedUntil: null,
            unavailableDiagnostics: [],
            advanceActivePointer: selected.advanceActivePointer !== false,
          };
        }
        if (leased.decision.kind === "allCapped") {
          // Bounded self-heal of stale usage cache, then ONE new atomic selection.
          await refreshCappedCodexUsageRows(db, settings, input.workspaceId, leased.accounts, {
            signalCodexCapacityWorkflow,
            wakeSessionWorkflow,
          });
          if (settings.codexCredentialLeasingEnabled) {
            leaseAcquisitionStartedAtMs = performance.now();
            leased = await acquireCodexCredentialLease(
              db,
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                turnId,
                holderId: codexLeaseHolderId,
                advanceActivePointer: sessionPin === null,
                continuationCredentialId: continuationCodexCredentialId,
              },
              selectForTurn,
            );
          } else {
            const [rotation, accounts] = await Promise.all([
              getCodexRotationSettings(db, input.workspaceId),
              listCodexAccountStatuses(db, input.workspaceId),
            ]);
            const leaseAccounts = accounts.map((account) => ({
              ...account,
              activeLeaseCount: 0,
              selectionCount: 0,
              lastSelectedAt: null,
            }));
            const selected = selectForTurn({
              accounts: leaseAccounts,
              activeCredentialId: rotation?.activeCredentialId ?? null,
              rotationEnabled: rotation?.rotationEnabled ?? false,
              leaseRotationEnabled: false,
              rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
              existingCredentialId: null,
              policyScope: null,
              unavailableDiagnostics: [],
            });
            leased = {
              ...selected,
              accounts: leaseAccounts,
              activeCredentialId: rotation?.activeCredentialId ?? null,
              rotationEnabled: rotation?.rotationEnabled ?? false,
              rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
              reused: false,
              holderId: null,
              generation: null,
              leasedUntil: null,
              unavailableDiagnostics: [],
              advanceActivePointer: selected.advanceActivePointer !== false,
            };
          }
        }
        const rotationDecision = leased.decision;
        const selectedPinDisposition = classifyCodexPin({
          pinnedCredentialId: sessionPin,
          pinSource: sessionPinSource,
          strategy: leased.rotationStrategy as CodexRotationStrategy,
          rotationEnabled: leased.rotationEnabled,
        });
        // pin policy pin persistence follows the atomic credential allocator selection. The selector
        // already ran exact-turn reuse before policy filtering and vetoed pointer
        // movement for manual/policy homes; this write only records the NEXT turn's
        // policy home (or clears a policy pin whose strategy is no longer active).
        if (
          selectedPinDisposition === "sharded" &&
          leased.credentialId !== null &&
          (sessionPinSource !== "policy" || sessionPin !== leased.credentialId)
        ) {
          const pinMutation = await withCodexCapacityMutation(
            db,
            {
              workspaceId: input.workspaceId,
              reason: "codex_policy_pin_changed",
            },
            async (tx) => {
              const changed = await setSessionCodexPin(
                tx,
                input.workspaceId,
                input.sessionId,
                leased.credentialId,
                "policy",
                {
                  expected: {
                    pinnedCredentialId: sessionPin,
                    pinSource: sessionPinSource,
                  },
                },
              );
              return { result: changed, changed };
            },
          );
          await signalCodexCapacityWakeTargets(
            { signalCodexCapacityWorkflow, wakeSessionWorkflow },
            pinMutation.wakeTargets,
          );
        } else if (selectedPinDisposition === "clearStale") {
          const pinMutation = await withCodexCapacityMutation(
            db,
            {
              workspaceId: input.workspaceId,
              reason: "codex_stale_policy_pin_cleared",
            },
            async (tx) => {
              const changed = await setSessionCodexPin(
                tx,
                input.workspaceId,
                input.sessionId,
                null,
                "policy",
                {
                  expected: {
                    pinnedCredentialId: sessionPin,
                    pinSource: sessionPinSource,
                  },
                },
              );
              return { result: changed, changed };
            },
          );
          await signalCodexCapacityWakeTargets(
            { signalCodexCapacityWorkflow, wakeSessionWorkflow },
            pinMutation.wakeTargets,
          );
        }
        if (
          !settings.codexCredentialLeasingEnabled &&
          leased.advanceActivePointer &&
          sessionPin === null &&
          rotationDecision.kind === "active" &&
          rotationDecision.moved
        ) {
          await setActiveCodexCredential(db, input.workspaceId, rotationDecision.credentialId);
        }
        effectiveCodexCredentialId = leased.credentialId;
        codexLeaseGeneration = leased.generation;
        codexLeaseConfirmedUntilMs =
          leased.leasedUntil && leaseAcquisitionStartedAtMs !== null
            ? leaseAcquisitionStartedAtMs + CODEX_CREDENTIAL_LEASE_TTL_MS
            : null;
        codexLeaseHeld =
          effectiveCodexCredentialId !== null &&
          leased.holderId !== null &&
          leased.generation !== null &&
          codexLeaseConfirmedUntilMs !== null;
        if (codexLeaseHeld) startCodexLeaseHeartbeat();

        const eligibleCount = leased.accounts.filter((account) =>
          isCodexCredentialEligible(account, new Date()),
        ).length;
        const poolDepth = eligibleCount === 0 ? "zero" : eligibleCount === 1 ? "one" : "many";
        observability.incrementCounter({
          name: "opengeni_codex_pool_observations_total",
          help: "Observed eligible Codex pool depth buckets at turn selection.",
          labels: { workspace_key: codexWorkspaceKey, depth: poolDepth },
        });
        if (eligibleCount <= 1) {
          observability.incrementCounter({
            name: "opengeni_codex_pool_low_total",
            help: "Alert signal emitted when the eligible Codex pool is zero or one.",
            labels: { workspace_key: codexWorkspaceKey, depth: poolDepth },
          });
          observability.warn("Codex eligible credential pool is low", {
            workspaceId: input.workspaceId,
            eligibleCount,
            connectedCount: leased.accounts.length,
            depth: poolDepth,
          });
        }

        if (
          effectiveCodexCredentialId === null &&
          leased.accounts.length > 0 &&
          leased.accounts.every((account) => !account.allocatorEnabled) &&
          turnId
        ) {
          if (turn.source === "compaction") {
            if (
              !(await settle!({
                events: [
                  {
                    type: "turn.cancelled",
                    payload: {
                      maintenance: "context_compaction",
                      reason: "codex_allocator_disabled",
                      requestPreserved: true,
                    },
                  },
                  {
                    type: "session.status.changed",
                    payload: { status: "idle" },
                  },
                ],
                turnStatus: "cancelled",
                sessionStatus: "idle",
                activeTurnId: null,
              }))
            ) {
              return claimedResult({ status: "cancelled" });
            }
            turnMetricOutcome = "cancelled";
            activityStatus = "idle";
            return claimedResult({ status: "idle", deferredUntilWake: true });
          }
          const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(
            () => null,
          );
          if (goal?.status === "active") {
            const armed = await armCodexCapacityWait(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              attemptId: input.attemptId,
              workflowId: input.workflowId,
              goalId: goal.id,
              goalVersion: goal.version,
              earliestResetAt: null,
              resetKind: "bounded_refresh",
              failurePayload: {
                error: "All connected Codex subscriptions are disabled for new allocations.",
                code: "codex_allocator_disabled",
                detail: "waiting for a credential to be re-enabled, reconnected, or added",
              },
            });
            if (armed.action === "waiting") {
              await publishDurableSessionEvents(
                bus,
                input.workspaceId,
                input.sessionId,
                armed.events,
              );
              turnMetricOutcome = "failed";
              activityStatus = "idle";
              return claimedResult({
                status: "idle",
                capacityWait: {
                  waiterId: armed.waiter.id,
                  generation: armed.waiter.generation,
                  nextCheckAt: armed.waiter.nextCheckAt.toISOString(),
                  wakeRevision: armed.waiter.wakeRevision,
                },
              });
            }
          }
          if (
            !(await settle!({
              events: [
                {
                  type: "turn.failed",
                  payload: {
                    error: "All connected Codex subscriptions are disabled for new allocations.",
                    code: "codex_allocator_disabled",
                    retryable: false,
                    recovery: "user_message",
                  },
                },
                { type: "session.status.changed", payload: { status: "idle" } },
              ],
              turnStatus: "failed",
              sessionStatus: "idle",
              activeTurnId: null,
            }))
          ) {
            return claimedResult({ status: "cancelled" });
          }
          turnMetricOutcome = "failed";
          activityStatus = "idle";
          return claimedResult({ status: "idle" });
        }

        if (rotationDecision.kind === "allCapped" && turnId) {
          if (turn.source === "compaction") {
            if (
              !(await settle!({
                events: [
                  {
                    type: "turn.cancelled",
                    payload: {
                      maintenance: "context_compaction",
                      reason: "codex_capacity_unavailable",
                      requestPreserved: true,
                    },
                  },
                  {
                    type: "session.status.changed",
                    payload: { status: "idle" },
                  },
                ],
                turnStatus: "cancelled",
                sessionStatus: "idle",
                activeTurnId: null,
              }))
            ) {
              return claimedResult({ status: "cancelled" });
            }
            turnMetricOutcome = "cancelled";
            activityStatus = "idle";
            return claimedResult({ status: "idle", deferredUntilWake: true });
          }
          // Every eligible account is capped/cooling (and a usage refresh did NOT
          // surface a reset): idle the turn AT THE BOUNDARY (no wasted model/sandbox
          // build) until the EARLIEST reset across all accounts — the multi-account
          // generalization of #143's single-account idle-until-reset. No saveRunState:
          // no model ran, nothing to freeze.
          const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(
            () => null,
          );
          const goalActive = Boolean(goal && goal.status === "active");
          // BOUNDED + POSITIVE: clamp to [MIN_IDLE_MS, max] so a null/elapsed/unknown
          // reset can never yield a 0 (which session.ts would treat as "continue now",
          // re-entering this path in a tight CPU/DB-hammering loop).
          const resumeMs = computeIdleDelayMs(
            rotationDecision.earliestResetAt,
            new Date(),
            CODEX_USAGE_LIMIT_MAX_RESUME_MS,
          );
          const failurePayload = codexUsageLimitFailurePayload(
            { resetsInSeconds: Math.ceil(resumeMs / 1000) },
            "all connected Codex subscriptions are rate-limited",
            { allAccounts: true },
          );
          if (goalActive && goal) {
            const authoritativeResetAt = authoritativeCodexCapacityResetAt(
              leased.accounts,
              new Date(),
            );
            const armed = await armCodexCapacityWait(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              attemptId: input.attemptId,
              workflowId: input.workflowId,
              goalId: goal.id,
              goalVersion: goal.version,
              earliestResetAt: authoritativeResetAt,
              resetKind: authoritativeResetAt ? "authoritative" : "bounded_refresh",
              failurePayload,
            });
            if (armed.action === "waiting") {
              await publishDurableSessionEvents(
                bus,
                input.workspaceId,
                input.sessionId,
                armed.events,
              );
              turnMetricOutcome = "failed";
              activityStatus = "idle";
              return claimedResult({
                status: "idle",
                capacityWait: {
                  waiterId: armed.waiter.id,
                  generation: armed.waiter.generation,
                  nextCheckAt: armed.waiter.nextCheckAt.toISOString(),
                  wakeRevision: armed.waiter.wakeRevision,
                },
              });
            }
          }
          if (
            !(await settle!({
              events: [
                // `rotated:true` (Finding 2): the proactive all-capped wait is the SAME
                // rotation-wait state as the reactive all-capped path, so it must freeze
                // autoContinuations identically (evaluateGoalContinuation reads this marker)
                // — a goal waiting out a long reset must not burn its continuation budget on
                // the proactive path while the reactive path spares it.
                {
                  type: "turn.failed",
                  payload: {
                    ...failurePayload,
                    recovery: goalActive ? "goal_continuation" : "user_message",
                    rotated: true,
                  },
                },
                { type: "session.status.changed", payload: { status: "idle" } },
              ],
              turnStatus: "failed",
              sessionStatus: "idle",
              activeTurnId: null,
            }))
          ) {
            return claimedResult({ status: "cancelled" });
          }
          turnMetricOutcome = "failed";
          activityStatus = "idle";
          // idleUntilReset marks this a MANDATORY hold: session.ts must wait the full
          // resumeMs even if a future change made it 0 — never a tight re-dispatch.
          return claimedResult(
            goalActive
              ? {
                  status: "idle",
                  continueDelayMs: resumeMs,
                  idleUntilReset: true,
                }
              : { status: "idle" },
          );
        }
        if (effectiveCodexCredentialId) {
          const priorAccountId = sessionCodex?.lastCredentialId ?? null;
          await recordSessionActiveCodexCredential(
            db,
            input.workspaceId,
            input.sessionId,
            effectiveCodexCredentialId,
          );
          if (priorAccountId !== effectiveCodexCredentialId) {
            const rotated = rotationDecision.kind === "active" && rotationDecision.moved;
            // P4: surface the dropped-connector note when this rotation pick couldn't
            // cover the session's used connectors (a Tier-2/unknown failover); the pill
            // renders the badge. Omitted when the switch covered everything (the norm).
            const droppedConnectors =
              rotationDecision.kind === "active" ? rotationDecision.droppedConnectors : undefined;
            await publish([
              {
                type: "codex.account.switched",
                payload: {
                  fromAccountId: priorAccountId,
                  toAccountId: effectiveCodexCredentialId,
                  reason: rotated ? "rotation" : "manual",
                  ...(droppedConnectors && droppedConnectors.length > 0
                    ? { droppedConnectors }
                    : {}),
                },
              },
            ]);
          }

          const selectionReason = leased.reused
            ? "lease_reused"
            : sessionPin === effectiveCodexCredentialId
              ? "pin"
              : rotationDecision.kind === "active" && rotationDecision.moved
                ? "rotation"
                : "active";
          observability.incrementCounter({
            name: "opengeni_codex_credential_selections_total",
            help: "Codex credential selections by strategy and reason.",
            labels: {
              workspace_key: codexWorkspaceKey,
              strategy: leased.rotationStrategy,
              reason: selectionReason,
            },
          });
          await publish([
            {
              type: "codex.credential.selected",
              payload: {
                credentialId: effectiveCodexCredentialId,
                strategy: leased.rotationStrategy,
                reason: selectionReason,
                eligibleCount,
                connectedCount: leased.accounts.length,
                reused: leased.reused,
              },
            },
          ]);
        }
      }

      // Pack-scoped runtime: enabled packs may declare the sandbox image this
      // workspace's sessions run in and skills for the sandbox skill index.
      // Resolved after turn.started so a composition conflict (two enabled
      // packs declaring images) fails the turn with its plain error instead
      // of failing the activity opaquely.
      const packRuntime = await resolveWorkspacePackRuntime(db, input.workspaceId);
      // RIG BINDING (M3): load the session's FROZEN rig version (resolved+frozen
      // at create). Everything rig-derived below (image precedence, env default
      // sets, setup hook, credential hooks, doctrine, lease/telemetry stamps) is
      // gated on this being non-null, so a rig-less session takes a zero-cost
      // branch that is byte-for-byte today's turn. Both ids are frozen together;
      // a defensive null (e.g. a since-deleted rig FK-nulled the columns) simply
      // runs the turn rig-less.
      const rigVersion =
        session.rigId && session.rigVersionId
          ? await getRigVersion(db, input.workspaceId, session.rigId, session.rigVersionId)
          : null;
      // Rig display name for the doctrine block + setup events/errors (only on a
      // rig-bound turn; null-safe fallback keeps the turn alive if the rig row is
      // gone). Loaded once here alongside the version.
      const rigName =
        rigVersion && session.rigId
          ? ((await getRigName(db, input.workspaceId, session.rigId)) ?? "rig")
          : null;
      // Telemetry: stamp the frozen rig binding (empty for a rig-less turn).
      rigId = session.rigId ?? "";
      rigVersionId = session.rigVersionId ?? "";
      // Workspace tier of the agent-persona resolution (session > workspace >
      // deployment default). null means the workspace has no override, so the
      // runtime falls back to runSettings.agentInstructionsTemplate (the
      // deployment default, byte-identical to the historical preamble).
      const workspaceAgentInstructions = await resolveWorkspaceAgentInstructions(
        db,
        input.workspaceId,
      );
      const workspaceMemory = await resolveWorkspaceMemoryBlock(db, input.workspaceId);
      const baseRunSettings = {
        // IMAGE PRECEDENCE (M3): rig > pack > deployment. settingsWithRigImage runs
        // OUTERMOST so a rig-pinned image overrides both the pack image and the
        // deployment default; a rig with no image (or a rig-less turn) is a
        // pass-through, leaving the pack/deployment chain exactly as today.
        ...settingsWithRigImage(
          settingsWithPackSandboxImage(capabilitySettings, packRuntime.sandboxImage),
          rigVersion?.image ?? null,
        ),
        openaiModel: turn.model,
        openaiReasoningEffort: turn.reasoningEffort,
        sandboxBackend: turn.sandboxBackend,
      };
      const runSettings = await settingsWithSessionMcpServersForRun(
        db,
        input.workspaceId,
        input.sessionId,
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
      const resolvedModel = runtime.resolveTurnModel(capabilitySettings, turn.model);
      // Bind the provider/model catalog's context policy to every model-facing
      // path for this turn. In particular, Codex subscription turns must not
      // inherit the deployment's OpenAI/Azure mode or 1.05M context defaults:
      // raw window, effective ceiling, and auto-compact limit are distinct live
      // catalog values and must reach pre-turn compaction, history guards, and
      // every model call together.
      modelRunSettings = resolvedModel
        ? settingsWithResolvedModelContext(runSettings, resolvedModel.configured)
        : runSettings;
      // WORKSPACE MODEL POLICY — the authoritative hard gate. Runs immediately
      // after resolution and BEFORE any model call (the compaction summarizer
      // and the main run both come later in this scope), so a blocked
      // provider/model can never be reached through ANY stamp path: explicit
      // turn model, inherited session default, goal-continuation inheritance,
      // or the legacy null-resolution fallback (null → the built-in
      // OpenAI/Azure client, attributed here via builtinProviderId so a policy
      // blocking the built-in also blocks that fallback — this exact path is
      // how bare-model turns silently spent real Azure money in a
      // codex-intended workspace). Fail-loud, never a silent remap.
      {
        const workspaceModelPolicy = await getWorkspaceModelPolicy(db, input.workspaceId);
        if (workspaceModelPolicy) {
          const effectiveProviderId = resolvedModel
            ? resolvedModel.provider.id
            : builtinProviderId(capabilitySettings);
          const verdict = evaluateWorkspaceModelPolicy(workspaceModelPolicy, {
            providerId: effectiveProviderId,
            modelId: turn.model,
          });
          if (!verdict.allowed) {
            throw new WorkspaceModelPolicyBlockedError(
              turn.model,
              effectiveProviderId,
              verdict.reason,
            );
          }
        }
      }
      // A codex-subscription turn resolves the bearer for THIS turn's effective
      // codex account (effectiveCodexCredentialId; pin > workspace-active) at
      // model-call time — multi-account P1 means a workspace can hold N accounts,
      // so the bearer is per-account, not per-workspace. codexSubscriptionFetch
      // (on the provider's OpenAI client) reads this AsyncLocalStorage context.
      // Build it once and wrap BOTH the compaction summarizer (a separate model
      // call on the same codex client) and the main run; otherwise the summarizer
      // would hit the codex backend unauthenticated.
      const codexContext: CodexRequestContext | null =
        resolvedModel?.provider.kind === "codex-subscription"
          ? ((): CodexRequestContext => {
              // The empty-string fallback yields no row → null credential → the
              // existing CodexReloginRequired path (a codex turn with no usable
              // account fails closed, exactly as before multi-account).
              const resolver = buildCodexTokenResolver(
                db,
                runSettings,
                input.workspaceId,
                effectiveCodexCredentialId ?? "",
              );
              return {
                clientVersion: CODEX_CLIENT_VERSION,
                // Backend sticky cache-routing key — the SAME id as the body's
                // prompt_cache_key (set from input.sessionId for codex turns),
                // so routing and cache key agree. Without this header on the
                // wire, byte-identical resends hit the prompt cache ~50%
                // (per-request shard lottery = prod's measured 48.6% on sol);
                // with it, resends pin to the warm shard (Codex CLI parity).
                sessionId: input.sessionId,
                getToken: resolver.getToken,
                refresh: resolver.refresh,
                resolveModel: buildModelResolver(
                  CODEX_FALLBACK_MODEL_SLUGS,
                  CODEX_FALLBACK_MODEL_SLUGS[0],
                ),
                onUsageHeaders: (snapshot) => {
                  latestCodexUsage = snapshot;
                }, // latest wins; flushed once in finally
              };
            })()
          : null;
      const withCodex = <T>(fn: () => Promise<T>): Promise<T> =>
        codexContext ? codexRequestStorage.run(codexContext, fn) : fn();
      const promptCacheKey = acceptsPromptCacheKeyForTurn(resolvedModel)
        ? input.sessionId
        : undefined;
      let compactionUsageCount = 0;
      const recordCompactionUsage = async (usage: ModelResponseUsage) => {
        await recordCompletedModelCallBeforeOwnershipFences({
          renewLease: () => renewCodexLease("model_usage"),
          leaseLost: () => codexLeaseLost,
          leaseLostMessage: "Codex credential lease expired during context compaction",
          recordUsage: async () => {
            compactionUsageCount += 1;
            const sourceKey = modelUsageSourceKey({
              responseId: usage.responseId,
              dispatchId: modelUsageDispatchId,
              positionalKey: `compaction-${compactionUsageCount}`,
            });
            const responseAccountCtx = modelCallAccountContext({
              servingCredentialId: effectiveCodexCredentialId,
              priorSessionCredentialId: priorSessionCodexCredentialId,
              isFirstCallOfTurn: compactionUsageCount === 1,
            });
            await recordModelUsageAndDebitCredits(settings, db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turn.id,
              turnAttemptId: input.attemptId,
              model: resolvedModel?.configured.id ?? turn.model,
              isCodexTurn,
              usage: usage.usage,
              sourceKey,
              observability,
            });
            await emitModelCallUsage({
              observability,
              publish,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turn.id,
              provider: resolvedModel?.provider.id ?? settings.openaiProvider,
              providerApi: resolvedModel?.provider.api ?? "responses",
              model: resolvedModel?.configured.id ?? turn.model,
              sourceKey,
              usage,
              servingAccountHash: responseAccountCtx.servingAccountHash,
              accountChangedFromPrevCall: responseAccountCtx.accountChangedFromPrevCall,
              emittedSourceKeys: emittedModelUsageSourceKeys,
            });
          },
        });
      };
      const compactionSummarizerFor = (systemInstructions?: string) =>
        resolvedModel
          ? (s: Settings, m: Array<Record<string, unknown>>) =>
              withCodex(() =>
                summarizeForCompaction(s, m, {
                  client: resolvedModel.client,
                  api: resolvedModel.provider.api,
                  model: resolvedModel.configured.id,
                  maxOutputTokens: SUMMARY_BUFFER_TOKENS,
                  onUsage: recordCompactionUsage,
                  ...(systemInstructions ? { systemInstructions } : {}),
                  ...(promptCacheKey ? { promptCacheKey } : {}),
                }),
              )
          : (s: Settings, m: Array<Record<string, unknown>>) =>
              summarizeForCompaction(s, m, {
                maxOutputTokens: SUMMARY_BUFFER_TOKENS,
                onUsage: recordCompactionUsage,
                ...(systemInstructions ? { systemInstructions } : {}),
                ...(promptCacheKey ? { promptCacheKey } : {}),
              });

      if (turn.source === "compaction") {
        const persistentSessionSettings = {
          titleIsSet: Boolean(session.title?.trim()),
        };
        const compactionInstructions = appendPersistentSessionSettings(
          appendSessionInstructions(
            appendWorkspaceMemory(
              composeAgentInstructions(
                workspaceAgentInstructions ?? modelRunSettings.agentInstructionsTemplate,
                undefined,
                rigVersion && rigName ? { name: rigName, version: rigVersion.version } : undefined,
              ),
              workspaceMemory ?? undefined,
            ),
            session.instructions ?? undefined,
          ),
          persistentSessionSettings,
        );
        const requested = await isSessionCompactionRequested(
          db,
          input.workspaceId,
          input.sessionId,
        );
        let outcome: Awaited<ReturnType<typeof maybeCompactContext>> | null = null;
        if (requested) {
          try {
            outcome = await waitForTurnOperation(
              maybeCompactContext(
                db,
                modelRunSettings,
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  turnId: turn.id,
                  executionGeneration,
                  attemptId: input.attemptId,
                },
                session.lastInputTokens,
                compactionSummarizerFor(compactionInstructions),
                {
                  force: true,
                  clearRequestedCompaction: true,
                  trigger: "operator",
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
            if (!isCompactionSummaryFailure(error)) throw error;
            const errorMessage = compactionFailureReasonFromError(error);
            if (
              !(await settle!({
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
                consumeRequestedCompactionFailure: true,
              }))
            ) {
              return claimedResult({ status: "cancelled" });
            }
            turnMetricOutcome = "failed";
            activityStatus = "idle";
            activityError = error;
            return claimedResult({ status: "idle" });
          }
          if (outcome.events.length > 0) {
            if (outcome.compacted) {
              recordContextCompaction(observability, "operator");
            }
            await publishDurableSessionEvents(
              bus,
              input.workspaceId,
              input.sessionId,
              outcome.events,
            );
          }
        }
        if (
          !(await settle!({
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
          return claimedResult({ status: "cancelled" });
        }
        turnMetricOutcome = "completed";
        activityStatus = "idle";
        return claimedResult({ status: "idle" });
      }

      const turnResources = mergeResourceRefs(session.resources, turn.resources);
      // Attach the first-party MCP server to EVERY turn, regardless of how/when
      // the session was created (API, scheduled task, or a pre-existing session
      // whose stored tools predate this) — so set_session_title and the rest are
      // always reachable. Idempotent: mergeToolRefs dedupes if already present.
      // Attach codex_apps (the ChatGPT/Codex connectors MCP) when the codex
      // overlay injected it into runSettings.mcpServers (active subscription +
      // connector scopes); no-op for every other turn. Its refreshing bearer is
      // resolved at connect time from the codex ALS (see the withCodex-wrapped
      // prepareTools call below).
      const turnTools = withCodexAppsTool(
        runSettings,
        withFirstPartyTools(runSettings, mergeToolRefs(session.tools, turn.tools)),
      );
      // §7.6 connection-credential provider — load (and decrypt) the variable set via the host
      // `sandboxSecrets` provider when bound; unset → today's local decrypt.
      const connectionScope = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
      };
      const workspaceVariableSet = await waitForTurnOperation(
        loadWorkspaceEnvironmentForRunWithCredentials(
          db,
          runSettings,
          connectionScope,
          session.variableSetId,
          connectionCredentials?.sandboxSecrets,
        ),
        cancellationSignal,
        undefined,
      );
      variableSetId = workspaceVariableSet?.id ?? "";
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
      const rigDefaultEnvironmentValues: Record<string, string> = {};
      for (const rigDefaultVariableSetId of rigVersion?.defaultVariableSetIds ?? []) {
        const rigDefaultSet = await waitForTurnOperation(
          loadWorkspaceEnvironmentForRunWithCredentials(
            db,
            runSettings,
            connectionScope,
            rigDefaultVariableSetId,
            connectionCredentials?.sandboxSecrets,
          ),
          cancellationSignal,
          undefined,
        );
        Object.assign(rigDefaultEnvironmentValues, rigDefaultSet?.values ?? {});
      }
      // Session set wins collisions with the rig defaults (explicit precedence).
      const sandboxWorkspaceEnvironmentValues = mergeRigDefaultVariableSetEnvironment(
        rigDefaultEnvironmentValues,
        workspaceVariableSet?.values ?? {},
      );
      // Redact EVERY exported secret value (rig defaults + session set) from turn
      // output, not just the session set's.
      registerSecretRedactions(
        Object.entries(sandboxWorkspaceEnvironmentValues).map(([name, value]) => ({ name, value })),
      );
      // EFFECTIVE compute backend, resolved ONCE at turn start (Case B + Stage D
      // D1-lite) and reused for EVERY downstream decision: the env mint (skip
      // inert platform git tokens for a machine turn), the establish path (no phantom Modal
      // home box for a machine-primary turn), buildAgent (skip the repository clone
      // hook so a private repo is never `git clone`d onto the user's real disk), and
      // the warm-rate (a machine accrues ZERO cloud warm-seconds). The active pointer
      // + its sandbox row are loaded ONCE here (best-effort, never throwing) and the
      // SAME values feed resolveActiveSandboxBackend (the tested gate) AND the
      // machine-primary establish branch (enrollmentId/epoch/workingDir) below — no
      // double read, no read-skew between the gate decision and the establish. With
      // routing OFF this is byte-for-byte the legacy path: no reads, undefined backend.
      const routingOn = routingEnabled(settings);
      let activeSandboxPointer = routingOn
        ? await readActiveSandbox(db, input.workspaceId, input.sessionId).catch(() => null)
        : null;
      // TURN-START RECONCILE (issue #341 invariant B / Shapes 1+2): a persisted
      // pointer whose target is STRUCTURALLY unestablishable at turn start would strand
      // EVERY op of this turn — reset it to the session HOME under the epoch fence +
      // emit a visible event, honoring a concurrent higher-epoch swap. The sandbox row
      // is loaded HERE, inside reconcile, via a NON-swallowing lookup: a null decision
      // then means the row is genuinely absent, never a suppressed transient DB error
      // (which would wrongly clear a healthy user-chosen pointer). On a lookup throw the
      // reconcile fails open — pointer untouched, record null (machinePrimary:false),
      // no event — and the establish branch below reads the returned values.
      let activeSandboxRecord: SandboxRecord | null = null;
      if (routingOn) {
        const reconciled = await reconcileActiveSandboxPointer(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
          },
          activeSandboxPointer,
          (sandboxId) => getSandbox(db, input.workspaceId, sandboxId),
          publish
            ? async (events) => {
                await publish!(events);
              }
            : undefined,
        );
        activeSandboxPointer = reconciled.pointer;
        activeSandboxRecord = reconciled.record;
      }
      const activeSandboxBackend = await resolveActiveSandboxBackend(
        routingOn,
        async () => activeSandboxPointer,
        async () => activeSandboxRecord?.kind ?? null,
      );
      // A machine-primary turn = the effective backend is selfhosted AND we have the
      // machine's enrollment (agent id) + a non-null pointer to bind it. Anything
      // missing (should not happen — the DB enforces selfhosted⇒enrollmentId) falls
      // back to the cloud establish path (a correct, if phantom, box) rather than
      // crashing the turn.
      const machinePrimary =
        activeSandboxBackend === "selfhosted" &&
        Boolean(activeSandboxPointer?.activeSandboxId) &&
        Boolean(activeSandboxRecord?.enrollmentId);
      // The backend that can actually create a sandbox for this turn. In the
      // common path this is runSettings.sandboxBackend. A selfhosted home turn
      // that is NOT machine-primary falls back to the deployment cloud backend
      // so swap-away / flag-off degrade to a real group box.
      const groupBoxBackend: Settings["sandboxBackend"] =
        runSettings.sandboxBackend === "selfhosted" && !machinePrimary
          ? settings.sandboxBackend
          : runSettings.sandboxBackend;
      const sandboxCreationBackend: Settings["sandboxBackend"] =
        settings.sandboxOwnershipEnabled && runSettings.sandboxBackend !== "none"
          ? groupBoxBackend
          : runSettings.sandboxBackend;
      const effectiveRunCredentialBackend = activeSandboxBackend ?? groupBoxBackend;
      const runCredentialResolver =
        effectiveRunCredentialBackend === "none"
          ? null
          : await waitForTurnOperation(
              bindRunCredentialResolver({
                db,
                connectionCredentials: connectionCredentials ?? null,
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                session,
                turn,
                attemptId: input.attemptId,
                effectiveSandboxBackend: effectiveRunCredentialBackend,
                variableSet: workspaceVariableSet
                  ? {
                      id: workspaceVariableSet.id,
                      name: workspaceVariableSet.name,
                    }
                  : null,
              }),
              cancellationSignal,
              undefined,
            );
      const initialRunCredentialMaterial = runCredentialResolver
        ? await waitForTurnOperation(
            runCredentialResolver.resolve({
              purpose: "provision",
              forceRefresh: false,
            }),
            cancellationSignal,
            undefined,
          )
        : null;
      if (initialRunCredentialMaterial) {
        registerSecretRedactions(initialRunCredentialMaterial.redactions);
        for (const payload of runCredentialAuthNeededPayloads(initialRunCredentialMaterial)) {
          publishedRunCredentialNotices.add(JSON.stringify(payload));
          await publish!([{ type: "credential.auth_needed", payload }], true);
        }
      }
      const runCredentialsNote = initialRunCredentialMaterial
        ? runCredentialModelNote(initialRunCredentialMaterial)
        : undefined;
      throwIfTurnOperationCancelled(cancellationSignal);
      await waitForTurnOperation(
        ensureTurnModalRegistryImage(runSettings, sandboxCreationBackend),
        cancellationSignal,
        undefined,
      );
      const establishPolicy: "eager" | "on-demand" =
        lazyProvisionEnabled(settings) && !machinePrimary && runSettings.sandboxBackend !== "none"
          ? "on-demand"
          : "eager";
      // Computed exactly ONCE per turn and reused for BOTH the box manifest
      // (resumeBoxForTurn -> establishSandboxSessionFromEnvelope, below) AND the
      // agent (runtime.buildAgent, below). sandboxEnvironmentForRun mints a FRESH
      // run-scoped git provider tokens on every call, so a second call would
      // yield DIFFERENT token values and re-introduce the manifest-env delta the
      // SDK's provided-session guard throws on — the box and the agent MUST share
      // this same object. A machine-primary turn skips the (inert) token mint entirely
      // (the machine uses its own git creds); the SAME base env still feeds the box +
      // the agent, so env-parity holds.
      // TOKEN-BROKER (B1): sandboxEnvironmentForRun now returns the STABLE manifest
      // env (no rotating GH_TOKEN/GITHUB_TOKEN/GIT_CONFIG_* extraheader) PLUS the
      // run-scoped git tokens minted ONCE per turn as provider seeds, with `gitToken`
      // retained as the GitHub alias. The env feeds BOTH the box manifest AND the
      // agent (env-parity, as before); tokens are threaded OFF-MANIFEST as
      // clone-seeds to buildAgent (below) so the box never carries rotating values
      // on its manifest. When a platform token IS minted, the host `gitCredentials`
      // provider may supply it; unset still self-mints GitHub from settings.
      // gitToken/gitTokens are undefined on the selfhosted skip path (the machine
      // uses its own git creds).
      if (activeSandboxBackend !== "selfhosted") {
        await assertGitHubResourcesRemainAuthorized(db, input.workspaceId, turnResources);
      }
      const authorizeGitHubTokenMint: GitHubTokenMintAuthorization = async (selection) => {
        await assertGitHubTokenMintSelectionAuthorized(
          db,
          input.workspaceId,
          selection.installationId,
          selection.repositoryIds,
        );
      };
      // Git and MCP credentials share one lineage snapshot for this turn. A
      // host that supplies both ports must never see two independently resolved
      // roots for the same execution merely because the call sites are far apart.
      const needsHostCredentialRoot = Boolean(
        connectionCredentials?.gitCredentials || connectionCredentials?.mcpCredentials,
      );
      const hostCredentialRootSessionId = needsHostCredentialRoot
        ? await getSessionRootId(db, input.workspaceId, input.sessionId)
        : null;
      if (needsHostCredentialRoot && !hostCredentialRootSessionId) {
        throw new Error(`cannot resolve host credentials for missing session ${input.sessionId}`);
      }
      const gitCredentialAuthority =
        connectionCredentials?.gitCredentials && hostCredentialRootSessionId
          ? gitCredentialAuthorityForTurn({
              sessionId: input.sessionId,
              rootSessionId: hostCredentialRootSessionId,
              attemptId: input.attemptId,
              turn,
            })
          : undefined;
      const {
        environment: sandboxEnvironment,
        gitToken: sandboxGitToken,
        gitTokens: sandboxGitTokens,
        gitTokenExpiresAt: sandboxGitTokenExpiresAt,
        gitCredentialBindings: sandboxGitCredentialBindings,
        toolspaceToken: sandboxToolspaceToken,
        toolspaceTokenExpiresAt: sandboxToolspaceTokenExpiresAt,
      } = await waitForTurnOperation(
        sandboxEnvironmentForRun(
          runSettings,
          turnResources,
          // Rig default sets merged BELOW the session set (session wins); rig-less
          // turns pass exactly workspaceVariableSet?.values (byte-for-byte today).
          sandboxWorkspaceEnvironmentValues,
          {
            skipGitHubToken: activeSandboxBackend === "selfhosted",
            deferGitHubToken:
              activeSandboxBackend !== "selfhosted" && establishPolicy === "on-demand",
            scope: connectionScope,
            ...(gitCredentialAuthority ? { authority: gitCredentialAuthority } : {}),
            gitCredentials: connectionCredentials?.gitCredentials,
            authorizeGitHubTokenMint,
            sessionId: input.sessionId,
            runId: turnId,
          },
        ),
        cancellationSignal,
        undefined,
      );
      const sandboxToolspaceTokenFile = sandboxToolspaceToken
        ? toolspaceTokenFileFromEnvironment(sandboxEnvironment, input.sessionId)
        : undefined;

      const initialGitCredentials: MintedRunGitCredentials | undefined =
        sandboxGitCredentialBindings
          ? {
              bindings: sandboxGitCredentialBindings,
              gitTokens: sandboxGitTokens ?? {},
              expiresAt: sandboxGitTokenExpiresAt ?? {},
            }
          : undefined;
      const attachGitCredentialRenewal = async (
        tokenSession: GitCredentialTokenWriterSession,
        initial: MintedRunGitCredentials | undefined,
      ): Promise<void> => {
        if (!initial || initial.bindings.length === 0) return;
        const previous = gitCredentialRenewals;
        gitCredentialRenewals = [];
        await Promise.all(previous.map(async (controller) => await controller.stop()));
        if (gitCredentialRenewalClosed) return;

        const controllers = initial.bindings.map((initialBinding) => {
          let pendingBinding: typeof initialBinding | undefined;
          return startGitCredentialRenewalLoop({
            expectedProviders: [initialBinding.provider],
            initialExpiresAt: initialBinding.expiresAt
              ? { [initialBinding.provider]: initialBinding.expiresAt }
              : {},
            mint: async () => {
              const binding = await mintRunGitCredentialBinding(
                runSettings,
                turnResources,
                initialBinding.provider,
                initialBinding.credentialBindingId,
                {
                  scope: connectionScope,
                  ...(gitCredentialAuthority ? { authority: gitCredentialAuthority } : {}),
                  gitCredentials: connectionCredentials?.gitCredentials,
                  authorizeGitHubTokenMint,
                },
              );
              pendingBinding = binding;
              return binding
                ? {
                    bindings: [binding],
                    gitTokens: { [binding.provider]: binding.token },
                    expiresAt: binding.expiresAt ? { [binding.provider]: binding.expiresAt } : {},
                  }
                : undefined;
            },
            write: async () => {
              if (!pendingBinding) {
                throw new Error("credential renewal produced no binding token");
              }
              const runAs = sandboxRunAs(runSettings);
              await refreshGitCredentialBindingTokenFiles(tokenSession, [pendingBinding], {
                ...(runAs ? { runAs } : {}),
                ...(toolCancellationFenceRef.current
                  ? {
                      commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                        toolCancellationFenceRef.current,
                      ),
                    }
                  : {}),
              });
            },
            onSuccess: ({ providers: renewedProviders }) => {
              for (const provider of renewedProviders) {
                observability.incrementCounter({
                  name: "opengeni_git_credential_renewals_total",
                  help: "Host-managed Git credential renewal attempts by provider and outcome.",
                  labels: { provider, outcome: "completed" },
                });
              }
            },
            onFailure: ({ providers: failedProviders, retryDelayMs, errorClass }) => {
              for (const provider of failedProviders) {
                observability.incrementCounter({
                  name: "opengeni_git_credential_renewals_total",
                  help: "Host-managed Git credential renewal attempts by provider and outcome.",
                  labels: { provider, outcome: "error" },
                });
              }
              observability.warn("Sandbox Git credential renewal failed; retry scheduled", {
                sessionId: input.sessionId,
                turnId,
                providers: failedProviders.join(","),
                errorClass,
                retryDelayMs,
              });
            },
          });
        });
        if (gitCredentialRenewalClosed) {
          await Promise.all(controllers.map(async (controller) => await controller.stop()));
          return;
        }
        gitCredentialRenewals = controllers;
      };

      const attachToolspaceTokenRenewal = async (
        tokenSession: ToolspaceTokenWriterSession,
        initialExpiresAt = sandboxToolspaceTokenExpiresAt,
      ): Promise<void> => {
        if (!sandboxToolspaceToken || !initialExpiresAt) return;
        const previous = toolspaceTokenRenewal;
        toolspaceTokenRenewal = null;
        await previous?.stop();
        if (toolspaceTokenRenewalClosed) return;

        const mint = async () =>
          await mintSandboxToolspaceToken(runSettings, connectionScope, input.sessionId, turn.id);
        const write = async (material: NonNullable<Awaited<ReturnType<typeof mint>>>) => {
          const runAs = sandboxRunAs(runSettings);
          await refreshToolspaceTokenFile(tokenSession, material.token, {
            ...(runAs ? { runAs } : {}),
            ...(sandboxToolspaceTokenFile
              ? {
                  tokenFile: sandboxToolspaceTokenFile,
                  legacyTokenFile: sandboxEnvironment.OPENGENI_TOOLSPACE_TOKEN_FILE!,
                }
              : {}),
            ...(toolCancellationFenceRef.current
              ? {
                  commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                    toolCancellationFenceRef.current,
                  ),
                }
              : {}),
          });
        };
        let renewalExpiresAt = initialExpiresAt;
        if (renewalExpiresAt.getTime() <= Date.now() + TOOLSPACE_TOKEN_EXPIRY_LEAD_MS) {
          const fresh = await mint();
          if (!fresh) {
            throw new Error("Toolspace token mint became unavailable during sandbox setup");
          }
          await write(fresh);
          renewalExpiresAt = fresh.expiresAt;
        }
        const controller = startToolspaceTokenRenewalLoop({
          initialExpiresAt: renewalExpiresAt,
          mint,
          write,
          onSuccess: () => {
            observability.incrementCounter({
              name: "opengeni_toolspace_token_renewals_total",
              help: "Sandbox Toolspace token renewal attempts by outcome.",
              labels: { outcome: "completed" },
            });
          },
          onFailure: ({ retryDelayMs, errorClass }) => {
            observability.incrementCounter({
              name: "opengeni_toolspace_token_renewals_total",
              help: "Sandbox Toolspace token renewal attempts by outcome.",
              labels: { outcome: "error" },
            });
            observability.warn("Sandbox Toolspace token renewal failed; retry scheduled", {
              sessionId: input.sessionId,
              turnId,
              errorClass,
              retryDelayMs,
            });
          },
        });
        if (toolspaceTokenRenewalClosed) {
          await controller.stop();
          return;
        }
        toolspaceTokenRenewal = controller;
      };

      const attachRunCredentialRenewal = async (
        credentialSession: RunCredentialCommandSession,
      ): Promise<void> => {
        if (!runCredentialResolver) return;
        const previous = runCredentialRenewal;
        runCredentialRenewal = null;
        await previous?.stop();
        if (runCredentialRenewalClosed) return;
        runCredentialSession = credentialSession;

        if (!initialRunCredentialMaterial) {
          await clearRunCredentials(
            credentialSession,
            input.sessionId,
            toolCancellationFenceRef.current
              ? toolCancellationFenceRef.current.runSandboxCommand.bind(
                  toolCancellationFenceRef.current,
                )
              : undefined,
          );
          return;
        }

        const write = async (
          material: NormalizedRunCredentialMaterial | null,
          pruneOtherAttempts = false,
        ): Promise<void> => {
          if (!material) {
            await clearRunCredentialsForAttempt(credentialSession, {
              sessionId: input.sessionId,
              attemptId: input.attemptId,
              executionGeneration,
            });
            return;
          }
          registerSecretRedactions(material.redactions);
          await materializeRunCredentials(credentialSession, material, {
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            executionGeneration,
            ...(pruneOtherAttempts ? { pruneOtherAttempts: true } : {}),
            ...(!pruneOtherAttempts ? { pruneSupersededGenerations: true } : {}),
            ...(material.authNeeded.length > 0 &&
            Object.keys(material.environment).length === 0 &&
            material.files.length === 0
              ? { prunePreviousGenerations: true }
              : {}),
            ...(toolCancellationFenceRef.current
              ? {
                  commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                    toolCancellationFenceRef.current,
                  ),
                }
              : {}),
          });
          for (const payload of runCredentialAuthNeededPayloads(material)) {
            const key = JSON.stringify(payload);
            if (publishedRunCredentialNotices.has(key)) continue;
            publishedRunCredentialNotices.add(key);
            await publish!([{ type: "credential.auth_needed", payload }], true);
          }
        };

        const initialExpiryMs = initialRunCredentialMaterial.expiresAt?.getTime() ?? null;
        const seed =
          initialExpiryMs !== null && initialExpiryMs <= Date.now() + RUN_CREDENTIAL_EXPIRY_LEAD_MS
            ? await runCredentialResolver.resolve({
                purpose: "provision",
                forceRefresh: true,
              })
            : initialRunCredentialMaterial;
        await write(seed, true);
        if (runCredentialRenewalClosed) return;
        const controller = startRunCredentialRenewalLoop({
          initialExpiresAt: seed?.expiresAt ?? null,
          resolve: async () =>
            await runCredentialResolver.resolve({
              purpose: "renewal",
              forceRefresh: true,
            }),
          write: async (material) => await write(material),
          onSuccess: ({ authNeeded }) => {
            observability.incrementCounter({
              name: "opengeni_run_credential_renewals_total",
              help: "Host-managed run credential renewal attempts by outcome.",
              labels: { outcome: authNeeded ? "auth_needed" : "completed" },
            });
          },
          onFailure: ({ retryDelayMs, errorClass }) => {
            observability.incrementCounter({
              name: "opengeni_run_credential_renewals_total",
              help: "Host-managed run credential renewal attempts by outcome.",
              labels: { outcome: "error" },
            });
            observability.warn("Host run credential renewal failed; retry scheduled", {
              sessionId: input.sessionId,
              turnId,
              errorClass,
              retryDelayMs,
            });
          },
        });
        if (runCredentialRenewalClosed) {
          await controller.stop();
          return;
        }
        runCredentialRenewal = controller;
      };

      // P1.2 ownership inversion (gated, default OFF). With the flag off this
      // block is skipped entirely: resolvedSandbox stays null and runStream
      // takes the legacy per-run build-and-discard path — byte-for-byte today.
      // With it on, acquire the group lease (holder = the durable attempt id),
      // resume the one box by id, and inject it NON-OWNED into the run. The box
      // backend is "none" -> never resolve (no box to touch).
      //
      // Established AFTER sandboxEnvironment is computed (not before) so the box's
      // manifest is created with the SAME variableSet the agent declares — the SDK
      // applies the agent's manifest to this provided session and throws on ANY
      // variableSet delta (validateNoEnvironmentDelta). Passing sandboxEnvironment
      // here makes current==target so the delta is empty.
      if (settings.sandboxOwnershipEnabled && turn.sandboxBackend !== "none") {
        sandboxHolderId = sandboxLeaseHolderIdForAttempt(input.attemptId);
        sandboxGroupId = session.sandboxGroupId;
        // STAGE D honest-label guard: a machine-home session carries
        // turn.sandboxBackend "selfhosted", but a turn is only machine-PRIMARY
        // when a live machine pointer resolves (activeSandboxBackend==='selfhosted'
        // + enrollmentId). When it is NOT primary — the agent swapped back to the
        // group box (sandbox_swap 'session'/'default'/groupId clears the pointer) or
        // selfhosted routing is flag-OFF (the pointer is ignored) — the else-branch
        // must resume a REAL cloud group box, not a "selfhosted" one: the registry
        // SelfhostedSandboxClient has no bound agentId and throws. Fall the group-box
        // backend back to the deployment default cloud backend so swap-away / flag-off
        // degrade to a genuine cloud box exactly like today (home=modal did).
        if (machinePrimary) {
          // STAGE D D1-lite: the active sandbox is a connected machine, so DO NOT
          // establish or lease a phantom Modal home box (today's path leased + BILLED
          // a cloud box the turn never touched). Build the SelfhostedSession DIRECTLY
          // (no Modal box created) and take the group lease with backend "selfhosted"
          // (refcount/idle bookkeeping; the reaper drains it cold with NO provider
          // stop, and bills ZERO warm-seconds). The session is a harmless in-memory
          // bind (no NATS round-trip), so build it FIRST; if the lease then fences,
          // there is nothing to clean up.
          // Whether the machine's latest Hello advertised the op-stream engine
          // (refreshed on every connect). Read only when the server flag is on —
          // one indexed lookup, and the flag off keeps this path byte-identical.
          const machineOpStream =
            settings.agentOpStreamEnabled === true
              ? (await getEnrollment(db, input.workspaceId, activeSandboxRecord!.enrollmentId!))
                  ?.opStream === true
              : false;
          const established = await establishSelfhostedTurnSession(
            {
              db,
              settings,
              bus,
              onOp: machineOpObserver.observer,
              opJournal,
            },
            {
              workspaceId: input.workspaceId,
              agentId: activeSandboxRecord!.enrollmentId!,
              opStream: machineOpStream,
              epoch: activeSandboxPointer!.activeEpoch,
              environment: sandboxEnvironment,
              workingDir: activeSandboxPointer!.workingDir,
            },
          );
          // The machine-primary establish narrows `session` to SelfhostedSession
          // (buildSelfhostedBackendSession); EstablishedSandboxSession widens it.
          machinePrimarySession =
            established.session as import("@opengeni/runtime").SelfhostedSession;
          const lease = await waitForTurnOperation(
            acquireSelfhostedLeaseForTurn(
              { db, settings },
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sandboxGroupId: session.sandboxGroupId,
                sessionId: input.sessionId,
              },
              "turn",
              sandboxHolderId,
            ),
            cancellationSignal,
            async (lateLease) => await lateLease.release(),
          );
          setupBoxSession = established.session;
          resolvedSandbox = {
            // Wrap in the SAME routing proxy so a mid-turn swap (to another machine
            // or back to the group box) still re-routes per op. PIN this established
            // SelfhostedSession for the machine pointer so the turn-start manifest
            // write (via the proxy's `state` getter) and the per-op reads hit ONE
            // instance — no two-instance manifest divergence.
            established: wrapTurnBoxWithRouting(
              {
                db,
                settings,
                bus,
                onOp: machineOpObserver.observer,
              },
              {
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                environment: sandboxEnvironment,
                pinnedSelfhosted: {
                  sandboxId: activeSandboxPointer!.activeSandboxId!,
                  epoch: activeSandboxPointer!.activeEpoch,
                },
                // HOME semantics for a mid-turn clear-to-null: only a genuine
                // machine-HOME session (its home IS this machine, session.sandboxBackend
                // === "selfhosted") resolves null back to the pinned machine. A Modal-HOME
                // session merely PINNED to a machine this turn never established its group
                // box, so defaultIsHome:false makes a clear-to-null fail typed
                // (`home_unavailable_this_turn`) rather than silently serving the machine;
                // the detach takes effect next turn. (Lazy home-box establishment on such a
                // clear is a deferred follow-up; issue #341.)
                defaultIsHome: session.sandboxBackend === "selfhosted",
              },
              established,
            ),
            leaseEpoch: lease.leaseEpoch,
            release: lease.release,
          };
        } else if (establishPolicy === "on-demand") {
          // Lazy sandbox provisioning: holder/group ids are fixed at turn start,
          // but the lease acquire + box establish + setup move behind the routing
          // proxy's first default-pointer op. A chat-only turn never calls it, so
          // no lease row, no provider box, no warm-meter interval.
        } else {
          resolvedSandbox = await waitForTurnOperation(
            resumeBoxForTurn(
              {
                db,
                settings,
                sandboxMetrics: runtimeMetricsHooksForObservability(observability),
                onSandboxLost: publishSandboxLost,
              },
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sandboxGroupId: session.sandboxGroupId,
                sessionId: input.sessionId,
                // groupBoxBackend, not turn.sandboxBackend: a machine-home turn that
                // is not machine-primary resumes a real cloud group box (the
                // deployment default), never a "selfhosted" box (which would throw
                // for lack of a bound agentId).
                backend: groupBoxBackend,
                os: session.sandboxOs,
                environment: sandboxEnvironment,
                // IMAGE IS SHARED STATE (B3, Modal warm-box path only): the container image
                // this run resolves. The lease stamps it + conflicts on a live shared box
                // running a DIFFERENT image (solo → recreate on the new image; N-holders →
                // SandboxImageConflictError surfaced as an actionable turn error). Prefer the
                // explicit Modal image ref, else the docker image. The selfhosted branch
                // (establishSelfhostedTurnSession/acquireSelfhostedLeaseForTurn) NEVER passes
                // an image — B3 lives only on this Modal else-branch.
                ...((runSettings.modalImageRef ?? runSettings.dockerImage)
                  ? {
                      image: runSettings.modalImageRef ?? runSettings.dockerImage,
                    }
                  : {}),
                // RIG IS SHARED STATE (M3): stamp the frozen rig version so the lease
                // conflicts on a live shared box set up under a different rig (solo
                // recreate / N-holders SandboxRigConflictError). Omitted for a rig-less
                // turn -> never stamped or enforced (shares exactly as today).
                ...(rigVersion ? { rigVersionId: rigVersion.id } : {}),
              },
              "turn",
              sandboxHolderId,
            ),
            cancellationSignal,
            async (lateSandbox) => await lateSandbox.release(),
          );
          setupBoxSession = resolvedSandbox.established.session;
          // Durable box-lifecycle events (sandbox-file-persistence observability):
          // record every box transition in session_events so the NEXT box loss is
          // attributable from the DB alone — worker logs rotate within hours, which
          // left both 2026-07-06 incidents without a durable trace. Best-effort.
          await publishSandboxLifecycleEvents(resolvedSandbox);
          // M7 hot-swap: when the selfhosted feature is on, wrap the established
          // group box in the STABLE routing proxy before it is injected NON-OWNED
          // into the run. The SDK binds to this ONE object once and calls its
          // methods per tool call; the proxy re-reads (active_sandbox_id,
          // active_epoch) per op and dispatches to the currently-active backend, so
          // a sandbox_swap mid-turn lands the NEXT tool call on the new box. With
          // the flag off the established group box is injected unchanged (today's
          // path). The lease still owns the group box lifecycle — the proxy is a
          // routing veneer, not an owner.
          if (routingEnabled(settings)) {
            resolvedSandbox = {
              ...resolvedSandbox,
              established: wrapTurnBoxWithRouting(
                { db, settings, bus },
                // Thread the SAME declared environment the group box was created with
                // (resumeBoxForTurn, above) so a selfhosted swap target's manifest
                // carries it too — the SDK's per-turn manifest-env delta stays empty
                // (no "cannot change manifest environment variables" throw).
                {
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  environment: sandboxEnvironment,
                },
                resolvedSandbox.established,
              ),
            };
          }
        }
        if (resolvedSandbox) {
          startLeaseHeartbeat(resolvedSandbox, activeSandboxBackend ?? groupBoxBackend);
        }
      }

      const fileResourceDownloads = await waitForTurnOperation(
        sandboxFileDownloadsForRun(
          runSettings,
          db,
          objectStorage,
          input.workspaceId,
          turnResources,
        ),
        cancellationSignal,
        undefined,
      );
      throwIfWorkerShuttingDown();
      throwIfTurnCancelled();
      const mcpCredentialRootSessionId =
        connectionCredentials?.mcpCredentials && hostCredentialRootSessionId
          ? hostCredentialRootSessionId
          : input.sessionId;
      // Wrap MCP prep in the codex ALS so the codex_apps connect handshake
      // (initialize + tools/list) can resolve the per-workspace bearer from
      // codexRequestStorage (runtime/codexAppsMcpRequestInit). withCodex is the
      // identity on every non-codex turn, so this is a no-op for existing paths.
      const resolveCredential = connectionTokenResolverForTurn({
        db,
        settings: runSettings,
        connectionCredentials: connectionCredentials ?? null,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        rootSessionId: mcpCredentialRootSessionId,
        attemptId: input.attemptId,
        turn,
      });
      preparedTools = await waitForTurnOperation(
        withCodex(() =>
          runtime.prepareTools(runSettings, turnTools, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            // Sign the calling turn into the first-party token so tools classify
            // the caller by its own identity (sacred-pause guard), not the racy
            // live active pointer.
            ...(turnId ? { turnId } : {}),
            attemptId: input.attemptId,
            executionGeneration,
            subjectId: "worker:first-party-mcp",
            subjectLabel: "OpenGeni worker",
            resolveCredential,
            onAuthNeeded: async (payload) => {
              await publish!([{ type: "tool.auth_needed", payload }], true);
            },
            // Manager-style sessions carry a creation-validated permission set
            // for their first-party MCP token; null keeps the fixed default.
            ...(session.firstPartyMcpPermissions?.length
              ? { firstPartyPermissions: session.firstPartyMcpPermissions }
              : {}),
          }),
        ),
        cancellationSignal,
        async (latePreparedTools) => await latePreparedTools.close().catch(() => undefined),
      );
      // Genesis turn = the first user turn (no assistant history reconciled
      // yet). Durable Postgres state (countSessionHistoryItems includes
      // superseded rows after compaction), NOT a workflow counter (turnsThisRun
      // resets on continueAsNew). Drives the one-shot title hint appended to the
      // agent's instructions; later attempts and goal continuations never match.
      const isGenesisTurn =
        triggerType === "user.message" &&
        (await countSessionHistoryItems(db, input.workspaceId, input.sessionId)) === 0;
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
      const agent = runtime.buildAgent(modelRunSettings, turnResources, {
        reasoningEffort: turn.reasoningEffort,
        ...(humanInputResume ? { humanInputResponse: humanInputResume } : {}),
        genesisTitleHint: isGenesisTurn,
        persistentSessionSettings: {
          titleIsSet: Boolean(session.title?.trim()),
        },
        sandboxEnvironment,
        ...(cancellationSignal ? { turnCancellationSignal: cancellationSignal } : {}),
        onToolCancellationFence: (fence) => {
          toolCancellationFenceRef.current = fence;
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
        // Toolspace is delivered on EVERY backend including selfhosted. The git-
        // token skip does NOT transfer: that token is inert on a connected
        // machine (it uses its own git creds), but the toolspace token is the
        // machine's ONLY path to programmatic tool calling and grants no more
        // than toolspace:call for its own session (own-session-bound, turn TTL,
        // budgeted, approval-tools excluded). The runtime seeds it to the box's
        // token file over the same exec channel, off-manifest, on every backend.
        ...(sandboxToolspaceToken
          ? {
              toolspaceTokenSeed: sandboxToolspaceToken,
              toolspaceTokenSessionId: input.sessionId,
            }
          : {}),
        ...(activeSandboxBackend ? { activeSandboxBackend } : {}),
        fileResourceDownloads,
        mcpServers: preparedTools.mcpServers,
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
        // only when the model opts in; the effective context window drives the
        // compaction threshold.
        ...(resolvedModel
          ? {
              hostedWebSearch: resolvedModel.configured.hostedWebSearch,
              encryptedReasoning:
                resolvedModel.provider.api === "responses" &&
                runSettings.openaiReasoningEncryptedContent,
              contextWindowTokens:
                resolvedModel.configured.contextWindowTokens ?? runSettings.contextWindowTokens,
              // The ChatGPT/Codex backend rejects the SDK's HOSTED sandbox tools —
              // the `apply_patch` tool type ("Unsupported tool type: apply_patch")
              // and structured tool output — which the OpenAIResponsesModel the SDK
              // binds would otherwise select. Tell buildAgent to emit the function
              // `apply_patch` + text `view_image` variants the backend accepts. Only
              // the codex-subscription provider needs this; every other backend
              // (built-in OpenAI/Azure = real hosted support; registry "chat"
              // providers = the SDK's own ChatCompletions detection) keeps the SDK
              // default.
              structuredToolTransport: resolvedModel.provider.kind !== "codex-subscription",
              // EXPLICIT computer-use tool transport, derived from the resolved provider's
              // authoritative wire identity (codex → function-image, chat → function-text,
              // responses → hosted) so the runtime never string-sniffs the model instance's
              // constructor name. See {@link computerToolModeForTurn}.
              computerToolMode: computerToolModeForTurn(resolvedModel),
              ...(promptCacheKey ? { promptCacheKey } : {}),
            }
          : // LEGACY global-client fallback (resolveTurnModel returned null → the model
            // is not in the registry, served by the built-in OpenAI/Azure Responses
            // client). That backend has real hosted support, so pin computerToolMode to
            // "hosted" EXPLICITLY rather than leaving the runtime to sniff the instance.
            {
              computerToolMode: computerToolModeForTurn(null),
              promptCacheKey: input.sessionId,
            }),
        // Lazy computer-use seam: runtime first brings up :0 only after the model
        // selects a computer tool, then this hook begins the optional proof
        // recording. Shell/filesystem turns never invoke either operation.
        onComputerUseReady: async () => {
          if (!resolvedSandbox) {
            throw new Error("Computer-use display became ready without a resolved sandbox");
          }
          // This callback is the authoritative execution boundary. Record the
          // action before async ffmpeg startup so transport-event ordering cannot
          // make settlement misclassify a real computer turn as unused.
          didComputerUse = true;
          await maybeStartOnTurnRecording(resolvedSandbox, activeSandboxBackend);
        },
        ...(packRuntime.skills.length > 0 ? { packSkills: packRuntime.skills } : {}),
        ...(workspaceAgentInstructions ? { instructionsTemplate: workspaceAgentInstructions } : {}),
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
                    },
                  }
                : {}),
              ...(rigVersion.credentialHooks.length > 0
                ? { rigCredentialHookIds: rigVersion.credentialHooks }
                : {}),
            }
          : {}),
      });
      if (modelRunSettings.sandboxBackend !== "none" && toolCancellationFenceRef.current === null) {
        throw new Error(
          "Sandbox agent construction did not install the mandatory turn tool cancellation fence",
        );
      }
      if (establishPolicy === "on-demand" && sandboxHolderId && sandboxGroupId) {
        const lazyHolderId = sandboxHolderId;
        const lazyGroupId = sandboxGroupId;
        const agentDefaultManifest = (agent as { defaultManifest?: unknown }).defaultManifest;
        if (!agentDefaultManifest) {
          throw new Error("Lazy sandbox provisioning requires a SandboxAgent defaultManifest");
        }
        const lazyClient = {
          backendId: sdkBackendIdForSandboxBackend(groupBoxBackend),
        } as EstablishedSandboxSession["client"];
        turnSandboxProvisioner = createTurnSandboxProvisioner<ResumedTurnSandbox>(
          async () => {
            throwIfWorkerShuttingDown();
            throwIfTurnCancelled();
            const lazyGitCredentials =
              activeSandboxBackend === "selfhosted"
                ? undefined
                : await mintRunGitCredentials(runSettings, turnResources, {
                    scope: connectionScope,
                    ...(gitCredentialAuthority ? { authority: gitCredentialAuthority } : {}),
                    gitCredentials: connectionCredentials?.gitCredentials,
                    authorizeGitHubTokenMint,
                  });
            const lazyGitTokens = lazyGitCredentials?.gitTokens;
            const lazyToolspaceToken = sandboxToolspaceToken
              ? await mintSandboxToolspaceToken(
                  runSettings,
                  connectionScope,
                  input.sessionId,
                  turn.id,
                )
              : undefined;
            const provisioned = await resumeBoxForTurn(
              {
                db,
                settings,
                sandboxMetrics: runtimeMetricsHooksForObservability(observability),
                onSandboxLost: publishSandboxLost,
              },
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sandboxGroupId: lazyGroupId,
                sessionId: input.sessionId,
                backend: groupBoxBackend,
                os: session.sandboxOs,
                environment: sandboxEnvironment,
                ...((runSettings.modalImageRef ?? runSettings.dockerImage)
                  ? {
                      image: runSettings.modalImageRef ?? runSettings.dockerImage,
                    }
                  : {}),
              },
              "turn",
              lazyHolderId,
            );
            await publishSandboxLifecycleEvents(provisioned);
            await attachRunCredentialRenewal(
              provisioned.established.session as RunCredentialCommandSession,
            );
            const provisionedSetupSession = initialRunCredentialMaterial
              ? withRunCredentialsSession(
                  provisioned.established.session as object,
                  input.sessionId,
                )
              : provisioned.established.session;
            await runOwnedSandboxSetup(
              agent,
              provisioned.established.session as never,
              provisionedSetupSession as never,
              {
                settings: runSettings,
                environment: sandboxEnvironment,
                onRuntimeEvent: async (event) => {
                  await publish?.([{ type: event.type, payload: event.payload }], true);
                },
                ...(lazyGitTokens ? { gitTokenSeedsOverride: lazyGitTokens } : {}),
                ...(lazyGitCredentials?.bindings
                  ? { gitCredentialBindingsOverride: lazyGitCredentials.bindings }
                  : {}),
                ...(lazyToolspaceToken
                  ? { toolspaceTokenSeedOverride: lazyToolspaceToken.token }
                  : {}),
                ...(toolCancellationFenceRef.current
                  ? {
                      commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                        toolCancellationFenceRef.current,
                      ),
                    }
                  : {}),
              },
            );
            await attachToolspaceTokenRenewal(
              provisioned.established.session as ToolspaceTokenWriterSession,
              lazyToolspaceToken?.expiresAt,
            );
            await attachGitCredentialRenewal(
              provisioned.established.session as GitCredentialTokenWriterSession,
              lazyGitCredentials,
            );
            // Return the REAL established box (NOT a copy whose session is the routing
            // proxy). resolveActiveBackend dispatches ops to `provisioned.established.session`;
            // if that were the proxy itself, proxy.exec -> dispatch -> resolve ->
            // provisioner.get() -> proxy.exec -> ... loops forever (an async infinite
            // recursion that HANGS the turn — caught live on staging 2026-07-08). The SDK
            // already holds the proxy directly (injected as lazyOwnedSandbox.session), so it
            // gets per-op routing; the worker-side handle (resolvedSandbox: release,
            // heartbeat, computer-use recording) wants the real box, unproxied.
            return provisioned;
          },
          {
            ...(activityContext ? { signal: activityContext.cancellationSignal } : {}),
            onStarted: async () => {
              await publish?.(
                [
                  {
                    type: "sandbox.operation.started",
                    payload: { name: "sandbox.provision" },
                  },
                ],
                true,
              );
            },
            onCompleted: async (provisioned) => {
              await publish?.(
                [
                  {
                    type: "sandbox.operation.completed",
                    payload: {
                      name: "sandbox.provision",
                      ...(provisioned.established.origin
                        ? { origin: provisioned.established.origin }
                        : {}),
                    },
                  },
                ],
                true,
              );
              throwIfTurnOperationCancelled(activityContext?.cancellationSignal);
              startLeaseHeartbeat(provisioned, activeSandboxBackend ?? groupBoxBackend);
              setupBoxSession = provisioned.established.session;
              resolvedSandbox = provisioned;
            },
            onFailed: async (error) => {
              await publish?.(
                [
                  {
                    type: "sandbox.operation.failed",
                    payload: {
                      name: "sandbox.provision",
                      error: error instanceof Error ? error.message : String(error),
                    },
                  },
                ],
                true,
              );
            },
            disposeResult: async (provisioned) => {
              await provisioned.release().catch(() => undefined);
            },
          },
        );
        lazyOwnedSandbox = wrapLazyTurnBoxWithRouting(
          {
            db,
            settings,
            bus,
            onOp: machineOpObserver.observer,
          },
          {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            environment: sandboxEnvironment,
          },
          {
            client: lazyClient,
            backendId: sdkBackendIdForSandboxBackend(groupBoxBackend),
            agentDefaultManifest,
            provisioner: turnSandboxProvisioner,
          },
        );
      }
      const compactSummarizer = compactionSummarizerFor(
        typeof agent.instructions === "string" ? agent.instructions : undefined,
      );
      // Pre-turn durable context compaction. When the single Codex-parity
      // threshold is crossed, this summarizes active history and rebuilds active
      // history as [user messages..., summary] BEFORE the model input is read.
      // Summarizer context overflows drop one oldest summarizer-input item and
      // retry, exactly like Codex. Other failures end this turn honestly.
      // Run before every fresh inference. Approval resumes replay their frozen
      // RunState verbatim and recovering attempts already compacted, if needed,
      // before the first attempt's model boundary.
      if (triggerType === "user.message" || triggerType === "system.update.delivered") {
        let forced = false;
        try {
          // Operator /compact (the slash command) sets a durable request flag;
          // observe it without consuming it so a failed/stale attempt cannot
          // lose the request. The replacement transaction clears it on success.
          forced = await isSessionCompactionRequested(db, input.workspaceId, input.sessionId);
          const outcome = await waitForTurnOperation(
            maybeCompactContext(
              db,
              modelRunSettings,
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: turnId!,
                executionGeneration,
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
                  }
                : { trigger: "auto" },
            ),
            cancellationSignal,
            undefined,
          );
          if (outcome.compacted) {
            const compactionTrigger = forced ? "operator" : undefined;
            recordContextCompaction(observability, compactionTrigger ?? "auto");
            await publishDurableSessionEvents(
              bus,
              input.workspaceId,
              input.sessionId,
              outcome.events,
            );
          }
        } catch (compactError) {
          if (shouldRecoverCompactionProviderFailure(compactError)) throw compactError;
          if (!isCompactionSummaryFailure(compactError)) throw compactError;
          const errorMessage = compactionFailureReasonFromError(compactError);
          observability.error("context compaction failed", {
            sessionId: input.sessionId,
            turnId,
            error: errorMessage,
          });
          if (
            !(await settle!({
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
              ...(forced ? { consumeRequestedCompactionFailure: true } : {}),
            }))
          ) {
            return claimedResult({ status: "cancelled" });
          }
          turnMetricOutcome = "failed";
          activityStatus = "idle";
          activityError = compactError;
          return claimedResult({ status: "idle" });
        }
      }
      let fileMaterializationFailures: SandboxFileDownloadFailure[] = [];
      let fileDownloadsMaterializedForRun = false;
      if (
        resolvedSandbox &&
        setupBoxSession &&
        activeSandboxBackend !== "selfhosted" &&
        fileResourceDownloads.length > 0
      ) {
        const boxInstanceId = resolvedSandbox.established.instanceId;
        const alreadyMaterialized = await getMaterializedSandboxFileResources(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: session.sandboxGroupId,
          expectedEpoch: resolvedSandbox.leaseEpoch,
          instanceId: boxInstanceId,
        });
        const downloadsToMaterialize = filterUnmaterializedSandboxFileDownloads(
          fileResourceDownloads,
          alreadyMaterialized,
        );
        const runAs = sandboxRunAs(runSettings);
        if (downloadsToMaterialize.length > 0) {
          const materialized = await materializeSandboxFileDownloads(
            setupBoxSession as any,
            downloadsToMaterialize,
            {
              onRuntimeEvent: async (event) => {
                await publish!([{ type: event.type, payload: event.payload }], true);
              },
              ...(runAs ? { runAs } : {}),
              ...(toolCancellationFenceRef.current
                ? {
                    commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                      toolCancellationFenceRef.current,
                    ),
                  }
                : {}),
            },
          );
          fileMaterializationFailures = materialized.failures;
          const failedFileIds = new Set(materialized.failures.map((failure) => failure.fileId));
          const succeededFileIds = downloadsToMaterialize
            .map((download) => download.fileId)
            .filter((fileId) => !failedFileIds.has(fileId));
          if (succeededFileIds.length > 0) {
            await markSandboxFileResourcesMaterialized(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sandboxGroupId: session.sandboxGroupId,
              expectedEpoch: resolvedSandbox.leaseEpoch,
              instanceId: boxInstanceId,
              fileIds: succeededFileIds,
            });
          }
        }
        fileDownloadsMaterializedForRun = true;
      }
      const unavailableSandboxFilesNote = sandboxFileDownloadFailureNote(
        fileMaterializationFailures,
      );
      // Cross-account reasoning strip: pass THIS turn's codex account so every
      // history read path (items + run-state replay) drops reasoning produced by
      // a DIFFERENT codex account. effectiveCodexCredentialId is the resolved
      // codex credential on a codex turn (pin > workspace-active) and null on a
      // non-codex turn OR a codex turn with no usable account — exactly the
      // "current account" the single strip rule compares against (null is the
      // built-in/Azure account, so a non-codex turn still drops codex-produced
      // reasoning, and a no-codex-history session is a byte-for-byte no-op).
      const activeTurnId = turnId;
      if (!activeTurnId) {
        throw new Error("Turn id was not initialized");
      }
      let runInput: Awaited<ReturnType<typeof turnInput>>["input"] | null = null;
      const prepareRunAttemptInput = async () => {
        const prepared = await turnInput(
          db,
          runtime,
          agent,
          trigger,
          { currentCodexCredentialId: effectiveCodexCredentialId },
          {
            turnId: activeTurnId,
            recovering: turn.executionGeneration > 1,
            ...(unavailableSandboxFilesNote ? { unavailableSandboxFilesNote } : {}),
            ...(runCredentialsNote ? { runCredentialsNote } : {}),
          },
        );
        runInput = prepared.input;
        // Slice index = the length of the model-facing (active) history this turn
        // is seeded from; new items beyond it (the trigger message + this turn's
        // generated items) are the ones to persist. After a compaction this is the
        // short [summary, ...tail] active set, NOT the total row count. The
        // absolute write position is tracked separately (next whole number past
        // the max existing position) because the fractional summary row means
        // total rows no longer equal max(position)+1. Pre-compaction both reduce to
        // the old total-count value, so the common path is unchanged.
        //
        // CRITICAL: seed from the SANITIZED active-row length, not the raw active
        // count. `prepareRunInput` builds `state.history` from
        // `sanitizeHistoryItemsForModel(activeRows)`, so when sanitization drops K
        // rows (a legacy orphan/dangling pair), the in-memory history this turn
        // starts from is K shorter than the raw row count. The reconcile slices the
        // re-sanitized `state.history` off `persistedHistoryCount`; seeding it from
        // the raw count (K too high) skips K genuinely-new items, and a
        // `function_call` left in that skipped region can later have its
        // `function_call_result` persisted alone — the orphan that 400s on replay
        // and bricks the session (issue-61). The sanitized seed is already
        // orphan-free, so it is a stable prefix of the re-sanitized history and the
        // slice begins exactly at the first genuinely-new item.
        const activeSeedRows = await getActiveSessionHistoryItems(
          db,
          input.workspaceId,
          input.sessionId,
        );
        // Seed the reconcile watermark from EXACTLY the view the model's
        // `state.history` was seeded from (items strip on the items path = HOLE D; NO
        // strip on the run-state blob path, where foreign reasoning is neutralized but
        // KEPT = HOLE E), so the model-input length and the watermark never disagree.
        persistedHistoryCount = reconcileSeedCount(activeSeedRows, prepared.modelHistoryFromItems, {
          currentCodexCredentialId: effectiveCodexCredentialId,
        });
        nextHistoryPosition = await nextSessionHistoryPosition(
          db,
          input.workspaceId,
          input.sessionId,
        );
      };

      const forceContextCompaction = async (
        triggerLabel: "overflow" | "proactive" | "operator",
        recoverySignalTokens: number | null,
      ) => {
        const outcome = await waitForTurnOperation(
          maybeCompactContext(
            db,
            modelRunSettings,
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: activeTurnId,
              executionGeneration,
              attemptId: input.attemptId,
            },
            // Never reuse the persisted prior-turn signal for recovery. Proactive
            // guards provide their exact current signal; provider overflows do not,
            // so null derives decision metadata from active history. Forced
            // recovery proves progress separately by comparing the replacement
            // with the current active-history estimate in maybeCompactContext.
            recoverySignalTokens,
            compactSummarizer,
            {
              force: true,
              ...(triggerLabel === "operator" ? { clearRequestedCompaction: true } : {}),
              trigger: triggerLabel,
            },
          ),
          cancellationSignal,
          undefined,
        );
        if (outcome.events.length > 0) {
          if (outcome.compacted) {
            recordContextCompaction(observability, triggerLabel);
          }
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            outcome.events,
          );
        }
        return outcome;
      };

      const runStreamAttempt = async (): Promise<RunAgentTurnResult> => {
        if (!runInput) {
          throw new Error("Run input was not prepared");
        }
        stream = undefined;
        batcher = null;
        let responseUsageCount = 0;
        // The SDK emits every processed call item for one model response before
        // it emits any result for that response. Keep that response-local batch
        // in memory so an orphan from an older response cannot pin later stable
        // calls. Durable recovery remains call/result based and needs no batch
        // schema or compatibility state.
        let currentToolBatchCallIds = new Set<string>();
        let currentToolBatchCompletedCallIds = new Set<string>();
        // Actual input tokens of the most recent model response this turn; the
        // pre-read trigger for the NEXT turn. Persisted at every turn-end path.
        let lastProviderContextTokensObserved: number | null = null;
        let providerContextRevision = 0;
        throwIfWorkerShuttingDown();
        throwIfTurnCancelled();
        const ownedEstablished = resolvedSandbox?.established ?? lazyOwnedSandbox;
        const runStreamOnce = (): ReturnType<OpenGeniRuntime["runStream"]> =>
          runtime.runStream(agent, runInput!, modelRunSettings, {
            ...(activityContext ? { signal: activityContext.cancellationSignal } : {}),
            sandboxEnvironment,
            onRuntimeEvent: async (event) => {
              await renewCodexLease("runtime_event");
              if (codexLeaseLost) {
                throw new Error("Codex credential lease expired during the active turn");
              }
              await publish!([{ type: event.type, payload: event.payload }], true);
            },
            // P1.2: inject the resumed box NON-OWNED (the SDK never reaps it — the
            // keystone). Absent when the flag is off -> legacy build-and-discard.
            ...(ownedEstablished
              ? {
                  ownedSandbox: {
                    client: ownedEstablished.client,
                    session: ownedEstablished.session,
                    ...(resolvedSandbox?.established.sessionState
                      ? {
                          sessionState: resolvedSandbox.established.sessionState,
                        }
                      : {}),
                    // Pin platform setup (hooks + file materialization) to the un-proxied
                    // established box — never through the routing proxy, which would
                    // re-route those execs onto a machine swapped in mid-turn.
                    ...(setupBoxSession ? { setupSession: setupBoxSession } : {}),
                    ...(fileDownloadsMaterializedForRun ? { fileDownloadsMaterialized: true } : {}),
                    ...(lazyOwnedSandbox ? { deferredSetup: true } : {}),
                  },
                }
              : {}),
            ...(initialGitCredentials
              ? {
                  onGitCredentialSessionReady: async (
                    tokenSession: GitCredentialTokenWriterSession,
                  ) => {
                    await attachGitCredentialRenewal(tokenSession, initialGitCredentials);
                  },
                }
              : {}),
            ...(sandboxToolspaceToken && sandboxToolspaceTokenExpiresAt && !lazyOwnedSandbox
              ? {
                  onToolspaceTokenSessionReady: async (
                    tokenSession: ToolspaceTokenWriterSession,
                  ) => {
                    const renewalSession =
                      activeSandboxBackend === "selfhosted"
                        ? tokenSession
                        : ((setupBoxSession as ToolspaceTokenWriterSession | null) ?? tokenSession);
                    await attachToolspaceTokenRenewal(renewalSession);
                  },
                }
              : {}),
            ...(runCredentialResolver
              ? {
                  runCredentialSessionId: input.sessionId,
                  ...(!lazyOwnedSandbox
                    ? {
                        onRunCredentialSessionReady: async (
                          credentialSession: RunCredentialCommandSession,
                        ) => {
                          const pinnedCredentialSession = setupBoxSession
                            ? (setupBoxSession as RunCredentialCommandSession)
                            : credentialSession;
                          await attachRunCredentialRenewal(pinnedCredentialSession);
                        },
                      }
                    : {}),
                }
              : {}),
            contextCompactionSignal: () =>
              lastProviderContextTokensObserved === null
                ? null
                : {
                    revision: providerContextRevision,
                    totalTokens: lastProviderContextTokensObserved,
                  },
            contextCompactionRequested: () =>
              isSessionCompactionRequested(db, input.workspaceId, input.sessionId),
            ...(toolCancellationFenceRef.current
              ? { turnToolCancellationFence: toolCancellationFenceRef.current }
              : {}),
          });
        if (codexLeaseLost) {
          throw new Error("Codex credential lease expired before the model run");
        }
        stream = await withCodex(runStreamOnce);
        // Bounded provider label for the streaming SLIs — the resolved registry
        // provider id (or the built-in OpenAI/Azure provider), never a raw
        // user-supplied model string.
        const streamProvider = resolvedModel?.provider.id ?? settings.openaiProvider ?? "openai";
        const streamTiming = new StreamTimingMetrics(observability, {
          provider: streamProvider,
        });
        batcher = createRuntimeBatcher(
          async (events) => {
            await publish!(events);
          },
          {
            onFlush: ({ events, durationSeconds }) =>
              recordBatchFlush(observability, { events, durationSeconds }),
          },
        );

        const iterator = stream.toStream()[Symbol.asyncIterator]();
        let streamDone = false;
        try {
          while (true) {
            const next = await nextStreamEvent(iterator, activityContext);
            if (next.done) {
              streamDone = true;
              break;
            }
            let stableToolCallIdsToClear: string[] | null = null;
            let completedCurrentToolBatch = false;
            const responseUsage = modelResponseUsageFromSdkEvent(next.value);
            if (responseUsage) {
              await recordCompletedModelCallBeforeOwnershipFences({
                renewLease: () => renewCodexLease("model_usage"),
                leaseLost: () => codexLeaseLost,
                leaseLostMessage: "Codex credential lease expired during the active turn",
                recordUsage: async () => {
                  responseUsageCount += 1;
                  const responseSourceKey = modelUsageSourceKey({
                    responseId: responseUsage.responseId,
                    dispatchId: modelUsageDispatchId,
                    positionalKey: `response-${responseUsageCount}`,
                  });
                  // Within a turn the serving credential is fixed, so a switch can only
                  // surface on the turn's FIRST model call (vs the session's prior).
                  const responseAccountCtx = modelCallAccountContext({
                    servingCredentialId: effectiveCodexCredentialId,
                    priorSessionCredentialId: priorSessionCodexCredentialId,
                    isFirstCallOfTurn: responseUsageCount === 1,
                  });
                  await recordModelUsageAndDebitCredits(settings, db, {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    turnId: activeTurnId,
                    turnAttemptId: input.attemptId,
                    model: turn.model,
                    isCodexTurn,
                    usage: responseUsage.usage,
                    sourceKey: responseSourceKey,
                    observability,
                  });
                  await emitModelCallUsage({
                    observability,
                    publish,
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    turnId: activeTurnId,
                    provider: resolvedModel?.provider.id ?? settings.openaiProvider,
                    providerApi: resolvedModel?.provider.api ?? "responses",
                    model: turn.model,
                    sourceKey: responseSourceKey,
                    usage: responseUsage,
                    servingAccountHash: responseAccountCtx.servingAccountHash,
                    accountChangedFromPrevCall: responseAccountCtx.accountChangedFromPrevCall,
                    emittedSourceKeys: emittedModelUsageSourceKeys,
                  });
                  const observed = responseUsage.usage?.inputTokens;
                  if (typeof observed === "number" && observed > 0) {
                    recordModelInputTokens(observability, streamProvider, observed);
                  }
                  const observedTotal = providerContextTokens(responseUsage.usage);
                  if (observedTotal !== null) {
                    lastProviderContextTokensObserved = observedTotal;
                    providerContextRevision += 1;
                  }
                  // Prompt-cache efficiency for this response — same usage frame as the
                  // input-token accounting above, so the two are always consistent.
                  recordModelCacheTokens(observability, streamProvider, {
                    cachedTokens: modelCallUsageTelemetry(responseUsage.usage).cachedTokens,
                    promptTokens: responseUsage.usage?.inputTokens,
                  });
                },
                recordAttemptSignals: async () => {
                  const observed = responseUsage.usage?.inputTokens;
                  if (typeof observed === "number" && observed > 0) {
                    await setLastInputTokensFenced(observed);
                  }
                },
              });
              currentToolBatchCallIds = new Set<string>();
              currentToolBatchCompletedCallIds = new Set<string>();
              await reconcileConversationTruth();
              try {
                await ensureRunAllowed(
                  settings,
                  db,
                  input.accountId,
                  input.workspaceId,
                  isCodexTurn,
                  entitlements,
                );
              } catch (limitError) {
                // Capture the run state at the boundary so the budget valve in
                // the outer catch can end this segment gracefully with full
                // conversation context preserved for the post-top-up resume.
                let serializedRunState: string | null = null;
                try {
                  serializedRunState = stream.state.toString();
                } catch {
                  serializedRunState = null;
                }
                throw new BudgetExhaustedError(
                  limitError instanceof Error ? limitError.message : String(limitError),
                  serializedRunState,
                );
              }
            }
            const pendingToolCall = pendingToolCallFromSdkEvent(next.value);
            if (pendingToolCall) {
              const registered = await registerPendingSessionToolCall(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: activeTurnId,
                executionGeneration,
                attemptId: input.attemptId,
                ...pendingToolCall,
              });
              if (!registered.accepted) {
                throw new TurnAttemptFencedError(
                  "turn attempt ended while recording an in-flight tool call",
                );
              }
              currentToolBatchCallIds.add(pendingToolCall.callId);
            }
            const completedToolCall = completedToolCallFromSdkEvent(next.value);
            if (completedToolCall) {
              // Keep every parallel result in the attempt ledger until the full
              // call batch has settled. The SDK's computed history is
              // non-monotonic while parallel calls complete (a later call may
              // appear before an earlier persisted pair), so reconciling a
              // partial batch through a scalar watermark can create an orphan.
              const recorded = await recordPendingSessionToolCallResult(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: activeTurnId,
                executionGeneration,
                attemptId: input.attemptId,
                callId: completedToolCall.callId,
                resultItem: completedToolCall.resultItem,
              });
              if (!recorded.accepted) {
                throw new TurnAttemptFencedError(
                  "turn attempt ended while recording a tool-call result",
                );
              }
              const belongsToCurrentBatch = currentToolBatchCallIds.has(completedToolCall.callId);
              if (belongsToCurrentBatch) {
                currentToolBatchCompletedCallIds.add(completedToolCall.callId);
              }
              const currentBatchIsStable =
                belongsToCurrentBatch &&
                currentToolBatchCallIds.size > 0 &&
                currentToolBatchCompletedCallIds.size === currentToolBatchCallIds.size;
              const standaloneStableResult =
                !belongsToCurrentBatch && currentToolBatchCallIds.size === 0;
              if (currentBatchIsStable || standaloneStableResult) {
                // Persist the SDK's now-stable complete call/result batch. Keep
                // the receipts until the normalized tool-output event below is
                // durably flushed: recovery then covers every crash boundary
                // without either losing or duplicating the UI projection.
                await reconcileConversationTruth({ requireDurable: true });
                stableToolCallIdsToClear = currentBatchIsStable
                  ? [...currentToolBatchCallIds]
                  : [completedToolCall.callId];
                completedCurrentToolBatch = currentBatchIsStable;
              }
            }
            const normalized = normalizeSdkEvent(next.value);
            for (const event of normalized) {
              streamTiming.onEvent(event.type);
              await batcher.push(event);
            }
            if (stableToolCallIdsToClear) {
              const cleared = await clearDurablePendingSessionToolCalls(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: activeTurnId,
                executionGeneration,
                attemptId: input.attemptId,
                callIds: stableToolCallIdsToClear,
              });
              if (!cleared.accepted) {
                throw new TurnAttemptFencedError(
                  "turn attempt ended while finalizing tool-call results",
                );
              }
              if (completedCurrentToolBatch) {
                currentToolBatchCallIds = new Set<string>();
                currentToolBatchCompletedCallIds = new Set<string>();
              }
            }
          }
        } finally {
          if (!streamDone) {
            // ReadableStream cancellation synchronously trips the Agents SDK's
            // abort controller, but its returned promise may wait for an
            // uncooperative provider producer. Once this attempt is fenced,
            // awaiting that provider-side cleanup pins the Temporal activity
            // (and therefore Pause) even though every late write is already
            // rejected. Start cancellation and detach only its cleanup wait;
            // the SDK abort signal stops the producer and the durable attempt
            // fence remains the authority for every callback that arrives late.
            void iterator.return?.().catch(() => undefined);
          }
        }
        await waitForTurnStreamCleanup(
          batcher.flush(),
          stream.completed.catch(() => undefined),
          cancellationSignal,
        );
        if (responseUsageCount === 0) {
          const aggregateUsage = stream.state.usage;
          const aggregateInput = (aggregateUsage as { inputTokens?: unknown } | undefined)
            ?.inputTokens;
          if (typeof aggregateInput === "number" && aggregateInput > 0) {
            const aggregateContext = providerContextTokens(
              aggregateUsage as {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
              },
            );
            if (aggregateContext !== null) {
              lastProviderContextTokensObserved = aggregateContext;
              providerContextRevision += 1;
            }
          }
          const aggregateSourceKey = modelUsageSourceKey({
            responseId: null,
            dispatchId: modelUsageDispatchId,
            positionalKey: "aggregate",
          });
          // The single aggregate frame is this turn's only model-usage record, so
          // it is the first (account-switch surfaces here just like a first response).
          const aggregateAccountCtx = modelCallAccountContext({
            servingCredentialId: effectiveCodexCredentialId,
            priorSessionCredentialId: priorSessionCodexCredentialId,
            isFirstCallOfTurn: true,
          });
          recordModelCacheTokens(observability, streamProvider, {
            cachedTokens: modelCallUsageTelemetry(
              aggregateUsage as Parameters<typeof modelCallUsageTelemetry>[0],
            ).cachedTokens,
            promptTokens: (aggregateUsage as { inputTokens?: unknown } | undefined)?.inputTokens as
              | number
              | undefined,
          });
          await recordCompletedModelCallBeforeOwnershipFences({
            renewLease: () => renewCodexLease("model_usage"),
            leaseLost: () => codexLeaseLost,
            leaseLostMessage: "Codex credential lease expired during the active turn",
            recordUsage: async () => {
              await recordModelUsageAndDebitCredits(settings, db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: activeTurnId,
                turnAttemptId: input.attemptId,
                model: turn.model,
                isCodexTurn,
                usage: aggregateUsage,
                sourceKey: aggregateSourceKey,
                observability,
              });
              await emitModelCallUsage({
                observability,
                publish,
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: activeTurnId,
                provider: resolvedModel?.provider.id ?? settings.openaiProvider,
                providerApi: resolvedModel?.provider.api ?? "responses",
                model: turn.model,
                sourceKey: aggregateSourceKey,
                usage: { usage: aggregateUsage },
                servingAccountHash: aggregateAccountCtx.servingAccountHash,
                accountChangedFromPrevCall: aggregateAccountCtx.accountChangedFromPrevCall,
                emittedSourceKeys: emittedModelUsageSourceKeys,
              });
            },
            recordAttemptSignals: async () => {
              if (typeof aggregateInput === "number" && aggregateInput > 0) {
                await setLastInputTokensFenced(aggregateInput);
              }
            },
          });
        }
        if (stream.interruptions.length > 0) {
          await reconcileConversationTruth();
          const approvals = runtime.serializeApprovals(stream.interruptions);
          const humanInputInterruptions =
            runtime.serializeHumanInputRequests?.(stream.interruptions) ?? [];
          const humanInputRequests = await Promise.all(
            humanInputInterruptions.map(async (interruption) => {
              const id = stableHumanInputRequestId(
                input.sessionId,
                activeTurnId,
                interruption.toolCallId,
              );
              const existing = await getSessionHumanInputRequest(
                db,
                input.workspaceId,
                input.sessionId,
                id,
              );
              if (existing && existing.status !== "pending") {
                throw new Error(`Settled human-input request ${id} reappeared as an interruption`);
              }
              const expiresAt = existing?.expiresAt
                ? new Date(existing.expiresAt)
                : interruption.input.expiresInSeconds
                  ? new Date(Date.now() + interruption.input.expiresInSeconds * 1000)
                  : null;
              return {
                id,
                toolCallId: interruption.toolCallId,
                questions: interruption.input.questions,
                allowSkip: interruption.input.allowSkip,
                expiresAt,
                isNew: existing === null,
              };
            }),
          );
          const requestEvents = humanInputRequests
            .filter((request) => request.isNew)
            .map((request) => ({
              type: "session.humanInput.requested" as const,
              payload: {
                request: {
                  id: request.id,
                  questions: request.questions,
                  allowSkip: request.allowSkip,
                  expiresAt: request.expiresAt?.toISOString() ?? null,
                },
              },
            }));
          if (
            !(await settle!({
              events: [
                ...requestEvents,
                ...(approvals.length > 0
                  ? [{ type: "session.requiresAction" as const, payload: { approvals } }]
                  : []),
                {
                  type: "session.status.changed",
                  payload: { status: "requires_action" },
                },
              ],
              turnStatus: "requires_action",
              sessionStatus: "requires_action",
              activeTurnId,
              runState: {
                serializedRunState: stream.state.toString(),
                pendingApprovals: approvals,
                frozenCodexCredentialId: effectiveCodexCredentialId,
                humanInputRequests: humanInputRequests.map(
                  ({ isNew: _isNew, ...request }) => request,
                ),
              },
            }))
          ) {
            return claimedResult({ status: "cancelled" });
          }
          activityStatus = "requires_action";
          return claimedResult({ status: "requires_action" });
        }

        const finalOutput = String(stream.finalOutput ?? "");
        await reconcileConversationTruth();
        // Op-stream durability fence: the tool outputs are now durably in the
        // history store (a redispatch would NOT re-execute them), so this
        // turn's settled ops may advance their acked frontier — journal persist
        // then wire final ack (licensing the runner to GC its retained
        // frames). Best-effort: a miss leaves the runner's retention TTL to
        // reap, never fails a completed turn.
        if (machinePrimarySession) {
          try {
            await machinePrimarySession.finalizeOpStreamOps();
          } catch {
            // The runner's retention TTL owns the fallback.
          }
        }
        if (
          !(await settle!({
            events: [
              {
                type: "agent.message.completed",
                payload: { text: finalOutput },
              },
              { type: "turn.completed", payload: { output: finalOutput } },
              { type: "session.status.changed", payload: { status: "idle" } },
            ],
            turnStatus: "completed",
            sessionStatus: "idle",
            activeTurnId: null,
          }))
        ) {
          return claimedResult({ status: "cancelled" });
        }
        turnMetricOutcome = "completed";
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: activeTurnId,
          sessionId: input.sessionId,
          turnId: activeTurnId,
          turnAttemptId: input.attemptId,
          idempotencyKey: `usage:agent_run.completed:${activeTurnId}`,
        });
        activityStatus = "idle";
        return claimedResult({ status: "idle" });
      };

      await prepareRunAttemptInput();
      let retriedAfterCompaction = false;
      while (true) {
        try {
          const result = await runStreamAttempt();
          if (retriedAfterCompaction) {
            observability.info("context compaction recovery succeeded after in-activity retry", {
              sessionId: input.sessionId,
              turnId: activeTurnId,
            });
          }
          return result;
        } catch (attemptError) {
          const overflow = classifyContextWindowOverflowError(attemptError);
          const compactionNeeded = findCompactionNeededError(attemptError);
          const recoveryKind = compactionNeeded
            ? compactionNeeded.trigger === "operator"
              ? "operator"
              : "proactive"
            : overflow
              ? "overflow"
              : null;
          if (!recoveryKind || !publish || !turnStartedPublished) {
            throw attemptError;
          }
          await flushRuntimeBatcher();
          await reconcileConversationTruth({ skipInputOnlyRows: true });
          observability.warn("context compaction recovery attempted", {
            sessionId: input.sessionId,
            turnId: activeTurnId,
            reason: recoveryKind,
            code: overflow?.code,
            error: overflow?.message ?? compactionNeeded?.message,
            signalTokens: compactionNeeded?.signalTokens,
            thresholdTokens: compactionNeeded?.thresholdTokens,
          });
          let compacted = false;
          let compactionHandled = false;
          let compactionFailureMessage: string | null = null;
          try {
            const outcome = await forceContextCompaction(
              recoveryKind,
              compactionNeeded?.signalTokens ?? null,
            );
            compacted = outcome.compacted;
            if (outcome.compacted) {
              compactionHandled = true;
            } else {
              compactionHandled = recoveryKind === "operator" && outcome.requestConsumed;
              if (!compactionHandled) {
                compactionFailureMessage = compactionFailureReason(outcome.reason);
              }
            }
          } catch (compactError) {
            // Transient checkpoint-provider failures recover this same accepted
            // turn through the normal provider/capacity path. They are not an
            // empty summary and must not create a new goal continuation.
            if (shouldRecoverCompactionProviderFailure(compactError)) throw compactError;
            if (!isCompactionSummaryFailure(compactError)) throw compactError;
            compactionFailureMessage = compactionFailureReasonFromError(compactError);
            observability.warn("context compaction recovery compaction failed", {
              sessionId: input.sessionId,
              turnId: activeTurnId,
              error: compactionFailureMessage,
            });
          }
          if (!compactionHandled) {
            const errorMessage =
              compactionFailureMessage ??
              "compaction summarization failed: compaction produced no replacement history";
            if (
              !(await settle!({
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
                ...(recoveryKind === "operator" ? { consumeRequestedCompactionFailure: true } : {}),
              }))
            ) {
              return claimedResult({ status: "cancelled" });
            }
            turnMetricOutcome = "failed";
            activityStatus = "idle";
            activityError = attemptError;
            // The failed turn settlement already defers ordinary internal
            // updates and makes the delivered goal-continuation receipt
            // terminal. End this workflow run as well: returning plain idle
            // would immediately synthesize another goal continuation against
            // the unchanged active history and repeat the same failed
            // compaction. A new human/API prompt, Steer, or explicitly requested
            // Compact remains a durable explicit wake and may retry; ordinary
            // machine updates stay pending for that actionable wake.
            return claimedResult({ status: "idle", deferredUntilWake: true });
          }
          // Codex parity: compaction remains inside the same logical turn and
          // the same activity. Rebuild the model-visible history from the
          // durable replacement and continue the sampling loop; do not create
          // a recovery event, a queue row, a fake user message, or a sandbox.
          retriedAfterCompaction = true;
          observability.info("context compaction recovery retrying turn after compaction", {
            sessionId: input.sessionId,
            turnId: activeTurnId,
            reason: recoveryKind,
            compacted,
          });
          await prepareRunAttemptInput();
        }
      }
    } catch (error) {
      // Graceful worker shutdown (deploy / rollout restart): checkpoint the
      // same current inference for a new fenced attempt instead of failing the
      // session. Conversation truth is already persisted per model response;
      // the final reconcile bounds loss to the one in-flight model step.
      //
      // The branch deliberately does NOT require turn.started to have been
      // published: a shutdown landing during setup (claim/billing, before the
      // turn visibly started) must also recover, not fail the session. In that
      // early case nothing ran, so the new attempt uses the original trigger.
      // The turn id falls
      // back to the workflow-claimed turn when the local lookup had not
      // finished yet.
      const recoveryTurnId = turnId;
      // P1.2: a lease supersession during resume (a newer epoch re-established
      // the box concurrently) is NOT a session failure. Recover the same turn
      // so its next attempt reattaches under the current epoch.
      if (error instanceof SandboxLeaseSupersededError && recoveryTurnId) {
        try {
          const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
            sessionId: input.sessionId,
            turnId: recoveryTurnId,
            triggerEventId: triggerEventId!,
            attemptId: input.attemptId,
            reason: "sandbox_lease_superseded",
          });
          if (recovery.action === "stale") {
            acknowledgeLostAttemptOwnership();
            activityStatus = "cancelled";
            turnMetricOutcome = "cancelled";
            return claimedResult({ status: "cancelled" });
          }
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            recovery.events,
          );
          activityStatus = "recovering";
          turnMetricOutcome = "recovering";
          return claimedResult({ status: "recovering" });
        } catch (recoveryError) {
          console.error("sandbox lease supersession recovery failed", recoveryError);
          throw recoveryError;
        }
      }
      const cancellationFailure = turnOperationCancellationFailure(error);
      if (
        cancellationFailure &&
        isWorkerShutdownCancellation(cancellationFailure) &&
        recoveryTurnId
      ) {
        try {
          await flushRuntimeBatcher();
          await reconcileConversationTruth();
          // An approval-decision rerun always replays its original trigger:
          // the decision is applied through the approval resume path reading
          // the frozen RunState blob (the only representation of a turn
          // paused mid-flight), so swapping the trigger for a resume notice
          // could drop the user's decision. Re-applying an already-consumed
          // approval re-executes at most the single approved step — the same
          // bound every recovery already accepts.
          const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
            sessionId: input.sessionId,
            turnId: recoveryTurnId,
            triggerEventId: triggerEventId!,
            attemptId: input.attemptId,
            reason: "worker_shutdown",
          });
          if (recovery.action === "stale") {
            acknowledgeLostAttemptOwnership();
            activityStatus = "cancelled";
            turnMetricOutcome = "cancelled";
            return claimedResult({ status: "cancelled" });
          }
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            recovery.events,
          );
          activityStatus = "recovering";
          turnMetricOutcome = "recovering";
          return claimedResult({ status: "recovering" });
        } catch (recoveryError) {
          // The database transition is atomic. If it could not commit, surface
          // the failure so Temporal can retry on a healthy worker; never mutate
          // the turn through a second cancellation path.
          console.error("worker-shutdown recovery checkpoint failed", recoveryError);
          throw recoveryError;
        }
      }
      if (error instanceof TurnAttemptFencedError) {
        activityStatus = "cancelled";
        activityError = error;
        acknowledgeQuiescence = true;
        noteCancellationRequested();
        await waitForTurnFinalizerStep(
          flushRuntimeBatcher(),
          turnFinalizerCancellationSignal(cancellationSignal, activityStatus),
        );
        // Ownership already moved to a newer attempt or an authoritative
        // control transaction. Surface the exact transport cancellation rather
        // than a normal result. Temporal terminalization remains diagnostic
        // only; replacement admission waits for the activity-owned durable
        // quiescence receipt written from the hard tool fence below.
        turnMetricOutcome = "cancelled";
        throw new CancelledFailure("TURN_ATTEMPT_FENCED", [], error);
      }
      if (cancellationFailure) {
        activityStatus = "cancelled";
        activityError = error;
        acknowledgeQuiescence = true;
        noteCancellationRequested();
        await waitForTurnFinalizerStep(
          flushRuntimeBatcher(),
          turnFinalizerCancellationSignal(cancellationSignal, activityStatus),
        );
        // The workflow owns cancellation settlement: Pause/Steer controls use
        // settleSessionControl, and heartbeat timeouts use worker-death
        // recovery. A dying activity must never append a
        // competing cancellation or mutate the turn/session on its own.
        turnMetricOutcome = "cancelled";
        throw cancellationFailure;
      }
      // The SDK's per-segment turn cap is a pacing valve, not a failure: end
      // the turn gracefully and idle the session so an active goal continues
      // via a synthesized continuation turn (or a user message resumes work).
      // The run state captured at the cap keeps full conversation context for
      // that resumption.
      const maxTurns = maxTurnsExceededRunState(error);
      if (maxTurns && publish && turnId && turnStartedPublished) {
        await flushRuntimeBatcher();
        // The SDK attaches the run state at the throw site; persisting it lets
        // the continuation resume with this segment's full context. If capture
        // ever fails, the continuation falls back to the previous snapshot --
        // degraded context, flagged on the event, but still strictly better
        // than a terminal failed session: the sandbox filesystem state
        // persists independently and the agent re-derives from it.
        await reconcileConversationTruth();
        if (
          !(await settle!({
            events: [
              {
                type: "turn.completed",
                payload: { output: "", segmentLimit: "max_turns" },
              },
              { type: "session.status.changed", payload: { status: "idle" } },
            ],
            turnStatus: "completed",
            sessionStatus: "idle",
            activeTurnId: null,
          }))
        ) {
          return claimedResult({ status: "cancelled" });
        }
        turnMetricOutcome = "completed";
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: turnId,
          sessionId: input.sessionId,
          turnId,
          turnAttemptId: input.attemptId,
          idempotencyKey: `usage:agent_run.completed:${turnId}`,
        });
        activityStatus = "idle";
        return claimedResult({ status: "idle" });
      }
      const settleLostCodexAttempt = async (
        lostTurnId: string,
        holderId: string,
        generation: number,
        historyCheckpointDurable = false,
      ): Promise<RunAgentTurnResult> => {
        let checkpointDurable = historyCheckpointDurable;
        try {
          if (!historyCheckpointDurable) {
            await flushRuntimeBatcher();
            await reconcileConversationTruth({ requireDurable: true });
          }
          checkpointDurable = true;
        } catch (checkpointError) {
          observability.warn("Codex lease-loss checkpoint failed; refusing automatic turn replay", {
            workspaceId: input.workspaceId,
            turnId: lostTurnId,
            errorName: checkpointError instanceof Error ? checkpointError.name : "unknown",
          });
        }

        const settlement = await settleCodexCredentialLeaseLoss(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: lostTurnId,
          attemptId: input.attemptId,
          holderId,
          generation,
          expectedRedispatches: redispatchesAtDispatch,
          checkpointDurable,
          recoveryPayload: {
            triggerEventId: triggerEventId!,
            reason: "codex_lease_lost",
            credentialId: effectiveCodexCredentialId,
          },
          failedPayload: {
            error:
              "The Codex credential lease was lost and the latest conversation checkpoint could not be persisted. Automatic replay was refused.",
            code: "codex_lease_checkpoint_failed",
            retryable: false,
          },
        });
        codexLeaseHeld = false;
        observability.incrementCounter({
          name: "opengeni_codex_lease_loss_settlements_total",
          help: "Fenced Codex lease-loss settlements by outcome.",
          labels: {
            workspace_key: codexWorkspaceKey,
            outcome: settlement.action,
          },
        });
        await publishDurableSessionEvents(
          bus,
          input.workspaceId,
          input.sessionId,
          settlement.events,
        );
        activityError = error;
        if (settlement.action === "failed") {
          activityStatus = "failed";
          turnMetricOutcome = "failed";
          await deliverFailedChildTurnToParent(
            { db, bus, settings, observability, wakeSessionWorkflow },
            input.workspaceId,
            input.sessionId,
            lostTurnId,
          );
          return claimedResult({ status: "failed" });
        }
        activityStatus = "recovering";
        turnMetricOutcome = "recovering";
        return claimedResult({ status: "recovering" });
      };

      // A missing/expired/superseded lease is an execution-ownership failure,
      // not a provider failure. Settle it before credential quarantine or the
      // generic terminal path: the DB transaction marks a still-current turn
      // recoverable, but a successor attempt or worker recovery makes this activity
      // stale and unable to clobber the shared turn/session.
      if (
        codexLeaseLost &&
        settings.codexCredentialLeasingEnabled &&
        isCodexTurn &&
        publish &&
        turnId &&
        turnStartedPublished &&
        codexLeaseHolderId &&
        codexLeaseGeneration !== null
      ) {
        return await settleLostCodexAttempt(turnId, codexLeaseHolderId, codexLeaseGeneration);
      }
      // Definitive Codex credential/account refusals are the only provider
      // errors that may walk the pool. This is an explicit checkpoint + SAME
      // turn recovery, never an SDK/Temporal blind retry. A network break,
      // malformed/partial 200 stream, invalid content, prompt 4xx, or provider
      // 5xx does not classify here and therefore cannot consume another
      // subscription or duplicate a side effect.
      const codexCredentialFailure =
        settings.codexCredentialLeasingEnabled && isCodexTurn && effectiveCodexCredentialId
          ? classifyCodexCredentialFailure(error)
          : null;
      if (
        codexCredentialFailure &&
        effectiveCodexCredentialId &&
        publish &&
        turnId &&
        turnStartedPublished
      ) {
        observability.incrementCounter({
          name: "opengeni_codex_credential_failures_total",
          help: "Definitive Codex credential failures classified for safe failover.",
          labels: {
            workspace_key: codexWorkspaceKey,
            kind: codexCredentialFailure.kind,
            outcome: "classified",
          },
        });
        const failoverStartedAt = performance.now();
        let checkpointDurable = false;
        try {
          await flushRuntimeBatcher();
          await reconcileConversationTruth({ requireDurable: true });
          checkpointDurable = true;
        } catch (checkpointError) {
          observability.incrementCounter({
            name: "opengeni_codex_failover_checkpoints_total",
            help: "Durable Codex failover checkpoint attempts by outcome.",
            labels: { workspace_key: codexWorkspaceKey, outcome: "failed" },
          });
          observability.warn("Codex failover checkpoint failed; refusing automatic replay", {
            workspaceId: input.workspaceId,
            turnId,
            errorName: checkpointError instanceof Error ? checkpointError.name : "unknown",
          });
        }

        if (checkpointDurable) {
          observability.incrementCounter({
            name: "opengeni_codex_failover_checkpoints_total",
            help: "Durable Codex failover checkpoint attempts by outcome.",
            labels: { workspace_key: codexWorkspaceKey, outcome: "completed" },
          });
          const now = new Date();
          const before = await listCodexAccountStatuses(db, input.workspaceId).catch(() => []);
          const servingCached = before.find((account) => account.id === effectiveCodexCredentialId);
          const usageSnapshot = latestCodexUsage as CodexUsageHeaderSnapshot | null;
          const serving = servingCached
            ? {
                ...servingCached,
                ...(usageSnapshot
                  ? {
                      primaryUsedPercent: usageSnapshot.primaryUsedPercent,
                      primaryResetAt: usageSnapshot.primaryResetAt,
                      secondaryUsedPercent: usageSnapshot.secondaryUsedPercent,
                      secondaryResetAt: usageSnapshot.secondaryResetAt,
                    }
                  : {}),
              }
            : null;
          const cooldownUntil = codexCredentialCooldownUntil(codexCredentialFailure, serving, now);
          const statePersisted =
            codexLeaseHolderId && codexLeaseGeneration !== null
              ? await quarantineCodexCredentialForLease(db, {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  turnId,
                  credentialId: effectiveCodexCredentialId,
                  holderId: codexLeaseHolderId,
                  generation: codexLeaseGeneration,
                  quarantine:
                    codexCredentialFailure.kind === "auth"
                      ? {
                          kind: "status",
                          status: "needs_relogin",
                          lastError: "model request remained unauthorized after refresh",
                        }
                      : codexCredentialFailure.kind === "forbidden"
                        ? {
                            kind: "status",
                            status: "error",
                            lastError: "model request was forbidden for this credential",
                          }
                        : { kind: "cooldown", until: cooldownUntil! },
                })
              : false;
          if (!statePersisted && codexLeaseHolderId && codexLeaseGeneration !== null) {
            codexLeaseLost = true;
            return await settleLostCodexAttempt(
              turnId,
              codexLeaseHolderId,
              codexLeaseGeneration,
              true,
            );
          }
          const [rotation, accounts] = await Promise.all([
            getCodexRotationSettings(db, input.workspaceId).catch(() => null),
            listCodexAccountStatuses(db, input.workspaceId).catch(() => []),
          ]);
          const decision = rotation
            ? chooseRotationActive({
                rotationStrategy: rotation.rotationStrategy as CodexRotationStrategy,
                activeCredentialId: rotation.activeCredentialId,
                priorCredentialId: effectiveCodexCredentialId,
                accounts,
                now: new Date(),
                usedConnectors: serving?.connectorNamespaces ?? [],
              })
            : ({ kind: "none" } as const);
          const candidateAvailable =
            statePersisted &&
            Boolean(rotation?.rotationEnabled && rotation?.leaseRotationEnabled) &&
            decision.kind === "active" &&
            decision.credentialId !== effectiveCodexCredentialId;

          if (candidateAvailable && codexLeaseHolderId && codexLeaseGeneration !== null) {
            const settlement = await settleCodexCredentialFailover(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              attemptId: input.attemptId,
              holderId: codexLeaseHolderId,
              generation: codexLeaseGeneration,
              expectedRedispatches: redispatchesAtDispatch,
              maxFailovers: Math.max(1, accounts.length),
              recoveryPayload: {
                triggerEventId: triggerEventId!,
                reason: "codex_credential_failover",
                credentialId: effectiveCodexCredentialId,
                failureKind: codexCredentialFailure.kind,
                ...(cooldownUntil ? { cooldownUntil: cooldownUntil.toISOString() } : {}),
              },
            });
            observability.incrementCounter({
              name: "opengeni_codex_failover_settlements_total",
              help: "Atomic Codex failover settlements by outcome.",
              labels: {
                workspace_key: codexWorkspaceKey,
                outcome: settlement.action,
              },
            });
            if (settlement.action === "recovering") {
              codexLeaseHeld = false;
              await publishDurableSessionEvents(
                bus,
                input.workspaceId,
                input.sessionId,
                settlement.events,
              );
              observability.observeHistogram({
                name: "opengeni_codex_failover_recovery_seconds",
                help: "Time from credential refusal to durable same-turn recovery.",
                labels: {
                  workspace_key: codexWorkspaceKey,
                  kind: codexCredentialFailure.kind,
                },
                value: Math.max(0, (performance.now() - failoverStartedAt) / 1000),
              });
              activityStatus = "recovering";
              turnMetricOutcome = "recovering";
              return claimedResult({ status: "recovering" });
            }
            if (settlement.action === "stale") {
              // One transaction proves both exact-holder recovery (including a
              // just-expired or reaped lease row) and successor/control-gate
              // rejection. Cross the hard tool fence so a control-gate loss can
              // write its quiescence receipt; a successor-only loss is a no-op.
              acknowledgeLostAttemptOwnership();
              activityStatus = "cancelled";
              turnMetricOutcome = "cancelled";
              return claimedResult({ status: "recovering" });
            }
          }
        }
      }
      // A ChatGPT/Codex usage cap (429 usage_limit_reached) is account state,
      // NOT an agent failure: surface the precise, actionable message (so the
      // user sees the reset window) but idle the session — never go terminal,
      // which would reject the user's next message after the cap lifts. The
      // payload is retryable:false so the generic provider-backpressure auto-retry
      // does not loop. For an active goal we hold the continuation for the reported
      // reset window (capped) so it resumes itself when access returns, instead of
      // hammering the capped backend.
      const usageLimit = isCodexTransportError(error) ? classifyCodexUsageLimitError(error) : null;
      if (usageLimit && publish && turnId && turnStartedPublished) {
        const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
        const goalActive = Boolean(goal && goal.status === "active");
        await flushRuntimeBatcher();
        await reconcileConversationTruth();
        // --- P3 reactive rotation (gated; re-fetch fresh state on this already-failed,
        // already-idling path). Mark THIS account cooling until its reset, then CONSULT the
        // engine over fresh accounts to decide continueDelayMs: a fast 0-delay re-dispatch
        // when another account is available, or idle-until-earliest when all are capped. The
        // catch deliberately does NOT move the active pointer — the re-dispatched turn's
        // proactive seam (turn-start) is the single authoritative pointer-move + strip site.
        let rotated = false;
        let rotationResumeMs: number | null = null; // 0 ⇒ a candidate is available; re-dispatch now
        let rotationResumeIdleUntilReset = false; // circuit-breaker fall (Finding 1b) ⇒ MANDATORY hold
        let allCappedResetAt: Date | null = null; // set ⇒ every account capped; idle until this
        let capacityAuthoritativeResetAt: Date | null = null;
        if (effectiveCodexCredentialId) {
          const [rotation, sessionCodex] = await Promise.all([
            getCodexRotationSettings(db, input.workspaceId).catch(() => null),
            getSessionCodexState(db, input.workspaceId, input.sessionId).catch(() => null),
          ]);
          const reactiveStrategy = (rotation?.rotationStrategy ??
            "most_remaining") as CodexRotationStrategy;
          const reactiveDisposition = classifyCodexPin({
            pinnedCredentialId: sessionCodex?.pinnedCredentialId ?? null,
            pinSource: sessionCodex?.pinSource ?? null,
            strategy: reactiveStrategy,
            rotationEnabled: Boolean(rotation?.rotationEnabled),
          });
          const reactiveSharded = reactiveDisposition === "sharded";
          const rotating =
            Boolean(rotation?.rotationEnabled || rotation?.leaseRotationEnabled) &&
            reactiveDisposition !== "manual";
          if (rotating && rotation) {
            const accounts = await listCodexAccountStatuses(db, input.workspaceId).catch(() => []);
            const serving = accounts.find((a) => a.id === effectiveCodexCredentialId) ?? null;
            // Both provider allowance windows bind. Use the same canonical
            // quarantine calculation as the fenced failover path so a short
            // five-hour reset can never overwrite a later weekly reset.
            const until = codexCredentialCooldownUntil(
              { kind: "quota", cooldownSeconds: usageLimit.resetsInSeconds },
              serving,
              new Date(),
            )!;
            // Finding 1a: INSPECT the cooldown-write result. A swallowed best-effort
            // write whose failure went unnoticed is exactly what lets the next proactive
            // rank re-pick this just-capped account (stale-low cached usedPercent, not
            // cooling) — so capture whether it PERSISTED and feed it into the resume floor.
            const cooldownMutation = await setCodexCredentialExhaustedWithWakeTargets(
              db,
              input.workspaceId,
              effectiveCodexCredentialId,
              until,
            ).catch(() => null);
            const cooldownPersisted = cooldownMutation?.result ?? false;
            if (cooldownMutation) {
              await signalCodexCapacityWakeTargets(
                { signalCodexCapacityWorkflow, wakeSessionWorkflow },
                cooldownMutation.wakeTargets,
              );
            }
            // Re-rank over the fresh accounts; the in-memory list predates the cooldown
            // write, so stamp the just-cooled account so the engine excludes it now. The
            // serving account is thus walked AT MOST ONCE per turn (invariant 4: bounded).
            const fresh = accounts.map((a) =>
              a.id === effectiveCodexCredentialId ? { ...a, exhaustedUntil: until } : a,
            );
            if (reactiveSharded) {
              // AM-5: RE-SHARD over the healthy survivors (the just-capped serving account is
              // marked cooling in `fresh` → excluded) so sessions sharing a capped account
              // spread across the pool rather than re-concentrating on one first-eligible
              // failover. AM-3: DURABLY REWRITE the session's POLICY pin to the new home —
              // selectCodexCredentialForTurn returns a cooling pinned account with NO
              // exhaustion check, so a pointer-only move would leave the re-dispatched turn on
              // the capped pin. Like the classic path we do NOT touch the workspace active
              // pointer; the session pin is the sharded home.
              const newHome = shardCredentialForSession({
                sessionId: input.sessionId,
                accounts: fresh,
                now: new Date(),
              });
              if (newHome) {
                rotated = true;
                const pinMutation = await withCodexCapacityMutation(
                  db,
                  {
                    workspaceId: input.workspaceId,
                    reason: "codex_policy_pin_resharded",
                  },
                  async (tx) => {
                    const changed = await setSessionCodexPin(
                      tx,
                      input.workspaceId,
                      input.sessionId,
                      newHome,
                      "policy",
                      {
                        expected: {
                          pinnedCredentialId: sessionCodex?.pinnedCredentialId ?? null,
                          pinSource: sessionCodex?.pinSource ?? null,
                        },
                      },
                    );
                    return { result: changed, changed };
                  },
                ).catch(() => null);
                if (pinMutation) {
                  await signalCodexCapacityWakeTargets(
                    { signalCodexCapacityWorkflow, wakeSessionWorkflow },
                    pinMutation.wakeTargets,
                  );
                }
                const priorConsecutiveRotations = await countConsecutiveReactiveRotations(
                  db,
                  input.workspaceId,
                  input.sessionId,
                ).catch(() => 0);
                const resume = computeReactiveRotationResume({
                  cooldownPersisted,
                  priorConsecutiveRotations,
                  connectedAccountCount: accounts.length,
                });
                rotationResumeMs = resume.continueDelayMs;
                rotationResumeIdleUntilReset = resume.idleUntilReset;
              } else {
                // Every account capped/cooling → idle until the earliest reset across all.
                rotated = true;
                allCappedResetAt = earliestCodexReset(fresh, new Date());
                capacityAuthoritativeResetAt = authoritativeCodexCapacityResetAt(fresh, new Date());
              }
            } else {
              const decision = chooseRotationActive({
                rotationStrategy: reactiveStrategy,
                activeCredentialId: rotation.activeCredentialId,
                priorCredentialId: effectiveCodexCredentialId,
                accounts: fresh,
                now: new Date(),
                // P4: the just-capped serving account's connector set is the proxy for
                // "what this session has access to" — prefer a covering failover target.
                usedConnectors: serving?.connectorNamespaces ?? [],
              });
              if (decision.kind === "active") {
                rotated = true;
                // Finding 1: a live candidate normally re-dispatches NOW (0). Two second-order
                // faults would turn that 0 into a hot loop, so bound it. Count the consecutive
                // reactive failovers since the last successful turn (this one is not yet
                // published) and combine with the cooldown-persistence result.
                const priorConsecutiveRotations = await countConsecutiveReactiveRotations(
                  db,
                  input.workspaceId,
                  input.sessionId,
                ).catch(() => 0);
                const resume = computeReactiveRotationResume({
                  cooldownPersisted,
                  priorConsecutiveRotations,
                  connectedAccountCount: accounts.length,
                });
                rotationResumeMs = resume.continueDelayMs; // 0 (happy path), a slow-retry floor, or the circuit-breaker idle
                rotationResumeIdleUntilReset = resume.idleUntilReset; // true only on the circuit-breaker fall (MANDATORY hold)
              } else if (decision.kind === "allCapped") {
                rotated = true;
                allCappedResetAt = decision.earliestResetAt;
                capacityAuthoritativeResetAt = authoritativeCodexCapacityResetAt(fresh, new Date());
              }
              // kind:"none" → fall through to today's single-account idle.
            }
          }
        }

        const failurePayload = allCappedResetAt
          ? codexUsageLimitFailurePayload(
              {
                resetsInSeconds: Math.ceil(
                  Math.max(0, allCappedResetAt.getTime() - Date.now()) / 1000,
                ),
              },
              error instanceof Error ? error.message : String(error),
              { allAccounts: true },
            )
          : codexUsageLimitFailurePayload(
              usageLimit,
              error instanceof Error ? error.message : String(error),
            );
        // A live alternate is still handled by the existing immediate,
        // same-policy continuation path. When no alternate exists (all capped,
        // or a single non-rotating account), persist the native capacity wait
        // instead of an in-memory delay/user-message recovery.
        if (goalActive && goal && rotationResumeMs === null) {
          const providerResetAt =
            capacityAuthoritativeResetAt ??
            (usageLimit.resetsInSeconds !== null &&
            Number.isFinite(usageLimit.resetsInSeconds) &&
            usageLimit.resetsInSeconds > 0
              ? new Date(Date.now() + Math.ceil(usageLimit.resetsInSeconds) * 1000)
              : null);
          const armed = await armCodexCapacityWait(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            attemptId: input.attemptId,
            workflowId: input.workflowId,
            goalId: goal.id,
            goalVersion: goal.version,
            earliestResetAt: providerResetAt,
            resetKind: providerResetAt ? "authoritative" : "bounded_refresh",
            failurePayload,
            ...(codexLeaseHolderId && codexLeaseGeneration !== null
              ? {
                  leaseFence: {
                    holderId: codexLeaseHolderId,
                    generation: codexLeaseGeneration,
                  },
                  expectedRedispatches: redispatchesAtDispatch,
                }
              : {}),
          });
          if (armed.action === "waiting") {
            await publishDurableSessionEvents(
              bus,
              input.workspaceId,
              input.sessionId,
              armed.events,
            );
            turnMetricOutcome = "failed";
            activityStatus = "idle";
            activityError = error;
            return claimedResult({
              status: "idle",
              capacityWait: {
                waiterId: armed.waiter.id,
                generation: armed.waiter.generation,
                nextCheckAt: armed.waiter.nextCheckAt.toISOString(),
                wakeRevision: armed.waiter.wakeRevision,
              },
            });
          }
        }
        if (
          !(await settle!({
            events: [
              // `rotated:true` ONLY on the reactive rotation path tells evaluateGoalContinuation to
              // freeze autoContinuations (a rotation walk must not burn the goal's continuation budget).
              {
                type: "turn.failed",
                payload: {
                  ...failurePayload,
                  recovery: goalActive ? "goal_continuation" : "user_message",
                  ...(rotated ? { rotated: true } : {}),
                },
              },
              { type: "session.status.changed", payload: { status: "idle" } },
            ],
            turnStatus: "failed",
            sessionStatus: "idle",
            activeTurnId: null,
          }))
        ) {
          return claimedResult({ status: "cancelled" });
        }
        turnMetricOutcome = "failed";
        activityStatus = "idle";
        activityError = error;
        if (goalActive) {
          // Rotation: a candidate is available → continue NOW (0). All-capped → idle until the
          // earliest reset across all accounts (capped at 1h). Else the unchanged single-account idle.
          if (rotationResumeMs !== null) {
            // A candidate IS available. Normally the just-failed account is now cooling so
            // the ranker cannot re-pick it → 0 (re-dispatch NOW, the legitimate skip-the-hold
            // case). Finding 1 bounds the two exceptions: a persistence fault yields a positive
            // slow-retry floor, and once consecutive failovers exceed the account count + margin
            // the circuit breaker returns a fixed MANDATORY idle (idleUntilReset) — never a 0-delay
            // hot loop against a capped backend + DB.
            return claimedResult({
              status: "idle",
              continueDelayMs: rotationResumeMs,
              ...(rotationResumeIdleUntilReset ? { idleUntilReset: true } : {}),
            });
          }
          // All-capped: clamp to [MIN_IDLE_MS, max] — a POSITIVE, BOUNDED hold (never 0,
          // so session.ts can never tight-loop). The post-idle continuation re-dispatch
          // hits the proactive seam, which refreshes usage and self-heals.
          const resumeMs = allCappedResetAt
            ? computeIdleDelayMs(allCappedResetAt, new Date(), CODEX_USAGE_LIMIT_MAX_RESUME_MS)
            : usageLimit.resetsInSeconds !== null &&
                Number.isFinite(usageLimit.resetsInSeconds) &&
                usageLimit.resetsInSeconds > 0
              ? Math.min(
                  Math.ceil(usageLimit.resetsInSeconds) * 1000,
                  CODEX_USAGE_LIMIT_MAX_RESUME_MS,
                )
              : CODEX_USAGE_LIMIT_MAX_RESUME_MS;
          return claimedResult({
            status: "idle",
            continueDelayMs: resumeMs,
            ...(allCappedResetAt ? { idleUntilReset: true } : {}),
          });
        }
        return claimedResult({ status: "idle" });
      }
      // Budget/limit exhaustion between model calls is account state, not an
      // agent failure: idle the session for goal-bearing and goal-less runs
      // alike (a failed session would reject the user's next message after a
      // top-up). An active goal pauses visibly with reason "limits" at the
      // next continuation evaluation, without consuming continuation budget.
      if (error instanceof BudgetExhaustedError && publish && turnId && turnStartedPublished) {
        await flushRuntimeBatcher();
        await reconcileConversationTruth();
        if (
          !(await settle!({
            events: [
              {
                type: "turn.completed",
                payload: {
                  output: "",
                  segmentLimit: "budget_exhausted",
                  detail: error.message,
                },
              },
              { type: "session.status.changed", payload: { status: "idle" } },
            ],
            turnStatus: "completed",
            sessionStatus: "idle",
            activeTurnId: null,
          }))
        ) {
          return claimedResult({ status: "cancelled" });
        }
        turnMetricOutcome = "completed";
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: turnId,
          sessionId: input.sessionId,
          turnId,
          turnAttemptId: input.attemptId,
          idempotencyKey: `usage:agent_run.completed:${turnId}`,
        });
        activityStatus = "idle";
        return claimedResult({ status: "idle" });
      }
      // A retryable provider/MCP failure is transient external backpressure,
      // not a session or goal failure. The in-client retry budget is already
      // exhausted by the time the error reaches here. Checkpoint conversation
      // truth, recover this SAME accepted turn, then let the workflow re-claim
      // it after a pacing delay. This is independent of goal state and never
      // relies on a synthetic continuation prompt.
      const failure = agentRunFailurePayload(error);
      if (isSessionEventPersistenceError(error)) {
        // Never pass the original Drizzle/postgres-js error to telemetry: its
        // nested cause may contain raw SQL and bound parameters. The typed DB
        // boundary retains only SQLSTATE, stage, correlation, and safe catalog
        // identifiers. Provider inference has already happened and is NOT
        // retried by this terminal classification.
        observability.error("session event persistence failed", {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          attemptId: input.attemptId,
          code: error.details.code,
          sqlState: error.details.sqlState ?? "unknown",
          stage: error.details.stage,
          eventTypes: error.details.eventTypes.join(","),
          correlationId: error.details.correlationId,
          attempts: error.details.attempts,
          retryOutcome: error.details.retryOutcome,
          dbSeverity: error.details.database.severity,
          dbSchema: error.details.database.schema,
          dbTable: error.details.database.table,
          dbColumn: error.details.database.column,
          dbDataType: error.details.database.dataType,
          dbConstraint: error.details.database.constraint,
          dbRoutine: error.details.database.routine,
        });
      }
      if (failure.retryable && publish && turnId && turnStartedPublished) {
        const recoveryResult = providerRecoveryResult();
        await flushRuntimeBatcher();
        await reconcileConversationTruth({ requireDurable: true });
        const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId,
          triggerEventId: triggerEventId!,
          attemptId: input.attemptId,
          reason: failure.code ?? "provider_unavailable",
          detail: {
            ...failure,
            continueDelayMs: recoveryResult.continueDelayMs,
          },
        });
        if (recovery.action === "stale") {
          acknowledgeLostAttemptOwnership();
          activityStatus = "cancelled";
          turnMetricOutcome = "cancelled";
          return claimedResult({ status: "cancelled" });
        }
        await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, recovery.events);
        turnMetricOutcome = "recovering";
        activityStatus = "recovering";
        activityError = error;
        return claimedResult(recoveryResult);
      }
      activityStatus = "failed";
      activityError = error;
      if (!publish || !turnId || !turnStartedPublished) {
        throw error;
      }
      // A partial/malformed stream may have emitted assistant/tool items (and
      // external side effects) before its terminal error. Persist every item the
      // SDK state observed before marking the turn failed so a later user revive
      // never replays work from an incomplete history. This does not retry or
      // rotate the ambiguous request.
      await flushRuntimeBatcher();
      await reconcileConversationTruth();
      if (
        !(await settle!({
          events: [
            { type: "turn.failed", payload: failure },
            { type: "session.status.changed", payload: { status: "failed" } },
          ],
          turnStatus: "failed",
          sessionStatus: "failed",
          activeTurnId: null,
        }))
      ) {
        return claimedResult({ status: "cancelled" });
      }
      turnMetricOutcome = "failed";
      // The common failure path ends here: runAgentTurn marks the session
      // failed and returns "failed", and the session workflow then exits
      // WITHOUT calling failSession/markSessionIdle. Wake a spawned worker's
      // parent here too, so a manager learns of a worker that died inside its
      // turn (not just one failed by the workflow's failSession path). Turn
      // settlement already owns the durable outbox payload; this call only
      // delivers that exact turn-scoped row.
      await deliverFailedChildTurnToParent(
        { db, bus, settings, observability, wakeSessionWorkflow },
        input.workspaceId,
        input.sessionId,
        turnId,
      );
      return claimedResult({ status: "failed" });
    } finally {
      const finalizationStarted = performance.now();
      let finalizationError: unknown;
      let physicalToolQuiescenceConfirmed = !acknowledgeQuiescence;
      let quiescenceReceiptOrProofDurable = !acknowledgeQuiescence;
      const finalizerSignal = turnFinalizerCancellationSignal(cancellationSignal, activityStatus);
      try {
        const toolCancellationFence = toolCancellationFenceRef.current;
        if (acknowledgeQuiescence && toolCancellationFence) {
          // This is an AUTHORITATIVE safety wait, not best-effort housekeeping.
          // It actively interrupts any turn-owned shell process and drains
          // parallel filesystem/computer operations. Never race it against the
          // already-aborted Temporal signal: the replacement queue may open only
          // after the old attempt can no longer mutate the workspace.
          toolCancellationFence.cancel(
            cancellationSignal?.reason ?? new Error("TURN_ATTEMPT_FENCED"),
          );
          await toolCancellationFence.waitForQuiescence();
          physicalToolQuiescenceConfirmed = true;
        } else if (acknowledgeQuiescence) {
          // A cancellation can arrive before sandbox-backed capabilities exist.
          // At that boundary there are no tool calls to drain. Sandbox agent
          // construction itself fails closed when a backend is present but no
          // controller was installed.
          physicalToolQuiescenceConfirmed = true;
        }
        // Toolspace renewal is attempt-owned. Stop it and drain a physical file
        // replacement before any successor can be admitted.
        toolspaceTokenRenewalClosed = true;
        const toolspaceRenewalToStop =
          toolspaceTokenRenewal as ToolspaceTokenRenewalController | null;
        toolspaceTokenRenewal = null;
        if (toolspaceRenewalToStop) {
          await waitForTurnFinalizerStep(toolspaceRenewalToStop.stop(), finalizerSignal);
        }
        // Run credentials are attempt-owned sandbox state. Stop renewal, drain
        // its last physical write, and remove only this attempt's generations
        // BEFORE publishing quiescence (which can admit a successor). Cleanup
        // deliberately bypasses the now-cancelled tool fence. Pointer mutation
        // is serialized with activation, and the attempt-qualified check cannot
        // erase a successor generation. Cleanup failure is recorded but must not
        // skip the remaining finalizer chain or its quiescence proof.
        runCredentialRenewalClosed = true;
        const runRenewalToStop = runCredentialRenewal as RunCredentialRenewalController | null;
        runCredentialRenewal = null;
        if (runRenewalToStop) {
          await waitForTurnFinalizerStep(runRenewalToStop.stop(), finalizerSignal);
        }
        const credentialSessionToClear = runCredentialSession;
        runCredentialSession = null;
        if (credentialSessionToClear) {
          const cleanup = clearRunCredentialsForAttempt(credentialSessionToClear, {
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            executionGeneration,
          }).catch((error: unknown) => {
            try {
              observability.incrementCounter({
                name: "opengeni_run_credential_cleanup_total",
                help: "Attempt-owned run credential cleanup outcomes.",
                labels: { outcome: "error" },
              });
              observability.warn("Attempt-owned run credential cleanup failed", {
                sessionId: input.sessionId,
                turnId,
                attemptId: input.attemptId,
                errorClass: error instanceof Error ? error.name : "UnknownError",
              });
            } catch {
              // Cleanup observability must not own finalizer liveness.
            }
          });
          await waitForTurnFinalizerStep(cleanup, finalizerSignal);
        }
        if (acknowledgeQuiescence && physicalToolQuiescenceConfirmed) {
          // This receipt is part of the hard cancellation boundary, not
          // housekeeping. Persist it immediately after the sandbox/tool fence
          // and before lease, cache, recording, or provider cleanup. Its
          // transaction also enqueues the exact workflow wake that will admit
          // the replacement; Temporal activity terminalization does neither.
          const proof: SessionAttemptQuiescenceProof = {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            workflowId: input.workflowId,
            workflowRunId: input.workflowRunId,
            activityId: dispatchId,
          };
          const recoveryMode = await persistOrSignalSessionAttemptQuiescence({
            proof,
            persistReceipt: async () =>
              await markSessionAttemptQuiesced(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                attemptId: input.attemptId,
                temporalWorkflowId: input.workflowId,
                temporalWorkflowRunId: input.workflowRunId,
                temporalActivityId: dispatchId,
                allowUninterrupted: true,
              }),
            publishEvents: async (events) => {
              await waitForTurnFinalizerStep(
                publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, events),
                finalizerSignal,
              );
            },
            signalProof: signalSessionAttemptQuiesced,
            heartbeat: (attempt, retryMs) => {
              activityContext?.heartbeat({
                phase: "quiescence-proof-delivery",
                sessionId: input.sessionId,
                attemptId: input.attemptId,
                deliveryAttempt: attempt,
                retryMs,
                at: new Date().toISOString(),
              });
            },
            onReceiptFailure: (error) => {
              console.error("agent turn quiescence receipt exhausted; signalling proof", error);
            },
            onPublishFailure: (error) => {
              console.error("agent turn quiescence event fanout failed", error);
            },
            onSignalFailure: (error, attempt, retryMs) => {
              console.error("agent turn quiescence proof signal failed; retrying", {
                error,
                attempt,
                retryMs,
              });
            },
          });
          quiescenceReceiptOrProofDurable = true;
          if (recoveryMode === "signal") {
            observability.info("agent turn quiescence proof handed to workflow recovery", {
              "opengeni.session_id": input.sessionId,
              "opengeni.attempt_id": input.attemptId,
              "opengeni.workflow_run_id": input.workflowRunId,
              "opengeni.activity_id": dispatchId,
            });
          }
        }
        gitCredentialRenewalClosed = true;
        const renewalsToStop = gitCredentialRenewals;
        gitCredentialRenewals = [];
        for (const renewal of renewalsToStop) {
          await waitForTurnFinalizerStep(renewal.stop(), finalizerSignal);
        }
        // Drain the buffered Connected Machine op events (infra failures + healed
        // recoveries) to durable session events — awaited, best-effort, never blocking
        // the turn. Sync observer → buffer → single awaited append here (no unawaited
        // DB write inside the activity). Scoped to this turn; skipped if no turnId
        // (the op ran under a turn, so on the normal path turnId is set).
        const machineOpEvents = machineOpObserver.drainEvents();
        if (machineOpEvents.length > 0 && turnId && executionGeneration > 0) {
          await waitForTurnFinalizerStep(
            appendAndPublishTurnEventsFenced(
              db,
              bus,
              input.workspaceId,
              input.sessionId,
              turnId,
              executionGeneration,
              input.attemptId,
              machineOpEvents.map((event) => ({
                ...event,
                turnId: turnId ?? null,
              })),
            ).catch(() => undefined),
            finalizerSignal,
          );
        }
        // Multi-account P4: flush the serving account's free per-turn caches ONCE,
        // best-effort (same discipline as today's usage write). Both writers skip
        // version/updatedAt, so neither can race the token-refresh CAS.
        if (effectiveCodexCredentialId) {
          // Part A: the latest scraped usage-header snapshot → the P2 usage cache. A
          // full both-windows snapshot (parseCodexUsageHeaders gates on both), so this
          // is byte-identical to the /wham/usage write — no partial-window clobber.
          if (latestCodexUsage) {
            const usageMutation = await waitForTurnFinalizerStep(
              recordCodexAccountUsageWithWakeTargets(
                db,
                input.workspaceId,
                effectiveCodexCredentialId,
                latestCodexUsage,
              ).catch(() => null),
              finalizerSignal,
            );
            if (usageMutation) {
              await waitForTurnFinalizerStep(
                signalCodexCapacityWakeTargets(
                  { signalCodexCapacityWorkflow, wakeSessionWorkflow },
                  usageMutation.wakeTargets,
                ),
                finalizerSignal,
              );
            }
          }
          // Part B.1: the connector namespaces codex_apps listed this turn → the
          // connector-set cache. NON-EMPTY-only: a flaky/empty tools/list must never
          // overwrite a known set with [] (false coverage drop). Read by reference
          // AFTER the run, so every tools/list this turn has accumulated.
          const connectorNamespaces = preparedTools?.codexConnectorNamespaces;
          if (connectorNamespaces && connectorNamespaces.size > 0) {
            await waitForTurnFinalizerStep(
              recordCodexAccountConnectors(db, input.workspaceId, effectiveCodexCredentialId, [
                ...connectorNamespaces,
              ]).catch(() => undefined),
              finalizerSignal,
            );
          }
        }
        if (codexLeaseHeartbeatTimer) {
          clearInterval(codexLeaseHeartbeatTimer);
          codexLeaseHeartbeatTimer = undefined;
        }
        if (codexLeaseHeld && turnId && codexLeaseHolderId && codexLeaseGeneration !== null) {
          await waitForTurnFinalizerStep(
            releaseCodexCredentialLease(
              db,
              input.accountId,
              input.workspaceId,
              turnId,
              codexLeaseHolderId,
              codexLeaseGeneration,
            ).catch(() => undefined),
            finalizerSignal,
          );
          codexLeaseHeld = false;
        }
        // Workbench v2 turn-end workspace capture — runs FIRST in
        // the turn-end finally, while the box is MAXIMALLY ALIVE. The agent's last
        // tool ran before this finally, so /workspace is already final; capture is
        // FS-equivalent to the already-settled recording preparation and the warm
        // snapshot (neither mutates workspace files). Running it here — BEFORE
        // preparedTools.close() (which tears down tools / computer-use / the display
        // stack and is what starts the Modal box exiting a few seconds later) —
        // gives capture the full live-box margin instead of racing the teardown
        // tail, which was dropping 100% of captures on real Modal desktop boxes
        // ("request cancelled due to container exiting", 0 rows). External module:
        // self-capped at 60s, best-effort (never throws past its boundary),
        // epoch-fenced, and it NEVER closes the box. The emitted
        // workspace.revision.captured event is ANNOUNCE-ONLY (metadata, never
        // content).
        if (process.env.OPENGENI_TEST_SCENARIO === "sandbox") {
          console.log(
            `[sandbox-e2e] capture preflight ownership=${settings.sandboxOwnershipEnabled} enabled=${settings.workspaceCaptureEnabled} resolved=${Boolean(resolvedSandbox)} session=${Boolean(setupBoxSession)} group=${Boolean(sandboxGroupId)} storage=${Boolean(objectStorage)}`,
          );
        }
        const runTurnEndPersistence = shouldRunTurnEndWorkspacePersistence({
          activityStatus,
          cancellationRequested: finalizerSignal?.aborted === true,
        });
        if (
          runTurnEndPersistence &&
          turnId &&
          resolvedSandbox &&
          setupBoxSession &&
          sandboxGroupId
        ) {
          // Stop new heartbeat snapshot/meter ticks so a mid-turn snapshot cannot
          // start concurrently with capture, then drain any in-flight snapshot
          // (bounded) — capture and the warm snapshot both exec on the box, so
          // sequence them, exactly as the turn-end snapshot placement did.
          if (leaseHeartbeatTimer) {
            clearInterval(leaseHeartbeatTimer);
            leaseHeartbeatTimer = undefined;
          }
          if (snapshotInFlight) {
            await waitForWarmSnapshot(
              snapshotInFlight,
              settings.sandboxSnapshotTimeoutMs,
              finalizerSignal,
            );
          }
          await captureWorkspaceRevision({
            db,
            objectStorage,
            settings,
            publish: async (events) => {
              await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, events);
            },
            session: setupBoxSession as ChannelASession,
            leaseEpoch: resolvedSandbox.leaseEpoch,
            sandboxGroupId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            attemptId: input.attemptId,
            observability,
            ...(finalizerSignal ? { signal: finalizerSignal } : {}),
          });
        }
        if (preparedTools) {
          await waitForTurnFinalizerStep(
            preparedTools.close().catch(() => undefined),
            finalizerSignal,
          );
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        if (turnSandboxProvisioner?.hasStarted()) {
          await waitForTurnFinalizerStep(
            turnSandboxProvisioner.waitForSettled(30_000),
            finalizerSignal,
          );
        }
        // P1.2: stop the lease-TTL refresh, release the turn holder (idempotent
        // delete-my-row; refcount-- and warm->draining if it hit 0 with no turns),
        // and DROP the in-memory handle. Release NEVER stops the box — the reaper
        // (P1.3) issues the provider stop() past the drain grace at refcount 0; the
        // box rides the provider idle-timeout in the meantime. Best-effort: a
        // release failure must never mask the turn's real outcome.
        if (leaseHeartbeatTimer) {
          clearInterval(leaseHeartbeatTimer);
        }
        // A recording normally closes inside the attempt-fenced turn settlement.
        // Reaching finally with one still active means settlement threw, never ran,
        // or lost ownership. Stop ffmpeg and mark only this exact attempt-owned row
        // failed; publish no event and leave the artifact recoverable on the box.
        await waitForTurnFinalizerStep(
          abandonActiveRecording(
            "activity ended without recording settlement",
            didComputerUse ? "failed" : "discard",
          ),
          finalizerSignal,
        );
        if (resolvedSandbox) {
          // TURN-END mid-session snapshot (sandbox-file-persistence): fold the
          // turn's finished /workspace onto the lease before releasing the holder,
          // so the work this turn just produced survives any unclean box death in
          // the idle window ahead. Throttled by the same interval as the heartbeat
          // tick (a short turn right after a snapshot skips — bounded-loss contract
          // is the interval, not per-turn). Best-effort and time-capped by the
          // helper's own failure discipline; never delays release on failure.
          const settledTurnId = turnId;
          if (runTurnEndPersistence && setupBoxSession && sandboxGroupId && settledTurnId) {
            // Single-flight vs the heartbeat capture: the timer is already cleared
            // above, but a capture it launched may still be in flight — and that
            // capture predates the turn's final writes. Wait for it, but only up
            // to the snapshot timeout: release must never depend on an unbounded
            // provider capture.
            if (snapshotInFlight) {
              await waitForWarmSnapshot(
                snapshotInFlight,
                settings.sandboxSnapshotTimeoutMs,
                finalizerSignal,
              );
            }
            const persisted = await maybePersistWarmWorkspaceSnapshot(
              { db, settings },
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: settledTurnId,
                attemptId: input.attemptId,
                sandboxGroupId,
              },
              setupBoxSession,
              resolvedSandbox.leaseEpoch,
              finalizerSignal,
            );
            if (persisted && publish) {
              await publish([
                {
                  type: "sandbox.box.snapshot",
                  payload: { trigger: "turn-end" },
                },
              ]).catch(() => undefined);
            }
            // NB workspace capture no longer runs here — it moved to
            // the TOP of this finally (before preparedTools.close) so it completes
            // while the box is still solidly alive, instead of racing the turn-end
            // teardown that was killing 100% of captures on real Modal desktop boxes.
          }
          const sandboxToRelease = resolvedSandbox;
          resolvedSandbox = null; // drop ownership now; the exact-holder release may finish later
          await waitForTurnFinalizerStep(
            sandboxToRelease.release().catch((releaseError) => {
              console.error("sandbox lease release failed (turn outcome unaffected)", releaseError);
            }),
            finalizerSignal,
          );
        }
      } catch (error) {
        finalizationError ??= error;
        console.error("agent turn finalization failed (turn outcome unaffected)", error);
      } finally {
        cancellationSignal?.removeEventListener("abort", noteCancellationRequested);
        const completedAt = performance.now();
        const durationSeconds = (completedAt - activityStarted) / 1000;
        const finalizationDurationSeconds = (completedAt - finalizationStarted) / 1000;
        observability.observeHistogram({
          name: "opengeni_turn_finalization_duration_seconds",
          help: "Agent turn finalization duration, including workspace housekeeping and lease release.",
          labels: {
            cancellation_requested: String(cancellationRequestedAt !== null),
          },
          value: finalizationDurationSeconds,
        });
        if (cancellationRequestedAt !== null) {
          const physicalCancellationDurationSeconds =
            (completedAt - cancellationRequestedAt) / 1000;
          observability.observeHistogram({
            name: "opengeni_turn_physical_cancellation_duration_seconds",
            help: "Time from Temporal cancellation delivery until the activity physically stops.",
            value: physicalCancellationDurationSeconds,
          });
          observability.info("agent turn physical cancellation completed", {
            "opengeni.session_id": input.sessionId,
            "opengeni.turn_id": turnId ?? "",
            "opengeni.attempt_id": input.attemptId,
            "opengeni.physical_cancellation_duration_ms": Math.round(
              physicalCancellationDurationSeconds * 1000,
            ),
          });
        }
        observability.recordWorkerActivity({
          activity: "runAgentTurn",
          status: finalizationError ? "cleanup_failed" : activityStatus,
          durationSeconds,
        });
        if (turnId && activityStatus !== "unknown") {
          turnLifecycleMetricsFor(observability).finish(turnId, turnMetricOutcome, durationSeconds);
        }
        activitySpan.end({
          attributes: {
            "opengeni.turn_id": turnId ?? "",
            "opengeni.status": activityStatus,
            "opengeni.variable_set_id": variableSetId,
            "opengeni.rig_id": rigId,
            "opengeni.rig_version_id": rigVersionId,
            "opengeni.codex_credential_id": effectiveCodexCredentialId ?? "",
            "opengeni.duration_ms": Math.round(durationSeconds * 1000),
            "opengeni.finalization_duration_ms": Math.round(finalizationDurationSeconds * 1000),
          },
          error: finalizationError ?? activityError,
        });
        assertPhysicalToolQuiescenceForCancellation({
          acknowledgeQuiescence,
          physicalToolQuiescenceConfirmed,
          failure: finalizationError,
        });
        assertSessionAttemptQuiescenceRecoveryDurable({
          acknowledgeQuiescence,
          physicalToolQuiescenceConfirmed,
          receiptOrProofDurable: quiescenceReceiptOrProofDurable,
          failure: finalizationError,
        });
      }
    }
  };
}

async function assertGitHubResourcesRemainAuthorized(
  db: Parameters<typeof areGitHubRepositoriesAllowedForWorkspace>[0],
  workspaceId: string,
  resources: import("@opengeni/contracts").ResourceRef[],
): Promise<void> {
  // Must check exactly what sandboxEnvironmentForRun would mint a token for,
  // so the selection is derived from the same extraction as the mint path.
  for (const selection of gitHubTokenMintSelections(resources)) {
    await assertGitHubTokenMintSelectionAuthorized(
      db,
      workspaceId,
      selection.installationId,
      selection.repositoryIds,
    );
  }
}

async function assertGitHubTokenMintSelectionAuthorized(
  db: Parameters<typeof areGitHubRepositoriesAllowedForWorkspace>[0],
  workspaceId: string,
  installationId: number,
  repositoryIds: number[],
): Promise<void> {
  if (
    !(await areGitHubRepositoriesAllowedForWorkspace(
      db,
      workspaceId,
      installationId,
      repositoryIds,
    ))
  ) {
    throw new Error(
      "This workspace no longer authorizes one or more GitHub repositories attached to the session",
    );
  }
}

/**
 * True when the error is transient upstream backpressure — a model-provider 5xx,
 * a "server had a bad minute" body, or a dropped/again-able network connection —
 * rather than a request the session got wrong. These are safe to recover as a new
 * fenced attempt of the SAME turn after PROVIDER_BACKPRESSURE_DELAY_MS. Durable
 * tool results are preserved and ambiguous in-flight effects are closed before
 * the new attempt, independent of whether the session has an active goal.
 *
 * This is the classification gap that hard-failed a fleet of prod sessions during a
 * provider degradation window: their errors ("Our servers are currently overloaded",
 * the generic 500 "An error occurred while processing your request", "Connection
 * error") carried no retryable marker and fell through to a terminal session.failed.
 *
 * HTTP status is authoritative when present — EVERY 5xx is a server-side failure that
 * is safe to retry, while 4xx (validation, auth, 404) is a request fault that must
 * still hard-fail. The code/message matches are the fallback for network faults and
 * SDK-rethrown bare Errors that carry no status. A ChatGPT/Codex usage cap (a 429
 * that will NOT clear on retry) is classified and returned BEFORE this in
 * agentRunFailurePayload, so it never reaches here.
 */
export function isTransientProviderError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  // A real HTTP status is AUTHORITATIVE: a 5xx is transient, and ANY other status
  // (4xx validation/auth/404, plus the 429 the earlier branches already handled) is
  // a request fault that must NOT auto-retry — even if its body happens to read like
  // "connection error" or "overloaded". The code/message heuristics below apply ONLY
  // when no status survived: a network fault or an SDK-rethrown bare Error.
  if (status !== undefined && Number.isFinite(status)) {
    return status >= 500 && status < 600;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (code && /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE)$/i.test(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /overloaded|an error occurred while processing your request|connection error|service unavailable|bad gateway|gateway timeout/i.test(
    message,
  );
}

export function agentRunFailurePayload(error: unknown): {
  error: string;
  code?: string;
  retryable?: boolean;
  detail?: string;
  correlationId?: string;
  stage?: string;
  sqlState?: string | null;
  attempts?: number;
  retryOutcome?: string;
  database?: Record<string, string>;
} {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  // An accepted Codex stream with no terminal response is malformed/partial,
  // not provider backpressure. Replaying the same accepted turn could repeat
  // model or tool effects, so this marked transport failure must outrank the
  // generic 5xx retry classifier (CodexStreamingTerminalError uses status 502).
  if (isCodexTransportError(error) && code === "invalid_sse_terminal") {
    return {
      error: "The Codex response stream ended without a terminal response",
      code: "invalid_sse_terminal",
      retryable: false,
    };
  }
  if (isSessionEventPersistenceError(error)) {
    const { details } = error;
    const eventLabel = details.eventTypes.join(", ") || "session events";
    const failureLabel =
      details.code === "db_deadlock"
        ? "Database deadlock"
        : details.code === "db_serialization_failure"
          ? "Database serialization failure"
          : "Database failure";
    return {
      error: `${failureLabel} while persisting ${eventLabel}. The completed provider call and external effects were not retried.`,
      code: details.code,
      detail:
        details.retryOutcome === "exhausted"
          ? `The idempotent persistence transaction failed after ${details.attempts} attempts.`
          : "The database rejected the idempotent persistence transaction.",
      correlationId: details.correlationId,
      stage: details.stage,
      sqlState: details.sqlState,
      attempts: details.attempts,
      retryOutcome: details.retryOutcome,
      ...(Object.keys(details.database).length > 0 ? { database: details.database } : {}),
    };
  }
  // A ChatGPT/Codex usage cap is a HARD limit, not transient backpressure: it
  // must NOT be reported as a generic, retryable rate-limit (which would loop a
  // goal against a capped backend). Surface a precise, actionable message with
  // the humanized reset window and code, non-retryable. Checked BEFORE the
  // generic 429 branch below (a usage cap is also a 429).
  // This terminal payload classifier may receive a plain SDK-shaped error in
  // tests or after wrapper metadata was stripped. An explicit
  // `usage_limit_reached` shape must still outrank generic 429 retryability.
  // Credential quarantine/failover remains separately provenance-gated by
  // `isCodexTransportError`; this branch only chooses the truthful user payload.
  const usageLimit = classifyCodexUsageLimitError(error);
  if (usageLimit) {
    return codexUsageLimitFailurePayload(usageLimit, message);
  }
  const mcpTimeout = classifyMcpTransportTimeoutError(error);
  if (mcpTimeout) {
    return {
      error:
        "An MCP server request timed out. Any completed tool output was checkpointed; the session can continue safely.",
      code: "mcp_transport_timeout",
      retryable: true,
      ...(mcpTimeout.detail || mcpTimeout.message
        ? { detail: mcpTimeout.detail ?? mcpTimeout.message }
        : {}),
    };
  }
  if (
    status === 429 ||
    code === "rate_limit_exceeded" ||
    /(?:too many requests|rate.?limit|\b429\b)/i.test(message)
  ) {
    return {
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      ...(message && message !== "Too Many Requests" ? { detail: message } : {}),
    };
  }
  // Transient upstream backpressure (5xx / overloaded / dropped connection): keep
  // the provider's own message (it is already user-meaningful) but mark it
  // retryable so a goal-bearing session idles and auto-continues instead of going
  // terminal on a provider's bad minute. See isTransientProviderError.
  if (isTransientProviderError(error)) {
    return { error: message, code: "provider_unavailable", retryable: true };
  }
  return { error: message };
}

export type CodexCredentialFailure = {
  kind: "auth" | "forbidden" | "rate_limit" | "quota";
  cooldownSeconds: number | null;
};

export const CODEX_ALLOWANCE_FALLBACK_MS = 5 * 60 * 60_000;

/**
 * Resolve a deterministic quarantine end. Generic request throttling honors
 * provider retry-after (or one minute); allowance/quota refusal waits for the
 * LAST of provider reset and every still-binding cached window (five-hour and
 * weekly both bind), falling back to one complete five-hour window when no reset
 * metadata exists.
 */
export function codexCredentialCooldownUntil(
  failure: CodexCredentialFailure,
  account: Pick<
    CodexAccountStatus,
    "primaryUsedPercent" | "primaryResetAt" | "secondaryUsedPercent" | "secondaryResetAt"
  > | null,
  now: Date,
): Date | null {
  if (failure.kind === "auth" || failure.kind === "forbidden") {
    return null;
  }
  const providerReset =
    failure.cooldownSeconds !== null &&
    Number.isFinite(failure.cooldownSeconds) &&
    failure.cooldownSeconds > 0
      ? new Date(now.getTime() + Math.ceil(failure.cooldownSeconds) * 1000)
      : null;
  if (failure.kind === "rate_limit") {
    return providerReset ?? new Date(now.getTime() + PROVIDER_BACKPRESSURE_DELAY_MS);
  }
  const blockingResets = account
    ? [
        { used: account.primaryUsedPercent, reset: account.primaryResetAt },
        { used: account.secondaryUsedPercent, reset: account.secondaryResetAt },
      ]
        .filter(
          (window): window is { used: number; reset: Date } =>
            (window.used ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT &&
            window.reset instanceof Date &&
            window.reset.getTime() > now.getTime(),
        )
        .map((window) => window.reset)
    : [];
  const quotaResets = providerReset ? [...blockingResets, providerReset] : blockingResets;
  if (quotaResets.length === 0) {
    return new Date(now.getTime() + CODEX_ALLOWANCE_FALLBACK_MS);
  }
  return quotaResets.reduce((latest, reset) =>
    reset.getTime() > latest.getTime() ? reset : latest,
  );
}

/**
 * Only definitive credential/account refusals are safe rotation signals.
 * Ambiguous network failures, malformed/partial streams, invalid model content,
 * prompt 4xx, and provider 5xx may already have consumed tokens or persisted
 * progress and therefore MUST NOT walk the credential pool automatically.
 */
export function classifyCodexCredentialFailure(error: unknown): CodexCredentialFailure | null {
  // A permanent OAuth refresh failure is definitive and the shared resolver has
  // already fenced/stamped the exact credential version. The OpenAI client can
  // wrap a rejection from its custom fetch in APIConnectionError, so recognize
  // the typed exception through the same bounded cause chain used below.
  let refreshError: unknown = error;
  for (let depth = 0; depth < 6 && refreshError && typeof refreshError === "object"; depth += 1) {
    if (refreshError instanceof CodexReloginRequired) {
      return { kind: "auth", cooldownSeconds: null };
    }
    refreshError = (refreshError as Record<string, unknown>).cause;
  }
  // The activity catch also receives sandbox, MCP, storage, and tool failures.
  // Their HTTP status codes are not Codex account state and must never walk the
  // subscription pool or replay a tool on another credential.
  if (!isCodexTransportError(error)) {
    return null;
  }
  const usageLimit = classifyCodexUsageLimitError(error);
  if (usageLimit) {
    return { kind: "quota", cooldownSeconds: usageLimit.resetsInSeconds };
  }
  let cur: unknown = error;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const value = cur as Record<string, unknown>;
    const body =
      value.error && typeof value.error === "object"
        ? (value.error as Record<string, unknown>)
        : null;
    const status = Number(value.status ?? body?.status);
    const code = String(value.code ?? body?.code ?? "").toLowerCase();
    const directRetryAfter = Number(
      value.retry_after_seconds ?? body?.retry_after_seconds ?? value.retryAfterSeconds,
    );
    const headers = value.headers as { get?: (name: string) => string | null } | undefined;
    const retryAfterHeader = headers?.get?.("retry-after") ?? null;
    const retryAfterNumber = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    const retryAfterDate =
      retryAfterHeader !== null && !Number.isFinite(retryAfterNumber)
        ? Date.parse(retryAfterHeader)
        : Number.NaN;
    const retryAfter = Number.isFinite(directRetryAfter)
      ? directRetryAfter
      : Number.isFinite(retryAfterNumber)
        ? retryAfterNumber
        : Number.isFinite(retryAfterDate)
          ? Math.max(0, (retryAfterDate - Date.now()) / 1000)
          : Number.NaN;
    const cooldownSeconds =
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null;
    // Provider quota codes are more specific than their HTTP transport status.
    // A permanent allowance refusal commonly arrives as HTTP 429; classify it
    // before generic backpressure so it receives the binding-window cooldown.
    if (
      code === "insufficient_quota" ||
      code === "quota_exceeded" ||
      code === "billing_hard_limit_reached"
    ) {
      return { kind: "quota", cooldownSeconds };
    }
    if (status === 401 || code === "unauthorized" || code === "invalid_api_key") {
      return { kind: "auth", cooldownSeconds };
    }
    if (status === 403) {
      return { kind: "forbidden", cooldownSeconds };
    }
    if (status === 429 || code === "rate_limit_exceeded" || code === "too_many_requests") {
      return { kind: "rate_limit", cooldownSeconds };
    }
    cur = value.cause;
  }
  return null;
}

/** Humanize a seconds duration into a short "2h 5m" / "9m" / "in under a minute" string. */
export function humanizeResetWindow(resetsInSeconds: number | null): string {
  if (resetsInSeconds === null || !Number.isFinite(resetsInSeconds) || resetsInSeconds <= 0) {
    return "shortly";
  }
  const total = Math.ceil(resetsInSeconds);
  if (total < 60) {
    return "in under a minute";
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) {
    return minutes > 0 ? `in about ${hours}h ${minutes}m` : `in about ${hours}h`;
  }
  return `in about ${minutes}m`;
}

/**
 * Build the turn.failed payload for a ChatGPT/Codex usage cap: a precise,
 * actionable message naming the reset window, the stable `codex_usage_limit_reached`
 * code, and retryable:false (an auto-retry would just re-hit the cap).
 */
export function codexUsageLimitFailurePayload(
  info: { resetsInSeconds: number | null },
  detail: string,
  opts?: { allAccounts?: boolean },
): { error: string; code: string; retryable: boolean; detail?: string } {
  // P3: when EVERY connected subscription is rate-limited the message names the
  // earliest reset across accounts; the single-account message is unchanged.
  const error = opts?.allAccounts
    ? `All connected ChatGPT/Codex subscriptions are rate-limited. Access returns ${humanizeResetWindow(info.resetsInSeconds)}. ` +
      `You can switch this session to a different model in the meantime, or wait for a subscription to reset.`
    : `Your ChatGPT/Codex subscription usage limit has been reached. Access resets ${humanizeResetWindow(info.resetsInSeconds)}. ` +
      `You can switch this session to a different model in the meantime, or wait for the limit to reset.`;
  return {
    error,
    code: "codex_usage_limit_reached",
    retryable: false,
    ...(detail ? { detail } : {}),
  };
}

// A usage cap that won't reset for a long time should not pin a Temporal timer
// open indefinitely for a goal-bearing session; cap the continuation hold so the
// goal re-evaluates at most this far out (it will re-pause if still capped).
const CODEX_USAGE_LIMIT_MAX_RESUME_MS = 60 * 60_000; // 1h

function pendingToolCallFromSdkEvent(event: unknown): {
  callId: string;
  callType: string;
  callItem: Record<string, unknown>;
} | null {
  if (!event || typeof event !== "object") return null;
  if ((event as { type?: unknown }).type !== "run_item_stream_event") return null;
  const item = (event as { item?: { type?: unknown; rawItem?: unknown } }).item;
  if (
    !item ||
    (item.type !== "tool_call_item" && item.type !== "tool_search_call_item") ||
    !item.rawItem ||
    typeof item.rawItem !== "object" ||
    Array.isArray(item.rawItem)
  ) {
    return null;
  }
  const raw = item.rawItem as Record<string, unknown>;
  const callId = raw.callId ?? raw.call_id ?? raw.id;
  const callType = raw.type;
  if (typeof callId !== "string" || callId.length === 0 || typeof callType !== "string") {
    return null;
  }
  return { callId, callType, callItem: raw };
}

function completedToolCallFromSdkEvent(event: unknown): {
  callId: string;
  resultItem: Record<string, unknown>;
} | null {
  if (!event || typeof event !== "object") return null;
  if ((event as { type?: unknown }).type !== "run_item_stream_event") return null;
  const item = (event as { item?: { type?: unknown; rawItem?: unknown; id?: unknown } }).item;
  if (!item || (item.type !== "tool_call_output_item" && item.type !== "tool_search_output_item")) {
    return null;
  }
  const raw =
    item.rawItem && typeof item.rawItem === "object" && !Array.isArray(item.rawItem)
      ? (item.rawItem as Record<string, unknown>)
      : {};
  const callId = raw.callId ?? raw.call_id ?? item.id;
  return typeof callId === "string" && callId.length > 0 ? { callId, resultItem: raw } : null;
}

/**
 * Budget/limit exhaustion detected between model calls. This is account
 * state, not an agent failure: the segment ends gracefully (session idles,
 * run state preserved) so a top-up or limit reset lets the same session
 * continue — a failed session would reject the user's next message. An
 * active goal pauses visibly (reason "limits") at the next continuation
 * evaluation without consuming continuation budget.
 */
class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    readonly serializedRunState: string | null,
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

// Exported for unit testing the codex-billed bypass (codex-billing.test.ts); not part
// of the activity surface. Takes BOTH `isCodexTurn` (codex-plan turns bypass the credit
// and token gates) and the optional §7.5 P3 host `entitlements` port (when bound, its
// `admitRun` REPLACES the local credit read for a non-codex turn; unset → local ledger).
export async function ensureRunAllowed(
  settings: Settings,
  db: ActivityServices["db"],
  accountId: string,
  workspaceId: string,
  isCodexTurn: boolean,
  entitlements?: ActivityServices["entitlements"],
): Promise<void> {
  // Codex-billed turns are paid by the user's ChatGPT/Codex plan: skip the
  // credit-balance gate and the monthly token cap. The agent-run COUNT cap below
  // is a volume/fairness quota (not a credit/cost gate) and is intentionally kept.
  //
  // §7.5 P3 — host-entitlements DELEGATION (the worker half of the same seam the
  // API edge exposes). For a non-codex turn, when the host binds `entitlements`, its
  // `admitRun` decision REPLACES the local credit-balance read below: a host that owns
  // its ledger/meter is the funding authority. A deny throws the SAME Error the local
  // read throws, so the mid-stream budget-valve at :727 wraps it in a
  // `BudgetExhaustedError` and pauses identically — the valve never learns whether the
  // deny came from the local ledger or the host meter.
  //
  // This is an admission READ only; it records NO usage (metering stays the sole,
  // idempotency-keyed writer at recordModelUsageAndDebitCredits), so a PULL host meter
  // is consulted without ever double-charging.
  if (
    !isCodexTurn &&
    entitlements &&
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")
  ) {
    const decision = await entitlements.admitRun({
      accountId,
      workspaceId,
      action: "agent_run:create",
      quantity: 1,
    });
    if (!decision.allowed) {
      throw new Error(decision.reason || "insufficient OpenGeni credits");
    }
  } else if (
    !isCodexTurn &&
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")
  ) {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      throw new Error("insufficient OpenGeni credits");
    }
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    if (limits.maxMonthlyAgentRunsPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "agent_run.created",
        since: startOfUtcMonth(),
      });
      // Agent turns are admitted and recorded before this worker activity starts.
      // Equality means this accepted turn is exactly at the cap; greater-than is
      // the race/backstop case where another admission already exceeded the cap.
      if (used > limits.maxMonthlyAgentRunsPerWorkspace) {
        throw new Error(
          `monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`,
        );
      }
    }
    if (!isCodexTurn && limits.maxMonthlyTokensPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "model.tokens",
        since: startOfUtcMonth(),
      });
      if (used >= limits.maxMonthlyTokensPerWorkspace) {
        throw new Error(`monthly token limit reached (${limits.maxMonthlyTokensPerWorkspace})`);
      }
    }
  }
}

// Exported for unit testing the codex-billed bypass; not part of the activity surface.
export async function recordModelUsageAndDebitCredits(
  settings: Settings,
  db: ActivityServices["db"],
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    turnAttemptId: string;
    model: string;
    isCodexTurn: boolean;
    usage?: ModelUsageInput | null;
    sourceKey: string;
    observability?: ActivityServices["observability"];
  },
): Promise<void> {
  if (!input.usage) {
    return;
  }
  const inputTokens = positiveInt(input.usage.inputTokens);
  const outputTokens = positiveInt(input.usage.outputTokens);
  const totalTokens = positiveInt(input.usage.totalTokens) || inputTokens + outputTokens;
  // A codex-subscription turn is paid by the user's ChatGPT/Codex plan, so it
  // consumes ZERO OpenGeni credits and must never feed an OpenGeni cap. A
  // codex/<slug> model has no entry in configuredModelPricing, so the normal path
  // below would throw "Missing model pricing". We:
  //   - do NOT emit the cap-feeding `model.tokens` event (ensureRunAllowed and
  //     the API tokens:consume cap sum `model.tokens` with NO cost dimension, so
  //     any row would count against maxMonthlyTokensPerWorkspace);
  //   - record a `model.cost = 0` audit marker (harmless to the monthly cost cap);
  //   - never look up pricing and never debit credits.
  if (input.isCodexTurn) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.cost",
      quantity: 0,
      unit: "usd_micros",
      sourceResourceType: "model_response",
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      idempotencyKey: `usage:model.cost:${input.turnId}:${input.sourceKey}`,
    });
    return;
  }
  if (totalTokens > 0) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.tokens",
      quantity: totalTokens,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      idempotencyKey: `usage:model.tokens:${input.turnId}:${input.sourceKey}`,
    });
  }
  const shouldDebit = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  if (!shouldDebit || totalTokens === 0) {
    return;
  }
  if (!configuredModelPricing(settings)[input.model]) {
    throw new Error(`Missing model pricing for ${input.model}`);
  }
  const costMicros = calculateModelUsageCostMicros(settings, input.model, input.usage);
  await recordUsageEvent(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: "model.cost",
    quantity: costMicros,
    unit: "usd_micros",
    sourceResourceType: "model_response",
    sourceResourceId: `${input.turnId}:${input.sourceKey}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    turnAttemptId: input.turnAttemptId,
    idempotencyKey: `usage:model.cost:${input.turnId}:${input.sourceKey}`,
  });
  if (costMicros > 0) {
    const result = await applyCreditDebitUpToBalance(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: "model_usage_debit",
      requestedAmountMicros: costMicros,
      sourceType: "model_response",
      sourceId: `${input.turnId}:${input.sourceKey}`,
      idempotencyKey: `credit:model_usage_debit:${input.turnId}:${input.sourceKey}`,
      metadata: {
        model: input.model,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sourceKey: input.sourceKey,
        inputTokens,
        outputTokens,
        totalTokens,
        // Additive: the prompt-cache slice of this call's input tokens, so the
        // per-call debit record carries cache efficiency alongside the token
        // counts. 0 when the provider did not report cached tokens.
        cachedTokens: positiveInt(
          modelCallUsageTelemetry(input.usage as Parameters<typeof modelCallUsageTelemetry>[0])
            .cachedTokens,
        ),
      },
    });
    recordCreditMicros(input.observability, "usage", result.debitedMicros);
  }
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function sandboxFileDownloadsForRun(
  settings: Settings,
  db: ActivityServices["db"],
  objectStorage: ObjectStorage | null,
  workspaceId: string,
  resources: ResourceRef[],
): Promise<SandboxFileDownload[]> {
  if (settings.sandboxBackend === "none" || !requiresSignedFileResourceDownloads(settings)) {
    return [];
  }
  const fileResources = resources.filter(
    (resource): resource is Extract<ResourceRef, { kind: "file" }> => resource.kind === "file",
  );
  if (fileResources.length === 0) {
    return [];
  }
  if (!objectStorage) {
    throw new Error(
      `${settings.objectStorageBackend} file resources require configured object storage`,
    );
  }
  const downloadStorage = objectStorageForSandboxDownloads(settings, objectStorage);
  const downloads: SandboxFileDownload[] = [];
  for (const resource of fileResources) {
    const file = await requireFile(db, workspaceId, resource.fileId);
    const url = await downloadStorage.createGetUrl({ key: file.objectKey });
    downloads.push({
      fileId: file.id,
      mountPath: resource.mountPath ?? `files/${file.id}`,
      filename: file.safeFilename,
      url: url.url,
      expiresAt: url.expiresAt,
      sizeBytes: file.sizeBytes,
    });
  }
  return downloads;
}

function requiresSignedFileResourceDownloads(settings: Settings): boolean {
  // A selfhosted machine (bring-your-own-compute) can NEVER mount ANY object store
  // — it is a remote user machine reached only over NATS, so file resources are
  // ALWAYS delivered by exec-curling a pre-signed URL onto it. Without this a
  // machine-home turn (sandbox_backend "selfhosted") would silently drop file
  // resources on an azure-blob / s3-compatible store (nativeBucketMount=false),
  // a regression from the pre-honest-label path where the same turn ran home=modal
  // and modal's descriptor forced signed downloads.
  if (settings.sandboxBackend === "selfhosted") {
    return true;
  }
  // A nativeBucketMount backend (modal) cannot mount Azure Blob entries, so it
  // needs pre-signed downloads for that store. Keying on the descriptor (not the
  // "modal" literal) keeps this correct as bucket-mount backends are added.
  const nativeBucketMount = CAPABILITY_DESCRIPTORS[settings.sandboxBackend].nativeBucketMount;
  return (
    (settings.sandboxBackend === "docker" && settings.objectStorageBackend === "s3-compatible") ||
    settings.objectStorageBackend === "aws-s3" ||
    settings.objectStorageBackend === "gcs" ||
    (nativeBucketMount && settings.objectStorageBackend === "azure-blob")
  );
}

function objectStorageForSandboxDownloads(
  settings: Settings,
  objectStorage: ObjectStorage,
): ObjectStorage {
  if (settings.objectStorageBackend !== "s3-compatible" || !settings.objectStorageSandboxEndpoint) {
    return objectStorage;
  }
  return (
    createObjectStorage({
      ...settings,
      objectStorageEndpoint: settings.objectStorageSandboxEndpoint,
    }) ?? objectStorage
  );
}
