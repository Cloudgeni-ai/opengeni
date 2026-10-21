import {
  adoptConnectedMachineSessionBackgroundCommand,
  settleConnectedMachineSessionBackgroundCommand,
  type Database,
} from "@opengeni/db";
import { recordConnectedCommandOutputConsumption } from "@opengeni/db/session-background-commands";
import { createConnectedCommandOutputCapture } from "@opengeni/db/session-command-output";
import type { EventBus } from "@opengeni/events";
import { NatsControlRpc, type SelfhostedSessionDeps } from "@opengeni/runtime/sandbox";
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
    },
  };
}
