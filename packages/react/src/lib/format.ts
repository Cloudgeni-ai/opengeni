/** Compact relative time: "now", "42s", "7m", "3h", "2d", then a date. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 10) {
    return "now";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 14) {
    return `${days}d`;
  }
  return new Date(iso).toLocaleDateString();
}

/** Human-readable byte size: "512 B", "8.0 KB", "1.4 MB", "3 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === "GB") {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

/** Single-line preview of arbitrary text, for tiles and collapsed rows. */
export function truncate(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Render an unknown payload as readable text (pretty JSON when possible). */
export function stringifyPayload(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed !== undefined && typeof parsed === "object") {
      return stringifyPayload(parsed);
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** JSON.parse that returns `undefined` instead of throwing. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The canonical credit-death sentence. Credit exhaustion is the one failure a
 * user can fix themselves — the copy must say what happened (empty balance),
 * what to do (add credits), and what is safe (nothing was lost). Crucially it
 * must NOT say "send a message to revive": a revive turn burns credits the
 * workspace no longer has.
 */
export const CREDIT_EXHAUSTION_MESSAGE =
  "Out of OpenGeni credits — this workspace's balance is empty. Add credits to continue; the conversation is preserved.";

/**
 * Does this failure/completion payload (or raw error string) mean the
 * workspace ran out of OpenGeni credits? Matches the engine's
 * "insufficient OpenGeni credits" text (case-insensitive, substring — it
 * arrives both bare and wrapped in "Activity task failed: …") and the
 * budget-exhausted segment limit the engine stamps on a turn it ended early.
 */
export function isCreditExhaustion(
  input: { error?: string | null; detail?: string | null; segmentLimit?: string | null } | string,
): boolean {
  if (typeof input === "string") {
    return input.toLowerCase().includes("insufficient opengeni credits");
  }
  if (input.segmentLimit === "budget_exhausted") {
    return true;
  }
  for (const text of [input.error, input.detail]) {
    if (typeof text === "string" && text.toLowerCase().includes("insufficient opengeni credits")) {
      return true;
    }
  }
  return false;
}

/**
 * Humanize engine/provider failure text before it reaches the timeline or a
 * failure banner. Raw provider errors leak the wrong audience's instructions —
 * "Incorrect API key … find your API key at platform.openai.com" tells a
 * managed-deployment USER to fix credentials only an OPERATOR controls (and is
 * flatly wrong for Azure or subscription-backed engines). Auth, quota, and
 * credit-exhaustion failures collapse to one neutral, honest sentence; every
 * other reason passes through untouched. Raw payloads stay available in the
 * debug surfaces.
 */
export function humanizeFailureReason(reason: string | null): string | null {
  if (!reason) {
    return reason;
  }
  if (isCreditExhaustion(reason)) {
    return CREDIT_EXHAUSTION_MESSAGE;
  }
  const normalized = reason.toLowerCase();
  const authFailure =
    normalized.includes("incorrect api key") ||
    normalized.includes("invalid api key") ||
    normalized.includes("invalid_api_key") ||
    normalized.includes("platform.openai.com/account/api-keys") ||
    (normalized.includes("401") && (normalized.includes("api key") || normalized.includes("unauthorized")));
  if (authFailure) {
    return "The model provider rejected this deployment's engine credentials. Sending messages won't help until the deployment's engine configuration is fixed.";
  }
  const quotaFailure =
    normalized.includes("insufficient_quota") ||
    normalized.includes("exceeded your current quota");
  if (quotaFailure) {
    return "The model provider refused the request: this deployment's provider quota is exhausted.";
  }
  return reason;
}
