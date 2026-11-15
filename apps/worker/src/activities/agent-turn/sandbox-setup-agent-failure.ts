import {
  type Database,
  requestSandboxProcessStartReplacement,
  SandboxLeaseTransitionError,
} from "@opengeni/db";
import {
  isMachineProcessStartFailureMessage,
  isModalShellStartFailureMessage,
  isProcessStartFailureMessage,
  MISSING_SHELL_NOTE,
  processStartFailureMachineNote,
  sandboxCommandExitCode,
  sandboxCommandOutput,
  sanitizeModalShellStartFailureMessage,
  sanitizeProcessStartFailureMessage,
  SelfhostedControlError,
  type UnresponsiveAgentRecovery,
  type UnresponsiveComputeMachine,
} from "@opengeni/runtime";
import { ComputeControlError } from "@opengeni/runtime/sandbox";
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
 * wrapper's message (older wrappers keep only the text), or Modal's answer
 * for an exec whose /bin/sh cannot load (Modal runs every command through
 * it). One missing program is not that: it keeps its ordinary handling. */
export function isSandboxProcessStartFailure(error: unknown): boolean {
  return findProcessStartFailure(error) !== null;
}

function findProcessStartFailure(error: unknown): Error | null {
  return findInCauseGraph(error, (node) =>
    node instanceof SelfhostedControlError
      ? node.processStartFailed
      : isMachineProcessStartFailureMessage(node.message) ||
        isModalShellStartFailureMessage(node.message),
  );
}

/** A process-start failure on one bounded line with nothing from the
 * command: the program's name from a machine agent, or Modal's stable tail
 * (its message repeats the whole command). */
export function sanitizeSandboxProcessStartMessage(message: string): string {
  return isModalShellStartFailureMessage(message)
    ? sanitizeModalShellStartFailureMessage(message)
    : sanitizeProcessStartFailureMessage(message);
}

/** The probe ran the shell builtin `true` in the default working directory,
 * so any process start that failed with ENOENT means the machine cannot start
 * programs, whatever the agent named: an older agent reports `for true`,
 * which elsewhere would read as one missing program. */
function probeCannotStartPrograms(error: unknown): boolean {
  return (
    findInCauseGraph(
      error,
      (node) =>
        isProcessStartFailureMessage(node.message) && /\(os error 2\)\s*$/.test(node.message),
    ) !== null
  );
}

