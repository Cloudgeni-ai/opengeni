import type { ClaudeSubscriptionUsage, ClaudeUsageWindow } from "@opengeni/contracts";

const UNKNOWN_RESET_RECHECK_MS = 60_000;
const allowed = (status: ClaudeUsageWindow["status"]) =>
  status === "allowed" || status === "allowed_warning";

/** Evaluate provider-reported plan capacity and its explicitly allowed paid fallback. */
export function claudeSubscriptionCapacity(
  usage: ClaudeSubscriptionUsage,
  upstreamModelId: string,
  now: Date,
  options: { allowOverage?: boolean } = {},
): { available: boolean; nextCheckAt: Date | null; blockingWindows: ClaudeUsageWindow["id"][] } {
  const available = { available: true, nextCheckAt: null, blockingWindows: [] };
  if (!usage.connected || usage.refreshStatus === "reconnect")
    return { ...available, available: false };
  const relevant = (id: ClaudeUsageWindow["id"]): boolean => {
    if (id === "seven_day_opus") return /^claude-opus-/.test(upstreamModelId);
    if (id === "seven_day_sonnet") return /^claude-sonnet-/.test(upstreamModelId);
    return id === "five_hour" || id === "seven_day";
  };
  const applicable = usage.windows.filter((window) => relevant(window.id));
  const relevantClaim = (id: ClaudeUsageWindow["id"] | null) =>
    id === "seven_day_opus" || id === "seven_day_sonnet" ? relevant(id) : true;
  const restrictions = (usage.requestRestrictions ?? []).filter(
    (item) =>
      item.status === "rejected" &&
      (item.upstreamModelId === upstreamModelId ||
        (item.upstreamModelId === null && relevantClaim(item.representativeClaim))) &&
      !applicable.some(
        (window) =>
          window.source === "provider" &&
          window.usedPercent !== null &&
          window.usedPercent < 100 &&
          window.id === item.representativeClaim &&
          window.observedAt > item.observedAt,
      ) &&
      (item.resetsAt
        ? Date.parse(item.resetsAt)
        : Date.parse(item.observedAt) + UNKNOWN_RESET_RECHECK_MS) > now.getTime(),
  );
  const blocking = applicable.filter((window) => {
    if (
      (window.resetsAt
        ? Date.parse(window.resetsAt)
        : Date.parse(window.observedAt) + UNKNOWN_RESET_RECHECK_MS) <= now.getTime()
    )
      return false;
    return (
      window.status === "rejected" || (window.status === null && (window.usedPercent ?? 0) >= 100)
    );
  });
  const request = usage.requestStatus;
  const exactModel = request?.upstreamModelId === upstreamModelId;
  const relevantRequest =
    request &&
    (exactModel ||
      (request.upstreamModelId === null && relevantClaim(request.representativeClaim)));
  const freshRequest =
    relevantRequest &&
    applicable.every((window) => window.observedAt <= request.observedAt) &&
    restrictions.every((item) => item.observedAt <= request.observedAt);
  const planResetElapsed =
    request &&
    (request.resetsAt
      ? Date.parse(request.resetsAt)
      : Date.parse(request.observedAt) + UNKNOWN_RESET_RECHECK_MS) <= now.getTime();
  const exactAllowance = (usage.requestRestrictions ?? []).find(
    (item) =>
      item.upstreamModelId === upstreamModelId &&
      allowed(item.status) &&
      blocking.every((window) => window.observedAt < item.observedAt) &&
      restrictions.every((restriction) => restriction.observedAt < item.observedAt),
  );
  if (exactAllowance) return available;
  // An allowed response for Sonnet never overrides an independently observed
  // Opus cap. Only the exact model's fresh response proves overall dispatch.
  if (freshRequest && exactModel && allowed(request.status) && !planResetElapsed) return available;
  const mayUseOverage = options.allowOverage !== false;
  const overageResetElapsed =
    request?.overageResetsAt && Date.parse(request.overageResetsAt) <= now.getTime();
  if (
    freshRequest &&
    request.status === "rejected" &&
    mayUseOverage &&
    allowed(request.overageStatus) &&
    !overageResetElapsed
  )
    return available;
  const rejectedRequest = freshRequest && request.status === "rejected" && !planResetElapsed;
  if (blocking.length === 0 && !rejectedRequest && restrictions.length === 0) return available;
  // An extra-usage balance is a separate fallback. Its rejection does not block
  // an available base plan or delay the next base-plan reset to a monthly date.
  const resets = blocking.map((window) =>
    window.resetsAt
      ? Date.parse(window.resetsAt)
      : Date.parse(window.observedAt) + UNKNOWN_RESET_RECHECK_MS,
  );
  if (rejectedRequest)
    resets.push(
      request.resetsAt
        ? Date.parse(request.resetsAt)
        : Date.parse(request.observedAt) + UNKNOWN_RESET_RECHECK_MS,
    );
  resets.push(
    ...restrictions.map((item) =>
      item.resetsAt
        ? Date.parse(item.resetsAt)
        : Date.parse(item.observedAt) + UNKNOWN_RESET_RECHECK_MS,
    ),
  );
  let nextCheckAt = Math.max(...resets);
  if (
    rejectedRequest &&
    mayUseOverage &&
    request.overageStatus === "rejected" &&
    request.overageResetsAt
  ) {
    const overageReset = Date.parse(request.overageResetsAt);
    // A known reset permits a new authoritative probe, never invents a reading.
    if (overageReset <= now.getTime()) return available;
    nextCheckAt = Math.min(nextCheckAt, overageReset);
  }
  return {
    available: false,
    nextCheckAt: new Date(nextCheckAt),
    blockingWindows: blocking.map((window) => window.id),
  };
}
