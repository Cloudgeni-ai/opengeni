// Normalizer for GET /wham/usage (P2). The live body exposes `used_percent` +
// reset timing per window and NO raw used/limit/remaining integer counts (the only
// raw counts live under `credits.approx_*_messages`). So the brief's
// used/limit/remaining/percent/resetAt shape is SYNTHESIZED off `used_percent`,
// with `percent` authoritative and used/limit/remaining carried on a normalized
// 0–100 scale (limit = 100). `remaining = 100 - percent` is the P3 rotation key
// (rotationStrategy:"most_remaining" ranks by max(min(fiveHour, weekly).remaining)).
//
// Windows are identified by `limit_window_seconds` (18000 ⇒ 5h, 604800 ⇒ weekly),
// NEVER by position. A 200 may carry `limit_reached:true`; a 404 carries a
// limit-reached body. The parser is zod over rate_limit.{primary,secondary}_window.

import * as z from "zod/v4";

/** The 5-hour (primary) window's `limit_window_seconds`. */
export const CODEX_FIVE_HOUR_WINDOW_SECONDS = 18000;
/** The weekly (secondary) window's `limit_window_seconds`. */
export const CODEX_WEEKLY_WINDOW_SECONDS = 604800;

/** One normalized usage window (applied to BOTH primary_window and secondary_window). */
export type CodexUsageWindow = {
  used: number; // = percent (0–100 scale, limit = 100)
  limit: number; // = 100 (normalized; the provider gives no raw cap)
  remaining: number; // = 100 - percent  ← P3 rotation key
  percent: number; // = used_percent (authoritative)
  resetAt: string | null; // ISO 8601, from reset_at*1000 (absolute), or derived from reset_after_seconds
  resetAfterSeconds: number | null; // from reset_after_seconds (skew-free countdown)
  limitWindowSeconds: number; // 18000 | 604800 — identify the window, never positional
};

/** One additional (per-feature) limit (forward-compat; P2 renders nothing from it). */
export type CodexAdditionalLimit = {
  limitName: string;
  meteredFeature: string;
  fiveHour: CodexUsageWindow | null;
  weekly: CodexUsageWindow | null;
};

export type CodexUsageStatus = "ok" | "limit_reached" | "error" | "no-data";

/** The normalized usage payload — the P2/P3 contract. */
export type CodexUsagePayload = {
  status: CodexUsageStatus;
  planType: string | null; // "pro" | "plus" | ... (rate row label)
  fiveHour: CodexUsageWindow | null; // ← rate_limit.primary_window  (limitWindowSeconds === 18000)
  weekly: CodexUsageWindow | null; // ← rate_limit.secondary_window (604800)
  limitReached: boolean; // rate_limit.limit_reached || !rate_limit.allowed
  fetchedAt: string; // ISO; server stamp
  /** Present only on a refresh/auth failure path; carries the precise reason. */
  reason?: "needs_relogin" | undefined;
  // forward-compat, populated but unused in P2:
  additionalLimits?: CodexAdditionalLimit[] | undefined;
  credits?: { hasCredits: boolean; unlimited: boolean; overageLimitReached: boolean; balance: string } | undefined;
};

/**
 * Build a normalized window from the PERSISTED cache columns (used_percent +
 * absolute reset timestamp). The same 0–100 synthesis as the live path, with the
 * skew-free countdown derived from `resetAt − now` at read time. Returns null when
 * there is no cached percent yet. `limitWindowSeconds` is the constant that
 * identifies the window (18000 ⇒ 5h, 604800 ⇒ weekly).
 */
export function buildCodexUsageWindowFromCache(
  usedPercent: number | null | undefined,
  resetAt: Date | string | null | undefined,
  limitWindowSeconds: number,
): CodexUsageWindow | null {
  if (typeof usedPercent !== "number") {
    return null;
  }
  const percent = clampPercent(usedPercent);
  const resetDate = resetAt ? new Date(resetAt) : null;
  const resetIso = resetDate && !Number.isNaN(resetDate.getTime()) ? resetDate.toISOString() : null;
  const resetAfterSeconds = resetDate && !Number.isNaN(resetDate.getTime())
    ? Math.max(0, Math.round((resetDate.getTime() - Date.now()) / 1000))
    : null;
  return {
    used: percent,
    limit: 100,
    remaining: 100 - percent,
    percent,
    resetAt: resetIso,
    resetAfterSeconds,
    limitWindowSeconds,
  };
}

const windowSchema = z
  .object({
    used_percent: z.number().optional(),
    reset_after_seconds: z.number().optional(),
    reset_at: z.number().optional(),
    limit_window_seconds: z.number().optional(),
  })
  .nullish();

const rateLimitSchema = z
  .object({
    allowed: z.boolean().optional(),
    limit_reached: z.boolean().optional(),
    primary_window: windowSchema,
    secondary_window: windowSchema,
  })
  .nullish();

const additionalLimitSchema = z.object({
  limit_name: z.string().optional(),
  metered_feature: z.string().optional(),
  primary_window: windowSchema,
  secondary_window: windowSchema,
});

const creditsSchema = z
  .object({
    has_credits: z.boolean().optional(),
    unlimited: z.boolean().optional(),
    overage_limit_reached: z.boolean().optional(),
    balance: z.union([z.string(), z.number()]).optional(),
  })
  .nullish();

