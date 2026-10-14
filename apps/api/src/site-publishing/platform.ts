import { parseSiteHostname } from "@opengeni/contracts";
import {
  actionOpenSiteAbuseReports,
  findSiteHostname,
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
  type SitePublishingDeps,
} from "./service";

/**
 * Platform moderation: the deployment operator takes a published Site down
 * (or restores one it took down) by hostname, across workspaces. There is no
 * platform-admin API in OpenGeni, so this runs from the operator script
 * (`scripts/operator/site-takedown.ts`) with the migrations credential. Owners
 * and workspace admins cannot lift a platform takedown.
 */
export async function moderateSiteAsPlatform(
  deps: SitePublishingDeps,
  input: {
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
  const host = input.host.trim().toLowerCase();
  // A bare label or the full hostname.
  const label = host.includes(".") ? parseSiteHostname(host, domain) : host;
  const record = label ? await findSiteHostname(deps.db, label) : null;
  if (!record || record.releasedAt !== null)
    throw sitePublishingError(404, "not_found", "site_not_found", "No Site has this hostname");
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
  scheduleSiteEdgeSync(deps, scope, record.siteId, { purge: true });
  await sitePublishingEffects(deps.settings).flush();
  return publication;
}
