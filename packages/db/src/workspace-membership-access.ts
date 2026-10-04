import { asc, eq } from "drizzle-orm";
import type { Permission, WorkspaceMember } from "@opengeni/contracts";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";
import { normalizeWorkspaceMembershipPermissions } from "./workspace-membership-permissions";

export async function grantWorkspaceAccess(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    subjectLabel?: string;
    role?: string;
    permissions: Permission[];
  },
): Promise<void> {
  await db
    .insert(schema.workspaceMemberships)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel ?? null,
      role: input.role ?? "member",
      permissions: input.permissions,
    })
    .onConflictDoUpdate({
      target: [schema.workspaceMemberships.subjectId, schema.workspaceMemberships.workspaceId],
      set: {
        subjectLabel: input.subjectLabel ?? null,
        role: input.role ?? "member",
        permissions: input.permissions,
        updatedAt: new Date(),
      },
    });
}

/** Insert-only membership grant: never overwrites an existing row. True when inserted. */
export async function insertWorkspaceMembershipIfAbsent(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    role?: string;
    permissions: Permission[];
  },
): Promise<boolean> {
  const inserted = await db
    .insert(schema.workspaceMemberships)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      subjectLabel: null,
      role: input.role ?? "member",
      permissions: input.permissions,
    })
    .onConflictDoNothing({
      target: [schema.workspaceMemberships.subjectId, schema.workspaceMemberships.workspaceId],
    })
    .returning({ subjectId: schema.workspaceMemberships.subjectId });
  return inserted.length > 0;
}

export async function listWorkspaceMembers(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspaceMemberships)
      .where(eq(schema.workspaceMemberships.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceMemberships.createdAt));
    return rows.map(mapWorkspaceMember);
  });
}

function mapWorkspaceMember(row: typeof schema.workspaceMemberships.$inferSelect): WorkspaceMember {
  return {
    subjectId: row.subjectId,
    subjectLabel: row.subjectLabel,
    role: row.role,
    permissions: normalizeWorkspaceMembershipPermissions(row.permissions),
    createdAt: row.createdAt.toISOString(),
  };
}
