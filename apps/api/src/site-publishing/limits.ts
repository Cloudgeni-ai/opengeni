import {
  DEFAULT_SITE_LIMITS,
  SiteLimits,
  UNLIMITED_SITE_FLOOD_BRAKES,
  type SiteLimitProfile,
  type SiteLimitProfileKind,
  type SiteLimits as SiteLimitsValue,
} from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import type { StoredSiteLimitProfile } from "@opengeni/db";

/**
 * Limit profiles for published Sites. Opengeni enforces these values (the
 * edge only brakes floods). Limits follow who the viewer is, not the Site's
 * access mode:
 *
 * - Workspace members are never limited by Site limits, on any Site: they
 *   use the workspace's normal session limits and billing. Only the request
 *   flood brake applies.
 * - Everyone outside the workspace (invited people and public visitors,
 *   signed in or anonymous) shares ONE Site limit (per month by default, or
 *   per day), and an optional per-person limit (off by default).
 * - Anonymous guests also meet internal bot guards (conversation and message
 *   counts and a per-conversation cap), configured in settings and not shown
 *   to Site owners.
 *
 * The profile in force is the Site's own, else the workspace default, else
 * `standard`. Every profile keeps the flood brakes, and deployment switches
 * (public agents) apply last.
 */

export type SiteLimitSettings = Pick<
  Settings,
  | "sitesFreeRequestsPerMinutePerVisitor"
  | "sitesFreeGuestWritesPerMinute"
  | "sitesFreeConversationsPerVisitorPerDay"
  | "sitesFreeConversationsPerSitePerDay"
  | "sitesFreeTurnsPerConversation"
  | "sitesFreeAgentMicrosPerConversation"
  | "sitesFreeAgentMicrosPerVisitorPerDay"
  | "sitesFreeAgentMicrosPerSitePerMonth"
  | "sitesAgentMicrosPerSitePerMonth"
  | "sitesAgentMicrosPerPersonPerDay"
  | "sitesGuestConversationsPerVisitorPerDay"
  | "sitesGuestConversationsPerSitePerDay"
  | "sitesGuestTurnsPerConversation"
  | "sitesGuestAgentMicrosPerConversation"
  | "sitesCreditsLimitMultiplier"
  | "sitesPublicAgentsEnabled"
>;

/** The stored kind as the API reports it: the legacy `free` is `standard`. */
export function normalizedSiteLimitProfileKind(kind: SiteLimitProfileKind): SiteLimitProfileKind {
  return kind === "free" ? "standard" : kind;
}

/** The standard limits from settings (the new setting, the deprecated one, the built-in default). */
export function standardSiteLimits(settings: SiteLimitSettings): SiteLimitsValue {
  const pick = (...values: (number | null | undefined)[]) =>
    values.find((value) => value !== undefined && value !== null) ?? null;
  const fallback = DEFAULT_SITE_LIMITS;
  return {
    ...fallback,
    requestsPerMinutePerVisitor: settings.sitesFreeRequestsPerMinutePerVisitor,
    guestWritesPerMinute: settings.sitesFreeGuestWritesPerMinute,
    conversationsPerVisitorPerDay: pick(
      settings.sitesGuestConversationsPerVisitorPerDay,
      settings.sitesFreeConversationsPerVisitorPerDay,
      fallback.conversationsPerVisitorPerDay,
    ),
    conversationsPerSitePerDay: pick(
      settings.sitesGuestConversationsPerSitePerDay,
      settings.sitesFreeConversationsPerSitePerDay,
      fallback.conversationsPerSitePerDay,
    ),
    turnsPerConversation: pick(
      settings.sitesGuestTurnsPerConversation,
      settings.sitesFreeTurnsPerConversation,
      fallback.turnsPerConversation,
    ),
    agentMicrosPerConversation: pick(
      settings.sitesGuestAgentMicrosPerConversation,
      settings.sitesFreeAgentMicrosPerConversation,
      fallback.agentMicrosPerConversation,
    ),
    agentMicrosPerVisitorPerDay: pick(
      settings.sitesAgentMicrosPerPersonPerDay,
      settings.sitesFreeAgentMicrosPerVisitorPerDay,
      fallback.agentMicrosPerVisitorPerDay,
    ),
    agentMicrosPerSitePerMonth: pick(
      settings.sitesAgentMicrosPerSitePerMonth,
      settings.sitesFreeAgentMicrosPerSitePerMonth,
      fallback.agentMicrosPerSitePerMonth,
    ),
  };
}

/** @deprecated The former free profile: the standard limits. */
export function freeSiteLimits(settings: SiteLimitSettings): SiteLimitsValue {
  return standardSiteLimits(settings);
}

const times = (value: number | null, factor: number) => (value === null ? null : value * factor);

/** A cap that never exceeds `brake` (null, no cap, becomes the brake). */
const braked = (value: number | null, brake: number) =>
  value === null ? brake : Math.min(value, brake);

/** Parse stored overrides leniently: unknown or invalid fields are ignored. */
export function siteLimitOverrides(
  overrides: Record<string, unknown> | null | undefined,
): Partial<SiteLimitsValue> {
  if (!overrides) return {};
  const parsed = SiteLimits.partial().safeParse(overrides);
  if (parsed.success) return parsed.data as Partial<SiteLimitsValue>;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const one = SiteLimits.partial().safeParse({ [key]: value });
    if (one.success) Object.assign(kept, one.data);
  }
  return kept as Partial<SiteLimitsValue>;
}

