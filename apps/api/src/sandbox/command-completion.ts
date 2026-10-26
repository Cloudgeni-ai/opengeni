import { AgentEventAck, type OperationCompleted } from "@opengeni/agent-proto";
import type { Settings } from "@opengeni/config";
import { agentConnectionCurrent, releaseStoredConnectedCommandOutput } from "@opengeni/core";
import {
  computeSandboxOfEnrollment,
  settleCollectedConnectedMachineBackgroundCommand,
  type Database,
} from "@opengeni/db";
import {
  locateConnectedCommandCompletion,
  claimPushedConnectedCommandCompletion,
  claimConnectedCommandOutputCollection,
  deferConnectedMachineBackgroundCommandReconciliation,
  connectedCommandReconciliationRetryMs,
  recordConnectedCommandOutputConsumption,
  returnConnectedCommandOutputCollection,
  type ConnectedCommandInventoryRow,
  type ConnectedCommandStopTarget,
} from "@opengeni/db/session-background-commands";
import { createConnectedCommandOutputCapture } from "@opengeni/db/session-command-output";
import type { EventBus } from "@opengeni/events";
import {
  cancelSelfhostedOp,
  ComputeControlClient,
  type ControlRpc,
  NatsControlRpc,
  type NatsRequestConnection,
  wakeComputeSandboxOnNoResponders,
  NatsOpStreamTransport,
  OpStreamExecClient,
  defaultSelfhostedRetryClock,
  subjectFor,
  replayConnectedCommandOutput,
  connectedCommandExitProof,
  withoutWaking,
} from "@opengeni/runtime/sandbox";
import type { ConnectedCommandCompletionLocator } from "./completion-locator";

/**
 * The transport of an immediate stop. One absolute budget covers capability
 * negotiation, retries and the cancel itself: no recovery allowance runs past
 * it, and the reconciler delivers whatever does not fit. A stop that no host
 * receives wakes the compute sandbox it addresses, as any other request to
 * that sandbox does, and is retried at the same locator; a Connected Machine
 * keeps its ordinary offline retry.
 */
export function connectedCommandStopRpc(input: {
  db: Database;
  settings: Pick<Settings, "computeApiUrl" | "computeApiKey">;
  connect: () => Promise<NatsRequestConnection | null>;
  budgetMs: number;
  /** Injected for tests: the control service, and the sandbox an enrollment runs in. */
  compute?: {
    control: Pick<ComputeControlClient, "wake">;
    sandboxOf: (agent: { workspaceId: string; enrollmentId: string }) => Promise<string | null>;
  };
  /** Injected for tests: whether a subject's connection is still live. */
  connectionCurrent?: (subject: string) => Promise<boolean>;
}): ControlRpc {
  const deadlineAtMs = Date.now() + input.budgetMs;
  const signal = AbortSignal.timeout(input.budgetMs);
  const { computeApiUrl, computeApiKey } = input.settings;
  const compute =
    input.compute ??
    (computeApiUrl && computeApiKey
      ? {
          control: new ComputeControlClient({
            baseUrl: computeApiUrl,
            apiKey: computeApiKey,
            requestTimeoutMs: input.budgetMs,
            maxAttempts: 1,
            signal,
          }),
          sandboxOf: async (agent: { workspaceId: string; enrollmentId: string }) =>
            await computeSandboxOfEnrollment(input.db, agent, { deadlineAtMs, signal }),
        }
      : undefined);
  // A stop addressed to a replaced connection ends at once and never wakes a
  // sandbox: that runner is gone, and the reconciler settles the command by
  // runner retirement.
  const connectionCurrent = input.connectionCurrent ?? agentConnectionCurrent(input.db);
  return new NatsControlRpc(input.connect, {
    recoveryMs: 0,
    connectionCurrent,
    ...(compute
      ? { onNoResponders: wakeComputeSandboxOnNoResponders({ ...compute, connectionCurrent }) }
      : {}),
  });
}

