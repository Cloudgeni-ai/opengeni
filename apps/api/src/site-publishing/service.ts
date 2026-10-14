import { randomBytes } from "node:crypto";
import {
  normalizeSitesDomain,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  siteHostname,
  siteHostnameLabelProblem,
  SITE_HOSTNAME_PROBLEM_MESSAGES,
  suggestSiteHostnameLabel,
  type ErrorCode,
  type Permission,
  type SiteHostMapRecord,
  type SiteHostnameAvailability,
  type SitePublication,
  type UpsertSitePublicationRequest,
} from "@opengeni/contracts";
import type { AccessGrant } from "@opengeni/contracts";
import {
  assertNotSiteClampedAgent,
  currentSiteSessionOrigin,
  hasLiteralPermission,
  siteViewerForGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  bumpSitePublicationGeneration,
  checkSiteHostnameClaim,
  countOpenSiteAbuseReports,
  getPublishedSiteVersion,
  getSiteDataSite,
  getSitePublication,
  getWorkspaceSiteLimitProfile,
  markSitePublicationEdgeSynced,
  readSiteRuntimeUsage,
  recordSitePublicationScan,
  getPublishedSite,
  listActiveSiteRuntimeConversations,
  revokeSiteViewerSessions,
  SitePublishingError,
  SITE_RUNTIME_SITE_PRINCIPAL,
  upsertSitePublication,
  withSiteHostnameEdgeState,
  type PublishedSiteRecord,
  type SiteDataSite,
  type SiteHostnameEdgeState,
  type SitePublicationRecord,
  type SitePublishingScope,
  type StoredSiteLimitProfile,
} from "@opengeni/db";
import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";
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

