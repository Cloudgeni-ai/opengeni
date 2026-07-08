import {
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  createTurn,
  applyCreditDebitUpToBalance,
  finishTurn,
  getBillingBalance,
  getRigVersion,
  getSandbox,
  readActiveSandbox,
  requireFile,
  getSessionEvent,
  getSessionGoal,
  getSessionTurn,
  isCodexBilledTurn,
  workspaceCodexSubscriptionActive,
  getCodexRotationSettings,
  listCodexAccountStatuses,
  fetchCodexUsageForAccount,
  getSessionCodexState,
  recordSessionActiveCodexCredential,
  recordCodexAccountUsage,
  recordCodexAccountConnectors,
  resolveWorkspaceMemoryBlock,
  setActiveCodexCredential,
  setCodexCredentialExhausted,
  countConsecutiveReactiveRotations,
  requireSession,
  recordUsageEvent,
  appendSessionHistoryItems,
  consumeSessionCompactionRequest,
  countSessionHistoryItems,
  getActiveSessionHistoryItems,
  nextSessionHistoryPosition,
  requeuePreemptedTurn,
  saveRunState,
  upsertSandboxSessionEnvelope,
  setSessionStatus,
  setSessionLastInputTokens,
  sumUsageQuantity,
  heartbeatLeaseHolder,
  accrueWarmSeconds,
  getMaterializedSandboxFileResources,
  markSandboxFileResourcesMaterialized,
  SandboxLeaseSupersededError,
  buildConnectionTokenResolver,
  type AppendEventInput,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import {
  sandboxStateEntryFromRunState,
  agentsErrorRunState,
  maxTurnsExceededRunState,
  modelCallUsageTelemetry,
  modelResponseUsageFromSdkEvent,
  normalizeSdkEvent,
  sanitizeHistoryItemsForModel,
  summarizeForCompaction,
  ensureModalRegistryImage,
  findCompactionNeededError,
  materializeSandboxFileDownloads,
  sandboxFileDownloadFailureNote,
  SUMMARY_BUFFER_TOKENS,
  type SandboxFileDownload,
  type SandboxFileDownloadFailure,
  type OpenGeniRuntime,
  type ComputerToolMode,
  type ModelResponseUsage,
} from "@opengeni/runtime";
import { calculateModelUsageCostMicros, configuredModelPricing, configuredStaticUsageLimits, sandboxWarmRateMicrosPerSecond, type ModelUsageInput, type ModelProviderApi, type RegistryProviderKind, type Settings } from "@opengeni/config";
import { CancelledFailure } from "@temporalio/activity";
import { settingsWithCodexCredential, settingsWithEnabledCapabilityMcpServers, settingsWithSessionMcpServersForRun } from "./capabilities";
import { chooseRotationActive, computeIdleDelayMs, computeReactiveRotationResume, type CodexRotationStrategy, type RotationDecision } from "./codex-rotation";
import type { CodexAccountStatus } from "@opengeni/db";
import { buildCodexTokenResolver } from "./codex-auth";
import {
  buildModelResolver,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  classifyCodexUsageLimitError,
  codexRequestStorage,
  type CodexRequestContext,
  type CodexUsageHeaderSnapshot,
} from "@opengeni/codex";
import {
  mergeResourceRefs,
  mergeToolRefs,
} from "./common";
import { maybeCompactContext } from "./context-compaction";
import { loadWorkspaceEnvironmentForRunWithCredentials, sandboxEnvironmentForRun } from "./environment";
import { withCodexAppsTool, withFirstPartyTools } from "./goals";
import { resolveWorkspaceAgentInstructions, resolveWorkspacePackRuntime, settingsWithPackSandboxImage, settingsWithRigImage } from "./packs";
import { notifyParentOfChildTerminal } from "./parent-wake";
import { createSecretRedactor, identityRedactor } from "./redaction";
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
} from "./types";
import { resumeBoxForTurn, acquireSelfhostedLeaseForTurn, maybePersistWarmWorkspaceSnapshot, type ResumedTurnSandbox } from "../sandbox-resume";
import { wrapTurnBoxWithRouting, establishSelfhostedTurnSession, routingEnabled } from "../sandbox-routing";
import { recordCreditMicros, runtimeMetricsHooksForObservability, turnLifecycleMetricsFor, type TurnOutcome } from "../observability-metrics";
import { beginRecording, discardRecording, finalizeRecording, type ActiveRecording } from "./recording";
import { createObjectStorage, type ObjectStorage } from "@opengeni/storage";
import { desktopCapableBackend, sandboxRunAs } from "@opengeni/runtime";
import { CAPABILITY_DESCRIPTORS, type ResourceRef } from "@opengeni/contracts";
import { randomUUID } from "node:crypto";

// How long the session workflow holds the loop after a retryable provider
// failure before the goal continuation re-enters the model. Azure/OpenAI TPM
// throttling is minute-granular; anything shorter mostly burns continuation
// budget against the same window.
export const PROVIDER_BACKPRESSURE_DELAY_MS = 60_000;

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

// Resume notice fed to the model when a turn re-enters after a graceful
// worker shutdown (deploy/rollout restart) checkpointed it mid-flight. The
// agent must not blindly replay side effects it cannot see in its history:
// at most the single in-flight model step was lost, and anything it started
// there may or may not have completed.
// Resume notice after an in-turn context-window overflow was recovered by
// compaction: the turn's earlier work survives (albeit summarized), so the
// agent continues instead of the session dying or stalling idle.
export const CONTEXT_OVERFLOW_RESUME_TEXT = [
  "[TURN RESUMED AFTER CONTEXT COMPACTION] The conversation approached or exceeded the model's context window mid-turn; older history above was compacted into a summary.",
  "Continue the original task from where it left off. Before repeating any action with side effects, check whether it already happened.",
].join("\n");

export const WORKER_SHUTDOWN_RESUME_TEXT = [
  "[TURN RESUMED AFTER WORKER RESTART] The platform worker running this turn restarted (deploy/rollout) before the turn finished.",
  "Your conversation history above, including this turn's earlier work, is preserved up to the last checkpoint; at most the single in-flight model step after it was lost.",
  "Continue the original task from where it left off. Before repeating any action with side effects, check whether it already happened.",
].join("\n");

// Resume notice for the harder variant: the worker died WITHOUT running the
// graceful checkpoint (SIGKILL, OOM, node loss — surfaced to the workflow as
// a heartbeat-timeout activity failure). Conversation truth is still
// dual-written after every model response, so the bound is the same order as
// a graceful preempt, but nothing after the last reconcile was captured and
// the agent must be even more suspicious about repeated side effects.
export const WORKER_DEATH_RESUME_TEXT = [
  "[TURN RESUMED AFTER WORKER CRASH] The platform worker running this turn died before the turn finished.",
  "Your conversation history above, including this turn's earlier work, is preserved up to the last checkpoint; anything in flight after that checkpoint was lost.",
  "Continue the original task from where it left off. Before repeating any action with side effects, check whether it already happened.",
].join("\n");

/**
 * True when this activity attempt was cancelled because its hosting worker is
 * shutting down gracefully (SIGTERM during a deploy), as opposed to a
 * workflow-requested cancellation (user interrupt) or a server-side timeout.
 */
export function isWorkerShutdownCancellation(error: unknown): boolean {
  return error instanceof CancelledFailure && error.message === "WORKER_SHUTDOWN";
}

export const CONTEXT_WINDOW_OVERFLOW_RECOVERY_MESSAGE =
  "The conversation reached the model context compaction threshold; it has been compacted. Send a message to continue.";
const MAX_CONTEXT_COMPACTION_RECOVERY_ATTEMPTS = 3;

function compactionFailureReason(reason: string): string {
  return reason.startsWith("compaction summarization failed:")
    ? reason
    : `compaction summarization failed: ${reason}`;
}

export function classifyContextWindowOverflowError(error: unknown): { message: string; code?: string; detail?: string } | null {
  const fields = collectErrorStrings(error);
  const matched = fields.find((value) =>
    /context[_\s-]*length[_\s-]*exceeded/i.test(value)
    || /exceeds?\s+(?:the\s+)?context\s+window/i.test(value)
    || /maximum\s+context\s+length/i.test(value)
    || /context\s+window[^.]*exceed/i.test(value)
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
 * shared across a re-dispatch of the SAME turn (preemption resume, approval
 * rerun, activity retry), so the sourceKey alone must distinguish calls.
 *
 * - A provider responseId is globally stable+unique, so reuse it verbatim: a
 *   true activity retry that re-emits the same responseId correctly DEDUPES
 *   (one charge), while two distinct calls get distinct ids.
 * - Without a responseId the only fallback was POSITIONAL ("response-1",
 *   "aggregate"), which collides across a re-dispatch — dispatch B's first
 *   call reuses dispatch A's "response-1" key and its charge is silently
 *   dropped (undercharge). Qualifying the positional fallback with the
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

type TurnEventPublisher = (events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>, immediate?: boolean) => Promise<void>;

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
}): Promise<void> {
  const usage = input.usage && typeof input.usage === "object" && "usage" in input.usage
    ? (input.usage as { usage?: unknown }).usage
    : null;
  if (!usage || typeof usage !== "object") {
    return;
  }
  const telemetry = modelCallUsageTelemetry(usage as Parameters<typeof modelCallUsageTelemetry>[0]);
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
    });
  } catch {
    // Usage observability is best-effort.
  }
  try {
    await input.publish?.([
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
    ], true);
  } catch (error) {
    input.observability.warn("model call usage event publish failed", {
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceKey: input.sourceKey,
      error: error instanceof Error ? error.message : String(error),
    });
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
): { rows: Array<{ position: number; item: Record<string, unknown> }>; nextWatermark: number; nextPosition: number } {
  const sanitized = sanitizeHistoryItemsForModel(rawHistory);
  if (sanitized.length <= persistedHistoryCount) {
    return { rows: [], nextWatermark: persistedHistoryCount, nextPosition };
  }
  const rows = sanitized.slice(persistedHistoryCount).map((item, offset) => ({
    position: nextPosition + offset,
    item: item as Record<string, unknown>,
  }));
  return { rows, nextWatermark: sanitized.length, nextPosition: nextPosition + rows.length };
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
 *  - run-state BLOB path (`modelHistoryFromItems === false`: approval resume, the
 *    items-mode run-state fallback, run_state mode) — `state.history` was seeded
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
  activeSeedRows: ReadonlyArray<{ item: Record<string, unknown>; producerCodexCredentialId: string | null }>,
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
    console.error("active sandbox backend resolution failed (turn proceeds on home backend)", error);
    return undefined;
  }
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
 * Decide whether to start on-turn desktop recording for THIS turn.
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
 * EDGE — mid-turn swap: this is evaluated ONCE at turn start (the box is only filmed
 * for the duration of one turn). A swap AFTER the recording starts is deliberately
 * ignored — a partial-turn recording already has defined failure semantics, so we do
 * not add machinery to stop/restart it mid-turn.
 */
