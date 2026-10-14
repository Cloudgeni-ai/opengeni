import { createHash, randomBytes } from "node:crypto";
import {
  parseSiteHostname,
  SiteAuthAuthorizeRequest,
  SiteLimitProfile,
  siteHostname,
  SiteTakedownRequest,
  SITE_GATEWAY_CALLBACK_PATH,
  UpsertSitePublicationRequest,
  type SiteAbuseReport,
  type SiteAuthAuthorizeResponse,
} from "@opengeni/contracts";
import {
  getManagedSession,
  hasLiteralPermission,
  requireAccessContext,
  requireAccessGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  actionOpenSiteAbuseReports,
  consumeSiteRuntimeRate,
  createSiteAuthCode,
  findSiteHostname,
  getPublishedSite,
  getSitePublication,
  getWorkspaceSiteLimitProfile,
  isSiteWorkspaceMember,
  listSiteAbuseReports,
  putWorkspaceSiteLimitProfile,
  recordAuditEvent,
  restoreSitePublication,
  suspendSitePublication,
  updateSiteAbuseReportStatus,
  upsertSitePublication,
  type SiteAbuseReportRecord,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { isAgentActingAsPerson } from "../http/acting-person";
import {
  effectiveSiteLimits,
  siteLimitOverrides,
  sourceSiteLimitProfile,
} from "../site-publishing/limits";
import {
  requireSiteManager,
  requireSitesDomain,
  resolveSiteManagement,
  runSitePublishing,
  scheduleSiteEdgeSync,
  siteHostnameAvailability,
  sitePublicationView,
  sitePublishingError,
  siteServable,
  upsertSitePublicationForManager,
} from "../site-publishing/service";
import { effectiveSiteAccess, signedInSiteViewerKind } from "../site-publishing/viewer";
import { requireSameOriginBrowserMutation } from "./subscription-pool-access";

/** A one-time sign-in code lives this long. */
export const SITE_AUTH_CODE_TTL_SECONDS = 60;
/** Sign-in codes a person may mint per minute (per Site). */
const SIGN_IN_PER_MINUTE = 30;

const SiteIdParam = z.string().uuid();
const ReportIdParam = z.string().uuid();
const ReportStatusRequest = z.object({ status: z.enum(["open", "dismissed", "actioned"]) });

function invalid(message: string) {
  return sitePublishingError(400, "validation_failed", "site_invalid_request", message);
}

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success)
    throw invalid(
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
        .join("; "),
    );
  return parsed.data;
}

function siteIdParam(context: Context): string {
  const parsed = SiteIdParam.safeParse(context.req.param("artifactId"));
  if (!parsed.success)
    throw sitePublishingError(404, "not_found", "site_not_found", "Site not found");
  return parsed.data;
}

function reportView(report: SiteAbuseReportRecord): SiteAbuseReport {
  return {
    id: report.id,
    siteId: report.siteId,
    hostname: report.hostname,
    category: report.category as SiteAbuseReport["category"],
    message: report.message,
    contactEmail: report.contactEmail,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
  };
}

/** Machine and key principals never sign in to a Site; only people do. */
const NON_PERSON_SUBJECT = /^(site|agent|service|configured|schedule|guest):/u;

/**
 * The person asking to sign in to a Site: the signed-in console user (a
 * managed browser session, same-origin), or on deployments without managed
 * sign-in a human context (an external user acting through the host). API
 * keys, agents and service principals are refused. Only a verified email
 * counts for invitations.
 */
