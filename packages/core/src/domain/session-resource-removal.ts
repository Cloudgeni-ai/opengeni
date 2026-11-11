import { randomUUID } from "node:crypto";
import {
  RemoveSessionResourcesRequest,
  boundSessionRemovedRepositories,
  findSessionRemovedRepository,
  repositoryMembershipKey,
  resourcesIncludeRepository,
  type AccessGrant,
  type ResourceRef,
  type Session,
  type SessionAuthorizationPort,
  type SessionRemovedRepository,
} from "@opengeni/contracts";
import {
  appendSessionEventsWithLockedSessionUpdate,
  assertSessionIsNotImported,
  listSessionDescendantIdsForResourceRemoval,
  recordSessionRemovedRepositories,
  requireSession,
  type Database,
} from "@opengeni/db";
import { publishDurableSessionEvents, type EventBus } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";
import { requirePermission } from "../access";
import {
  grantHasAgentAttemptAuthority,
  requireSessionAuthorization,
} from "../session-authorization";

export const SESSION_RESOURCES_REMOVED_EVENT = "session.resources.removed" as const;

type RepositoryResource = Extract<ResourceRef, { kind: "repository" }>;

/** Most passes over a session tree one removal makes; see the cascade below. */
const SESSION_RESOURCE_REMOVAL_MAX_PASSES = 8;

/**
 * Remove repositories from a session and every descendant session. Session
 * resources are the live repository authority: the personal Git broker, the
 * GitHub REST tools and GitHub App token minting re-read them on every call,
 * so a turn already running (or a child or goal continuation holding an
 * older snapshot) loses the repository on its next call through them. Each
 * session keeps a removal record until a person attaches the repository
 * again: an agent cannot re-attach it, queued turns leave it out, and child
 * sessions created later inherit the record. The next managed-sandbox turn
 * removes the repository folder and credential binding.
 *
 * Only a person or an API caller removes repositories; an agent attempt
 * cannot. Removing a repository that is no longer attached is a no-op, so a
 * retry after a partial cascade completes it.
 */
export async function removeSessionResources(
  deps: {
    db: Database;
    bus: EventBus;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  grant: AccessGrant,
  sessionId: string,
  request: RemoveSessionResourcesRequest,
): Promise<Session> {
  await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation: "session.resources.write",
    surface: "core",
  });
  requirePermission(grant, "sessions:control");
  if (grantHasAgentAttemptAuthority(grant)) {
    throw new HTTPException(403, {
      message: "Only a person can remove repositories from a chat.",
    });
  }
  const parsed = RemoveSessionResourcesRequest.safeParse(request);
  if (!parsed.success) {
    throw new HTTPException(422, { message: "invalid repository removal request" });
  }
  const keys = new Set<string>();
  for (const resource of parsed.data.resources) {
    const key = repositoryMembershipKey(resource.uri);
    if (!key) {
      throw new HTTPException(422, { message: `invalid repository URI: ${resource.uri}` });
    }
    keys.add(key);
  }
  const session = await requireSession(deps.db, grant.workspaceId, sessionId);
  assertSessionIsNotImported(session);

  // The full repository references, for descendants that never held them.
  const known = new Map<string, RepositoryResource>();
  const remember = (resources: readonly RepositoryResource[]) => {
    for (const resource of resources) {
      const key = repositoryMembershipKey(resource.uri);
      if (key && keys.has(key) && !known.has(key)) known.set(key, resource);
    }
  };
  remember(await removeRepositoriesFromSession(deps, grant.workspaceId, sessionId, keys, null));
  remember((session.removedRepositories ?? []).map((entry) => entry.resource));

  // Children inherit their parent's repositories when they are created and
  // keep their own copy, so the removal narrows each descendant as well. A
  // child created while the cascade runs inherits the record from a parent
  // already narrowed, or appears in the next pass.
  // Bounded: a child created after its parent was narrowed inherits the
  // record, so only children created during the previous pass need another.
  const visited = new Set<string>();
  for (let pass = 0; pass < SESSION_RESOURCE_REMOVAL_MAX_PASSES; pass += 1) {
    const pending = (
      await listSessionDescendantIdsForResourceRemoval(deps.db, grant.workspaceId, sessionId)
    ).filter((id) => !visited.has(id));
    if (pending.length === 0) break;
    for (const descendantId of pending) {
      visited.add(descendantId);
      remember(
        await removeRepositoriesFromSession(deps, grant.workspaceId, descendantId, keys, sessionId),
      );
      await recordSessionRemovedRepositories(
        deps.db,
        grant.workspaceId,
        descendantId,
        [...known.values()].map((resource) => removalRecord(resource, false)),
      );
    }
  }
  return await requireSession(deps.db, grant.workspaceId, sessionId);
}

