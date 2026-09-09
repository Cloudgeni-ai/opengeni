import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { SandboxProviderCommand } from "@opengeni/contracts";
import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

type ProcessScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  processId: string;
};

/** Bound to an already-authorized exact process scope by runtime wiring. */
export function retainedProviderCommandPersistence(db: Database, scope: ProcessScope) {
  return {
    load: () => getRetainedProviderCommand(db, scope),
    acknowledge: (command: SandboxProviderCommand) =>
      acknowledgeRetainedProviderOutput(db, scope, command),
    reserveInput: () => reserveRetainedProviderInput(db, scope),
  };
}

function processWhere(scope: ProcessScope) {
  return and(
    eq(schema.sandboxRetainedProcesses.accountId, scope.accountId),
    eq(schema.sandboxRetainedProcesses.workspaceId, scope.workspaceId),
    eq(schema.sandboxRetainedProcesses.sessionId, scope.sessionId),
    eq(schema.sandboxRetainedProcesses.id, scope.processId),
  );
}

function sameExecution(a: SandboxProviderCommand, b: SandboxProviderCommand): boolean {
  return (
    a.kind === b.kind &&
    a.sandboxId === b.sandboxId &&
    a.taskId === b.taskId &&
    a.execId === b.execId &&
    Boolean(a.pty) === Boolean(b.pty)
  );
}

/** Promotion and the opaque provider locator commit together. Preserve the
 * existing durable-but-output-rejected promotion contract: its typed rejection
 * is rethrown only AFTER this outer transaction has committed the locator. */
export function createProviderCommandRetainer<Input extends ProcessScope, Process>(
  promote: (db: Database, input: Input) => Promise<Process>,
  recoverDurablePromotion: (error: unknown) => Process | null,
) {
  return async function retainWorkspaceProviderCommand(
    db: Database,
    input: Input & { providerCommand?: SandboxProviderCommand | null },
  ): Promise<Process> {
    if (!input.providerCommand) return promote(db, input);
    const command = SandboxProviderCommand.parse(input.providerCommand);
    const result = await withRlsContext(db, input, async (tx) => {
      let process: Process;
      let rejection: unknown = null;
      try {
        process = await promote(tx, input);
      } catch (error) {
        const durable = recoverDurablePromotion(error);
        if (durable === null) throw error;
        process = durable;
        rejection = error;
      }
      const [row] = await tx
        .select()
        .from(schema.sandboxRetainedProcesses)
        .where(processWhere(input))
        .for("update")
        .limit(1);
      if (!row || row.providerBackend !== "modal" || row.providerInstanceId !== command.sandboxId)
        throw new Error("Provider command does not match its retained sandbox");
      if (row.providerCommand) {
        if (!sameExecution(SandboxProviderCommand.parse(row.providerCommand), command))
          throw new Error("Retained process already has a different provider execution");
      } else {
        await tx
          .update(schema.sandboxRetainedProcesses)
          .set({ providerCommand: command })
          .where(processWhere(input));
      }
      return { process, rejection };
    });
    if (result.rejection) throw result.rejection;
    return result.process;
  };
}

export async function getRetainedProviderCommand(
  db: Database,
  scope: ProcessScope,
): Promise<SandboxProviderCommand | null> {
  return withRlsContext(db, scope, async (tx) => {
    const [row] = await tx
      .select({ command: schema.sandboxRetainedProcesses.providerCommand })
      .from(schema.sandboxRetainedProcesses)
      .where(processWhere(scope))
      .limit(1);
    return row?.command ? SandboxProviderCommand.parse(row.command) : null;
  });
}

/** Call only after all output in this provider page has been durably captured.
 * A stale acknowledgment cannot roll back a cursor or erase terminal evidence. */
export async function acknowledgeRetainedProviderOutput(
  db: Database,
  scope: ProcessScope,
  candidate: SandboxProviderCommand,
): Promise<SandboxProviderCommand> {
  const next = SandboxProviderCommand.parse(candidate);
  return withRlsContext(db, scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.sandboxRetainedProcesses)
      .where(processWhere(scope))
      .for("update")
      .limit(1);
    if (!row?.providerCommand) throw new Error("Retained provider command is unavailable");
    const previous = SandboxProviderCommand.parse(row.providerCommand);
    if (!sameExecution(previous, next))
      throw new Error("Output acknowledgment changed provider execution identity");
    const merged = structuredClone(previous);
    for (const stream of ["stdout", "stderr"] as const) {
      const oldCursor = previous.streams[stream];
      const newCursor = next.streams[stream];
      if (newCursor.batchIndex < oldCursor.batchIndex) continue;
      if (
        (newCursor.batchIndex === oldCursor.batchIndex || oldCursor.exitCode !== null) &&
        !isDeepStrictEqual(oldCursor, newCursor)
      )
        throw new Error("Provider output acknowledgment conflicts with retained evidence");
      merged.streams[stream] = newCursor;
    }
    await tx
      .update(schema.sandboxRetainedProcesses)
      .set({ providerCommand: merged })
      .where(processWhere(scope));
    return merged;
  });
}

/** Reserve a strictly increasing provider stdin index before dispatch. An
 * ambiguous send consumes its index and is never silently replayed. */
export async function reserveRetainedProviderInput(
  db: Database,
  scope: ProcessScope,
): Promise<number> {
  return withRlsContext(db, scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.sandboxRetainedProcesses)
      .where(processWhere(scope))
      .for("update")
      .limit(1);
    if (!row?.providerCommand || row.state !== "active")
      throw new Error("Active retained provider command is unavailable");
    const index = row.providerCommandInputIndex + 1;
    if (!Number.isSafeInteger(index)) throw new Error("Provider stdin sequence exhausted");
    await tx
      .update(schema.sandboxRetainedProcesses)
      .set({ providerCommandInputIndex: index })
      .where(processWhere(scope));
    return index;
  });
}
