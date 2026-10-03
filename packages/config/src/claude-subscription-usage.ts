import {
  ClaudeUsageWindowId,
  type ClaudeSubscriptionUsage,
  type ClaudeUsageWindow,
  type ClaudeUsageRequestStatus,
} from "@opengeni/contracts";

export type ClaudeUsageObservation = {
  windows: ClaudeUsageWindow[];
  observedAt: string;
  source: "response_headers" | "provider";
  requestStatus?: ClaudeUsageRequestStatus | null;
  requestRestrictions?: ClaudeUsageRequestStatus[];
};
const prefixes: Record<string, string[]> = {
  five_hour: ["5h"],
  seven_day: ["7d"],
  seven_day_opus: ["7d-opus"],
  seven_day_sonnet: ["7d-sonnet"],
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
      }
    : null;
}

export function parseClaudeUsageResponse(
  value: unknown,
  now = new Date(),
): ClaudeUsageObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const observedAt = now.toISOString();
  const windows = ClaudeUsageWindowId.options.flatMap((id) => {
    const window = (value as Record<string, unknown>)[id];
    if (!window || typeof window !== "object" || Array.isArray(window)) return [];
    const fields = window as Record<string, unknown>;
    const usedPercent = percent(fields.utilization, 1);
    const time = typeof fields.resets_at === "string" ? Date.parse(fields.resets_at) : NaN;
    const resetsAt = Number.isFinite(time) ? new Date(time).toISOString() : null;
    if (usedPercent === null && resetsAt === null) return [];
    return [{ id, usedPercent, resetsAt, status: null, observedAt }];
  });
  return windows.length ? { windows, observedAt, source: "provider" } : null;
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
