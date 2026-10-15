import {
  siteHostname,
  type FirstPartyMcpToolName,
  type SiteLimitProfileKind,
} from "@opengeni/contracts";
import { resolveFirstPartyMcpToolPolicy } from "@opengeni/config";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  consumeSiteRuntimeRate,
  findSiteRuntimeAgentConversation,
  getPublishedSite,
  getSitePublication,
  getSiteSqlDatabase,
  isSiteWorkspaceMember,
  siteRuntimeConversationViewerEmail,
  type SiteRuntimeConversationViewerKind,
} from "@opengeni/db";
import type { PublishedSiteDataViewer } from "../site-data/service";
import { siteSqlOffered } from "../site-sql/gateway";
import { siteRuntimeLimitProfile, type SiteRuntimeHost } from "./runtime";
import { siteServable } from "./service";
import { effectiveSiteAccess, signedInSiteViewerKind, siteGuestsAllowed } from "./viewer";

/**
 * A published Site's own data tools for its agent. Every Site agent
 * conversation (members, invited people and public visitors) gets them,
 * pinned on the server to that Site and acting as the conversation's viewer:
 * the same audience checks and row binding as the Site's page (per-viewer
 * collections, owner binding, `:viewer` and query audiences such as
 * `signed_in` or `managers`). Site management tools (publication, migrate,
 * define, reset, import, export, enable, files and so on) are never given.
 *
 * - `site_data_query`, `site_data_write`: the Site's collections under the
 *   viewer's access rules (guests only what each collection's guest rule allows).
 * - `site_sql_run`: the Site's named queries, when Site SQL is on.
 * - `site_sql_query`: read-only statements, for workspace members only, when
 *   Site SQL is on.
 */
export const SITE_AGENT_DATA_TOOLS = Object.freeze([
  "site_data_query",
  "site_data_write",
] as const satisfies readonly FirstPartyMcpToolName[]);
export const SITE_AGENT_SQL_TOOLS = Object.freeze([
  "site_sql_run",
] as const satisfies readonly FirstPartyMcpToolName[]);
export const SITE_AGENT_MEMBER_SQL_TOOLS = Object.freeze([
  "site_sql_query",
] as const satisfies readonly FirstPartyMcpToolName[]);

/** The first-party permissions those tools need (Site Data writes need publish). */
export const SITE_AGENT_DATA_TOOL_PERMISSIONS = Object.freeze([
  "artifacts:read",
  "artifacts:publish",
] as const);

export const SITE_AGENT_OTHER_SITE_MESSAGE = "This Site's assistant can only use this Site's data";
export const SITE_AGENT_MANAGEMENT_MESSAGE =
  "This Site's assistant can use the Site's data, not manage the Site";

/** The data tools one viewer's Site agent conversation gets, within the deployment's tools. */
export function siteAgentDataToolNames(input: {
  viewerKind: SiteRuntimeConversationViewerKind;
  /** Site SQL is offered here and turned on for this Site. */
  siteSql: boolean;
  /** The deployment's first-party tool allowlist. */
  allowed: readonly string[];
}): FirstPartyMcpToolName[] {
  const names: FirstPartyMcpToolName[] = [
    ...SITE_AGENT_DATA_TOOLS,
    ...(input.siteSql ? SITE_AGENT_SQL_TOOLS : []),
    ...(input.siteSql && input.viewerKind === "member" ? SITE_AGENT_MEMBER_SQL_TOOLS : []),
  ];
  return names.filter((name) => input.allowed.includes(name));
}

/** Whether Site SQL is offered on this deployment and turned on for the Site. */
export async function siteAgentSiteSqlOn(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  scope: { accountId: string; workspaceId: string },
  siteId: string,
): Promise<boolean> {
  if (!siteSqlOffered(deps.settings)) return false;
  const database = await getSiteSqlDatabase(deps.db, { ...scope, siteId }).catch(() => null);
  return database?.enabled === true;
}

/** The data tools for a new conversation of this viewer on this Site. */
export async function siteAgentDataToolsForStart(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  scope: { accountId: string; workspaceId: string },
  siteId: string,
  viewerKind: SiteRuntimeConversationViewerKind,
): Promise<FirstPartyMcpToolName[]> {
  return siteAgentDataToolNames({
    viewerKind,
    siteSql: await siteAgentSiteSqlOn(deps, scope, siteId),
    allowed: resolveFirstPartyMcpToolPolicy(deps.settings).allowed,
  });
}

/** This Site's viewer (`user:<subject>` or `guest:<visitor>`) as Site Data and Site SQL see it. */
export function sitePublishedDataViewer(
  host: Pick<SiteRuntimeHost, "scope" | "site">,
  principal: string,
  guest: boolean,
): PublishedSiteDataViewer {
  return {
    kind: "published_viewer",
    accountId: host.scope.accountId,
    workspaceId: host.scope.workspaceId,
    site: {
      id: host.site.id,
      title: host.site.title,
      status: host.site.status,
      visibility: host.site.visibility,
      ownerSubjectId: host.site.ownerSubjectId,
      createdBySubjectId: host.site.createdBySubjectId,
    },
    principal,
    guest,
  };
}

const VIEWER_WORDS: Record<SiteRuntimeConversationViewerKind, string> = {
  member: "a member of the workspace that owns this Site",
  invited: "a person invited to this Site from outside the workspace",
  user: "a signed-in visitor from outside the workspace",
  guest: "an anonymous visitor",
};

