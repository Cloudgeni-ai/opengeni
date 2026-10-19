import { getEnrollment, type Database } from "@opengeni/db";
import {
  claimConnectedCommandOutputRelease,
  recordConnectedCommandOutputRelease,
  returnConnectedCommandOutputReleaseClaim,
} from "@opengeni/db/session-background-commands";
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
 * Whether the exact runner process a command ran on serves `OpRelease`. Every
 * compute sandbox agent does (a compute agent without it is refused as an
 * incompatible image). A Connected Machine's does when it advertised
 * `capabilities.op_release` in the Hello of that same connection instance;
 * one without it keeps the reconciler's attach and final-ACK release.
 */
export async function connectedRunnerReleasesOutput(
  db: Database,
  runner: { controlWorkspaceId: string; enrollmentId: string; connectionInstanceId: string },
): Promise<boolean> {
  const enrollment = await getEnrollment(db, runner.controlWorkspaceId, runner.enrollmentId);
  if (enrollment?.kind === "sandbox") return true;
  return (
    enrollment?.connectionInstanceId === runner.connectionInstanceId &&
    enrollment.agentCapabilities.opRelease === true
  );
}

/**
 * Release a command's output on its runner right where it was durably stored,
 * while that runner is live from the command: one answered `OpRelease`, then
 * the release is recorded, so nothing about the command is left for a later
 * maintenance pass to send the runner. It first takes the obligation's one
 * claim; when another owner holds it (the reconciler already recovering it),
 * this sends nothing ("claimed_elsewhere"). "unsupported" when the runner
 * does not serve `OpRelease`: the reconciler releases it as before, at once.
 * A failure returns the claim and throws, leaving the reconciler to recover
 * the release once.
 */
export async function releaseStoredConnectedCommandOutput(
  db: Database,
  input: {
    command: StoredConnectedCommandOutput;
    exitSeq: string;
    controlRpc: ControlRpc;
    controlTimeoutMs: number;
  },
): Promise<"released" | "not_retained" | "unsupported" | "claimed_elsewhere"> {
  const { command } = input;
  const claimId = crypto.randomUUID();
  if (
    !(await claimConnectedCommandOutputRelease(db, { ...command, exitSeq: input.exitSeq, claimId }))
  )
    return "claimed_elsewhere";
  if (!(await connectedRunnerReleasesOutput(db, command))) {
    await returnConnectedCommandOutputReleaseClaim(db, { ...command, claimId, afterMs: 0 });
    return "unsupported";
  }
  let outcome: "released" | "not_retained";
  try {
    outcome = await releaseSelfhostedOpOutput({
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
  } catch (error) {
    await returnConnectedCommandOutputReleaseClaim(db, { ...command, claimId, afterMs: 0 }).catch(
      () => undefined,
    );
    throw error;
  }
  await recordConnectedCommandOutputRelease(db, { ...command, exitSeq: input.exitSeq });
  return outcome;
}
