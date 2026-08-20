import {
  SandboxLeaseRecoveryBlockedError,
  SandboxLeaseSupersededError,
  SandboxLeaseTransitionError,
  SandboxImageConflictError,
  SandboxRigConflictError,
} from "@opengeni/db";
import {
  SandboxConfigError,
  SandboxExactResumeInstanceUnavailableError,
  SandboxExactResumeReplacedError,
  SandboxExecReadinessError,
  SandboxProviderContinuityUnavailableError,
  SandboxProviderUnavailableError,
  SandboxResumeIdentityMismatchError,
  SandboxResumeIdentityUnavailableError,
  SandboxResumeStateUnavailableError,
  WorkspaceArchiveIntegrityError,
  classifyProviderSandboxFailure,
} from "@opengeni/runtime";
import { type Settings } from "@opengeni/config";
import { CancelledFailure } from "@temporalio/activity";
import {
  sandboxProvisionFailureStage,
  SandboxProvisionStageError,
  SandboxWarmingTimeoutError,
} from "../../sandbox-resume";
import {
  type SandboxLogicalProvisionCategory,
  type SandboxLogicalProvisionStage,
} from "../../observability-metrics";
import { randomUUID } from "node:crypto";

export type TurnSandboxProvisioner<T> = {
  get(): Promise<T>;
  hasStarted(): boolean;
  waitForSettled(timeoutMs: number): Promise<T | null>;
};

export type SandboxLogicalProvisionFailure = {
  category: SandboxLogicalProvisionCategory;
  stage: SandboxLogicalProvisionStage;
  code: string;
  expected: boolean;
  retryable: boolean;
};

export type TurnSandboxProvisionAttempt<T = unknown> = {
  provisionId: string;
  attempt: number;
  outcome: "completed" | "retrying" | "failed";
  durationMs: number;
  result?: T;
  error?: unknown;
};

export type TurnSandboxProvisionSettlement = {
  provisionId: string;
  internalAttempts: number;
  durationMs: number;
};

export class TurnOperationCancelledError extends Error {
  readonly name = "TurnOperationCancelledError";

  constructor(readonly reason: unknown) {
    super("Turn operation was cancelled with its owning turn", {
      ...(reason instanceof Error ? { cause: reason } : {}),
    });
  }
}

export class SandboxDeadlineRotationError extends Error {
  readonly name = "SandboxDeadlineRotationError";