/**
 * The Site agent's instructions: which Site and viewer it serves and what its
 * data tools may do, then the owner's own instructions for the Site.
 */
export function siteAgentInstructions(
  host: Pick<SiteRuntimeHost, "site">,
  viewer: { kind: SiteRuntimeConversationViewerKind },
  dataTools: readonly string[],
  ownerInstructions: string | null | undefined,
): string {
  const lines = [
    `You are the assistant on the published Site "${host.site.title}" (Site id ${host.site.id}). You are talking with ${VIEWER_WORDS[viewer.kind]}.`,
    dataTools.length > 0
      ? `Your tools (${dataTools.join(", ")}) work only on this Site: always pass siteId ${host.site.id}. They act as this person, so they see and change only what this person may on the page. When a tool refuses (for example sign_in_required or not_available_for_viewer), tell the person plainly what can't be done here and why.`
      : "You have no tools: answer from the conversation.",
    viewer.kind === "member"
      ? "As a workspace member, this person may also have workspace tools the Site gives its assistant."
      : "This person is outside the workspace: you can only use this Site's own data for them, never workspace tools or files. If they ask for something else, say plainly that you can't do it here.",
    "You cannot change the Site, its settings, or how its data is defined, and you have no shell or workspace files.",
  ];
  const own = ownerInstructions?.trim();
  return own ? `${lines.join("\n")}\n\n${own}` : lines.join("\n");
}

/** A Site agent conversation's data context: the pinned Site and the viewer it acts as. */
export type SiteAgentDataContext = {
  kind: "site";
  siteId: string;
  viewerKind: SiteRuntimeConversationViewerKind;
  viewer: PublishedSiteDataViewer;
  /** The limit profile kind in force (Site SQL limits follow it). */
  profileKind: SiteLimitProfileKind;
  /**
   * Count one write against the guest write limit (anonymous guests only);
   * null when allowed, else the seconds to wait.
   */
  guestWrite: () => Promise<number | null>;
};

export type SiteAgentDataResolution =
  | { kind: "ordinary" }
  | { kind: "refused"; message: string }
  | SiteAgentDataContext;

/**
 * Whether an agent session is a published Site's agent and, if so, the Site
 * and viewer its data tools act for. Ordinary sessions resolve `ordinary`.
 * A Site agent whose conversation, Site or publication cannot be confirmed,
 * or whose member viewer has left the workspace, is refused (fail closed).
 */
export async function resolveSiteAgentDataContext(
  deps: Pick<ApiRouteDeps, "db" | "settings" | "objectStorage">,
  scope: { accountId: string; workspaceId: string },
  sessionId: string,
): Promise<SiteAgentDataResolution> {
  const found = await findSiteRuntimeAgentConversation(deps.db, scope, sessionId);
  if (!found.siteAgent) return { kind: "ordinary" };
  const refused = (message: string): SiteAgentDataResolution => ({ kind: "refused", message });
  const conversation = found.conversation;
  if (!conversation) return refused("This Site's assistant could not confirm its conversation");
  const [publication, site] = await Promise.all([
    getSitePublication(deps.db, scope, conversation.siteId),
    getPublishedSite(deps.db, scope, conversation.siteId),
  ]);
  if (!publication || !site || publication.status !== "active" || !siteServable(site))
    return refused("This Site is not available");
  const subjectId = conversation.viewerPrincipal.startsWith("user:")
    ? conversation.viewerPrincipal.slice("user:".length)
    : null;
  if (
    conversation.viewerKind === "member" &&
    (!subjectId || !(await isSiteWorkspaceMember(deps.db, scope, subjectId)))
  )
    return refused("This conversation's viewer is no longer a workspace member");
  // Cancellation is only a convenience. Recheck the current audience for every
  // tool call, using the verified identity retained on the server at start.
  if (conversation.viewerKind === "guest") {
    if (!siteGuestsAllowed(publication.access, deps.settings))
      return refused("This conversation's viewer no longer has access to this Site");
  } else if (conversation.viewerKind !== "member") {
    const kind =
      subjectId &&
      signedInSiteViewerKind({
        access: effectiveSiteAccess(publication.access, deps.settings),
        member: false,
        email: await siteRuntimeConversationViewerEmail(deps.db, scope, conversation.sessionId),
        invitedEmails: publication.invitedEmails,
      });
    if (!kind) return refused("This conversation's viewer no longer has access to this Site");
  }
  const domain = deps.settings.sitesDomain ?? "";
  const host: SiteRuntimeHost = {
    domain,
    label: publication.label,
    hostname: domain ? siteHostname(publication.label, domain) : publication.label,
    scope,
    publication,
    site,
  };
  const guest = conversation.viewerKind === "guest";
  const profile = await siteRuntimeLimitProfile(deps, host, { kind: conversation.viewerKind });
  return {
    kind: "site",
    siteId: conversation.siteId,
    viewerKind: conversation.viewerKind,
    viewer: sitePublishedDataViewer(host, conversation.viewerPrincipal, guest),
    profileKind: profile.kind,
    guestWrite: async () => {
      const limit = profile.limits.guestWritesPerMinute;
      if (!guest || limit === null) return null;
      const rate = await consumeSiteRuntimeRate(deps.db, scope, {
        siteId: conversation.siteId,
        principal: conversation.viewerPrincipal,
        bucket: "guest_writes",
        limit,
      });
      return rate.allowed ? null : Math.max(1, rate.retryAfterSeconds);
    },
  };
}
