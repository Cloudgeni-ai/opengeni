import { z } from "zod";

/** Opt-in observational evidence, separate from body-free request lifecycle events. */
export const MODEL_REQUEST_EVIDENCE_EVENT = "agent.model.evidence" as const;
export type ModelEvidencePurpose = "main" | "session-title" | "compaction";
export type ModelEvidencePhysicalRequest = {
  requestId: string;
  transportAttempt: number;
  identitySource: "codex_custody" | "local_fetch";
};
export type ModelRequestEvidence = {
  version: 1;
  scopeId: string;
  ordinal: number;
  purpose: ModelEvidencePurpose;
  kind: "scope_open" | "request" | "wire_request" | "response" | "usage" | "scope_close";
  physical?: ModelEvidencePhysicalRequest;
  provider?: string;
  responseId?: string;
  status: "captured" | "unavailable";
  reason?: string;
  /** Exact-byte source hash before intentional credential redaction, when available. */
  sourceSha256?: string;
  redacted?: boolean;
  /** Public-output projection or exact request body, never auth headers/hidden reasoning. */
  content: unknown;
  /** Stored representation only; hydrated export removes these refs. */
  contentRefs?: string[];
  details?: Record<string, unknown>;
};
export const ModelRequestEvidenceSchema = z.object({
  version: z.literal(1),
  scopeId: z.string().min(1),
  ordinal: z.number().int().positive(),
  purpose: z.enum(["main", "session-title", "compaction"]),
  kind: z.enum(["scope_open", "request", "wire_request", "response", "usage", "scope_close"]),
  physical: z
    .object({
      requestId: z.string().min(1),
      transportAttempt: z.number().int().positive(),
      identitySource: z.enum(["codex_custody", "local_fetch"]),
    })
    .optional(),
  provider: z.string().optional(),
  responseId: z.string().min(1).optional(),
  status: z.enum(["captured", "unavailable"]),
  reason: z.string().optional(),
  sourceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  redacted: z.boolean().optional(),
  content: z.unknown(),
  contentRefs: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type SessionModelEvidencePage = {
  sessionId: string;
  scope: "session_only";
  availability: "live" | "archived";
  events: Array<{
    id: string;
    sequence: number;
    turnId: string | null;
    attemptId: string | null;
    record: ModelRequestEvidence;
  }>;
  throughSequence: number;
  afterSequence: number;
  attemptInventory: { ids: string[]; truncated: boolean };
  nextAfterSequence: number;
  hasMore: boolean;
  /** A page, empty result or latest snapshot is never a completeness certificate. */
  completeness: "requires_all_pages_and_scope_check";
};

/** Use only after every page through a fixed watermark, separately for every child. */
export function assessModelRequestEvidence(records: readonly ModelRequestEvidence[]): {
  complete: boolean;
  issues: string[];
} {
  const issues = new Set<string>();
  if (records.some((record) => !ModelRequestEvidenceSchema.safeParse(record).success))
    return { complete: false, issues: ["invalid_evidence_manifest"] };
  if (!records.length) issues.add("recording_disabled_or_missing");
  const groupBy = <T>(items: readonly T[], key: (item: T) => string) => {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const k = key(item);
      const group = groups.get(k) ?? [];
      group.push(item);
      groups.set(k, group);
    }
    return groups;
  };
  const scopes = groupBy(records, (record) => record.scopeId);
  for (const [scopeId, scope] of scopes) {
    const ordinals = scope.map((record) => record.ordinal);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1))
      issues.add(`${scopeId}:missing_or_duplicate_record`);
    const closes = scope.filter((record) => record.kind === "scope_close");
    if (
      scope.filter((record) => record.kind === "scope_open" && record.ordinal === 1).length !== 1 ||
      closes.length !== 1
    )
      issues.add(`${scopeId}:scope_not_closed`);
    if (closes[0]?.details?.errors !== 0 || closes[0]?.ordinal !== scope.length)
      issues.add(`${scopeId}:capture_or_persistence_gap`);
    for (const record of scope)
      if (record.version !== 1 || record.status !== "captured" || record.contentRefs)
        issues.add(`${scopeId}:${record.ordinal}:unavailable_or_unhydrated`);
    for (const record of scope)
      if (
        ["request", "wire_request", "response"].includes(record.kind) &&
        (!record.sourceSha256 || record.content === null || record.content === undefined)
      )
        issues.add(`${scopeId}:${record.ordinal}:source_evidence_missing`);
    const requests = scope.filter((record) => record.kind === "request");
    if (closes[0]?.details?.physicalRequests !== requests.length)
      issues.add(`${scopeId}:physical_request_count_gap`);
    const key = (record: ModelRequestEvidence) =>
      JSON.stringify([record.physical?.requestId, record.physical?.transportAttempt]);
    const physicals = groupBy(requests, key);
    for (const [physicalKey, starts] of physicals) {
      const request = starts[0]!;
      if (
        starts.length !== 1 ||
        !request.physical?.requestId ||
        !Number.isSafeInteger(request.physical.transportAttempt) ||
        request.physical.transportAttempt < 1 ||
        request.physical.identitySource !== "codex_custody"
      )
        issues.add(`${scopeId}:${physicalKey}:ambiguous_physical_request`);
      const responses = scope.filter(
        (record) => record.kind === "response" && key(record) === physicalKey,
      );
      const response = responses[0];
      if (
        responses.length !== 1 ||
        !response?.responseId ||
        response.details?.terminal !== "completed"
      ) {
        issues.add(`${scopeId}:${physicalKey}:response_incomplete`);
        continue;
      }
      if (
        response.details?.transport === "websocket" &&
        scope.filter((record) => record.kind === "wire_request" && key(record) === physicalKey)
          .length !== 1
      )
        issues.add(`${scopeId}:${physicalKey}:missing_websocket_packet`);
      const sameIdResponses = scope.filter(
        (record) => record.kind === "response" && record.responseId === response.responseId,
      );
      const usages = scope.filter(
        (record) => record.kind === "usage" && record.responseId === response.responseId,
      );
      if (
        sameIdResponses.length !== 1 ||
        usages.length !== 1 ||
        usages[0]?.purpose !== request.purpose ||
        response.purpose !== request.purpose
      )
        issues.add(`${scopeId}:${physicalKey}:missing_or_ambiguous_usage_join`);
      const usage = usages[0];
      const payload = usage?.content as Record<string, unknown> | null;
      if (
        !usage?.details?.usageEventId ||
        !Number.isSafeInteger(usage.details.usageEventSequence) ||
        payload?.sourceKey !== response.responseId ||
        payload?.purpose !== request.purpose ||
        ![payload?.inputTokens, payload?.outputTokens].every(
          (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
        )
      )
        issues.add(`${scopeId}:${physicalKey}:usage_identity_or_token_totals_unknown`);
    }
    for (const record of scope) {
      if (
        (record.kind === "response" || record.kind === "wire_request") &&
        !physicals.has(key(record))
      )
        issues.add(`${scopeId}:${record.ordinal}:orphan_physical_record`);
      if (
        record.kind === "usage" &&
        !scope.some(
          (response) => response.kind === "response" && response.responseId === record.responseId,
        )
      )
        issues.add(`${scopeId}:${record.ordinal}:orphan_usage`);
    }
  }
  return { complete: issues.size === 0, issues: [...issues].sort() };
}

