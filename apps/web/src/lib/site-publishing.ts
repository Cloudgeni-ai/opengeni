import {
  DEFAULT_SITE_LIMITS,
  SITE_HOSTNAME_PROBLEM_MESSAGES,
  SITE_PLATFORM_BRAKE_ERROR_CODE,
  SITE_PLATFORM_QUOTA_ERROR_CODE,
  siteHostnameLabelProblem,
  suggestSiteHostnameLabel,
  type SiteAccessMode,
  type SiteHostnameAvailability,
  type SiteLimits,
  type SitePlatformMeter,
  type SitePublication,
  type SitePublishWarning,
  type UpsertSitePublicationRequest,
} from "@opengeni/contracts";

import { apiErrorFacts } from "@/lib/api-error";

/* ----------------------------------------------------------------------------
   Publishing a Site to the web: the pure parts of the Publish page. The API
   decides availability, access and limits; these helpers only shape what the
   page shows and what it sends.
   -------------------------------------------------------------------------- */

/**
 * Optional deployment facts about Sites publishing on the client config.
 * Older APIs omit them; the page then learns the domain from the API's
 * hostname answers and leaves the choices open for the server to refuse.
 */
export type SitesClientConfig = {
  domain?: string | null;
  publicEnabled?: boolean;
  publicAgentsEnabled?: boolean;
  loginOnly?: boolean;
  forceNoindex?: boolean;
};

export function sitesClientConfig(config: unknown): SitesClientConfig {
  const sites =
    config && typeof config === "object" ? (config as { sites?: unknown }).sites : undefined;
  return sites && typeof sites === "object" ? (sites as SitesClientConfig) : {};
}

/** Where a publication stands, from the API's answer. */
export type SitePublicationLoad =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "forbidden" }
  | { state: "none" }
  | { state: "error"; error: unknown }
  | { state: "ready"; publication: SitePublication };

export function sitePublicationLoadFromError(error: unknown): SitePublicationLoad {
  const { status, code } = apiErrorFacts(error);
  if (code === "sites_publishing_disabled" || status === 503) return { state: "unavailable" };
  if (status === 404) return { state: "none" };
  if (status === 403) return { state: "forbidden" };
  return { state: "error", error };
}

/** A random four-character suffix for a suggested label. */
export function randomLabelSuffix(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function suggestedLabel(title: string, suffix = randomLabelSuffix()): string {
  return suggestSiteHostnameLabel(title, suffix);
}

/** Lowercase and trim what someone types, so the check matches what is saved. */
export function normalizeLabelInput(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "-");
}

/** The label's own problem in words, before asking the API. */
export function labelProblemMessage(label: string): string | null {
  const problem = siteHostnameLabelProblem(label);
  return problem ? SITE_HOSTNAME_PROBLEM_MESSAGES[problem] : null;
}

/** What the API said about a label, in words. */
export function availabilityMessage(availability: SiteHostnameAvailability): string | null {
  if (availability.available) return null;
  if (availability.message) return availability.message;
  switch (availability.problem) {
    case "taken":
      return "Another Site uses this name.";
    case "held":
      return "This name was released recently and is held for its workspace.";
    case null:
      return "This name can't be used.";
    default:
      return SITE_HOSTNAME_PROBLEM_MESSAGES[availability.problem];
  }
}

/** The Sites domain from any hostname the API returned for a label. */
export function domainFromHostname(hostname: string | null | undefined, label: string) {
  if (!hostname || !hostname.startsWith(`${label}.`)) return null;
  return hostname.slice(label.length + 1) || null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
export function invitedEmailProblem(email: string): string | undefined {
  return EMAIL.test(email) ? undefined : "Not an email address";
}

export const ACCESS_CHOICES: readonly {
  value: SiteAccessMode;
  title: string;
  description: (facts: { workspaceName: string; loginOnly: boolean }) => string;
}[] = [
  {
    value: "members",
    title: "Workspace members",
    description: ({ workspaceName }) => `People in ${workspaceName}, after they sign in.`,
  },
  {
    value: "invited",
    title: "Invited people",
    description: () => "Members and the people you add here. They sign in with their email.",
  },
  {
    value: "public",
    title: "Anyone with the link",
    description: ({ loginOnly }) =>
      loginOnly
        ? "Anyone signed in to Opengeni. This server requires sign-in for every Site."
        : "No sign-in needed. Visitors who don't sign in are guests.",
  },
];

export function formatUsdMicros(micros: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2,
  }).format(micros / 1_000_000);
}

