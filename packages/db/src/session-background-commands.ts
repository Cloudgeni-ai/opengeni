import type {
  SessionBackgroundCommand,
  SessionBackgroundCommandActivity,
} from "@opengeni/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "./database";
import { withRlsContext } from "./database";
import * as schema from "./schema";

function commandPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return Array.from(normalized).slice(0, 512).join("");
}

function mapCommand(
  row: typeof schema.sessionBackgroundCommands.$inferSelect,
): SessionBackgroundCommand {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    provider: row.provider,
    state: row.state,
    commandPreview: row.commandPreview,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    exitCode: row.exitCode ?? null,
    settlementReason: row.settlementReason ?? null,
    startedAt: row.startedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function backgroundCommandActivityForSessions(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionIds: string[] },
): Promise<Map<string, SessionBackgroundCommandActivity>> {
  if (input.sessionIds.length === 0) return new Map();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .select({
          sessionId: schema.sessionBackgroundCommands.sessionId,
          count: sql<number>`count(*)::int`,
          stoppingCount: sql<number>`count(*) filter (where ${schema.sessionBackgroundCommands.state} = 'stopping')::int`,
        })
        .from(schema.sessionBackgroundCommands)
        .where(
          and(
            eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
            inArray(schema.sessionBackgroundCommands.sessionId, input.sessionIds),
            inArray(schema.sessionBackgroundCommands.state, ["running", "stopping"]),
          ),
        )
        .groupBy(schema.sessionBackgroundCommands.sessionId);
      return new Map(
        rows.map((row) => [
          row.sessionId,
          {
            state: Number(row.stoppingCount) > 0 ? ("stopping" as const) : ("running" as const),
            count: Number(row.count),
          },
        ]),
      );
    },
  );
}

export async function listSessionBackgroundCommands(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<SessionBackgroundCommand[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .select()
        .from(schema.sessionBackgroundCommands)
        .where(
          and(
            eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
            eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
          ),
        )
        .orderBy(
          desc(schema.sessionBackgroundCommands.startedAt),
          desc(schema.sessionBackgroundCommands.id),
        )
        .limit(1000);
      return rows.map(mapCommand);
    },
  );
}

export async function adoptManagedSessionBackgroundCommand(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    commandId: string;
    retainedProcessId: string;
    command: string;
  },
): Promise<SessionBackgroundCommand> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [process] = await tx
          .select({
            accountId: schema.sandboxRetainedProcesses.accountId,
            workspaceId: schema.sandboxRetainedProcesses.workspaceId,
            sessionId: schema.sandboxRetainedProcesses.sessionId,
            state: schema.sandboxRetainedProcesses.state,
          })
          .from(schema.sandboxRetainedProcesses)
          .where(eq(schema.sandboxRetainedProcesses.id, input.retainedProcessId))
          .for("update")
          .limit(1);
        if (
          !process ||
          process.accountId !== input.accountId ||
          process.workspaceId !== input.workspaceId ||
          process.sessionId !== input.sessionId ||
          process.state !== "active"
        ) {
          throw new Error("Managed background command requires its exact active retained process");
        }
        const [row] = await tx
          .insert(schema.sessionBackgroundCommands)
          .values({
            id: input.commandId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            provider: "managed",
            state: "running",
            retainedProcessId: input.retainedProcessId,
            commandPreview: commandPreview(input.command),
          })
          .onConflictDoUpdate({
            target: schema.sessionBackgroundCommands.retainedProcessId,
            set: { updatedAt: new Date() },
          })
          .returning();
        if (!row) throw new Error("Managed background command adoption returned no row");
        if (
          row.accountId !== input.accountId ||
          row.workspaceId !== input.workspaceId ||
          row.sessionId !== input.sessionId ||
          row.provider !== "managed" ||
          row.retainedProcessId !== input.retainedProcessId
        ) {
          throw new Error("Managed background command adoption conflicted with another identity");
        }
        return mapCommand(row);
      }),
  );
}

export async function adoptConnectedMachineSessionBackgroundCommand(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    commandId: string;
    enrollmentId: string;
    connectionInstanceId: string;
    opId: string;
    command: string;
  },
): Promise<SessionBackgroundCommand> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.sessionBackgroundCommands)
        .values({
          id: input.commandId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          provider: "connected_machine",
          state: "running",
          enrollmentId: input.enrollmentId,
          connectionInstanceId: input.connectionInstanceId,
          opId: input.opId,
          commandPreview: commandPreview(input.command),
        })
        .onConflictDoUpdate({
          target: [
            schema.sessionBackgroundCommands.workspaceId,
            schema.sessionBackgroundCommands.enrollmentId,
            schema.sessionBackgroundCommands.connectionInstanceId,
            schema.sessionBackgroundCommands.opId,
          ],
          targetWhere: sql`${schema.sessionBackgroundCommands.provider} = 'connected_machine'`,
          set: { updatedAt: new Date() },
        })
        .returning();
      if (!row) throw new Error("Connected Machine background command adoption returned no row");
      return mapCommand(row);
    },
  );
}

export async function requestSessionBackgroundCommandCancellation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    commandId: string;
    subjectId: string;
  },
): Promise<{ command: SessionBackgroundCommand | null; accepted: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.sessionBackgroundCommands)
          .where(
            and(
              eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
              eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
              eq(schema.sessionBackgroundCommands.id, input.commandId),
            ),
          )
          .for("update")
          .limit(1);
        if (!current) return { command: null, accepted: false };
        if (current.state !== "running") {
          return { command: mapCommand(current), accepted: false };
        }
        const [updated] = await tx
          .update(schema.sessionBackgroundCommands)
          .set({
            state: "stopping",
            cancelRequestedAt: new Date(),
            cancelRequestedBy: input.subjectId.slice(0, 1024),
            updatedAt: new Date(),
          })
          .where(eq(schema.sessionBackgroundCommands.id, current.id))
          .returning();
        if (current.retainedProcessId) {
          await tx
            .update(schema.sandboxRetainedProcesses)
            .set({ reconcileAfter: new Date(), lastReconcileOutcome: "cancel_requested" })
            .where(
              and(
                eq(schema.sandboxRetainedProcesses.id, current.retainedProcessId),
                eq(schema.sandboxRetainedProcesses.state, "active"),
                sql`${schema.sandboxRetainedProcesses.reconcileClaimId} is null`,
              ),
            );
        }
        return { command: mapCommand(updated!), accepted: true };
      }),
  );
}

export async function settleSessionBackgroundCommandForRetainedProcess(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    retainedProcessId: string;
    outcome: "exited" | "lost";
    exitCode: number | null;
    reason: string;
  },
): Promise<SessionBackgroundCommand | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .update(schema.sessionBackgroundCommands)
        .set({
          state: input.outcome,
          exitCode: input.outcome === "exited" ? input.exitCode : null,
          settlementReason: input.reason.slice(0, 512),
          settledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
            eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
            eq(schema.sessionBackgroundCommands.retainedProcessId, input.retainedProcessId),
            inArray(schema.sessionBackgroundCommands.state, ["running", "stopping"]),
          ),
        )
        .returning();
      return row ? mapCommand(row) : null;
    },
  );
}
