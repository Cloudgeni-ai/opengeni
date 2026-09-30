import {
  ClaudeUsageWindowId,
  type ClaudeSubscriptionUsage,
  type ClaudeUsageWindow,
} from "@opengeni/contracts";

export type ClaudeUsageObservation = {
  windows: ClaudeUsageWindow[];
  observedAt: string;
  source: "response_headers" | "provider";
};
const prefixes: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d-opus",
  seven_day_sonnet: "7d-sonnet",
  seven_day_overage_included: "7d-overage-included",
  overage: "overage",
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

export function parseClaudeUsageHeaders(
  headers: Headers,
  now = new Date(),
): ClaudeUsageObservation | null {
  const observedAt = now.toISOString();
  const windows = ClaudeUsageWindowId.options.flatMap((id) => {
    const prefix = `anthropic-ratelimit-unified-${prefixes[id]}`;
    const usedPercent = percent(headers.get(`${prefix}-utilization`), 100);
    const resetsAt = epoch(headers.get(`${prefix}-reset`));
    const windowStatus = status(headers.get(`${prefix}-status`));
    if (usedPercent === null && resetsAt === null && windowStatus === null) return [];
    return [{ id, usedPercent, resetsAt, status: windowStatus, observedAt }];
  });
  return windows.length ? { windows, observedAt, source: "response_headers" } : null;
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
  for (const window of observation.windows) {
    const previous = windows.get(window.id);
    if (!previous || previous.observedAt <= window.observedAt) windows.set(window.id, window);
  }
  const newest = !current.observedAt || current.observedAt <= observation.observedAt;
  return {
    ...current,
    windows: ClaudeUsageWindowId.options.flatMap((id) =>
      windows.has(id) ? [windows.get(id)!] : [],
    ),
    ...(newest ? { observedAt: observation.observedAt, source: observation.source } : {}),
  };
}