async function siteAuthPerson(
  context: Context,
  deps: ApiRouteDeps,
): Promise<{ subjectId: string; email: string | null; name: string | null }> {
  if (
    deps.settings.productAccessMode === "managed" &&
    deps.managedAuth &&
    context.req.header("cookie") &&
    !context.req.header("authorization")
  ) {
    requireSameOriginBrowserMutation(context, deps);
    const session = await getManagedSession(context, deps.managedAuth, {
      db: deps.db,
      sessionAdapter: deps.managedAuthSessionAdapter,
      sessionSetMode: deps.settings.managedAuthSessionSetMode,
    });
    if (!session?.user?.id)
      throw sitePublishingError(401, "unauthenticated", "site_sign_in_required", "Sign in first");
    const user = session.user as {
      id: string;
      email?: string;
      emailVerified?: boolean;
      name?: string;
    };
    return {
      subjectId: `user:${user.id}`,
      email: user.emailVerified === true && user.email ? user.email.toLowerCase() : null,
      name: user.name?.trim() || null,
    };
  }
  const access = await requireAccessContext(context, deps);
  if (
    access.credential !== undefined ||
    isAgentActingAsPerson(context) ||
    NON_PERSON_SUBJECT.test(access.subjectId) ||
    access.workspaceGrants.some(
      (grant) => grant.principalKind !== undefined && grant.principalKind !== "human_session",
    )
  )
    throw sitePublishingError(
      403,
      "forbidden",
      "site_person_required",
      "Only a signed-in person can sign in to a Site",
    );
  return { subjectId: access.subjectId, email: null, name: access.subjectLabel?.trim() || null };
}

