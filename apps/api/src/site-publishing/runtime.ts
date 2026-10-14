import { createHash } from "node:crypto";
import { parseSiteHostname, siteHostname, type SiteLimits } from "@opengeni/contracts";
import { sessionUsageLimitsProducerEnabled, type ApiRouteDeps } from "@opengeni/core";
import {
  consumeSiteRuntimeRate,
  findSiteHostname,
  findSiteViewerSession,
  getPublishedSite,
  getSession,
  getSitePublication,
  isSiteWorkspaceMember,
  listReservedSiteRuntimeConversations,
  readSessionUsageLimit,
  recordUsageEvent,
  releaseSiteRuntimeConversationStart,
  settleSiteRuntimeConversationSpend,
  withRlsContext,
  type PublishedSiteRecord,
  type SitePublicationRecord,
  type SitePublishingScope,
  type SiteRuntimeBudget,
  type SiteRuntimeBudgetLimits,
  type SiteRuntimeConversationRecord,
  type SiteRuntimeRateBucket,
  type SiteRuntimeReservation,
} from "@opengeni/db";
import type { SiteGatewayFields } from "./gateway-signature";
import { effectiveSiteLimits } from "./limits";
import {
  siteLimitInputs,
  sitePublishingError,
  siteServable,
  siteServiceSessionRequest,
  SITE_RUNTIME_AGENT_PERMISSIONS,
} from "./service";
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
  // parseSiteHostname lowercases and drops a port and one trailing dot.
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
  const profiles = await siteLimitInputs(deps, host.scope, host.publication);
  return effectiveSiteLimits(deps.settings, profiles.site, profiles.workspace);
}

/** A guest's client address may carry this many visitors' worth of traffic. */
export const SITE_GUEST_IP_LIMIT_FACTOR = 4;

/**
 * A viewer's per-minute bucket. Guests are also counted per signed client
 * address (`ip:<address>`, `SITE_GUEST_IP_LIMIT_FACTOR` times the visitor
 * limit), so minting new visitor ids does not reset their limits; both must
 * pass.
 */
export async function enforceSiteRuntimeViewerRate(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  viewer: SiteRuntimeViewer,
  fields: Pick<SiteGatewayFields, "clientIp">,
  bucket: SiteRuntimeRateBucket,
  limit: number | null,
): Promise<void> {
  await enforceSiteRuntimeRate(deps, host, viewer.principal, bucket, limit);
  if (viewer.kind === "guest" && limit !== null)
    await enforceSiteRuntimeRate(
      deps,
      host,
      siteClientAddressPrincipal(fields),
      bucket,
      limit * SITE_GUEST_IP_LIMIT_FACTOR,
    );
}

/** The rate principal of the signed client address (`ip:unknown` when the gateway sent none). */
export function siteClientAddressPrincipal(fields: Pick<SiteGatewayFields, "clientIp">): string {
  return `ip:${fields.clientIp.trim().slice(0, 64) || "unknown"}`;
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

export { SITE_RUNTIME_AGENT_PERMISSIONS };

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

const BUDGET_MESSAGES: Record<SiteRuntimeBudget, string> = {
  conversations_per_visitor_per_day:
    "You have started as many conversations as this Site allows today",
  conversations_per_site_per_day:
    "This Site's assistant has started as many conversations as it allows today",
  turns_per_conversation: "This conversation has reached its message limit; start a new one",
  agent_micros_per_conversation: "This conversation has reached its budget; start a new one",
  agent_micros_per_visitor_per_day:
    "You have used this Site's assistant as much as it allows today",
  agent_micros_per_site_per_month: "This Site's assistant has reached its budget for this month",
};

/** The 429 for a refused reservation. */
export function siteBudgetExhausted(budget: SiteRuntimeBudget) {
  return budgetExhausted(budget, BUDGET_MESSAGES[budget]);
}

/** The budgets a conversation start or message is reserved against. */
export function siteRuntimeBudgetLimits(limits: SiteLimits): SiteRuntimeBudgetLimits {
  return {
    conversationsPerVisitorPerDay: limits.conversationsPerVisitorPerDay,
    conversationsPerSitePerDay: limits.conversationsPerSitePerDay,
    turnsPerConversation: limits.turnsPerConversation,
    agentMicrosPerConversation: limits.agentMicrosPerConversation,
    agentMicrosPerVisitorPerDay: limits.agentMicrosPerVisitorPerDay,
    agentMicrosPerSitePerMonth: limits.agentMicrosPerSitePerMonth,
  };
}

/** Whether a refusal is a Site-wide budget (stale reservations of others may free it). */
export function siteWideBudget(result: SiteRuntimeReservation): boolean {
  return !result.ok && result.budget === "agent_micros_per_site_per_month";
}

const IDLE_SESSION_STATUSES = new Set(["idle", "failed", "cancelled"]);
/** A start whose session has not appeared after this long failed before its create committed. */
const ABANDONED_START_MS = 10 * 60_000;

/**
 * Bring a conversation's counted spend up to its session usage so far and
 * release what it no longer needs reserved (all of it once the session is
 * idle). A start whose session never appeared is released entirely. A read
 * failure leaves the counters as they are; the session's own usage limit
 * still caps the conversation.
 */
export async function settleSiteRuntimeSpend(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  conversation: Pick<SiteRuntimeConversationRecord, "sessionId" | "turns" | "reservedMicros"> &
    Partial<Pick<SiteRuntimeConversationRecord, "createdAt">>,
): Promise<number | null> {
  const { sessionId } = conversation;
  try {
    const session = await getSession(deps.db, host.scope.workspaceId, sessionId);
    if (session === null) {
      if (
        conversation.createdAt &&
        Date.now() - conversation.createdAt.getTime() > ABANDONED_START_MS
      )
        await releaseSiteRuntimeConversationStart(deps.db, host.scope, { sessionId });
      return null;
    }
    const read = await readSessionUsageLimit(deps.db, {
      ...host.scope,
      sessionId,
      runtime: true,
    });
    const used = read.outcome === "ok" ? read.state.usedMicros : null;
    if (used === null) return null;
    await settleSiteRuntimeConversationSpend(deps.db, host.scope, {
      sessionId,
      usedMicros: used,
      idle: session !== null && IDLE_SESSION_STATUSES.has(session.status),
      expected: { turns: conversation.turns, reservedMicros: conversation.reservedMicros },
    });
    return used;
  } catch (error) {
    console.warn("[site-runtime] could not settle conversation spend", {
      siteId: host.site.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Reservations swept per refusal before one retry. */
const STALE_RESERVATION_SWEEP = 20;

/**
 * Settle the Site's oldest reserved conversations (idle ones release their
 * whole reservation), so a Site-wide budget held by finished conversations
 * frees up. Bounded per call.
 */
export async function sweepSiteRuntimeReservations(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
): Promise<void> {
  for (const conversation of await listReservedSiteRuntimeConversations(deps.db, host.scope, {
    siteId: host.site.id,
    limit: STALE_RESERVATION_SWEEP,
  }))
    await settleSiteRuntimeSpend(deps, host, conversation);
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
  return await siteServiceSessionRequest(
    deps,
    host.scope,
    { id: host.site.id, versionId: host.versionId },
    { ...input, label: `${siteRuntimeViewerLabel(viewer)} on ${host.hostname}` },
  );
}

/** A forwarded response without cookies (site-runtime never sets any). */
export function siteRuntimeForwardedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
