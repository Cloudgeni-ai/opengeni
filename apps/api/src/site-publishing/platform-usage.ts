import {
  SITE_PLATFORM_BRAKE_ERROR_CODE,
  SITE_PLATFORM_QUOTA_ERROR_CODE,
  type SitePlatformMeter,
  type SitePlatformUsage,
} from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import {
  applyCreditDebitAfterUse,
  claimSitePlatformCharge,
  creditDebitAttributionMetadata,
  currentCreditDebitAttribution,
  evaluateSitePlatformBrake,
  getSpendableCreditBalance,
  readSitePlatformBrake,
  readSitePlatformTotals,
  readSitePlatformUsage,
  recordUsageEvent,
  type Database,
  type SitePlatformBrakeRecord,
  type SitePlatformScope,
  type SitePlatformUsageRecord,
} from "@opengeni/db";
import { ApiHttpError } from "../http/api-error";

/**
 * Site platform usage: what published Sites cost the platform apart from
 * model spend (gateway requests, Site SQL rows read and written, Site SQL
 * plus Site Data storage). Every mode meters it per workspace and month.
 *
 * - usage_only (default): recorded only.
 * - shadow: what credits mode would charge is recorded (shadow_micros).
 * - credits: usage above the workspace's monthly allowance is charged from
 *   organization credits; a workspace past an allowance with no credits (or
 *   with overage off) is refused further Site SQL and Site Data use (402).
 *
 * Separately, one Opengeni-wide monthly limit brakes every workspace: when
 * the estimated cost of all metered usage this month reaches
 * OPENGENI_SITES_PLATFORM_MONTHLY_LIMIT_USD the brake engages and refuses
 * new Site SQL writes, new publishes and guest agent turns (503,
 * details.code site_platform_brake_engaged). Published pages keep serving.
 */

export type SitePlatformSettings = Pick<
  Settings,
  | "sitesPlatformBillingMode"
  | "sitesPlatformOverageEnabled"
  | "sitesPlatformAllowanceRequests"
  | "sitesPlatformAllowanceSqlRowsRead"
  | "sitesPlatformAllowanceSqlRowsWritten"
  | "sitesPlatformAllowanceStorageBytes"
  | "sitesPlatformPriceMicrosPerMillionRequests"
  | "sitesPlatformPriceMicrosPerMillionSqlRowsRead"
  | "sitesPlatformPriceMicrosPerMillionSqlRowsWritten"
  | "sitesPlatformPriceMicrosPerGbMonth"
  | "sitesPlatformMonthlyLimitUsd"
  | "sitesPlatformAlertPercent"
>;

export type SitePlatformDeps = { db: Database; settings: SitePlatformSettings };

type MeterRule = {
  meter: SitePlatformMeter;
  allowance: number;
  priceMicros: number;
  priceUnit: number;
};

/** GB-month unit of storage prices (decimal gigabytes, as Cloudflare bills). */
export const SITE_PLATFORM_GB = 1_000_000_000;

export function sitePlatformMeterRules(settings: SitePlatformSettings): MeterRule[] {
  return [
    {
      meter: "requests",
      allowance: settings.sitesPlatformAllowanceRequests,
      priceMicros: settings.sitesPlatformPriceMicrosPerMillionRequests,
      priceUnit: 1_000_000,
    },
    {
      meter: "sql_rows_read",
      allowance: settings.sitesPlatformAllowanceSqlRowsRead,
      priceMicros: settings.sitesPlatformPriceMicrosPerMillionSqlRowsRead,
      priceUnit: 1_000_000,
    },
    {
      meter: "sql_rows_written",
      allowance: settings.sitesPlatformAllowanceSqlRowsWritten,
      priceMicros: settings.sitesPlatformPriceMicrosPerMillionSqlRowsWritten,
      priceUnit: 1_000_000,
    },
    {
      meter: "storage_bytes",
      allowance: settings.sitesPlatformAllowanceStorageBytes,
      priceMicros: settings.sitesPlatformPriceMicrosPerGbMonth,
      priceUnit: SITE_PLATFORM_GB,
    },
  ];
}

type MeterAmounts = Record<SitePlatformMeter, { used: number; peak: number }>;

type UsageAmounts = {
  requests: number;
  sqlRowsRead: number;
  sqlRowsWritten: number;
  storageBytes: number;
  storagePeakBytes?: number;
};