/**
 * Deliver a stop to an adopted command at its frozen locator, at once, within
 * `budgetMs` whatever the transport does. Best effort: the command is already
 * `stopping`, and when this fails the reconciler delivers the cancellation on
 * its next pass. The runner then pushes the exit, which settles the command.
 */
export async function deliverConnectedCommandStop(
  controlRpc: ControlRpc,
  target: ConnectedCommandStopTarget,
  budgetMs: number,
): Promise<{ delivered: true } | { delivered: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ delivered: false; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ delivered: false, error: `not delivered within ${budgetMs} ms` }),
      budgetMs,
    );
  });
  try {
    return await Promise.race([deliverStop(controlRpc, target, budgetMs), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function deliverStop(
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

/** How long a collection waits on one control request to the runner. */
const CONNECTED_COMMAND_COLLECTION_TIMEOUT_MS = 10_000;

/** Collection deps: the bus carries replay and release; tests inject both. */
export type ConnectedCommandCollectionDeps = {
  /** Fresh pending-read batching owned by the ingestion consumer, never a cache. */
  locate?: ConnectedCommandCompletionLocator | undefined;
  bus?: EventBus | undefined;
  reader?: Pick<OpStreamExecClient, "readExisting"> | undefined;
  /** Injected for tests: the control transport of the output release. */
  releaseRpc?: ControlRpc | undefined;
};

/** Collection is housekeeping: its attach is sent without waking. When the
 * runner does not answer (its sandbox fell asleep), the collection fails and
 * records nothing; the runner reports the op again while it is talking. */
function connectedCommandOutputReader(
  identity: { controlWorkspaceId: string; enrollmentId: string; connectionInstanceId: string },
  deps: ConnectedCommandCollectionDeps,
): Pick<OpStreamExecClient, "readExisting"> {
  if (deps.reader) return deps.reader;
  const bus = deps.bus;
  if (!bus?.getOpStreamConnection)
    throw new Error("Connected command output transport unavailable");
  return new OpStreamExecClient({
    workspaceId: identity.controlWorkspaceId,
    agentId: identity.enrollmentId,
    connectionInstanceId: identity.connectionInstanceId,
    epoch: 0,
    controlRpc: withoutWaking(new NatsControlRpc(async () => bus.getRequestConnection())),
    rpcSubject: subjectFor(
      identity.controlWorkspaceId,
      identity.enrollmentId,
      identity.connectionInstanceId,
    ),
    transport: new NatsOpStreamTransport(async () => bus.getOpStreamConnection!()),
    controlTimeoutMs: CONNECTED_COMMAND_COLLECTION_TIMEOUT_MS,
    retryClock: defaultSelfhostedRetryClock,
    journal: { attachGeneration: () => String(Date.now()), persistSettled: () => {} },
  });
}

function connectedCommandReleaseRpc(deps: ConnectedCommandCollectionDeps): ControlRpc | null {
  const bus = deps.bus;
  return (
    deps.releaseRpc ?? (bus ? new NatsControlRpc(async () => bus.getRequestConnection()) : null)
  );
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
  /** Injected for tests: the control transport of the output release. */
  releaseRpc?: ControlRpc,
  locate?: ConnectedCommandCompletionLocator,
): Promise<void> {
  if (!completed.exit || !completed.opId || /[\s.*>]/u.test(completed.opId)) return;
  await collectConnectedCommandCompletion(
    db,
    ids,
    completed.opId,
    { bus, reader, releaseRpc, locate },
    { acknowledge: true },
  );
}

/**
 * Collect the exit of a command its runner reports completed: from the
 * completion push (which is acknowledged), or from the runner's operation
 * inventory. Replays and stores its output, settles it, and releases it on
 * the runner in the same exchange.
 */
export async function collectConnectedCommandCompletion(
  db: Database,
  ids: { workspaceId: string; agentId: string; connectionInstanceId: string },
  opId: string,
  deps: ConnectedCommandCollectionDeps,
  options: { acknowledge: boolean },
): Promise<void> {
  const { bus, reader, releaseRpc } = deps;
  const identity = {
    controlWorkspaceId: ids.workspaceId,
    enrollmentId: ids.agentId,
    connectionInstanceId: ids.connectionInstanceId,
    opId,
  };
  const command = await (deps.locate
    ? deps.locate(identity)
    : locateConnectedCommandCompletion(db, identity));
  // Foreground operations and exits before adoption have no background row.
  // Their attached consumer still owns terminal proof and the adoption race.
  if (!command) return;
  const acknowledgeDelivery = async () => {
    if (!options.acknowledge || !bus?.getOpStreamConnection) return;
    const connection = await bus.getOpStreamConnection();
    connection.publish(
      `agent.${ids.workspaceId}.${ids.agentId}.connection.${ids.connectionInstanceId}.ack`,
      AgentEventAck.encode({
        ack: { $case: "operationCompleted", operationCompleted: { opId } },
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
  const controlTimeoutMs = CONNECTED_COMMAND_COLLECTION_TIMEOUT_MS;
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
    const client = connectedCommandOutputReader(identity, deps);
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
    // All bytes are durable before terminal fanout. Release them on the runner
    // now, while it is live from this command: one answered exchange, so no
    // later maintenance pass reaches it. A runner without OpRelease is
    // released by the reconciler; a failed release is recovered by the
    // runner's own operation inventory. The model's observation never
    // depends on it.
    const controlRpc = connectedCommandReleaseRpc({ bus, releaseRpc });
    if (controlRpc)
      await releaseStoredConnectedCommandOutput(db, {
        command: claim,
        exitSeq: receipt.exitSeq,
        controlRpc,
        controlTimeoutMs,
      }).catch(() => undefined);
  } catch (error) {
    await deferConnectedMachineBackgroundCommandReconciliation(db, {
      claim,
      outcome: "completion_retry",
      retryAfterMs: connectedCommandReconciliationRetryMs(claim.reconcileAttempts),
    });
    throw error;
  }
}

/**
 * Collect the output of a command that is settled exited but whose output
 * was never stored, when its runner reports the op completed in its
 * operation inventory (the runner is talking, so this reaches no sleeping
 * sandbox): replay and store it, then release it on the runner in the same
 * exchange. One claim on the output makes this the only collector; `false`
 * when another holds it. A failure gives the claim back and throws: the
 * runner reports the op again.
 */
export async function collectExitedConnectedCommandOutput(
  db: Database,
  row: ConnectedCommandInventoryRow,
  deps: ConnectedCommandCollectionDeps,
): Promise<boolean> {
  const claimId = crypto.randomUUID();
  if (!(await claimConnectedCommandOutputCollection(db, { ...row, claimId }))) return false;
  try {
    const client = connectedCommandOutputReader(row, deps);
    const capture = createConnectedCommandOutputCapture(
      db,
      row,
      deps.bus
        ? async (events) => {
            await deps.bus!.publish(row.workspaceId, row.sessionId, events);
          }
        : undefined,
    );
    const replay = await replayConnectedCommandOutput(
      client,
      row.opId,
      true,
      async (frames) => capture(row.commandId, frames),
      Date.now() + 2 * 60_000,
    );
    const terminal = replay.status === "completed" ? replay : replay.terminal;
    const receipt =
      replay.outputReceipt ??
      (replay.status === "running" ? replay.terminal?.outputReceipt : undefined);
    if (!terminal || !receipt)
      throw new Error("Connected command output replay has no complete custody receipt");
    await recordConnectedCommandOutputConsumption(db, {
      ...row,
      receipt,
      exitCode: terminal.outcome.response.exitCode,
    });
    const controlRpc = connectedCommandReleaseRpc(deps);
    if (controlRpc)
      await releaseStoredConnectedCommandOutput(db, {
        command: row,
        exitSeq: receipt.exitSeq,
        controlRpc,
        controlTimeoutMs: CONNECTED_COMMAND_COLLECTION_TIMEOUT_MS,
      });
    return true;
  } finally {
    // Recording the release already dropped the claim; otherwise give it back.
    await returnConnectedCommandOutputCollection(db, { ...row, claimId }).catch(() => undefined);
  }
}
