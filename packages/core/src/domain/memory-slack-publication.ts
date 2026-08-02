import { createHash } from "node:crypto";
import {
  redactSensitiveText,
  stableJson,
  type KnowledgeMemoryKind,
  type KnowledgeMemoryStatus,
} from "@opengeni/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SELECTOR_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const MEMORY_SLACK_PROJECTION_VERSION = 1;
export const MEMORY_SLACK_SUMMARY_MAX_UTF8_BYTES = 512;
export const MEMORY_SLACK_NAMESPACE_MAX_UTF8_BYTES = 128;
export const MEMORY_SLACK_LABEL_MAX_UTF8_BYTES = 64;
export const MEMORY_SLACK_LABEL_MAX_COUNT = 8;
export const MEMORY_SLACK_OWNER_MAX_UTF8_BYTES = 96;
export const MEMORY_SLACK_PROJECTION_MAX_UTF8_BYTES = 4096;

export type MemorySlackImportance = "major" | "normal" | "minor";
export type MemorySlackRequestedMode = "auto" | "review" | "never";
export type MemorySlackDeliveryMode = Exclude<MemorySlackRequestedMode, "never">;
export type MemorySlackChangeKind = "created" | "corrected" | "superseded";
export type MemorySlackOrigin = "native" | "slack_derived";
export type MemorySlackAudience = "workspace" | "restricted";

export type MemorySlackPublicationPolicy = {
  enabled: boolean;
  autoImportances: readonly MemorySlackImportance[];
  reviewImportances: readonly MemorySlackImportance[];
};

/**
 * Nothing publishes without an explicit workspace-admin enablement. When
 * enabled without tuning, major changes may publish automatically, normal
 * changes require review, and minor changes stay quiet.
 */
export const DEFAULT_MEMORY_SLACK_PUBLICATION_POLICY = {
  enabled: false,
  autoImportances: ["major"],
  reviewImportances: ["normal"],
} as const satisfies MemorySlackPublicationPolicy;

export type MemorySlackPublicationInput = {
  context: {
    accountId: string;
    workspaceId: string;
    now: string;
  };
  policy?: MemorySlackPublicationPolicy | undefined;
  memory: {
    sourceType: "workspace_memory";
    accountId: string;
    workspaceId: string;
    id: string;
    version: number;
    status: KnowledgeMemoryStatus;
    kind: KnowledgeMemoryKind;
    scopeType: "workspace" | "user" | "role" | "session" | "ephemeral" | "legacy";
    namespace: string;
    labels: readonly string[];
    validFrom: string;
    validUntil: string | null;
    supersedesId: string | null;
    supersededById: string | null;
  };
  change: {
    kind: MemorySlackChangeKind;
    relatedMemoryId: string | null;
    occurredAt: string;
    origin: MemorySlackOrigin;
    ownerLabel?: string | null | undefined;
  };
  distribution: {
    importance: MemorySlackImportance;
    audience: MemorySlackAudience;
    slackMode: MemorySlackRequestedMode;
    shareSummary: string;
  };
};

export type MemorySlackPublicationDenialReason =
  | "disabled"
  | "invalid_input"
  | "unsupported_source"
  | "tenant_mismatch"
  | "not_decision"
  | "status_ineligible"
  | "restricted_scope"
  | "restricted_audience"
  | "not_yet_valid"
  | "expired"
  | "slack_origin_loop"
  | "mode_never"
  | "below_noise_policy"
  | "missing_summary"
  | "invalid_change_lineage";

export type MemorySlackPublicationProjection = {
  version: typeof MEMORY_SLACK_PROJECTION_VERSION;
  workspaceId: string;
  memoryId: string;
  memoryVersion: number;
  changeKind: MemorySlackChangeKind;
  relatedMemoryId: string | null;
  occurredAt: string;
  importance: MemorySlackImportance;
  deliveryMode: MemorySlackDeliveryMode;
  summary: string;
  summaryRedacted: boolean;
  summaryTruncated: boolean;
  namespace: string;
  labels: string[];
  labelsTruncated: boolean;
  ownerLabel: string | null;
  ownerLabelRedacted: boolean;
  ownerLabelTruncated: boolean;
  authoritativeRecord: {
    workspaceId: string;
    memoryId: string;
  };
};

export type MemorySlackPublicationDecision =
  | {
      eligible: false;
      reason: MemorySlackPublicationDenialReason;
    }
  | {
      eligible: true;
      deliveryMode: MemorySlackDeliveryMode;
      idempotencyKey: string;
      projection: MemorySlackPublicationProjection;
    };

