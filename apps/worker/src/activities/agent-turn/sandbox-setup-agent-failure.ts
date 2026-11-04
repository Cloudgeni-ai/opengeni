import {
  isMachineProcessStartFailureMessage,
  processStartFailureNullDeviceNote,
  sanitizeProcessStartFailureMessage,
  SelfhostedControlError,
} from "@opengeni/runtime";
import { CancelledFailure } from "@temporalio/activity";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";

/**
 * Platform sandbox setup (credential hooks, client readiness, repository
 * clones, file delivery) failed because the sandbox's machine agent was not
 * answering: offline, reconnecting, draining, timed out or replaced. Setup
 * runs before any model-requested command can reach the box, and every hook
 * it ran is idempotent, so the same turn may run it again after a short delay.
 * Only `withSandboxSetupAgentRecovery` creates it.
 */
export class SandboxSetupAgentUnavailableError extends Error {
  override readonly name = "SandboxSetupAgentUnavailableError";

  constructor(cause: unknown) {
    super(
      `The sandbox's agent did not answer while the sandbox was being set up: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** A machine-agent liveness failure, not an answer from the agent. An
 * agent-returned error (a failed command, a missing path, consent, an oversized
 * reply) or an epoch fence is a real outcome, never a liveness blip. */
function isAgentLivenessControlError(node: unknown): boolean {
  if (!(node instanceof SelfhostedControlError)) return false;
  if (node.fenced || node.osNotFound || node.payloadTooLarge) return false;
  if (node.reason === "consent_required") return false;
  return (
    node.agentOffline ||
    node.connectionReplaced ||
    node.draining ||
    node.reason === "agent_offline" ||
    node.reason === "agent_reconnecting"
  );
}

/** Whether a machine-agent liveness failure appears anywhere in the error's
 * cause graph (`cause`, the agents SDK's `.error`, AggregateError members). */
export function isSandboxAgentLivenessFailure(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  try {
    for (let index = 0; index < queue.length && seen.size < 64; index += 1) {
      const node = queue[index];
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (isAgentLivenessControlError(node)) return true;
      const record = node as { cause?: unknown; error?: unknown; errors?: unknown };
      queue.push(record.cause, record.error);
      if (Array.isArray(record.errors)) queue.push(...record.errors.slice(0, 16));
    }
  } catch {
    // An unreadable graph never grants retry authority.
  }
  return false;
}

type SharedRigSetupCoordinator = (input: {
  specHash: string;
  timeoutMs: number;
  execute: () => Promise<void>;
}) => Promise<"executed" | "reused">;

/**
 * Tracks whether one setup run stayed replay safe. Every setup hook is
 * idempotent except the rig setup script, which runs user-defined commands:
 * once it has started without finishing, a liveness failure leaves the setup
 * failed rather than retrying it.
 */
export function createSandboxSetupReplayGuard() {
  let rigScriptUnfinished = false;
  return {
    /** Wrap the shared rig setup coordinator so the guard sees its script run. */
    trackRigSetup(coordinator: SharedRigSetupCoordinator): SharedRigSetupCoordinator {
      return async (input) =>
        await coordinator({
          ...input,
          execute: async () => {
            rigScriptUnfinished = true;
            await input.execute();
            rigScriptUnfinished = false;
          },
        });
    },
    replaySafe(): boolean {
      return !rigScriptUnfinished;
    },
  };
}

export type SandboxSetupReplayGuard = ReturnType<typeof createSandboxSetupReplayGuard>;

/**
 * The error a failed platform setup throws: a machine-agent liveness failure
 * becomes the typed setup failure the turn recovers from. Any other failure,
 * and a liveness failure after a non-idempotent step started, stays unchanged.
 */
export function sandboxSetupFailure(guard: SandboxSetupReplayGuard, error: unknown): unknown {
  if (
    !(error instanceof SandboxSetupAgentUnavailableError) &&
    guard.replaySafe() &&
    isSandboxAgentLivenessFailure(error)
  ) {
    return new SandboxSetupAgentUnavailableError(error);
  }
  return error;
}

/** The recovery code of a turn whose sandbox is being restarted because it
 * could not start programs. */
export const SANDBOX_MACHINE_RESTARTING_CODE = "sandbox_machine_restarting";
/** The terminal code of a turn whose sandbox cannot start programs. */
export const SANDBOX_PROCESS_START_FAILED_CODE = "sandbox_process_start_failed";

/** Whether the machine's inability to start programs appears anywhere in the
 * error's cause graph: a typed agent answer, or its stable marker in a
 * wrapper's message (older wrappers keep only the text). One missing program
 * is not that: it keeps its ordinary handling. */
export function isSandboxProcessStartFailure(error: unknown): boolean {
  return findProcessStartFailure(error) !== null;
}

function findProcessStartFailure(error: unknown): Error | null {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  try {
    for (let index = 0; index < queue.length && seen.size < 64; index += 1) {
      const node = queue[index];
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (node instanceof SelfhostedControlError) {
        if (node.processStartFailed) return node;
      } else if (node instanceof Error && isMachineProcessStartFailureMessage(node.message)) {
        return node;
      }
      const record = node as { cause?: unknown; error?: unknown; errors?: unknown };
      queue.push(record.cause, record.error);
      if (Array.isArray(record.errors)) queue.push(...record.errors.slice(0, 16));
    }
  } catch {
    // An unreadable graph is not a process-start failure.
  }
  return null;
}

/**
 * Platform setup failed because the sandbox could no longer start programs,
 * and the worker restarted it (files kept, programs ended). Nothing the model
 * asked for ran, so the same turn retries once the box is back.
 */
export class SandboxMachineRestartingError extends Error {
  override readonly name = "SandboxMachineRestartingError";

  constructor(cause: unknown) {
    super(
      "The workspace machine couldn't start programs, so it was restarted. Your files are kept; programs that were running stopped. The same turn continues once it is back.",
      { cause },
    );
  }
}

/** Where the machine that cannot start programs runs, for the person's copy. */
export type SandboxProcessStartMachine = "compute" | "connected_machine" | "other";

/**
 * The sandbox cannot start programs and the worker will not restart it
 * (again): a restart already happened this turn, the machine is the person's
 * own, or the restart itself failed. The turn stops with copy that says what
 * to do, never the agent's raw text.
 */
export class SandboxProcessStartFailedError extends Error {
  override readonly name = "SandboxProcessStartFailedError";
  readonly machine: SandboxProcessStartMachine;
  /** Diagnostic only: the sanitized agent message and any restart failure. */
  readonly detail: string;

  constructor(
    cause: unknown,
    input: {
      machine: SandboxProcessStartMachine;
      restartedThisTurn: boolean;
      /** A restart was tried and failed (not merely skipped). */
      restartAttemptFailed?: boolean;
      restartFailure?: string;
    },
  ) {
    const found = findProcessStartFailure(cause);
    // A wrapper keeps the agent's raw text, which older agents filled with
    // the whole command: only its sanitized form is kept.
    const agentMessage = sanitizeProcessStartFailureMessage(
      found?.message ?? (cause instanceof Error ? cause.message : String(cause)),
    ).slice(0, 2_000);
    super(
      processStartFailedCopy(
        input.machine,
        input.restartedThisTurn,
        input.restartAttemptFailed ?? false,
        agentMessage,
      ),
      { cause },
    );
    this.machine = input.machine;
    this.detail = input.restartFailure
      ? `${agentMessage} (restart failed: ${input.restartFailure})`
      : agentMessage;
  }
}

function processStartFailedCopy(
  machine: SandboxProcessStartMachine,
  restartedThisTurn: boolean,
  restartAttemptFailed: boolean,
  agentMessage: string,
): string {
  if (machine === "connected_machine") {
    const nullDevice = processStartFailureNullDeviceNote(agentMessage);
    return nullDevice
      ? `Your connected machine can't start programs because ${nullDevice}. Restart the machine to restore it, then retry.`
      : "Your connected machine can't start programs. Restart the machine, then retry.";
  }
  if (restartedThisTurn) {
    return "The workspace machine still can't start programs after it was restarted, so this turn stopped. Retry once more, or start a new chat if it keeps failing.";
  }
  if (restartAttemptFailed) {
    return "The workspace machine can't start programs and couldn't be restarted, so this turn stopped. Retry in a moment, or start a new chat if it keeps failing.";
  }
  return "The workspace machine can't start programs, so this turn stopped. Retry, or start a new chat if it keeps failing.";
}

/** A sandbox session that can boot its box afresh (compute). */
type RestartableMachine = { backendId: "compute"; restartMachine(): Promise<void> };

function restartableMachine(session: unknown): RestartableMachine | null {
  if (!session || typeof session !== "object") return null;
  const candidate = session as { backendId?: unknown; restartMachine?: unknown };
  return candidate.backendId === "compute" && typeof candidate.restartMachine === "function"
    ? (session as RestartableMachine)
    : null;
}

export type SandboxProcessStartRecovery = {
  /** The established sandbox session the setup ran against. */
  session: unknown;
  /** The turn's sandbox backend ("compute", "selfhosted", ...). */
  backend: string | null | undefined;
  /** Restarts this turn already made for this reason (durable). */
  restartsThisTurn: () => Promise<number>;
  /** Publish the restart's `sandbox.operation.*` events (durable). */
  publish: (
    events: Array<{
      type:
        | "sandbox.operation.started"
        | "sandbox.operation.completed"
        | "sandbox.operation.failed";
      payload: Record<string, unknown>;
    }>,
  ) => Promise<void>;
  /** The operation name the guard counts. */
  operationName: string;
};

/**
 * The error a failed platform setup throws, with process-start recovery: when
 * the sandbox cannot start programs, a compute box is restarted at most once
 * per turn and the turn retries; any other case stops the turn with short,
 * actionable copy. Liveness failures keep their own recovery.
 */
export async function recoverSandboxSetupFailure(
  guard: SandboxSetupReplayGuard,
  error: unknown,
  recovery: SandboxProcessStartRecovery,
): Promise<unknown> {
  const mapped = sandboxSetupFailure(guard, error);
  if (mapped !== error) return mapped;
  if (
    error instanceof SandboxMachineRestartingError ||
    error instanceof SandboxProcessStartFailedError ||
    !isSandboxProcessStartFailure(error)
  ) {
    return error;
  }
  const machine = restartableMachine(recovery.session);
  if (!machine) {
    return new SandboxProcessStartFailedError(error, {
      machine: recovery.backend === "selfhosted" ? "connected_machine" : "other",
      restartedThisTurn: false,
    });
  }
  if (!guard.replaySafe()) {
    return new SandboxProcessStartFailedError(error, {
      machine: "compute",
      restartedThisTurn: false,
      restartFailure: "a setup script had started, so the setup is not replayed",
    });
  }
  let restarts: number;
  try {
    restarts = await recovery.restartsThisTurn();
  } catch (countError) {
    // Without proof that no restart happened, never risk a restart loop.
    return new SandboxProcessStartFailedError(error, {
      machine: "compute",
      restartedThisTurn: false,
      restartFailure: `could not read earlier restarts: ${errorText(countError)}`,
    });
  }
  if (restarts > 0) {
    return new SandboxProcessStartFailedError(error, {
      machine: "compute",
      restartedThisTurn: true,
    });
  }
  const name = recovery.operationName;
  try {
    // Recorded before the restart, so a crash during it still counts.
    await recovery.publish([
      { type: "sandbox.operation.started", payload: { name, reason: "process_start_failed" } },
    ]);
  } catch (publishError) {
    // A fenced or cancelled attempt stops as such; nothing was restarted.
    if (isAttemptStop(publishError)) return publishError;
    return new SandboxProcessStartFailedError(error, {
      machine: "compute",
      restartedThisTurn: false,
      restartFailure: `could not record the restart: ${errorText(publishError)}`,
    });
  }
  try {
    await machine.restartMachine();
  } catch (restartError) {
    await recovery
      .publish([
        {
          type: "sandbox.operation.failed",
          payload: { name, error: errorText(restartError) },
        },
      ])
      .catch(() => undefined);
    return new SandboxProcessStartFailedError(error, {
      machine: "compute",
      restartedThisTurn: false,
      restartAttemptFailed: true,
      restartFailure: errorText(restartError),
    });
  }
  await recovery
    .publish([{ type: "sandbox.operation.completed", payload: { name } }])
    .catch(() => undefined);
  return new SandboxMachineRestartingError(error);
}

/** A lost attempt (fenced, superseded) or a cancelled operation: never
 * reported as a machine failure. */
function isAttemptStop(error: unknown): boolean {
  return (
    error instanceof TurnAttemptFencedError ||
    error instanceof CancelledFailure ||
    (error instanceof Error && error.name === "TurnOperationCancelledError")
  );
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 300);
}