export function shouldStartOnTurnRecording(params: {
  recordingEnabled: boolean;
  desktopEnabled: boolean;
  establishedBackendId: string;
  effectiveBackend: Settings["sandboxBackend"] | undefined;
}): boolean {
  return (
    params.recordingEnabled
    && params.desktopEnabled
    && desktopCapableBackend(params.establishedBackendId)
    && params.effectiveBackend !== "selfhosted"
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
  resolvedModel: { provider: { kind: RegistryProviderKind; api: ModelProviderApi } } | null,
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
  resolvedModel: { provider: { kind: RegistryProviderKind; builtin?: boolean } } | null,
): boolean {
  if (!resolvedModel) {
    return true;
  }
  return resolvedModel.provider.builtin === true || resolvedModel.provider.kind === "codex-subscription";
}

/**
 * SELF-HEAL helper for the all-capped rotation idle (invariant 4: BOUNDED, no thrash).
 * The turn hot path never refreshes Codex usage — only the usage API route does — so a
 * window that has actually reset still reads OVER-threshold from the stale cache, which
 * would idle-loop forever. Before idling, refresh LIVE usage for every connected account
 * the cache marks over-threshold (bounded to the account count), which re-writes the
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
): Promise<CodexAccountStatus[]> {
  const nearPct = settings.codexRotationNearExhaustionPct;
  const stale = accounts.filter(
    (a) => a.status === "active" && ((a.primaryUsedPercent ?? 0) >= nearPct || (a.secondaryUsedPercent ?? 0) >= nearPct),
  );
  if (stale.length === 0) {
    return accounts;
  }
  await Promise.all(stale.map((a) => fetchCodexUsageForAccount(db, settings, workspaceId, a.id).catch(() => undefined)));
  return listCodexAccountStatuses(db, workspaceId).catch(() => accounts);
}

export function createRunAgentTurnActivity(services: () => Promise<ActivityServices>) {
  return async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const { settings, db, bus, runtime, objectStorage, observability, wakeSessionWorkflow, entitlements, connectionCredentials } = await services();
    const activityStarted = performance.now();
    const activitySpan = observability.startSpan("worker.run_agent_segment", {
      "opengeni.session_id": input.sessionId,
      "opengeni.workflow_id": input.workflowId,
      "opengeni.trigger_event_id": input.triggerEventId,
    });
    let activityStatus: RunAgentTurnResult["status"] | "unknown" = "unknown";
    let turnMetricOutcome: TurnOutcome | null = null;
    let activityError: unknown;
    let turnId: string | undefined;
    let heartbeatTimer: ReturnType<typeof startActivityHeartbeat> | undefined;
    // P1.2 ownership inversion: when sandboxOwnershipEnabled, the turn resolves
    // the one box by id from the group lease and injects it NON-OWNED into the
    // run. null when the flag is off (byte-for-byte the legacy build-and-discard
    // path) OR when the backend is "none". Released + dropped in `finally`.
    let resolvedSandbox: ResumedTurnSandbox | null = null;
    // The UN-PROXIED established box session, captured BEFORE wrapTurnBoxWithRouting.
    // Platform setup (beforeAgentStart hooks + file materialization) execs against
    // THIS handle so a mid-turn sandbox_swap can never re-route those execs onto a
    // connected machine (the user's real computer).
    let setupBoxSession: unknown = null;
    // The lease holder id (Temporal activityId, unique per scheduled execution)
    // + the group id, captured so the lease heartbeat can refresh the lease TTL
    // epoch-fenced (a superseded owner self-evicts) and finally can release.
    let sandboxHolderId: string | null = null;
    let sandboxGroupId: string | null = null;
    // Lease-TTL refresh timer (parallels the activity heartbeat): while the turn
    // runs it refreshes expires_at epoch-fenced so a legit multi-day turn is
    // never TTL-reaped. Cleared in finally. Only set when the flag resolved a box.
    let leaseHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
    // MID-SESSION snapshot single-flight guard: the heartbeat tick fires every
    // 10s but a Modal filesystem snapshot can take longer — never overlap two
    // captures on one box. The in-flight capture's promise is held so the
    // turn-end persist can await it (its capture predates the turn's final
    // writes; landing after the fresher turn-end capture started would make
    // the atomic DB throttle discard the fresher one). Interval throttling
    // itself lives in maybePersistWarmWorkspaceSnapshot / persistWarmSnapshot.
    let snapshotInFlight: Promise<void> | null = null;
    // P4.3 on-turn recording: when the desktop tier + recording are enabled and
    // the box is desktop-capable, the turn films the SAME :0 the agent's
    // computer-use drives, finalized to storage in this activity's `finally`
    // (read+PUT in-process — never a Temporal payload, F10). null otherwise.
    let activeRecording: ActiveRecording | null = null;
    // P4.3 recording gate: flips true the first time a computer-use/desktop tool
    // ACTUALLY executes this turn (an SDK `computer_call` item streams through). A
    // plain text turn ("hey"/"continue") never flips it, so finalize discards the
    // recording with NO storage PUT and NO recording.failed — a clean no-op (a
    // static frame of an untouched desktop is not worth uploading).
    let didComputerUse = false;
    let batcher: ReturnType<typeof createRuntimeBatcher> | null = null;
    const flushRuntimeBatcher = async () => {
      const current = batcher as ReturnType<typeof createRuntimeBatcher> | null;
      await current?.flush().catch(() => undefined);
    };
    let preparedTools: Awaited<ReturnType<OpenGeniRuntime["prepareTools"]>> | null = null;
    let publish: ((events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>, immediate?: boolean) => Promise<void>) | null = null;
    let turnStartedPublished = false;
    let stream: Awaited<ReturnType<OpenGeniRuntime["runStream"]>> | undefined;
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
    // it by sanitizing the current history into an API-valid sequence (the same
    // pure function the read path uses) before persisting: a dangling call is
    // never persisted (it is deferred until its result exists, when the pair is
    // written together at consecutive positions), and a result is never
    // persisted without its preceding call. The watermark counts only items we
    // actually persisted, so a non-monotonic history can never desync it.
    let persistedHistoryCount = 0;
    let historyCountAtTurnStart = 0;
    let modelOrToolProgressPersisted = false;
    // Next free WHOLE-NUMBER absolute position to append at. Tracked separately
    // from persistedHistoryCount (the in-memory slice index) because a compaction
    // inserts a fractional summary position, so total rows no longer equal
    // max(position)+1 and the slice index can no longer double as the position.
    let nextHistoryPosition = 0;
    const reconcileConversationTruth = async (options: { skipInputOnlyRows?: boolean } = {}) => {
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
          );
          const hasModelOrToolProgress = rows.some((row) => isModelOrToolProgressHistoryItem(row.item));
          const shouldAppendRows = rows.length > 0 && (!options.skipInputOnlyRows || hasModelOrToolProgress);
          if (shouldAppendRows) {
            await appendSessionHistoryItems(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              // Tag each row with the codex account that produced it (null on the
              // non-codex path). Resolved at line ~504 before any reconcile pass
              // runs, so this is the turn's effective account. The read path uses
              // it to strip cross-account reasoning.encrypted_content next turn.
              producerCodexCredentialId: effectiveCodexCredentialId,
              items: rows,
            });
          }
          if (shouldAppendRows || !options.skipInputOnlyRows) {
            persistedHistoryCount = nextWatermark;
            nextHistoryPosition = nextPosition;
          }
          if (hasModelOrToolProgress) {
            modelOrToolProgressPersisted = true;
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
      }
    };
    // Reassigned after the variable set loads; the publish closure is
    // created (and used for turn.started) before the variableSet is available.
    let redact: (payload: unknown) => unknown = identityRedactor;
    let variableSetId = "";
    // The Codex account this turn runs on (pin > workspace active), resolved once
    // a codex-billed turn is confirmed and threaded into the token resolver below.
    let effectiveCodexCredentialId: string | null = null;
    // Multi-account P4 (Part A): the latest usage-header snapshot scraped FOR FREE
    // off this turn's `/codex/responses` responses (a turn issues many model calls;
    // latest wins). Flushed ONCE into the P2 usage cache for the serving account in
    // the `finally` — cheaper than a /wham/usage poll AND it self-heals P3 rotation
    // (the proactive + 429 rankers read these exact columns). null ⇒ nothing scraped.
    // Hoisted to activity scope so the finally flush (below) sees it. The sink is
    // wired into codexContext.onUsageHeaders inside the try.
    let latestCodexUsage: CodexUsageHeaderSnapshot | null = null;
    // Hoisted for the preemption path: an approval-decision rerun must
    // re-enter through the approval resume path (its frozen mid-flight state
    // only exists in the RunState blob), never through a swapped trigger.
    let triggerType: string | null = null;
    try {
      const mcpSettings = await settingsWithEnabledCapabilityMcpServers(db, input.workspaceId, settings);
      // Read the active-credential flag ONCE (P2-b) and thread it through both the
      // routing overlay (settingsWithCodexCredential) and the billed-turn predicate
      // (isCodexBilledTurn below), so a concurrent disconnect/reconnect cannot make
      // provider-injection and billing disagree about whether this is a codex turn.
      const codexSubscriptionActive = await workspaceCodexSubscriptionActive(db, mcpSettings, input.workspaceId);
      const capabilitySettings = await settingsWithCodexCredential(db, input.workspaceId, mcpSettings, codexSubscriptionActive);
      runtime.configure(capabilitySettings);
      const session = await requireSession(db, input.workspaceId, input.sessionId);
      const trigger = await getSessionEvent(db, input.workspaceId, input.triggerEventId);
      if (!trigger) {
        throw new Error(`Trigger event not found: ${input.triggerEventId}`);
      }
      triggerType = trigger.type;
      let turn = input.turnId ? await getSessionTurn(db, input.workspaceId, input.turnId) : await claimNextQueuedTurnDb(db, input.workspaceId, input.sessionId, input.workflowId);
      if (!turn && !input.turnId) {
        const createdTurnId = await createTurn(db, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          temporalWorkflowId: input.workflowId,
          triggerEventId: input.triggerEventId,
        });
        turn = await getSessionTurn(db, input.workspaceId, createdTurnId);
      }
      if (!turn) {
        throw new Error(`Session turn not found for trigger: ${input.triggerEventId}`);
      }
      turnId = turn.id;
      turnLifecycleMetricsFor(observability).start(turnId);
      // Canonical codex-billed predicate (codex/<slug> + feature enabled + active
      // workspace credential). Computed once and threaded through every billing
      // gate + the usage recorder so a turn paid by the user's ChatGPT/Codex plan
      // consumes ZERO OpenGeni credits and never feeds an OpenGeni cap. Resolved
      // here (before resolvedModel at the routing step) because the pre-turn gate
      // below needs it; mirrors the same active-credential read the codex provider
      // overlay uses, so billing and routing agree on what "codex" is.
      const isCodexTurn = await isCodexBilledTurn({ db, settings, workspaceId: input.workspaceId, model: turn.model, active: codexSubscriptionActive });
      // §7.5 P3 — pass BOTH the codex predicate (codex-plan turns bypass the gate)
      // AND the optional host `entitlements` port (when bound, its admitRun replaces
      // the local credit read). Unset port → today's local-ledger path.
      await ensureRunAllowed(settings, db, input.accountId, input.workspaceId, isCodexTurn, entitlements);
      const activityContext = currentActivityContext();
      // Setup (variableSet load, MCP connects, sandbox restore) does not
      // stream and so never observes cancellation on its own; these explicit
      // checks let a graceful shutdown preempt the turn before the worker is
      // force-killed instead of riding the setup to a heartbeat timeout.
      const throwIfWorkerShuttingDown = () => {
        const reason = activityContext?.cancellationSignal.reason;
        if (isWorkerShutdownCancellation(reason)) {
          throw reason;
        }
      };
      heartbeatTimer = startActivityHeartbeat(activityContext, {
        phase: "running",
        sessionId: input.sessionId,
        turnId,
      });
      let producerSeq = 0;
      // One producer per activity execution, not per turn: a turn can run
      // again on the same workflow (preemption resume, approval rerun), and
      // each execution restarts producerSeq at 1 — a shared producer id would
      // trip the per-producer uniqueness constraint on the event log. The
      // Temporal activity id is unique per scheduled execution.
      const producerId = `${input.workflowId}:${turnId}${activityContext ? `:${activityContext.info.activityId}` : ""}`;
      // Unique per scheduled activity execution (Temporal activityId). Folded
      // into positional usage source keys so a re-dispatch of this turn does
      // not collide its model-call charges with the prior dispatch's. A genuine
      // activity retry reuses the same activityId, so its re-emitted calls keep
      // deduping (no double charge).
      const dispatchId = activityContext?.info.activityId ?? null;
      publish = async (events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>, immediate = false) => {
        const inputs = events.map((event) => ({
          ...event,
          payload: redact(event.payload),
          turnId: turnId!,
          producerId,
          producerSeq: ++producerSeq,
        }));
        await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, inputs);
        activityContext?.heartbeat({ phase: "events_published", sessionId: input.sessionId, turnId, producerSeq });
        if (immediate) {
          await Bun.sleep(0);
        }
      };
      activityContext?.heartbeat({ phase: "turn_started", sessionId: input.sessionId, turnId });

      // A shutdown that landed during claim/billing setup preempts before the
      // turn visibly starts: nothing ran yet, so the requeued turn replays the
      // original trigger cleanly on a healthy worker.
      throwIfWorkerShuttingDown();
      await setSessionStatus(db, input.workspaceId, input.sessionId, "running", turnId);
      await publish([
        { type: "session.status.changed", payload: { status: "running" } },
        { type: "turn.started", payload: { triggerEventId: input.triggerEventId } },
      ], true);
      turnStartedPublished = true;

      // Multi-account (P1): resolve the effective Codex account for this turn
      // (session-pin > workspace active) and stamp it on the session so the
      // in-session "Running on:" indicator reflects reality. Emit a switch event
      // when it changed from the prior run's account so the pill flips live.
      // Gated on the codex-billed predicate — non-codex turns never touch this.
      if (isCodexTurn) {
        const [rotation, accounts, sessionCodex] = await Promise.all([
          getCodexRotationSettings(db, input.workspaceId),
          listCodexAccountStatuses(db, input.workspaceId),
          getSessionCodexState(db, input.workspaceId, input.sessionId),
        ]);
        const connectedIds = new Set(accounts.map((account) => account.id));
        const sessionPin = sessionCodex?.pinnedCredentialId ?? null;
        // The off-path / P1 default: today's workspace active pointer. Untouched
        // when rotation is off or the session is pinned (byte-identical to P1).
        let chosenActive = rotation?.activeCredentialId ?? null;
        let rotationDecision: RotationDecision | null = null;

        // P3 auto-rotation: the ONLY new branch, gated on rotation_enabled and
        // pin-guarded (a pinned session NEVER rotates). When skipped, chosenActive
        // stays the active pointer and selectCodexCredentialForTurn is called with
        // byte-identical arguments to today — zero added cost on non-rotation turns.
        if (rotation?.rotationEnabled && sessionPin == null) {
          let rankAccounts = accounts;
          rotationDecision = chooseRotationActive({
            rotationStrategy: rotation.rotationStrategy as CodexRotationStrategy,
            activeCredentialId: rotation.activeCredentialId,
            priorCredentialId: sessionCodex?.lastCredentialId ?? null,
            accounts: rankAccounts,
            nearExhaustionPct: settings.codexRotationNearExhaustionPct,
            now: new Date(),
            // P4: the leaving (active) account's cached connector set is the proxy
            // for "what this session has access to" — prefer a covering target.
            usedConnectors: rankAccounts.find((a) => a.id === rotation.activeCredentialId)?.connectorNamespaces ?? [],
          });
          if (rotationDecision.kind === "allCapped") {
            // SELF-HEAL (invariant 4): the turn hot path NEVER refreshes usage, so a
            // window that has actually reset still reads capped from the stale cache —
            // which would otherwise idle-loop forever (idle → continuation re-dispatch →
            // same stale all-capped → idle …). Before idling, refresh usage for the
            // over-threshold accounts (bounded to the account count) and re-rank ONCE,
            // so a genuinely-reset window is picked up immediately and the cache heals.
            rankAccounts = await refreshCappedCodexUsageRows(db, settings, input.workspaceId, rankAccounts);
            rotationDecision = chooseRotationActive({
              rotationStrategy: rotation.rotationStrategy as CodexRotationStrategy,
              activeCredentialId: rotation.activeCredentialId,
              priorCredentialId: sessionCodex?.lastCredentialId ?? null,
              accounts: rankAccounts,
              nearExhaustionPct: settings.codexRotationNearExhaustionPct,
              now: new Date(),
              // P4: leaving (active) account's connector set (refreshCappedCodexUsageRows
              // only touches usage columns, so connectorNamespaces is preserved here).
              usedConnectors: rankAccounts.find((a) => a.id === rotation.activeCredentialId)?.connectorNamespaces ?? [],
            });
          }
          if (rotationDecision.kind === "active") {
            if (rotationDecision.moved) {
              // The single authoritative pointer-move site: persist the new active.
              await setActiveCodexCredential(db, input.workspaceId, rotationDecision.credentialId);
            }
            chosenActive = rotationDecision.credentialId;
          } else if (rotationDecision.kind === "allCapped" && publish && turnId) {
            // Every eligible account is capped/cooling (and a usage refresh did NOT
            // surface a reset): idle the turn AT THE BOUNDARY (no wasted model/sandbox
            // build) until the EARLIEST reset across all accounts — the multi-account
            // generalization of #143's single-account idle-until-reset. No saveRunState:
            // no model ran, nothing to freeze.
            const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
            const goalActive = Boolean(goal && goal.status === "active");
            // BOUNDED + POSITIVE: clamp to [MIN_IDLE_MS, max] so a null/elapsed/unknown
            // reset can never yield a 0 (which session.ts would treat as "continue now",
            // re-entering this path in a tight CPU/DB-hammering loop).
            const resumeMs = computeIdleDelayMs(rotationDecision.earliestResetAt, new Date(), CODEX_USAGE_LIMIT_MAX_RESUME_MS);
            const failurePayload = codexUsageLimitFailurePayload(
              { resetsInSeconds: Math.ceil(resumeMs / 1000) },
              "all connected Codex subscriptions are rate-limited",
              { allAccounts: true },
            );
            await publish([
              // `rotated:true` (Finding 2): the proactive all-capped wait is the SAME
              // rotation-wait state as the reactive all-capped path, so it must freeze
              // autoContinuations identically (evaluateGoalContinuation reads this marker)
              // — a goal waiting out a long reset must not burn its continuation budget on
              // the proactive path while the reactive path spares it.
              { type: "turn.failed", payload: { ...failurePayload, recovery: goalActive ? "goal_continuation" : "user_message", runStateSaved: false, rotated: true } },
              { type: "session.status.changed", payload: { status: "idle" } },
            ], true);
            await finishTurn(db, input.workspaceId, turnId, "failed");
            turnMetricOutcome = "failed";
            await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
            activityStatus = "idle";
            // idleUntilReset marks this a MANDATORY hold: session.ts must wait the full
            // resumeMs even if a future change made it 0 — never a tight re-dispatch.
            return goalActive ? { status: "idle", continueDelayMs: resumeMs, idleUntilReset: true } : { status: "idle" };
          }
          // kind:"none" (no accounts) → chosenActive stays null → existing relogin path.
        }

        effectiveCodexCredentialId = selectCodexCredentialForTurn({
          sessionPinnedCredentialId: sessionPin,    // pin still wins, structurally
          activeCredentialId: chosenActive,         // rotation-choice OR today's active
          connectedIds,
        });
        if (effectiveCodexCredentialId) {
          const priorAccountId = sessionCodex?.lastCredentialId ?? null;
          await recordSessionActiveCodexCredential(db, input.workspaceId, input.sessionId, effectiveCodexCredentialId);
          if (priorAccountId !== effectiveCodexCredentialId) {
            // "rotation" only when the engine actually moved the pointer; otherwise the
            // unchanged P1 "manual" literal (a manual active flip between turns).
            const rotated = rotationDecision?.kind === "active" && rotationDecision.moved;
            // P4: surface the dropped-connector note when this rotation pick couldn't
            // cover the session's used connectors (a Tier-2/unknown failover); the pill
            // renders the badge. Omitted when the switch covered everything (the norm).
            const droppedConnectors = rotationDecision?.kind === "active" ? rotationDecision.droppedConnectors : undefined;
            await publish([{
              type: "codex.account.switched",
              payload: {
                fromAccountId: priorAccountId,
                toAccountId: effectiveCodexCredentialId,
                reason: rotated ? "rotation" : "manual",
                ...(droppedConnectors && droppedConnectors.length > 0 ? { droppedConnectors } : {}),
              },
            }]);
          }
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
      const rigVersion = session.rigId && session.rigVersionId
        ? await getRigVersion(db, input.workspaceId, session.rigId, session.rigVersionId)
        : null;
      // Workspace tier of the agent-persona resolution (session > workspace >
      // deployment default). null means the workspace has no override, so the
      // runtime falls back to runSettings.agentInstructionsTemplate (the
      // deployment default, byte-identical to the historical preamble).
      const workspaceAgentInstructions = await resolveWorkspaceAgentInstructions(db, input.workspaceId);
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
      const runSettings = await settingsWithSessionMcpServersForRun(db, input.workspaceId, input.sessionId, baseRunSettings);
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
      // A codex-subscription turn resolves the bearer for THIS turn's effective
      // codex account (effectiveCodexCredentialId; pin > workspace-active) at
      // model-call time — multi-account P1 means a workspace can hold N accounts,
      // so the bearer is per-account, not per-workspace. codexSubscriptionFetch
      // (on the provider's OpenAI client) reads this AsyncLocalStorage context.
      // Build it once and wrap BOTH the compaction summarizer (a separate model
      // call on the same codex client) and the main run; otherwise the summarizer
      // would hit the codex backend unauthenticated.
      const codexContext: CodexRequestContext | null = resolvedModel?.provider.kind === "codex-subscription"
        ? ((): CodexRequestContext => {
            // The empty-string fallback yields no row → null credential → the
            // existing CodexReloginRequired path (a codex turn with no usable
            // account fails closed, exactly as before multi-account).
            const resolver = buildCodexTokenResolver(db, runSettings, input.workspaceId, effectiveCodexCredentialId ?? "");
            return {
              clientVersion: CODEX_CLIENT_VERSION,
              getToken: resolver.getToken,
              refresh: resolver.refresh,
              resolveModel: buildModelResolver(CODEX_FALLBACK_MODEL_SLUGS, CODEX_FALLBACK_MODEL_SLUGS[0]),
              onUsageHeaders: (snapshot) => { latestCodexUsage = snapshot; }, // latest wins; flushed once in finally
            };
          })()
        : null;
      const withCodex = <T>(fn: () => Promise<T>): Promise<T> => (codexContext ? codexRequestStorage.run(codexContext, fn) : fn());
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
      const turnTools = withCodexAppsTool(runSettings, withFirstPartyTools(runSettings, mergeToolRefs(session.tools, turn.tools)));
      // §7.6 P4a — load (and decrypt) the variable set via the host
      // `sandboxSecrets` provider when bound; unset → today's local decrypt.
      const connectionScope = { accountId: input.accountId, workspaceId: input.workspaceId };
      const workspaceVariableSet = await loadWorkspaceEnvironmentForRunWithCredentials(
        db,
        runSettings,
        connectionScope,
        session.variableSetId,
        connectionCredentials?.sandboxSecrets,
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
        const rigDefaultSet = await loadWorkspaceEnvironmentForRunWithCredentials(
          db,
          runSettings,
          connectionScope,
          rigDefaultVariableSetId,
          connectionCredentials?.sandboxSecrets,
        );
        Object.assign(rigDefaultEnvironmentValues, rigDefaultSet?.values ?? {});
      }
      // Session set wins collisions with the rig defaults (explicit precedence).
      const sandboxWorkspaceEnvironmentValues: Record<string, string> = {
        ...rigDefaultEnvironmentValues,
        ...(workspaceVariableSet?.values ?? {}),
      };
      // Redact EVERY exported secret value (rig defaults + session set) from turn
      // output, not just the session set's.
      redact = createSecretRedactor(
        Object.entries(sandboxWorkspaceEnvironmentValues).map(([name, value]) => ({ name, value })),
      );
      // EFFECTIVE compute backend, resolved ONCE at turn start (Case B + Stage D
      // D1-lite) and reused for EVERY downstream decision: the env mint (skip the
      // inert GitHub token for a machine turn), the establish path (no phantom Modal
      // home box for a machine-primary turn), buildAgent (skip the repository clone
      // hook so a private repo is never `git clone`d onto the user's real disk), and
      // the warm-rate (a machine accrues ZERO cloud warm-seconds). The active pointer
      // + its sandbox row are loaded ONCE here (best-effort, never throwing) and the
      // SAME values feed resolveActiveSandboxBackend (the tested gate) AND the
      // machine-primary establish branch (enrollmentId/epoch/workingDir) below — no
      // double read, no read-skew between the gate decision and the establish. With
      // routing OFF this is byte-for-byte the legacy path: no reads, undefined backend.
      const routingOn = routingEnabled(settings);
      const activeSandboxPointer = routingOn
        ? await readActiveSandbox(db, input.workspaceId, input.sessionId).catch(() => null)
        : null;
      const activeSandboxRecord = routingOn && activeSandboxPointer?.activeSandboxId
        ? await getSandbox(db, input.workspaceId, activeSandboxPointer.activeSandboxId).catch(() => null)
        : null;
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
        activeSandboxBackend === "selfhosted"
        && Boolean(activeSandboxPointer?.activeSandboxId)
        && Boolean(activeSandboxRecord?.enrollmentId);
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
      await ensureTurnModalRegistryImage(runSettings, sandboxCreationBackend);
      // Computed exactly ONCE per turn and reused for BOTH the box manifest
      // (resumeBoxForTurn -> establishSandboxSessionFromEnvelope, below) AND the
      // agent (runtime.buildAgent, below). sandboxEnvironmentForRun mints a FRESH
      // run-scoped GitHub installation token on every call, so a second call would
      // yield a DIFFERENT token value and re-introduce the manifest-env delta the
      // SDK's provided-session guard throws on — the box and the agent MUST share
      // this same object. A machine-primary turn skips the (inert) token mint entirely
      // (the machine uses its own git creds); the SAME base env still feeds the box +
      // the agent, so env-parity holds.
      // TOKEN-BROKER (B1): sandboxEnvironmentForRun now returns the STABLE manifest
      // env (no rotating GH_TOKEN/GITHUB_TOKEN/GIT_CONFIG_* extraheader) PLUS the
      // run-scoped GitHub token minted ONCE per turn as `gitToken`. The env feeds BOTH
      // the box manifest AND the agent (env-parity, as before); the token is threaded
      // OFF-MANIFEST as the clone-seed `gitTokenSeed` to buildAgent (below) so the box
      // never carries a rotating value on its manifest. When the platform token IS
      // minted, the host `gitCredentials` provider may supply it; unset → self-mint
      // from settings. gitToken is undefined on the selfhosted skip path (the machine
      // uses its own git creds).
      const {
        environment: sandboxEnvironment,
        gitToken: sandboxGitToken,
        toolspaceToken: sandboxToolspaceToken,
      } = await sandboxEnvironmentForRun(
        runSettings,
        turnResources,
        // Rig default sets merged BELOW the session set (session wins); rig-less
        // turns pass exactly workspaceVariableSet?.values (byte-for-byte today).
        sandboxWorkspaceEnvironmentValues,
        {
          skipGitHubToken: activeSandboxBackend === "selfhosted",
          scope: connectionScope,
          gitCredentials: connectionCredentials?.gitCredentials,
          sessionId: input.sessionId,
          runId: turnId,
        },
      );

      // P1.2 ownership inversion (gated, default OFF). With the flag off this
      // block is skipped entirely: resolvedSandbox stays null and runStream
      // takes the legacy per-run build-and-discard path — byte-for-byte today.
      // With it on, acquire the group lease ('turn' holder = the activityId),
      // resume the one box by id, and inject it NON-OWNED into the run. The box
      // backend is "none" -> never resolve (no box to touch).
      //
      // Established AFTER sandboxEnvironment is computed (not before) so the box's
      // manifest is created with the SAME variableSet the agent declares — the SDK
      // applies the agent's manifest to this provided session and throws on ANY
      // variableSet delta (validateNoEnvironmentDelta). Passing sandboxEnvironment
      // here makes current==target so the delta is empty.
      if (settings.sandboxOwnershipEnabled && turn.sandboxBackend !== "none") {
        sandboxHolderId = dispatchId ?? `turn:${turnId}`;
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
          const established = await establishSelfhostedTurnSession(
            { db, settings, bus },
            {
              workspaceId: input.workspaceId,
              agentId: activeSandboxRecord!.enrollmentId!,
              epoch: activeSandboxPointer!.activeEpoch,
              environment: sandboxEnvironment,
              workingDir: activeSandboxPointer!.workingDir,
            },
          );
          const lease = await acquireSelfhostedLeaseForTurn(
            { db, settings },
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sandboxGroupId: session.sandboxGroupId,
              sessionId: input.sessionId,
            },
            "turn",
            sandboxHolderId,
          );
          setupBoxSession = established.session;
          resolvedSandbox = {
            // Wrap in the SAME routing proxy so a mid-turn swap (to another machine
            // or back to the group box) still re-routes per op. PIN this established
            // SelfhostedSession for the machine pointer so the turn-start manifest
            // write (via the proxy's `state` getter) and the per-op reads hit ONE
            // instance — no two-instance manifest divergence.
            established: wrapTurnBoxWithRouting(
              { db, settings, bus },
              {
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                environment: sandboxEnvironment,
                pinnedSelfhosted: {
                  sandboxId: activeSandboxPointer!.activeSandboxId!,
                  epoch: activeSandboxPointer!.activeEpoch,
                },
              },
              established,
            ),
            leaseEpoch: lease.leaseEpoch,
            release: lease.release,
          };
        } else {
          resolvedSandbox = await resumeBoxForTurn(
            { db, settings, sandboxMetrics: runtimeMetricsHooksForObservability(observability) },
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
                ? { image: runSettings.modalImageRef ?? runSettings.dockerImage }
                : {}),
              // RIG IS SHARED STATE (M3): stamp the frozen rig version so the lease
              // conflicts on a live shared box set up under a different rig (solo
              // recreate / N-holders SandboxRigConflictError). Omitted for a rig-less
              // turn -> never stamped or enforced (shares exactly as today).
              ...(rigVersion ? { rigVersionId: rigVersion.id } : {}),
            },
            "turn",
            sandboxHolderId,
          );
          setupBoxSession = resolvedSandbox.established.session;
          // Durable box-lifecycle events (sandbox-file-persistence observability):
          // record every box transition in session_events so the NEXT box loss is
          // attributable from the DB alone — worker logs rotate within hours, which
          // left both 2026-07-06 incidents without a durable trace. Best-effort.
          {
            const established = resolvedSandbox.established;
            if (publish && established.origin && established.origin !== "resumed") {
              const lifecycleEvents: Array<{ type: "sandbox.box.lost" | "sandbox.box.created"; payload: unknown }> = [];
              if (established.lostInstanceId) {
                lifecycleEvents.push({ type: "sandbox.box.lost", payload: { sandboxId: established.lostInstanceId } });
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
          }
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
                { workspaceId: input.workspaceId, sessionId: input.sessionId, environment: sandboxEnvironment },
                resolvedSandbox.established,
              ),
            };
          }
        }
        // Refresh the lease TTL on the activity-heartbeat cadence (10s, well
        // inside the 90s lease TTL). EPOCH-FENCED: a superseded owner's refresh
        // is rejected (returns false) and we stop refreshing — the box rides the
        // provider idle-timeout and the next dispatch re-establishes it. Best-
        // effort: a transient DB error must never fail the turn.
        const heartbeatEpoch = resolvedSandbox.leaseEpoch;
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
        const warmRate = sandboxWarmRateMicrosPerSecond(settings, activeSandboxBackend ?? groupBoxBackend);
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
          if (snapshotSession && !snapshotInFlight) {
            snapshotInFlight = maybePersistWarmWorkspaceSnapshot(
              { db, settings },
              { accountId: input.accountId, workspaceId: input.workspaceId, sandboxGroupId: heartbeatGroupId },
              snapshotSession,
              heartbeatEpoch,
            )
              .then(async (persisted) => {
                if (persisted && publish) {
                  await publish([{ type: "sandbox.box.snapshot", payload: { trigger: "heartbeat" } }]);
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
      }

      // P4.3 on-turn recording. The box's :0 display stack was brought up by
      // resumeBoxForTurn (spawner path) / is up from a prior turn; film it for
      // the duration of this turn so the human can watch the agent work and the
      // agent's computer-use proofs are captured. Best-effort: a recording start
      // failure NEVER fails the turn (the desktop is a value-add). Finalized in
      // `finally` (read+PUT in this same activity — never a Temporal payload).
      if (
        resolvedSandbox
        && shouldStartOnTurnRecording({
          recordingEnabled: settings.recordingEnabled,
          desktopEnabled: settings.sandboxDesktopEnabled,
          establishedBackendId: resolvedSandbox.established.backendId,
          // EFFECTIVE (active) backend, not the session home: a machine-primary turn
          // resolves to "selfhosted" and skips; a swap back to the cloud group box
          // resolves to undefined and records as before.
          effectiveBackend: activeSandboxBackend,
        })
      ) {
        try {
          const begun = await beginRecording({
            settings,
            db,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: turnId!,
            recordingId: randomUUID(),
            mode: "on-turn",
            session: resolvedSandbox.established.session,
            runAs: sandboxRunAs(settings),
            reason: null,
          });
          activeRecording = begun.active;
          await publish([{ type: "recording.started", payload: begun.started }]);
        } catch (recordingError) {
          activeRecording = null;
          console.error("on-turn recording start failed (turn outcome unaffected)", recordingError);
        }
      }

      const fileResourceDownloads = await sandboxFileDownloadsForRun(runSettings, db, objectStorage, input.workspaceId, turnResources);
      throwIfWorkerShuttingDown();
      // Wrap MCP prep in the codex ALS so the codex_apps connect handshake
      // (initialize + tools/list) can resolve the per-workspace bearer from
      // codexRequestStorage (runtime/codexAppsMcpRequestInit). withCodex is the
      // identity on every non-codex turn, so this is a no-op for existing paths.
      const resolveCredential = buildConnectionTokenResolver(db, runSettings);
      preparedTools = await withCodex(() => runtime.prepareTools(runSettings, turnTools, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        subjectId: "worker:first-party-mcp",
        subjectLabel: "OpenGeni worker",
        resolveCredential,
        onAuthNeeded: async (payload) => {
          await publish!([{ type: "tool.auth_needed", payload }], true);
        },
        // Manager-style sessions carry a creation-validated permission set
        // for their first-party MCP token; null keeps the fixed default.
        ...(session.firstPartyMcpPermissions?.length ? { firstPartyPermissions: session.firstPartyMcpPermissions } : {}),
      }));
      // Genesis turn = the first user turn (no assistant history reconciled
      // yet). Durable Postgres state (countSessionHistoryItems includes
      // superseded rows after compaction), NOT a workflow counter (turnsThisRun
      // resets on continueAsNew). Drives the one-shot title hint appended to the
      // agent's instructions; continuation/preemption turns never match (their
      // trigger is goal.continuation/turn.preempted).
      const isGenesisTurn = triggerType === "user.message"
        && (await countSessionHistoryItems(db, input.workspaceId, input.sessionId)) === 0;
      const promptCacheKey = acceptsPromptCacheKeyForTurn(resolvedModel) ? input.sessionId : undefined;
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
      const agent = runtime.buildAgent(runSettings, turnResources, {
        reasoningEffort: turn.reasoningEffort,
        genesisTitleHint: isGenesisTurn,
        sandboxEnvironment,
        // TOKEN-BROKER (B1): forward the per-turn git token OFF-MANIFEST as the clone
        // seed. ONLY when the effective backend is NOT selfhosted (the connected
        // machine uses its own git creds — mirrors the skipGitHubToken gate above)
        // AND the mint actually produced a token (repo resources present). The runtime
        // seeds it to the box's token file before the repository-clone runs; it never
        // touches the box/agent manifest env.
        ...(activeSandboxBackend !== "selfhosted" && sandboxGitToken ? { gitTokenSeed: sandboxGitToken } : {}),
        // Toolspace is delivered on EVERY backend including selfhosted. The git-
        // token skip does NOT transfer: that token is inert on a connected
        // machine (it uses its own git creds), but the toolspace token is the
        // machine's ONLY path to programmatic tool calling and grants no more
        // than toolspace:call for its own session (own-session-bound, turn TTL,
        // budgeted, approval-tools excluded). The runtime seeds it to the box's
        // token file over the same exec channel, off-manifest, on every backend.
        ...(sandboxToolspaceToken ? { toolspaceTokenSeed: sandboxToolspaceToken } : {}),
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
            compactionMode: resolvedModel.provider.compactionMode,
            hostedWebSearch: resolvedModel.configured.hostedWebSearch,
            encryptedReasoning: resolvedModel.provider.api === "responses" && runSettings.openaiReasoningEncryptedContent,
            contextWindowTokens: resolvedModel.configured.contextWindowTokens ?? runSettings.contextWindowTokens,
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
          // LEGACY global-client fallback (resolveTurnModel returned null → the model
          // is not in the registry, served by the built-in OpenAI/Azure Responses
          // client). That backend has real hosted support, so pin computerToolMode to
          // "hosted" EXPLICITLY rather than leaving the runtime to sniff the instance.
          : {
            computerToolMode: computerToolModeForTurn(null),
            promptCacheKey: input.sessionId,
          }),
        ...(packRuntime.skills.length > 0 ? { packSkills: packRuntime.skills } : {}),
        ...(workspaceAgentInstructions ? { instructionsTemplate: workspaceAgentInstructions } : {}),
        ...(workspaceMemory ? { workspaceMemory } : {}),
        // Per-session persona tier (session > workspace > deployment default).
        // Composed system-level AFTER the workspace persona so it refines it for
        // this one session; absent ⇒ byte-identical to today's composition.
        ...(session.instructions ? { sessionInstructions: session.instructions } : {}),
        ...(workspaceVariableSet
          ? {
            workspaceVariableSet: {
              name: workspaceVariableSet.name,
              description: workspaceVariableSet.description,
              variableNames: Object.keys(workspaceVariableSet.values),
            },
          }
          : {}),
      });
      const compactSummarizer = resolvedModel
        ? (s: Settings, m: Array<Record<string, unknown>>, o?: { maxTranscriptTokens?: number }) => withCodex(() => summarizeForCompaction(s, m, {
            client: resolvedModel.client,
            api: resolvedModel.provider.api,
            model: resolvedModel.configured.id,
            maxOutputTokens: SUMMARY_BUFFER_TOKENS,
            ...(o?.maxTranscriptTokens ? { maxTranscriptTokens: o.maxTranscriptTokens } : {}),
            ...(promptCacheKey ? { promptCacheKey } : {}),
          }))
        : promptCacheKey
          ? ((s: Settings, m: Array<Record<string, unknown>>, o?: { maxTranscriptTokens?: number }) => summarizeForCompaction(s, m, {
              maxOutputTokens: SUMMARY_BUFFER_TOKENS,
              ...(o?.maxTranscriptTokens ? { maxTranscriptTokens: o.maxTranscriptTokens } : {}),
              promptCacheKey,
            }))
          : undefined;
      // Pre-turn client-side context compaction (Azure path). When the
      // resolved mode is "client" and the single Codex-parity threshold is
      // crossed, this summarizes the current active history and rebuilds active
      // history as [user messages..., summary] BEFORE the model input is read.
      // Summarizer failures fall through to hard-trim retry and deterministic
      // fallback; only structural no-ops leave the history unchanged.
      // Skipped on approval/preempt resumes (no fresh user turn; the frozen
      // RunState or in-flight tail must replay verbatim).
      if (triggerType === "user.message" || triggerType === "goal.continuation") {
        try {
          // Operator /compact (the slash command) sets a durable request flag;
          // consume it atomically so a forced compaction runs now even when the
          // budget trigger would not fire. Only the turn that observes the flag
          // runs it, so concurrent turns can't double-compact.
          const forced = await consumeSessionCompactionRequest(db, input.workspaceId, input.sessionId);
          const outcome = await maybeCompactContext(
            db,
            runSettings,
            { accountId: input.accountId, workspaceId: input.workspaceId, sessionId: input.sessionId, turnId },
            session.lastInputTokens,
            // Provider-aware summarizer: when the turn's model resolved to a
            // registry provider, summarize on THAT provider's client + wire API
            // (a chat provider can't summarize through OpenAI/Azure). Null
            // resolution uses the built-in Responses summarizer with the same
            // session prompt-cache key as the main model calls.
            compactSummarizer,
            forced ? { force: true } : {},
          );
          if (outcome.compacted) {
            const trigger = forced ? "operator" : undefined;
            await publish([{ type: "session.context.compacted", payload: { summaryPosition: outcome.summaryPosition, ...(trigger ? { trigger } : {}) } }]);
          }
        } catch (compactError) {
          console.error("context compaction failed (turn proceeds un-compacted)", compactError);
        }
      }
      let fileMaterializationFailures: SandboxFileDownloadFailure[] = [];
      let fileDownloadsMaterializedForRun = false;
      if (
        resolvedSandbox
        && setupBoxSession
        && activeSandboxBackend !== "selfhosted"
        && fileResourceDownloads.length > 0
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
          const materialized = await materializeSandboxFileDownloads(setupBoxSession as any, downloadsToMaterialize, {
            onRuntimeEvent: async (event) => {
              await publish!([{ type: event.type, payload: event.payload }], true);
            },
            ...(runAs ? { runAs } : {}),
          });
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
      const unavailableSandboxFilesNote = sandboxFileDownloadFailureNote(fileMaterializationFailures);
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
          runSettings,
          { currentCodexCredentialId: effectiveCodexCredentialId },
          unavailableSandboxFilesNote ? { unavailableSandboxFilesNote } : {},
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
        const activeSeedRows = await getActiveSessionHistoryItems(db, input.workspaceId, input.sessionId);
        // Seed the reconcile watermark from EXACTLY the view the model's
        // `state.history` was seeded from (items strip on the items path = HOLE D; NO
        // strip on the run-state blob path, where foreign reasoning is neutralized but
        // KEPT = HOLE E), so the model-input length and the watermark never disagree.
        persistedHistoryCount = reconcileSeedCount(
          activeSeedRows,
          prepared.modelHistoryFromItems,
          { currentCodexCredentialId: effectiveCodexCredentialId },
        );
        historyCountAtTurnStart = persistedHistoryCount;
        nextHistoryPosition = await nextSessionHistoryPosition(db, input.workspaceId, input.sessionId);
      };

      const forceContextCompaction = async (triggerLabel: "overflow" | "proactive") => {
        const clientCompactionSettings: Settings = { ...runSettings, contextCompactionMode: "client" };
        const outcome = await maybeCompactContext(
          db,
          clientCompactionSettings,
          { accountId: input.accountId, workspaceId: input.workspaceId, sessionId: input.sessionId, turnId: activeTurnId },
          session.lastInputTokens,
          compactSummarizer,
          { force: true, requireShrink: true },
        );
        if (outcome.compacted) {
          await publish!([{ type: "session.context.compacted", payload: { summaryPosition: outcome.summaryPosition, trigger: triggerLabel } }]);
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
        // Actual input tokens of the most recent model response this turn; the
        // pre-read trigger for the NEXT turn. Persisted at every turn-end path.
        let lastInputTokensObserved: number | null = null;
        throwIfWorkerShuttingDown();
        const runStreamOnce = (): ReturnType<OpenGeniRuntime["runStream"]> => runtime.runStream(agent, runInput!, runSettings, {
          sandboxEnvironment,
          onRuntimeEvent: async (event) => {
            await publish!([{ type: event.type, payload: event.payload }], true);
          },
          // P1.2: inject the resumed box NON-OWNED (the SDK never reaps it — the
          // keystone). Absent when the flag is off -> legacy build-and-discard.
          ...(resolvedSandbox
            ? {
              ownedSandbox: {
                client: resolvedSandbox.established.client,
                session: resolvedSandbox.established.session,
                sessionState: resolvedSandbox.established.sessionState,
                // Pin platform setup (hooks + file materialization) to the un-proxied
                // established box — never through the routing proxy, which would
                // re-route those execs onto a machine swapped in mid-turn.
                ...(setupBoxSession ? { setupSession: setupBoxSession } : {}),
                ...(fileDownloadsMaterializedForRun ? { fileDownloadsMaterialized: true } : {}),
              },
            }
            : {}),
          contextCompactionSignalTokens: () => lastInputTokensObserved,
        });
        stream = await withCodex(runStreamOnce);
        batcher = createRuntimeBatcher(async (events) => {
          await publish!(events);
        });

        const iterator = stream.toStream()[Symbol.asyncIterator]();
        let streamDone = false;
        try {
          while (true) {
            const next = await nextStreamEvent(iterator, activityContext);
            if (next.done) {
              streamDone = true;
              break;
            }
            let modelUsageEventContext: Record<string, unknown> | null = null;
            const responseUsage = modelResponseUsageFromSdkEvent(next.value);
            if (responseUsage) {
              responseUsageCount += 1;
              const responseSourceKey = modelUsageSourceKey({
                responseId: responseUsage.responseId,
                dispatchId,
                positionalKey: `response-${responseUsageCount}`,
              });
              await emitModelCallUsage({
                observability,
                publish: null,
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: activeTurnId,
                provider: resolvedModel?.provider.id ?? settings.openaiProvider,
                providerApi: resolvedModel?.provider.api ?? "responses",
                model: turn.model,
                sourceKey: responseSourceKey,
                usage: responseUsage,
              });
              modelUsageEventContext = {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: activeTurnId,
                provider: resolvedModel?.provider.id ?? settings.openaiProvider,
                providerApi: resolvedModel?.provider.api ?? "responses",
                model: turn.model,
                sourceKey: responseSourceKey,
              };
              const observed = responseUsage.usage?.inputTokens;
              if (typeof observed === "number" && observed > 0) {
                lastInputTokensObserved = observed;
                await setSessionLastInputTokens(db, input.workspaceId, input.sessionId, observed)
                  .catch((error) => console.error("persist last_input_tokens failed (non-fatal)", error));
              }
              await recordModelUsageAndDebitCredits(settings, db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: activeTurnId,
                model: turn.model,
                isCodexTurn,
                usage: responseUsage.usage,
                sourceKey: responseSourceKey,
                observability,
              });
              await reconcileConversationTruth();
              try {
                await ensureRunAllowed(settings, db, input.accountId, input.workspaceId, isCodexTurn, entitlements);
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
            // Recording gate: a computer-use tool actually ran when an SDK
            // `tool_call_item` whose rawItem.type is "computer_call" streams through
            // (screenshot/click/type/scroll/etc. — the first computer action proves
            // the desktop was driven). Match the raw SDK event (ground truth) BEFORE
            // normalization. Only meaningful when a recording is live.
            if (activeRecording && !didComputerUse && isComputerCallStreamEvent(next.value)) {
              didComputerUse = true;
            }
            const normalized = normalizeSdkEvent(next.value);
            for (const event of normalized) {
              if (event.type === "agent.model.usage" && modelUsageEventContext && event.payload && typeof event.payload === "object") {
                event.payload = { ...modelUsageEventContext, ...event.payload };
              }
              await batcher.push(event);
            }
          }
        } finally {
          if (!streamDone) {
            await iterator.return?.();
          }
        }
        await batcher.flush();
        await stream.completed.catch(() => undefined);
        if (responseUsageCount === 0) {
          const aggregateInput = (stream.state.usage as { inputTokens?: unknown } | undefined)?.inputTokens;
          if (typeof aggregateInput === "number" && aggregateInput > 0) {
            lastInputTokensObserved = aggregateInput;
          }
          const aggregateSourceKey = modelUsageSourceKey({ responseId: null, dispatchId, positionalKey: "aggregate" });
          await recordModelUsageAndDebitCredits(settings, db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: activeTurnId,
            model: turn.model,
            isCodexTurn,
            usage: stream.state.usage,
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
            usage: { usage: stream.state.usage },
          });
        }
        if (lastInputTokensObserved !== null) {
          await setSessionLastInputTokens(db, input.workspaceId, input.sessionId, lastInputTokensObserved)
            .catch((error) => console.error("persist last_input_tokens failed (non-fatal)", error));
        }

        if (stream.interruptions.length > 0) {
          await reconcileConversationTruth();
          const approvals = runtime.serializeApprovals(stream.interruptions);
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: activeTurnId,
            serializedRunState: stream.state.toString(),
            pendingApprovals: approvals,
            // Record the account freezing this state so a resume on a DIFFERENT
            // codex account strips its account-bound reasoning before replay (HOLE C).
            frozenCodexCredentialId: effectiveCodexCredentialId,
          });
          await publish!([
            { type: "session.requiresAction", payload: { approvals } },
            { type: "session.status.changed", payload: { status: "requires_action" } },
          ], true);
          await finishTurn(db, input.workspaceId, activeTurnId, "requires_action");
          await setSessionStatus(db, input.workspaceId, input.sessionId, "requires_action", activeTurnId);
          activityStatus = "requires_action";
          return { status: "requires_action" };
        }

        const finalOutput = String(stream.finalOutput ?? "");
        await reconcileConversationTruth();
        if (settings.sessionHistorySource !== "items") {
          // Legacy conversation memory; in items mode the blob is only written
          // for requires_action pauses (the one RunState-only resume path).
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: activeTurnId,
            serializedRunState: stream.state.toString(),
            pendingApprovals: [],
            frozenCodexCredentialId: effectiveCodexCredentialId,
          });
        }
        await publish!([
          { type: "agent.message.completed", payload: { text: finalOutput } },
          { type: "turn.completed", payload: { output: finalOutput } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ], true);
        await finishTurn(db, input.workspaceId, activeTurnId, "idle");
        turnMetricOutcome = "completed";
        await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: activeTurnId,
          idempotencyKey: `usage:agent_run.completed:${activeTurnId}`,
        });
        activityStatus = "idle";
        return { status: "idle" };
      };

      await prepareRunAttemptInput();
      let compactionRecoveryAttempts = 0;
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
          const recoveryKind = compactionNeeded ? "proactive" : overflow ? "overflow" : null;
          if (recoveryKind && compactionRecoveryAttempts >= MAX_CONTEXT_COMPACTION_RECOVERY_ATTEMPTS) {
            throw new Error(
              `compaction summarization failed: context compaction recovery attempt cap reached (${MAX_CONTEXT_COMPACTION_RECOVERY_ATTEMPTS})`,
              { cause: attemptError },
            );
          }
          if (!recoveryKind || !publish || !turnStartedPublished) {
            throw attemptError;
          }
          compactionRecoveryAttempts += 1;
          await flushRuntimeBatcher();
          await reconcileConversationTruth({ skipInputOnlyRows: true });
          const progressPersisted = modelOrToolProgressPersisted;
          observability.warn("context compaction recovery attempted", {
            sessionId: input.sessionId,
            turnId: activeTurnId,
            reason: recoveryKind,
            progressPersisted,
            code: overflow?.code,
            error: overflow?.message ?? compactionNeeded?.message,
            signalTokens: compactionNeeded?.signalTokens,
            thresholdTokens: compactionNeeded?.thresholdTokens,
          });
          let compacted = false;
          let compactionFailureMessage: string | null = null;
          try {
            const outcome = await forceContextCompaction(recoveryKind);
            compacted = outcome.compacted;
            if (!outcome.compacted) {
              compactionFailureMessage = compactionFailureReason(outcome.reason);
            }
          } catch (compactError) {
            compactionFailureMessage = compactionFailureReason(compactError instanceof Error ? compactError.message : String(compactError));
            observability.warn("context compaction recovery compaction failed", {
              sessionId: input.sessionId,
              turnId: activeTurnId,
              error: compactionFailureMessage,
            });
          }
          if (!compacted) {
            const errorMessage = compactionFailureMessage ?? "compaction summarization failed: compaction produced no replacement history";
            if (!progressPersisted) {
              throw new Error(errorMessage, { cause: attemptError });
            }
            await publish!([
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
            ], true);
            await finishTurn(db, input.workspaceId, activeTurnId, "failed");
            turnMetricOutcome = "failed";
            await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
            activityStatus = "idle";
            activityError = attemptError;
            return { status: "idle" };
          }
          if (progressPersisted) {
            // The user's intent was live mid-turn — after a successful
            // compaction the turn AUTO-CONTINUES via the same synthesized
            // resume-notice requeue the worker-shutdown checkpoint uses (never
            // the original trigger, so side effects are not replayed). Idle is
            // the fallback, not the default; it remains for: legacy run-state
            // history (resuming the frozen pre-compaction RunState would
            // overflow again), a compaction that could not shrink anything,
            // and a turn that ALREADY resumed from an overflow (loop guard —
            // a second overflow in the same lineage stops churning).
            const triggerPayload =
              trigger.payload && typeof trigger.payload === "object" && !Array.isArray(trigger.payload)
                ? trigger.payload as Record<string, unknown>
                : {};
            const compactionResumedTurn = triggerType === "turn.preempted"
              && (triggerPayload.reason === "context_compacted" || triggerPayload.reason === "context_overflow_compacted");
            const canAutoContinue =
              compacted && !compactionResumedTurn && settings.sessionHistorySource === "items" && activeTurnId != null;
            if (canAutoContinue) {
              const [preemptedEvent] = await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [
                {
                  turnId: activeTurnId,
                  type: "turn.preempted",
                  payload: {
                    triggerEventId: input.triggerEventId,
                    reason: "context_compacted",
                    resumeWithNotice: true,
                    text: CONTEXT_OVERFLOW_RESUME_TEXT,
                  },
                },
                { turnId: activeTurnId, type: "session.status.changed", payload: { status: "queued" } },
              ]);
              await requeuePreemptedTurn(db, input.workspaceId, activeTurnId, preemptedEvent ? preemptedEvent.id : input.triggerEventId);
              await setSessionStatus(db, input.workspaceId, input.sessionId, "queued", null).catch(() => undefined);
              activityStatus = "preempted";
              turnMetricOutcome = "preempted";
              observability.info("context compaction recovery succeeded by compacting and auto-continuing", {
                sessionId: input.sessionId,
                turnId: activeTurnId,
                reason: recoveryKind,
                compacted,
              });
              return { status: "preempted" };
            }
            await publish!([
              {
                type: "turn.failed",
                payload: {
                  error: CONTEXT_WINDOW_OVERFLOW_RECOVERY_MESSAGE,
                  code: recoveryKind === "overflow" ? "context_window_overflow_compacted" : "context_compacted",
                  retryable: false,
                  recovery: "user_message",
                  compacted,
                },
              },
              { type: "session.status.changed", payload: { status: "idle" } },
            ], true);
            await finishTurn(db, input.workspaceId, activeTurnId, "failed");
            turnMetricOutcome = "failed";
            await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
            activityStatus = "idle";
            activityError = attemptError;
            observability.info("context compaction recovery succeeded by compacting and idling", {
              sessionId: input.sessionId,
              turnId: activeTurnId,
              reason: recoveryKind,
              compacted,
            });
            return { status: "idle" };
          }
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
      // Graceful worker shutdown (deploy / rollout restart): checkpoint and
      // hand the turn back instead of failing the session. Conversation truth
      // is already dual-written per model response; the final reconcile below
      // bounds the loss to at most the single in-flight model step. The turn
      // is re-queued so the session workflow re-dispatches it on a healthy
      // worker — through a synthesized resume notice when this turn already
      // persisted progress (replaying the original trigger would duplicate
      // input the model has already seen and invite it to redo side effects),
      // or through the original trigger when nothing was persisted yet. This
      // is an explicit checkpoint/resume, not a blind activity retry: the
      // resumed attempt sees everything the first attempt did.
      //
      // The branch deliberately does NOT require turn.started to have been
      // published: a shutdown landing during setup (claim/billing, before the
      // turn visibly started) must also requeue, not fail the session. In
      // that early case nothing ran and nothing was checkpointed, so the
      // requeued turn replays the original trigger cleanly. The turn id falls
      // back to the workflow-claimed turn when the local lookup had not
      // finished yet.
      const preemptTurnId = turnId ?? input.turnId;
      // P1.2: a lease supersession during resume (a newer epoch re-established
      // the box concurrently) is NOT a session failure — re-dispatch the turn so
      // it re-resumes by id under the current epoch. Requeue + idle, mirroring
      // the worker-death re-dispatch (any worker re-resumes by id).
      if (error instanceof SandboxLeaseSupersededError && preemptTurnId) {
        try {
          await requeuePreemptedTurn(db, input.workspaceId, preemptTurnId, input.triggerEventId);
          await setSessionStatus(db, input.workspaceId, input.sessionId, "queued", null).catch(() => undefined);
          activityStatus = "preempted";
          turnMetricOutcome = "preempted";
          return { status: "preempted" };
        } catch (requeueError) {
          console.error("sandbox lease supersession requeue failed; falling back", requeueError);
        }
      }
      if (isWorkerShutdownCancellation(error) && preemptTurnId) {
        try {
          await flushRuntimeBatcher();
          await reconcileConversationTruth();
          // An approval-decision rerun always replays its original trigger:
          // the decision is applied through the approval resume path reading
          // the frozen RunState blob (the only representation of a turn
          // paused mid-flight), so swapping the trigger for a resume notice
          // could drop the user's decision. Re-applying an already-consumed
          // approval re-executes at most the single approved step — the same
          // bound every preemption already accepts.
          const approvalRerun = triggerType === "user.approvalDecision";
          let resumeWithNotice = !approvalRerun && settings.sessionHistorySource === "items" && persistedHistoryCount > historyCountAtTurnStart;
          if (settings.sessionHistorySource !== "items" && stream) {
            // Legacy run-state mode: the resume reads the RunState blob, so
            // the checkpoint must be captured there — including any pending
            // approval interruptions, exactly like the requires_action path,
            // so a shutdown while approvals wait does not erase them. A
            // failed capture falls back to the previous snapshot and a clean
            // re-run of the original trigger.
            try {
              await saveRunState(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: preemptTurnId,
                serializedRunState: stream.state.toString(),
                pendingApprovals: runtime.serializeApprovals(stream.interruptions ?? []),
                frozenCodexCredentialId: effectiveCodexCredentialId,
              });
              resumeWithNotice = true;
            } catch {
              resumeWithNotice = false;
            }
          }
          const [preemptedEvent] = await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [
            {
              turnId: preemptTurnId,
              type: "turn.preempted",
              payload: {
                triggerEventId: input.triggerEventId,
                reason: "worker_shutdown",
                resumeWithNotice,
                ...(resumeWithNotice ? { text: WORKER_SHUTDOWN_RESUME_TEXT } : {}),
              },
            },
            {
              turnId: preemptTurnId,
              type: "session.status.changed",
              payload: { status: "queued" },
            },
          ]);
          await requeuePreemptedTurn(db, input.workspaceId, preemptTurnId, resumeWithNotice && preemptedEvent ? preemptedEvent.id : input.triggerEventId);
          await setSessionStatus(db, input.workspaceId, input.sessionId, "queued", null).catch(() => undefined);
          activityStatus = "preempted";
          turnMetricOutcome = "preempted";
          return { status: "preempted" };
        } catch (preemptError) {
          // A failing checkpoint/requeue must not surface as an arbitrary
          // activity error around a half-applied preemption (the workflow
          // would fail the session while a requeued turn lingers). Fall
          // through to the cancellation path below: the turn is marked
          // cancelled — also resetting a turn this block already requeued —
          // and the session fails like an uncheckpointed death.
          console.error("worker-shutdown preemption failed; falling back to cancellation", preemptError);
        }
      }
      if (error instanceof CancelledFailure) {
        activityStatus = "cancelled";
        activityError = error;
        await flushRuntimeBatcher();
        if (preemptTurnId) {
          await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [{
            turnId: preemptTurnId,
            type: "turn.cancelled",
            payload: {
              triggerEventId: input.triggerEventId,
              reason: error.message || "activity_cancelled",
            },
          }]).catch(() => undefined);
          await finishTurn(db, input.workspaceId, preemptTurnId, "cancelled").catch(() => undefined);
          turnMetricOutcome = "cancelled";
        }
        throw error;
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
        const runStateSaved = Boolean(maxTurns.serializedRunState) && settings.sessionHistorySource !== "items";
        if (maxTurns.serializedRunState && settings.sessionHistorySource !== "items") {
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            serializedRunState: maxTurns.serializedRunState,
            pendingApprovals: [],
            frozenCodexCredentialId: effectiveCodexCredentialId,
          });
        }
        await publish([
          { type: "turn.completed", payload: { output: "", segmentLimit: "max_turns", runStateSaved } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ], true);
        await finishTurn(db, input.workspaceId, turnId, "idle");
        turnMetricOutcome = "completed";
        await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: turnId,
          idempotencyKey: `usage:agent_run.completed:${turnId}`,
        });
        activityStatus = "idle";
        return { status: "idle" };
      }
      // A ChatGPT/Codex usage cap (429 usage_limit_reached) is account state,
      // NOT an agent failure: surface the precise, actionable message (so the
      // user sees the reset window) but idle the session — never go terminal,
      // which would reject the user's next message after the cap lifts. The
      // payload is retryable:false so the generic provider-backpressure auto-retry
      // does not loop. For an active goal we hold the continuation for the reported
      // reset window (capped) so it resumes itself when access returns, instead of
      // hammering the capped backend.
      const usageLimit = classifyCodexUsageLimitError(error);
      if (usageLimit && publish && turnId && turnStartedPublished) {
        const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
        const goalActive = Boolean(goal && goal.status === "active");
        await flushRuntimeBatcher();
        await reconcileConversationTruth();
        const serializedRunState = agentsErrorRunState(error);
        const runStateSaved = Boolean(serializedRunState) && settings.sessionHistorySource !== "items";
        if (serializedRunState && settings.sessionHistorySource !== "items") {
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            serializedRunState,
            pendingApprovals: [],
            frozenCodexCredentialId: effectiveCodexCredentialId,
          });
        }
        // --- P3 reactive rotation (gated; re-fetch fresh state on this already-failed,
        // already-idling path). Mark THIS account cooling until its reset, then CONSULT the
        // engine over fresh accounts to decide continueDelayMs: a fast 0-delay re-dispatch
        // when another account is available, or idle-until-earliest when all are capped. The
        // catch deliberately does NOT move the active pointer — the re-dispatched turn's
        // proactive seam (turn-start) is the single authoritative pointer-move + strip site.
        let rotated = false;
        let rotationResumeMs: number | null = null;     // 0 ⇒ a candidate is available; re-dispatch now
        let rotationResumeIdleUntilReset = false;       // circuit-breaker fall (Finding 1b) ⇒ MANDATORY hold
        let allCappedResetAt: Date | null = null;       // set ⇒ every account capped; idle until this
        if (effectiveCodexCredentialId) {
          const [rotation, sessionCodex] = await Promise.all([
            getCodexRotationSettings(db, input.workspaceId).catch(() => null),
            getSessionCodexState(db, input.workspaceId, input.sessionId).catch(() => null),
          ]);
          const rotating = Boolean(rotation?.rotationEnabled) && (sessionCodex?.pinnedCredentialId == null);
          if (rotating && rotation) {
            const accounts = await listCodexAccountStatuses(db, input.workspaceId).catch(() => []);
            const serving = accounts.find((a) => a.id === effectiveCodexCredentialId) ?? null;
            // Cooldown end (invariant 5): authoritative resets_in_seconds from the 429; else
            // the serving account's soonest cached window reset; else the 1h cap.
            const cachedReset = [serving?.primaryResetAt, serving?.secondaryResetAt]
              .filter((d): d is Date => d instanceof Date && d.getTime() > Date.now())
              .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
            const until = usageLimit.resetsInSeconds !== null && Number.isFinite(usageLimit.resetsInSeconds) && usageLimit.resetsInSeconds > 0
              ? new Date(Date.now() + Math.ceil(usageLimit.resetsInSeconds) * 1000)
              : (cachedReset ?? new Date(Date.now() + CODEX_USAGE_LIMIT_MAX_RESUME_MS));
            // Finding 1a: INSPECT the cooldown-write result. A swallowed best-effort
            // write whose failure went unnoticed is exactly what lets the next proactive
            // rank re-pick this just-capped account (stale-low cached usedPercent, not
            // cooling) — so capture whether it PERSISTED and feed it into the resume floor.
            const cooldownPersisted = await setCodexCredentialExhausted(db, input.workspaceId, effectiveCodexCredentialId, until).catch(() => false);
            // Re-rank over the fresh accounts; the in-memory list predates the cooldown
            // write, so stamp the just-cooled account so the engine excludes it now. The
            // serving account is thus walked AT MOST ONCE per turn (invariant 4: bounded).
            const fresh = accounts.map((a) => (a.id === effectiveCodexCredentialId ? { ...a, exhaustedUntil: until } : a));
            const decision = chooseRotationActive({
              rotationStrategy: rotation.rotationStrategy as CodexRotationStrategy,
              activeCredentialId: rotation.activeCredentialId,
              priorCredentialId: effectiveCodexCredentialId,
              accounts: fresh,
              nearExhaustionPct: settings.codexRotationNearExhaustionPct,
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
              const priorConsecutiveRotations = await countConsecutiveReactiveRotations(db, input.workspaceId, input.sessionId).catch(() => 0);
              const resume = computeReactiveRotationResume({
                cooldownPersisted,
                priorConsecutiveRotations,
                connectedAccountCount: accounts.length,
              });
              rotationResumeMs = resume.continueDelayMs;               // 0 (happy path), a slow-retry floor, or the circuit-breaker idle
              rotationResumeIdleUntilReset = resume.idleUntilReset;    // true only on the circuit-breaker fall (MANDATORY hold)
            } else if (decision.kind === "allCapped") {
              rotated = true;
              allCappedResetAt = decision.earliestResetAt;
            }
            // kind:"none" → fall through to today's single-account idle.
          }
        }

        const failurePayload = allCappedResetAt
          ? codexUsageLimitFailurePayload(
              { resetsInSeconds: Math.ceil(Math.max(0, allCappedResetAt.getTime() - Date.now()) / 1000) },
              error instanceof Error ? error.message : String(error),
              { allAccounts: true },
            )
          : codexUsageLimitFailurePayload(usageLimit, error instanceof Error ? error.message : String(error));
        await publish([
          // `rotated:true` ONLY on the reactive rotation path tells evaluateGoalContinuation to
          // freeze autoContinuations (a rotation walk must not burn the goal's continuation budget).
          { type: "turn.failed", payload: { ...failurePayload, recovery: goalActive ? "goal_continuation" : "user_message", runStateSaved, ...(rotated ? { rotated: true } : {}) } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ], true);
        await finishTurn(db, input.workspaceId, turnId, "failed");
        turnMetricOutcome = "failed";
        await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
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
            return { status: "idle", continueDelayMs: rotationResumeMs, ...(rotationResumeIdleUntilReset ? { idleUntilReset: true } : {}) };
          }
          // All-capped: clamp to [MIN_IDLE_MS, max] — a POSITIVE, BOUNDED hold (never 0,
          // so session.ts can never tight-loop). The post-idle continuation re-dispatch
          // hits the proactive seam, which refreshes usage and self-heals.
          const resumeMs = allCappedResetAt
            ? computeIdleDelayMs(allCappedResetAt, new Date(), CODEX_USAGE_LIMIT_MAX_RESUME_MS)
            : (usageLimit.resetsInSeconds !== null && Number.isFinite(usageLimit.resetsInSeconds) && usageLimit.resetsInSeconds > 0
                ? Math.min(Math.ceil(usageLimit.resetsInSeconds) * 1000, CODEX_USAGE_LIMIT_MAX_RESUME_MS)
                : CODEX_USAGE_LIMIT_MAX_RESUME_MS);
          return { status: "idle", continueDelayMs: resumeMs, ...(allCappedResetAt ? { idleUntilReset: true } : {}) };
        }
        return { status: "idle" };
      }
      // Budget/limit exhaustion between model calls is account state, not an
      // agent failure: idle the session for goal-bearing and goal-less runs
      // alike (a failed session would reject the user's next message after a
      // top-up). An active goal pauses visibly with reason "limits" at the
      // next continuation evaluation, without consuming continuation budget.
      if (error instanceof BudgetExhaustedError && publish && turnId && turnStartedPublished) {
        await flushRuntimeBatcher();
        await reconcileConversationTruth();
        const runStateSaved = Boolean(error.serializedRunState) && settings.sessionHistorySource !== "items";
        if (error.serializedRunState && settings.sessionHistorySource !== "items") {
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            serializedRunState: error.serializedRunState,
            pendingApprovals: [],
            frozenCodexCredentialId: effectiveCodexCredentialId,
          });
        }
        await publish([
          { type: "turn.completed", payload: { output: "", segmentLimit: "budget_exhausted", detail: error.message, runStateSaved } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ], true);
        await finishTurn(db, input.workspaceId, turnId, "idle");
        turnMetricOutcome = "completed";
        await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: turnId,
          idempotencyKey: `usage:agent_run.completed:${turnId}`,
        });
        activityStatus = "idle";
        return { status: "idle" };
      }
      // A retryable provider failure (rate limit) is transient backpressure,
      // not a session failure: the in-client retry budget is already
      // exhausted by the time the error reaches here, so fail the turn
      // truthfully but idle the session. With an active goal the continuation
      // loop resumes after a pacing delay; without one the session simply
      // waits for the next user message. Long-lived sessions (a per-customer
      // ops channel between goals) must never go terminal because the
      // provider had a bad minute -- a failed session would reject the very
      // retry message the failure asks for.
      const failure = agentRunFailurePayload(error);
      if (failure.retryable && publish && turnId && turnStartedPublished) {
        const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
        const goalActive = Boolean(goal && goal.status === "active");
        await flushRuntimeBatcher();
        // Provider errors rarely carry SDK run state; a null falls back to
        // the previous snapshot, same degraded-context contract as the
        // max-turns path above.
        await reconcileConversationTruth();
        const serializedRunState = agentsErrorRunState(error);
        const runStateSaved = Boolean(serializedRunState) && settings.sessionHistorySource !== "items";
        if (serializedRunState && settings.sessionHistorySource !== "items") {
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            serializedRunState,
            pendingApprovals: [],
            frozenCodexCredentialId: effectiveCodexCredentialId,
          });
        }
        await publish([
          { type: "turn.failed", payload: { ...failure, recovery: goalActive ? "goal_continuation" : "user_message", runStateSaved } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ], true);
        await finishTurn(db, input.workspaceId, turnId, "failed");
        turnMetricOutcome = "failed";
        await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
        activityStatus = "idle";
        activityError = error;
        return goalActive ? { status: "idle", continueDelayMs: PROVIDER_BACKPRESSURE_DELAY_MS } : { status: "idle" };
      }
      activityStatus = "failed";
      activityError = error;
      if (!publish || !turnId || !turnStartedPublished) {
        throw error;
      }
      await publish([
        { type: "turn.failed", payload: failure },
        { type: "session.status.changed", payload: { status: "failed" } },
      ], true);
      await finishTurn(db, input.workspaceId, turnId, "failed");
      turnMetricOutcome = "failed";
      await setSessionStatus(db, input.workspaceId, input.sessionId, "failed", null);
      // The common failure path ends here: runAgentTurn marks the session
      // failed and returns "failed", and the session workflow then exits
      // WITHOUT calling failSession/markSessionIdle. Wake a spawned worker's
      // parent here too, so a manager learns of a worker that died inside its
      // turn (not just one failed by the workflow's failSession path). Deduped
      // per terminal episode by the child's lastSequence, so it never
      // double-fires with the workflow-level wake.
      await notifyParentOfChildTerminal({ db, bus, settings, observability, wakeSessionWorkflow }, input.workspaceId, input.sessionId, "failed", `turn:${turnId}`);
      return { status: "failed" };
    } finally {
      const durationSeconds = (performance.now() - activityStarted) / 1000;
      observability.recordWorkerActivity({
        activity: "runAgentTurn",
        status: activityStatus,
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
          "opengeni.duration_ms": Math.round(durationSeconds * 1000),
        },
        error: activityError,
      });
      // Multi-account P4: flush the serving account's free per-turn caches ONCE,
      // best-effort (same discipline as today's usage write). Both writers skip
      // version/updatedAt, so neither can race the token-refresh CAS.
      if (effectiveCodexCredentialId) {
        // Part A: the latest scraped usage-header snapshot → the P2 usage cache. A
        // full both-windows snapshot (parseCodexUsageHeaders gates on both), so this
        // is byte-identical to the /wham/usage write — no partial-window clobber.
        if (latestCodexUsage) {
          await recordCodexAccountUsage(db, input.workspaceId, effectiveCodexCredentialId, latestCodexUsage)
            .catch(() => undefined);
        }
        // Part B.1: the connector namespaces codex_apps listed this turn → the
        // connector-set cache. NON-EMPTY-only: a flaky/empty tools/list must never
        // overwrite a known set with [] (false coverage drop). Read by reference
        // AFTER the run, so every tools/list this turn has accumulated.
        const connectorNamespaces = preparedTools?.codexConnectorNamespaces;
        if (connectorNamespaces && connectorNamespaces.size > 0) {
          await recordCodexAccountConnectors(db, input.workspaceId, effectiveCodexCredentialId, [...connectorNamespaces])
            .catch(() => undefined);
        }
      }
      await preparedTools?.close().catch(() => undefined);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
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
      // P4.3: finalize the on-turn recording BEFORE releasing the box handle
      // (the read+PUT needs the live session). read bytes → storage PUT →
      // updateRecording(available) → publish recording.available; the box file is
      // deleted only after the PUT confirms (F9). Best-effort: a finalize failure
      // emits recording.failed and never masks the turn outcome (F10: the bytes
      // never become a Temporal payload — read+PUT happen here in-process).
      if (activeRecording && resolvedSandbox) {
        try {
          if (!didComputerUse) {
            // Recording gate (P4.3): the turn never drove the desktop (a plain text
            // turn), so the film is a static frame of an untouched screen. DISCARD
            // it — stop ffmpeg, delete the box artifact, drop the row — with NO
            // storage PUT and NO recording.failed (a clean no-op, not a failure).
            await discardRecording({
              db,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              active: activeRecording,
              session: resolvedSandbox.established.session,
            });
          } else {
            const outcome = await finalizeRecording({
              settings,
              db,
              objectStorage,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              active: activeRecording,
              session: resolvedSandbox.established.session,
              runAs: sandboxRunAs(settings),
            });
            if (publish) {
              await publish(outcome.ok
                ? [{ type: "recording.available", payload: outcome.available }]
                : [{ type: "recording.failed", payload: { recordingId: activeRecording.recordingId, turnId: activeRecording.turnId, reason: outcome.reason, detail: outcome.detail } }]);
            }
          }
        } catch (finalizeError) {
          console.error("recording finalize failed (turn outcome unaffected)", finalizeError);
        } finally {
          activeRecording = null;
        }
      }
      if (resolvedSandbox) {
        // TURN-END mid-session snapshot (sandbox-file-persistence): fold the
        // turn's finished /workspace onto the lease before releasing the holder,
        // so the work this turn just produced survives any unclean box death in
        // the idle window ahead. Throttled by the same interval as the heartbeat
        // tick (a short turn right after a snapshot skips — bounded-loss contract
        // is the interval, not per-turn). Best-effort and time-capped by the
        // helper's own failure discipline; never delays release on failure.
        if (setupBoxSession && sandboxGroupId) {
          // Single-flight vs the heartbeat capture: the timer is already cleared
          // above, but a capture it launched may still be in flight — and that
          // capture predates the turn's final writes. Await it (it never
          // rejects; its own failure discipline caps its runtime), THEN
          // attempt; the atomic throttle decides in capture order.
          if (snapshotInFlight) {
            await snapshotInFlight;
          }
          const persisted = await maybePersistWarmWorkspaceSnapshot(
            { db, settings },
            { accountId: input.accountId, workspaceId: input.workspaceId, sandboxGroupId },
            setupBoxSession,
            resolvedSandbox.leaseEpoch,
          );
          if (persisted && publish) {
            await publish([{ type: "sandbox.box.snapshot", payload: { trigger: "turn-end" } }]).catch(() => undefined);
          }
        }
        await resolvedSandbox.release().catch((releaseError) => {
          console.error("sandbox lease release failed (turn outcome unaffected)", releaseError);
        });
        resolvedSandbox = null;   // drop the handle; the box survives the turn
      }
    }
  };
}

export function agentRunFailurePayload(error: unknown): { error: string; code?: string; retryable?: boolean; detail?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  // A ChatGPT/Codex usage cap is a HARD limit, not transient backpressure: it
  // must NOT be reported as a generic, retryable rate-limit (which would loop a
  // goal against a capped backend). Surface a precise, actionable message with
  // the humanized reset window and code, non-retryable. Checked BEFORE the
  // generic 429 branch below (a usage cap is also a 429).
  const usageLimit = classifyCodexUsageLimitError(error);
  if (usageLimit) {
    return codexUsageLimitFailurePayload(usageLimit, message);
  }
  if (status === 429 || code === "rate_limit_exceeded" || /(?:too many requests|rate.?limit|\b429\b)/i.test(message)) {
    return {
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      ...(message && message !== "Too Many Requests" ? { detail: message } : {}),
    };
  }
  return { error: message };
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
    ? `All connected ChatGPT/Codex subscriptions are rate-limited. Access returns ${humanizeResetWindow(info.resetsInSeconds)}. `
      + `You can switch this session to a different model in the meantime, or wait for a subscription to reset.`
    : `Your ChatGPT/Codex subscription usage limit has been reached. Access resets ${humanizeResetWindow(info.resetsInSeconds)}. `
      + `You can switch this session to a different model in the meantime, or wait for the limit to reset.`;
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

/**
 * Recognize an SDK stream event that represents a COMPUTER-USE tool call actually
 * executing — a `run_item_stream_event` carrying a `tool_call_item` whose
 * underlying raw item is a `computer_call` (the @openai/agents computer tool's
 * action: screenshot/click/type/scroll/drag/keypress/move/wait/…). This is the
 * same shape `normalizeSdkEvent` reads (`event.item.rawItem`), matched here against
 * the raw SDK type rather than a tool NAME so it is robust to the computer tool's
 * configured name. Drives the on-turn recording gate (no computer-use → discard).
 */
function isComputerCallStreamEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  if ((event as { type?: unknown }).type !== "run_item_stream_event") {
    return false;
  }
  const item = (event as { item?: { type?: unknown; rawItem?: { type?: unknown } } }).item;
  if (!item || item.type !== "tool_call_item") {
    return false;
  }
  return item.rawItem?.type === "computer_call";
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
  constructor(message: string, readonly serializedRunState: string | null) {
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
  if (!isCodexTurn && entitlements && (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")) {
    const decision = await entitlements.admitRun({
      accountId,
      workspaceId,
      action: "agent_run:create",
      quantity: 1,
    });
    if (!decision.allowed) {
      throw new Error(decision.reason || "insufficient OpenGeni credits");
    }
  } else if (!isCodexTurn && (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")) {
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
          throw new Error(`monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`);
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
export async function recordModelUsageAndDebitCredits(settings: Settings, db: ActivityServices["db"], input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  model: string;
  isCodexTurn: boolean;
  usage?: ModelUsageInput | null;
  sourceKey: string;
  observability?: ActivityServices["observability"];
}): Promise<void> {
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
  const fileResources = resources.filter((resource): resource is Extract<ResourceRef, { kind: "file" }> => resource.kind === "file");
  if (fileResources.length === 0) {
    return [];
  }
  if (!objectStorage) {
    throw new Error(`${settings.objectStorageBackend} file resources require configured object storage`);
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
  return (settings.sandboxBackend === "docker" && settings.objectStorageBackend === "s3-compatible")
    || settings.objectStorageBackend === "aws-s3"
    || settings.objectStorageBackend === "gcs"
    || (nativeBucketMount && settings.objectStorageBackend === "azure-blob");
}

function objectStorageForSandboxDownloads(settings: Settings, objectStorage: ObjectStorage): ObjectStorage {
  if (settings.objectStorageBackend !== "s3-compatible" || !settings.objectStorageSandboxEndpoint) {
    return objectStorage;
  }
  return createObjectStorage({
    ...settings,
    objectStorageEndpoint: settings.objectStorageSandboxEndpoint,
  }) ?? objectStorage;
}
