import {
  adoptConnectedMachineSessionBackgroundCommand,
  settleConnectedMachineSessionBackgroundCommand,
  signalBackgroundCommandWakes,
  type Database,
  type SessionWorkflowWake,
} from "@opengeni/db";
import {
  recordConnectedCommandOutputConsumption,
  runningConnectedCommandLocator,
} from "@opengeni/db/session-background-commands";
import { createConnectedCommandOutputCapture } from "@opengeni/db/session-command-output";
import type { EventBus } from "@opengeni/events";
import {
  defaultSelfhostedRetryClock,
  NatsControlRpc,
  NatsOpStreamTransport,
  OpStreamExecClient,
  replayConnectedCommandOutput,
  subjectFor,
  withoutWaking,
  type SelfhostedSessionDeps,
} from "@opengeni/runtime/sandbox";
import { releaseStoredConnectedCommandOutput } from "./output-release";

export function captureConnectedCommandOutput(
  db: Database,
  ids: { accountId: string; workspaceId: string; sessionId: string },
  bus?: EventBus,
) {
  return createConnectedCommandOutputCapture(
    db,
    ids,
    bus
      ? async (events) => {
          await bus.publish(ids.workspaceId, ids.sessionId, events);
        }
      : undefined,
  );
}

/**
 * Adapt a session workflow signaler (`wakeSessionWorkflow`) to the wake hook
 * of a background-command settlement. Absent signaler: the periodic wake
 * dispatcher delivers the committed wake instead.
 */
export type BackgroundCommandWakeSignal = (input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
  wakeRevision: number;
}) => Promise<unknown>;

export function backgroundCommandWakeSender(
  signal: BackgroundCommandWakeSignal | null | undefined,
): ((wake: SessionWorkflowWake) => Promise<unknown>) | undefined {
  if (!signal) return undefined;
  return async (wake) =>
    await signal({
      accountId: wake.accountId,
      workspaceId: wake.workspaceId,
      sessionId: wake.sessionId,
      workflowId: wake.temporalWorkflowId,
      wakeRevision: wake.wakeRevision,
    });
}

/**
 * The background-command ledger hooks of an agent session (a Connected
 * Machine, or the agent inside a compute sandbox): a yielded command is
 * adopted into the session's ledger, its output captured, and its exit settled.
 */
/** One answered OpRelease to a live runner. */
const CONNECTED_OUTPUT_RELEASE_TIMEOUT_MS = 10_000;

export function agentBackgroundCommandDeps(
  db: Database,
  bus: EventBus | undefined,
  args: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    backgroundCommandAttempt?: {
      turnId: string;
      executionGeneration: number;
      attemptId: string;
    };
    /** Signals a committed wake of a session waiting on a settled command. */
    wake?: ((wake: SessionWorkflowWake) => Promise<unknown>) | undefined;
  },
): Pick<
  SelfhostedSessionDeps,
  "adoptBackgroundCommand" | "captureBackgroundCommandOutput" | "settleBackgroundCommand"
