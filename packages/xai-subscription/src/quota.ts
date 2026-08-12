import type { XaiFetchLike } from "./fetch";
import { fetchXaiProxyJson, type XaiProxyAuthContext } from "./proxy";

export type XaiUsagePeriod = {
  type: string | null;
  start: Date | null;
  end: Date | null;
};

export type XaiSubscriptionQuota = {
  usedPercent: number | null;
  period: XaiUsagePeriod | null;
  prepaidBalanceCents: number | null;
  onDemandCapCents: number | null;
  onDemandUsedCents: number | null;
  onDemandEnabled: boolean | null;
  unifiedBilling: boolean | null;
  subscriptionTier: string | null;
  checkedAt: Date;
};

export async function fetchXaiSubscriptionQuota(input: {
  context: XaiProxyAuthContext;
  fetch?: XaiFetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}): Promise<XaiSubscriptionQuota> {
  const body = await fetchXaiProxyJson<Record<string, unknown>>({
    path: "billing?format=credits",
    context: input.context,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    label: "billing request",
  });
  const config = record(body.config);
  const currentPeriod = record(config?.currentPeriod ?? config?.current_period);
  const monthlyLimit = cents(config?.monthlyLimit ?? config?.monthly_limit);
  const used = cents(config?.used);
  const directPercent = finitePercent(config?.creditUsagePercent ?? config?.credit_usage_percent);
  const derivedPercent =
    monthlyLimit !== null && monthlyLimit > 0 && used !== null
      ? Math.max(0, Math.min(100, (used / monthlyLimit) * 100))
      : null;
  const period = currentPeriod
    ? {
        type: stringOrNull(currentPeriod.type),
        start: dateOrNull(currentPeriod.start),
        end: dateOrNull(currentPeriod.end),
      }
    : legacyPeriod(config);
  return {
    usedPercent: directPercent ?? derivedPercent,
    period,
    prepaidBalanceCents: cents(config?.prepaidBalance ?? config?.prepaid_balance),
    onDemandCapCents: cents(config?.onDemandCap ?? config?.on_demand_cap),
    onDemandUsedCents: cents(config?.onDemandUsed ?? config?.on_demand_used),
    onDemandEnabled: booleanOrNull(body.onDemandEnabled ?? body.on_demand_enabled),
    unifiedBilling: booleanOrNull(config?.isUnifiedBillingUser ?? config?.is_unified_billing_user),
    subscriptionTier: stringOrNull(body.subscriptionTier ?? body.subscription_tier),
    checkedAt: new Date(),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cents(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  const object = record(value);
  const candidate = object?.val;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) ? candidate : null;
}

function finitePercent(value: unknown): number | null {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.max(0, Math.min(100, candidate)) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function legacyPeriod(config: Record<string, unknown> | null): XaiUsagePeriod | null {
  const start = dateOrNull(config?.billingPeriodStart ?? config?.billing_period_start);
  const end = dateOrNull(config?.billingPeriodEnd ?? config?.billing_period_end);
  return start || end ? { type: null, start, end } : null;
}
