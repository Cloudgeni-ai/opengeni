import { RepositoryResourceRef } from "@opengeni/contracts";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import type { Database } from "./database";
import { withWorkspaceSubjectRls } from "./database";
import * as schema from "./schema";

/** Most sessions one lookup reads; the caller keeps the first few distinct repositories. */
const MAX_RECENT_SESSIONS = 50;

/**
 * Repository resources on the top-level sessions `subjectId` itself started in
 * this workspace since `since`, most recently active session first, in each
 * session's own resource order. Duplicates are kept; the caller decides
 * identity.
 *
 * This reads only the subject's own sessions (`created_by_kind = 'subject'`,
 * exact subject id), never another member's, and only root sessions, so a
 * repository an agent attached to a child session does not count as the
 * person's choice. It is a usage signal, not authority: whoever attaches one
 * of these repositories must still check that the person may use it now.
 */
export async function listRecentSessionRepositoryResources(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    since: Date;
    sessionLimit?: number;
  },
): Promise<RepositoryResourceRef[]> {
  const sessionLimit = Math.min(
    MAX_RECENT_SESSIONS,
    Math.max(1, Math.floor(input.sessionLimit ?? MAX_RECENT_SESSIONS)),
  );
  const rows = await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) =>
      await scopedDb
        .select({ resources: schema.sessions.resources })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.createdByKind, "subject"),
            eq(schema.sessions.createdBySubjectId, input.subjectId),
            isNull(schema.sessions.parentSessionId),
            gte(schema.sessions.updatedAt, input.since),
          ),
        )
        .orderBy(desc(schema.sessions.updatedAt), desc(schema.sessions.id))
        .limit(sessionLimit),
  );
  const repositories: RepositoryResourceRef[] = [];
  for (const row of rows) {
    for (const resource of Array.isArray(row.resources) ? row.resources : []) {
      const parsed = RepositoryResourceRef.safeParse(resource);
      if (parsed.success) repositories.push(parsed.data);
    }
  }
  return repositories;
}
