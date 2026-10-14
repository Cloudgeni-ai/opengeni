import { createHash } from "node:crypto";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  parseSiteHostname,
  signDelegatedAccessToken,
  siteHostname,
  type Permission,
  type SiteLimitProfileKind,
  type SiteLimits,
} from "@opengeni/contracts";
import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import { sessionUsageLimitsProducerEnabled, type ApiRouteDeps } from "@opengeni/core";
import {
  consumeSiteRuntimeRate,
  findSiteHostname,
  findSiteViewerSession,
  getPublishedSite,
  getSitePublication,
  isSiteWorkspaceMember,
  readSessionUsageLimit,
  recordUsageEvent,
  setSessionUsageLimitInTransaction,
  settleSiteRuntimeConversationSpend,
  withRlsContext,
  withWorkspaceSessionActivityRls,
  type PublishedSiteRecord,
  type SitePublicationRecord,
  type SitePublishingScope,
  type SiteRuntimeRateBucket,
} from "@opengeni/db";
import type { SiteGatewayFields } from "./gateway-signature";
import { effectiveSiteLimits, sourceSiteLimitProfile } from "./limits";
import { siteLimitInputs, sitePublishingError, siteServable } from "./service";
import {
  effectiveSiteAccess,
  signedInSiteViewerKind,
  siteGuestsAllowed,
  SITE_VISITOR_ID,
  type SiteRuntimeViewer,
} from "./viewer";

/**
 * Site-runtime: the narrow API a Site gateway calls for one published Site
 * host, after the gateway signature passed. Everything here works for exactly
 * one Site: the host names it, the viewer is resolved for it, and the agent
 * principal is `site:<siteId>`.
 */

export type SiteRuntimeDeps = Pick<ApiRouteDeps, "db" | "settings" | "objectStorage">;

export type SiteRuntimeHost = {
  domain: string;
  label: string;
  hostname: string;
  scope: SitePublishingScope;
  publication: SitePublicationRecord;
  site: PublishedSiteRecord;
};

/** The Site behind a host, whatever its status (null when the host names no Site). */
export async function findSiteRuntimeHost(
  deps: SiteRuntimeDeps,
  domain: string,
  host: string,
): Promise<SiteRuntimeHost | null> {
  const label = parseSiteHostname(host, domain);
  if (!label) return null;
  const record = await findSiteHostname(deps.db, label);
  if (!record || record.releasedAt !== null) return null;
  const scope = { accountId: record.accountId, workspaceId: record.workspaceId };
  const [publication, site] = await Promise.all([
    getSitePublication(deps.db, scope, record.siteId),
    getPublishedSite(deps.db, scope, record.siteId),
  ]);
  if (!publication || !site || publication.label !== label) return null;
  return { domain, label, hostname: siteHostname(label, domain), scope, publication, site };
}

