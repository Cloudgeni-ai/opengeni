import { type SessionAttemptQuiescenceCommit } from "@opengeni/db";
import { type TurnToolCancellationFence } from "@opengeni/runtime";
import { type GitCredentialRenewalController } from "../git-credential-renewal";
import { type RunCredentialRenewalController } from "../run-credential-renewal";
import { type CodemodeTokenRenewalController } from "../codemode-token-renewal";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnResult,
  SessionAttemptQuiescenceProof,
} from "../types";
import { type ResumedTurnSandbox } from "../../sandbox-resume";
import { type SessionEvent } from "@opengeni/contracts";
import { sleep } from "./sandbox-provision";

export function shouldRunTurnEndWorkspacePersistence(input: {
  activityStatus: RunAgentTurnResult["status"] | "unknown";
  cancellationRequested: boolean;
}): boolean {
  return input.activityStatus !== "cancelled" && !input.cancellationRequested;
}

/**
 * Periodic workspace snapshots protect work performed during a long-running
 * turn. Before the first provider request reaches the wire there is no
 * mid-turn agent work to protect; snapshotting platform setup at that point can
 * instead make the request wait behind the snapshot's workspace-write fence.
 */
export function shouldStartPeriodicWorkspaceSnapshot(input: {
  firstProviderRequestStarted: boolean;
  snapshotInFlight: boolean;
  turnEndCaptureInProgress: boolean;
}): boolean {
  return (
    input.firstProviderRequestStarted && !input.snapshotInFlight && !input.turnEndCaptureInProgress
  );
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

export const QUIESCENCE_PROOF_SIGNAL_INITIAL_RETRY_MS = 250;
export const QUIESCENCE_PROOF_SIGNAL_MAX_RETRY_MS = 5_000;
export const TURN_QUIESCENCE_WATCHDOG_MS = 5 * 60_000;

/** A fenced activity must never heartbeat forever while its physical writer
 * drain is stuck. The last-resort worker exit stops every in-process writer;
 * Kubernetes replaces the pod and the workflow's heartbeat-lease reconciler
 * then commits the exact quiescence receipt. */
export function armTurnQuiescenceWatchdog(input: {
  enabled: boolean;
  timeoutMs?: number;
  onTimeout?: () => void;
  terminateWorker: () => void;
}): () => void {
  if (!input.enabled) return () => undefined;
  let armed = true;
  const timer = setTimeout(() => {
    if (!armed) return;
    input.onTimeout?.();
    input.terminateWorker();
  }, input.timeoutMs ?? TURN_QUIESCENCE_WATCHDOG_MS);
  timer.unref?.();
  return () => {
    if (!armed) return;
    armed = false;
    clearTimeout(timer);
  };
}

/** Persist the authoritative receipt or durably hand the exact physical proof
 * to Temporal. This retries signal delivery, not DB eligibility or workflow
 * state. The proof object never changes between attempts. */
export async function persistOrSignalSessionAttemptQuiescence(input: {
  proof: SessionAttemptQuiescenceProof;
  persistReceipt: () => Promise<SessionAttemptQuiescenceCommit>;
  deliverWorkflowWake?: (
    wake: NonNullable<SessionAttemptQuiescenceCommit["workflowWake"]>,
  ) => Promise<unknown>;
  publishEvents: (events: SessionEvent[]) => Promise<unknown>;
  signalProof: ActivityServices["signalSessionAttemptQuiesced"];
  sleep?: (ms: number) => Promise<void>;
  heartbeat?: (attempt: number, delayMs: number) => void;
  onReceiptFailure?: (error: unknown) => void;
  onWakeFailure?: (error: unknown) => void;
  onPublishFailure?: (error: unknown) => void;
  onSignalFailure?: (error: unknown, attempt: number, delayMs: number) => void;
}): Promise<"receipt" | "signal"> {
  let receipt: SessionAttemptQuiescenceCommit;
  try {
    receipt = await input.persistReceipt();
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

  if (receipt.workflowWake && input.deliverWorkflowWake) {
    try {
      await input.deliverWorkflowWake(receipt.workflowWake);
    } catch (wakeError) {
      // The exact revision is already durable. Immediate delivery is latency
      // optimization only; the outbox dispatcher remains the repair path.
      input.onWakeFailure?.(wakeError);
    }
  }
  try {
    await input.publishEvents(receipt.events);
  } catch (publishError) {
    // Postgres already committed quiesced_at, the queue event, and the wake.
    // NATS is live fanout only; never misclassify its failure as receipt loss.
    input.onPublishFailure?.(publishError);
  }
  return "receipt";
}

/**
 * Cross the non-detachable physical boundary for one dying attempt. Temporal's
 * cancellation signal is intentionally absent: cancellation is transport, not
 * proof that sandbox tools and attempt-owned credential writers have drained.
 * A replacement may be admitted only after this function resolves and the
 * caller durably persists or signals the exact quiescence receipt.
 */
export async function drainAttemptOwnedSandboxWriters(input: {
  toolCancellationFence: Pick<TurnToolCancellationFence, "cancel" | "waitForQuiescence"> | null;
  cancellationReason?: unknown;
  gitCredentialRenewals: readonly Pick<GitCredentialRenewalController, "stop">[];
  codemodeTokenRenewal: Pick<CodemodeTokenRenewalController, "stop"> | null;
  runCredentialRenewal: Pick<RunCredentialRenewalController, "stop"> | null;
}): Promise<void> {
  if (input.toolCancellationFence) {
    input.toolCancellationFence.cancel(
      input.cancellationReason ?? new Error("TURN_ATTEMPT_FENCED"),
    );
    await input.toolCancellationFence.waitForQuiescence();
  }
  await Promise.all(input.gitCredentialRenewals.map(async (renewal) => await renewal.stop()));
  await input.codemodeTokenRenewal?.stop();
  await input.runCredentialRenewal?.stop();
}

/** Persist the exact turn's second-stage release only after the caller has
 * crossed the physical writer boundary. This wait is intentionally independent
 * of Temporal cancellation: it is a short idempotent DB transaction that closes
 * the durable archive-capture fence. Bounded retries cover a rollout connection
 * reset without turning ordinary finalizer housekeeping into lifecycle state. */
export async function releaseTurnSandboxAfterWriterDrain(
  sandbox: Pick<ResumedTurnSandbox, "release">,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 50);
  const wait = options.wait ?? sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await sandbox.release({ workspaceWritersQuiesced: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await wait(retryDelayMs * attempt);
      }
    }
  }
  throw lastError;
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

export class IncompleteAgentStreamError extends Error {
  readonly name = "IncompleteAgentStreamError";

  constructor(message = "Agent stream ended without a successful terminal output") {
    super(message);
  }
}

/**
 * Prove that SDK completion authority did not report a failure or runtime
 * cancellation. The Agents SDK closes its ReadableStream immediately when its
 * run signal aborts, so iterator EOF is not completion authority: the separate
 * `completed` promise carries the eventual run failure.
 *
 * Only Temporal cancellation detaches cleanup. Internal runtime cancellation
 * such as a provider-deadline sandbox rotation must escape to the turn failure
 * settlement path, which checkpoints and redispatches the same logical turn.
 */
export async function assertSuccessfulAgentStreamCompletion(input: {
  batcherFlush: Promise<unknown>;
  stream: {
    completed: Promise<void>;
    error: unknown;
  };
  temporalCancellationSignal: AbortSignal | undefined;
  runtimeCancellationSignal: AbortSignal;
}): Promise<void> {
  await waitForTurnStreamCleanup(
    input.batcherFlush,
    input.stream.completed,
    input.temporalCancellationSignal,
  );

  if (input.runtimeCancellationSignal.aborted) {
    throw (
      input.runtimeCancellationSignal.reason ??
      new IncompleteAgentStreamError("Agent stream was cancelled without a terminal reason")
    );
  }
  if (input.stream.error !== null && input.stream.error !== undefined) {
    throw input.stream.error;
  }
}

/** Call after any more-specific empty-stream recovery has had priority. */
export function assertAgentStreamNotCancelled(cancelled: boolean): void {
  if (cancelled) {
    throw new IncompleteAgentStreamError("Agent stream was cancelled without a terminal result");
  }
}

/** Interruption streams do not produce a normal final output. Call this only
 * after the interruption branch has settled any required action. */
export function requireAgentStreamFinalOutput(finalOutput: unknown | undefined): unknown {
  if (finalOutput === undefined) {
    throw new IncompleteAgentStreamError();
  }
  return finalOutput;
}

/**
 * Terminal settlement closes the active attempt before turn finalization. The
 * ordinary workspace admission therefore correctly returns `attempt_fenced`
 * for the final attempt-qualified credential deletion. Retry only that exact
 * settled-attempt case directly; every other fence/status and the direct
 * deletion itself remain fail-closed.
 */
export async function clearAttemptCredentialsWithSettledFence(input: {
  activityStatus: RunAgentTurnResult["status"] | "unknown";
  runWorkspaceFencedClear: () => Promise<void>;
  clearExactAttempt: () => Promise<void>;
  onSettledAttemptFence: () => void;
}): Promise<void> {
  try {
    await input.runWorkspaceFencedClear();
  } catch (error) {
    const settledAttemptFence =
      error instanceof Error &&
      error.name === "SandboxWorkspaceMutationFencedError" &&
      (error as Error & { code?: unknown }).code === "attempt_fenced" &&
      (input.activityStatus === "idle" ||
        input.activityStatus === "failed" ||
        input.activityStatus === "cancelled");
    if (!settledAttemptFence) throw error;
    input.onSettledAttemptFence();
    await input.clearExactAttempt();
  }
}

export function turnFinalizerCancellationSignal(
  temporalSignal: AbortSignal | undefined,
  activityStatus: RunAgentTurnResult["status"] | "unknown",
): AbortSignal | undefined {
  if (activityStatus !== "cancelled" || temporalSignal?.aborted) return temporalSignal;
  const fenced = new AbortController();
  fenced.abort(new Error("TURN_ATTEMPT_FENCED"));
  return fenced.signal;
}

export type MandatoryHistoryPersistenceStage = "history_append" | "sandbox_envelope";

/**
 * Preserve the exact storage failure for the permission-controlled turn event
 * while attaching only a stable, non-secret operation token to public worker
 * diagnostics. Mandatory history failures remain terminal and never inherit a
 * provider-retry classification from coincidental source text or status.
 */
export class MandatoryHistoryPersistenceError extends Error {
  readonly name = "MandatoryHistoryPersistenceError";
  readonly cause: unknown;

  constructor(
    readonly stage: MandatoryHistoryPersistenceStage,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

export async function runMandatoryHistoryPersistenceStep<T>(
  stage: MandatoryHistoryPersistenceStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new MandatoryHistoryPersistenceError(stage, cause);
  }
}

export type OpStreamFinalizer = {
  finalizeOpStreamOps(): Promise<void>;
};

/** Release retained Connected Machine output only after the turn is durable. */
export async function finalizeDurableTurnOpStreams(
  sessions: readonly unknown[],
  fallback: OpStreamFinalizer | null,
): Promise<void> {
  const candidates = new Set<OpStreamFinalizer>();
  for (const session of sessions) {
    const candidate = session as Partial<OpStreamFinalizer> | null;
    if (typeof candidate?.finalizeOpStreamOps === "function") {
      candidates.add(candidate as OpStreamFinalizer);
    }
  }
  if (candidates.size === 0 && fallback) {
    candidates.add(fallback);
  }
  for (const candidate of candidates) {
    try {
      await candidate.finalizeOpStreamOps();
    } catch {
      // The runner's retention TTL owns the fallback.
    }
  }
}
