import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessGrant } from "@opengeni/contracts";
import {
  getSessionSiteAccess,
  getSession,
  getSessionAuthorityProjection,
  type Database,
} from "@opengeni/db";
import {
  siteOriginsMatch,
  siteSessionOriginFromMetadata,
  type SiteSessionOrigin,
} from "./site-session-origin";

// Request-local proof installed by the console frame guard, never metadata.
const consoleSiteAccess = new AsyncLocalStorage<boolean>();
export function withConsoleSiteSessionAccess<T>(run: () => T): T {
  return consoleSiteAccess.run(true, run);
}
export function isConsoleSiteSessionRequest(): boolean {
  return consoleSiteAccess.getStore() === true;
}

/** This is an additional frame boundary; normal session authorization still applies. */
export async function siteMayAccessSession(
  db: Database,
  grant: AccessGrant,
  sessionId: string,
  origin: SiteSessionOrigin,
  requireAudience = false,
): Promise<boolean> {
  if (origin.siteId && consoleSiteAccess.getStore()) {
    return (
      (await getSessionSiteAccess(db, {
        workspaceId: grant.workspaceId,
        sessionId,
        siteId: origin.siteId,
        subjectId: grant.subjectId,
      })) !== null
    );
  }
  if (requireAudience) {
    const authority = await getSessionAuthorityProjection(db, grant.workspaceId, sessionId);
    if (!authority?.siteAccessRootId) return false;
  }
  const session = await getSession(db, grant.workspaceId, sessionId);
  return siteOriginsMatch(origin, siteSessionOriginFromMetadata(session?.metadata));
}
