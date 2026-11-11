import {
  ClaudeExtraUsage,
  ClaudeLimitResetClaim,
  ClaudeLimitResetGrant,
  ClaudeLimitResets,
  ClaudeServiceState,
  ClaudeSurfaceUsageWindow,
  ClaudeUsageLimit,
  ClaudeUsageWindowId,
  ClaudeWallReset,
  type ClaudeSubscriptionUsage,
  type ClaudeUsageWindow,
  type ClaudeUsageRequestStatus,
} from "@opengeni/contracts";

/**
 * The Claude Code release whose account-API surface usage reads and limit
 * reset claims present. Claude reports reset grants only to its CLI surface
 * (`ineligible_reason: "surface"` for any other user agent). Model requests
 * keep their own identity (`claude-code-identity.ts` in the runtime).
 */
export const CLAUDE_CLI_SURFACE_VERSION = "2.1.322";
export const CLAUDE_CLI_SURFACE_USER_AGENT = `claude-cli/${CLAUDE_CLI_SURFACE_VERSION} (external, cli)`;

/** What a usage read or response reported beyond the plan windows. */
export type ClaudeUsageDetails = {
  limitResets?: ClaudeLimitResets | null;
  wallReset?: ClaudeWallReset | null;
  limits?: ClaudeUsageLimit[];
  extraUsage?: ClaudeExtraUsage | null;
  surfaceWindows?: ClaudeSurfaceUsageWindow[];
  serviceState?: ClaudeServiceState;
};

export type ClaudeUsageObservation = {
  windows: ClaudeUsageWindow[];
  observedAt: string;
  source: "response_headers" | "provider";
  requestStatus?: ClaudeUsageRequestStatus | null;
  requestRestrictions?: ClaudeUsageRequestStatus[];
  /**
   * Windows the usage endpoint answered with an explicit `null`: the plan has
   * no such limit now (a verified Ultra plan reports `five_hour: null`). An
   * omitted key is not evidence of anything and is never listed here.
   */
  noLimitWindows?: ClaudeUsageWindow["id"][];
  /** Everything else the read reported (reset grants, limit list, service state). */
  details?: ClaudeUsageDetails;
};
const prefixes: Record<string, string[]> = {
  five_hour: ["5h"],
  seven_day: ["7d"],
  seven_day_opus: ["7d-opus"],
  seven_day_sonnet: ["7d-sonnet"],
  seven_day_fable: ["7d-fable"],
  seven_day_overage_included: ["7d_oi", "7d-overage-included"],
  overage: ["overage"],
};
function percent(value: unknown, scale: number): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value) * scale;
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function epoch(value: string | null): string | null {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const time = Number(value) * 1000;
  return Number.isFinite(time) && time > 0 && time < 8.64e15 ? new Date(time).toISOString() : null;
}
function status(value: unknown): ClaudeUsageWindow["status"] {
  return value === "allowed" || value === "allowed_warning" || value === "rejected" ? value : null;
}

function latestReset(left: string | null, right: string | null, observedAt: string): string {
  return new Date(
    Math.max(
      left ? Date.parse(left) : Date.parse(observedAt) + 60_000,
      right ? Date.parse(right) : Date.parse(observedAt) + 60_000,
    ),
  ).toISOString();
}

function evidenceKey(item: ClaudeUsageRequestStatus): string {
  // A legacy Sonnet claim does not prove an account-wide restriction cleared.
  return JSON.stringify([
    item.upstreamModelId,
    item.upstreamModelId ? null : item.representativeClaim,
    item.source === "provider",
  ]);
}

