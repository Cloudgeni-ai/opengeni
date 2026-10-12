import type { SubscriptionQuota } from "@opengeni/subscriptions";
import { decodeSubscriptionQuota } from "../subscription-core-repository";
import type { SubscriptionCoreConnectionRow } from "./administration";

/** A cached observation, not a fresh usage check or an account eligibility decision. */
export type SubscriptionCoreAccountUsage = {
  /** Snapshot-level time only: retained windows have no individual observation timestamps. */
  observedAt: string | null;
  source: SubscriptionQuota["source"];
  windows: Array<{
    id: string;
    usedPercent: number | null;
    resetsAt: string | null;
    status: SubscriptionQuota["windows"][number]["status"];
  }>;
  exhaustedUntil: string | null;
  exhaustedKind: SubscriptionQuota["exhaustedKind"];
};

type UsageRow = Pick<
  SubscriptionCoreConnectionRow,
  "quota" | "quota_revision" | "quota_observed_refresh_generation" | "quota_updated_at"
>;

function iso(epoch: number | null): string | null {
  if (epoch === null || !Number.isFinite(epoch)) return null;
  const date = new Date(epoch);
  // The public datetime contract uses four-digit years, not extended ISO years.
  return Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() >= 0 &&
    date.getUTCFullYear() <= 9999
    ? date.toISOString()
    : null;
}

/**
 * Project only a row already authorized by the account-list reader. Null means
 * this visible account has no decodable stored observation, never that a hidden
 * account was inspected. No I/O, credential metadata, raw provider payloads or
 * new authorization path belongs here.
 *
 * Keep partial/unknown windows and past resets as observed; neither elapsed time
 * nor an absent window proves replenishment. A snapshot can combine observations,
 * so its source/time does not assert per-window freshness or completeness. Token
 * refreshes do not erase historical readings: the existing decoder requires the
 * stored generation marker, not equality with a current credential version.
 * Routing/allocator decisions and model cooldowns remain on their existing paths.
 */
export function projectSubscriptionCoreAccountUsage(
  row: UsageRow,
): SubscriptionCoreAccountUsage | null {
  const quota = decodeSubscriptionQuota(row);
  if (!quota) return null;
  return {
    observedAt: iso(quota.observedAt),
    source: quota.source,
    windows: quota.windows.map((window) => ({
      id: window.id,
      // Retain values over 100 (overage), but do not present negative
      // utilization as real capacity.
      usedPercent:
        window.usedPercent !== null && window.usedPercent >= 0 ? window.usedPercent : null,
      resetsAt: iso(window.resetsAt),
      status: window.status,
    })),
    exhaustedUntil: iso(quota.exhaustedUntil),
    exhaustedKind: quota.exhaustedKind,
  };
}
