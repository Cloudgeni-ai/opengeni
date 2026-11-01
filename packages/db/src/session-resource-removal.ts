import {
  ResourceRef,
  boundSessionRemovedRepositories,
  findSessionRemovedRepository,
  parseSessionRemovedRepositories,
  repositoryMembershipKey,
  resourcesIncludeRepository,
  type SessionRemovedRepository,
} from "@opengeni/contracts";
import { and, eq, ne, sql } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/**
 * An agent asked to attach a repository a person removed from the chat. Only
 * a person (or an API caller) attaches it again.
 */
export class SessionRepositoryRemovedError extends Error {
  constructor(readonly uri: string) {
    super(`This repository was removed from this chat: ${uri}`);
    this.name = "SessionRepositoryRemovedError";
  }
}

/**
 * Who asks to attach repositories to a session: an agent attempt, or a person
 * (a signed-in human, an operator or an API caller acting for the workspace).
 */
export type RepositoryAttachRequester = "agent" | "person";

/**
 * Apply a session's repository removal records to a request that attaches
 * repositories. An agent cannot attach a removed repository; a person
 * attaching one ends its removal record.
 */
export function admitRequestedRepositories(input: {
  removedRepositories: readonly SessionRemovedRepository[];
  requested: readonly ResourceRef[];
  requester: RepositoryAttachRequester;
}): { removedRepositories: SessionRemovedRepository[]; changed: boolean } {
  const reattached = new Set<SessionRemovedRepository>();
  for (const resource of input.requested) {
    if (resource.kind !== "repository") continue;
    const entry = findSessionRemovedRepository(input.removedRepositories, resource.uri);
    if (!entry) continue;
    if (input.requester === "agent") throw new SessionRepositoryRemovedError(resource.uri);
    reattached.add(entry);
  }
  return {
    removedRepositories: input.removedRepositories.filter((entry) => !reattached.has(entry)),
    changed: reattached.size > 0,
  };
}

/**
 * The session's current resources, read live for an authority check, or null
 * when the session is not visible in the workspace. Repository membership is
 * live authority: a repository removed from the session must stop working on
 * the next Git or GitHub call, including for turns that captured an older
 * snapshot.
 */
export async function getSessionResourcesForAuthority(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<ResourceRef[] | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ resources: schema.sessions.resources })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) return null;
    const parsed = ResourceRef.array().safeParse(row.resources);
    // An unreadable stored value grants nothing.
    return parsed.success ? parsed.data : [];
  });
}

/**
 * Every live descendant of a session (children, their children, ...),
 * shallower first. Imported read-only sessions are skipped; the walk still
 * passes through them. Ids only: callers lock each session they change.
 */
export async function listSessionDescendantIdsForResourceRemoval(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<string[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = (await scopedDb.execute(sql`
      with recursive descendants(id, depth, path, imported) as (
        select child.id, 1, array[${sessionId}::uuid, child.id],
          child.imported_archive_import_id is not null
        from ${schema.sessions} child
        where child.workspace_id = ${workspaceId}
          and child.parent_session_id = ${sessionId}
        union all
        select child.id, descendants.depth + 1, descendants.path || child.id,
          child.imported_archive_import_id is not null
        from ${schema.sessions} child
        join descendants on child.parent_session_id = descendants.id
        where child.workspace_id = ${workspaceId}
          and not child.id = any(descendants.path)
      )
      select id from descendants
      where not imported
      order by depth, id
    `)) as Array<{ id: string }>;
    return [...new Set(rows.map((row) => row.id))];
  });
}

/** Most other sessions in one sandbox group a removal cleanup consults. */
const SANDBOX_GROUP_RESOURCE_LIMIT = 1_000;

/**
 * Repositories other sessions in the same sandbox group still attach. Child
 * sessions share their parent's box by default, so a turn removing a
 * repository's folder or credential binding keeps whatever another session in
 * the box still uses. An unreadable stored value contributes nothing.
 */
export async function listSandboxGroupRepositoryResources(
  db: Database,
  workspaceId: string,
  sandboxGroupId: string,
  exceptSessionId: string,
): Promise<ResourceRef[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({ resources: schema.sessions.resources })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.sandboxGroupId, sandboxGroupId),
          ne(schema.sessions.id, exceptSessionId),
        ),
      )
      .limit(SANDBOX_GROUP_RESOURCE_LIMIT);
    return rows.flatMap((row) => {
      const parsed = ResourceRef.array().safeParse(row.resources);
      return parsed.success ? parsed.data.filter((resource) => resource.kind === "repository") : [];
    });
  });
}

/**
 * Update a session's removal records under its row lock. `change` receives
 * the current records; returning null leaves the row untouched.
 */
async function updateSessionRemovedRepositories(
  db: Database,
  workspaceId: string,
  sessionId: string,
  change: (
    current: SessionRemovedRepository[],
    attached: ResourceRef[],
  ) => SessionRemovedRepository[] | null,
): Promise<void> {
  // The workspace scope runs in one transaction, so the row lock holds until
  // the update commits.
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        removedRepositories: schema.sessions.removedRepositories,
        resources: schema.sessions.resources,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .for("update")
      .limit(1);
    if (!row) return;
    const attached = ResourceRef.array().safeParse(row.resources);
    const next = change(
      parseSessionRemovedRepositories(row.removedRepositories),
      attached.success ? attached.data : [],
    );
    if (next === null) return;
    await scopedDb
      .update(schema.sessions)
      .set({ removedRepositories: boundSessionRemovedRepositories(next) })
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  });
}

/**
 * Settle sandbox cleanup for exactly these removals once a turn removed the
 * repository folders and credential bindings. The removal records stay; a
 * later removal of the same repository (a new id) stays pending.
 */
export async function settleSessionRepositoryCleanup(
  db: Database,
  workspaceId: string,
  sessionId: string,
  removalIds: readonly string[],
): Promise<void> {
  const settled = new Set(removalIds);
  if (settled.size === 0) return;
  await updateSessionRemovedRepositories(db, workspaceId, sessionId, (current) => {
    if (!current.some((entry) => entry.sandboxCleanupPending && settled.has(entry.id))) {
      return null;
    }
    return current.map((entry) =>
      settled.has(entry.id) ? { ...entry, sandboxCleanupPending: false } : entry,
    );
  });
}

/**
 * Record removals on a session that does not attach the repositories (a
 * descendant that never had them), so an agent there cannot attach them
 * either. Nothing is left to clean up in its sandbox. A repository the
 * session attaches meanwhile (a person attached it again) gets no record.
 */
export async function recordSessionRemovedRepositories(
  db: Database,
  workspaceId: string,
  sessionId: string,
  entries: readonly SessionRemovedRepository[],
): Promise<void> {
  if (entries.length === 0) return;
  await updateSessionRemovedRepositories(db, workspaceId, sessionId, (current, attached) => {
    const missing = entries.filter(
      (entry) =>
        findSessionRemovedRepository(current, entry.resource.uri) === undefined &&
        repositoryMembershipKey(entry.resource.uri) !== null &&
        !resourcesIncludeRepository(attached, entry.resource.uri),
    );
    if (missing.length === 0) return null;
    return [...current, ...missing.map((entry) => ({ ...entry, sandboxCleanupPending: false }))];
  });
}
