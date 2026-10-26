import type { WorkspaceControlEvent } from "@opengeni/contracts";
import {
  hasPermission,
  hasVerifiedOwningUserAuthorization,
  requireSessionAuthorizationListScope,
  SessionAuthorizationDeniedError,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { listVisibleSessionInvalidationHints, SessionListAccessError } from "@opengeni/db";
import type { WorkspaceControlEventVisibility } from "./http/sse";

/**
 * Workspace control events are a workspace feed, but a session-scope event
 * (pause, resume or timer on one chat) names that chat, its actor and reason.
 * A reader receives it only for root chats it can see in its session list;
 * workspace-scope events go to everyone with workspace:read. Visibility is
 * resolved on every call so a chat shared or hidden mid-stream is honored.
 */
export function workspaceControlEventVisibility(
  deps: ApiRouteDeps,
  workspaceId: string,
  authorization: AccessGrantAuthorization,
): WorkspaceControlEventVisibility {
  const grant = authorization.grant;
  return async (events) => {
    const rootSessionIds = [
      ...new Set(
        events.flatMap((event) =>
          event.scope === "session" && event.rootSessionId ? [event.rootSessionId] : [],
        ),
      ),
    ];
    const visible = rootSessionIds.length
      ? await visibleRootSessionIds(rootSessionIds)
      : new Set<string>();
    return events.filter(
      (event: WorkspaceControlEvent) =>
        event.scope !== "session" ||
        (event.rootSessionId !== null && visible.has(event.rootSessionId)),
    );
  };

  async function visibleRootSessionIds(rootSessionIds: string[]): Promise<Set<string>> {
    if (!hasPermission(grant.permissions, "sessions:read", grant.permissionMode)) return new Set();
    try {
      const authorizationScope = await requireSessionAuthorizationListScope(deps, grant, "http");
      const hints = await listVisibleSessionInvalidationHints(
        deps.db,
        workspaceId,
        rootSessionIds,
        {
          subjectId: grant.subjectId,
          ...(authorizationScope ? { authorizationScope } : {}),
          personalWorkspaceOwnerException: hasVerifiedOwningUserAuthorization(authorization),
        },
      );
      return new Set([...hints.sessionIds, ...hints.siteSessionIds]);
    } catch (error) {
      // A reader without session-list authority sees no chat-specific events.
      if (
        error instanceof SessionListAccessError ||
        error instanceof SessionAuthorizationDeniedError
      )
        return new Set();
      throw error;
    }
  }
}
