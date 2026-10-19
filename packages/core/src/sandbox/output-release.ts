import { getEnrollment, type Database } from "@opengeni/db";
import { recordConnectedCommandOutputRelease } from "@opengeni/db/session-background-commands";
import { releaseSelfhostedOpOutput, subjectFor, type ControlRpc } from "@opengeni/runtime/sandbox";

/** The exact background command whose stored output is released. */
export type StoredConnectedCommandOutput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  commandId: string;
  controlWorkspaceId: string;
  enrollmentId: string;
  connectionInstanceId: string;
  opId: string;
};

/**
 * How the runner process a command ran on gets the output Opengeni stored
 * released:
 * - `"inventory"`: it serves `OpRelease` and reports its own operation
 *   inventory. Every compute sandbox agent does (one without it is refused as
 *   an incompatible image), and so does a Connected Machine whose live
 *   connection instance is this one and advertised `capabilities.op_release`.
 *   Output is released where it is stored, and the runner's inventory, which
 *   Opengeni answers while the runner is talking, recovers the rest: Opengeni
 *   never sends it anything to recover a release.
 * - `"retired"`: a compute sandbox whose enrollment is revoked or whose
 *   connection another agent process holds. That runner retains nothing.
 * - `"legacy"`: any other Connected Machine runner. The reconciler releases
 *   its output with an attach and a final ACK, as before.
 */
export type ConnectedRunnerReleaseMode = "inventory" | "retired" | "legacy";

export async function connectedRunnerReleaseMode(
  db: Database,
  runner: { controlWorkspaceId: string; enrollmentId: string; connectionInstanceId: string },
): Promise<ConnectedRunnerReleaseMode> {
  const enrollment = await getEnrollment(db, runner.controlWorkspaceId, runner.enrollmentId);
  if (enrollment?.kind === "sandbox") {
    return enrollment.status === "revoked" ||
      (enrollment.connectionInstanceId !== null &&
        enrollment.connectionInstanceId !== runner.connectionInstanceId)
      ? "retired"
      : "inventory";
  }
  return enrollment?.connectionInstanceId === runner.connectionInstanceId &&
    enrollment.agentCapabilities.opRelease === true
    ? "inventory"
    : "legacy";
}

/**
 * Release a command's output on its runner right where it was durably stored,
 * while that runner is live from the command: one answered `OpRelease`, then
 * the release is recorded, so nothing about the command is left for a later
 * pass to send the runner. `OpRelease` is idempotent, so an inventory answer
 * releasing the same output meanwhile is harmless. It is sent without waking:
 * "not_answered" when the runner did not answer (its sandbox fell asleep, or
 * it is away), which records nothing, and the runner's own inventory releases
 * it when it next talks. "unsupported" when the runner does not report its
 * inventory: the reconciler releases it with an attach and a final ACK. A
 * failure throws; the runner's inventory recovers that too.
 */
export async function releaseStoredConnectedCommandOutput(
  db: Database,
  input: {
    command: StoredConnectedCommandOutput;
    exitSeq: string;
    controlRpc: ControlRpc;
    controlTimeoutMs: number;
  },
): Promise<"released" | "not_retained" | "not_answered" | "unsupported" | "retired"> {
  const { command } = input;
  const mode = await connectedRunnerReleaseMode(db, command);
  if (mode !== "inventory") return mode === "retired" ? "retired" : "unsupported";
  const outcome = await releaseSelfhostedOpOutput({
    controlRpc: input.controlRpc,
    rpcSubject: subjectFor(
      command.controlWorkspaceId,
      command.enrollmentId,
      command.connectionInstanceId,
    ),
    opId: command.opId,
    exitSeq: input.exitSeq,
    controlTimeoutMs: input.controlTimeoutMs,
  });
  if (outcome === "not_answered") return outcome;
  await recordConnectedCommandOutputRelease(db, { ...command, exitSeq: input.exitSeq });
  return outcome;
}
