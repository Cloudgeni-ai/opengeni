// One provider-neutral view of a subscription account's plan and usage for
// every surface that lists one (Claude, ChatGPT/Codex, SuperGrok and any
// later provider): the account menu, the model settings rows and the account
// pages. Each provider has one adapter below that names its plans and labels
// the usage windows it reports; everything else is shared.
//
// Windows come only from what the provider reported for that account. Nothing
// here adds a window a plan doesn't have: a verified Claude Ultra account or a
// ChatGPT Pro account reports no 5-hour window, so none is shown.

/** One usage window as a data source reports it. */
export type SubscriptionWindowInput = {
  id: string;
  /** Share used, 0-100; null when unknown. Over 100 can mean extra usage. */
  usedPercent: number | null;
  /** When the window resets: an ISO string or epoch milliseconds. */
  resetsAt: string | number | null;
  /**
   * The provider's own state for the window: `exhausted` (it refused on this
   * limit, whatever the percentage says) or `warning` (it says it is close).
   */
  status?: "ok" | "warning" | "exhausted" | "unknown" | null | undefined;
};

/** One usage window, ready to show. */
export type SubscriptionWindow = {
  id: string;
  /** Short label: "5h", "Week", "Fable week", "Extra usage", "Credits". */
  label: string;
  /** Share left, 0-100; null when unknown or when the reading predates a reset. */
  leftPercent: number | null;
  /** The next reset, epoch milliseconds; null when unknown or already past. */
  resetsAt: number | null;
  limitReached: boolean;
  /** Under 10% left, or the provider says it is close. */
  nearLimit: boolean;
  /** The reading was taken before this window reset, so it no longer says what is left. */
  resetPassed: boolean;
  /** Paid extra usage, not part of the plan's included allowance. */
  extra: boolean;
};

/** Whether the account can take work, from its windows and any refusal. */
export type SubscriptionLimit = {
  reached: boolean;
  /** When the reached limit ends, epoch milliseconds, when known. */
  until: number | null;
  /** Not reached, but an included-usage window is near its limit. */
  near: boolean;
};

type WindowSpec = { label: string; order: number; extra?: boolean };

type SubscriptionAdapter = {
  /** The name plans are sold under: "Claude", "ChatGPT", "SuperGrok". */
  planBrand: string;
  /** The plan's own name without the brand ("Ultra", "Plus"), or null when unknown. */
  planName(plan: string): string | null;
  windows: Record<string, WindowSpec>;
};

