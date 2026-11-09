import {
  ResourceRefConflictError,
  mergeResourceRefs,
  resourcesIncludeRepository,
  type RepositoryResourceRef,
  type Session,
} from "@opengeni/contracts";
import {
  admitRequestedRepositories,
  appendSessionEventsWithLockedSessionUpdate,
  assertSessionIsNotImported,
  requireSession,
  type Database,
} from "@opengeni/db";
import { publishDurableSessionEvents, type EventBus } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";
import { validateGitHubRepositorySelection } from "./resources";

export const SESSION_RESOURCES_ADDED_EVENT = "session.resources.added" as const;

/** What attaching one repository to a running chat did. */
export type SessionRepositoryAttachResult = {
  /** False when the chat already attached the repository; nothing changed. */
  attached: boolean;
  /** True when a person had removed the repository from the chat earlier. */
  reattached: boolean;
  session: Session;
};

/**
 * Attach one repository to a chat that has already started, on behalf of a
 * person: the caller has already checked that a person asked for or approved
 * exactly this repository. The repository joins the chat's live repository
 * membership, which the Git broker, the GitHub tools and every new Git
 * credential mint read, and the next turn clones it like any attached
 * repository. A turn already running keeps the credentials it started with.
 *
 * A person attaching a repository they removed earlier ends its removal
 * record, as when they attach it from the composer. The GitHub App allowlist
 * is checked again here; attaching a repository the chat already has is a
 * no-op, so a retry is safe.
 */
export async function attachSessionRepositoryResource(
  deps: { db: Database; bus: EventBus },
  input: { workspaceId: string; sessionId: string; resource: RepositoryResourceRef },
): Promise<SessionRepositoryAttachResult> {
  const { workspaceId, sessionId, resource } = input;
  const current = await requireSession(deps.db, workspaceId, sessionId);
  assertSessionIsNotImported(current);
  if (resourcesIncludeRepository(current.resources, resource.uri)) {
    return { attached: false, reattached: false, session: current };
  }
  // Only the new repository: the chat's others were checked when they were
  // attached, and one the App has since lost must not block every attach.
  await validateGitHubRepositorySelection(deps.db, workspaceId, [resource]);
  let attached = false;
  let reattached = false;
  const events = await appendSessionEventsWithLockedSessionUpdate(
    deps.db,
    workspaceId,
    sessionId,
    (session) => {
      // Re-read under the session lock: a concurrent attach wins once.
      if (resourcesIncludeRepository(session.resources, resource.uri)) return { events: [] };
      let resources;
      try {
        resources = mergeResourceRefs(session.resources, [resource], { rejectConflicts: true });
      } catch (error) {
        if (error instanceof ResourceRefConflictError) {
          throw new HTTPException(409, { message: error.message });
        }
        throw error;
      }
      const admission = admitRequestedRepositories({
        removedRepositories: session.removedRepositories ?? [],
        requested: [resource],
        requester: "person",
      });
      attached = true;
      reattached = admission.changed;
      return {
        events: [
          {
            type: SESSION_RESOURCES_ADDED_EVENT,
            payload: { resources: [resource], ...(reattached ? { reattached: true } : {}) },
          },
        ],
        update: {
          resources,
          ...(admission.changed ? { removedRepositories: admission.removedRepositories } : {}),
        },
      };
    },
    { activity: "semantic" },
  );
  if (events.length > 0) {
    await publishDurableSessionEvents(deps.bus, workspaceId, sessionId, events);
  }
  return {
    attached,
    reattached,
    session: attached ? await requireSession(deps.db, workspaceId, sessionId) : current,
  };
}
