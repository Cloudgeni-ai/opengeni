import { randomUUID } from "node:crypto";
import {
  ResourceRef,
  boundSessionRemovedRepositories,
  findSessionRemovedRepository,
  parseSessionRemovedRepositories,
  repositoryMembershipKey,
  resourcesIncludeRepository,
  type SessionRemovedRepository,
} from "@opengeni/contracts";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { isTransactionHandle, withWorkspaceRls, type Database } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
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

/** A session's live repository membership: what it attaches and what a person removed. */
export type SessionRepositoryMembership = {
  resources: ResourceRef[];
  removedRepositories: SessionRemovedRepository[];
};

/**
 * The session's current resources and removal records, read live for an
 * authority check, or null when the session is not visible in the workspace.
 * All my repositories does not limit a chat to its attached repositories,
 * but a repository a person removed from the chat (or from a parent chat,
 * which records the removal on its descendants) stays refused there.
 */
export async function getSessionRepositoryMembershipForAuthority(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionRepositoryMembership | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        resources: schema.sessions.resources,
        removedRepositories: schema.sessions.removedRepositories,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) return null;
    const resources = ResourceRef.array().safeParse(row.resources);
    return {
      resources: resources.success ? resources.data : [],
      removedRepositories: parseSessionRemovedRepositories(row.removedRepositories),
    };
  });
}

/** The GitHub repository id a github.com repository resource carries, if any. */
function githubRepositoryIdOf(resource: ResourceRef): string | null {
  if (resource.kind !== "repository") return null;
  if (!repositoryMembershipKey(resource.uri)?.startsWith("https://github.com/")) return null;
  const id = resource.repositoryId ?? resource.githubRepositoryId;
  return id === undefined ? null : String(id);
}

/**
 * Whether a person removed the repository (at any of `uris`, or with this
 * GitHub repository id, so a rename or transfer does not undo the removal)
 * from the session and it is not attached again. A removal record that
 * outlived a re-attach never refuses a repository the session attaches.
 */
export function sessionRepositoryRemoved(
  membership: SessionRepositoryMembership,
  repository: { uris: readonly string[]; githubRepositoryId?: string | undefined },
): boolean {
  const id = repository.githubRepositoryId;
  const matches = (resource: ResourceRef) =>
    (resource.kind === "repository" &&
      repository.uris.some(
        (uri) =>
          repositoryMembershipKey(uri) !== null &&
          repositoryMembershipKey(uri) === repositoryMembershipKey(resource.uri),
      )) ||
    (id !== undefined && githubRepositoryIdOf(resource) === id);
  return (
    membership.removedRepositories.some((entry) => matches(entry.resource)) &&
    !membership.resources.some(matches)
  );
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
  await updateSessionRemovedRepositories(db, workspaceId, sessionId, (current, attached) =>
    withMissingRemovalRecords(current, attached, entries),
  );
}

/** `current` plus the records of `entries` it lacks and doesn't attach; null when none. */
function withMissingRemovalRecords(
  current: SessionRemovedRepository[],
  attached: readonly ResourceRef[],
  entries: readonly SessionRemovedRepository[],
): SessionRemovedRepository[] | null {
  const missing = entries.filter(
    (entry) =>
      findSessionRemovedRepository(current, entry.resource.uri) === undefined &&
      repositoryMembershipKey(entry.resource.uri) !== null &&
      !resourcesIncludeRepository(attached, entry.resource.uri),
  );
  if (missing.length === 0) return null;
  return [...current, ...missing.map((entry) => ({ ...entry, sandboxCleanupPending: false }))];
}

/** Sessions one removal batch reads or locks at a time. */
const REMOVAL_BATCH_SIZE = 200;

function attachedRepositories(value: unknown): ResourceRef[] {
  const parsed = ResourceRef.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * Of these sessions, those that attach any of the repositories (by
 * `repositoryMembershipKey`), read in a few queries rather than one per
 * session: a chat can have a thousand descendants, and only those holding the
 * repository need their own locked removal.
 */
export async function listSessionIdsAttachingRepositories(
  db: Database,
  workspaceId: string,
  sessionIds: readonly string[],
  keys: ReadonlySet<string>,
): Promise<string[]> {
  const holding: string[] = [];
  for (let start = 0; start < sessionIds.length; start += REMOVAL_BATCH_SIZE) {
    const chunk = sessionIds.slice(start, start + REMOVAL_BATCH_SIZE);
    const rows = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
      scopedDb
        .select({ id: schema.sessions.id, resources: schema.sessions.resources })
        .from(schema.sessions)
        .where(
          and(eq(schema.sessions.workspaceId, workspaceId), inArray(schema.sessions.id, chunk)),
        ),
    );
    for (const row of rows) {
      if (
        attachedRepositories(row.resources).some(
          (resource) =>
            resource.kind === "repository" && keys.has(repositoryMembershipKey(resource.uri) ?? ""),
        )
      ) {
        holding.push(row.id);
      }
    }
  }
  return holding;
}

