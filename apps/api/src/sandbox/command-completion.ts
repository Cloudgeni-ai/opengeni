import { AgentEventAck, type OperationCompleted } from "@opengeni/agent-proto";
import { settleCollectedConnectedMachineBackgroundCommand, type Database } from "@opengeni/db";
import {
  locateConnectedCommandCompletion,
  claimPushedConnectedCommandCompletion,
  deferConnectedMachineBackgroundCommandReconciliation,
  connectedCommandReconciliationRetryMs,
  type ConnectedCommandStopTarget,
} from "@opengeni/db/session-background-commands";
import { createConnectedCommandOutputCapture } from "@opengeni/db/session-command-output";
import type { EventBus } from "@opengeni/events";
import {
  cancelSelfhostedOp,
  type ControlRpc,
  NatsControlRpc,
  NatsOpStreamTransport,
  OpStreamExecClient,
  defaultSelfhostedRetryClock,
  subjectFor,
  replayConnectedCommandOutput,
  connectedCommandExitProof,
} from "@opengeni/runtime/sandbox";

/**
 * Deliver a stop to an adopted command at its frozen locator, at once. Best
 * effort: the command is already `stopping`, and when this fails the
 * reconciler delivers the cancellation on its next pass. The runner then pushes
 * the exit, which settles the command.
 */
export async function deliverConnectedCommandStop(
  controlRpc: ControlRpc,
  target: ConnectedCommandStopTarget,
  controlTimeoutMs: number,
): Promise<{ delivered: true } | { delivered: false; error: string }> {
  try {
    await cancelSelfhostedOp({
      controlRpc,
      rpcSubject: subjectFor(
        target.controlWorkspaceId,
        target.enrollmentId,
        target.connectionInstanceId,
      ),
      opId: target.opId,
      controlTimeoutMs,
    });
    return { delivered: true };
  } catch (error) {
    return { delivered: false, error: error instanceof Error ? error.message : String(error) };
  }
}

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
  const acknowledgeDelivery = async () => {
    if (!bus?.getOpStreamConnection) return;
    const connection = await bus.getOpStreamConnection();
    connection.publish(
      `agent.${ids.workspaceId}.${ids.agentId}.connection.${ids.connectionInstanceId}.ack`,
      AgentEventAck.encode({
        ack: { $case: "operationCompleted", operationCompleted: { opId: completed.opId } },
      }).finish(),
    );
  };
  if (command.terminal) {
    await acknowledgeDelivery();
    return;
  }
  if (!reader && !bus?.getOpStreamConnection)
    throw new Error("Connected command output transport unavailable");
  const claimTtlMs = 5 * 60_000;
  const controlTimeoutMs = 10_000;
  // Finish or relinquish collection before the existing claim can be stolen.
  // Reserve the bounded replay window plus control timeout for the last read.
  const replayDeadlineAt = Date.now() + claimTtlMs - controlTimeoutMs - 5_000;
  const claim = await claimPushedConnectedCommandCompletion(db, {
    ...command,
    ...identity,
    claimTtlMs,
  });
  // Delivery receipt is independent of output/final ACK. Once this transaction
  // commits, the reconciler owns retries even if this API process disappears.
  await acknowledgeDelivery().catch(() => undefined); // A lost receipt is healed by the runner's retry.
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
        controlTimeoutMs,
        retryClock: defaultSelfhostedRetryClock,
        journal: { attachGeneration: () => String(Date.now()), persistSettled: () => {} },
      });
    const capture = createConnectedCommandOutputCapture(
      db,
      command,
      bus
        ? async (events) => {
            await bus.publish(command.workspaceId, command.sessionId, events);
          }
        : undefined,
    );
    const replay = await replayConnectedCommandOutput(
      client,
      claim.opId,
      true,
      async (frames) => capture(command.commandId, frames),
      replayDeadlineAt,
    );
    const terminal = replay.status === "completed" ? replay : replay.terminal;
    const receipt =
      replay.outputReceipt ??
      (replay.status === "running" ? replay.terminal?.outputReceipt : undefined);
    if (!terminal || !receipt || !terminal.outcome.terminalExit)
      throw new Error("Connected command completion does not match its captured exit frontier");
    // The event is a wake hint. Only verified retained truth supplies proof,
    // including cancellation, timeout and failure details, not just exit code.
    const exit = terminal.outcome.terminalExit;
    await settleCollectedConnectedMachineBackgroundCommand(db, {
      claim,
      proof: connectedCommandExitProof(exit, new Date()),
      receipt,
      publish: bus
        ? async (events) => {
            await bus.publish(command.workspaceId, command.sessionId, events);
          }
        : undefined,
    });
    // Final ACK remains the separately retryable custody obligation, never the
    // model's observation. All bytes are durable before terminal fanout.
  } catch (error) {
    await deferConnectedMachineBackgroundCommandReconciliation(db, {
      claim,
      outcome: "completion_retry",
      retryAfterMs: connectedCommandReconciliationRetryMs(claim.reconcileAttempts),
    });
    throw error;
  }
}