/** The Site behind a host when it is served: 404 for no Site, 410 when not served. */
export async function requireServedSiteRuntimeHost(
  deps: SiteRuntimeDeps,
  domain: string,
  host: string,
): Promise<SiteRuntimeHost & { versionId: string }> {
  const found = await findSiteRuntimeHost(deps, domain, host);
  if (!found)
    throw sitePublishingError(404, "not_found", "site_not_found", "This Site does not exist");
  const { publication, site } = found;
  if (publication.status !== "active" || !siteServable(site) || !site.currentVersionId)
    throw sitePublishingError(410, "not_found", "site_unavailable", "This Site is not available", {
      status: publication.status === "suspended" ? "suspended" : "unpublished",
    });
  return { ...found, versionId: site.currentVersionId };
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Who is viewing: a live site-session of this Site whose person the Site
 * still admits (membership and invitations are re-read every call), else an
 * anonymous guest of a public Site, else sign-in is required.
 */
export async function resolveSiteRuntimeViewer(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  fields: SiteGatewayFields,
): Promise<SiteRuntimeViewer> {
  const { scope, publication, site } = host;
  if (fields.session) {
    const session = await findSiteViewerSession(deps.db, scope, {
      siteId: site.id,
      tokenHash: sha256Text(fields.session),
      idleSeconds: deps.settings.sitesViewerSessionIdleSeconds,
    });
    if (session) {
      const kind = signedInSiteViewerKind({
        access: effectiveSiteAccess(publication.access, deps.settings),
        member: await isSiteWorkspaceMember(deps.db, scope, session.subjectId),
        email: session.email,
        invitedEmails: publication.invitedEmails,
      });
      if (!kind)
        throw sitePublishingError(
          403,
          "forbidden",
          "site_access_denied",
          "You do not have access to this Site",
        );
      return {
        kind,
        principal: `user:${session.subjectId}`,
        subjectId: session.subjectId,
        name: session.displayName,
        email: session.email,
        sessionId: session.id,
      };
    }
  }
  if (siteGuestsAllowed(publication.access, deps.settings) && SITE_VISITOR_ID.test(fields.visitor))
    return {
      kind: "guest",
      principal: `guest:${fields.visitor}`,
      subjectId: null,
      name: null,
      email: null,
      sessionId: null,
    };
  throw sitePublishingError(
    401,
    "unauthenticated",
    "site_sign_in_required",
    "Sign in to view this Site",
  );
}

export async function siteRuntimeLimits(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
): Promise<SiteLimits> {
  return (await siteRuntimeLimitProfile(deps, host)).limits;
}

/** The Site's effective limits and the kind of limit profile they come from. */
export async function siteRuntimeLimitProfile(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
): Promise<{ limits: SiteLimits; kind: SiteLimitProfileKind }> {
  const profiles = await siteLimitInputs(deps, host.scope, host.publication);
  return {
    limits: effectiveSiteLimits(deps.settings, profiles.site, profiles.workspace),
    kind: sourceSiteLimitProfile(profiles.site, profiles.workspace).kind,
  };
}

/** Count one operation in a per-minute bucket; 429 with Retry-After past `limit` (null: no limit). */
export async function enforceSiteRuntimeRate(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  principal: string,
  bucket: SiteRuntimeRateBucket,
  limit: number | null,
): Promise<void> {
  if (limit === null) return;
  const rate = await consumeSiteRuntimeRate(deps.db, host.scope, {
    siteId: host.site.id,
    principal,
    bucket,
    limit,
  });
  if (!rate.allowed)
    throw sitePublishingError(
      429,
      "limit_exceeded",
      "site_rate_limited",
      "Too many requests; try again shortly",
      {
        bucket,
        retryAfterSeconds: rate.retryAfterSeconds,
      },
    );
}

// --- agents ---------------------------------------------------------------------

/** The authority site-runtime agent sessions run with: sessions only, nothing else. */
export const SITE_RUNTIME_AGENT_PERMISSIONS: readonly Permission[] = Object.freeze([
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
]);

/** A short display label for the viewer, recorded as the end user of the agent's work. */
export function siteRuntimeViewerLabel(viewer: SiteRuntimeViewer): string {
  if (viewer.kind === "guest") return "Site guest";
  const who = viewer.name?.trim() || viewer.email || "Site viewer";
  return who.slice(0, 120);
}

/** Whether this viewer may use the Site's embedded agent at all (before budgets). */
export function siteAgentRefusal(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  viewer: SiteRuntimeViewer,
  limits: SiteLimits,
): string | null {
  if (!host.publication.agent.enabled || !limits.agentsEnabled) return "agent_disabled";
  // Every conversation is capped by its own task usage limit; without the
  // producer that cap cannot be stored, so Site agents stay off.
  if (!sessionUsageLimitsProducerEnabled(deps.settings)) return "usage_limits_disabled";
  if (viewer.kind === "guest" && !limits.guestAgentsEnabled) return "guest_agents_disabled";
  if (viewer.kind === "user" && !deps.settings.sitesPublicAgentsEnabled)
    return "public_agents_disabled";
  return null;
}

export function requireSiteAgent(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  viewer: SiteRuntimeViewer,
  limits: SiteLimits,
): void {
  const reason = siteAgentRefusal(deps, host, viewer, limits);
  if (reason)
    throw sitePublishingError(
      403,
      "forbidden",
      "site_agents_unavailable",
      "This Site's assistant is not available to you",
      { reason },
    );
}

function budgetExhausted(budget: string, message: string) {
  return sitePublishingError(429, "limit_exceeded", "site_budget_exhausted", message, { budget });
}

/**
 * Bring a conversation's counted spend up to its session usage so far. A read
 * failure leaves the counters as they are; the session's own usage limit still
 * caps the conversation.
 */
export async function settleSiteRuntimeSpend(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  sessionId: string,
): Promise<number | null> {
  try {
    const read = await readSessionUsageLimit(deps.db, {
      ...host.scope,
      sessionId,
      runtime: true,
    });
    const used = read.outcome === "ok" ? read.state.usedMicros : null;
    if (used === null) return null;
    await settleSiteRuntimeConversationSpend(deps.db, host.scope, { sessionId, usedMicros: used });
    return used;
  } catch (error) {
    console.warn("[site-runtime] could not settle conversation spend", {
      siteId: host.site.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The viewer's day and the Site's month budgets, before a new conversation or message. */
export function requireSiteRuntimeBudgets(
  limits: SiteLimits,
  usage: {
    visitorDay: { conversations: number; agentMicros: number };
    siteMonth: { agentMicros: number };
  },
  options: { newConversation: boolean },
): void {
  if (
    options.newConversation &&
    limits.conversationsPerVisitorPerDay !== null &&
    usage.visitorDay.conversations >= limits.conversationsPerVisitorPerDay
  )
    throw budgetExhausted(
      "conversations_per_visitor_per_day",
      "You have started as many conversations as this Site allows today",
    );
  if (
    limits.agentMicrosPerVisitorPerDay !== null &&
    usage.visitorDay.agentMicros >= limits.agentMicrosPerVisitorPerDay
  )
    throw budgetExhausted(
      "agent_micros_per_visitor_per_day",
      "You have used this Site's assistant as much as it allows today",
    );
  if (
    limits.agentMicrosPerSitePerMonth !== null &&
    usage.siteMonth.agentMicros >= limits.agentMicrosPerSitePerMonth
  )
    throw budgetExhausted(
      "agent_micros_per_site_per_month",
      "This Site's assistant has reached its budget for this month",
    );
}

export function requireSiteRuntimeConversationBudget(
  limits: SiteLimits,
  meteredMicros: number,
): void {
  if (
    limits.agentMicrosPerConversation !== null &&
    meteredMicros >= limits.agentMicrosPerConversation
  )
    throw budgetExhausted(
      "agent_micros_per_conversation",
      "This conversation has reached its budget; start a new one",
    );
}

export function siteTurnsExhausted() {
  return budgetExhausted(
    "turns_per_conversation",
    "This conversation has reached its message limit; start a new one",
  );
}

/**
 * Cap a new conversation with its own task usage limit (the effective
 * per-conversation budget). Session create refuses limits from service
 * principals, so site-runtime, the trusted server here, sets it right after
 * create as the host actor `site:<siteId>`. The initial turn is admitted per
 * model call against the limit; the limit lands before the first call in
 * practice, and the Site budgets are checked again on every message.
 */
export async function applySiteRuntimeConversationLimit(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  sessionId: string,
  limitMicros: number | null,
): Promise<boolean> {
  if (limitMicros === null) return true;
  try {
    const result = await withWorkspaceSessionActivityRls(
      deps.db,
      host.scope.workspaceId,
      async (tx) =>
        await setSessionUsageLimitInTransaction(tx, {
          accountId: host.scope.accountId,
          workspaceId: host.scope.workspaceId,
          sessionId,
          limitMicros,
          expectedVersion: 0,
          operationId: `site-runtime:${sessionId}`,
          actor: { type: "host", subjectId: `site:${host.site.id}` },
          producerEnabled: sessionUsageLimitsProducerEnabled(deps.settings),
        }),
    );
    if (result.outcome === "ok" || result.outcome === "replayed") return true;
    console.warn("[site-runtime] could not cap a conversation", {
      siteId: host.site.id,
      outcome: result.outcome,
    });
  } catch (error) {
    console.warn("[site-runtime] could not cap a conversation", {
      siteId: host.site.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

/** Usage-only metering for Site runtime events (agent spend is metered by the session itself). */
export async function meterSiteRuntime(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  event: { type: "conversation" | "sign_in" | "report"; viewer?: SiteRuntimeViewer },
): Promise<void> {
  try {
    await withRlsContext(deps.db, host.scope, async (tx) => {
      await recordUsageEvent(tx, {
        accountId: host.scope.accountId,
        workspaceId: host.scope.workspaceId,
        subjectId: event.viewer?.subjectId ?? null,
        eventType: `site_runtime.${event.type}`,
        quantity: 1,
        unit: event.type,
        sourceResourceType: "site",
        sourceResourceId: host.site.id,
        idempotencyKey: `site_runtime.${event.type}:${crypto.randomUUID()}`,
      });
    });
  } catch (error) {
    console.warn("[site-runtime] could not meter usage", {
      siteId: host.site.id,
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// --- in-process dispatch ------------------------------------------------------------

/**
 * Run an ordinary session route in this process as the Site's service
 * principal (`site:<siteId>`), with a 60-second delegated token carrying only
 * session permissions and the viewer as its display label. The Site and the
 * served version ride along as the request's Site origin, so new sessions and
 * turns record where they came from. The route authorizes as usual.
 */
export async function siteRuntimeSessionRequest(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost & { versionId: string },
  viewer: SiteRuntimeViewer,
  input: { origin: string; method: string; path: string; body?: unknown },
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
    accountId: host.scope.accountId,
    workspaceId: host.scope.workspaceId,
    subjectId: `site:${host.site.id}`,
    subjectLabel: `${siteRuntimeViewerLabel(viewer)} on ${host.hostname}`.slice(0, 250),
    permissions: [...SITE_RUNTIME_AGENT_PERMISSIONS],
    principalKind: "service",
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    accept: "application/json",
    [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    "x-opengeni-site-id": host.site.id,
    "x-opengeni-site-version": host.versionId,
  });
  if (input.body !== undefined) headers.set("content-type", "application/json");
  return new Request(new URL(input.path, input.origin), {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

/** A forwarded response without cookies (site-runtime never sets any). */
export function siteRuntimeForwardedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