/**
 * `recordSessionRemovedRepositories` for many sessions, a batch of rows per
 * transaction (locked in id order, retried on a deadlock or lock timeout, then
 * one session at a time). Sessions that already have the record are left as
 * they are. Returns the sessions that attach one of the repositories by now
 * and so got no record: during a cascade the caller removes it from them too,
 * even when a person attached it again while the cascade ran.
 */
export async function recordSessionRemovedRepositoriesForSessions(
  db: Database,
  workspaceId: string,
  sessionIds: readonly string[],
  entries: readonly SessionRemovedRepository[],
): Promise<string[]> {
  if (entries.length === 0) return [];
  const attaching: string[] = [];
  for (let start = 0; start < sessionIds.length; start += REMOVAL_BATCH_SIZE) {
    const chunk = sessionIds.slice(start, start + REMOVAL_BATCH_SIZE);
    try {
      attaching.push(...(await recordRemovalBatchWithRetry(db, workspaceId, chunk, entries)));
    } catch (error) {
      // A batch that keeps colliding with other writers (deadlock, lock wait)
      // falls back to one session per transaction, like the per-session path,
      // so the cascade still finishes.
      if (chunk.length === 1 || !retryableRemovalBatchError(error)) throw error;
      for (const id of chunk) {
        attaching.push(...(await recordRemovalBatchWithRetry(db, workspaceId, [id], entries)));
      }
    }
  }
  return attaching;
}

// Deadlock, serialization failure, and this batch's own lock_timeout.
const RETRYABLE_REMOVAL_SQLSTATES = new Set(["40P01", "40001", "55P03"]);
const REMOVAL_BATCH_ATTEMPTS = 3;

function retryableRemovalBatchError(error: unknown): boolean {
  return RETRYABLE_REMOVAL_SQLSTATES.has(nestedPostgresSqlState(error) ?? "");
}

async function recordRemovalBatchWithRetry(
  db: Database,
  workspaceId: string,
  chunk: readonly string[],
  entries: readonly SessionRemovedRepository[],
): Promise<string[]> {
  // Inside a caller's transaction a failed statement aborts it, so a retry
  // here could only repeat the abort; the caller's own retry handles it.
  const attempts = isTransactionHandle(db) ? 1 : REMOVAL_BATCH_ATTEMPTS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await recordRemovalBatch(db, workspaceId, chunk, entries);
    } catch (error) {
      if (attempt >= attempts || !retryableRemovalBatchError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
    }
  }
}

async function recordRemovalBatch(
  db: Database,
  workspaceId: string,
  chunk: readonly string[],
  entries: readonly SessionRemovedRepository[],
): Promise<string[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const attaching: string[] = [];
    // Don't wait behind a long turn holding one of these rows: give up and
    // retry (or fall back to one session at a time) instead.
    await scopedDb.execute(sql`set local lock_timeout = '5s'`);
    const rows = await scopedDb
      .select({
        id: schema.sessions.id,
        removedRepositories: schema.sessions.removedRepositories,
        resources: schema.sessions.resources,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), inArray(schema.sessions.id, chunk)))
      .orderBy(asc(schema.sessions.id))
      .for("update");
    const changed: Array<{ id: string; records: SessionRemovedRepository[] }> = [];
    for (const row of rows) {
      const attached = attachedRepositories(row.resources);
      if (entries.some((entry) => resourcesIncludeRepository(attached, entry.resource.uri))) {
        attaching.push(row.id);
      }
      const next = withMissingRemovalRecords(
        parseSessionRemovedRepositories(row.removedRepositories),
        attached,
        // Each session's record gets its own id, as one recorded alone would.
        entries.map((entry) => ({ ...entry, id: randomUUID() })),
      );
      if (next !== null)
        changed.push({ id: row.id, records: boundSessionRemovedRepositories(next) });
    }
    if (changed.length === 0) return attaching;
    // One statement for the batch: the rows stay locked until it commits.
    const values = sql.join(
      changed.map(({ id, records }) => sql`(${id}::uuid, ${JSON.stringify(records)}::jsonb)`),
      sql`, `,
    );
    await scopedDb.execute(sql`
        update ${schema.sessions}
        set removed_repositories = changed.records
        from (values ${values}) as changed(id, records)
        where ${schema.sessions.workspaceId} = ${workspaceId}
          and ${schema.sessions.id} = changed.id
      `);
    return attaching;
  });
}
