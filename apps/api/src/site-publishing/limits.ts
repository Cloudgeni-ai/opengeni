import {
  SiteLimits,
  UNLIMITED_SITE_FLOOD_BRAKES,
  type SiteLimitProfile,
  type SiteLimits as SiteLimitsValue,
} from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import type { StoredSiteLimitProfile } from "@opengeni/db";

/**
 * Limit profiles for published Sites. Opengeni enforces these values (the
 * edge only brakes floods). Effective limits come from the Site's own profile,
 * else the workspace default, else the free profile from settings; every
 * profile keeps the flood brakes, and deployment switches (public agents)
 * apply last.
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
  | "sitesCreditsLimitMultiplier"
  | "sitesPublicAgentsEnabled"
>;

export function freeSiteLimits(settings: SiteLimitSettings): SiteLimitsValue {
  return {
    requestsPerMinutePerVisitor: settings.sitesFreeRequestsPerMinutePerVisitor,
    guestWritesPerMinute: settings.sitesFreeGuestWritesPerMinute,
    agentsEnabled: true,
    guestAgentsEnabled: true,
    conversationsPerVisitorPerDay: settings.sitesFreeConversationsPerVisitorPerDay,
    conversationsPerSitePerDay: settings.sitesFreeConversationsPerSitePerDay,
    turnsPerConversation: settings.sitesFreeTurnsPerConversation,
    agentMicrosPerConversation: settings.sitesFreeAgentMicrosPerConversation,
    agentMicrosPerVisitorPerDay: settings.sitesFreeAgentMicrosPerVisitorPerDay,
    agentMicrosPerSitePerMonth: settings.sitesFreeAgentMicrosPerSitePerMonth,
    agentModels: null,
  };
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

/** The limits of one profile, before deployment switches. */
export function siteLimitsForProfile(
  settings: SiteLimitSettings,
  profile: StoredSiteLimitProfile | SiteLimitProfile,
): SiteLimitsValue {
  const free = freeSiteLimits(settings);
  let limits: SiteLimitsValue;
  switch (profile.kind) {
    case "free":
      limits = free;
      break;
    case "credits": {
      const factor = settings.sitesCreditsLimitMultiplier;
      limits = {
        ...free,
        conversationsPerVisitorPerDay: times(free.conversationsPerVisitorPerDay, factor),
        conversationsPerSitePerDay: times(free.conversationsPerSitePerDay, factor),
        agentMicrosPerConversation: times(free.agentMicrosPerConversation, factor),
        agentMicrosPerVisitorPerDay: times(free.agentMicrosPerVisitorPerDay, factor),
        agentMicrosPerSitePerMonth: times(free.agentMicrosPerSitePerMonth, factor),
      };
      break;
    }
    case "unlimited":
      limits = {
        ...free,
        conversationsPerVisitorPerDay: null,
        conversationsPerSitePerDay: UNLIMITED_SITE_FLOOD_BRAKES.conversationsPerSitePerDay,
        turnsPerConversation: null,
        agentMicrosPerVisitorPerDay: null,
        agentMicrosPerSitePerMonth: null,
        requestsPerMinutePerVisitor: UNLIMITED_SITE_FLOOD_BRAKES.requestsPerMinutePerVisitor,
        agentMicrosPerConversation: UNLIMITED_SITE_FLOOD_BRAKES.agentMicrosPerConversation,
      };
      break;
    case "custom":
      limits = { ...free, ...siteLimitOverrides(profile.overrides) };
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

/** The profile in force: the Site's own, else the workspace default, else free. */
export function sourceSiteLimitProfile(
  siteProfile: StoredSiteLimitProfile | null,
  workspaceProfile: StoredSiteLimitProfile | null,
): SiteLimitProfile {
  const profile = siteProfile ?? workspaceProfile ?? { kind: "free", overrides: null };
  return {
    kind: profile.kind,
    overrides: profile.kind === "custom" ? siteLimitOverrides(profile.overrides) : null,
  };
}

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
