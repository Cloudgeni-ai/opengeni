import { AgentEventAck, type OperationInventory } from "@opengeni/agent-proto";
import { getEnrollment, type Database } from "@opengeni/db";
import {
  classifyConnectedCommandOps,
  CONNECTED_COMMAND_CLASSIFY_LIMIT,
  recordConnectedCommandOutputRelease,
  type ConnectedCommandInventoryRow,
} from "@opengeni/db/session-background-commands";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { OP_START_RESEND_HORIZON_MS } from "@opengeni/runtime/sandbox";
import {
  collectConnectedCommandCompletion,
  collectExitedConnectedCommandOutput,
  type ConnectedCommandCollectionDeps,
} from "./command-completion";

/** One reported operation, as the runner described it. */
export type ReportedOperation = {
  opId: string;
  /** The connection generation its OpStart carried; "0" when unknown. */
  connectionGeneration: string;
  complete: boolean;
  completedAgeMs: string;
};

/** What Opengeni does about one inventory page. */
export type InventoryDecision = {
  /** Ops the runner ends: cancels a running one, releases a completed one. */
  end: string[];
  /** Stored outputs whose release the answer completes: recorded released. */
  released: ConnectedCommandInventoryRow[];
  /** Completed ops of a running command: their exit is collected now. */
  collectCompletions: string[];
  /** Completed ops of an exited command whose output was never stored. */
  collectOutputs: ConnectedCommandInventoryRow[];
};

/** The row that decides for an op: a command in flight, then an exited one
 * whose output is still open, then any other. */
function decidingRow(
  rows: readonly ConnectedCommandInventoryRow[] | undefined,
): ConnectedCommandInventoryRow | undefined {
  if (!rows?.length) return undefined;
  const rank = (row: ConnectedCommandInventoryRow) =>
    row.state === "running" || row.state === "stopping"
      ? 0
      : row.state === "exited" && !row.outputConsumed && !row.outputUnavailable
        ? 1
        : 2;
  return [...rows].sort((left, right) => rank(left) - rank(right))[0];
}

/**
 * Decide one inventory page. With a command row of this exact connection
 * instance, the row's custody decides:
 * - in flight: kept; a completed op's exit is collected now;
 * - exited with its output stored: ended (the runner releases it), and the
 *   release recorded; exited with output recorded unavailable, or lost: ended;
 * - exited with output never stored: kept, and a completed op's output is
 *   collected now. Nothing is dropped before Opengeni has custody of it.
 * Without a row (foreground work, or a command deleted with its chat):
 * - running: ended only when it started on an earlier connection generation
 *   than the current one (a different process held the connection since, and
 *   every requester was answered). Never on age: foreground work may
 *   legitimately run for hours. Generation 0 (an older Opengeni) is kept;
 * - completed: ended when it started on an earlier generation, or when it
 *   exited longer ago than any OpStart can still reach the runner, so no
 *   requester can still be reading it.
 */
export function decideInventoryPage(input: {
  operations: readonly ReportedOperation[];
  commands: ReadonlyMap<string, readonly ConnectedCommandInventoryRow[]>;
  connectionGeneration: string;
}): InventoryDecision {
  const current = BigInt(input.connectionGeneration);
  const decision: InventoryDecision = {
    end: [],
    released: [],
    collectCompletions: [],
    collectOutputs: [],
  };
  for (const operation of input.operations) {
    const row = decidingRow(input.commands.get(operation.opId));
    if (row) {
      if (row.state === "running" || row.state === "stopping") {
        if (operation.complete) decision.collectCompletions.push(operation.opId);
      } else if (row.state === "lost" || row.outputUnavailable) {
        decision.end.push(operation.opId);
      } else if (row.outputConsumed) {
        decision.end.push(operation.opId);
        if (!row.outputReleased && row.outputExitSeq !== null) decision.released.push(row);
      } else if (operation.complete) {
        decision.collectOutputs.push(row);
      }
      continue;
    }
    const startedOn = BigInt(operation.connectionGeneration || "0");
    const earlier = startedOn > 0n && startedOn < current;
    const expired =
      operation.complete && BigInt(operation.completedAgeMs || "0") >= OP_START_RESEND_HORIZON_MS;
    if (earlier || expired) decision.end.push(operation.opId);
  }
  return decision;
}

/** The outcome of one inventory page. */
export type OperationInventoryAnswer =
  | { answered: false; reason: "not_current" | "invalid" | "no_transport" }
  | ({ answered: true } & InventoryDecision);

/**
 * Answer one page of the inventory a runner process reports, on each
 * connection and while it holds completed output nobody released: which ops
 * to end, in the same exchange, then collect what Opengeni has not stored yet
 * while the runner is talking. The authenticated events subject supplies the
 * exact process identity; a process that does not hold its enrollment's
 * connection gets no answer (it repeats the page while connected). The
 * runner starts every such exchange, so nothing here reaches a runner that is
 * not talking, such as a sleeping compute sandbox.
 */
export async function answerOperationInventory(
  db: Database,
  ids: { workspaceId: string; agentId: string; connectionInstanceId: string },
  inventory: OperationInventory,
  bus: EventBus | undefined,
  observability?: Observability,
  collection?: Omit<ConnectedCommandCollectionDeps, "bus">,
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
  const commands = await classifyConnectedCommandOps(db, {
    controlWorkspaceId: ids.workspaceId,
    enrollmentId: ids.agentId,
    connectionInstanceId: ids.connectionInstanceId,
    opIds: [...new Set(operations.map((operation) => operation.opId))],
  });
  const decision = decideInventoryPage({
    operations,
    commands,
    connectionGeneration: String(enrollment.connectionGeneration),
  });
  const warn = (message: string, opId: string, error: unknown) =>
    observability?.warn?.(message, {
      workspaceId: ids.workspaceId,
      enrollmentId: ids.agentId,
      opId,
      error: error instanceof Error ? error.message : String(error),
    });
  // Record each release before answering, so an output is never dropped with
  // its obligation left open. Opengeni already holds the output; should the
  // answer be lost, or recording fail (nothing is answered), the runner
  // repeats the page.
  for (const row of decision.released) {
    await recordConnectedCommandOutputRelease(db, { ...row, exitSeq: row.outputExitSeq! });
  }
  connection.publish(
    `agent.${ids.workspaceId}.${ids.agentId}.connection.${ids.connectionInstanceId}.ack`,
    AgentEventAck.encode({
      ack: {
        $case: "operationInventory",
        operationInventory: {
          reportId: inventory.reportId,
          page: inventory.page,
          endOpIds: decision.end,
        },
      },
    }).finish(),
  );
  if (decision.end.length > 0) {
    observability?.info?.("Told a runner to end operations Opengeni no longer needs", {
      workspaceId: ids.workspaceId,
      enrollmentId: ids.agentId,
      reported: operations.length,
      ended: decision.end.length,
    });
  }
  const deps = { ...collection, bus };
  for (const opId of decision.collectCompletions) {
    await collectConnectedCommandCompletion(db, ids, opId, deps, { acknowledge: false }).catch(
      (error: unknown) => warn("Failed to collect a reported command exit", opId, error),
    );
  }
  for (const row of decision.collectOutputs) {
    await collectExitedConnectedCommandOutput(db, row, deps).catch((error: unknown) =>
      warn("Failed to collect a reported command output", row.opId, error),
    );
  }
  return { answered: true, ...decision };
}
