import { SelfhostedControlError } from "@opengeni/runtime";

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
