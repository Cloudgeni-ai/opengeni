import { createHash } from "node:crypto";

const MAX_SCHEDULED_TASK_ID_BYTES = 256;
const MAX_STARTS_AT_BYTES = 256;
const MAX_PROVIDER_BYTES = 256;
const MAX_FINGERPRINT_BYTES = 1_024;
const MAX_LABELS = 256;
const MAX_LABEL_KEY_BYTES = 256;
const MAX_LABEL_VALUE_BYTES = 4_096;
const OFFSET_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export type ScheduledAlertOccurrenceDeclaration = {
  status: "firing" | "resolved";
  startsAt: string;
  fingerprint: string;
  labels: Record<string, string>;
  provider?: string;
};

export type ScheduledAlertOccurrenceIdentity = {
  status: "firing" | "resolved";
  sessionCreateIdempotencyKey: string;
  /** Exact bounded labels from the validated structured occurrence. */
  labels: Readonly<Record<string, string>>;
};

/**
 * Bind the series-stable occurrence identity to one accepted task execution
 * definition. A later task revision must not adopt the prior responder root,
 * because that session has already frozen the old prompt/tool/authority policy.
 */
export function scheduledAlertResponderSessionCreateIdempotencyKey(input: {
  occurrence: ScheduledAlertOccurrenceIdentity;
  taskAuthorityRevision: number;
  taskExecutionDigest: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        occurrenceKey: input.occurrence.sessionCreateIdempotencyKey,
        taskAuthorityRevision: input.taskAuthorityRevision,
        taskExecutionDigest: input.taskExecutionDigest,
      }),
    )
    .digest("hex");
  return `scheduled-alert-occurrence:v1:${digest}`;
}

/**
 * Derive one content-free, workspace-bound identity for an Alertmanager-style
 * alert occurrence. Missing or malformed metadata deliberately returns null so
 * ordinary scheduled tasks retain their existing new-session-per-run behavior.
 */
export function scheduledAlertOccurrenceIdentity(input: {
  workspaceId: string;
  scheduledTaskId: string;
  metadata: Record<string, unknown>;
}): ScheduledAlertOccurrenceIdentity | null {
  const scheduledTaskId = boundedString(input.scheduledTaskId, MAX_SCHEDULED_TASK_ID_BYTES);
  if (!scheduledTaskId) return null;

  const alert = record(input.metadata.alert);
  if (!alert) return null;

  const status = alert.status;
  if (status !== "firing" && status !== "resolved") return null;

  const startsAt = canonicalTimestamp(alert.startsAt);
  const fingerprint = boundedString(alert.fingerprint, MAX_FINGERPRINT_BYTES);
  const labels = canonicalLabels(alert.labels);
  if (!startsAt || !fingerprint || !labels) return null;

  const provider = boundedString(
    alert.provider ?? input.metadata.alertProvider ?? input.metadata.provider ?? "alertmanager",
    MAX_PROVIDER_BYTES,
  );
  if (!provider) return null;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        workspaceId: input.workspaceId,
        scheduledTaskId,
        provider,
        fingerprint,
        startsAt,
        labels,
      }),
    )
    .digest("hex");
  return {
    status,
    sessionCreateIdempotencyKey: `scheduled-alert-occurrence:v1:${digest}`,
    labels: Object.fromEntries(labels),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes) return null;
  return normalized;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_STARTS_AT_BYTES) return null;
  const match = OFFSET_TIMESTAMP.exec(trimmed);
  if (!match) return null;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? trimmed : null;
}

function canonicalLabels(value: unknown): Array<readonly [string, string]> | null {
  const labels = record(value);
  if (!labels) return null;
  const entries = Object.entries(labels);
  if (entries.length === 0 || entries.length > MAX_LABELS) return null;
  const canonical: Array<readonly [string, string]> = [];
  for (const [key, rawValue] of entries) {
    if (
      !key ||
      Buffer.byteLength(key, "utf8") > MAX_LABEL_KEY_BYTES ||
      typeof rawValue !== "string" ||
      Buffer.byteLength(rawValue, "utf8") > MAX_LABEL_VALUE_BYTES
    ) {
      return null;
    }
    canonical.push([key, rawValue]);
  }
  return canonical.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