function amounts(usage: UsageAmounts): MeterAmounts {
  return {
    requests: { used: usage.requests, peak: usage.requests },
    sql_rows_read: { used: usage.sqlRowsRead, peak: usage.sqlRowsRead },
    sql_rows_written: { used: usage.sqlRowsWritten, peak: usage.sqlRowsWritten },
    storage_bytes: {
      used: usage.storageBytes,
      peak: Math.max(usage.storageBytes, usage.storagePeakBytes ?? 0),
    },
  };
}

const priced = (quantity: number, rule: MeterRule) =>
  Math.ceil((Math.max(0, quantity) * rule.priceMicros) / rule.priceUnit);

/**
 * Estimated cost of usage, micro-USD, before allowances. Storage is priced
 * at its level (peak for a workspace) as if held the whole month: an upper
 * bound, so the brake errs early rather than late.
 */
export function sitePlatformEstimateMicros(
  settings: SitePlatformSettings,
  usage: UsageAmounts,
): number {
  const values = amounts(usage);
  return sitePlatformMeterRules(settings).reduce(
    (total, rule) => total + priced(values[rule.meter].peak, rule),
    0,
  );
}

/** What credits mode charges this month: usage above each allowance, at its price. */
export function sitePlatformBillableMicros(
  settings: SitePlatformSettings,
  usage: UsageAmounts,
): number {
  const values = amounts(usage);
  return sitePlatformMeterRules(settings).reduce(
    (total, rule) => total + priced(values[rule.meter].peak - rule.allowance, rule),
    0,
  );
}

function brakeView(brake: SitePlatformBrakeRecord) {
  return { engaged: brake.engagedAt !== null, engagedAt: brake.engagedAt?.toISOString() ?? null };
}

export function sitePlatformUsageView(
  settings: SitePlatformSettings,
  workspaceId: string,
  usage: SitePlatformUsageRecord,
  brake: SitePlatformBrakeRecord,
): SitePlatformUsage {
  const values = amounts(usage);
  const meters = sitePlatformMeterRules(settings).map((rule) => ({
    meter: rule.meter,
    used: values[rule.meter].used,
    peak: values[rule.meter].peak,
    allowance: rule.allowance,
    priceMicros: rule.priceMicros,
    priceUnit: rule.priceUnit,
    estimatedMicros: priced(values[rule.meter].peak, rule),
  }));
  return {
    workspaceId,
    periodStart: usage.periodStart,
    billingMode: settings.sitesPlatformBillingMode,
    meters,
    estimatedMicros: meters.reduce((total, meter) => total + meter.estimatedMicros, 0),
    chargedMicros: usage.chargedMicros,
    shadowMicros: usage.shadowMicros,
    brake: brakeView(brake),
  };
}

export async function readSitePlatformUsageView(
  deps: SitePlatformDeps,
  scope: SitePlatformScope,
): Promise<SitePlatformUsage> {
  const [usage, brake] = await Promise.all([
    readSitePlatformUsage(deps.db, scope),
    readSitePlatformBrake(deps.db),
  ]);
  return sitePlatformUsageView(deps.settings, scope.workspaceId, usage, brake);
}

// --- charging (shadow and credits modes) --------------------------------------------

/** Charges smaller than this wait for more usage (one debit per cent at most). */
export const SITE_PLATFORM_MIN_CHARGE_MICROS = 10_000;

/**
 * After usage was recorded: in shadow mode record what credits would charge;
 * in credits mode charge the new billable amount from organization credits
 * (claim and debit in one transaction). Best effort: a failure is logged and
 * the next metered call retries it.
 */
