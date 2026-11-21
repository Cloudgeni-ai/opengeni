import { randomUUID } from "node:crypto";
import {
  APP_NOTIFY_MAX_RECIPIENTS,
  APP_NOTIFY_SENDS_PER_WINDOW,
  APP_NOTIFY_WINDOW_SECONDS,
  APP_NOTIFY_WORKSPACE_SENDS_PER_WINDOW,
  AppNotifyRequest,
  type AccessGrant,
  type AppNotifyResponse,
} from "@opengeni/contracts";
import { siteViewerForGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  getMemberNotificationsAllowed,
  getSiteDataSite,
  getWorkspaceGrant,
  insertAppNotification,
  listWorkspaceMembers,
  SiteDataError,
  subjectHasLiveWorkspaceAuthorityInScope,
  withWorkspaceSubjectRls,
  type SiteDataSite,
} from "@opengeni/db";
import { personLabel, resolveMember } from "../mcp/notification-tools";
import {
  isPublishedViewer,
  siteDataRole,
  type SiteDataAuthority,
  type SiteDataSurface,
} from "../site-data/service";

/**
 * Notifications from apps (`site.notify`, docs/site-runtime-api.md). An app
 * page sends a normal Opengeni notification: an inbox notice about the app
 * (not about a chat) with a phone push under each device's rules, linking
 * back into the app. Only signed-in workspace members send them: to
 * themselves always; to another member who can open the app and allows other
 * members to notify them; to everyone who can open the app (and allows it)
 * only as one of the app's managers. Rate limited per sender and app; the
 * same key updates the person's notice in place. The insert's trigger
 * delivers it (migration 1532).
 */

const forbidden = (message: string, code: string) =>
  new SiteDataError("forbidden", message, { reason: code });

type Sender = {
  scope: { accountId: string; workspaceId: string };
  site: SiteDataSite;
  subjectId: string;
};

const MEMBERS_ONLY = "Only signed-in members of this workspace can send notifications from an app.";

/** The person sending, the app, and the app as they see it. */
async function senderOf(
  deps: ApiRouteDeps,
  authority: SiteDataAuthority,
  siteId: string,
  surface: SiteDataSurface,
): Promise<Sender> {
  if (isPublishedViewer(authority)) {
    if (authority.site.id !== siteId)
      throw forbidden("An app can only send its own notifications", "other_app");
    if (
      authority.guest ||
      authority.access !== "member" ||
      !authority.principal.startsWith("user:")
    )
      throw forbidden(MEMBERS_ONLY, "members_only");
    return {
      scope: { accountId: authority.accountId, workspaceId: authority.workspaceId },
      site: authority.site,
      subjectId: authority.principal.slice("user:".length),
    };
  }
  const grant = authority;
  if (surface.frameSiteId != null && surface.frameSiteId !== siteId)
    throw forbidden("An app can only send its own notifications", "other_app");
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const viewer = await siteViewerForGrant(deps.db, grant);
  const site = await getSiteDataSite(deps.db, scope, viewer, siteId);
  if (!site) throw new SiteDataError("not_found", "App not found");
  if (!viewer.subjectId) throw forbidden(MEMBERS_ONLY, "members_only");
  return { scope, site, subjectId: viewer.subjectId };
}

/** The sender's own live workspace grant: null for anyone who isn't a member now. */
async function memberGrant(
  deps: ApiRouteDeps,
  scope: Sender["scope"],
  subjectId: string,
): Promise<AccessGrant | null> {
  return await withWorkspaceSubjectRls(deps.db, scope.workspaceId, subjectId, async (tx) => {
    if (!(await subjectHasLiveWorkspaceAuthorityInScope(tx, { ...scope, subjectId }))) return null;
    return await getWorkspaceGrant(tx, subjectId, scope.workspaceId, {
      principalKind: "human_session",
    });
  });
}

/** Whether a person can open the app: everyone in the workspace for a shared app, else its owner. */
function canOpen(site: SiteDataSite, subjectId: string): boolean {
  return site.visibility === "workspace_shared" || site.ownerSubjectId === subjectId;
}

function appLink(scope: Sender["scope"], siteId: string, path: string | undefined): string {
  const base = `/workspaces/${scope.workspaceId}/sites/${siteId}`;
  return path && path !== "/" ? `${base}?page=${encodeURIComponent(path)}` : base;
}

