import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  SandboxProviderCommand,
  ModalRouterProviderCommand,
  type SessionEvent,
} from "@opengeni/contracts";
import { withRlsContext, withSessionActivityRlsContext, type Database } from "./database";
import { lockSessionEventWriteRows } from "./session-control";
import { appendSessionCommandOutput } from "./session-command-output";
import * as schema from "./schema";

type ProcessScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  processId: string;
};

/** Bound to an already-authorized exact process scope by runtime wiring. */
export function retainedProviderCommandPersistence(
  db: Database,
  scope: ProcessScope,
  publish?: (events: SessionEvent[]) => Promise<void>,
) {
  return {
    load: () => getRetainedProviderCommand(db, scope),
    acknowledge: (command: SandboxProviderCommand) =>
      acknowledgeRetainedProviderOutput(db, scope, command),
    reserveInput: (byteLength?: number) => reserveRetainedProviderInput(db, scope, byteLength),
    captureRouterPage: async (page: RetainedRouterOutputPage) => {
      const result = await captureRetainedRouterOutput(db, scope, page);
      // A committed capture is authoritative even if live fanout fails.
      if (result.events.length && publish) await publish(result.events).catch(() => undefined);
      return { command: result.command, captured: result.captured };
    },
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
  if (next.kind !== "modal-control-v1")
    throw new Error("Byte-offset command output requires atomic capture");
  return withRlsContext(db, scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.sandboxRetainedProcesses)
      .where(processWhere(scope))
      .for("update")
      .limit(1);
    if (!row?.providerCommand) throw new Error("Retained provider command is unavailable");
    const previous = SandboxProviderCommand.parse(row.providerCommand);
    if (previous.kind !== "modal-control-v1")
      throw new Error("Legacy acknowledgment cannot advance byte-offset output");
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

export type RetainedRouterOutputPage = {
  expected: ModalRouterProviderCommand;
  command: ModalRouterProviderCommand;
  stdout: string;
  stderr: string;
};

export function validateRouterOutputAdvance(page: RetainedRouterOutputPage): void {
  const before = ModalRouterProviderCommand.parse(page.expected);
  const after = ModalRouterProviderCommand.parse(page.command);
  if (!sameExecution(before, after)) throw new Error("Output capture changed execution identity");
  for (const stream of ["stdout", "stderr"] as const) {
    const oldCursor = before.streams[stream],
      cursor = after.streams[stream];
    if (
      cursor.byteOffset < oldCursor.byteOffset ||
      (oldCursor.eof && (!cursor.eof || cursor.byteOffset !== oldCursor.byteOffset)) ||
      (oldCursor.exitCode !== null && !isDeepStrictEqual(oldCursor, cursor))
    )
      throw new Error("Output capture cannot regress or rewrite terminal evidence");
    if (
      cursor.byteOffset === oldCursor.byteOffset &&
      !(!oldCursor.eof && cursor.eof) &&
      (page[stream].length > 0 || cursor.utf8Remainder !== oldCursor.utf8Remainder)
    )
      throw new Error("Output without byte advancement requires the first EOF");
    if (cursor.eof && cursor.utf8Remainder !== "")
      throw new Error("EOF must flush pending UTF-8 bytes");
    if (Buffer.byteLength(page[stream]) > 4 * 1024 * 1024)
      throw new Error("Command output page exceeds its capture bound");
  }
}

/** Capture and offsets commit atomically. The session lock is acquired before
 * the process lock, matching the event-write lock order. A concurrent reader
 * with a stale cursor discards its page and reloads; it never appends overlapping
 * output or silently advances the other reader's cursor. */
export async function captureRetainedRouterOutput(
  db: Database,
  scope: ProcessScope,
  page: RetainedRouterOutputPage,
): Promise<{ command: ModalRouterProviderCommand; events: SessionEvent[]; captured: boolean }> {
  validateRouterOutputAdvance(page);
  return await withSessionActivityRlsContext(db, scope, async (tx) => {
    const locks = await lockSessionEventWriteRows(tx, {
      workspaceId: scope.workspaceId,
      sessionIds: [scope.sessionId],
      controlLock: "share",
    });
    if (locks.sessions[0]?.accountId !== scope.accountId)
      throw new Error("Command output session not found");
    const [row] = await tx
      .select()
      .from(schema.sandboxRetainedProcesses)
      .where(processWhere(scope))
      .for("update")
      .limit(1);
    if (!row?.providerCommand || row.providerBackend !== "modal")
      throw new Error("Retained provider command is unavailable");
    const current = ModalRouterProviderCommand.parse(row.providerCommand);
    if (!sameExecution(current, page.expected))
      throw new Error("Output capture does not own this execution");
    if (!isDeepStrictEqual(current, page.expected))
      return { command: current, events: [], captured: false };
    const events: SessionEvent[] = [];
    for (const stream of ["stdout", "stderr"] as const) {
      const before = current.streams[stream],
        after = page.command.streams[stream];
      if (page[stream])
        events.push(
          ...(await appendSessionCommandOutput(tx, {
            ...scope,
            commandId: scope.processId,
            stream,
            streamFidelity: current.pty ? "merged" : "separate",
            chunkId: `modal-router:${current.execId}:${stream}:${before.byteOffset}:${after.byteOffset}:${after.eof ? 1 : 0}`,
            chunk: page[stream],
          })),
        );
    }
    await tx
      .update(schema.sandboxRetainedProcesses)
      .set({ providerCommand: page.command })
      .where(processWhere(scope));
    return { command: page.command, events, captured: true };
  });
}

/** Reserve a strictly increasing provider stdin index before dispatch. An
 * ambiguous send consumes its index and is never silently replayed. */
export async function reserveRetainedProviderInput(
  db: Database,
  scope: ProcessScope,
  byteLength?: number,
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
    const router = row.providerCommand.kind === "modal-router-v1";
    if (router && (!Number.isSafeInteger(byteLength) || byteLength! <= 0))
      throw new Error("Byte-offset stdin requires a positive byte reservation");
    const index = row.providerCommandInputIndex + (router ? byteLength! : 1);
    if (!Number.isSafeInteger(index)) throw new Error("Provider stdin sequence exhausted");
    await tx
      .update(schema.sandboxRetainedProcesses)
      .set({ providerCommandInputIndex: index })
      .where(processWhere(scope));
    return router ? row.providerCommandInputIndex : index;
  });
}
