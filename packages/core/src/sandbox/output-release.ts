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
 * Whether the exact runner process a command ran on serves `OpRelease` (it
 * advertised `capabilities.op_release` in the Hello of that same connection
 * instance). A runner without it keeps the reconciler's attach and final-ACK
 * release.
 */
export async function connectedRunnerReleasesOutput(
  db: Database,
  runner: { controlWorkspaceId: string; enrollmentId: string; connectionInstanceId: string },
): Promise<boolean> {
  const enrollment = await getEnrollment(db, runner.controlWorkspaceId, runner.enrollmentId);
  return (
    enrollment?.connectionInstanceId === runner.connectionInstanceId &&
    enrollment.agentCapabilities.opRelease === true
  );
}

/**
 * Release a command's output on its runner right where it was durably stored,
 * while that runner is live from the command: one answered `OpRelease`, then
 * the release is recorded, so nothing about the command is left for a later
 * maintenance pass to send the runner. "unsupported" when the runner does not
 * serve `OpRelease`; the reconciler then releases it as before. A failure
 * throws and leaves the reconciler to recover the release once.
 */
export async function releaseStoredConnectedCommandOutput(
  db: Database,
  input: {
    command: StoredConnectedCommandOutput;
    exitSeq: string;
    controlRpc: ControlRpc;
    controlTimeoutMs: number;
  },
): Promise<"released" | "not_retained" | "unsupported"> {
  const { command } = input;
  if (!(await connectedRunnerReleasesOutput(db, command))) return "unsupported";
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
  await recordConnectedCommandOutputRelease(db, { ...command, exitSeq: input.exitSeq });
  return outcome;
}
