import type { AccessContext } from "@opengeni/sdk";

import { workspaceSessionPath } from "./routes";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionDeepLinkLocation = Pick<Location, "pathname" | "search" | "hash">;
export type SessionReadGrant = Pick<
  AccessContext["workspaceGrants"][number],
  "workspaceId" | "permissions"
>;

export type SessionDeepLinkResolution =
  | { status: "resolved"; workspaceId: string }
  | { status: "not-found" }
  | { status: "error"; error: unknown };

// Keep the resolver's dependency structural so it can reuse the SDK client
// without adding a second API surface or coupling this helper to the client
// implementation in tests.
export type AuthorizedSessionReader = {
  getSession: (workspaceId: string, sessionId: string) => Promise<unknown>;
};

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function sessionReadWorkspaceIds(grants: readonly SessionReadGrant[]): string[] {
  return [
    ...new Set(
      grants
        .filter(
          (grant) =>
            grant.permissions.includes("sessions:read") ||
            grant.permissions.includes("workspace:admin"),
        )
        .map((grant) => grant.workspaceId),
    ),
  ];
}

/**
 * Resolve only through workspace-scoped session reads that the caller already
 * has permission to make. A 401/403/404 is intentionally indistinguishable
 * from a miss so foreign, inaccessible, and nonexistent sessions do not gain
 * a discovery oracle. Other failures remain a generic unavailable state for
 * the route to render safely.
 */
export async function resolveAuthorizedSessionWorkspace(
  client: AuthorizedSessionReader,
  grants: readonly SessionReadGrant[],
  sessionId: string,
): Promise<SessionDeepLinkResolution> {
  if (!isSessionId(sessionId)) {
    return { status: "not-found" };
  }

  let unavailableError: unknown = null;
  for (const workspaceId of sessionReadWorkspaceIds(grants)) {
    try {
      await client.getSession(workspaceId, sessionId);
      return { status: "resolved", workspaceId };
    } catch (error) {
      if (isAuthorizationOrNotFound(error)) {
        continue;
      }
      unavailableError ??= error;
    }
  }

  return unavailableError ? { status: "error", error: unavailableError } : { status: "not-found" };
}

export function sessionDeepLinkReturnPath(location: SessionDeepLinkLocation): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function canonicalSessionDeepLinkTarget(
  workspaceId: string,
  sessionId: string,
  location: SessionDeepLinkLocation,
): string {
  return `${workspaceSessionPath(workspaceId, sessionId)}${location.search}${location.hash}`;
}

export function shouldRedirectSessionDeepLink(
  pathname: string,
  canonicalPathname: string,
): boolean {
  return pathname !== canonicalPathname;
}

function isAuthorizationOrNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403 || status === 404;
}