function tiedRequest(
  left: ClaudeUsageRequestStatus,
  right: ClaudeUsageRequestStatus,
): ClaudeUsageRequestStatus {
  const denied = left.status === "rejected" ? left : right.status === "rejected" ? right : null;
  return {
    ...(denied ?? left),
    resetsAt: denied
      ? latestReset(
          left.status === "rejected" ? left.resetsAt : denied.resetsAt,
          right.status === "rejected" ? right.resetsAt : denied.resetsAt,
          left.observedAt,
        )
      : null,
    representativeClaim:
      left.representativeClaim === right.representativeClaim ? left.representativeClaim : null,
    status: denied ? "rejected" : null,
    overageStatus: null,
    overageResetsAt: null,
  };
}

export function parseClaudeUsageHeaders(
  headers: Headers,
  now = new Date(),
  upstreamModelId?: string,
): ClaudeUsageObservation | null {
  const observedAt = now.toISOString();
  const claim = ClaudeUsageWindowId.safeParse(
    headers.get("anthropic-ratelimit-unified-representative-claim"),
  );
  const claimedStatus = status(headers.get("anthropic-ratelimit-unified-status"));
  const claimedReset = epoch(headers.get("anthropic-ratelimit-unified-reset"));
  const overageStatus = status(headers.get("anthropic-ratelimit-unified-overage-status"));
  const overageResetsAt = epoch(headers.get("anthropic-ratelimit-unified-overage-reset"));
  const windows = ClaudeUsageWindowId.options.flatMap((id) => {
    const header = (suffix: string) =>
      prefixes[id]!.map((prefix) =>
        headers.get(`anthropic-ratelimit-unified-${prefix}-${suffix}`),
      ).find((value) => value !== null) ?? null;
    const representative = claim.success && claim.data === id;
    const usedPercent = percent(header("utilization"), 100);
    const resetsAt = epoch(header("reset")) ?? (representative ? claimedReset : null);
    const windowStatus = status(header("status")) ?? (representative ? claimedStatus : null);
    if (usedPercent === null && resetsAt === null && windowStatus === null) return [];
    return [{ id, usedPercent, resetsAt, status: windowStatus, observedAt }];
  });
  const serviceState = parseClaudeServiceState(headers, now);
  return windows.length || claimedStatus || overageStatus
    ? {
        windows,
        observedAt,
        source: "response_headers",
        requestStatus: {
          status: claimedStatus,
          resetsAt: claimedReset,
          representativeClaim: claim.success ? claim.data : null,
          overageStatus,
          overageResetsAt,
          upstreamModelId: upstreamModelId ?? null,
          observedAt,
        },
        ...(serviceState ? { details: { serviceState } } : {}),
      }
    : null;
}

function finiteHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function tokenHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value && value.length <= 64 ? value : null;
}

const SLOW_STATUSES = new Set([
  "active",
  "not_needed",
  "slot_busy",
  "weekly_limit",
  "budget_exhausted",
  "ineligible",
  "off",
]);
const THRESHOLD_WINDOWS = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_overage_included", "7d_oi"],
  ["overage", "overage"],
] as const;

/**
 * The service state one model response's headers report (as Claude Code
 * 2.1.322 reads them): fallback, overage detail, upgrade paths, surpassed
 * thresholds, retry-after, the slow tier (sent only to a request that asked
 * for it with `anthropic-usage-limit: slow`) and grace (only with
 * `anthropic-usage-limit: extended`; utilization above zero means the
 * response was served in the grace zone). Null when the response reported
 * none of it.
 */