  constructor(
    readonly sandboxGroupId: string,
    readonly leaseEpoch: number,
  ) {
    super(
      `Sandbox ${sandboxGroupId} reached its provider rotation boundary at lease epoch ${leaseEpoch}`,
    );
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

export function throwIfTurnOperationCancelled(signal: AbortSignal | undefined): void {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sandboxProvisionErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    chain.push(current);
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    if (current instanceof SandboxProvisionStageError) {
      current = current.source;
      continue;
    }
    const cause = Reflect.get(current, "cause");
    if (cause === undefined || cause === current) break;
    current = cause;
  }
  return chain;
}

export function firstProvisionError<T>(
  chain: readonly unknown[],
  constructor: abstract new (...args: never[]) => T,
): T | null {
  return chain.find((value): value is T => value instanceof constructor) ?? null;
}

/**
 * Closed, structural taxonomy for one logical provision failure. The classifier
 * follows only typed wrapper/cause links and provider status/code fields; it
 * never infers lifecycle truth from an arbitrary error message.
 */
export function classifySandboxLogicalProvisionFailure(
  backend: string,
  error: unknown,
): SandboxLogicalProvisionFailure {
  const chain = sandboxProvisionErrorChain(error);
  const wrappedStage =
    chain.map((value) => sandboxProvisionFailureStage(value)).find((stage) => stage !== null) ??
    null;
  const warming =
    chain.find(
      (value): value is SandboxWarmingTimeoutError => value instanceof SandboxWarmingTimeoutError,
    ) ?? null;
  if (warming) {
    const execReadiness = warming.stage === "exec_readiness";
    return {
      category: execReadiness ? "exec_readiness" : "sibling_warming",
      stage: execReadiness ? "exec_readiness" : "sibling_warming",
      code: warming.code,
      expected: false,
      retryable: false,
    };
  }
  const readiness = firstProvisionError(chain, SandboxExecReadinessError);
  if (readiness) {
    return {
      category: "exec_readiness",
      stage: "exec_readiness",
      code: readiness.code,
      expected: false,
      retryable: false,
    };
  }
  const superseded = firstProvisionError(chain, SandboxLeaseSupersededError);
  if (superseded) {
    return {
      category: "lease_superseded",
      stage: "lease_admission",
      code: "lease_superseded",
      expected: true,
      retryable: true,
    };
  }
  const transition = firstProvisionError(chain, SandboxLeaseTransitionError);
  if (transition) {
    return {
      category: "drain_capture_wait",
      stage: "lifecycle_wait",
      code: transition.reason,
      expected: true,
      retryable: true,
    };
  }
  const deadlineRotation = firstProvisionError(chain, SandboxDeadlineRotationError);
  if (deadlineRotation) {
    return {
      category: "drain_capture_wait",
      stage: "lifecycle_wait",
      code: "provider_deadline_rotation",
      expected: true,
      retryable: false,
    };
  }
  const recoveryBlocked = firstProvisionError(chain, SandboxLeaseRecoveryBlockedError);
  if (recoveryBlocked) {
    return {
      category: "archive_recovery",
      stage: "archive_recovery",
      code: recoveryBlocked.code,
      expected: false,
      retryable: false,
    };
  }
  const archive = firstProvisionError(chain, WorkspaceArchiveIntegrityError);
  if (archive) {
    return {
      category: "archive_recovery",
      stage: "archive_recovery",
      code: archive.code,
      expected: false,
      retryable: archive.retryable,
    };
  }
  const continuity = firstProvisionError(chain, SandboxProviderContinuityUnavailableError);
  if (continuity) {
    return {
      category: "archive_recovery",
      stage: "archive_recovery",
      code: "provider_continuity_unavailable",
      expected: false,
      retryable: continuity.retryable,
    };
  }
  const configuration = chain.find(
    (value) =>
      value instanceof SandboxConfigError ||
      value instanceof SandboxProviderUnavailableError ||
      value instanceof SandboxImageConflictError ||
      value instanceof SandboxRigConflictError,
  );
  if (configuration) {
    return {
      category: "configuration",
      stage: wrappedStage ?? "configuration",
      code:
        configuration instanceof SandboxImageConflictError
          ? "image_conflict"
          : configuration instanceof SandboxRigConflictError
            ? "rig_conflict"
            : configuration instanceof SandboxProviderUnavailableError
              ? "provider_unavailable"
              : "sandbox_config",
      expected: false,
      retryable: false,
    };
  }
  const resumeFailure = chain.find(
    (value) =>
      value instanceof SandboxResumeStateUnavailableError ||
      value instanceof SandboxResumeIdentityMismatchError ||
      value instanceof SandboxResumeIdentityUnavailableError ||
      value instanceof SandboxExactResumeReplacedError ||
      value instanceof SandboxExactResumeInstanceUnavailableError,
  );
  if (resumeFailure) {
    return {
      category: "resume",
      stage: "resume",
      code:
        resumeFailure instanceof SandboxResumeStateUnavailableError
          ? "resume_state_unavailable"
          : resumeFailure instanceof SandboxResumeIdentityMismatchError
            ? "resume_identity_mismatch"
            : resumeFailure instanceof SandboxResumeIdentityUnavailableError
              ? "resume_identity_unavailable"
              : resumeFailure instanceof SandboxExactResumeReplacedError
                ? "exact_resume_replaced"
                : "exact_resume_instance_unavailable",
      expected: false,
      retryable: false,
    };
  }
  const providerFailure = classifyProviderSandboxFailure(backend, error);
  if (providerFailure.kind === "transient_transport") {
    return {
      category: "provider_transport",
      stage: wrappedStage ?? "provider_transport",
      code: providerFailure.diagnostic,
      expected: false,
      // A typed transport fault is attributable, but a create outcome may be
      // ambiguous. Classification never licenses replay on its own.
      retryable: false,
    };
  }
  if (wrappedStage) {
    return {
      category: wrappedStage,
      stage: wrappedStage,
      code: `${wrappedStage}_failed`,
      expected: false,
      retryable: false,
    };
  }
  return {
    category: "unknown",
    stage: "unknown",
    code: "unknown",
    expected: false,
    retryable: false,
  };
}

export function isLazySandboxProvisionRetryable(error: unknown): boolean {
  const chain = sandboxProvisionErrorChain(error);
  if (
    chain.some(
      (value) =>
        value instanceof SandboxImageConflictError ||
        value instanceof SandboxRigConflictError ||
        value instanceof SandboxLeaseRecoveryBlockedError,
    )
  ) {
    return false;
  }
  const archive = firstProvisionError(chain, WorkspaceArchiveIntegrityError);
  if (archive) {
    return archive.retryable;
  }
  if (
    chain.some(
      (value) =>
        value instanceof SandboxLeaseSupersededError ||
        value instanceof SandboxLeaseTransitionError,
    )
  ) {
    return true;
  }
  if (chain.some((value) => value instanceof SandboxWarmingTimeoutError)) {
    return false;
  }
  // Provider/transport text is not durable evidence that creation never
  // happened. Retrying an ambiguous unknown here can create a second box; only
  // typed, ownership-fenced lifecycle outcomes above are safe to replay.
  return false;
}

/** Short workflow-visible anti-churn pacing after a lifecycle transition. The
 * next acquire waits on the exact durable claim itself, so this is deliberately
 * not a guessed snapshot-plus-schedules completion time. */
export function sandboxDeadlineRotationRecoveryDelayMs(
  settings: Pick<Settings, "sandboxLeaseReaperPeriodMs">,
): number {
  // The next attempt waits on the durable lifecycle claim itself. This delay is
  // only anti-churn pacing, not an estimate of snapshot + future schedules.
  return Math.min(5_000, settings.sandboxLeaseReaperPeriodMs);
}

export function createTurnSandboxProvisioner<T>(
  establish: () => Promise<T>,
  options: {
    maxRetries?: number;
    backoffMs?: number;
    signal?: AbortSignal;
    provisionIdFactory?: () => string;
    onStarted?: (
      settlement: Pick<TurnSandboxProvisionSettlement, "provisionId">,
    ) => Promise<void> | void;
    onAttemptSettled?: (attempt: TurnSandboxProvisionAttempt<T>) => Promise<void> | void;
    beforeCompleted?: (
      result: T,
      settlement: TurnSandboxProvisionSettlement,
    ) => Promise<void> | void;
    onCompleted?: (result: T, settlement: TurnSandboxProvisionSettlement) => Promise<void> | void;
    onFailed?: (error: unknown, settlement: TurnSandboxProvisionSettlement) => Promise<void> | void;
    disposeResult?: (result: T) => Promise<void> | void;
  } = {},
): TurnSandboxProvisioner<T> {
  const maxRetries = options.maxRetries ?? 2;
  const backoffMs = options.backoffMs ?? 250;
  let memo: Promise<T> | null = null;

  const run = async (
    provisionId: string,
    onAttempt: (attempt: number) => void,
  ): Promise<{ result: T; internalAttempts: number }> => {
    let internalAttempts = 0;
    while (true) {
      internalAttempts += 1;
      onAttempt(internalAttempts);
      const startedAt = performance.now();
      try {
        throwIfTurnOperationCancelled(options.signal);
        const operation = establish();
        const result = await waitForTurnOperation(operation, options.signal, options.disposeResult);
        await options.onAttemptSettled?.({
          provisionId,
          attempt: internalAttempts,
          outcome: "completed",
          durationMs: performance.now() - startedAt,
          result,
        });
        return { result, internalAttempts };
      } catch (error) {
        const retrying = !(
          error instanceof TurnOperationCancelledError ||
          internalAttempts > maxRetries ||
          !isLazySandboxProvisionRetryable(error)
        );
        await options.onAttemptSettled?.({
          provisionId,
          attempt: internalAttempts,
          outcome: retrying ? "retrying" : "failed",
          durationMs: performance.now() - startedAt,
          error,
        });
        if (!retrying) {
          throw error;
        }
        await sleep(backoffMs * internalAttempts);
      }
    }
  };

  return {
    get(): Promise<T> {
      if (!memo) {
        const provisionId = options.provisionIdFactory?.() ?? randomUUID();
        memo = (async () => {
          const startedAt = performance.now();
          throwIfTurnOperationCancelled(options.signal);
          await options.onStarted?.({ provisionId });
          throwIfTurnOperationCancelled(options.signal);
          let result: T | undefined;
          let internalAttempts = 0;
          let hasResult = false;
          try {
            const runResult = await run(provisionId, (attempt) => {
              internalAttempts = attempt;
            });
            result = runResult.result;
            internalAttempts = runResult.internalAttempts;
            hasResult = true;
            throwIfTurnOperationCancelled(options.signal);
            await options.beforeCompleted?.(result, {
              provisionId,
              internalAttempts,
              durationMs: performance.now() - startedAt,
            });
            throwIfTurnOperationCancelled(options.signal);
            await options.onCompleted?.(result, {
              provisionId,
              internalAttempts,
              durationMs: performance.now() - startedAt,
            });
            return result;
          } catch (error) {
            if (hasResult) {
              await options.disposeResult?.(result as T);
            }
            if (!(error instanceof TurnOperationCancelledError)) {
              await options.onFailed?.(error, {
                provisionId,
                internalAttempts: Math.max(1, internalAttempts),
                durationMs: performance.now() - startedAt,
              });
            }
            throw error;
          }
        })().catch((error) => {
          // A terminal lease/archive/configuration result cannot change within
          // this frozen turn. Keep its rejected promise memoized so later model
          // tool calls observe the same typed result without re-entering
          // provisioning, emitting another failure event, or creating another
          // provider attempt. Only a retryable failure releases the single-flight
          // for a later operation to re-read the lease/provider state.
          if (isLazySandboxProvisionRetryable(error)) {
            memo = null;
          }
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