/** The limits one profile gives people outside the workspace, before deployment switches. */
export function siteLimitsForProfile(
  settings: SiteLimitSettings,
  profile: StoredSiteLimitProfile | SiteLimitProfile,
): SiteLimitsValue {
  const standard = standardSiteLimits(settings);
  const overrides = profile.kind === "custom" ? siteLimitOverrides(profile.overrides) : {};
  let limits: SiteLimitsValue;
  switch (profile.kind) {
    case "standard":
    case "free":
      limits = standard;
      break;
    case "credits": {
      const factor = settings.sitesCreditsLimitMultiplier;
      limits = {
        ...standard,
        conversationsPerVisitorPerDay: times(standard.conversationsPerVisitorPerDay, factor),
        conversationsPerSitePerDay: times(standard.conversationsPerSitePerDay, factor),
        agentMicrosPerConversation: times(standard.agentMicrosPerConversation, factor),
        agentMicrosPerVisitorPerDay: times(standard.agentMicrosPerVisitorPerDay, factor),
        agentMicrosPerVisitorPerMonth: times(standard.agentMicrosPerVisitorPerMonth, factor),
        agentMicrosPerSitePerDay: times(standard.agentMicrosPerSitePerDay, factor),
        agentMicrosPerSitePerMonth: times(standard.agentMicrosPerSitePerMonth, factor),
      };
      break;
    }
    case "unlimited":
      limits = {
        ...standard,
        conversationsPerVisitorPerDay: null,
        conversationsPerSitePerDay: UNLIMITED_SITE_FLOOD_BRAKES.conversationsPerSitePerDay,
        turnsPerConversation: null,
        agentMicrosPerVisitorPerDay: null,
        agentMicrosPerVisitorPerMonth: null,
        agentMicrosPerSitePerDay: null,
        agentMicrosPerSitePerMonth: null,
        requestsPerMinutePerVisitor: UNLIMITED_SITE_FLOOD_BRAKES.requestsPerMinutePerVisitor,
        agentMicrosPerConversation: UNLIMITED_SITE_FLOOD_BRAKES.agentMicrosPerConversation,
      };
      break;
    case "custom":
      limits = { ...standard, ...overrides };
      break;
  }
  // Flood brakes hold under every profile.
  return {
    ...limits,
    requestsPerMinutePerVisitor: braked(
      limits.requestsPerMinutePerVisitor,
      UNLIMITED_SITE_FLOOD_BRAKES.requestsPerMinutePerVisitor,
    ),
    conversationsPerSitePerDay: braked(
      limits.conversationsPerSitePerDay,
      UNLIMITED_SITE_FLOOD_BRAKES.conversationsPerSitePerDay,
    ),
    agentMicrosPerConversation: braked(
      limits.agentMicrosPerConversation,
      UNLIMITED_SITE_FLOOD_BRAKES.agentMicrosPerConversation,
    ),
  };
}

/** The profile in force: the Site's own, else the workspace default, else standard. */
export function sourceSiteLimitProfile(
  siteProfile: StoredSiteLimitProfile | null,
  workspaceProfile: StoredSiteLimitProfile | null,
): SiteLimitProfile {
  const profile = siteProfile ?? workspaceProfile ?? { kind: "standard", overrides: null };
  return {
    kind: normalizedSiteLimitProfileKind(profile.kind),
    overrides: profile.kind === "custom" ? siteLimitOverrides(profile.overrides) : null,
  };
}

/**
 * The Site's limits (for people outside the workspace) under the profile in
 * force, deployment switches applied. Viewer-specific limits: siteViewerLimits.
 */
export function effectiveSiteLimits(
  settings: SiteLimitSettings,
  siteProfile: StoredSiteLimitProfile | null,
  workspaceProfile: StoredSiteLimitProfile | null,
): SiteLimitsValue {
  const limits = siteLimitsForProfile(
    settings,
    sourceSiteLimitProfile(siteProfile, workspaceProfile),
  );
  return {
    ...limits,
    guestAgentsEnabled:
      limits.agentsEnabled && limits.guestAgentsEnabled && settings.sitesPublicAgentsEnabled,
  };
}

export type SiteViewerLimitKind = "member" | "invited" | "user" | "guest";

/**
 * The limits that govern one viewer:
 * - members: no Site limits at all (agents on, nothing capped), only the
 *   request flood brake;
 * - signed-in people outside the workspace: the Site limit and the optional
 *   per-person limit, with the flood brakes as their only guards;
 * - anonymous guests: all of the Site's limits, bot guards included.
 */
export function siteViewerLimits(
  limits: SiteLimitsValue,
  viewerKind: SiteViewerLimitKind,
): SiteLimitsValue {
  if (viewerKind === "member")
    return {
      ...limits,
      agentsEnabled: true,
      guestAgentsEnabled: true,
      conversationsPerVisitorPerDay: null,
      conversationsPerSitePerDay: null,
      turnsPerConversation: null,
      agentMicrosPerConversation: null,
      agentMicrosPerVisitorPerDay: null,
      agentMicrosPerVisitorPerMonth: null,
      agentMicrosPerSitePerDay: null,
      agentMicrosPerSitePerMonth: null,
    };
  if (viewerKind === "guest") return limits;
  return {
    ...limits,
    conversationsPerVisitorPerDay: null,
    turnsPerConversation: null,
    conversationsPerSitePerDay: UNLIMITED_SITE_FLOOD_BRAKES.conversationsPerSitePerDay,
    agentMicrosPerConversation: UNLIMITED_SITE_FLOOD_BRAKES.agentMicrosPerConversation,
  };
}

/** The stored form of a requested profile kind: `free` is stored as `standard`. */
export function storedSiteLimitProfileKind(
  kind: SiteLimitProfileKind,
): StoredSiteLimitProfile["kind"] {
  return normalizedSiteLimitProfileKind(kind);
}