export async function notifyFromApp(
  deps: ApiRouteDeps,
  authority: SiteDataAuthority,
  siteId: string,
  body: unknown,
  surface: SiteDataSurface = {},
): Promise<AppNotifyResponse> {
  const parsed = AppNotifyRequest.safeParse(body ?? {});
  if (!parsed.success)
    throw new SiteDataError(
      "validation",
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`)
        .join("; "),
    );
  const request = parsed.data;
  const sender = await senderOf(deps, authority, siteId, surface);
  const { scope, site } = sender;
  if (site.status !== "active") throw forbidden("This app is archived", "app_archived");
  const grant = await memberGrant(deps, scope, sender.subjectId);
  if (!grant) throw forbidden(MEMBERS_ONLY, "members_only");

  let audience: "people" | "workspace" = "people";
  let recipients: string[];
  let skipped = 0;
  let overLimit = 0;
  const to = request.to?.trim();
  if (to === "workspace") {
    if (siteDataRole(grant, site, sender.subjectId) !== "manager")
      throw forbidden(
        "Only the app's managers can notify everyone who can open it.",
        "managers_only",
      );
    audience = "workspace";
    recipients = [];
    const members = (await listWorkspaceMembers(deps.db, scope.workspaceId)).filter(
      (member) => member.subjectId !== sender.subjectId && canOpen(site, member.subjectId),
    );
    for (const member of members) {
      if (recipients.length >= APP_NOTIFY_MAX_RECIPIENTS) {
        overLimit += 1;
        continue;
      }
      const allowed = await getMemberNotificationsAllowed(deps.db, {
        workspaceId: scope.workspaceId,
        subjectId: member.subjectId,
      });
      if (allowed) recipients.push(member.subjectId);
      else skipped += 1;
    }
  } else if (!to) {
    recipients = [sender.subjectId];
  } else {
    const member = await resolveMember(deps, scope.workspaceId, to);
    if (!member)
      throw new SiteDataError(
        "validation",
        `${to} is not a member of this workspace (or the name matches more than one member). Use their email.`,
        { code: "not_a_member" },
      );
    if (member.subjectId !== sender.subjectId) {
      if (!canOpen(site, member.subjectId))
        throw forbidden(`${member.label} can't open this app.`, "recipient_cannot_open");
      if (
        !(await getMemberNotificationsAllowed(deps.db, {
          workspaceId: scope.workspaceId,
          subjectId: member.subjectId,
        }))
      )
        throw forbidden(
          `${member.label} doesn't allow other members to notify them in this workspace.`,
          "member_notifications_off",
        );
    }
    recipients = [member.subjectId];
  }

  const key = request.key ?? randomUUID();
  if (recipients.length === 0) return { key, delivered: 0, skipped, overLimit };
  const inserted = await insertAppNotification(
    deps.db,
    scope,
    {
      siteId: site.id,
      senderSubjectId: sender.subjectId,
      senderLabel: await personLabel(deps, scope.workspaceId, sender.subjectId),
      appTitle: site.title.trim().slice(0, 120) || "App",
      audience,
      recipients,
      key,
      title: request.title,
      body: request.body?.trim() ?? "",
      link: appLink(scope, site.id, request.path),
    },
    {
      perSender: APP_NOTIFY_SENDS_PER_WINDOW,
      workspacePerSender: APP_NOTIFY_WORKSPACE_SENDS_PER_WINDOW,
      windowSeconds: APP_NOTIFY_WINDOW_SECONDS,
    },
  );
  if ("unavailable" in inserted)
    throw forbidden(
      "Notifications from apps aren't available on this deployment yet.",
      "notify_not_available",
    );
  if ("limited" in inserted)
    throw new SiteDataError(
      "rate_limited",
      inserted.limited === "workspace"
        ? `An app can notify everyone at most ${APP_NOTIFY_WORKSPACE_SENDS_PER_WINDOW} times in ${APP_NOTIFY_WINDOW_SECONDS / 60} minutes per sender.`
        : `An app can send at most ${APP_NOTIFY_SENDS_PER_WINDOW} notifications in ${APP_NOTIFY_WINDOW_SECONDS / 60} minutes per sender.`,
      { retryable: true },
    );
  return { key, delivered: recipients.length, skipped, overLimit };
}