export function registerSitePublishingRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/published-artifacts/:artifactId/publication";
  const grantFor = (context: Context, permission: "artifacts:read" | "artifacts:publish") =>
    requireAccessGrant(context, deps, context.req.param("workspaceId")!, permission);

  app.get(base, async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await grantFor(context, "artifacts:read");
    const management = await resolveSiteManagement(deps, grant, siteIdParam(context));
    requireSiteManager(management);
    const publication = await getSitePublication(deps.db, management.scope, management.record.id);
    if (!publication)
      throw sitePublishingError(
        404,
        "not_found",
        "site_not_published",
        "This Site is not published",
      );
    return context.json(await sitePublicationView(deps, management.scope, publication));
  });

  app.put(base, async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await grantFor(context, "artifacts:publish");
    const request = await body(context, UpsertSitePublicationRequest);
    const management = await resolveSiteManagement(deps, grant, siteIdParam(context));
    const result = await runSitePublishing(() =>
      upsertSitePublicationForManager(deps, grant, management, request),
    );
    return context.json(result.publication, result.created ? 201 : 200);
  });

  // Unpublish: the Site stops being served; its hostname stays with it.
  app.delete(base, async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await grantFor(context, "artifacts:publish");
    const management = await resolveSiteManagement(deps, grant, siteIdParam(context));
    requireSiteManager(management);
    const existing = await getSitePublication(deps.db, management.scope, management.record.id);
    if (!existing)
      throw sitePublishingError(
        404,
        "not_found",
        "site_not_published",
        "This Site is not published",
      );
    if (existing.status === "suspended")
      throw sitePublishingError(
        409,
        "conflict",
        "site_suspended",
        "This Site was taken down; restore it first",
      );
    const result = await runSitePublishing(() =>
      upsertSitePublication(deps.db, management.scope, {
        siteId: management.record.id,
        defaultLabel: existing.label,
        changes: { status: "unpublished" },
        actor: grant.subjectId,
        holdDays: deps.settings.sitesHostnameHoldDays,
        defaults: { access: existing.access, noindex: existing.noindex },
      }),
    );
    scheduleSiteEdgeSync(deps, management.scope, management.record.id, { purge: true });
    return context.json(await sitePublicationView(deps, management.scope, result.publication));
  });

  // Take a Site down at once: the Site's owner or a workspace admin.
  app.post(`${base}/takedown`, async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await grantFor(context, "artifacts:publish");
    const request = await body(context, SiteTakedownRequest);
    const management = await resolveSiteManagement(deps, grant, siteIdParam(context));
    if (!management.owner && !management.admin)
      throw sitePublishingError(
        403,
        "forbidden",
        "site_owner_or_admin_required",
        "Only the Site's owner or a workspace admin can take it down",
      );
    const by = management.owner ? "owner" : "admin";
    const publication = await runSitePublishing(() =>
      suspendSitePublication(deps.db, management.scope, management.record.id, {
        by,
        reason: request.reason,
        subject: grant.subjectId,
      }),
    );
    await actionOpenSiteAbuseReports(deps.db, management.scope, {
      siteId: management.record.id,
      actor: grant.subjectId,
    });
    await recordAuditEvent(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      action: "site.publication.takedown",
      targetType: "site",
      targetId: management.record.id,
      metadata: { by, label: publication.label, reason: request.reason.slice(0, 2000) },
    });
    scheduleSiteEdgeSync(deps, management.scope, management.record.id, { purge: true });
    return context.json(await sitePublicationView(deps, management.scope, publication));
  });

  app.post(`${base}/restore`, async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await grantFor(context, "artifacts:publish");
    const management = await resolveSiteManagement(deps, grant, siteIdParam(context));
    if (!management.owner && !management.admin)
      throw sitePublishingError(
        403,
        "forbidden",
        "site_owner_or_admin_required",
        "Only the Site's owner or a workspace admin can restore it",
      );
    const by = management.owner ? "owner" : "admin";
    const publication = await runSitePublishing(() =>
      restoreSitePublication(deps.db, management.scope, management.record.id, {
        by,
        subject: grant.subjectId,
      }),
    );
    await recordAuditEvent(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      action: "site.publication.restore",
      targetType: "site",
      targetId: management.record.id,
      metadata: { by, label: publication.label },
    });
    scheduleSiteEdgeSync(deps, management.scope, management.record.id, { purge: true });
    return context.json(await sitePublicationView(deps, management.scope, publication));
  });

  app.get(`${base}/reports`, async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await grantFor(context, "artifacts:read");
    const management = await resolveSiteManagement(deps, grant, siteIdParam(context));
    requireSiteManager(management);
    const status = z
      .enum(["open", "dismissed", "actioned"])
      .optional()
      .safeParse(context.req.query("status") || undefined);
    if (!status.success) throw invalid("status must be open, dismissed or actioned");
    const reports = await listSiteAbuseReports(deps.db, management.scope, {
      siteId: management.record.id,
      ...(status.data ? { status: status.data } : {}),
      limit: 100,
    });
    return context.json({ reports: reports.map(reportView) });
  });

  app.patch(`${base}/reports/:reportId`, async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await grantFor(context, "artifacts:publish");
    const request = await body(context, ReportStatusRequest);
    const management = await resolveSiteManagement(deps, grant, siteIdParam(context));
    requireSiteManager(management);
    const reportId = ReportIdParam.safeParse(context.req.param("reportId"));
    const report = reportId.success
      ? await updateSiteAbuseReportStatus(deps.db, management.scope, {
          siteId: management.record.id,
          reportId: reportId.data,
          status: request.status,
          actor: grant.subjectId,
        })
      : null;
    if (!report)
      throw sitePublishingError(404, "not_found", "site_report_not_found", "Report not found");
    return context.json(reportView(report));
  });

  app.get("/v1/workspaces/:workspaceId/site-hostnames/:label", async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await grantFor(context, "artifacts:read");
    const siteId = context.req.query("siteId");
    if (siteId !== undefined && !SiteIdParam.safeParse(siteId).success)
      throw invalid("siteId must be a Site id");
    const label = (context.req.param("label") ?? "").toLowerCase();
    return context.json(
      await siteHostnameAvailability(
        deps,
        { accountId: grant.accountId, workspaceId: grant.workspaceId },
        label,
        siteId ?? null,
      ),
    );
  });

  // The workspace's default limit profile for its published Sites.
  app.get("/v1/workspaces/:workspaceId/site-limit-profile", async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await requireAccessGrant(
      context,
      deps,
      context.req.param("workspaceId")!,
      "workspace:read",
    );
    const stored = await getWorkspaceSiteLimitProfile(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });
    return context.json({
      profile: sourceSiteLimitProfile(null, stored),
      effectiveLimits: effectiveSiteLimits(deps.settings, null, stored),
    });
  });

  app.put("/v1/workspaces/:workspaceId/site-limit-profile", async (context) => {
    requireSitesDomain(deps.settings);
    const grant = await requireAccessGrant(
      context,
      deps,
      context.req.param("workspaceId")!,
      "workspace:admin",
    );
    if (!hasLiteralPermission(grant.permissions, "workspace:admin"))
      throw sitePublishingError(
        403,
        "forbidden",
        "site_admin_required",
        "Only a workspace admin can change Site limits",
      );
    const request = await body(context, SiteLimitProfile);
    const stored = await putWorkspaceSiteLimitProfile(
      deps.db,
      { accountId: grant.accountId, workspaceId: grant.workspaceId },
      {
        kind: request.kind,
        overrides:
          request.kind === "custom"
            ? (siteLimitOverrides(request.overrides as Record<string, unknown> | null) as Record<
                string,
                unknown
              >)
            : null,
      },
      grant.subjectId,
    );
    await recordAuditEvent(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      action: "site.limit_profile.update",
      targetType: "workspace",
      targetId: grant.workspaceId,
      metadata: { kind: stored.kind },
    });
    return context.json({
      profile: sourceSiteLimitProfile(null, stored),
      effectiveLimits: effectiveSiteLimits(deps.settings, null, stored),
    });
  });

  /**
   * Viewer sign-in, step one: the signed-in person on the console's
   * `/site-auth/authorize` page asks for a one-time code for a Site host. The
   * API checks the Site admits them, then binds a 60 s single-use code to the
   * host, the PKCE challenge, the exact redirect and the person.
   */
  app.post("/v1/site-auth/authorize", async (context) => {
    const domain = requireSitesDomain(deps.settings);
    const request = await body(context, SiteAuthAuthorizeRequest);
    const person = await siteAuthPerson(context, deps);
    const notFound = () =>
      sitePublishingError(404, "not_found", "site_not_found", "This Site is not available");
    const label = parseSiteHostname(request.host, domain);
    if (!label) throw notFound();
    const hostname = siteHostname(label, domain);
    const record = await findSiteHostname(deps.db, label);
    if (!record || record.releasedAt !== null) throw notFound();
    const scope = { accountId: record.accountId, workspaceId: record.workspaceId };
    const [publication, site] = await Promise.all([
      getSitePublication(deps.db, scope, record.siteId),
      getPublishedSite(deps.db, scope, record.siteId),
    ]);
    if (!publication || !site || publication.status !== "active" || !siteServable(site))
      throw notFound();
    if (request.redirectUri !== `https://${hostname}${SITE_GATEWAY_CALLBACK_PATH}`)
      throw invalid("redirectUri must be this Site's sign-in callback");
    const kind = signedInSiteViewerKind({
      access: effectiveSiteAccess(publication.access, deps.settings),
      member: await isSiteWorkspaceMember(deps.db, scope, person.subjectId),
      email: person.email,
      invitedEmails: publication.invitedEmails,
    });
    if (!kind)
      throw sitePublishingError(
        403,
        "forbidden",
        "site_access_denied",
        "You do not have access to this Site",
      );
    const rate = await consumeSiteRuntimeRate(deps.db, scope, {
      siteId: site.id,
      principal: `user:${person.subjectId}`,
      bucket: "sign_in",
      limit: SIGN_IN_PER_MINUTE,
    });
    if (!rate.allowed) {
      context.header("retry-after", String(rate.retryAfterSeconds));
      throw sitePublishingError(429, "limit_exceeded", "site_rate_limited", "Try again shortly", {
        retryAfterSeconds: rate.retryAfterSeconds,
      });
    }
    const code = randomBytes(32).toString("base64url");
    await createSiteAuthCode(deps.db, scope, {
      siteId: site.id,
      codeHash: createHash("sha256").update(code).digest("hex"),
      hostname,
      codeChallenge: request.codeChallenge,
      redirectUri: request.redirectUri,
      subjectId: person.subjectId,
      kind,
      email: person.email,
      displayName: person.name,
      ttlSeconds: SITE_AUTH_CODE_TTL_SECONDS,
    });
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", request.state);
    context.header("cache-control", "no-store");
    const response: SiteAuthAuthorizeResponse = {
      redirectTo: redirect.toString(),
      site: { title: site.title, hostname },
    };
    return context.json(response);
  });
}