export async function settleSitePlatformCharges(
  deps: SitePlatformDeps,
  scope: SitePlatformScope,
  usage: SitePlatformUsageRecord,
): Promise<void> {
  const mode = deps.settings.sitesPlatformBillingMode;
  if (mode === "usage_only") return;
  const billable = sitePlatformBillableMicros(deps.settings, usage);
  if (mode === "shadow" ? billable <= usage.shadowMicros : billable <= usage.chargedMicros) return;
  const attribution = currentCreditDebitAttribution();
  try {
    await claimSitePlatformCharge(deps.db, scope, {
      billableMicros: billable,
      minimumMicros: SITE_PLATFORM_MIN_CHARGE_MICROS,
      mode,
      debit: async (tx, claim) => {
        const sourceId = `${scope.workspaceId}:${claim.periodStart}`;
        await recordUsageEvent(tx, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          eventType: "site_platform.cost",
          quantity: claim.deltaMicros,
          unit: "usd_micros",
          sourceResourceType: "site_platform",
          sourceResourceId: sourceId,
          idempotencyKey: `site_platform.cost:${sourceId}:${claim.seq}`,
        });
        await applyCreditDebitAfterUse(tx, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          type: "site_platform.usage",
          amountMicros: claim.deltaMicros,
          sourceType: "site_platform",
          sourceId,
          idempotencyKey: `debit:site_platform:${sourceId}:${claim.seq}`,
          metadata: creditDebitAttributionMetadata(attribution),
        });
      },
    });
  } catch (error) {
    console.warn("[site-platform] could not settle platform charges", {
      workspaceId: scope.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Credits mode only: refuse (402, details.code site_platform_quota_exhausted)
 * when a meter the call uses is at or past its allowance and the workspace
 * cannot pay for more (overage off, or no spendable credits).
 */
export async function requireSitePlatformQuota(
  deps: SitePlatformDeps,
  scope: SitePlatformScope,
  meters: readonly SitePlatformMeter[],
): Promise<void> {
  if (deps.settings.sitesPlatformBillingMode !== "credits" || meters.length === 0) return;
  const usage = await readSitePlatformUsage(deps.db, scope);
  const values = amounts(usage);
  const exhausted = sitePlatformMeterRules(deps.settings).find(
    (rule) => meters.includes(rule.meter) && values[rule.meter].peak >= rule.allowance,
  );
  if (!exhausted) return;
  let reason: "overage_disabled" | "no_credits" | null = null;
  if (!deps.settings.sitesPlatformOverageEnabled) reason = "overage_disabled";
  else {
    const balance = await getSpendableCreditBalance(deps.db, scope.accountId);
    if (balance.balanceMicros <= 0) reason = "no_credits";
  }
  if (!reason) return;
  throw new ApiHttpError(402, {
    code: "payment_required",
    message:
      reason === "no_credits"
        ? "This workspace has used its included Site usage for this month and has no credits left"
        : "This workspace has used its included Site usage for this month",
    retryable: false,
    outcomeUnknown: false,
    details: {
      code: SITE_PLATFORM_QUOTA_ERROR_CODE,
      meter: exhausted.meter,
      allowance: exhausted.allowance,
      used: values[exhausted.meter].peak,
      reason,
    },
  });
}

// --- the Opengeni-wide brake --------------------------------------------------------

/** The monthly limit in micro-USD, or null when the automatic brake is off (limit 0). */
export function sitePlatformLimitMicros(settings: SitePlatformSettings): number | null {
  const limit = Math.round(settings.sitesPlatformMonthlyLimitUsd * 1_000_000);
  return limit > 0 ? limit : null;
}

/** How long a process trusts a brake read. */
export const SITE_PLATFORM_BRAKE_CACHE_MS = 15_000;
/** How often a process re-evaluates the Opengeni-wide estimate after metering. */
export const SITE_PLATFORM_EVALUATE_INTERVAL_MS = 30_000;

type BrakeCache = { at: number; brake: SitePlatformBrakeRecord };
let brakeCache: BrakeCache | null = null;
let lastEvaluation = 0;
let evaluating: Promise<void> | null = null;

/** Forget cached brake state and the evaluation throttle (tests). */
export function resetSitePlatformBrakeCache(): void {
  brakeCache = null;
  lastEvaluation = 0;
}

async function cachedBrake(deps: SitePlatformDeps): Promise<SitePlatformBrakeRecord> {
  const now = Date.now();
  const period = `${new Date(now).toISOString().slice(0, 7)}-01`;
  if (
    brakeCache &&
    now - brakeCache.at < SITE_PLATFORM_BRAKE_CACHE_MS &&
    brakeCache.brake.periodStart === period
  )
    return brakeCache.brake;
  const brake = await readSitePlatformBrake(deps.db, new Date(now));
  brakeCache = { at: now, brake };
  return brake;
}

export type SitePlatformBrakedAction = "sql_write" | "publish" | "guest_agent";

const BRAKE_MESSAGES: Record<SitePlatformBrakedAction, string> = {
  sql_write:
    "Opengeni has paused new Site database writes for the rest of the month. Published pages keep working.",
  publish:
    "Opengeni has paused publishing for the rest of the month. Published pages keep working.",
  guest_agent:
    "Opengeni has paused Site assistants for visitors for the rest of the month. Published pages keep working.",
};

/** The 503 a braked action gets. */
export function sitePlatformBrakeError(action: SitePlatformBrakedAction): ApiHttpError {
  return new ApiHttpError(503, {
    code: "limit_exceeded",
    message: BRAKE_MESSAGES[action],
    retryable: false,
    outcomeUnknown: false,
    details: { code: SITE_PLATFORM_BRAKE_ERROR_CODE, action },
  });
}

/**
 * Run a brake check for a first-party agent tool: null when it passes, else
 * the refusal as a tool result (details.code site_platform_brake_engaged).
 */
export async function sitePlatformBrakeToolRefusal(check: () => Promise<void>) {
  try {
    await check();
    return null;
  } catch (error) {
    if (
      error instanceof ApiHttpError &&
      error.details?.code === SITE_PLATFORM_BRAKE_ERROR_CODE
    )
      return {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: { code: SITE_PLATFORM_BRAKE_ERROR_CODE, message: error.message },
            }),
          },
        ],
      };
    throw error;
  }
}