export function parseClaudeServiceState(
  headers: Headers,
  now = new Date(),
): ClaudeServiceState | null {
  const prefix = "anthropic-ratelimit-unified-";
  const fallback = headers.get(`${prefix}fallback`);
  const fallbackPercentage = finiteHeader(headers, `${prefix}fallback-percentage`);
  const flag = (name: string) => {
    const value = headers.get(`${prefix}${name}`);
    return value === null ? null : value === "true";
  };
  const surpassedThresholds = THRESHOLD_WINDOWS.flatMap(([windowId, short]) => {
    const threshold = finiteHeader(headers, `${prefix}${short}-surpassed-threshold`);
    return threshold === null ? [] : [{ windowId, threshold }];
  });
  const upgradePaths = (headers.get(`${prefix}upgrade-paths`) ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0 && path.length <= 64)
    .slice(0, 16);
  const slowStatusHeader = headers.get(`${prefix}slow-status`);
  const slowOffer = headers.get(`${prefix}slow-offer`);
  const slowRetryAfter = finiteHeader(headers, `${prefix}slow-retry-after`);
  const slowMaxWait = finiteHeader(headers, `${prefix}slow-max-wait`);
  const slowBudget = finiteHeader(headers, `${prefix}slow-budget-utilization`);
  const slowBudgetReset = epoch(headers.get(`${prefix}slow-budget-reset`));
  const slow =
    slowStatusHeader !== null ||
    slowOffer !== null ||
    slowRetryAfter !== null ||
    slowMaxWait !== null ||
    slowBudget !== null ||
    slowBudgetReset !== null
      ? {
          status:
            slowStatusHeader === null
              ? null
              : SLOW_STATUSES.has(slowStatusHeader)
                ? slowStatusHeader
                : "unrecognized",
          offer: slowOffer === "treatment" || slowOffer === "control" ? slowOffer : null,
          retryAfterSeconds: slowRetryAfter,
          maxWaitSeconds: slowMaxWait,
          budgetUtilization: slowBudget === null ? null : Math.min(1, slowBudget),
          budgetResetsAt: slowBudgetReset,
        }
      : null;
  const graceFive = finiteHeader(headers, `${prefix}grace-5h-utilization`);
  const graceSeven = finiteHeader(headers, `${prefix}grace-7d-utilization`);
  const state = {
    observedAt: now.toISOString(),
    fallbackAvailable: fallback === null ? null : fallback === "available",
    fallbackPercentage,
    overageDisabledReason: tokenHeader(headers, `${prefix}overage-disabled-reason`),
    overageInUse: flag("overage-in-use"),
    overageDailyCapPaused: flag("overage-daily-cap-paused"),
    overageScope: tokenHeader(headers, `${prefix}overage-scope`),
    upgradePaths,
    surpassedThresholds,
    retryAfterSeconds: finiteHeader(headers, "retry-after"),
    slow,
    grace:
      graceFive === null && graceSeven === null
        ? null
        : { fiveHourUtilization: graceFive, sevenDayUtilization: graceSeven },
  };
  const reported =
    state.fallbackAvailable !== null ||
    fallbackPercentage !== null ||
    state.overageDisabledReason !== null ||
    state.overageInUse !== null ||
    state.overageDailyCapPaused !== null ||
    state.overageScope !== null ||
    upgradePaths.length > 0 ||
    surpassedThresholds.length > 0 ||
    state.retryAfterSeconds !== null ||
    slow !== null ||
    state.grace !== null;
  if (!reported) return null;
  const parsed = ClaudeServiceState.safeParse(state);
  return parsed.success ? parsed.data : null;
}