const IMPORTANCES = new Set<MemorySlackImportance>(["major", "normal", "minor"]);
const REQUESTED_MODES = new Set<MemorySlackRequestedMode>(["auto", "review", "never"]);
const CHANGE_KINDS = new Set<MemorySlackChangeKind>(["created", "corrected", "superseded"]);
const ORIGINS = new Set<MemorySlackOrigin>(["native", "slack_derived"]);
const AUDIENCES = new Set<MemorySlackAudience>(["workspace", "restricted"]);
const SCOPE_TYPES = new Set<MemorySlackPublicationInput["memory"]["scopeType"]>([
  "workspace",
  "user",
  "role",
  "session",
  "ephemeral",
  "legacy",
]);
const MEMORY_STATUSES = new Set<KnowledgeMemoryStatus>([
  "proposed",
  "approved",
  "rejected",
  "active",
  "superseded",
  "archived",
]);
const MEMORY_KINDS = new Set<KnowledgeMemoryKind>([
  "semantic",
  "episodic",
  "procedural",
  "decision",
  "preference",
]);
const VISIBLE_STATUSES = new Set<KnowledgeMemoryStatus>(["active", "approved"]);

/**
 * Produce the only data shape a later delivery slice may persist or
 * render. This is a deterministic policy/security boundary, not a persistence
 * hook: callers must durably bind the returned projection and key in a later
 * transaction/outbox slice.
 */
export function evaluateMemorySlackPublication(
  input: MemorySlackPublicationInput,
): MemorySlackPublicationDecision {
  const policy = input.policy ?? DEFAULT_MEMORY_SLACK_PUBLICATION_POLICY;
  if (!validPolicy(policy)) return denied("invalid_input");
  if (!policy.enabled) return denied("disabled");

  if (input.memory.sourceType !== "workspace_memory") return denied("unsupported_source");
  if (!validIdentity(input)) return denied("invalid_input");
  if (
    input.memory.accountId !== input.context.accountId ||
    input.memory.workspaceId !== input.context.workspaceId
  ) {
    return denied("tenant_mismatch");
  }
  if (input.memory.kind !== "decision") return denied("not_decision");
  if (input.memory.scopeType !== "workspace") return denied("restricted_scope");
  if (input.distribution.audience !== "workspace") return denied("restricted_audience");
  if (input.change.origin === "slack_derived") return denied("slack_origin_loop");
  if (input.distribution.slackMode === "never") return denied("mode_never");

  const timeDecision = evaluateValidity(input);
  if (timeDecision) return denied(timeDecision);
  if (!statusEligibleForChange(input)) return denied("status_ineligible");
  if (!validChangeLineage(input)) return denied("invalid_change_lineage");

  const deliveryMode = effectiveDeliveryMode(policy, input.distribution);
  if (!deliveryMode) return denied("below_noise_policy");

  const collapsedSummary = collapseText(input.distribution.shareSummary);
  const redactedSummary = redactSensitiveText(collapsedSummary);
  if (!redactedSummary) return denied("missing_summary");
  const summary = truncateUtf8(redactedSummary, MEMORY_SLACK_SUMMARY_MAX_UTF8_BYTES);

  const namespace = normalizeNamespace(input.memory.namespace);
  const labels = normalizeLabels(input.memory.labels);
  if (!namespace || !labels) return denied("invalid_input");

  const owner = boundedOptionalText(input.change.ownerLabel, MEMORY_SLACK_OWNER_MAX_UTF8_BYTES);
  const projection: MemorySlackPublicationProjection = {
    version: MEMORY_SLACK_PROJECTION_VERSION,
    workspaceId: input.context.workspaceId,
    memoryId: input.memory.id,
    memoryVersion: input.memory.version,
    changeKind: input.change.kind,
    relatedMemoryId: input.change.relatedMemoryId,
    occurredAt: new Date(input.change.occurredAt).toISOString(),
    importance: input.distribution.importance,
    deliveryMode,
    summary: summary.value,
    summaryRedacted: redactedSummary !== collapsedSummary,
    summaryTruncated: summary.truncated,
    namespace,
    labels: labels.values,
    labelsTruncated: labels.truncated,
    ownerLabel: owner.value,
    ownerLabelRedacted: owner.redacted,
    ownerLabelTruncated: owner.truncated,
    authoritativeRecord: {
      workspaceId: input.context.workspaceId,
      memoryId: input.memory.id,
    },
  };

  if (utf8Bytes(stableJson(projection)) > MEMORY_SLACK_PROJECTION_MAX_UTF8_BYTES) {
    return denied("invalid_input");
  }

  const digest = createHash("sha256").update(stableJson(projection), "utf8").digest("hex");
  return {
    eligible: true,
    deliveryMode,
    idempotencyKey: `memory-slack:v${MEMORY_SLACK_PROJECTION_VERSION}:${digest}`,
    projection,
  };
}

function validPolicy(policy: MemorySlackPublicationPolicy): boolean {
  return (
    typeof policy.enabled === "boolean" &&
    Array.isArray(policy.autoImportances) &&
    Array.isArray(policy.reviewImportances) &&
    policy.autoImportances.every((importance) => IMPORTANCES.has(importance)) &&
    policy.reviewImportances.every((importance) => IMPORTANCES.has(importance))
  );
}