export type SitePublishingDeps = Pick<ApiRouteDeps, "db" | "settings" | "objectStorage"> &
  Partial<Pick<ApiRouteDeps, "managedEmailTransport">>;

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
  reserved: "conflict",
  conflict: "conflict",
  forbidden: "forbidden",
  validation: "validation_failed",
};
const STATUS: Record<SitePublishingError["code"], number> = {
  not_found: 404,
  taken: 409,
  held: 409,
  reserved: 409,
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
const dispatchBySettings = new WeakMap<object, (request: Request) => Promise<Response>>();

/**
 * The app's in-process dispatch, registered with the site-runtime routes, so
 * publication changes can cancel a Site's conversations through the ordinary
 * session routes. Without it (the operator script) cancellation is skipped.
 */
export function setSitePublishingDispatch(
  settings: ApiRouteDeps["settings"],
  dispatch: (request: Request) => Promise<Response>,
): void {
  dispatchBySettings.set(settings, dispatch);
}

export function sitePublishingDispatch(
  settings: ApiRouteDeps["settings"],
): ((request: Request) => Promise<Response>) | null {
  return dispatchBySettings.get(settings) ?? null;
}

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
): SiteHostMapRecord {
  const status =
    publication.status === "active" && !siteServable(site) ? "unpublished" : publication.status;
  return {
    v: 1,
    hostname: siteHostname(publication.label, domain),
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
 * The host-map record a hostname should have now: the live Site's, else a
 * tombstone (unpublished, no version) with a fresh generation, so it replaces
 * whatever the edge holds for that hostname. Null when no Site is known.
 */
export function siteHostnameEdgeRecord(
  settings: ApiRouteDeps["settings"],
  domain: string,
  state: SiteHostnameEdgeState,
  siteIdHint: string | null,
): SiteHostMapRecord | null {
  if (state.live)
    return siteHostMapRecord(settings, domain, state.live.publication, state.live.site);
  const siteId = state.hostname?.siteId ?? state.hold?.siteId ?? siteIdHint;
  if (!siteId || state.tombstoneGeneration === null) return null;
  return {
    v: 1,
    hostname: siteHostname(state.label, domain),
    siteId,
    status: state.hold ? "suspended" : "unpublished",
    access: "members",
    versionId: null,
    title: "",
    noindex: true,
    generation: state.tombstoneGeneration,
    updatedAt: new Date().toISOString(),
  };
}

/** Labels whose edge copy is being rewritten now (no duplicate self-heal work). */
const recentHeals = new Map<string, number>();

/**
 * Sync one hostname to the edge under its lock: write the live Site's record
 * or a tombstone, purge the edge cache when asked, then record the
 * generation the edge holds. A no-op without edge settings.
 */
export async function syncSiteHostnameEdge(
  deps: SitePublishingDeps,
  label: string,
  options: { purge?: boolean; siteIdHint?: string | null } = {},
): Promise<"synced" | "skipped" | "disabled"> {
  const domain = configuredSitesDomain(deps.settings);
  const effects = sitePublishingEffects(deps.settings);
  if (!domain || (!effects.edgeSync.kvEnabled && !effects.edgeSync.purgeEnabled)) return "disabled";
  const synced = await withSiteHostnameEdgeState(deps.db, label, async (state) => {
    const record = siteHostnameEdgeRecord(deps.settings, domain, state, options.siteIdHint ?? null);
    if (!record) return null;
    const put = await effects.edgeSync.putHostRecord(record);
    if (options.purge) await effects.edgeSync.purgeHost(record.hostname);
    return state.live && put !== "disabled"
      ? {
          scope: {
            accountId: state.live.publication.accountId,
            workspaceId: state.live.publication.workspaceId,
          },
          siteId: state.live.publication.siteId,
          generation: state.live.publication.generation,
        }
      : null;
  });
  // Recorded after the hostname lock is released (it is a separate write).
  if (synced)
    await markSitePublicationEdgeSynced(deps.db, synced.scope, synced.siteId, synced.generation);
  return synced ? "synced" : "skipped";
}

/**
 * After commit: rewrite the edge copy of each hostname (the Site's label and
 * a released previous one), and purge their edge cache when asked
 * (takedown, unpublish). A no-op without edge settings; failures are retried
 * and logged, and a missed sync heals on the next host lookup. Lost if the
 * process stops first: the KV TTL then bounds how long the edge stays stale.
 */
export function scheduleSiteEdgeSync(
  deps: SitePublishingDeps,
  labels: ReadonlyArray<string | null | undefined>,
  options: { purge?: boolean; siteIdHint?: string | null } = {},
): void {
  const domain = configuredSitesDomain(deps.settings);
  const effects = sitePublishingEffects(deps.settings);
  if (!domain || (!effects.edgeSync.kvEnabled && !effects.edgeSync.purgeEnabled)) return;
  const unique = [...new Set(labels.filter((label): label is string => Boolean(label)))];
  if (unique.length === 0) return;
  effects.schedule("edge sync", async () => {
    for (const label of unique) await syncSiteHostnameEdge(deps, label, options);
  });
}

/**
 * Self-heal: the edge copy of a live hostname is behind its publication
 * (a sync was lost or failed). Schedules one sync per hostname at most every
 * 30 seconds per process.
 */
export function healSiteEdgeIfStale(
  deps: SitePublishingDeps,
  publication: Pick<
    SitePublicationRecord,
    "label" | "generation" | "edgeSyncedGeneration" | "siteId"
  >,
): void {
  if (publication.edgeSyncedGeneration >= publication.generation) return;
  const effects = sitePublishingEffects(deps.settings);
  if (!effects.edgeSync.kvEnabled) return;
  const now = Date.now();
  if ((recentHeals.get(publication.label) ?? 0) > now - 30_000) return;
  if (recentHeals.size > 10_000) recentHeals.clear();
  recentHeals.set(publication.label, now);
  scheduleSiteEdgeSync(deps, [publication.label], { siteIdHint: publication.siteId });
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
    const domain = configuredSitesDomain(deps.settings);
    const publication =
      result.status === "flagged" && domain
        ? await getSitePublication(deps.db, scope, siteId)
        : null;
    if (publication && domain)
      notifySiteAbuse(deps, {
        scope,
        siteId,
        hostname: siteHostname(publication.label, domain),
        kind: "flagged_scan",
        detail: `${result.findings.length} finding(s) in version ${versionId}`,
      });
  });
}

/**
 * A Site changed outside publishing (new version, rollback, archive, audience):
 * advance its publication generation and resync the edge, and scan a newly
 * current version. A no-op when the Site is not published. Never throws.
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
    // Archived or made private: the Site is no longer served, so its viewers stop too.
    if (publication.status === "active") {
      const site = await getPublishedSite(deps.db, scope, siteId);
      if (!site || !siteServable(site))
        await stopSiteViewers(deps, scope, siteId, { reason: "unpublished" });
    }
    scheduleSiteEdgeSync(deps, [publication.label], { siteIdHint: siteId });
    if (options.scanVersionId && publication.status === "active")
      scheduleSiteContentScan(deps, scope, siteId, options.scanVersionId);
  } catch (error) {
    console.warn("[site-publishing] could not record a Site change", {
      siteId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The one hook every Site artifact mutation runs, from the API routes and
 * the agent tools alike (publish, rollback, archive, restore): a published
 * Site follows its Site. `scan` scans the version that became current
 * (publish and rollback). Replays changed nothing and do nothing.
 */
