import type { ModelAccountUsageSnapshot } from "@opengeni/sdk";
import type { SubscriptionAccountUsageWindow } from "./subscription-account-menu";

// Presentation labels only. Preserve every supplied window; never combine
// family-specific, overage or partial windows into an account capacity score.
const WINDOW_LABEL: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  five_hour: "5h",
  seven_day: "Week",
  seven_day_opus: "Week · Opus",
  seven_day_sonnet: "Week · Sonnet",
  overage: "Overage",
  billing: "Billing",
};

function time(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function modelAccountUsage(
  usage: ModelAccountUsageSnapshot | null | undefined,
  now = Date.now(),
): {
  windows?: SubscriptionAccountUsageWindow[];
  message?: string;
  note?: string;
  summary?: string;
} {
  // An omitted projection is not evidence the underlying provider has no data.
  if (usage === undefined) return { message: "Usage not reported" };
  if (usage === null) return { message: "No stored usage" };
  const observed = time(usage.observedAt);
  const note = observed ? `Cached observation · ${observed}` : "Cached observation · Time unknown";
  const windows = usage.windows.map((window) => {
    const reset = time(window.resetsAt);
    const past = reset !== null && Date.parse(window.resetsAt!) <= now;
    return {
      label: WINDOW_LABEL[window.id] ?? window.id,
      usedPercent: window.usedPercent,
      detail: [
        window.status === "unknown"
          ? "Status unknown"
          : window.status === "ok"
            ? null
            : window.status === "warning"
              ? "Observed warning"
              : "Observed exhausted",
        past
          ? "Reset time passed; current usage unknown"
          : reset
            ? `Resets ${reset}`
            : "Reset time unknown",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
  const exhaustedTime = time(usage.exhaustedUntil);
  const exhaustion =
    usage.exhaustedKind === "rate_limit"
      ? "Recorded rate limit"
      : usage.exhaustedKind === "quota"
        ? "Recorded quota exhaustion"
        : null;
  return {
    windows,
    ...(windows.length === 0
      ? {
          message: exhaustion
            ? `${exhaustion}${exhaustedTime ? ` until ${exhaustedTime}` : " · End time unknown"}`
            : "No usage windows recorded",
        }
      : {}),
    note,
    ...(windows.length > 0
      ? {
          summary: `Cached · ${windows.map((window) => `${window.label} ${window.usedPercent === null ? "unknown" : `${Math.round(window.usedPercent!)}% used`}`).join(" · ")}`,
        }
      : {}),
  };
}
