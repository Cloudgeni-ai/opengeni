import {
  DEFAULT_FREE_SITE_LIMITS,
  SITE_HOSTNAME_PROBLEM_MESSAGES,
  UNLIMITED_SITE_FLOOD_BRAKES,
  siteHostnameLabelProblem,
  suggestSiteHostnameLabel,
  type SiteAccessMode,
  type SiteHostnameAvailability,
  type SiteLimitProfileKind,
  type SiteLimits,
  type SitePublication,
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

export const LIMIT_PROFILE_OPTIONS: readonly { value: SiteLimitProfileKind; label: string }[] = [
  { value: "free", label: "Free" },
  { value: "credits", label: "Credits" },
  { value: "unlimited", label: "Unlimited" },
  { value: "custom", label: "Custom" },
];

export function limitProfileDescription(kind: SiteLimitProfileKind): string {
  switch (kind) {
    case "free":
      return "Strict limits that keep a busy Site cheap.";
    case "credits":
      return "Larger limits, paid from your organization's credits.";
    case "unlimited":
      return "No spending caps. Flood protection and a cap per conversation still apply.";
    case "custom":
      return "Your own limits. Leave a field empty for no limit.";
  }
}

/** The limits the page can say for sure for a profile; null when only the server knows. */
export function knownLimits(
  kind: SiteLimitProfileKind,
  saved: SitePublication | null,
  overrides: Partial<SiteLimits>,
): SiteLimits | null {
  if (saved && saved.limitProfile.kind === kind && kind !== "custom") return saved.effectiveLimits;
  if (kind === "free") return { ...DEFAULT_FREE_SITE_LIMITS };
  if (kind === "custom") return { ...DEFAULT_FREE_SITE_LIMITS, ...overrides };
  if (kind === "unlimited")
    return {
      ...DEFAULT_FREE_SITE_LIMITS,
      requestsPerMinutePerVisitor: UNLIMITED_SITE_FLOOD_BRAKES.requestsPerMinutePerVisitor,
      guestWritesPerMinute: null,
      conversationsPerVisitorPerDay: null,
      conversationsPerSitePerDay: UNLIMITED_SITE_FLOOD_BRAKES.conversationsPerSitePerDay,
      turnsPerConversation: null,
      agentMicrosPerConversation: UNLIMITED_SITE_FLOOD_BRAKES.agentMicrosPerConversation,
      agentMicrosPerVisitorPerDay: null,
      agentMicrosPerSitePerMonth: null,
    };
  return null;
}

export function formatUsdMicros(micros: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2,
  }).format(micros / 1_000_000);
}

/** The few numbers that decide what a Site can cost, in words. */
export function limitSummary(limits: SiteLimits): { label: string; value: string }[] {
  const count = (value: number | null, unit: string) =>
    value === null ? "No limit" : `${value.toLocaleString("en-US")} ${unit}`;
  const money = (value: number | null, unit: string) =>
    value === null ? "No limit" : `${formatUsdMicros(value)} ${unit}`;
  return [
    {
      label: "Conversations",
      value: count(limits.conversationsPerVisitorPerDay, "per visitor a day"),
    },
    { label: "Messages", value: count(limits.turnsPerConversation, "per conversation") },
    {
      label: "Agent spend",
      value: [
        money(limits.agentMicrosPerConversation, "per conversation"),
        money(limits.agentMicrosPerVisitorPerDay, "per visitor a day"),
        money(limits.agentMicrosPerSitePerMonth, "per month"),
      ].join(", "),
    },
  ];
}

/** Custom-profile fields people edit, money in dollars. */
export const CUSTOM_LIMIT_FIELDS: readonly {
  key: keyof Pick<
    SiteLimits,
    | "conversationsPerVisitorPerDay"
    | "conversationsPerSitePerDay"
    | "turnsPerConversation"
    | "agentMicrosPerConversation"
    | "agentMicrosPerVisitorPerDay"
    | "agentMicrosPerSitePerMonth"
  >;
  label: string;
  money: boolean;
}[] = [
  { key: "conversationsPerVisitorPerDay", label: "Conversations per visitor a day", money: false },
  { key: "conversationsPerSitePerDay", label: "Conversations per day (whole Site)", money: false },
  { key: "turnsPerConversation", label: "Messages per conversation", money: false },
  { key: "agentMicrosPerConversation", label: "Spend per conversation", money: true },
  { key: "agentMicrosPerVisitorPerDay", label: "Spend per visitor a day", money: true },
  { key: "agentMicrosPerSitePerMonth", label: "Spend per month", money: true },
];

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

export type SitePublishDraft = {
  label: string;
  access: SiteAccessMode;
  invitedEmails: string[];
  agentEnabled: boolean;
  /** null uses the workspace default model. */
  agentModel: string | null;
  profile: SiteLimitProfileKind;
  /** Custom fields as typed. */
  custom: Record<(typeof CUSTOM_LIMIT_FIELDS)[number]["key"], string>;
  noindex: boolean;
};

export function draftFromPublication(
  publication: SitePublication | null,
  fallbackLabel: string,
  forceNoindex = false,
): SitePublishDraft {
  const overrides = publication?.limitProfile.overrides ?? {};
  const base = { ...DEFAULT_FREE_SITE_LIMITS, ...overrides };
  return {
    label: publication?.label ?? fallbackLabel,
    access: publication?.access ?? "members",
    invitedEmails: publication?.invitedEmails ?? [],
    agentEnabled: publication?.agent.enabled ?? false,
    agentModel: publication?.agent.model ?? null,
    profile: publication?.limitProfile.kind ?? "free",
    custom: Object.fromEntries(
      CUSTOM_LIMIT_FIELDS.map((field) => [field.key, limitFieldText(base[field.key], field.money)]),
    ) as SitePublishDraft["custom"],
    noindex: forceNoindex || (publication?.noindex ?? true),
  };
}

/** Custom overrides from the typed fields, or the name of the first field that isn't a number. */
export function customOverrides(
  draft: SitePublishDraft,
): { overrides: Partial<SiteLimits> } | { invalid: string } {
  const overrides: Partial<SiteLimits> = {};
  for (const field of CUSTOM_LIMIT_FIELDS) {
    const value = parseLimitField(draft.custom[field.key], field.money);
    if (value === undefined) return { invalid: field.key };
    overrides[field.key] = value;
  }
  return { overrides };
}

/**
 * The PUT body for a draft: the fields that differ from the saved
 * publication (every field on a first publish), plus `status: "active"`
 * when publishing.
 */
export function publicationRequest(
  draft: SitePublishDraft,
  saved: SitePublication | null,
  options: { publish: boolean },
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
  const custom = draft.profile === "custom" ? customOverrides(draft) : null;
  const overrides = custom && "overrides" in custom ? custom.overrides : null;
  if (
    !saved ||
    saved.limitProfile.kind !== draft.profile ||
    (draft.profile === "custom" &&
      JSON.stringify(saved.limitProfile.overrides ?? {}) !== JSON.stringify(overrides ?? {}))
  )
    request.limitProfile = { kind: draft.profile, overrides };
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
