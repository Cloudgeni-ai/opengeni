import { randomBytes } from "node:crypto";
import {
  normalizeSitesDomain,
  siteHostname,
  siteHostnameLabelProblem,
  SITE_HOSTNAME_PROBLEM_MESSAGES,
  suggestSiteHostnameLabel,
  type ErrorCode,
  type SiteHostMapRecord,
  type SiteHostnameAvailability,
  type SitePublication,
  type UpsertSitePublicationRequest,
} from "@opengeni/contracts";
import type { AccessGrant } from "@opengeni/contracts";
import { hasLiteralPermission, siteViewerForGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  bumpSitePublicationGeneration,
  checkSiteHostnameClaim,
  countOpenSiteAbuseReports,
  getPublishedSite,
  getPublishedSiteVersion,
  getSiteDataSite,
  getSitePublication,
  getWorkspaceSiteLimitProfile,
  markSitePublicationEdgeSynced,
  readSiteRuntimeUsage,
  recordSitePublicationScan,
  SitePublishingError,
  SITE_RUNTIME_SITE_PRINCIPAL,
  upsertSitePublication,
  type PublishedSiteRecord,
  type SiteDataSite,
  type SitePublicationRecord,
  type SitePublishingScope,
  type StoredSiteLimitProfile,
} from "@opengeni/db";
import { ApiHttpError } from "../http/api-error";
import { siteDataRole } from "../site-data/service";
import { createSiteContentScanner, type SiteContentScanner } from "./content-scanner";
import { createSiteEdgeSync, type SiteEdgeSync } from "./edge-sync";
import { effectiveSiteLimits, sourceSiteLimitProfile } from "./limits";

/**
 * Published Sites: publication management, the host map, and the work that
 * follows a change (edge sync, content scan). Postgres is the source of truth;
 * the edge copies are rebuildable and written after commit, never blocking it.
 */

export type SitePublishingDeps = Pick<ApiRouteDeps, "db" | "settings" | "objectStorage">;

// --- configuration -------------------------------------------------------------

/** The configured Sites domain, or null when publishing is off (unset or invalid). */
export function configuredSitesDomain(settings: ApiRouteDeps["settings"]): string | null {
  if (!settings.sitesDomain) return null;
  try {
    return normalizeSitesDomain(settings.sitesDomain);
  } catch {
    return null;
  }
}

export function sitePublishingError(
  status: number,
  code: ErrorCode,
  detail: string,
  message: string,
  extra: Record<string, unknown> = {},
): ApiHttpError {
  return new ApiHttpError(status, {
    code,
    message,
    retryable: false,
    outcomeUnknown: false,
    details: { ...extra, code: detail },
  });
}

/** The Sites domain, or 404 when this deployment does not publish Sites. */
export function requireSitesDomain(settings: ApiRouteDeps["settings"]): string {
  const domain = configuredSitesDomain(settings);
  if (!domain)
    throw sitePublishingError(
      404,
      "not_found",
      "sites_publishing_disabled",
      "Publishing Sites is not enabled on this deployment",
    );
  return domain;
}

const PUBLIC_CODE: Record<SitePublishingError["code"], ErrorCode> = {
  not_found: "not_found",
  taken: "conflict",
  held: "conflict",
  conflict: "conflict",
  forbidden: "forbidden",
  validation: "validation_failed",
};
const STATUS: Record<SitePublishingError["code"], number> = {
  not_found: 404,
  taken: 409,
  held: 409,
  conflict: 409,
  forbidden: 403,
  validation: 400,
};

export function sitePublishingHttpError(error: SitePublishingError): ApiHttpError {
  return sitePublishingError(
    STATUS[error.code],
    PUBLIC_CODE[error.code],
    `site_${error.code}`,
    error.message,
  );
}

export async function runSitePublishing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SitePublishingError) throw sitePublishingHttpError(error);
    throw error;
  }
}

// --- after-commit effects --------------------------------------------------------

