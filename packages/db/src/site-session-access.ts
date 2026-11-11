import { and, eq, sql } from "drizzle-orm";
import { withWorkspaceSubjectRls, type Database } from "./database";
import * as schema from "./schema";

/** Live, viewer-specific permission, not an origin label or a tree-wide grant. */
export function siteSessionAccessFilter(siteId: string, subjectId: string) {
  return sql`(
    (${schema.sessions.siteId} = ${siteId}::uuid AND ${schema.sessions.siteAccessRootId} IS NOT NULL)
    OR EXISTS (
      SELECT 1 FROM site_session_access access
      JOIN workspace_artifacts site ON site.workspace_id=access.workspace_id AND site.id=access.site_id
      WHERE access.workspace_id=${schema.sessions.workspaceId} AND access.session_id=${schema.sessions.id}
        AND access.site_id=${siteId}::uuid AND access.owner_subject_id=${subjectId}
        AND ${schema.sessions.ownerSubjectId}=${subjectId} AND ${schema.sessions.siteAccessRootId} IS NULL
        AND site.visibility='user_private' AND site.owner_subject_id=${subjectId} AND site.status='active'
    )
  )`;
}

export async function canAccessSessionFromSite(
  db: Database,
  input: { workspaceId: string; siteId: string; sessionId: string; subjectId: string },
): Promise<boolean> {
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const rows = await tx
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
          siteSessionAccessFilter(input.siteId, input.subjectId),
        ),
      )
      .limit(1);
    return rows.length === 1;
  });
}

export async function listSiteSessionAccess(
  db: Database,
  input: { workspaceId: string; siteId: string; subjectId: string },
): Promise<string[]> {
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const rows = await tx
      .select({ id: schema.siteSessionAccess.sessionId })
      .from(schema.siteSessionAccess)
      .where(
        and(
          eq(schema.siteSessionAccess.workspaceId, input.workspaceId),
          eq(schema.siteSessionAccess.siteId, input.siteId),
          eq(schema.siteSessionAccess.ownerSubjectId, input.subjectId),
        ),
      );
    return rows.map((row) => row.id);
  });
}

/** The API resolves the human from verified authority; this rechecks both owners under RLS. */
export async function setSiteSessionAccess(
  db: Database,
  input: {
    workspaceId: string;
    siteId: string;
    sessionId: string;
    subjectId: string;
    allowed: boolean;
  },
): Promise<boolean> {
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    if (!input.allowed) {
      await tx
        .delete(schema.siteSessionAccess)
        .where(
          and(
            eq(schema.siteSessionAccess.workspaceId, input.workspaceId),
            eq(schema.siteSessionAccess.siteId, input.siteId),
            eq(schema.siteSessionAccess.sessionId, input.sessionId),
            eq(schema.siteSessionAccess.ownerSubjectId, input.subjectId),
          ),
        );
      return true;
    }
    const [target] = await tx
      .select({ accountId: schema.sessions.accountId })
      .from(schema.sessions)
      .innerJoin(
        schema.workspaceArtifacts,
        and(
          eq(schema.workspaceArtifacts.workspaceId, schema.sessions.workspaceId),
          eq(schema.workspaceArtifacts.id, input.siteId),
        ),
      )
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
          eq(schema.sessions.ownerSubjectId, input.subjectId),
          eq(schema.workspaceArtifacts.ownerSubjectId, input.subjectId),
          eq(schema.workspaceArtifacts.visibility, "user_private"),
          eq(schema.workspaceArtifacts.status, "active"),
          sql`${schema.sessions.siteAccessRootId} IS NULL`,
        ),
      )
      .for("share");
    if (!target) return false;
    await tx
      .insert(schema.siteSessionAccess)
      .values({
        accountId: target.accountId,
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        sessionId: input.sessionId,
        ownerSubjectId: input.subjectId,
      })
      .onConflictDoNothing();
    return true;
  });
}
