import type { OperationCompleted } from "@opengeni/agent-proto";
import { settleClaimedConnectedMachineBackgroundCommand, type Database } from "@opengeni/db";
import {
  locateConnectedCommandCompletion,
  claimPushedConnectedCommandCompletion,
  recordConnectedMachineBackgroundCommandProof,
  recordConnectedCommandOutputConsumption,
  deferConnectedMachineBackgroundCommandReconciliation,
} from "@opengeni/db/session-background-commands";
import { appendSessionCommandOutput } from "@opengeni/db/session-command-output";
import type { EventBus } from "@opengeni/events";
import {
  NatsControlRpc,
  NatsOpStreamTransport,
  OpStreamExecClient,
  defaultSelfhostedRetryClock,
  subjectFor,
  replayConnectedCommandOutput,
  connectedCommandExitProof,
} from "@opengeni/runtime/sandbox";

/** The authenticated process subject, never the payload, supplies machine
 * identity. Historical routes are intentional: changing a session's current
 * route does not change the daemon that owns its already-started command. */
export async function ingestConnectedCommandCompletion(
  db: Database,
  ids: { workspaceId: string; agentId: string; connectionInstanceId: string },
  completed: OperationCompleted,
  bus?: EventBus,
  reader?: Pick<OpStreamExecClient, "readExisting">,
): Promise<void> {
  if (!completed.exit || !completed.opId || /[\s.*>]/u.test(completed.opId)) return;
  const identity = {
    controlWorkspaceId: ids.workspaceId,
    enrollmentId: ids.agentId,
    connectionInstanceId: ids.connectionInstanceId,
    opId: completed.opId,
  };
  const command = await locateConnectedCommandCompletion(db, identity);
  // Foreground operations and exits before adoption have no background row.
  // Their attached consumer still owns terminal proof and the adoption race.
  if (!command) return;
  if (!reader && !bus?.getOpStreamConnection)
    throw new Error("Connected command output transport unavailable");
  const claim = await claimPushedConnectedCommandCompletion(db, {
    ...command,
    ...identity,
    claimTtlMs: 5 * 60_000,
  });
  if (!claim) return;
  try {
    const client =
      reader ??
      new OpStreamExecClient({
        workspaceId: identity.controlWorkspaceId,
        agentId: identity.enrollmentId,
        connectionInstanceId: identity.connectionInstanceId,
        epoch: 0,
        controlRpc: new NatsControlRpc(async () => bus!.getRequestConnection()),
        rpcSubject: subjectFor(
          identity.controlWorkspaceId,
          identity.enrollmentId,
          identity.connectionInstanceId,
        ),
        transport: new NatsOpStreamTransport(async () => bus!.getOpStreamConnection!()),
        controlTimeoutMs: 10_000,
        retryClock: defaultSelfhostedRetryClock,
        journal: { attachGeneration: () => String(Date.now()), persistSettled: () => {} },
      });
    const replay = await replayConnectedCommandOutput(client, claim.opId, true, async (frames) => {
      for (const frame of frames) {
        const events = await appendSessionCommandOutput(db, {
          ...command,
          chunkId: `op-frame:${frame.sequence}`,
          stream: frame.stream,
          chunk: frame.chunk,
        });
        if (bus && events.length)
          await bus.publish(command.workspaceId, command.sessionId, events).catch(() => undefined);
      }
    });
    const terminal = replay.status === "completed" ? replay : replay.terminal;
    const receipt =
      replay.outputReceipt ??
      (replay.status === "running" ? replay.terminal?.outputReceipt : undefined);
    if (!terminal || !receipt || terminal.outcome.response.exitCode !== completed.exit.exitCode)
      throw new Error("Connected command completion does not match its captured exit frontier");
    const exit = completed.exit;
    await recordConnectedMachineBackgroundCommandProof(db, {
      claim,
      proof: connectedCommandExitProof(exit, new Date()),
    });
    const settlement = await settleClaimedConnectedMachineBackgroundCommand(db, { claim });
    if (!settlement.settled) return; // An attached owner may have settled after capture.
    await recordConnectedCommandOutputConsumption(db, {
      ...command,
      ...identity,
      receipt,
      exitCode: exit.exitCode,
    });
    // Final ACK remains the separately retryable custody obligation, never the
    // model's observation. All bytes are durable before terminal fanout.
    if (bus) await bus.publish(command.workspaceId, command.sessionId, settlement.events);
  } catch (error) {
    await deferConnectedMachineBackgroundCommandReconciliation(db, {
      claim,
      outcome: "completion_retry",
      retryAfterMs: 0,
    });
    throw error;
  }
}
