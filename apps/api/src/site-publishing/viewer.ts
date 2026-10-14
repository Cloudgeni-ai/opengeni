import type { SiteAccessMode, SiteViewer } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";

/**
 * Who may open a published Site. The API decides this on sign-in and again
 * on every site-runtime call; the gateway's own checks are only a convenience.
 */

export type SiteViewerAccessSettings = Pick<Settings, "sitesPublicEnabled" | "sitesLoginOnly">;

/** Public access needs the deployment switch; without it a public Site is members-only. */
export function effectiveSiteAccess(
  access: SiteAccessMode,
  settings: SiteViewerAccessSettings,
): SiteAccessMode {
  return access === "public" && !settings.sitesPublicEnabled ? "members" : access;
}

/**
 * The kind of a signed-in viewer, or null when the Site does not admit them:
 * workspace members always; invited email addresses (verified) for invited
 * and public Sites; anyone signed in for public Sites.
 */
export function signedInSiteViewerKind(input: {
  access: SiteAccessMode;
  member: boolean;
  email: string | null;
  invitedEmails: readonly string[];
}): "member" | "invited" | "user" | null {
  if (input.member) return "member";
  if (
    input.access !== "members" &&
    input.email !== null &&
    input.invitedEmails.includes(input.email.trim().toLowerCase())
  )
    return "invited";
  return input.access === "public" ? "user" : null;
}

/** Anonymous guests reach only public Sites, and never on a login-only deployment. */
export function siteGuestsAllowed(
  access: SiteAccessMode,
  settings: SiteViewerAccessSettings,
): boolean {
  return effectiveSiteAccess(access, settings) === "public" && !settings.sitesLoginOnly;
}

/** Gateway-minted visitor ids: opaque, URL-safe, bounded. */
export const SITE_VISITOR_ID = /^[A-Za-z0-9_-]{16,128}$/u;

export type SiteRuntimeViewer = {
  kind: SiteViewer["kind"];
  /** `user:<subject>` or `guest:<visitor>`: the Site Data owner and conversation owner. */
  principal: string;
  subjectId: string | null;
  name: string | null;
  email: string | null;
  /** The site-session row when signed in. */
  sessionId: string | null;
};

export function publicSiteViewer(viewer: SiteRuntimeViewer): SiteViewer {
  return {
    kind: viewer.kind,
    id: viewer.principal,
    name: viewer.kind === "guest" ? null : viewer.name,
    email: viewer.kind === "guest" ? null : viewer.email,
    signedIn: viewer.kind !== "guest",
  };
}