/** "claude_team" → "Team", "k12" → "K12": a provider id read as words. */
function words(id: string): string {
  const text = id.replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

const SHARED_WINDOWS: Record<string, WindowSpec> = {
  five_hour: { label: "5h", order: 10 },
  seven_day: { label: "Week", order: 20 },
  overage: { label: "Extra usage", order: 90, extra: true },
  billing: { label: "Credits", order: 30 },
};

// Anthropic sells Pro, Max and Ultra (Max 20x was renamed Ultra on 30 Oct
// 2026). The profile reports both Max tiers as `claude_max`; the stored plan
// carries the tier as `claude_max_5x` or `claude_max_20x` once it is known.
const CLAUDE_PLANS: Record<string, string> = {
  claude_free: "Free",
  claude_pro: "Pro",
  claude_max: "Max or Ultra",
  claude_max_5x: "Max",
  claude_max_20x: "Ultra",
  claude_ultra: "Ultra",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
};

// ChatGPT renamed Team to Business; the id stays `team`.
const CHATGPT_PLANS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Business",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

const ADAPTERS: Record<string, SubscriptionAdapter> = {
  claude: {
    planBrand: "Claude",
    planName: (plan) => CLAUDE_PLANS[plan] ?? words(plan.replace(/^claude_/, "")),
    windows: {
      ...SHARED_WINDOWS,
      seven_day_fable: { label: "Fable week", order: 21 },
      seven_day_opus: { label: "Opus week", order: 22 },
      seven_day_sonnet: { label: "Sonnet week", order: 23 },
      seven_day_overage_included: { label: "Included extra", order: 80, extra: true },
    },
  },
  codex: {
    planBrand: "ChatGPT",
    planName: (plan) => CHATGPT_PLANS[plan.toLowerCase()] ?? words(plan),
    // The shared core stores the 5-hour window as `primary` and the weekly
    // one as `secondary`; both are identified by duration, never position.
    windows: {
      ...SHARED_WINDOWS,
      primary: { label: "5h", order: 10 },
      secondary: { label: "Week", order: 20 },
    },
  },
  xai: {
    planBrand: "SuperGrok",
    // The tier may already carry the product name ("SuperGrok Heavy").
    planName: (plan) => {
      const tier = plan.replace(/^super\s*grok[\s_-]*/i, "").trim();
      return tier ? words(tier) : "";
    },
    windows: SHARED_WINDOWS,
  },
};

/** Any later provider: its own plan id as words and the shared window names. */
const GENERIC_ADAPTER: SubscriptionAdapter = {
  planBrand: "",
  planName: (plan) => words(plan),
  windows: SHARED_WINDOWS,
};

function adapter(provider: string): SubscriptionAdapter {
  return ADAPTERS[provider === "supergrok" ? "xai" : provider] ?? GENERIC_ADAPTER;
}

/**
 * The plan as the provider names it today: "Claude Ultra", "ChatGPT Plus",
 * "SuperGrok Heavy". With `brand: false` only the plan's own name ("Ultra").
 * Null when the plan isn't known.
 */
export function subscriptionPlanLabel(
  provider: string,
  plan: string | null | undefined,
  options: { brand?: boolean } = {},
): string | null {
  const id = plan?.trim();
  if (!id) return null;
  const { planBrand, planName } = adapter(provider);
  const name = planName(id);
  if (options.brand === false) return name || planBrand || null;
  return [planBrand, name].filter(Boolean).join(" ") || null;
}

/** A window's short label: "5h", "Week", "Fable week"; an unknown id reads as words. */
export function subscriptionWindowLabel(provider: string, id: string): string {
  const spec = adapter(provider).windows[id];
  if (spec) return spec.label;
  // A new scoped weekly limit ("seven_day_haiku") reads as "Haiku week".
  const scoped = /^seven_day_(.+)$/.exec(id);
  return scoped ? `${words(scoped[1]!)} week` : words(id);
}

function epoch(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Every reported window, labelled and in a stable order (5h, week, scoped
 * weeks, credits, extra usage). A window whose reset has passed since it was
 * read keeps its place but no longer claims a share left.
 */
export function subscriptionWindows(
  provider: string,
  inputs: readonly SubscriptionWindowInput[],
  now: number = Date.now(),
): SubscriptionWindow[] {
  const specs = adapter(provider).windows;
  return inputs
    .map((input, index) => {
      const reset = epoch(input.resetsAt);
      const resetPassed = reset !== null && reset <= now;
      const used =
        input.usedPercent !== null && Number.isFinite(input.usedPercent) ? input.usedPercent : null;
      const leftPercent =
        resetPassed || used === null ? null : Math.min(100, Math.max(0, 100 - used));
      const limitReached = !resetPassed && (input.status === "exhausted" || (used ?? 0) >= 100);
      return {
        index,
        order: specs[input.id]?.order ?? 50,
        window: {
          id: input.id,
          label: subscriptionWindowLabel(provider, input.id),
          leftPercent,
          resetsAt: resetPassed ? null : reset,
          limitReached,
          nearLimit:
            !limitReached &&
            !resetPassed &&
            (input.status === "warning" ||
              (leftPercent !== null && leftPercent < SUBSCRIPTION_NEAR_LIMIT_LEFT)),
          resetPassed,
          extra: specs[input.id]?.extra === true,
        },
      };
    })
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map((entry) => entry.window);
}

/** Below this share left, an included-usage window counts as near its limit. */
export const SUBSCRIPTION_NEAR_LIMIT_LEFT = 10;

/**
 * The account's limit state from its included-usage windows and a stored
 * refusal deadline. Extra usage never makes an account look limited or free.
 */
export function subscriptionLimit(
  windows: readonly SubscriptionWindow[],
  exhaustedUntil: string | number | null = null,
  now: number = Date.now(),
): SubscriptionLimit {
  const included = windows.filter((window) => !window.extra);
  const reached = included.filter((window) => window.limitReached);
  const refusalEnd = epoch(exhaustedUntil);
  const refused = refusalEnd !== null && refusalEnd > now;
  const ends = [...reached.map((window) => window.resetsAt), ...(refused ? [refusalEnd] : [])];
  return {
    reached: reached.length > 0 || refused,
    // The account serves again only once every reached limit has ended.
    until: ends.length > 0 && ends.every((end) => end !== null) ? Math.max(...ends) : null,
    near: reached.length === 0 && !refused && included.some((window) => window.nearLimit),
  };
}

/** A Codex account's endpoint readings (five-hour and weekly, each when reported) as inputs. */
export function codexWindowInputs(usage: {
  fiveHour?: CodexWindowReading | null | undefined;
  weekly?: CodexWindowReading | null | undefined;
}): SubscriptionWindowInput[] {
  const input = (id: string, reading: CodexWindowReading | null | undefined) => {
    if (!reading) return [];
    const usedPercent =
      typeof reading.percent === "number"
        ? reading.percent
        : typeof reading.remaining === "number"
          ? 100 - reading.remaining
          : null;
    return [{ id, usedPercent, resetsAt: reading.resetAt ?? null }];
  };
  return [...input("five_hour", usage.fiveHour), ...input("seven_day", usage.weekly)];
}

type CodexWindowReading = {
  percent?: number | null | undefined;
  remaining?: number | null | undefined;
  resetAt?: string | null | undefined;
};