export type SitePublishingEffects = {
  edgeSync: SiteEdgeSync;
  scanner: SiteContentScanner;
  /** Wait for every scheduled effect (tests and graceful shutdown). */
  flush(): Promise<void>;
  schedule(name: string, run: () => Promise<void>): void;
};

const effectsBySettings = new WeakMap<object, SitePublishingEffects>();

function createEffects(
  settings: ApiRouteDeps["settings"],
  options: { fetch?: typeof fetch; backoffMs?: number; scanner?: SiteContentScanner } = {},
): SitePublishingEffects {
  const pending = new Set<Promise<void>>();
  return {
    edgeSync: createSiteEdgeSync(settings, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
    }),
    scanner:
      options.scanner ??
      createSiteContentScanner(settings, options.fetch ? { fetch: options.fetch } : {}),
    async flush() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    schedule(name, run) {
      const task = (async () => {
        try {
          await run();
        } catch (error) {
          console.warn(`[site-publishing] ${name} failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
  };
}

/** The effects for this deployment's settings (one set per settings object). */
export function sitePublishingEffects(settings: ApiRouteDeps["settings"]): SitePublishingEffects {
  let effects = effectsBySettings.get(settings);
  if (!effects) {
    effects = createEffects(settings);
    effectsBySettings.set(settings, effects);
  }
  return effects;
}

/** Replace the effects for a settings object (tests: a fake fetch or scanner). */
export function configureSitePublishingEffects(
  settings: ApiRouteDeps["settings"],
  options: { fetch?: typeof fetch; backoffMs?: number; scanner?: SiteContentScanner },
): SitePublishingEffects {
  const effects = createEffects(settings, options);
  effectsBySettings.set(settings, effects);
  return effects;
}

/** Whether a Site may be served at all: active and visible to its workspace. */
export function siteServable(site: Pick<PublishedSiteRecord, "status" | "visibility">): boolean {
  return site.status === "active" && site.visibility === "workspace_shared";
}

export function siteHostMapRecord(
  settings: ApiRouteDeps["settings"],
  domain: string,
  publication: SitePublicationRecord,
  site: PublishedSiteRecord,
  label = publication.label,
): SiteHostMapRecord {
  const current = label === publication.label;
  const status =
    !current || (publication.status === "active" && !siteServable(site))
      ? "unpublished"
      : publication.status;
  return {
    v: 1,
    hostname: siteHostname(label, domain),
    siteId: publication.siteId,
    status,
    access: publication.access,
    versionId: site.currentVersionId,
    title: site.title,
    noindex: publication.noindex || settings.sitesForceNoindex,
    generation: publication.generation,
    updatedAt: publication.updatedAt.toISOString(),
  };
}

/**
 * After commit: write the Site's host-map record (and a tombstone for a
 * released previous label), and purge the host's edge cache on a takedown.
 * A no-op without edge settings; failures are retried and logged.
 */
export function scheduleSiteEdgeSync(
  deps: SitePublishingDeps,
  scope: SitePublishingScope,
  siteId: string,
  options: { previousLabel?: string | null; purge?: boolean } = {},
): void {
  const domain = configuredSitesDomain(deps.settings);
  const effects = sitePublishingEffects(deps.settings);
  if (!domain || (!effects.edgeSync.kvEnabled && !effects.edgeSync.purgeEnabled)) return;
  effects.schedule("edge sync", async () => {
    const [publication, site] = await Promise.all([
      getSitePublication(deps.db, scope, siteId),
      getPublishedSite(deps.db, scope, siteId),
    ]);
    if (!publication || !site) return;
    const record = siteHostMapRecord(deps.settings, domain, publication, site);
    const results = [await effects.edgeSync.putHostRecord(record)];
    if (options.previousLabel)
      results.push(
        await effects.edgeSync.putHostRecord(
          siteHostMapRecord(deps.settings, domain, publication, site, options.previousLabel),
        ),
      );
    if (options.purge) {
      await effects.edgeSync.purgeHost(record.hostname);
      if (options.previousLabel)
        await effects.edgeSync.purgeHost(siteHostname(options.previousLabel, domain));
    }
    if (results.every((result) => result !== "disabled"))
      await markSitePublicationEdgeSynced(deps.db, scope, siteId, publication.generation);
  });
}

/**
 * After commit: scan the URLs in the published version's HTML with the
 * configured scanner and record the findings. Never blocks publishing; the
 * `none` scanner records nothing.
 */
export function scheduleSiteContentScan(
  deps: SitePublishingDeps,
  scope: SitePublishingScope,
  siteId: string,
  versionId: string | null,
): void {
  const effects = sitePublishingEffects(deps.settings);
  if (effects.scanner.name === "none" || !versionId || !deps.objectStorage) return;
  const storage = deps.objectStorage;
  effects.schedule("content scan", async () => {
    const version = await getPublishedSiteVersion(deps.db, scope, siteId, versionId);
    if (!version) return;
    const object = await storage.getObjectBytes(version.contentKey);
    if (!object) return;
    const html = new TextDecoder().decode(object.bytes.slice(0, 2 * 1024 * 1024));
    const result = await effects.scanner.scanHtml(html);
    await recordSitePublicationScan(deps.db, scope, siteId, {
      versionId,
      status: result.status,
      findings: result.findings,
    });
  });
}

/**
 * A Site changed outside publishing (new version, rollback, archive, audience):
 * advance its publication generation and resync the edge. A no-op when the
 * Site is not published. Never throws.
 */
export async function notifySitePublicationChanged(
  deps: SitePublishingDeps,
  scope: SitePublishingScope,
  siteId: string,
  options: { scanVersionId?: string | null } = {},
): Promise<void> {
  if (!configuredSitesDomain(deps.settings)) return;
  try {
    const publication = await bumpSitePublicationGeneration(deps.db, scope, siteId);
    if (!publication) return;
    scheduleSiteEdgeSync(deps, scope, siteId);
    if (options.scanVersionId && publication.status === "active")
      scheduleSiteContentScan(deps, scope, siteId, options.scanVersionId);
  } catch (error) {
    console.warn("[site-publishing] could not record a Site change", {
      siteId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// --- management ------------------------------------------------------------------

export type SiteManagement = {
  scope: SitePublishingScope;
  site: SiteDataSite;
  record: PublishedSiteRecord;
  manager: boolean;
  admin: boolean;
  owner: boolean;
  subjectId: string | null;
};

/**
 * Resolve a Site for publication management. The caller must see the Site
 * (its audience); managers are the Site Data managers (owner, workspace admin,
 * an agent acting for one, or a person-less key with artifacts:publish).
 */
export async function resolveSiteManagement(
  deps: SitePublishingDeps,
  grant: AccessGrant,
  siteId: string,
): Promise<SiteManagement> {
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const viewer = await siteViewerForGrant(deps.db, grant);
  const site = await getSiteDataSite(deps.db, scope, viewer, siteId);
  const record = site ? await getPublishedSite(deps.db, scope, siteId) : null;
  if (!site || !record)
    throw sitePublishingError(404, "not_found", "site_not_found", "Site not found");
  const owner = site.ownerSubjectId ?? site.createdBySubjectId ?? null;
  return {
    scope,
    site,
    record,
    manager: siteDataRole(grant, site, viewer.subjectId) === "manager",
    admin: hasLiteralPermission(grant.permissions, "workspace:admin"),
    owner: viewer.subjectId !== null && owner === viewer.subjectId,
    subjectId: viewer.subjectId,
  };
}

export function requireSiteManager(management: SiteManagement): void {
  if (!management.manager)
    throw sitePublishingError(
      403,
      "forbidden",
      "site_manager_required",
      "Only the Site's owner or a workspace admin can manage its publication",
    );
}

function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(4);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function normalizeEmails(emails: readonly string[]): string[] {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort();
}

export async function siteLimitInputs(
  deps: SitePublishingDeps,
  scope: SitePublishingScope,
  publication: Pick<SitePublicationRecord, "limitProfile"> | null,
): Promise<{ site: StoredSiteLimitProfile | null; workspace: StoredSiteLimitProfile | null }> {
  const site = publication?.limitProfile ?? null;
  return { site, workspace: site ? null : await getWorkspaceSiteLimitProfile(deps.db, scope) };
}

/** The publication as the management API returns it. */
export async function sitePublicationView(
  deps: SitePublishingDeps,
  scope: SitePublishingScope,
  publication: SitePublicationRecord,
): Promise<SitePublication> {
  const domain = requireSitesDomain(deps.settings);
  const profiles = await siteLimitInputs(deps, scope, publication);
  const [openReports, usage] = await Promise.all([
    countOpenSiteAbuseReports(deps.db, scope, publication.siteId),
    readSiteRuntimeUsage(deps.db, scope, {
      siteId: publication.siteId,
      viewerPrincipal: SITE_RUNTIME_SITE_PRINCIPAL,
    }),
  ]);
  const hostname = siteHostname(publication.label, domain);
  return {
    siteId: publication.siteId,
    workspaceId: publication.workspaceId,
    label: publication.label,
    hostname,
    url: `https://${hostname}/`,
    access: publication.access,
    status: publication.status,
    noindex: publication.noindex || deps.settings.sitesForceNoindex,
    agent: publication.agent,
    limitProfile: sourceSiteLimitProfile(profiles.site, profiles.workspace),
    effectiveLimits: effectiveSiteLimits(deps.settings, profiles.site, profiles.workspace),
    invitedEmails: publication.invitedEmails,
    moderation: {
      openReports,
      suspendedAt: publication.suspendedAt?.toISOString() ?? null,
      suspendedBy: publication.suspendedBy,
      suspendedReason: publication.suspendedReason,
    },
    usage: {
      agentMicrosThisMonth: usage.siteMonth.agentMicros,
      conversationsToday: usage.siteDay.conversations,
    },
    createdAt: publication.createdAt.toISOString(),
    updatedAt: publication.updatedAt.toISOString(),
  };
}

/** Hostname availability for this Site (the label rules, then global uniqueness and the hold). */
export async function siteHostnameAvailability(
  deps: SitePublishingDeps,
  scope: SitePublishingScope,
  label: string,
  siteId: string | null,
): Promise<SiteHostnameAvailability> {
  const domain = requireSitesDomain(deps.settings);
  const problem = siteHostnameLabelProblem(label);
  if (problem)
    return {
      label,
      hostname: null,
      available: false,
      problem,
      message: SITE_HOSTNAME_PROBLEM_MESSAGES[problem],
    };
  const check = await checkSiteHostnameClaim(
    deps.db,
    scope,
    label,
    siteId,
    deps.settings.sitesHostnameHoldDays,
  );
  return check.available
    ? {
        label,
        hostname: siteHostname(label, domain),
        available: true,
        problem: null,
        message: null,
      }
    : {
        label,
        hostname: siteHostname(label, domain),
        available: false,
        problem: check.problem,
        message:
          check.problem === "held"
            ? "This name was released recently and is held for its previous owner."
            : "This name is already taken.",
      };
}

/**
 * Create or change a Site's publication. The caller is a manager; a Site must
 * be active and visible to its workspace to be served; public access needs the
 * deployment to allow it; changing the limit profile needs a workspace admin.
 */
export async function upsertSitePublicationForManager(
  deps: SitePublishingDeps,
  grant: AccessGrant,
  management: SiteManagement,
  request: UpsertSitePublicationRequest,
): Promise<{ publication: SitePublication; created: boolean }> {
  requireSitesDomain(deps.settings);
  requireSiteManager(management);
  const { scope, record } = management;
  const existing = await getSitePublication(deps.db, scope, record.id);
  if (existing?.status === "suspended" && request.status !== undefined)
    throw sitePublishingError(
      409,
      "conflict",
      "site_suspended",
      "This Site was taken down; restore it first",
    );
  const activating =
    (request.status ?? existing?.status ?? "active") === "active" &&
    existing?.status !== "suspended";
  if (activating && !siteServable(record))
    throw sitePublishingError(
      409,
      "conflict",
      record.status !== "active" ? "site_archived" : "site_not_shared",
      record.status !== "active"
        ? "Restore this Site before publishing it"
        : "Share this Site with the workspace before publishing it; Only me Sites cannot be published",
    );
  if (request.access === "public" && !deps.settings.sitesPublicEnabled)
    throw sitePublishingError(
      403,
      "forbidden",
      "site_public_disabled",
      "Public Sites are turned off on this deployment",
    );
  if (request.limitProfile !== undefined && !management.admin)
    throw sitePublishingError(
      403,
      "forbidden",
      "site_admin_required",
      "Only a workspace admin can change a Site's limits",
    );
  const limitProfile =
    request.limitProfile === undefined
      ? undefined
      : {
          kind: request.limitProfile.kind,
          overrides:
            request.limitProfile.kind === "custom"
              ? ((request.limitProfile.overrides as Record<string, unknown> | null) ?? null)
              : null,
        };
  const model = request.agent?.model;
  if (model) {
    const profiles = await siteLimitInputs(deps, scope, {
      limitProfile: limitProfile === undefined ? (existing?.limitProfile ?? null) : limitProfile,
    });
    const allowed = effectiveSiteLimits(
      deps.settings,
      profiles.site,
      profiles.workspace,
    ).agentModels;
    if (allowed && !allowed.includes(model))
      throw sitePublishingError(
        400,
        "validation_failed",
        "site_model_not_allowed",
        "This model is not allowed for this Site's agent",
      );
  }
  const changes = {
    ...(request.label !== undefined ? { label: request.label } : {}),
    ...(request.access !== undefined ? { access: request.access } : {}),
    ...(request.status !== undefined ? { status: request.status } : {}),
    ...(request.noindex !== undefined ? { noindex: request.noindex } : {}),
    ...(request.agent !== undefined
      ? {
          agent: {
            ...(request.agent.enabled !== undefined ? { enabled: request.agent.enabled } : {}),
            ...(request.agent.model !== undefined ? { model: request.agent.model } : {}),
            ...(request.agent.instructions !== undefined
              ? { instructions: request.agent.instructions }
              : {}),
            ...(request.agent.tools !== undefined ? { tools: request.agent.tools } : {}),
          },
        }
      : {}),
    ...(limitProfile !== undefined ? { limitProfile } : {}),
    ...(request.invitedEmails !== undefined
      ? { invitedEmails: normalizeEmails(request.invitedEmails) }
      : {}),
  };
  // A new publication without a label takes a suggested one; a random suffix
  // collides rarely, so retry a few times.
  let result: Awaited<ReturnType<typeof upsertSitePublication>> | null = null;
  for (let attempt = 0; attempt < 5 && result === null; attempt += 1) {
    try {
      result = await upsertSitePublication(deps.db, scope, {
        siteId: record.id,
        defaultLabel: suggestSiteHostnameLabel(record.title, randomSuffix()),
        changes,
        actor: grant.subjectId,
        holdDays: deps.settings.sitesHostnameHoldDays,
        defaults: { access: "members", noindex: true },
      });
    } catch (error) {
      const retry =
        error instanceof SitePublishingError &&
        (error.code === "taken" || error.code === "held") &&
        request.label === undefined &&
        existing === null &&
        attempt < 4;
      if (!retry) throw error;
    }
  }
  const { publication, created, previousLabel } = result!;
  scheduleSiteEdgeSync(deps, scope, record.id, { previousLabel });
  if (publication.status === "active" && (created || existing?.status !== "active"))
    scheduleSiteContentScan(deps, scope, record.id, record.currentVersionId);
  return { publication: await sitePublicationView(deps, scope, publication), created };
}