/** Whether the Opengeni-wide brake is engaged (cached per process for 15 seconds). */
export async function sitePlatformBrakeEngaged(deps: SitePlatformDeps): Promise<boolean> {
  const brake = await cachedBrake(deps);
  if (brake.engagedAt === null) return false;
  // With the limit off (0) only an operator-engaged brake holds.
  return sitePlatformLimitMicros(deps.settings) !== null || brake.engagedBy === "operator";
}

/** Refuse a braked action while the brake is engaged. A failed read never refuses. */
export async function requireSitePlatformOpen(
  deps: SitePlatformDeps,
  action: SitePlatformBrakedAction,
): Promise<void> {
  let engaged = false;
  try {
    engaged = await sitePlatformBrakeEngaged(deps);
  } catch (error) {
    console.warn("[site-platform] could not read the platform brake", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (engaged) throw sitePlatformBrakeError(action);
}

/**
 * Re-evaluate the Opengeni-wide estimate: the month's totals of every
 * workspace and the current storage level, at the configured prices. At the
 * alert threshold operators are alerted once a month (a structured log line,
 * `site_platform_limit_alert`; Opengeni has no operator mailer); at the limit
 * the brake engages (`site_platform_brake_engaged`) unless an operator lifted
 * it this month.
 */
export async function evaluateSitePlatformLimit(
  deps: SitePlatformDeps,
  now: Date = new Date(),
): Promise<{ estimateMicros: number; limitMicros: number | null; brake: SitePlatformBrakeRecord }> {
  const totals = await readSitePlatformTotals(deps.db, now);
  const estimateMicros = sitePlatformEstimateMicros(deps.settings, totals);
  const limitMicros = sitePlatformLimitMicros(deps.settings);
  if (limitMicros === null)
    return { estimateMicros, limitMicros, brake: await readSitePlatformBrake(deps.db, now) };
  const alertMicros = Math.floor((limitMicros * deps.settings.sitesPlatformAlertPercent) / 100);
  const result = await evaluateSitePlatformBrake(deps.db, {
    estimateMicros,
    alert: estimateMicros >= alertMicros,
    limit: estimateMicros >= limitMicros,
    now,
  });
  const detail = {
    periodStart: totals.periodStart,
    estimateUsd: estimateMicros / 1_000_000,
    limitUsd: limitMicros / 1_000_000,
    percent: Math.round((estimateMicros / limitMicros) * 1000) / 10,
    requests: totals.requests,
    sqlRowsRead: totals.sqlRowsRead,
    sqlRowsWritten: totals.sqlRowsWritten,
    storageBytes: totals.storageBytes,
  };
  if (result.alerted)
    console.warn(JSON.stringify({ event: "site_platform_limit_alert", ...detail }));
  if (result.engaged) {
    console.warn(JSON.stringify({ event: "site_platform_brake_engaged", by: "auto", ...detail }));
    brakeCache = { at: Date.now(), brake: result.brake };
  }
  return { estimateMicros, limitMicros, brake: result.brake };
}

/**
 * After usage was metered: charge it (shadow and credits modes) and, at most
 * every 30 seconds per process, re-evaluate the Opengeni-wide limit. Never
 * throws.
 */
export async function afterSitePlatformUsage(
  deps: SitePlatformDeps,
  scope: SitePlatformScope,
  usage: SitePlatformUsageRecord,
): Promise<void> {
  await settleSitePlatformCharges(deps, scope, usage);
  if (sitePlatformLimitMicros(deps.settings) === null) return;
  const now = Date.now();
  if (evaluating || now - lastEvaluation < SITE_PLATFORM_EVALUATE_INTERVAL_MS) return;
  lastEvaluation = now;
  evaluating = evaluateSitePlatformLimit(deps)
    .then(() => undefined)
    .catch((error: unknown) => {
      console.warn("[site-platform] could not evaluate the platform limit", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      evaluating = null;
    });
  await evaluating;
}