/** Session-level coverage, not a claim about proprietary provider internals or
 * child sessions. Every child must be exported and checked independently. */
export function assessSessionModelEvidencePages(pages: readonly SessionModelEvidencePage[]) {
  const issues = new Set<string>();
  const first = pages[0];
  if (!first || first.afterSequence !== 0 || pages.at(-1)?.hasMore !== false)
    issues.add("missing_pages");
  const events = pages.flatMap((page) => page.events);
  const sequences = new Set<number>();
  for (const [index, page] of pages.entries()) {
    if (page.availability !== "live") issues.add("retrieve_and_verify_archived_bundle");
    if (page.attemptInventory.truncated) issues.add("attempt_inventory_truncated");
    if (
      page.sessionId !== first?.sessionId ||
      page.throughSequence !== first?.throughSequence ||
      JSON.stringify(page.attemptInventory) !== JSON.stringify(first?.attemptInventory)
    )
      issues.add("inconsistent_page_snapshot");
    if (index && page.afterSequence !== pages[index - 1]?.nextAfterSequence)
      issues.add("page_cursor_gap");
    if (index < pages.length - 1 && !page.hasMore) issues.add("unexpected_extra_page");
    let prior = page.afterSequence;
    for (const event of page.events) {
      if (
        sequences.has(event.sequence) ||
        event.sequence <= prior ||
        event.sequence > page.throughSequence
      )
        issues.add("duplicate_or_unordered_event");
      sequences.add(event.sequence);
      prior = event.sequence;
      if (!event.attemptId || !page.attemptInventory.ids.includes(event.attemptId))
        issues.add("unattributed_attempt");
    }
    if (page.nextAfterSequence !== prior) issues.add("invalid_next_cursor");
  }
  for (const id of first?.attemptInventory.ids ?? [])
    if (!events.some((event) => event.attemptId === id && event.record.kind === "scope_open"))
      issues.add(`${id}:entire_attempt_evidence_missing`);
  for (const issue of assessModelRequestEvidence(events.map((event) => event.record)).issues)
    issues.add(issue);
  return { complete: issues.size === 0, issues: [...issues].sort() };
}