function findInCauseGraph(error: unknown, matches: (node: Error) => boolean): Error | null {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  try {
    for (let index = 0; index < queue.length && seen.size < 64; index += 1) {
      const node = queue[index];
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (node instanceof Error && matches(node)) return node;
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

/**
 * Platform setup failed because the sandbox could not start programs, but the
 * worker's check did not show it still broken (it starts programs again, or
 * its agent is offline or waking, as after another session's restart of a
 * shared box), so it was not restarted. Nothing the model asked for ran, so
 * the same turn retries within the ordinary sandbox recovery budget.
 */
export class SandboxMachineBackError extends Error {
  override readonly name = "SandboxMachineBackError";

  constructor(cause: unknown, reason: "works_again" | "already_replaced" = "works_again") {
    super(
      reason === "already_replaced"
        ? "The workspace machine couldn't start programs, and nothing the model asked for ran. It has already been replaced, so the same turn will retry on the new one after a short delay."
        : "The workspace machine couldn't start programs, and nothing the model asked for ran. It wasn't restarted, because a check didn't confirm it is still broken; the same turn will retry after a short delay.",
      { cause },
    );
  }
}

/** Where the machine that cannot start programs runs, for the person's copy. */
export type SandboxProcessStartMachine = "compute" | "modal" | "connected_machine" | "other";

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
    const agentMessage = sanitizeSandboxProcessStartMessage(
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
    const note = processStartFailureMachineNote(agentMessage);
    if (note === MISSING_SHELL_NOTE) {
      return "Your connected machine can't start programs because /bin/sh is missing. Put it back on the machine, then retry.";
    }
    return note
      ? `Your connected machine can't start programs because ${note}. Restart the machine to restore it, then retry.`
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

/** A sandbox session whose box can be started afresh: compute reboots it
 * from its disk; Modal replaces it with a new box restored from the saved
 * /workspace. `exec` (or `execCommand`) runs a command on the box, which
 * shows whether it can start programs again. */
type RestartableMachine = {
  backendId: "compute" | "modal";
  restartMachine?(): Promise<void>;
  exec?: (args: { cmd: string }) => Promise<unknown>;
  execCommand?: (args: { cmd: string }) => Promise<unknown>;
};

/** A Modal box's replacement, requested from the lease: the turn waits for
 * this lifecycle transition and then continues on the restored box. */
export type SandboxBoxReplacement = {
  sandboxGroupId: string;
  leaseEpoch: number;
  instanceId: string;
  liveness: "warm" | "draining";
};

/** How long the box gets to start one trivial program before a restart. */
const START_PROBE_TIMEOUT_MS = 30_000;

/**
 * Whether the box can start a trivial program now. Several sessions can share
 * one box, so another session's turn may have restarted it since this setup
 * failed; restarting it again would stop that session's running programs.
 * Only a probe that itself fails to start a program shows the box is still
 * broken ("cannot"). One that starts ("starts"), or that cannot tell (the
 * agent is offline or reconnecting, the box is still waking from another
 * session's restart, no answer within the bound), never restarts it.
 */
async function probeProgramStart(
  machine: RestartableMachine,
): Promise<"starts" | "cannot" | "unknown"> {
  // No way to ask: the restart is the only remedy, as before the probe.
  const exec =
    typeof machine.exec === "function"
      ? machine.exec.bind(machine)
      : typeof machine.execCommand === "function"
        ? machine.execCommand.bind(machine)
        : null;
  if (!exec) return "cannot";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exec({ cmd: "true" }).then(
        // Modal answers an exec it could not start with a result (exit code
        // 128 and its shell-load error), not a rejection.
        (result: unknown) =>
          sandboxCommandExitCode(result) !== 0 &&
          isModalShellStartFailureMessage(sandboxCommandOutput(result))
            ? ("cannot" as const)
            : ("starts" as const),
        (probeError: unknown) =>
          isSandboxProcessStartFailure(probeError) || probeCannotStartPrograms(probeError)
            ? ("cannot" as const)
            : ("unknown" as const),
      ),
      new Promise<"unknown">((resolve) => {
        timer = setTimeout(() => resolve("unknown"), START_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function restartableMachine(
  session: unknown,
  backend: string | null | undefined,
  boxReplacement: SandboxProcessStartRecovery["boxReplacement"],
): RestartableMachine | null {
  if (!session || typeof session !== "object") return null;
  const candidate = session as { backendId?: unknown; restartMachine?: unknown };
  if (candidate.backendId === "compute" && typeof candidate.restartMachine === "function") {
    return session as RestartableMachine;
  }
  // A Modal box has no restart of its own: the lease replaces it.
  if (backend === "modal" && boxReplacement) {
    const box = session as Pick<RestartableMachine, "exec" | "execCommand">;
    return {
      backendId: "modal",
      ...(typeof box.exec === "function" ? { exec: box.exec.bind(session) } : {}),
      ...(typeof box.execCommand === "function"
        ? { execCommand: box.execCommand.bind(session) }
        : {}),
    };
  }
  return null;
}

export type SandboxProcessStartRecovery = {
  /** The established sandbox session the setup ran against. */
  session: unknown;
  /** The turn's sandbox backend ("compute", "selfhosted", ...). */
  backend: string | null | undefined;
  /** Restarts this turn already began and completed for this reason
   * (durable). */
  restartsThisTurn: () => Promise<{ started: number; completed: number }>;
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
  /**
   * Modal only: the exact box and how to ask the lease to replace it. The
   * reaper saves /workspace with Modal's own snapshot (no command runs in the
   * box), ends the box, and the next acquire restores a fresh one; arrivals
   * meanwhile wait instead of reusing it. `request` answers null when the
   * lease no longer names the box.
   */
  boxReplacement?: SandboxBoxReplacementRequest | undefined;
};

/** A Modal box (lease group, epoch, provider instance) and its replacement. */
export type SandboxBoxReplacementRequest = {
  sandboxGroupId: string;
  leaseEpoch: number;
  instanceId: string;
  request: () => Promise<SandboxBoxReplacement | null>;
};

/** How a Modal session saves /workspace (`tar`, `snapshot_filesystem` or
 * `snapshot_directory`), or null when it does not say. */
function modalWorkspacePersistence(session: unknown): string | null {
  if (!session || typeof session !== "object") return null;
  const state = (session as { state?: unknown }).state;
  if (!state || typeof state !== "object") return null;
  const record = state as {
    workspacePersistence?: unknown;
    providerState?: { workspacePersistence?: unknown } | null;
  };
  const value = record.workspacePersistence ?? record.providerState?.workspacePersistence;
  return typeof value === "string" ? value : null;
}

/**
 * The Modal box replacement for `SandboxProcessStartRecovery.boxReplacement`.
 * Only a Modal box with a known lease epoch and provider instance that saves
 * /workspace as a directory snapshot can be replaced: that save runs no
 * command in the box, and the fresh box starts from the clean image with
 * /workspace restored. A whole-filesystem snapshot would restore the broken
 * /bin/sh too, and a `tar` save needs the box's shell. Every other box gets
 * none, so its turn stops with short copy.
 */
export function modalSandboxBoxReplacer(
  db: Database,
  input: {
    backend: string | null | undefined;
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string | null | undefined;
    box: { leaseEpoch: number; established: { instanceId: string } } | null | undefined;
    session: unknown;
  },
): SandboxProcessStartRecovery["boxReplacement"] {
  const { backend, accountId, workspaceId, sandboxGroupId, box } = input;
  if (backend !== "modal" || !sandboxGroupId || !box?.established.instanceId) return undefined;
  if (modalWorkspacePersistence(input.session) !== "snapshot_directory") return undefined;
  const target = {
    sandboxGroupId,
    leaseEpoch: box.leaseEpoch,
    instanceId: box.established.instanceId,
  };
  return {
    ...target,
    request: async () =>
      await requestSandboxProcessStartReplacement(db, { accountId, workspaceId, ...target }),
  };
}

/**
 * Platform setup failed because a Modal box could not start programs, and
 * its replacement was requested. Its cause is the lease transition the turn
 * waits on (see failure-settlement): the same turn continues on a fresh box
 * restored from the saved /workspace.
 */
export class SandboxMachineReplacingError extends Error {
  override readonly name = "SandboxMachineReplacingError";

  constructor(transition: SandboxLeaseTransitionError) {
    super(
      "The workspace machine couldn't start programs, so it is being replaced with a fresh one restored from /workspace. The same turn continues once it is ready.",
      { cause: transition },
    );
  }
}

/**
 * This turn asked to replace a Modal box that could not start programs, and
 * the drain could not save that box's /workspace yet. The turn stops instead
 * of waiting on saves that keep failing; the box stays fenced, so no turn
 * reuses it, and it is replaced once a save succeeds. No cause: this is a
 * terminal stop, never a lifecycle wait.
 */
export class SandboxBoxNotSavedError extends Error {
  override readonly name = "SandboxBoxNotSavedError";

  constructor() {
    super(
      "The workspace machine can't start programs and its files couldn't be saved yet. It will be replaced once they're saved; retry then.",
    );
  }
}

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
    error instanceof SandboxMachineReplacingError ||
    error instanceof SandboxMachineBackError ||
    error instanceof SandboxProcessStartFailedError ||
    !isSandboxProcessStartFailure(error)
  ) {
    return error;
  }
  const machine = restartableMachine(recovery.session, recovery.backend, recovery.boxReplacement);
  if (!machine) {
    return new SandboxProcessStartFailedError(error, {
      machine: recovery.backend === "selfhosted" ? "connected_machine" : "other",
      restartedThisTurn: false,
    });
  }
  const kind = machine.backendId;
  if (!guard.replaySafe()) {
    return new SandboxProcessStartFailedError(error, {
      machine: kind,
      restartedThisTurn: false,
      restartFailure: "a setup script had started, so the setup is not replayed",
    });
  }
  let restarts: { started: number; completed: number };
  try {
    restarts = await recovery.restartsThisTurn();
  } catch (countError) {
    // Without proof that no restart happened, never risk a restart loop.
    return new SandboxProcessStartFailedError(error, {
      machine: kind,
      restartedThisTurn: false,
      restartFailure: `could not read earlier restarts: ${errorText(countError)}`,
    });
  }
  if (restarts.started > 0) {
    // One restart was begun this turn; the copy says it happened only when it
    // completed (the worker may have stopped before or during it). A Modal
    // replacement is never marked completed (the drain completes it), and a
    // later setup of this turn runs on a box it did not ask to replace (unless
    // the worker stopped between recording and requesting it, which is rare).
    return new SandboxProcessStartFailedError(error, {
      machine: kind,
      restartedThisTurn: restarts.completed > 0 || kind === "modal",
    });
  }
  // Checked before the restart: a box another session sharing it already
  // restarted (or is restarting) is retried as it is, never restarted again.
  // Nothing was restarted, so nothing is recorded; the ordinary sandbox
  // recovery budget bounds these retries.
  if ((await probeProgramStart(machine)) !== "cannot") return new SandboxMachineBackError(error);
  const name = recovery.operationName;
  try {
    // Recorded before the restart, so a crash during it still counts.
    await recovery.publish([
      {
        type: "sandbox.operation.started",
        payload: {
          name,
          reason: "process_start_failed",
          // The replaced box: a drain that cannot save it releases this
          // turn instead of leaving it waiting (see failure settlement).
          ...(kind === "modal" && recovery.boxReplacement
            ? {
                sandboxGroupId: recovery.boxReplacement.sandboxGroupId,
                leaseEpoch: recovery.boxReplacement.leaseEpoch,
              }
            : {}),
        },
      },
    ]);
  } catch (publishError) {
    // A fenced or cancelled attempt stops as such; nothing was restarted.
    if (isAttemptStop(publishError)) return publishError;
    return new SandboxProcessStartFailedError(error, {
      machine: kind,
      restartedThisTurn: false,
      restartFailure: `could not record the restart: ${errorText(publishError)}`,
    });
  }
  let replacement: SandboxBoxReplacement | null = null;
  try {
    if (kind === "modal") {
      replacement = await recovery.boxReplacement!.request();
      // The lease no longer names this box: it was already replaced (or
      // ended), so a retry gets a new box. The restart still counts.
      if (!replacement) return new SandboxMachineBackError(error, "already_replaced");
    } else {
      await machine.restartMachine!();
    }
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
      machine: kind,
      restartedThisTurn: false,
      restartAttemptFailed: true,
      restartFailure: errorText(restartError),
    });
  }
  if (replacement) {
    // Not completed yet: the box is replaced only once the drain has saved
    // /workspace and ended it. The row reads "Restarting the workspace
    // machine" while the turn waits and settles with the turn.
    return new SandboxMachineReplacingError(
      new SandboxLeaseTransitionError(
        replacement.sandboxGroupId,
        replacement.leaseEpoch,
        "rotation_in_progress",
        "modal",
        replacement.instanceId,
        replacement.liveness,
      ),
    );
  }
  await recovery
    .publish([{ type: "sandbox.operation.completed", payload: { name } }])
    .catch(() => undefined);
  return new SandboxMachineRestartingError(error);
}

/**
 * A compute box whose agent left a command's start unanswered for the op
 * stream's bound (it died and did not come back, or the box hangs): restart
 * it, at most once per turn, counted with the process-start restarts under the
 * same operation, so the person's next command reaches a working box. A box
 * whose agent answers again by now (another session sharing it may have
 * restarted it) is left alone. Never throws: the outcome goes into the
 * command's error.
 */
export async function recoverUnresponsiveComputeAgent(
  machine: UnresponsiveComputeMachine,
  recovery: Pick<SandboxProcessStartRecovery, "restartsThisTurn" | "publish" | "operationName"> & {
    /** Whether the box's host is busy with it, as handing it off, and so
     * refuses to wake it for a short while. Its agent is not at fault then,
     * and a restart would only wait on the same host. */
    hostBusy?: () => Promise<boolean>;
  },
): Promise<UnresponsiveAgentRecovery> {
  if (await machine.agentAnswers().catch(() => false)) return "answering";
  if (await (recovery.hostBusy?.() ?? Promise.resolve(false)).catch(() => false)) {
    return "host_busy";
  }
  let restarts: { started: number; completed: number };
  try {
    restarts = await recovery.restartsThisTurn();
  } catch {
    // Without proof that no restart happened, never risk a restart loop.
    return "restart_unavailable";
  }
  // Begun this turn, whether or not it finished (the worker may have stopped
  // during it): never a second one.
  if (restarts.started > 0) return "already_restarted";
  const name = recovery.operationName;
  try {
    // Recorded before the restart, so a crash during it still counts.
    await recovery.publish([
      { type: "sandbox.operation.started", payload: { name, reason: "agent_unresponsive" } },
    ]);
  } catch {
    // Unrecorded, it could repeat: none is made.
    return "restart_unavailable";
  }
  try {
    await machine.restartMachine();
  } catch (restartError) {
    await recovery
      .publish([
        { type: "sandbox.operation.failed", payload: { name, error: errorText(restartError) } },
      ])
      .catch(() => undefined);
    // The control service could not carry it out for now (`503 unavailable`):
    // most often the box's host is restarting its own agent while the box
    // runs on. A 503 does not prove nothing was restarted, so the words say
    // "probably" and send the agent to check its commands first.
    return isComputeHostUnavailable(restartError) ? "host_unavailable" : "restart_failed";
  }
  await recovery
    .publish([{ type: "sandbox.operation.completed", payload: { name } }])
    .catch(() => undefined);
  return "restarted";
}

/** A compute control refusal of `503 unavailable`: the box's host cannot
 * serve it now (see compute/docs/agent-link.md). */
function isComputeHostUnavailable(error: unknown): boolean {
  return error instanceof ComputeControlError && error.kind === "unavailable";
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
