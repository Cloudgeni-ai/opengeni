import type { OperationCompleted } from "@opengeni/agent-proto";
import { settleConnectedMachineSessionBackgroundCommand, type Database } from "@opengeni/db";
import { locateConnectedCommandCompletion } from "@opengeni/db/session-background-commands";
import type { EventBus } from "@opengeni/events";

/** The authenticated process subject, never the payload, supplies machine
 * identity. Historical routes are intentional: changing a session's current
 * route does not change the daemon that owns its already-started command. */
export async function ingestConnectedCommandCompletion(
  db: Database,
  ids: { workspaceId: string; agentId: string; connectionInstanceId: string },
  completed: OperationCompleted,
  bus?: EventBus,
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
  const exit = completed.exit;
  const code = exit.failureCode.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  const settlement = await settleConnectedMachineSessionBackgroundCommand(db, {
    ...command,
    ...identity,
    outcome: "exited",
    exitCode: exit.exitCode,
    reason: code
      ? `op_failure_${code}`
      : exit.cancelled
        ? "op_cancelled"
        : exit.timedOut
          ? "op_timed_out"
          : "op_exit",
    ...(code ? { failure: { code, detail: exit.failureDetail, retryable: false as const } } : {}),
  });
  // The existing atomic settlement owns audit/input/wake behavior. This event
  // grants neither output custody nor final ACK; normal reads/reaping collect it.
  if (settlement && bus)
    await bus.publish(command.workspaceId, command.sessionId, settlement.events);
}
