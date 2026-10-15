// Reader from 2fef1581b:apps/api/src/site-publishing/limits.ts.
// The switch and final dereferences are retained verbatim; its input type is
// kept separate from the current union so it cannot silently gain standard.
// Restore the old required setting defaults (now deprecated/optional) below.
import { SiteLimits, UNLIMITED_SITE_FLOOD_BRAKES } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";

type LegacyLimits = {
  requestsPerMinutePerVisitor: number | null;
  guestWritesPerMinute: number | null;
  agentsEnabled: boolean;
  guestAgentsEnabled: boolean;
  conversationsPerVisitorPerDay: number | null;
  conversationsPerSitePerDay: number | null;
  turnsPerConversation: number | null;
  agentMicrosPerConversation: number | null;
  agentMicrosPerVisitorPerDay: number | null;
  agentMicrosPerSitePerMonth: number | null;
  agentModels: string[] | null;
};
function freeSiteLimits(settings: Settings): LegacyLimits {
  return {
    requestsPerMinutePerVisitor: settings.sitesFreeRequestsPerMinutePerVisitor,
    guestWritesPerMinute: settings.sitesFreeGuestWritesPerMinute,
    agentsEnabled: true,
    guestAgentsEnabled: true,
    conversationsPerVisitorPerDay: settings.sitesFreeConversationsPerVisitorPerDay ?? 10,
    conversationsPerSitePerDay: settings.sitesFreeConversationsPerSitePerDay ?? 50,
    turnsPerConversation: settings.sitesFreeTurnsPerConversation ?? 20,
    agentMicrosPerConversation: settings.sitesFreeAgentMicrosPerConversation ?? 20_000,
    agentMicrosPerVisitorPerDay: settings.sitesFreeAgentMicrosPerVisitorPerDay ?? 200_000,
    agentMicrosPerSitePerMonth: settings.sitesFreeAgentMicrosPerSitePerMonth ?? 2_000_000,
    agentModels: null,
  };
}
const times = (value: number | null, factor: number) => (value === null ? null : value * factor);
const braked = (value: number | null, brake: number) => value === null ? brake : Math.min(value, brake);
function siteLimitOverrides(overrides: Record<string, unknown> | null) {
  if (!overrides) return {};
  const parsed = SiteLimits.partial().safeParse(overrides);
  if (parsed.success) return parsed.data;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const one = SiteLimits.partial().safeParse({ [key]: value });
    if (one.success) Object.assign(kept, one.data);
  }
  return kept;
}

export function previousReleaseSiteLimitsForProfile(
  settings: Settings,
  profile: { kind: string | null; overrides: Record<string, unknown> | null },
) {
  const free = freeSiteLimits(settings);
  let limits!: ReturnType<typeof freeSiteLimits>;
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
      limits = { ...free, ...siteLimitOverrides(profile.overrides) } as typeof free;
      break;
  }
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