> {
  return {
    ...(args.backgroundCommandAttempt
      ? {
          adoptBackgroundCommand: async (command) => {
            const adopted = await adoptConnectedMachineSessionBackgroundCommand(db, {
              accountId: args.accountId,
              workspaceId: args.workspaceId,
              sessionId: args.sessionId,
              turnId: args.backgroundCommandAttempt!.turnId,
              executionGeneration: args.backgroundCommandAttempt!.executionGeneration,
              attemptId: args.backgroundCommandAttempt!.attemptId,
              commandId: crypto.randomUUID(),
              controlWorkspaceId: command.controlWorkspaceId,
              enrollmentId: command.enrollmentId,
              connectionInstanceId: command.connectionInstanceId,
              opId: command.opId,
              command: command.command,
              ...(command.abandoned ? { abandoned: true } : {}),
            });
            return { commandId: adopted.id };
          },
        }
      : {}),
    captureBackgroundCommandOutput: captureConnectedCommandOutput(
      db,
      {
        accountId: args.accountId,
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
      },
      bus,
    ),
    settleBackgroundCommand: async (command) => {
      const settlement = await settleConnectedMachineSessionBackgroundCommand(db, {
        accountId: args.accountId,
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        commandId: command.commandId,
        controlWorkspaceId: command.controlWorkspaceId,
        enrollmentId: command.enrollmentId,
        connectionInstanceId: command.connectionInstanceId,
        opId: command.opId,
        outcome: command.outcome,
        exitCode: command.exitCode,
        reason: command.reason,
        backgroundChildrenStopped: command.backgroundChildrenStopped,
        ...(command.failure ? { failure: command.failure } : {}),
      });
      if (command.outputReceipt && command.outcome === "exited" && command.exitCode !== null) {
        await recordConnectedCommandOutputConsumption(db, {
          accountId: args.accountId,
          workspaceId: args.workspaceId,
          sessionId: args.sessionId,
          commandId: command.commandId,
          controlWorkspaceId: command.controlWorkspaceId,
          enrollmentId: command.enrollmentId,
          connectionInstanceId: command.connectionInstanceId,
          opId: command.opId,
          receipt: command.outputReceipt,
          exitCode: command.exitCode,
        });
        // Stored: release it on the runner now, in one answered exchange. A
        // runner without OpRelease, or a failure, leaves it to the reconciler.
        if (bus)
          await releaseStoredConnectedCommandOutput(db, {
            command: {
              accountId: args.accountId,
              workspaceId: args.workspaceId,
              sessionId: args.sessionId,
              commandId: command.commandId,
              controlWorkspaceId: command.controlWorkspaceId,
              enrollmentId: command.enrollmentId,
              connectionInstanceId: command.connectionInstanceId,
              opId: command.opId,
            },
            exitSeq: command.outputReceipt.exitSeq,
            controlRpc: new NatsControlRpc(async () => bus.getRequestConnection()),
            controlTimeoutMs: CONNECTED_OUTPUT_RELEASE_TIMEOUT_MS,
          }).catch(() => undefined);
      }
      if (settlement && bus) {
        await bus
          .publish(args.workspaceId, args.sessionId, settlement.events)
          .catch(() => undefined);
      }
      if (settlement) await signalBackgroundCommandWakes(settlement.wakes, args.wake);
    },
  };
}

/** Control requests of a session's output look at a command it no longer
 * reaches through its current machine. */
const CONNECTED_COMMAND_LOOK_TIMEOUT_MS = 10_000;

/**
 * Reads a running Connected Machine command's output from the machine that
 * runs it, for an attempt that did not start it: after its session moved to
 * another machine and back, or in any later turn. The command keeps running
 * on its machine whatever the session does, and its immutable ledger locator
 * says where. Each look stores the output produced since the previous one
 * (one reader per command, reused for the attempt) and settles nothing: the
 * runner's pushed exit or the reconciler settles it. A look never wakes a
 * sleeping sandbox. `false` when the command is not a running Connected
 * Machine command of this session, or its machine cannot be read now; the
 * durable output then answers the read.
 */
export function connectedCommandOutputLook(
  db: Database,
  bus: EventBus,
  ids: { accountId: string; workspaceId: string; sessionId: string },
  /** Tests inject the machine reader. */
  readerFor?: (locator: {
    controlWorkspaceId: string;
    enrollmentId: string;
    connectionInstanceId: string;
  }) => Pick<OpStreamExecClient, "readExisting">,
): (commandId: string) => Promise<boolean> {
  const readers = new Map<
    string,
    { opId: string; client: Pick<OpStreamExecClient, "readExisting"> }
  >();
  const capture = captureConnectedCommandOutput(db, ids, bus);
  return async (commandId) => {
    const getOpStreamConnection = bus.getOpStreamConnection?.bind(bus);
    if (!readerFor && !getOpStreamConnection) return false;
    let reader = readers.get(commandId);
    if (!reader) {
      const locator = await runningConnectedCommandLocator(db, { ...ids, commandId });
      if (!locator) return false;
      reader = {
        opId: locator.opId,
        client:
          readerFor?.(locator) ??
          new OpStreamExecClient({
            workspaceId: locator.controlWorkspaceId,
            agentId: locator.enrollmentId,
            connectionInstanceId: locator.connectionInstanceId,
            epoch: 0,
            controlRpc: withoutWaking(new NatsControlRpc(async () => bus.getRequestConnection())),
            rpcSubject: subjectFor(
              locator.controlWorkspaceId,
              locator.enrollmentId,
              locator.connectionInstanceId,
            ),
            transport: new NatsOpStreamTransport(async () => getOpStreamConnection!()),
            controlTimeoutMs: CONNECTED_COMMAND_LOOK_TIMEOUT_MS,
            retryClock: defaultSelfhostedRetryClock,
            journal: { attachGeneration: () => String(Date.now()), persistSettled: () => {} },
          }),
      };
      readers.set(commandId, reader);
    }
    try {
      await replayConnectedCommandOutput(reader.client, reader.opId, false, async (frames) =>
        capture(commandId, frames),
      );
      return true;
    } catch {
      // Released, lost, offline or replaced: the stored output and the
      // command's own settlement answer the read.
      readers.delete(commandId);
      return false;
    }
  };
}
