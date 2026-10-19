import { AgentEventAck, type OperationInventory } from "@opengeni/agent-proto";
import { getEnrollment, type Database } from "@opengeni/db";
import {
  classifyConnectedCommandOps,
  CONNECTED_COMMAND_CLASSIFY_LIMIT,
} from "@opengeni/db/session-background-commands";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";

/** What one inventory page reported, as Opengeni decided it. */
export type OperationInventoryAnswer =
  | { answered: false; reason: "not_current" | "invalid" | "no_transport" }
  | { answered: true; connectionGeneration: string; stopOpIds: string[] };

/**
 * Which reported operations the runner should stop. An operation is current
 * while its command is in flight on this exact connection instance (the
 * reconciler owns it). It is not current when its command is settled, or when
 * it has no command row (foreground work, or a command deleted with its chat)
 * and it started on an earlier connection generation: a different process
 * held the connection since, and every requester of that operation was
 * already answered on the replaced-connection path. A row-less operation
 * whose generation the runner never learned (0) is kept.
 */
export function unrecognisedOperations(input: {
  operations: ReadonlyArray<{ opId: string; connectionGeneration: string }>;
  commands: ReadonlyMap<string, { terminal: boolean }>;
  connectionGeneration: string;
}): string[] {
  const current = BigInt(input.connectionGeneration);
  const stop: string[] = [];
  for (const operation of input.operations) {
    const command = input.commands.get(operation.opId);
    if (command) {
      if (command.terminal) stop.push(operation.opId);
      continue;
    }
    const startedOn = BigInt(operation.connectionGeneration || "0");
    if (startedOn > 0n && startedOn !== current) stop.push(operation.opId);
  }
  return stop;
}

/**
 * Answer one page of the inventory a runner process reports on each
 * connection: the connection's generation, and the reported operations
 * Opengeni no longer recognises, which the runner then stops. The
 * authenticated events subject supplies the exact process identity; a
 * process that does not hold its enrollment's connection gets no answer (it
 * repeats the page while connected). The answer rides the exchange the
 * runner started, so it never reaches a runner that is not talking, and
 * nothing is recorded: the next connection reports afresh.
 */
export async function answerOperationInventory(
  db: Database,
  ids: { workspaceId: string; agentId: string; connectionInstanceId: string },
  inventory: OperationInventory,
  bus: EventBus | undefined,
  observability?: Observability,
): Promise<OperationInventoryAnswer> {
  const operations = inventory.operations;
  if (
    operations.length > CONNECTED_COMMAND_CLASSIFY_LIMIT ||
    operations.some((operation) => !operation.opId || /[\s.*>]/u.test(operation.opId))
  ) {
    observability?.warn?.("Ignored a malformed runner operation inventory page", {
      workspaceId: ids.workspaceId,
      enrollmentId: ids.agentId,
      operations: operations.length,
    });
    return { answered: false, reason: "invalid" };
  }
  const connection = bus?.getOpStreamConnection?.();
  if (!connection) return { answered: false, reason: "no_transport" };
  const enrollment = await getEnrollment(db, ids.workspaceId, ids.agentId);
  if (
    !enrollment ||
    enrollment.status !== "active" ||
    enrollment.connectionInstanceId !== ids.connectionInstanceId ||
    enrollment.connectionGeneration < 1
  ) {
    return { answered: false, reason: "not_current" };
  }
  const connectionGeneration = String(enrollment.connectionGeneration);
  const commands = await classifyConnectedCommandOps(db, {
    controlWorkspaceId: ids.workspaceId,
    enrollmentId: ids.agentId,
    connectionInstanceId: ids.connectionInstanceId,
    opIds: [...new Set(operations.map((operation) => operation.opId))],
  });
  const stopOpIds = unrecognisedOperations({ operations, commands, connectionGeneration });
  connection.publish(
    `agent.${ids.workspaceId}.${ids.agentId}.connection.${ids.connectionInstanceId}.ack`,
    AgentEventAck.encode({
      ack: {
        $case: "operationInventory",
        operationInventory: {
          reportId: inventory.reportId,
          page: inventory.page,
          connectionGeneration,
          stopOpIds,
        },
      },
    }).finish(),
  );
  if (stopOpIds.length > 0) {
    observability?.info?.("Told a runner to stop operations Opengeni no longer recognises", {
      workspaceId: ids.workspaceId,
      enrollmentId: ids.agentId,
      reported: operations.length,
      stopped: stopOpIds.length,
    });
  }
  return { answered: true, connectionGeneration, stopOpIds };
}