/** Whether a response was served in the grace zone past a plan limit. */
export function claudeServiceStateInGrace(state: ClaudeServiceState | null | undefined): boolean {
  return (
    (state?.grace?.fiveHourUtilization ?? 0) > 0 || (state?.grace?.sevenDayUtilization ?? 0) > 0
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function tokenOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

function tokens(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" && item.length > 0 && item.length <= 64,
        )
        .slice(0, 16)
    : [];
}

function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

/**
 * What a grant gives back, the way Claude Code 2.1.322 names it: `fable`
 * when it gives back the weekly limit it spent, else its `type`, else
 * derived from what it clears.
 */
export function claudeLimitResetGrantKind(grant: {
  type: string | null;
  clears: readonly string[];
  givesBackWeekly: boolean;
}): ClaudeLimitResetGrant["kind"] {
  if (grant.givesBackWeekly) return "fable";
  if (grant.type === "session" || grant.type === "weekly" || grant.type === "full")
    return grant.type;
  const session = grant.clears.includes("five_hour");
  const weekly = grant.clears.some((id) => id.startsWith("seven_day"));
  return session && weekly ? "full" : session ? "session" : "weekly";
}

function parseGrant(value: unknown): ClaudeLimitResetGrant | null {
  const grant = record(value);
  if (!grant) return null;
  const percentUsed: Record<string, number> = {};
  for (const [id, used] of Object.entries(record(grant.percent_used) ?? {})) {
    const number = percentOrNull(used);
    if (number !== null && id.length > 0 && id.length <= 64) percentUsed[id] = number;
  }
  const type = tokenOrNull(grant.type);
  const clears = tokens(grant.clears);
  const givesBackWeekly = grant.gives_back_weekly === true;
  const parsed = ClaudeLimitResetGrant.safeParse({
    id: grant.id,
    label: typeof grant.label === "string" ? grant.label.slice(0, 300) : null,
    type,
    kind: claudeLimitResetGrantKind({ type, clears, givesBackWeekly }),
    resetsTotal: countOrNull(grant.resets_total),
    resetsLeft: countOrNull(grant.resets_left),
    startsAt: isoOrNull(grant.starts_at),
    endsAt: isoOrNull(grant.ends_at),
    clears,
    paused: grant.paused === true,
    usableNow: grant.usable_now === true,
    // Claude Code's default: a grant is used at a limit unless it says otherwise.
    useRequiresLimit: grant.use_requires_limit !== false,
    givesBackWeekly,
    percentUsed,
    blocking: tokens(grant.blocking),
    unavailableReason: tokenOrNull(grant.unavailable_reason),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The account's limit reset status (the usage body's `cedar_ember` block).
 * A malformed grant is dropped, as Claude Code drops it; a malformed block
 * is no reading (null). Undefined when the body has no such block.
 */
export function parseClaudeLimitResets(
  value: unknown,
  now = new Date(),
): ClaudeLimitResets | null | undefined {
  if (value === undefined) return undefined;
  const program = record(value);
  if (!program || typeof program.eligible !== "boolean") return null;
  const grants = (Array.isArray(program.grants) ? program.grants : [])
    .map(parseGrant)
    .filter((grant): grant is ClaudeLimitResetGrant => grant !== null)
    .slice(0, 32);
  const nextGrantId =
    typeof program.next_grant_id === "string" && grants.some((g) => g.id === program.next_grant_id)
      ? program.next_grant_id
      : null;
  const parsed = ClaudeLimitResets.safeParse({
    eligible: program.eligible,
    ineligibleReason: tokenOrNull(program.ineligible_reason),
    atLimit: program.at_limit === true,
    exhausted: tokens(program.exhausted),
    grants,
    nextGrantId,
    weeklyResetsAt: isoOrNull(program.weekly_resets_at),
    cooldownUntil: isoOrNull(program.cooldown_until),
    observedAt: now.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/** The at-the-limit reset program (`juniper_tide`); undefined when the body has none. */
export function parseClaudeWallReset(
  value: unknown,
  now = new Date(),
): ClaudeWallReset | null | undefined {
  if (value === undefined || value === null) return undefined;
  const program = record(value);
  if (!program || typeof program.eligible !== "boolean") return null;
  const parsed = ClaudeWallReset.safeParse({
    eligible: program.eligible,
    ineligibleReason: tokenOrNull(program.ineligible_reason),
    inExperiment: program.in_experiment === true,
    available: program.available === true,
    nextAvailableAt: isoOrNull(program.next_available_at),
    weeklyResetsAt: isoOrNull(program.weekly_resets_at),
    resetsPerWeek: countOrNull(program.resets_per_week),
    observedAt: now.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/** The usage body's `limits` list with each scoped limit's weekly share; undefined without one. */
export function parseClaudeUsageLimits(
  body: Record<string, unknown>,
): ClaudeUsageLimit[] | undefined {
  if (!Array.isArray(body.limits)) return undefined;
  const shares = new Map<number, Record<string, unknown>>();
  if (Array.isArray(body.weekly_scoped_shares))
    for (const entry of body.weekly_scoped_shares) {
      const share = record(entry);
      const index = countOrNull(share?.limit_index);
      if (share && index !== null) shares.set(index, share);
    }
  return body.limits.slice(0, 16).flatMap((entry, index) => {
    const limit = record(entry);
    if (!limit) return [];
    const model = record(record(limit.scope)?.model);
    const share = shares.get(index);
    const parsed = ClaudeUsageLimit.safeParse({
      kind: limit.kind,
      group: tokenOrNull(limit.group),
      percent: percentOrNull(limit.percent ?? limit.utilization),
      severity: tokenOrNull(limit.severity),
      resetsAt: isoOrNull(limit.resets_at),
      modelName: typeof model?.display_name === "string" ? model.display_name.slice(0, 100) : null,
      modelId: typeof model?.id === "string" ? model.id.slice(0, 200) : null,
      surface: tokenOrNull(record(limit.scope)?.surface),
      isActive: limit.is_active === true,
      allowancePercentOfWeekly: percentOrNull(share?.allowance_percent_of_weekly),
      usedPercentOfWeekly: percentOrNull(share?.used_percent_of_weekly),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/** The usage body's `extra_usage`; undefined when absent, null when the provider reports none. */
export function parseClaudeExtraUsage(value: unknown): ClaudeExtraUsage | null | undefined {
  if (value === undefined) return undefined;
  const extra = record(value);
  if (!extra) return null;
  const parsed = ClaudeExtraUsage.safeParse({
    isEnabled: typeof extra.is_enabled === "boolean" ? extra.is_enabled : null,
    monthlyLimit: numberOrNull(extra.monthly_limit),
    usedCredits: numberOrNull(extra.used_credits),
    utilization: percentOrNull(extra.utilization),
    currency: typeof extra.currency === "string" ? extra.currency.slice(0, 16) : null,
    disabledReason: tokenOrNull(extra.disabled_reason),
  });
  return parsed.success ? parsed.data : null;
}

const SURFACE_WINDOWS = ["seven_day_cowork", "seven_day_omelette", "seven_day_oauth_apps"] as const;

function parseSurfaceWindows(body: Record<string, unknown>): ClaudeSurfaceUsageWindow[] {
  return SURFACE_WINDOWS.flatMap((id) => {
    const window = record(body[id]);
    if (!window) return [];
    const parsed = ClaudeSurfaceUsageWindow.safeParse({
      id,
      usedPercent: percentOrNull(window.utilization),
      resetsAt: isoOrNull(window.resets_at),
    });
    return parsed.success && (parsed.data.usedPercent !== null || parsed.data.resetsAt !== null)
      ? [parsed.data]
      : [];
  });
}

/**
 * Everything a usage body reports beyond the plan windows. Each part is
 * read on its own: a part that cannot be read is left out and never breaks
 * the reading or another part.
 */
export function parseClaudeUsageDetails(
  body: Record<string, unknown>,
  now = new Date(),
): ClaudeUsageDetails {
  const details: ClaudeUsageDetails = {};
  const part = <T>(read: () => T | undefined): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const limitResets = part(() => parseClaudeLimitResets(body.cedar_ember, now));
  if (limitResets !== undefined) details.limitResets = limitResets;
  const wallReset = part(() => parseClaudeWallReset(body.juniper_tide, now));
  if (wallReset !== undefined) details.wallReset = wallReset;
  const limits = part(() => parseClaudeUsageLimits(body));
  if (limits !== undefined) details.limits = limits;
  const extraUsage = part(() => parseClaudeExtraUsage(body.extra_usage));
  if (extraUsage !== undefined) details.extraUsage = extraUsage;
  const surfaceWindows = part(() =>
    SURFACE_WINDOWS.some((id) => Object.hasOwn(body, id)) ? parseSurfaceWindows(body) : undefined,
  );
  if (surfaceWindows !== undefined) details.surfaceWindows = surfaceWindows;
  return details;
}

const CLAIM_RESULTS = new Set([
  "reset",
  "already_used",
  "not_limited",
  "cooldown",
  "ineligible",
  "unavailable",
]);

/**
 * A limit reset claim's HTTP answer, as Claude Code 2.1.322 reads it: a
 * readable 2xx body is the provider's result (an unknown result is
 * `unavailable`, and `unavailable` is retried with the same request id); a
 * 429 is `rate_limited`, a 401 or 403 `auth_error`, anything else `error`.
 * Every unsettled outcome is `retryable`.
 */
export function parseClaudeLimitResetClaim(
  httpStatus: number,
  body: unknown,
): ClaudeLimitResetClaim {
  const unsettled = (result: "rate_limited" | "auth_error" | "error"): ClaudeLimitResetClaim => ({
    result,
    reason: null,
    resetsLeft: null,
    cleared: [],
    weeklyResetsAt: null,
    cooldownUntil: null,
    retryable: true,
  });
  if (httpStatus === 429) return unsettled("rate_limited");
  if (httpStatus === 401 || httpStatus === 403) return unsettled("auth_error");
  const answer = httpStatus >= 200 && httpStatus < 300 ? record(body) : null;
  if (!answer || typeof answer.result !== "string") return unsettled("error");
  const result = (CLAIM_RESULTS.has(answer.result) ? answer.result : "unavailable") as
    | "reset"
    | "already_used"
    | "not_limited"
    | "cooldown"
    | "ineligible"
    | "unavailable";
  const parsed = ClaudeLimitResetClaim.safeParse({
    result,
    reason: tokenOrNull(answer.reason),
    resetsLeft: countOrNull(answer.resets_left),
    cleared: tokens(answer.cleared),
    weeklyResetsAt: isoOrNull(answer.weekly_resets_at),
    cooldownUntil: isoOrNull(answer.cooldown_until),
    retryable: result === "unavailable",
  });
  return parsed.success ? parsed.data : unsettled("error");
}

/**
 * The weekly Fable limit from the endpoint's scoped `limits` list, when the
 * body has no top-level `seven_day_fable`. Built on the publicly reported
 * shape (`{ kind: "weekly_scoped", scope: { model: { id, display_name } },
 * percent | utilization, resets_at }`, percentages 0-100) without a captured
 * body, so any other shape is ignored and never breaks the reading.
 */
function scopedFableWindow(value: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const limits = value.limits;
    if (!Array.isArray(limits)) return null;
    for (const entry of limits) {
      const limit = record(entry);
      if (!limit || limit.kind !== "weekly_scoped") continue;
      const model = record(record(limit.scope)?.model);
      const name = typeof model?.display_name === "string" ? model.display_name : "";
      const id = typeof model?.id === "string" ? model.id : "";
      if (name.trim().toLowerCase() !== "fable" && !id.startsWith("claude-fable")) continue;
      return {
        utilization: limit.utilization ?? limit.percent ?? null,
        resets_at: limit.resets_at ?? null,
      };
    }
  } catch {
    // An unexpected shape is not a reading.
  }
  return null;
}

export function parseClaudeUsageResponse(
  value: unknown,
  now = new Date(),
): ClaudeUsageObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const observedAt = now.toISOString();
  const body = value as Record<string, unknown>;
  const windows = ClaudeUsageWindowId.options.flatMap((id) => {
    const window =
      id === "seven_day_fable" && body[id] === undefined ? scopedFableWindow(body) : body[id];
    if (!window || typeof window !== "object" || Array.isArray(window)) return [];
    const fields = window as Record<string, unknown>;
    const usedPercent = percent(fields.utilization, 1);
    const time = typeof fields.resets_at === "string" ? Date.parse(fields.resets_at) : NaN;
    const resetsAt = Number.isFinite(time) ? new Date(time).toISOString() : null;
    if (usedPercent === null && resetsAt === null) return [];
    return [{ id, usedPercent, resetsAt, status: null, observedAt }];
  });
  const noLimitWindows = ClaudeUsageWindowId.options.filter(
    (id) => Object.hasOwn(value, id) && (value as Record<string, unknown>)[id] === null,
  );
  const details = parseClaudeUsageDetails(body, now);
  return windows.length
    ? {
        windows,
        observedAt,
        source: "provider",
        ...(noLimitWindows.length ? { noLimitWindows } : {}),
        ...(Object.keys(details).length ? { details } : {}),
      }
    : null;
}

export function emptyClaudeUsage(credentialVersion: number | null): ClaudeSubscriptionUsage {
  return {
    connected: credentialVersion !== null,
    credentialVersion,
    windows: [],
    observedAt: null,
    source: null,
    refreshStatus: "not_checked",
    refreshCheckedAt: null,
  };
}

/** Preserve omitted windows and reject observations older than their individual window. */
export function mergeClaudeUsage(
  current: ClaudeSubscriptionUsage,
  observation: ClaudeUsageObservation,
): ClaudeSubscriptionUsage {
  const windows = new Map(current.windows.map((window) => [window.id, window]));
  for (const incomingWindow of observation.windows) {
    const window = { ...incomingWindow, source: incomingWindow.source ?? observation.source };
    const previous = windows.get(window.id);
    if (!previous || previous.observedAt < window.observedAt) windows.set(window.id, window);
    else if (
      previous.observedAt === window.observedAt &&
      JSON.stringify(previous) !== JSON.stringify(window)
    ) {
      const rejected = previous.status === "rejected" || window.status === "rejected";
      const full = (previous.usedPercent ?? 0) >= 100 || (window.usedPercent ?? 0) >= 100;
      windows.set(window.id, {
        ...previous,
        usedPercent:
          previous.usedPercent === null
            ? window.usedPercent
            : window.usedPercent === null
              ? previous.usedPercent
              : Math.max(previous.usedPercent, window.usedPercent),
        status: rejected ? "rejected" : previous.status === window.status ? previous.status : null,
        resetsAt:
          rejected || full
            ? latestReset(previous.resetsAt, window.resetsAt, window.observedAt)
            : previous.resetsAt === window.resetsAt
              ? previous.resetsAt
              : null,
        source:
          previous.source === "response_headers" || window.source === "response_headers"
            ? "response_headers"
            : "provider",
      });
    }
  }
  const incoming = observation.requestStatus;
  const restrictions = new Map(
    (current.requestRestrictions ?? []).map((item) => [evidenceKey(item), item]),
  );
  // Legacy snapshots also contribute their denial; a different model's success
  // must not erase a restriction with an unknown representative claim.
  for (const item of [
    current.requestStatus?.status ? current.requestStatus : null,
    ...(observation.requestRestrictions ?? []),
    incoming?.status ? incoming : null,
  ]) {
    if (!item) continue;
    const key = evidenceKey(item);
    const previous = restrictions.get(key);
    const sanitized = {
      ...item,
      overageStatus: null,
      overageResetsAt: null,
    };
    if (!previous || item.observedAt > previous.observedAt) restrictions.set(key, sanitized);
    else if (
      item.observedAt === previous.observedAt &&
      JSON.stringify(previous) !== JSON.stringify(sanitized)
    )
      restrictions.set(key, tiedRequest(previous, sanitized));
  }
  // Direct refreshes can precede late turn finalizers. Retain each direct
  // window's watermark even when no model restriction is present yet.
  const directWindows = [
    ...current.windows.filter(
      (window) =>
        window.source === "provider" ||
        (!window.source &&
          current.source === "provider" &&
          current.observedAt === window.observedAt),
    ),
    ...observation.windows.filter((window) => (window.source ?? observation.source) === "provider"),
  ];
  for (const window of directWindows) {
    if (window.usedPercent === null || window.usedPercent >= 100) continue;
    const proof: ClaudeUsageRequestStatus = {
      status: null,
      resetsAt: null,
      representativeClaim: window.id,
      upstreamModelId: null,
      overageStatus: null,
      overageResetsAt: null,
      observedAt: window.observedAt,
      source: "provider",
    };
    const key = evidenceKey(proof);
    if (!restrictions.has(key) || restrictions.get(key)!.observedAt < proof.observedAt)
      restrictions.set(key, proof);
  }
  for (const [key, item] of restrictions) {
    if (item.status !== "rejected") continue;
    const proof = [...restrictions.values()].find(
      (candidate) =>
        candidate.source === "provider" &&
        candidate.representativeClaim === item.representativeClaim &&
        candidate.observedAt > item.observedAt &&
        candidate.representativeClaim !== "overage" &&
        candidate.representativeClaim !== "seven_day_overage_included",
    );
    if (proof)
      restrictions.set(key, {
        ...item,
        status: null,
        resetsAt: null,
        observedAt: proof.observedAt,
      });
  }
  // Bound persisted state without dropping denials: overflow collapses to a
  // conservative account-wide restriction until the latest known reset.
  let requestRestrictions = [...restrictions.values()];
  const evidenceTime = requestRestrictions.reduce(
    (value, item) => (item.observedAt > value ? item.observedAt : value),
    observation.observedAt,
  );
  const liveDenials = requestRestrictions.filter(
    (item) =>
      item.status === "rejected" &&
      (item.resetsAt ? Date.parse(item.resetsAt) : Date.parse(item.observedAt) + 60_000) >
        Date.parse(evidenceTime),
  );
  if (requestRestrictions.length > 64 && liveDenials.length === 0) {
    requestRestrictions = requestRestrictions
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, 64);
  } else if (requestRestrictions.length > 64) {
    const observedAt = evidenceTime;
    const resetsAt = new Date(
      Math.max(
        ...liveDenials.map((item) =>
          item.resetsAt ? Date.parse(item.resetsAt) : Date.parse(item.observedAt) + 60_000,
        ),
        Date.parse(observedAt) + 60_000,
      ),
    ).toISOString();
    requestRestrictions = [
      {
        status: "rejected",
        resetsAt,
        representativeClaim: null,
        overageStatus: null,
        overageResetsAt: null,
        upstreamModelId: null,
        observedAt,
      },
    ];
  }
  const newest = !current.observedAt || current.observedAt < observation.observedAt;
  const tied = current.observedAt === observation.observedAt;
  let requestStatus = current.requestStatus ?? null;
  if (newest) requestStatus = incoming ?? null;
  else if (tied && JSON.stringify(requestStatus) !== JSON.stringify(incoming ?? null)) {
    // Millisecond timestamps do not order concurrent responses. Never restore
    // paid authority or erase a denial on an ambiguous tie.
    requestStatus =
      incoming && requestStatus && evidenceKey(incoming) === evidenceKey(requestStatus)
        ? tiedRequest(requestStatus, incoming)
        : null;
  }
  return {
    ...current,
    requestRestrictions,
    requestStatus,
    windows: ClaudeUsageWindowId.options.flatMap((id) =>
      windows.has(id) ? [windows.get(id)!] : [],
    ),
    ...(newest
      ? {
          observedAt: observation.observedAt,
          source: observation.source,
          // A newer direct or partial observation cannot retain an older paid
          // fallback authorization. Window readings remain independently merged.
        }
      : {}),
  };
}