const usageBodySchema = z.object({
  plan_type: z.string().nullish(),
  rate_limit: rateLimitSchema,
  additional_limits: z.array(additionalLimitSchema).nullish(),
  credits: creditsSchema,
});

type RawWindow = z.infer<typeof windowSchema>;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Build a normalized window from a raw provider window, or null when it carries no percent. */
function normalizeWindow(w: RawWindow): CodexUsageWindow | null {
  if (!w || typeof w.used_percent !== "number") {
    return null;
  }
  const percent = clampPercent(w.used_percent);
  const resetAfterSeconds = typeof w.reset_after_seconds === "number" ? Math.max(0, Math.round(w.reset_after_seconds)) : null;
  let resetAt: string | null = null;
  if (typeof w.reset_at === "number") {
    resetAt = new Date(w.reset_at * 1000).toISOString(); // epoch SECONDS → ms
  } else if (resetAfterSeconds != null) {
    resetAt = new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  }
  return {
    used: percent,
    limit: 100,
    remaining: 100 - percent,
    percent,
    resetAt,
    resetAfterSeconds,
    limitWindowSeconds: typeof w.limit_window_seconds === "number" ? w.limit_window_seconds : 0,
  };
}

/**
 * Map the two named windows to fiveHour/weekly by `limit_window_seconds`
 * (18000 vs 604800), NEVER by position; fall back to position (primary ⇒ 5h,
 * secondary ⇒ weekly) only for a window whose limit_window_seconds is absent.
 */
function pickWindows(primary: RawWindow, secondary: RawWindow): { fiveHour: CodexUsageWindow | null; weekly: CodexUsageWindow | null } {
  let fiveHour: CodexUsageWindow | null = null;
  let weekly: CodexUsageWindow | null = null;
  const unplaced: CodexUsageWindow[] = [];
  for (const raw of [primary, secondary]) {
    const nw = normalizeWindow(raw);
    if (!nw) continue;
    if (nw.limitWindowSeconds === CODEX_WEEKLY_WINDOW_SECONDS) {
      weekly = nw;
    } else if (nw.limitWindowSeconds === CODEX_FIVE_HOUR_WINDOW_SECONDS) {
      fiveHour = nw;
    } else {
      unplaced.push(nw);
    }
  }
  // Positional fallback for windows whose limit_window_seconds was absent/unknown.
  const primaryNorm = normalizeWindow(primary);
  const secondaryNorm = normalizeWindow(secondary);
  if (!fiveHour && primaryNorm && unplaced.includes(primaryNorm)) fiveHour = primaryNorm;
  if (!weekly && secondaryNorm && unplaced.includes(secondaryNorm)) weekly = secondaryNorm;
  return { fiveHour, weekly };
}

/**
 * Normalize a /wham/usage fetch result into the P2/P3 contract.
 *
 * @param httpStatus the HTTP status from fetchCodexUsage (404 ⇒ a limit body)
 * @param rawPayload the parsed JSON body (or null when the body was unreadable)
 */
export function normalizeCodexUsage(httpStatus: number, rawPayload: unknown): CodexUsagePayload {
  const fetchedAt = new Date().toISOString();
  const parsed = usageBodySchema.safeParse(rawPayload);
  const body = parsed.success ? parsed.data : null;

  const base: CodexUsagePayload = {
    status: "no-data",
    planType: body?.plan_type ?? null,
    fiveHour: null,
    weekly: null,
    limitReached: false,
    fetchedAt,
  };

  // A non-404 HTTP error, or a body we could not parse at all, is an error state.
  if ((httpStatus >= 400 && httpStatus !== 404) || body == null) {
    return { ...base, status: "error" };
  }

  const rate = body.rate_limit ?? null;
  const { fiveHour, weekly } = pickWindows(rate?.primary_window ?? null, rate?.secondary_window ?? null);
  const limitReached =
    !!(rate?.limit_reached || rate?.allowed === false) || (fiveHour?.percent ?? 0) >= 100 || (weekly?.percent ?? 0) >= 100;

  const additionalLimits: CodexAdditionalLimit[] | undefined = body.additional_limits
    ? body.additional_limits.map((al) => {
        const windows = pickWindows(al.primary_window ?? null, al.secondary_window ?? null);
        return {
          limitName: al.limit_name ?? "",
          meteredFeature: al.metered_feature ?? "",
          fiveHour: windows.fiveHour,
          weekly: windows.weekly,
        };
      })
    : undefined;

  const credits = body.credits
    ? {
        hasCredits: body.credits.has_credits ?? false,
        unlimited: body.credits.unlimited ?? false,
        overageLimitReached: body.credits.overage_limit_reached ?? false,
        balance: body.credits.balance != null ? String(body.credits.balance) : "0",
      }
    : undefined;

  // Status derivation: 404 ⇒ limit_reached; a 200 may still carry limit_reached;
  // succeeded-but-no-windows ⇒ no-data; otherwise ok.
  let status: CodexUsageStatus;
  if (httpStatus === 404 || limitReached) {
    status = "limit_reached";
  } else if (!fiveHour && !weekly) {
    status = "no-data";
  } else {
    status = "ok";
  }

  return {
    ...base,
    status,
    fiveHour,
    weekly,
    limitReached,
    ...(additionalLimits ? { additionalLimits } : {}),
    ...(credits ? { credits } : {}),
  };
}