export function limitFieldText(value: number | null | undefined, money: boolean): string {
  if (value === null || value === undefined) return "";
  return money ? String(value / 1_000_000) : String(value);
}

/** A field's text as a limit: null for empty, undefined for something that isn't a number. */
export function parseLimitField(text: string, money: boolean): number | null | undefined {
  const trimmed = text.trim().replace(/^\$/u, "");
  if (!trimmed) return null;
  if (!/^\d+(?:\.\d+)?$/u.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  if (money) return Math.round(value * 1_000_000);
  return Number.isInteger(value) ? value : undefined;
}

/** "Limit: [$10] per [month]" and "[amount] per [day]": the two spend periods a limit can use. */
export type SpendPeriod = "day" | "month";

export const SPEND_PERIOD_OPTIONS: readonly { value: SpendPeriod; label: string }[] = [
  { value: "day", label: "day" },
  { value: "month", label: "month" },
];

/** Invited and public Sites have people outside the workspace; members-only Sites don't. */
export function hasOutsideViewers(access: SiteAccessMode): boolean {
  return access !== "members";
}

export type SitePublishDraft = {
  label: string;
  access: SiteAccessMode;
  invitedEmails: string[];
  agentEnabled: boolean;
  /** null uses the workspace default model. */
  agentModel: string | null;
  /** "Agent for people outside the workspace" (members always keep the agent). */
  outsideAgent: boolean;
  /** The Site limit for everyone outside the workspace together, dollars as typed. */
  siteLimit: string;
  sitePeriod: SpendPeriod;
  /** The optional limit for each person or visitor outside the workspace. */
  personLimitOn: boolean;
  personLimit: string;
  personPeriod: SpendPeriod;
  noindex: boolean;
};

/** The spend limits a Site applies to people outside the workspace. */
export type OutsideSpendLimits = Pick<
  SiteLimits,
  | "agentsEnabled"
  | "agentMicrosPerSitePerMonth"
  | "agentMicrosPerSitePerDay"
  | "agentMicrosPerVisitorPerDay"
  | "agentMicrosPerVisitorPerMonth"
>;

function outsideSpendLimits(limits: SiteLimits): OutsideSpendLimits {
  return {
    agentsEnabled: limits.agentsEnabled,
    agentMicrosPerSitePerMonth: limits.agentMicrosPerSitePerMonth,
    agentMicrosPerSitePerDay: limits.agentMicrosPerSitePerDay,
    agentMicrosPerVisitorPerDay: limits.agentMicrosPerVisitorPerDay,
    agentMicrosPerVisitorPerMonth: limits.agentMicrosPerVisitorPerMonth,
  };
}

/** The Site limit's period and amount: per day only when that is the one set. */
export function siteSpendLimit(limits: OutsideSpendLimits): {
  period: SpendPeriod;
  micros: number | null;
} {
  if (limits.agentMicrosPerSitePerMonth === null && limits.agentMicrosPerSitePerDay !== null)
    return { period: "day", micros: limits.agentMicrosPerSitePerDay };
  return { period: "month", micros: limits.agentMicrosPerSitePerMonth };
}

/** The per-person limit's period and amount, or null when it is off. */
export function personSpendLimit(
  limits: OutsideSpendLimits,
): { period: SpendPeriod; micros: number } | null {
  if (limits.agentMicrosPerVisitorPerDay !== null)
    return { period: "day", micros: limits.agentMicrosPerVisitorPerDay };
  if (limits.agentMicrosPerVisitorPerMonth !== null)
    return { period: "month", micros: limits.agentMicrosPerVisitorPerMonth };
  return null;
}

export function draftFromPublication(
  publication: SitePublication | null,
  fallbackLabel: string,
  forceNoindex = false,
): SitePublishDraft {
  const limits = outsideSpendLimits(publication?.effectiveLimits ?? DEFAULT_SITE_LIMITS);
  const site = siteSpendLimit(limits);
  const person = personSpendLimit(limits);
  return {
    label: publication?.label ?? fallbackLabel,
    access: publication?.access ?? "members",
    invitedEmails: publication?.invitedEmails ?? [],
    agentEnabled: publication?.agent.enabled ?? false,
    agentModel: publication?.agent.model ?? null,
    outsideAgent: limits.agentsEnabled,
    siteLimit: limitFieldText(site.micros, true),
    sitePeriod: site.period,
    personLimitOn: person !== null,
    personLimit: limitFieldText(person?.micros ?? null, true),
    personPeriod: person?.period ?? "day",
    noindex: forceNoindex || (publication?.noindex ?? true),
  };
}

/**
 * The outside spend limits from the typed fields, or which field isn't a
 * dollar amount. An empty Site limit means no Site limit.
 */
export function outsideLimitsFromDraft(
  draft: SitePublishDraft,
): { limits: OutsideSpendLimits } | { invalid: "siteLimit" | "personLimit" } {
  const site = parseLimitField(draft.siteLimit, true);
  if (site === undefined) return { invalid: "siteLimit" };
  const person = draft.personLimitOn ? parseLimitField(draft.personLimit, true) : null;
  if (person === undefined) return { invalid: "personLimit" };
  return {
    limits: {
      agentsEnabled: draft.outsideAgent,
      agentMicrosPerSitePerMonth: draft.sitePeriod === "month" ? site : null,
      agentMicrosPerSitePerDay: draft.sitePeriod === "day" ? site : null,
      agentMicrosPerVisitorPerDay: draft.personPeriod === "day" ? person : null,
      agentMicrosPerVisitorPerMonth: draft.personPeriod === "month" ? person : null,
    },
  };
}

/** "$1.20 of $10 used this month": the Site's outside spend in its limit's period. */
export function outsideUsageLine(publication: SitePublication): string {
  const site = siteSpendLimit(outsideSpendLimits(publication.effectiveLimits));
  const used =
    site.period === "day"
      ? publication.usage.agentMicrosToday
      : publication.usage.agentMicrosThisMonth;
  const when = site.period === "day" ? "today" : "this month";
  return site.micros === null
    ? `${formatLimitAmount(used)} used ${when}`
    : `${formatLimitAmount(used)} of ${formatLimitAmount(site.micros)} used ${when}`;
}

/** "$10" for whole dollars, "$1.20" otherwise (credits are dollar amounts). */
export function formatLimitAmount(micros: number): string {
  return Number.isInteger(micros / 1_000_000)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(micros / 1_000_000)
    : formatUsdMicros(micros);
}

/**
 * The PUT body for a draft: the fields that differ from the saved
 * publication (every field on a first publish), plus `status: "active"`
 * when publishing. Changed outside spend limits are saved as overrides on the
 * Site's profile, keeping its kind and any other overrides.
 */
export function publicationRequest(
  draft: SitePublishDraft,
  saved: SitePublication | null,
  options: { publish: boolean; canChangeLimits?: boolean },
): UpsertSitePublicationRequest {
  const request: UpsertSitePublicationRequest = {};
  if (!saved || saved.label !== draft.label) request.label = draft.label;
  if (!saved || saved.access !== draft.access) request.access = draft.access;
  const emails = draft.access === "invited" ? draft.invitedEmails : (saved?.invitedEmails ?? []);
  if (!saved ? emails.length > 0 : !sameList(saved.invitedEmails, emails))
    request.invitedEmails = emails;
  if (
    !saved ||
    saved.agent.enabled !== draft.agentEnabled ||
    (draft.agentEnabled && saved.agent.model !== draft.agentModel)
  )
    request.agent = {
      enabled: draft.agentEnabled,
      ...(draft.agentEnabled ? { model: draft.agentModel } : {}),
    };
  // Only workspace admins change limits; everyone else keeps the current ones.
  const outside = outsideLimitsFromDraft(draft);
  if (options.canChangeLimits !== false && hasOutsideViewers(draft.access) && "limits" in outside) {
    const current = outsideSpendLimits(saved?.effectiveLimits ?? DEFAULT_SITE_LIMITS);
    const changed = (Object.keys(outside.limits) as (keyof OutsideSpendLimits)[]).some(
      (key) => outside.limits[key] !== current[key],
    );
    if (changed)
      request.limitProfile = {
        kind: saved?.limitProfile.kind ?? "standard",
        overrides: { ...(saved?.limitProfile.overrides ?? {}), ...outside.limits },
      };
  }
  if (!saved || saved.noindex !== draft.noindex) request.noindex = draft.noindex;
  if (options.publish && saved?.status !== "active") request.status = "active";
  return request;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function abuseCategoryLabel(category: string): string {
  switch (category) {
    case "phishing":
      return "Phishing";
    case "malware":
      return "Malware";
    case "spam":
      return "Spam";
    case "illegal":
      return "Illegal content";
    case "harassment":
      return "Harassment";
    case "copyright":
      return "Copyright";
    default:
      return "Other";
  }
}

export function suspendedByLabel(by: SitePublication["moderation"]["suspendedBy"]): string {
  switch (by) {
    case "platform":
      return "Opengeni";
    case "admin":
      return "a workspace admin";
    default:
      return "its owner";
  }
}

/** Free text as one sentence: trimmed and ending with punctuation. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The specific error code (`details.code`) of an API error, else its code. */
export function siteErrorCode(error: unknown): string | undefined {
  const details = (error as { details?: { code?: unknown } } | null)?.details;
  return typeof details?.code === "string" ? details.code : apiErrorFacts(error).code;
}

/** "2 things won't work for public visitors". */
export function readinessTitle(
  warnings: readonly SitePublishWarning[],
  access: SiteAccessMode,
): string {
  const count = warnings.length;
  const who = access === "public" ? "public visitors" : "invited people";
  return `${count} ${count === 1 ? "thing" : "things"} won't work for ${who}`;
}

/** The published Site opened as the role its visitors have ("View as visitor"). */
export function viewAsVisitorUrl(publication: Pick<SitePublication, "url" | "access">) {
  if (publication.access === "members") return null;
  const url = new URL(publication.url);
  url.searchParams.set("og_view_as", publication.access === "public" ? "public" : "invited");
  return url.toString();
}

/** A platform refusal (Opengeni-wide brake or the workspace's allowance), in words. */
export function platformRefusal(error: unknown): { title: string; body: string } | null {
  const code = siteErrorCode(error);
  if (code === SITE_PLATFORM_QUOTA_ERROR_CODE)
    return {
      title: "Sites allowance used up",
      body: "This workspace has used this month's Sites allowance and has no credits left. Add credits to publish again.",
    };
  if (code === SITE_PLATFORM_BRAKE_ERROR_CODE)
    return {
      title: "Publishing is paused",
      body: "Opengeni paused publishing while it reviews unusual Site usage. Try again later.",
    };
  return null;
}

export const PLATFORM_METER_LABELS: Record<SitePlatformMeter, string> = {
  requests: "Requests",
  sql_rows_read: "Rows read",
  sql_rows_written: "Rows written",
  storage_bytes: "Storage",
};

/** "1.2M", "640K", "980" for counts; "1.4 GB" for storage (GB = 10^9 bytes). */
export function formatPlatformAmount(meter: SitePlatformMeter, value: number): string {
  if (meter === "storage_bytes") {
    const units = ["B", "kB", "MB", "GB", "TB"];
    let amount = value;
    let unit = 0;
    while (amount >= 1000 && unit < units.length - 1) {
      amount /= 1000;
      unit += 1;
    }
    return `${unit === 0 ? amount : Number(amount.toFixed(amount < 10 ? 1 : 0))} ${units[unit]}`;
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