export async function afterSiteArtifactMutation<
  T extends {
    replayed?: boolean;
    artifact: { id: string; accountId: string; workspaceId: string };
    version?: { id: string } | null;
  },
>(deps: SitePublishingDeps, result: T, options: { scan?: boolean } = {}): Promise<T> {
  if (!result.replayed)
    await notifySitePublicationChanged(
      deps,
      { accountId: result.artifact.accountId, workspaceId: result.artifact.workspaceId },
      result.artifact.id,
      options.scan && result.version ? { scanVersionId: result.version.id } : {},
    );
  return result;
}

// --- the Site's own principal ---------------------------------------------------------

/** The authority Site agent sessions run with: sessions only, nothing else. */
export const SITE_RUNTIME_AGENT_PERMISSIONS: readonly Permission[] = Object.freeze([
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
]);

/**
 * A request to an ordinary session route as the Site's service principal
 * (`site:<siteId>`), with a 60-second delegated token carrying only session
 * permissions, for in-process dispatch. The Site headers ride along so the
 * API's Site frame guard and provenance see which Site acts.
 */
export async function siteServiceSessionRequest(
  deps: Pick<SitePublishingDeps, "settings">,
  scope: SitePublishingScope,
  site: { id: string; versionId: string | null },
  input: { origin: string; method: string; path: string; body?: unknown; label: string },
): Promise<Request> {
  const secret = resolveFirstPartyDelegationSecret(deps.settings);
  if (!secret)
    throw sitePublishingError(
      503,
      "upstream_unavailable",
      "site_agents_unavailable",
      "Site assistants are not configured on this deployment",
      { reason: "delegation_unconfigured" },
    );
  const token = await signDelegatedAccessToken(secret, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: `site:${site.id}`,
    subjectLabel: input.label.slice(0, 250),
    permissions: [...SITE_RUNTIME_AGENT_PERMISSIONS],
    principalKind: "service",
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    accept: "application/json",
    [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    "x-opengeni-site-id": site.id,
  });
  if (site.versionId) headers.set("x-opengeni-site-version", site.versionId);
  if (input.body !== undefined) headers.set("content-type", "application/json");
  return new Request(new URL(input.path, input.origin), {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

/** Conversations cancelled per stop (newest activity first); the rest end on their own caps. */
const STOP_CONVERSATIONS_LIMIT = 200;

/**
 * Stop a Site's viewers after a takedown, unpublish or narrower access:
 * revoke every site-session now, and after commit cancel the Site's agent
 * conversations that may still be working (in-flight turns and queued
 * messages), as the Site itself through the ordinary control route. The
 * gateway refuses new work at once regardless: every site-runtime call
 * re-checks the publication. Without an in-process dispatch (the operator
 * script) the cancellation is skipped and logged; per-conversation caps
 * still bound what running turns can spend.
 */
export async function stopSiteViewers(
  deps: SitePublishingDeps,
  scope: SitePublishingScope,
  siteId: string,
  options: { revokeSessions?: boolean; cancelConversations?: boolean; reason: string },
): Promise<{ revokedSessions: number }> {
  let revokedSessions = 0;
  if (options.revokeSessions !== false) {
    try {
      revokedSessions = await revokeSiteViewerSessions(deps.db, scope, siteId);
    } catch (error) {
      console.warn("[site-publishing] could not revoke viewer sessions", {
        siteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (options.cancelConversations === false) return { revokedSessions };
  const dispatch = sitePublishingDispatch(deps.settings);
  if (!dispatch) {
    console.warn("[site-publishing] conversation cancel skipped: no in-process dispatch", {
      siteId,
    });
    return { revokedSessions };
  }
  const effects = sitePublishingEffects(deps.settings);
  const origin = deps.settings.publicBaseUrl ?? "http://localhost";
  effects.schedule("cancel conversations", async () => {
    const sessionIds = await listActiveSiteRuntimeConversations(deps.db, scope, {
      siteId,
      limit: STOP_CONVERSATIONS_LIMIT,
    });
    if (sessionIds.length === 0) return;
    // The Site acts with its own origin (a Site and one of its versions).
    const versionId = (await getPublishedSite(deps.db, scope, siteId))?.currentVersionId ?? null;
    if (!versionId) {
      console.warn("[site-publishing] conversation cancel skipped: the Site has no version", {
        siteId,
      });
      return;
    }
    const operation = crypto.randomUUID();
    for (const sessionId of sessionIds) {
      try {
        const response = await dispatch(
          await siteServiceSessionRequest(
            deps,
            scope,
            { id: siteId, versionId },
            {
              origin,
              method: "POST",
              path: `/v1/workspaces/${scope.workspaceId}/sessions/${sessionId}/control`,
              body: {
                action: "cancel",
                clientEventId: `site-stop:${operation}:${sessionId}`.slice(0, 200),
                reason: options.reason.slice(0, 500),
              },
              label: "Published Site",
            },
          ),
        );
        if (!response.ok)
          console.warn("[site-publishing] could not cancel a Site conversation", {
            siteId,
            sessionId,
            status: response.status,
            body: (await response.text().catch(() => "")).slice(0, 300),
          });
        else await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        console.warn("[site-publishing] could not cancel a Site conversation", {
          siteId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  return { revokedSessions };
}

// --- reaching the platform -----------------------------------------------------------

const abuseNoticeHours = new Map<string, number>();

/**
 * Tell the platform about an abuse report or a flagged content scan: always a
 * structured log line (`site_abuse_notice`), and, when OPENGENI_SITES_ABUSE_EMAIL
 * is set, an email through the deployment's managed email transport (at most
 * one per Site per hour, best effort, after the request). The operator's
 * cross-workspace queue (`scripts/operator/site-moderation-queue.ts`) lists
 * everything open.
 */
export function notifySiteAbuse(
  deps: SitePublishingDeps,
  input: {
    scope: SitePublishingScope;
    siteId: string;
    hostname: string;
    kind: "report" | "flagged_scan";
    detail: string;
  },
): void {
  console.warn(
    JSON.stringify({
      event: "site_abuse_notice",
      kind: input.kind,
      accountId: input.scope.accountId,
      workspaceId: input.scope.workspaceId,
      siteId: input.siteId,
      hostname: input.hostname,
      detail: input.detail.slice(0, 200),
    }),
  );
  const to = deps.settings.sitesAbuseEmail;
  const transport = deps.managedEmailTransport;
  if (!to || !transport) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `${input.siteId}:${input.kind}`;
  if (abuseNoticeHours.get(key) === hour) return;
  if (abuseNoticeHours.size > 10_000) abuseNoticeHours.clear();
  abuseNoticeHours.set(key, hour);
  const what = input.kind === "report" ? "An abuse report" : "A flagged content scan";
  const text = [
    `${what} for the published Site https://${input.hostname}/`,
    `Site: ${input.siteId}`,
    `Workspace: ${input.scope.workspaceId}`,
    `Detail: ${input.detail.slice(0, 200)}`,
    "",
    "List open items with scripts/operator/site-moderation-queue.ts; take a Site down with scripts/operator/site-takedown.ts.",
  ].join("\n");
  sitePublishingEffects(deps.settings).schedule("abuse notice", async () => {
    const result = await transport.send({
      kind: "site_abuse_notice",
      from: transport.sender,
      to,
      subject: `[Opengeni Sites] ${what}: ${input.hostname}`.slice(0, 200),
      text,
      html: `<pre>${text.replace(/[&<>]/gu, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"))}</pre>`,
      idempotencyKey: `site-abuse-notice:${key}:${hour}`,
    });
    if (result.status !== "sent")
      console.warn("[site-publishing] abuse notice email not sent", {
        siteId: input.siteId,
        status: result.status,
      });
  });
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
 * Publication changes come from people and their own agents, never from a
 * Site page: refuse a request that carries a validated Site origin (a Site or
 * frame page reaching the API through a host) and an agent started from a
 * Site page, or acting in a turn one sent (the Site clamp).
 */
export async function requireSitePublicationWriter(
  deps: SitePublishingDeps,
  grant: AccessGrant,
): Promise<void> {
  if (currentSiteSessionOrigin())
    throw sitePublishingError(
      403,
      "forbidden",
      "site_page_forbidden",
      "A Site page cannot change Site publications",
    );
  try {
    await assertNotSiteClampedAgent(deps.db, grant, "Site publications");
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403)
      throw sitePublishingError(
        403,
        "forbidden",
        "site_agent_forbidden",
        "An agent started from a Site page cannot change Site publications",
      );
    throw error;
  }
}

/**
 * Resolve a Site for publication management. The caller must see the Site
 * (its audience); managers are the Site Data managers (owner, workspace admin,
 * an agent acting for one, or a person-less key with artifacts:publish).
 * `mutate` callers must also pass `requireSitePublicationWriter`.
 */
export async function resolveSiteManagement(
  deps: SitePublishingDeps,
  grant: AccessGrant,
  siteId: string,
  options: { mutate?: boolean } = {},
): Promise<SiteManagement> {
  if (options.mutate) await requireSitePublicationWriter(deps, grant);
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
            : check.problem === "reserved"
              ? "This name is reserved."
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
  if (
    existing?.status === "suspended" &&
    (request.status !== undefined ||
      (request.label !== undefined && request.label !== existing.label))
  )
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
  // Workspace tools act with the workspace's shared connections for whoever
  // views the Site: only a workspace admin may give them to the Site's agent
  // (or to guests). Anyone who manages the Site may keep or remove them.
  const tools = request.agent?.tools;
  const currentTools = new Set(existing?.agent.tools ?? []);
  const addsTools = (tools ?? []).some((tool) => !currentTools.has(tool));
  const grantsGuestTools =
    request.agent?.guestTools === true && existing?.agent.guestTools !== true;
  if ((addsTools || grantsGuestTools) && !management.admin)
    throw sitePublishingError(
      403,
      "forbidden",
      "site_admin_required",
      "Only a workspace admin can give a Site's assistant workspace tools",
    );
  for (const tool of tools ?? [])
    if (!SITE_AGENT_TOOL_ID.test(tool) || RESERVED_SITE_AGENT_TOOL_IDS.has(tool))
      throw sitePublishingError(
        400,
        "validation_failed",
        "site_tool_invalid",
        `"${tool.slice(0, 80)}" is not a workspace tool connection a Site's assistant can use`,
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
            ...(request.agent.tools !== undefined
              ? { tools: request.agent.tools ? [...new Set(request.agent.tools)] : null }
              : {}),
            ...(request.agent.guestTools !== undefined
              ? { guestTools: request.agent.guestTools }
              : {}),
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
  const stopping = existing ? siteAccessNarrowed(existing, publication) : null;
  if (stopping)
    await stopSiteViewers(deps, scope, record.id, {
      reason: stopping,
      revokeSessions: stopping !== "agent_disabled",
    });
  scheduleSiteEdgeSync(deps, [publication.label, previousLabel], {
    siteIdHint: record.id,
    purge: stopping === "unpublished",
  });
  if (publication.status === "active" && (created || existing?.status !== "active"))
    scheduleSiteContentScan(deps, scope, record.id, record.currentVersionId);
  return { publication: await sitePublicationView(deps, scope, publication), created };
}

const ACCESS_RANK = { members: 0, invited: 1, public: 2 } as const;

/**
 * Why a publication change must stop current viewers, or null: unpublished,
 * a narrower access mode, a removed invitation, or the assistant turned off
 * (conversations only).
 */
export function siteAccessNarrowed(
  before: Pick<SitePublicationRecord, "status" | "access" | "invitedEmails" | "agent">,
  after: Pick<SitePublicationRecord, "status" | "access" | "invitedEmails" | "agent">,
): "unpublished" | "access_narrowed" | "agent_disabled" | null {
  if (before.status === "active" && after.status !== "active") return "unpublished";
  if (ACCESS_RANK[after.access] < ACCESS_RANK[before.access]) return "access_narrowed";
  if (after.access === "invited") {
    const kept = new Set(after.invitedEmails);
    if (before.invitedEmails.some((email) => !kept.has(email))) return "access_narrowed";
  }
  if (before.agent.enabled && !after.agent.enabled) return "agent_disabled";
  return null;
}

/** MCP server ids (the session tool reference format). */
const SITE_AGENT_TOOL_ID = /^[A-Za-z0-9_-]{1,200}$/u;
/** The first-party server is never a Site agent's tool: it is the workspace itself. */
const RESERVED_SITE_AGENT_TOOL_IDS = new Set(["opengeni"]);
