import type {
  MemberAllowanceUsage,
  UsageAllowanceStatus,
  WorkspaceAllowanceUsage,
  WorkspaceUsageResponse,
} from "@opengeni/sdk/usage-allowances";

import type { AllowanceScope } from "./allowance-copy";

/** One ceiling as a person reads it: how much of it is used, and when it resets. */
export type UsageReading = {
  scope: AllowanceScope;
  /** Used share of the ceiling. Can exceed 1 after post-call overshoot. */
  fraction: number;
  status: UsageAllowanceStatus;
  resetsAt: string | null;
  /** USD micros. Only shown when a host opts in with `formatAmount`. */
  used: number;
  limit: number;
  remaining: number;
};

/**
 * What a member can still do: `unlimited` when no ceiling applies, otherwise
 * the state of whichever ceiling stops them first (`binding`).
 */
export type UsageSummary = {
  state: "unlimited" | "ok" | "warning" | "exhausted";
  /** The ceiling a person would ask to raise; null when unlimited. */
  binding: UsageReading | null;
  /** Their own ceiling, when one applies. */
  member: UsageReading | null;
  /** The shared workspace pool, when one is set. */
  workspace: UsageReading | null;
};

function reading(
  scope: AllowanceScope,
  usage: Pick<
    WorkspaceAllowanceUsage | MemberAllowanceUsage,
    "limit" | "used" | "remaining" | "fraction" | "status" | "resetsAt"
  >,
): UsageReading | null {
  if (usage.limit === null) return null;
  return {
    scope,
    fraction: usage.fraction ?? (usage.limit === 0 ? 1 : usage.used / usage.limit),
    status: usage.status,
    resetsAt: usage.resetsAt,
    used: usage.used,
    limit: usage.limit,
    remaining: Math.max(0, usage.remaining ?? usage.limit - usage.used),
  };
}

/**
 * Fold a usage response (normally `/usage/me`) into what to tell one member.
 * The server's `status` decides warning/exhausted (it applies the configured
 * thresholds); when both ceilings apply, the one with less room left binds.
 */
export function summarizeUsage(
  usage: WorkspaceUsageResponse,
  subjectId?: string | undefined,
): UsageSummary {
  const row =
    subjectId === undefined
      ? usage.members[0]
      : usage.members.find((member) => member.subjectId === subjectId);
  const member = row ? reading("member", row) : null;
  const workspace = reading("workspace", usage.workspace);
  const readings = [member, workspace].filter((value): value is UsageReading => value !== null);
  if (readings.length === 0) return { state: "unlimited", binding: null, member, workspace };
  // Raising a member ceiling cannot help while the shared pool is spent, so an
  // exhausted workspace binds first.
  const exhausted =
    (workspace?.status === "exhausted" ? workspace : null) ??
    (member?.status === "exhausted" ? member : null);
  if (exhausted) return { state: "exhausted", binding: exhausted, member, workspace };
  const warnings = readings.filter((value) => value.status === "warning");
  const candidates = warnings.length > 0 ? warnings : readings;
  const binding = candidates.reduce((tightest, value) =>
    value.remaining < tightest.remaining ? value : tightest,
  );
  return { state: warnings.length > 0 ? "warning" : "ok", binding, member, workspace };
}

/** A whole-number percentage for display: "<1" for a sliver, never "0" for some use. */
export function usagePercentLabel(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return "0";
  if (fraction < 0.01) return "<1";
  if (fraction < 1 && Math.round(fraction * 100) === 100) return "99";
  return String(Math.round(fraction * 100));
}
