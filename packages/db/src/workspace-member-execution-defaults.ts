import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withWorkspaceSubjectRls } from "./database";
import * as schema from "./schema";

/**
 * "Your default machine": one person's own placement for the new chats they
 * start in one workspace. Personal (RLS: own subject only). The stored target
 * has the workspace default's shape and is revalidated on every use.
 */
export type WorkspaceMemberExecutionDefaultRow = {
  target: unknown;
  version: number;
  updatedAt: string;
};

type MemberKey = { workspaceId: string; subjectId: string };

function keyWhere(input: MemberKey) {
  return and(
    eq(schema.workspaceMemberExecutionDefaults.workspaceId, input.workspaceId),
    eq(schema.workspaceMemberExecutionDefaults.subjectId, input.subjectId),
  );
}

export async function getWorkspaceMemberExecutionDefault(
  db: Database,
  input: MemberKey,
): Promise<WorkspaceMemberExecutionDefaultRow | null> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await tx
      .select({
        target: schema.workspaceMemberExecutionDefaults.target,
        version: schema.workspaceMemberExecutionDefaults.version,
        updatedAt: schema.workspaceMemberExecutionDefaults.updatedAt,
      })
      .from(schema.workspaceMemberExecutionDefaults)
      .where(keyWhere(input))
      .limit(1);
    return row
      ? { target: row.target, version: row.version, updatedAt: row.updatedAt.toISOString() }
      : null;
  });
}

/** Saves the person's own default, replacing any earlier one. */
export async function setWorkspaceMemberExecutionDefault(
  db: Database,
  input: MemberKey & { accountId: string; target: Record<string, unknown> },
): Promise<WorkspaceMemberExecutionDefaultRow> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await tx
      .insert(schema.workspaceMemberExecutionDefaults)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        target: input.target,
      })
      .onConflictDoUpdate({
        target: [
          schema.workspaceMemberExecutionDefaults.workspaceId,
          schema.workspaceMemberExecutionDefaults.subjectId,
        ],
        set: {
          target: input.target,
          version: sql`${schema.workspaceMemberExecutionDefaults.version} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({
        target: schema.workspaceMemberExecutionDefaults.target,
        version: schema.workspaceMemberExecutionDefaults.version,
        updatedAt: schema.workspaceMemberExecutionDefaults.updatedAt,
      });
    if (!row) throw new Error("workspace member execution default was not saved");
    return { target: row.target, version: row.version, updatedAt: row.updatedAt.toISOString() };
  });
}

/** Removes the person's own default so their new chats follow the workspace default. */
export async function clearWorkspaceMemberExecutionDefault(
  db: Database,
  input: MemberKey,
): Promise<boolean> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const removed = await tx
      .delete(schema.workspaceMemberExecutionDefaults)
      .where(keyWhere(input))
      .returning({ subjectId: schema.workspaceMemberExecutionDefaults.subjectId });
    return removed.length > 0;
  });
}
