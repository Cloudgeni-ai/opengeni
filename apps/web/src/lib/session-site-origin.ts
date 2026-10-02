import type { Session } from "@/types";
import type { SessionListEntry } from "@opengeni/sdk";
export type SessionSiteOrigin = { siteId: string; title: string };
export function sessionSiteOrigin(
  session: Pick<Session, "metadata"> | Pick<SessionListEntry, "siteOrigin">,
): SessionSiteOrigin | null {
  if ("siteOrigin" in session) return session.siteOrigin;
  const origin = session.metadata?._opengeniSiteOrigin as Partial<SessionSiteOrigin> | undefined;
  return origin &&
    typeof origin.siteId === "string" &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(origin.siteId) &&
    typeof origin.title === "string"
    ? (origin as SessionSiteOrigin)
    : null;
}
