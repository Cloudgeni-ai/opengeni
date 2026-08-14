import { createHash } from "node:crypto";

const MAX_PROVIDER_BYTES = 256;
const MAX_FINGERPRINT_BYTES = 1_024;
const MAX_LABELS = 256;
const MAX_LABEL_KEY_BYTES = 256;
const MAX_LABEL_VALUE_BYTES = 4_096;
const OFFSET_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

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
};

/**
 * Derive one content-free, workspace-bound identity for an Alertmanager-style
 * alert occurrence. Missing or malformed metadata deliberately returns null so
 * ordinary scheduled tasks retain their existing new-session-per-run behavior.
 */
export function scheduledAlertOccurrenceIdentity(input: {
  workspaceId: string;
  metadata: Record<string, unknown>;
}): ScheduledAlertOccurrenceIdentity | null {
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
  if (typeof value !== "string" || !OFFSET_TIMESTAMP.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
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
