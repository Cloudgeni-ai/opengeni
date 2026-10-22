import { parseSiteHostname } from "@opengeni/contracts";
import {
  actionOpenSiteAbuseReports,
  findSiteHostname,
  findSitePublicationGlobally,
  isSitePublishingUuid,
  recordAuditEvent,
  restoreSitePublication,
  suspendSitePublication,
  type SitePublicationRecord,
} from "@opengeni/db";
import {
  requireSitesDomain,
  runSitePublishing,
  scheduleSiteEdgeSync,
  sitePublishingEffects,
  sitePublishingError,
  stopSiteViewers,
  type SitePublishingDeps,
} from "./service";

/**
 * Platform moderation: the deployment operator takes a published Site down
 * (or restores one it took down) by hostname or Site id, across workspaces.
 * There is no platform-admin API in Opengeni, so this runs from the operator
 * script (`scripts/operator/site-takedown.ts`) with the migrations
 * credential. Owners and workspace admins cannot lift a platform takedown,
 * and its hostname stays held for the platform even if the Site or its
 * workspace is deleted (`liftSiteHostnameHold` releases it). Viewer sessions
 * are revoked at once; running conversations are refused further work by
 * site-runtime and end on their own usage caps (the script has no
 * in-process session dispatch to cancel them).
 */
export async function moderateSiteAsPlatform(
  deps: SitePublishingDeps,
  input: {
    /** A label, a full hostname, or a Site id. */
    host: string;
    operator: string;
    action: "takedown" | "restore";
    reason?: string | undefined;
  },
): Promise<SitePublicationRecord> {
  const domain = requireSitesDomain(deps.settings);
  const operator = input.operator.trim();
  if (!operator) throw new Error("Name the operator");
  const reason = input.reason?.trim() ?? "";
  if (input.action === "takedown" && reason.length < 6)
    throw new Error("Give a reason of at least six characters");
  const host = input.host.trim().toLowerCase().replace(/\.$/u, "");
  let record: { accountId: string; workspaceId: string; siteId: string } | null = null;
  if (isSitePublishingUuid(host)) {
    const found = await findSitePublicationGlobally(deps.db, host);
    record = found ? { ...found, siteId: host } : null;
  } else {
    // A bare label or the full hostname.
    const label = host.includes(".") ? parseSiteHostname(host, domain) : host;
    const hostname = label ? await findSiteHostname(deps.db, label) : null;
    record = hostname && hostname.releasedAt === null ? hostname : null;
  }
  if (!record)
    throw sitePublishingError(
      404,
      "not_found",
      "site_not_found",
      "No Site has this hostname or id",
    );
  const scope = { accountId: record.accountId, workspaceId: record.workspaceId };
  const subject = `platform:${operator}`.slice(0, 300);
  const publication = await runSitePublishing(() =>
    input.action === "takedown"
      ? suspendSitePublication(deps.db, scope, record.siteId, { by: "platform", reason, subject })
      : restoreSitePublication(deps.db, scope, record.siteId, { by: "platform", subject }),
  );
  if (input.action === "takedown")
    await actionOpenSiteAbuseReports(deps.db, scope, { siteId: record.siteId, actor: subject });
  await recordAuditEvent(deps.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: subject,
    action: input.action === "takedown" ? "site.publication.takedown" : "site.publication.restore",
    targetType: "site",
    targetId: record.siteId,
    metadata: {
      by: "platform",
      label: publication.label,
      ...(input.action === "takedown" ? { reason: reason.slice(0, 2000) } : {}),
    },
  });
  if (input.action === "takedown")
    await stopSiteViewers(deps, scope, record.siteId, {
      reason: "takedown",
      cancelConversations: false,
    });
  scheduleSiteEdgeSync(deps, [publication.label], { siteIdHint: record.siteId, purge: true });
  await sitePublishingEffects(deps.settings).flush();
  return publication;
}
