import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  parseSiteHostname,
  siteHostname,
  SITE_NOT_AVAILABLE_FOR_VIEWER_ERROR_CODE,
  type Permission,
  type SiteLimitProfileKind,
  type SiteLimits,
  type SiteViewerCapabilities,
} from "@opengeni/contracts";
import {
  sessionUsageLimitsProducerEnabled,
  stampSiteViewerSessionAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  consumeSiteRuntimeRate,
  findSiteHostname,
  findSiteViewerSession,
  getPublishedSite,
  getSession,
  getSitePublication,
  isSiteWorkspaceMember,
  claimSiteRuntimeReservationSweep,
  readSessionUsageLimit,
  recordUsageEvent,
  releaseSiteRuntimeConversationStart,
  setSessionUsageLimitInTransaction,
  siteRuntimeFundedLimitInTransaction,
  settleSiteRuntimeConversationSpend,
  SITE_RUNTIME_ABANDONED_START_MINUTES,
  SITE_RUNTIME_MEMBERS_PRINCIPAL,
  SITE_RUNTIME_SITE_PRINCIPAL,
  withRlsContext,
  withWorkspaceSessionActivityRls,
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
import { bindSiteSessionRequestAuthority } from "./session-request-authority";
import { effectiveSiteLimits, siteViewerLimits, sourceSiteLimitProfile } from "./limits";
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
 * one Site: the host names it and the viewer is resolved for it. Members retain
 * their human identity; outsiders use the viewer-bound `site:<siteId>` principal.
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
 *
 * "View as visitor": a workspace member whose site-session previews another
 * role is resolved as exactly that role, and only ever downgraded: `public`
 * is an anonymous guest (refused where guests are not admitted), `invited`
 * a signed-in person outside the workspace (refused on members-only Sites).
 * A preview role on the session of anyone who is not a member is ignored, so
 * it can never grant more than the person already has. `ignoreViewAs`
 * resolves the real viewer (to start or end a preview).
 */
export async function resolveSiteRuntimeViewer(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  fields: SiteGatewayFields,
  options: { ignoreViewAs?: boolean } = {},
): Promise<SiteRuntimeViewer> {
  const { scope, publication, site } = host;
  const denied = () =>
    sitePublishingError(
      403,
      "forbidden",
      "site_access_denied",
      "You do not have access to this Site",
    );
  const access = effectiveSiteAccess(publication.access, deps.settings);
  if (fields.session) {
    const session = await findSiteViewerSession(deps.db, scope, {
      siteId: site.id,
      tokenHash: sha256Text(fields.session),
      idleSeconds: deps.settings.sitesViewerSessionIdleSeconds,
    });
    if (session) {
      const member = await isSiteWorkspaceMember(deps.db, scope, session.subjectId);
      const kind = signedInSiteViewerKind({
        access,
        member,
        email: session.email,
        invitedEmails: publication.invitedEmails,
      });
      if (!kind) throw denied();
      const viewAs = !options.ignoreViewAs && kind === "member" ? (session.viewAs ?? null) : null;
      if (viewAs === "public") {
        if (
          !siteGuestsAllowed(publication.access, deps.settings) ||
          !SITE_VISITOR_ID.test(fields.visitor)
        )
          throw denied();
        return {
          kind: "guest",
          principal: `guest:${fields.visitor}`,
          subjectId: null,
          name: null,
          email: null,
          sessionId: null,
          viewAs,
        };
      }
      if (viewAs === "invited") {
        if (access === "members") throw denied();
        return {
          kind: "invited",
          principal: `user:${session.subjectId}`,
          subjectId: session.subjectId,
          name: session.displayName,
          email: session.email,
          sessionId: session.id,
          viewAs,
        };
      }
      return {
        kind,
        principal: `user:${session.subjectId}`,
        subjectId: session.subjectId,
        name: session.displayName,
        email: session.email,
        sessionId: session.id,
        viewAs: null,
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
      viewAs: null,
    };
  throw sitePublishingError(
    401,
    "unauthenticated",
    "site_sign_in_required",
    "Sign in to view this Site",
  );
}

/** What a viewer cannot do on a Site: 403 with `details.code` `not_available_for_viewer`. */
export type SiteViewerFeature =
  | "agent"
  | "private_conversations"
  | "agent_model"
  | "workspace_tools"
  | "site_data"
  | "site_sql";

/**
 * The `details.code` each feature answered before `not_available_for_viewer`,
 * retained as `details.legacyCode` for migration. Clients matching
 * `details.code` must adopt the new code; the alias is not automatic compatibility.
 */
const SITE_VIEWER_FEATURE_LEGACY_CODES: Partial<Record<SiteViewerFeature, string>> = {
  agent: "site_agents_unavailable",
  workspace_tools: "site_tools_unavailable",
  site_data: "forbidden",
  site_sql: "forbidden",
};

export function siteNotAvailableForViewer(
  feature: SiteViewerFeature,
  message: string,
  extra: Record<string, unknown> = {},
) {
  const legacyCode = SITE_VIEWER_FEATURE_LEGACY_CODES[feature];
  return sitePublishingError(403, "forbidden", SITE_NOT_AVAILABLE_FOR_VIEWER_ERROR_CODE, message, {
    ...extra,
    feature,
    ...(legacyCode ? { legacyCode } : {}),
  });
}

/** The viewer capabilities a page reads from `site.config` to hide what won't work. */
export function siteViewerCapabilities(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  viewer: SiteRuntimeViewer,
  limits: SiteLimits,
): SiteViewerCapabilities {
  return {
    agent: siteAgentRefusal(deps, host, viewer, limits) === null,
    // The route intersects this with the immutable page declarations and live grant.
    workspaceTools: viewer.kind === "member",
    siteData: viewer.kind === "guest" ? "guest" : "viewer",
    sqlQueryAudiences: viewer.kind === "guest" ? ["everyone"] : ["everyone", "signed_in"],
    viewAs: viewer.viewAs ?? null,
  };
}

export async function siteRuntimeLimits(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  viewer?: Pick<SiteRuntimeViewer, "kind">,
): Promise<SiteLimits> {
  return (await siteRuntimeLimitProfile(deps, host, viewer)).limits;
}

/**
 * The limits that govern a viewer and the kind of limit profile they come
 * from: workspace members are never limited by Site limits (flood brakes
 * only); everyone else gets the Site's limits (siteViewerLimits). Without a
 * viewer: the Site's limits.
 */
export async function siteRuntimeLimitProfile(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  viewer?: Pick<SiteRuntimeViewer, "kind">,
): Promise<{ limits: SiteLimits; kind: SiteLimitProfileKind }> {
  const profiles = await siteLimitInputs(deps, host.scope, host.publication);
  const limits = effectiveSiteLimits(deps.settings, profiles.site, profiles.workspace);
  return {
    limits: viewer ? siteViewerLimits(limits, viewer.kind) : limits,
    kind: sourceSiteLimitProfile(profiles.site, profiles.workspace).kind,
  };
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

/**
 * The rate principal of the signed client address (`ip:unknown` when the
 * gateway sent none). IPv6 addresses count per /64 (one subscriber usually
 * holds a whole /64, so per-address keys would be free to rotate);
 * IPv4-mapped IPv6 counts as its IPv4 address.
 */
export function siteClientAddressPrincipal(fields: Pick<SiteGatewayFields, "clientIp">): string {
  return `ip:${siteClientAddressKey(fields.clientIp)}`;
}

/** A client address as a rate key: IPv4 as is, IPv6 as its /64 prefix. */
export function siteClientAddressKey(raw: string): string {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/%.*$/u, "");
  if (!value) return "unknown";
  const family = isIP(value);
  if (family !== 6) return value.slice(0, 64);
  const halves = value.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  // An embedded IPv4 tail is two hextets.
  const last = halves.length === 2 ? tail : head;
  const dotted = last.at(-1);
  if (dotted?.includes(".")) {
    const octets = dotted.split(".").map(Number);
    last.splice(
      -1,
      1,
      ((octets[0]! << 8) | octets[1]!).toString(16),
      ((octets[2]! << 8) | octets[3]!).toString(16),
    );
  }
  const zeros = halves.length === 2 ? Math.max(0, 8 - head.length - tail.length) : 0;
  const hextets = [...head, ...Array<string>(zeros).fill("0"), ...tail].map((group) =>
    Number.parseInt(group, 16),
  );
  if (hextets.length !== 8 || hextets.some((hextet) => !Number.isInteger(hextet)))
    return value.slice(0, 64);
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff)
    return [hextets[6]! >> 8, hextets[6]! & 255, hextets[7]! >> 8, hextets[7]! & 255].join(".");
  return `${hextets
    .slice(0, 4)
    .map((hextet) => hextet.toString(16))
    .join(":")}::/64`;
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
  // A conversation of a viewer outside the workspace is capped by its own
  // task usage limit; without the producer that cap cannot be stored, so
  // their Site agents stay off. Members run under the workspace's normal
  // session limits and need no Site cap.
  if (viewer.kind !== "member" && !sessionUsageLimitsProducerEnabled(deps.settings))
    return "usage_limits_disabled";
  if (viewer.kind === "guest" && !limits.guestAgentsEnabled) return "guest_agents_disabled";
  if (viewer.kind === "user" && !deps.settings.sitesPublicAgentsEnabled)
    return "public_agents_disabled";
  return null;
}

const AGENT_REFUSAL_MESSAGES: Record<string, string> = {
  agent_disabled: "This Site's assistant is not available to you",
  usage_limits_disabled: "This Site's assistant is not available to you",
  guest_agents_disabled: "Sign in to use this Site's assistant",
  public_agents_disabled: "This Site's assistant is only available to invited people",
};

export function requireSiteAgent(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  viewer: SiteRuntimeViewer,
  limits: SiteLimits,
): void {
  const reason = siteAgentRefusal(deps, host, viewer, limits);
  if (reason)
    throw siteNotAvailableForViewer(
      "agent",
      AGENT_REFUSAL_MESSAGES[reason] ?? "This Site's assistant is not available to you",
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
  agent_micros_per_visitor_per_month:
    "You have used this Site's assistant as much as it allows this month",
  agent_micros_per_site_per_day: "This Site's assistant has reached its limit for today",
  agent_micros_per_site_per_month: "This Site's assistant has reached its limit for this month",
};

/** The 429 for a refused reservation. */
export function siteBudgetExhausted(budget: SiteRuntimeBudget) {
  return budgetExhausted(budget, BUDGET_MESSAGES[budget]);
}

/** Seconds a viewer waits before retrying a start or message refused as busy. */
export const SITE_BUDGET_BUSY_RETRY_SECONDS = 30;

/**
 * The 429 when only other running conversations' reservations refuse a
 * reservation: the budget has room once their spend settles, so it is worth
 * retrying shortly (`site_budget_busy`, with `retryAfterSeconds`).
 */
export function siteBudgetBusy(budget: SiteRuntimeBudget) {
  return sitePublishingError(
    429,
    "limit_exceeded",
    "site_budget_busy",
    "This Site's assistant is busy right now; try again in a moment",
    { budget, retryAfterSeconds: SITE_BUDGET_BUSY_RETRY_SECONDS },
  );
}

/** The 429 for a refused reservation, busy or exhausted. */
export function siteReservationRefused(result: Extract<SiteRuntimeReservation, { ok: false }>) {
  return result.busy ? siteBudgetBusy(result.budget) : siteBudgetExhausted(result.budget);
}

/**
 * The budgets a conversation start or message is reserved against. Members
 * reserve nothing (their caps are all null). For everyone else a
 * conversation is bounded by the per-conversation cap, else by the smallest
 * spend limit that applies, so a session usage limit always holds it.
 */
export function siteRuntimeBudgetLimits(
  limits: SiteLimits,
  settings: Pick<SiteRuntimeDeps["settings"], "sitesAgentReservationMicrosPerTurn">,
): SiteRuntimeBudgetLimits {
  const spend = [
    limits.agentMicrosPerVisitorPerDay,
    limits.agentMicrosPerVisitorPerMonth,
    limits.agentMicrosPerSitePerDay,
    limits.agentMicrosPerSitePerMonth,
  ].filter((value): value is number => value !== null && value !== undefined);
  return {
    conversationsPerVisitorPerDay: limits.conversationsPerVisitorPerDay,
    conversationsPerSitePerDay: limits.conversationsPerSitePerDay,
    turnsPerConversation: limits.turnsPerConversation,
    agentMicrosPerConversation:
      limits.agentMicrosPerConversation ?? (spend.length > 0 ? Math.min(...spend) : null),
    agentMicrosPerVisitorPerDay: limits.agentMicrosPerVisitorPerDay,
    agentMicrosPerVisitorPerMonth: limits.agentMicrosPerVisitorPerMonth,
    agentMicrosPerSitePerDay: limits.agentMicrosPerSitePerDay,
    agentMicrosPerSitePerMonth: limits.agentMicrosPerSitePerMonth,
    turnReservationMicros: settings.sitesAgentReservationMicrosPerTurn,
  };
}

/**
 * The Site-wide usage windows a viewer's conversations count in: members
 * count apart (`*members`), so they never use up the Site limit.
 */
export function siteRuntimeBudgetKey(viewer: Pick<SiteRuntimeViewer, "kind">): string {
  return viewer.kind === "member" ? SITE_RUNTIME_MEMBERS_PRINCIPAL : SITE_RUNTIME_SITE_PRINCIPAL;
}

/** Whether a refusal is a Site-wide budget (stale reservations of others may free it). */
export function siteWideBudget(result: SiteRuntimeReservation): boolean {
  return (
    !result.ok &&
    (result.budget === "agent_micros_per_site_per_month" ||
      result.budget === "agent_micros_per_site_per_day")
  );
}

const IDLE_SESSION_STATUSES = new Set(["idle", "failed", "cancelled"]);
/** A start whose session has not appeared after this long failed before its create committed. */
const ABANDONED_START_MS = SITE_RUNTIME_ABANDONED_START_MINUTES * 60_000;

/** A conversation's session usage as read while settling. */
export type SiteConversationUsage = {
  usedMicros: number;
  limitMicros: number | null;
  version: number;
};

/**
 * Bring a conversation's counted spend up to its session usage so far and
 * release what it no longer needs reserved (all of it once the session is
 * idle, or when `release` says so). A start whose session never appeared is
 * released entirely. A read failure leaves the counters as they are; the
 * session's own usage limit still caps the conversation.
 */
export async function settleSiteRuntimeSpend(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  conversation: Pick<SiteRuntimeConversationRecord, "sessionId" | "admissions"> &
    Partial<Pick<SiteRuntimeConversationRecord, "createdAt">>,
  options: { release?: boolean } = {},
): Promise<SiteConversationUsage | null> {
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
    if (read.outcome !== "ok" || read.state.usedMicros === null) return null;
    const usage = {
      usedMicros: read.state.usedMicros,
      limitMicros: read.state.limitMicros,
      version: read.state.version,
    };
    await settleSiteRuntimeConversationSpend(deps.db, host.scope, {
      sessionId,
      usedMicros: usage.usedMicros,
      idle: options.release === true || IDLE_SESSION_STATUSES.has(session.status),
      expected: { admissions: conversation.admissions },
    });
    return usage;
  } catch (error) {
    console.warn("[site-runtime] could not settle conversation spend", {
      siteId: host.site.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Lift the session usage limit a Site stamped on a workspace member's
 * conversation before members were kept out of Site limits: cleared only
 * while it is still exactly the Site's cap (`siteCapMicros`), so a limit
 * someone set on the session since is kept. Failure refuses admission; the
 * caller retains its durable normalization marker and retries next time.
 */
export async function liftSiteConversationUsageLimit(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  sessionId: string,
  siteCapMicros: number,
  usage: SiteConversationUsage | null,
): Promise<void> {
  let current = usage;
  if (current === null) {
    const read = await readSessionUsageLimit(deps.db, {
      ...host.scope,
      sessionId,
      runtime: true,
    }).catch(() => null);
    if (read?.outcome !== "ok")
      throw sitePublishingError(
        503,
        "upstream_unavailable",
        "site_conversation_unavailable",
        "The conversation cannot continue right now",
      );
    current = {
      usedMicros: read.state.usedMicros ?? 0,
      limitMicros: read.state.limitMicros,
      version: read.state.version,
    };
  }
  if (current.limitMicros !== siteCapMicros) return;
  const { version } = current;
  const result = await withWorkspaceSessionActivityRls(
    deps.db,
    host.scope.workspaceId,
    async (tx) =>
      await setSessionUsageLimitInTransaction(tx, {
        ...host.scope,
        sessionId,
        limitMicros: null,
        expectedVersion: version,
        operationId: `site-runtime-member-uncap:${sessionId}:${version}`,
        actor: { type: "host", subjectId: `site:${host.site.id}` },
        producerEnabled: sessionUsageLimitsProducerEnabled(deps.settings),
      }),
  ).catch(() => null);
  if (result?.outcome !== "ok" && result?.outcome !== "replayed")
    throw sitePublishingError(
      503,
      "upstream_unavailable",
      "site_conversation_unavailable",
      "The conversation cannot continue right now",
    );
}

/**
 * Stamp only funded execution: cumulative spend plus the current reservation,
 * bounded by the conversation cap. Top-ups reserve atomically before this
 * raises the ceiling; reread under the reservation lock so overlapping
 * admissions cannot stamp a stale larger allowance. Failure refuses work.
 */
export async function capSiteConversationUsageLimit(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
  sessionId: string,
  usage: SiteConversationUsage | null,
): Promise<void> {
  let current = usage;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (current === null) {
      const read = await readSessionUsageLimit(deps.db, {
        ...host.scope,
        sessionId,
        runtime: true,
      }).catch(() => null);
      current =
        read?.outcome === "ok"
          ? {
              usedMicros: read.state.usedMicros ?? 0,
              limitMicros: read.state.limitMicros,
              version: read.state.version,
            }
          : null;
      if (current === null) break;
    }
    const { version } = current;
    const result = await withWorkspaceSessionActivityRls(
      deps.db,
      host.scope.workspaceId,
      async (tx) => {
        const funded = await siteRuntimeFundedLimitInTransaction(tx, host.scope, sessionId);
        if (funded === null) throw new Error("Non-member conversation has no funded ceiling");
        return await setSessionUsageLimitInTransaction(tx, {
          ...host.scope,
          sessionId,
          limitMicros: funded,
          expectedVersion: version,
          operationId: `site-runtime-cap:${sessionId}:${version}:${funded}`,
          actor: { type: "host", subjectId: `site:${host.site.id}` },
          producerEnabled: sessionUsageLimitsProducerEnabled(deps.settings),
        });
      },
    ).catch(() => null);
    if (result?.outcome === "ok" || result?.outcome === "replayed") return;
    current = null;
  }
  throw sitePublishingError(
    503,
    "upstream_unavailable",
    "site_conversation_unavailable",
    "The conversation cannot continue right now",
  );
}

/** Reservations claimed per sweep. */
const STALE_RESERVATION_SWEEP = 20;
/** After a sweep that found nothing, the Site is not swept again for this long (per process). */
const EMPTY_SWEEP_COOLDOWN_MS = 5_000;
const emptySweeps = new Map<string, number>();

/**
 * Release reservations that conversations no longer need, so a Site-wide
 * budget held by finished, abandoned or long-inactive conversations frees
 * up. Claims a bounded batch of likely candidates (idle sessions, starts
 * whose session never appeared, reservations inactive for six hours),
 * least recently visited first and each at most every 30 seconds, and
 * settles each. A sweep that finds nothing pauses sweeping the Site for a
 * few seconds, so refused starts in a burst cost one cheap check at most.
 * Returns whether any reservation was visited.
 */
export async function sweepSiteRuntimeReservations(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost,
): Promise<boolean> {
  const now = Date.now();
  if ((emptySweeps.get(host.site.id) ?? 0) > now - EMPTY_SWEEP_COOLDOWN_MS) return false;
  const candidates = await claimSiteRuntimeReservationSweep(deps.db, host.scope, {
    siteId: host.site.id,
    limit: STALE_RESERVATION_SWEEP,
  });
  if (candidates.length === 0) {
    if (emptySweeps.size > 10_000) emptySweeps.clear();
    emptySweeps.set(host.site.id, now);
    return false;
  }
  emptySweeps.delete(host.site.id);
  for (const candidate of candidates)
    await settleSiteRuntimeSpend(deps, host, candidate, { release: candidate.aged });
  return true;
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
 * Run an ordinary session route in this process as the verified member, or
 * the Site service principal for an outsider. The latter uses a 60-second
 * delegated token plus the separate trusted viewer audience. The Site and the
 * served version ride along as the request's Site origin, so new sessions and
 * turns record where they came from. The route authorizes as usual.
 */
export async function siteRuntimeSessionRequest(
  deps: SiteRuntimeDeps,
  host: SiteRuntimeHost & { versionId: string },
  viewer: SiteRuntimeViewer,
  input: {
    origin: string;
    method: string;
    path: string;
    body?: unknown;
    extraPermissions?: readonly Permission[];
    reauthorize: () => Promise<void>;
  },
): Promise<Request> {
  const request = await siteServiceSessionRequest(
    deps,
    host.scope,
    { id: host.site.id, versionId: host.versionId },
    { ...input, label: `${siteRuntimeViewerLabel(viewer)} on ${host.hostname}` },
  );
  bindSiteSessionRequestAuthority(request, input.reauthorize);
  if (viewer.kind === "member" && viewer.subjectId && viewer.sessionId) {
    // The gateway already verified the host and opaque Site cookie. Native
    // resolution reloads this person's live membership, roles and models.
    // This is delegated ownership, never fabricated managed-cookie proof.
    stampSiteViewerSessionAuthorization(request, {
      organizationId: host.scope.accountId,
      subjectId: viewer.subjectId,
      permissions: [
        ...new Set([...SITE_RUNTIME_AGENT_PERMISSIONS, ...(input.extraPermissions ?? [])]),
      ],
      workspaceId: host.scope.workspaceId,
    });
  }
  return request;
}

/** A forwarded response without cookies (site-runtime never sets any). */
export function siteRuntimeForwardedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