function removalRecord(
  resource: RepositoryResource,
  sandboxCleanupPending: boolean,
): SessionRemovedRepository {
  return {
    id: randomUUID(),
    resource,
    removedAt: new Date().toISOString(),
    sandboxCleanupPending,
  };
}

/** Removes the matching attached repositories and returns them. */
async function removeRepositoriesFromSession(
  deps: { db: Database; bus: EventBus },
  workspaceId: string,
  sessionId: string,
  keys: ReadonlySet<string>,
  removedFromSessionId: string | null,
): Promise<RepositoryResource[]> {
  let removed: RepositoryResource[] = [];
  const events = await appendSessionEventsWithLockedSessionUpdate(
    deps.db,
    workspaceId,
    sessionId,
    (session) => {
      removed = session.resources.filter(
        (resource): resource is RepositoryResource =>
          resource.kind === "repository" && keys.has(repositoryMembershipKey(resource.uri) ?? ""),
      );
      if (removed.length === 0) return { events: [] };
      const removedSet = new Set<ResourceRef>(removed);
      const records = (session.removedRepositories ?? []).filter(
        (entry) => !resourcesIncludeRepository(removed, entry.resource.uri),
      );
      return {
        events: [
          {
            type: SESSION_RESOURCES_REMOVED_EVENT,
            payload: {
              resources: removed,
              ...(removedFromSessionId ? { removedFromSessionId } : {}),
            },
          },
        ],
        update: {
          resources: session.resources.filter((resource) => !removedSet.has(resource)),
          // The next managed-sandbox turn removes the folders and bindings.
          removedRepositories: boundSessionRemovedRepositories([
            ...records,
            ...removed.map((resource) => removalRecord(resource, true)),
          ]),
        },
      };
    },
    { activity: "semantic" },
  );
  if (events.length > 0) {
    await publishDurableSessionEvents(deps.bus, workspaceId, sessionId, events);
  }
  return removed;
}

/**
 * Removal records whose sandbox cleanup has not run yet. A turn removes these
 * repositories' folders and credential bindings before the agent runs.
 * Read from the session row, so it costs a turn nothing.
 */
export function pendingSessionRepositoryCleanup(
  session: Pick<Session, "removedRepositories" | "resources">,
): SessionRemovedRepository[] {
  return (session.removedRepositories ?? []).filter(
    (entry) =>
      entry.sandboxCleanupPending &&
      !resourcesIncludeRepository(session.resources, entry.resource.uri),
  );
}

/**
 * `resources` without the repositories a person removed from the session: a
 * turn's own resource snapshot (accepted before the removal) never restores
 * them. A repository the session currently attaches is kept, so a record
 * that outlived a re-attach never hides a repository the Git broker and the
 * GitHub tools would allow.
 */
export function withoutRemovedRepositories<T extends ResourceRef>(
  resources: readonly T[],
  session: Pick<Session, "removedRepositories" | "resources">,
): T[] {
  const removed = session.removedRepositories ?? [];
  if (removed.length === 0) return [...resources];
  return resources.filter(
    (resource) =>
      resource.kind !== "repository" ||
      findSessionRemovedRepository(removed, resource.uri) === undefined ||
      resourcesIncludeRepository(session.resources, resource.uri),
  );
}