function validIdentity(input: MemorySlackPublicationInput): boolean {
  const uuids = [
    input.context.accountId,
    input.context.workspaceId,
    input.memory.accountId,
    input.memory.workspaceId,
    input.memory.id,
    input.memory.supersedesId,
    input.memory.supersededById,
    input.change.relatedMemoryId,
  ].filter((value): value is string => value !== null);
  return (
    uuids.every((value) => UUID_PATTERN.test(value)) &&
    Number.isSafeInteger(input.memory.version) &&
    input.memory.version > 0 &&
    IMPORTANCES.has(input.distribution.importance) &&
    REQUESTED_MODES.has(input.distribution.slackMode) &&
    CHANGE_KINDS.has(input.change.kind) &&
    ORIGINS.has(input.change.origin) &&
    AUDIENCES.has(input.distribution.audience) &&
    SCOPE_TYPES.has(input.memory.scopeType) &&
    MEMORY_STATUSES.has(input.memory.status) &&
    MEMORY_KINDS.has(input.memory.kind)
  );
}

function evaluateValidity(
  input: MemorySlackPublicationInput,
): "invalid_input" | "not_yet_valid" | "expired" | null {
  const now = Date.parse(input.context.now);
  const occurredAt = Date.parse(input.change.occurredAt);
  const validFrom = Date.parse(input.memory.validFrom);
  const validUntil = input.memory.validUntil === null ? null : Date.parse(input.memory.validUntil);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(occurredAt) ||
    !Number.isFinite(validFrom) ||
    (validUntil !== null && !Number.isFinite(validUntil)) ||
    (validUntil !== null && validUntil <= validFrom)
  ) {
    return "invalid_input";
  }
  if (now < validFrom) return "not_yet_valid";
  if (validUntil !== null && now >= validUntil) return "expired";
  return null;
}

function validChangeLineage(input: MemorySlackPublicationInput): boolean {
  switch (input.change.kind) {
    case "created":
      return (
        input.change.relatedMemoryId === null &&
        input.memory.supersedesId === null &&
        input.memory.supersededById === null
      );
    case "corrected":
      return (
        input.change.relatedMemoryId !== null &&
        input.memory.supersedesId === input.change.relatedMemoryId &&
        input.memory.supersededById === null
      );
    case "superseded":
      return (
        input.change.relatedMemoryId !== null &&
        input.memory.supersededById === input.change.relatedMemoryId
      );
  }
}

function statusEligibleForChange(input: MemorySlackPublicationInput): boolean {
  return input.change.kind === "superseded"
    ? input.memory.status === "superseded"
    : VISIBLE_STATUSES.has(input.memory.status);
}

function effectiveDeliveryMode(
  policy: MemorySlackPublicationPolicy,
  distribution: MemorySlackPublicationInput["distribution"],
): MemorySlackDeliveryMode | null {
  const auto = new Set(policy.autoImportances);
  const review = new Set(policy.reviewImportances);
  if (distribution.slackMode === "review") {
    return auto.has(distribution.importance) || review.has(distribution.importance)
      ? "review"
      : null;
  }
  if (auto.has(distribution.importance)) return "auto";
  if (review.has(distribution.importance)) return "review";
  return null;
}

function normalizeNamespace(value: string): string | null {
  const namespace = value.trim().toLowerCase();
  if (!namespace || utf8Bytes(namespace) > MEMORY_SLACK_NAMESPACE_MAX_UTF8_BYTES) return null;
  const segments = namespace.split("/");
  if (segments.some((segment) => !SELECTOR_SEGMENT_PATTERN.test(segment))) return null;
  return segments.join("/");
}

function normalizeLabels(
  values: readonly string[],
): { values: string[]; truncated: boolean } | null {
  if (!Array.isArray(values)) return null;
  const labels = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") return null;
    const label = value.trim().toLowerCase();
    if (
      !SELECTOR_SEGMENT_PATTERN.test(label) ||
      utf8Bytes(label) > MEMORY_SLACK_LABEL_MAX_UTF8_BYTES
    ) {
      return null;
    }
    labels.add(label);
  }
  const sorted = [...labels].sort();
  return {
    values: sorted.slice(0, MEMORY_SLACK_LABEL_MAX_COUNT),
    truncated: sorted.length > MEMORY_SLACK_LABEL_MAX_COUNT,
  };
}

function boundedOptionalText(
  value: string | null | undefined,
  maxBytes: number,
): { value: string | null; redacted: boolean; truncated: boolean } {
  const collapsed = collapseText(value ?? "");
  if (!collapsed) return { value: null, redacted: false, truncated: false };
  const redacted = redactSensitiveText(collapsed);
  const bounded = truncateUtf8(redacted, maxBytes);
  return {
    value: bounded.value || null,
    redacted: redacted !== collapsed,
    truncated: bounded.truncated,
  };
}

function collapseText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  const marker = "…";
  const markerBytes = encoder.encode(marker);
  let end = Math.max(0, maxBytes - markerBytes.byteLength);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    value: `${decoder.decode(bytes.subarray(0, end)).trimEnd()}${marker}`,
    truncated: true,
  };
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function denied(reason: MemorySlackPublicationDenialReason): MemorySlackPublicationDecision {
  return { eligible: false, reason };
}
