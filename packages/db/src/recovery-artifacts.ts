import { createHash, type Hash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "./index";

export const RECOVERY_ARTIFACT_FORMAT_VERSION = 1 as const;
export const DEFAULT_RECOVERY_EVENT_PAGE_SIZE = 1_000;
export const DEFAULT_RECOVERY_SESSION_PAGE_SIZE = 500;
export const DEFAULT_RECOVERY_PARTITION_SIZE = 256;

type MetricValue = string | number | boolean | null | undefined;
type MetricLabels = Record<string, MetricValue>;

/**
 * Structural subset of @opengeni/observability used by recovery precompute.
 * Keeping this a port avoids making the persistence package depend on the
 * process-level telemetry package while accepting its Observability class
 * without an adapter.
 */
export type RecoveryArtifactObservability = {
  incrementCounter(input: {
    name: string;
    help?: string;
    labels?: MetricLabels;
    amount?: number;
  }): void;
  observeHistogram(input: {
    name: string;
    help?: string;
    labels?: MetricLabels;
    value: number;
    buckets?: number[];
  }): void;
  startSpan?: (
    name: string,
    attributes?: Record<string, MetricValue>,
  ) => {
    end(input?: { attributes?: Record<string, MetricValue>; error?: unknown }): void;
  };
};

export type RecoverySnapshotSession = {
  sessionId: string;
  parentSessionId: string | null;
  recoveryRevision: string;
  /** Full persisted session row. It is hashed and never retained in the manifest. */
  state: unknown;
};

export type RecoverySnapshotEvent = {
  sessionId: string;
  /** Full persisted event row, including payload and producer/attempt identity. */
  event: unknown;
};

export type RecoveryArtifactSession = {
  sessionId: string;
  parentSessionId: string | null;
  recoveryRevision: string;
  stateHash: string;
  eventCount: number;
  firstSequence: number | null;
  lastSequence: number | null;
  eventHistoryHash: string;
  canonicalBytes: number;
};

export type RecoveryArtifactPartition = {
  index: number;
  firstSessionId: string;
  lastSessionId: string;
  sessionCount: number;
  eventCount: number;
  canonicalBytes: number;
  partitionHash: string;
};

export type RecoveryArtifactManifest = {
  formatVersion: typeof RECOVERY_ARTIFACT_FORMAT_VERSION;
  workspaceId: string;
  rootSessionId: string;
  workspaceControlRevision: string;
  sessionCount: number;
  eventCount: number;
  canonicalBytes: number;
  sessions: RecoveryArtifactSession[];
  partitions: RecoveryArtifactPartition[];
};

export type RecoveryArtifact = {
  artifactHash: string;
  manifest: RecoveryArtifactManifest;
};

export type RecoveryArtifactBuildInput = {
  workspaceId: string;
  rootSessionId: string;
  workspaceControlRevision: string;
  sessions: Iterable<RecoverySnapshotSession>;
  events: Iterable<RecoverySnapshotEvent>;
  partitionSize?: number;
};

export type PrecomputeRecoveryArtifactInput = {
  accountId: string;
  workspaceId: string;
  rootSessionId: string;
  sessionPageSize?: number;
  eventPageSize?: number;
  partitionSize?: number;
  observability?: RecoveryArtifactObservability;
};

export type PersistRecoveryArtifactInput = {
  accountId: string;
  artifact: RecoveryArtifact;
};

export type AdmitRecoveryArtifactInput = PersistRecoveryArtifactInput & {
  idempotencyKey: string;
  observability?: RecoveryArtifactObservability;
};

export type RecoveryAdmissionResult =
  | { kind: "admitted"; admissionId: string; reused: boolean }
  | {
      kind: "retry";
      reason: "workspace_control_changed" | "session_tree_changed";
    };

export type RecoveryArtifactRetryPhase = "persist" | "admit";
export type RecoveryArtifactRetryReason = "serialization" | "deadlock" | "transient";

export class RecoveryArtifactValidationError extends Error {
  override readonly name = "RecoveryArtifactValidationError";
}

export class RecoveryAdmissionConflictError extends Error {
  override readonly name = "RecoveryAdmissionConflictError";
}

type EventCursor = { sessionId: string; sequence: number; eventId: string };

type RecoverySessionPageRow = {
  session_id: string;
  parent_session_id: string | null;
  recovery_revision: string;
  session_state: unknown;
};

type RecoveryEventPageRow = {
  session_id: string;
  sequence: number;
  event_id: string;
  event: unknown;
};

type MutableArtifactSession = RecoveryArtifactSession & {
  eventHasher?: Hash;
};

const EMPTY_SHA256 = createHash("sha256").digest("hex");
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPositiveBoundedInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RecoveryArtifactValidationError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function assertNonNegativeIntegerString(name: string, value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RecoveryArtifactValidationError(`${name} must be a non-negative integer string`);
  }
  return value;
}

function assertNonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecoveryArtifactValidationError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function addSafeInteger(name: string, left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new RecoveryArtifactValidationError(`${name} exceeds the safe integer range`);
  }
  return sum;
}

function assertUuid(name: string, value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new RecoveryArtifactValidationError(`${name} must be a UUID`);
  }
  return value;
}

function jsonNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RecoveryArtifactValidationError("canonical JSON rejects non-finite numbers");
  }
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

/** RFC-8785-shaped deterministic JSON for the persisted value domain. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return jsonNumber(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort(compareText);
    const entries: string[] = [];
    for (const key of keys) {
      const entry = object[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        throw new RecoveryArtifactValidationError(
          `canonical JSON rejects unsupported value at object key ${JSON.stringify(key)}`,
        );
      }
      entries.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${entries.join(",")}}`;
  }
  throw new RecoveryArtifactValidationError(`canonical JSON rejects ${typeof value}`);
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sequenceFromEvent(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    throw new RecoveryArtifactValidationError("recovery event must be an object");
  }
  const raw = (value as Record<string, unknown>).sequence;
  const sequence = typeof raw === "string" ? Number(raw) : raw;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RecoveryArtifactValidationError("recovery event sequence must be non-negative");
  }
  return sequence;
}

function idFromEvent(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : "";
}

class RecoveryArtifactAccumulator {
  readonly sessions: MutableArtifactSession[] = [];
  private readonly byId = new Map<string, MutableArtifactSession>();
  private eventCount = 0;
  private canonicalBytes = 0;
  private lastSessionId: string | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly rootSessionId: string,
    private readonly workspaceControlRevision: string,
    private readonly partitionSize: number,
  ) {
    assertNonNegativeIntegerString("workspaceControlRevision", workspaceControlRevision);
  }

  addSession(snapshot: RecoverySnapshotSession): void {
    assertNonNegativeIntegerString("recoveryRevision", snapshot.recoveryRevision);
    if (this.lastSessionId !== null && compareText(this.lastSessionId, snapshot.sessionId) >= 0) {
      throw new RecoveryArtifactValidationError(
        "recovery sessions are not in strict canonical order",
      );
    }
    const serializedState = canonicalJson(snapshot.state);
    const summary: MutableArtifactSession = {
      sessionId: snapshot.sessionId,
      parentSessionId: snapshot.parentSessionId,
      recoveryRevision: snapshot.recoveryRevision,
      stateHash: createHash("sha256").update(serializedState).digest("hex"),
      eventCount: 0,
      firstSequence: null,
      lastSequence: null,
      eventHistoryHash: EMPTY_SHA256,
      canonicalBytes: Buffer.byteLength(serializedState),
    };
    this.canonicalBytes += summary.canonicalBytes;
    this.byId.set(summary.sessionId, summary);
    this.sessions.push(summary);
    this.lastSessionId = summary.sessionId;
  }

  addEvent(input: RecoverySnapshotEvent): void {
    const session = this.byId.get(input.sessionId);
    if (!session) {
      throw new RecoveryArtifactValidationError("recovery event belongs to an unknown session");
    }
    const sequence = sequenceFromEvent(input.event);
    if (session.lastSequence !== null && sequence <= session.lastSequence) {
      throw new RecoveryArtifactValidationError("recovery events are not in strict sequence order");
    }
    const serialized = canonicalJson(input.event);
    const framed = `${serialized}\n`;
    session.eventHasher ??= createHash("sha256");
    session.eventHasher.update(framed);
    const bytes = Buffer.byteLength(framed);
    session.eventCount += 1;
    session.firstSequence ??= sequence;
    session.lastSequence = sequence;
    session.canonicalBytes += bytes;
    this.eventCount += 1;
    this.canonicalBytes += bytes;
  }

  finalize(): RecoveryArtifact {
    if (this.sessions.length === 0 || !this.byId.has(this.rootSessionId)) {
      throw new RecoveryArtifactValidationError("recovery snapshot must contain its root session");
    }
    const sessions: RecoveryArtifactSession[] = this.sessions.map((session) => {
      const { eventHasher, ...summary } = session;
      if (eventHasher) summary.eventHistoryHash = eventHasher.digest("hex");
      return summary;
    });
    const partitions: RecoveryArtifactPartition[] = [];
    for (let offset = 0; offset < sessions.length; offset += this.partitionSize) {
      const members = sessions.slice(offset, offset + this.partitionSize);
      const first = members[0]!;
      const last = members[members.length - 1]!;
      partitions.push({
        index: partitions.length,
        firstSessionId: first.sessionId,
        lastSessionId: last.sessionId,
        sessionCount: members.length,
        eventCount: members.reduce((sum, member) => sum + member.eventCount, 0),
        canonicalBytes: members.reduce((sum, member) => sum + member.canonicalBytes, 0),
        partitionHash: sha256Canonical(members),
      });
    }
    const manifest: RecoveryArtifactManifest = {
      formatVersion: RECOVERY_ARTIFACT_FORMAT_VERSION,
      workspaceId: this.workspaceId,
      rootSessionId: this.rootSessionId,
      workspaceControlRevision: this.workspaceControlRevision,
      sessionCount: sessions.length,
      eventCount: this.eventCount,
      canonicalBytes: this.canonicalBytes,
      sessions,
      partitions,
    };
    return { artifactHash: sha256Canonical(manifest), manifest };
  }
}

/** Pure deterministic builder used by process-death/retry and stress proofs. */
export function buildRecoveryArtifact(input: RecoveryArtifactBuildInput): RecoveryArtifact {
  const partitionSize = assertPositiveBoundedInteger(
    "partitionSize",
    input.partitionSize ?? DEFAULT_RECOVERY_PARTITION_SIZE,
    10_000,
  );
  const snapshots = [...input.sessions];
  const accumulator = new RecoveryArtifactAccumulator(
    input.workspaceId,
    input.rootSessionId,
    input.workspaceControlRevision,
    partitionSize,
  );
  for (const snapshot of snapshots.sort((left, right) =>
    compareText(left.sessionId, right.sessionId),
  )) {
    accumulator.addSession(snapshot);
  }
  const events = [...input.events].sort((left, right) => {
    const sessionOrder = compareText(left.sessionId, right.sessionId);
    if (sessionOrder !== 0) return sessionOrder;
    const sequenceOrder = sequenceFromEvent(left.event) - sequenceFromEvent(right.event);
    if (sequenceOrder !== 0) return sequenceOrder;
    return compareText(idFromEvent(left.event), idFromEvent(right.event));
  });
  for (const event of events) accumulator.addEvent(event);
  return accumulator.finalize();
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error("database driver returned an unsupported raw-query shape");
}

async function executeRows<T>(db: Database, query: SQL): Promise<T[]> {
  return resultRows<T>(await db.execute(query));
}

async function setRecoveryRlsContext(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<void> {
  if (!input.accountId.trim() || !input.workspaceId.trim()) {
    throw new RecoveryArtifactValidationError(
      "recovery RLS context requires account and workspace",
    );
  }
  await db.execute(sql`select set_config('opengeni.account_id', ${input.accountId}, true)`);
  await db.execute(sql`select set_config('opengeni.workspace_id', ${input.workspaceId}, true)`);
  const [applied] = await executeRows<{ account_id: string; workspace_id: string }>(
    db,
    sql`select current_setting('opengeni.account_id', true) as account_id,
               current_setting('opengeni.workspace_id', true) as workspace_id`,
  );
  if (applied?.account_id !== input.accountId || applied.workspace_id !== input.workspaceId) {
    throw new Error("recovery RLS context was not applied on the active backend");
  }
}

function recordPrecomputeMetrics(
  observability: RecoveryArtifactObservability | undefined,
  artifact: RecoveryArtifact | null,
  durationSeconds: number,
  outcome: "success" | "error",
): void {
  observability?.observeHistogram({
    name: "opengeni_recovery_artifact_precompute_duration_seconds",
    help: "Recovery artifact precompute time outside row-lock critical sections.",
    value: durationSeconds,
    labels: { outcome },
  });
  if (!artifact) return;
  observability?.observeHistogram({
    name: "opengeni_recovery_artifact_rows",
    help: "Rows processed while precomputing a recovery artifact.",
    value: artifact.manifest.sessionCount,
    labels: { phase: "precompute", kind: "sessions" },
  });
  observability?.observeHistogram({
    name: "opengeni_recovery_artifact_rows",
    help: "Rows processed while precomputing a recovery artifact.",
    value: artifact.manifest.eventCount,
    labels: { phase: "precompute", kind: "events" },
  });
  observability?.observeHistogram({
    name: "opengeni_recovery_artifact_canonical_bytes",
    help: "Canonical bytes hashed while precomputing a recovery artifact.",
    value: artifact.manifest.canonicalBytes,
    labels: { phase: "precompute" },
  });
}

/**
 * Enumerate and hash one exact tree in a read-only repeatable-read transaction.
 * No SELECT FOR UPDATE/SHARE appears here; event payloads are paged, hashed, and
 * discarded before the next page.
 */
export async function precomputeRecoveryArtifact(
  db: Database,
  input: PrecomputeRecoveryArtifactInput,
): Promise<RecoveryArtifact> {
  const sessionPageSize = assertPositiveBoundedInteger(
    "sessionPageSize",
    input.sessionPageSize ?? DEFAULT_RECOVERY_SESSION_PAGE_SIZE,
    5_000,
  );
  const eventPageSize = assertPositiveBoundedInteger(
    "eventPageSize",
    input.eventPageSize ?? DEFAULT_RECOVERY_EVENT_PAGE_SIZE,
    10_000,
  );
  const partitionSize = assertPositiveBoundedInteger(
    "partitionSize",
    input.partitionSize ?? DEFAULT_RECOVERY_PARTITION_SIZE,
    10_000,
  );
  const startedAt = performance.now();
  const span = input.observability?.startSpan?.("db.recovery_artifact.precompute", {
    format_version: RECOVERY_ARTIFACT_FORMAT_VERSION,
  });
  let artifact: RecoveryArtifact | null = null;
  try {
    artifact = await db.transaction(
      async (rawTransaction) => {
        const tx = rawTransaction as unknown as Database;
        await setRecoveryRlsContext(tx, input);
        // PostgreSQL renders timestamptz through the session TimeZone when a
        // row is converted with to_jsonb().  Pinning UTC makes hashes identical
        // across workers, process restarts, and database pool defaults.
        await tx.execute(sql`set local time zone 'UTC'`);
        const [control] = await executeRows<{ revision: string }>(
          tx,
          sql`select revision::text as revision
              from workspace_inference_controls
              where workspace_id = ${input.workspaceId}::uuid`,
        );
        if (!control) {
          throw new RecoveryArtifactValidationError("workspace control truth is unavailable");
        }

        const accumulator = new RecoveryArtifactAccumulator(
          input.workspaceId,
          input.rootSessionId,
          control.revision,
          partitionSize,
        );
        let sessionCursor: string | null = null;
        for (;;) {
          const cursorPredicate: SQL = sessionCursor
            ? sql`and session.id > ${sessionCursor}::uuid`
            : sql``;
          const page: RecoverySessionPageRow[] = await executeRows<RecoverySessionPageRow>(
            tx,
            sql`select session.id::text as session_id,
                       session.parent_session_id::text as parent_session_id,
                       revision.revision::text as recovery_revision,
                       to_jsonb(session) as session_state
                from recovery_session_revisions revision
                join sessions session
                  on session.workspace_id = revision.workspace_id
                 and session.id = revision.session_id
                where revision.workspace_id = ${input.workspaceId}::uuid
                  and revision.root_session_id = ${input.rootSessionId}::uuid
                  ${cursorPredicate}
                order by session.id
                limit ${sessionPageSize}`,
          );
          for (const row of page) {
            accumulator.addSession({
              sessionId: row.session_id,
              parentSessionId: row.parent_session_id,
              recoveryRevision: row.recovery_revision,
              state: row.session_state,
            });
          }
          if (page.length < sessionPageSize) break;
          sessionCursor = page[page.length - 1]!.session_id;
        }
        let eventCursor: EventCursor | null = null;
        for (;;) {
          const cursorPredicate: SQL = eventCursor
            ? sql`and (
                event.session_id > ${eventCursor.sessionId}::uuid
                or (
                  event.session_id = ${eventCursor.sessionId}::uuid
                  and event.sequence > ${eventCursor.sequence}
                )
                or (
                  event.session_id = ${eventCursor.sessionId}::uuid
                  and event.sequence = ${eventCursor.sequence}
                  and event.id > ${eventCursor.eventId}::uuid
                )
              )`
            : sql``;
          const page: RecoveryEventPageRow[] = await executeRows<RecoveryEventPageRow>(
            tx,
            sql`select event.session_id::text as session_id,
                       event.sequence,
                       event.id::text as event_id,
                       to_jsonb(event) as event
                from recovery_session_revisions revision
                join session_events event
                  on event.workspace_id = revision.workspace_id
                 and event.session_id = revision.session_id
                where revision.workspace_id = ${input.workspaceId}::uuid
                  and revision.root_session_id = ${input.rootSessionId}::uuid
                  ${cursorPredicate}
                order by event.session_id, event.sequence, event.id
                limit ${eventPageSize}`,
          );
          for (const row of page) {
            accumulator.addEvent({ sessionId: row.session_id, event: row.event });
          }
          if (page.length < eventPageSize) break;
          const last: RecoveryEventPageRow = page[page.length - 1]!;
          eventCursor = {
            sessionId: last.session_id,
            sequence: last.sequence,
            eventId: last.event_id,
          };
        }
        return accumulator.finalize();
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    const durationSeconds = (performance.now() - startedAt) / 1_000;
    recordPrecomputeMetrics(input.observability, artifact, durationSeconds, "success");
    span?.end({
      attributes: {
        outcome: "success",
        session_count: artifact.manifest.sessionCount,
        event_count: artifact.manifest.eventCount,
        canonical_bytes: artifact.manifest.canonicalBytes,
      },
    });
    return artifact;
  } catch (error) {
    recordPrecomputeMetrics(
      input.observability,
      null,
      (performance.now() - startedAt) / 1_000,
      "error",
    );
    span?.end({ attributes: { outcome: "error" } });
    throw error;
  }
}

function validateRecoveryArtifact(artifact: RecoveryArtifact): void {
  if (!HASH_PATTERN.test(artifact.artifactHash)) {
    throw new RecoveryArtifactValidationError("artifact hash must be lowercase SHA-256");
  }
  if (artifact.manifest.formatVersion !== RECOVERY_ARTIFACT_FORMAT_VERSION) {
    throw new RecoveryArtifactValidationError("unsupported recovery artifact format");
  }
  assertUuid("workspaceId", artifact.manifest.workspaceId);
  assertUuid("rootSessionId", artifact.manifest.rootSessionId);
  assertNonNegativeIntegerString(
    "workspaceControlRevision",
    artifact.manifest.workspaceControlRevision,
  );
  assertNonNegativeSafeInteger("sessionCount", artifact.manifest.sessionCount);
  assertNonNegativeSafeInteger("eventCount", artifact.manifest.eventCount);
  assertNonNegativeSafeInteger("canonicalBytes", artifact.manifest.canonicalBytes);
  if (artifact.manifest.sessionCount === 0) {
    throw new RecoveryArtifactValidationError("artifact must contain at least one session");
  }
  if (artifact.manifest.sessionCount !== artifact.manifest.sessions.length) {
    throw new RecoveryArtifactValidationError("artifact session count does not match manifest");
  }

  const byId = new Map<string, RecoveryArtifactSession>();
  let previousSessionId: string | null = null;
  let eventCount = 0;
  let canonicalBytes = 0;
  for (const session of artifact.manifest.sessions) {
    assertUuid("sessionId", session.sessionId);
    if (session.parentSessionId !== null) assertUuid("parentSessionId", session.parentSessionId);
    if (previousSessionId !== null && compareText(previousSessionId, session.sessionId) >= 0) {
      throw new RecoveryArtifactValidationError(
        "artifact sessions are not in strict canonical order",
      );
    }
    previousSessionId = session.sessionId;
    assertNonNegativeIntegerString("recoveryRevision", session.recoveryRevision);
    if (!HASH_PATTERN.test(session.stateHash) || !HASH_PATTERN.test(session.eventHistoryHash)) {
      throw new RecoveryArtifactValidationError("artifact contains an invalid session digest");
    }
    assertNonNegativeSafeInteger("session eventCount", session.eventCount);
    assertNonNegativeSafeInteger("session canonicalBytes", session.canonicalBytes);
    if (session.eventCount === 0) {
      if (
        session.firstSequence !== null ||
        session.lastSequence !== null ||
        session.eventHistoryHash !== EMPTY_SHA256
      ) {
        throw new RecoveryArtifactValidationError("empty session event summary is inconsistent");
      }
    } else {
      if (session.firstSequence === null || session.lastSequence === null) {
        throw new RecoveryArtifactValidationError("non-empty session lacks event bounds");
      }
      assertNonNegativeSafeInteger("firstSequence", session.firstSequence);
      assertNonNegativeSafeInteger("lastSequence", session.lastSequence);
      if (
        session.firstSequence > session.lastSequence ||
        session.eventCount > session.lastSequence - session.firstSequence + 1
      ) {
        throw new RecoveryArtifactValidationError("session event bounds are inconsistent");
      }
    }
    eventCount = addSafeInteger("artifact eventCount", eventCount, session.eventCount);
    canonicalBytes = addSafeInteger(
      "artifact canonicalBytes",
      canonicalBytes,
      session.canonicalBytes,
    );
    byId.set(session.sessionId, session);
  }
  if (
    eventCount !== artifact.manifest.eventCount ||
    canonicalBytes !== artifact.manifest.canonicalBytes
  ) {
    throw new RecoveryArtifactValidationError("artifact aggregate counts are inconsistent");
  }

  const root = byId.get(artifact.manifest.rootSessionId);
  if (!root || root.parentSessionId !== null) {
    throw new RecoveryArtifactValidationError("artifact root session is missing or not a root");
  }
  for (const session of artifact.manifest.sessions) {
    if (session.sessionId !== artifact.manifest.rootSessionId && session.parentSessionId === null) {
      throw new RecoveryArtifactValidationError("artifact contains a second root session");
    }
    const visited = new Set<string>();
    let cursor: RecoveryArtifactSession | undefined = session;
    while (cursor.sessionId !== artifact.manifest.rootSessionId) {
      if (visited.has(cursor.sessionId) || cursor.parentSessionId === null) {
        throw new RecoveryArtifactValidationError(
          "artifact session topology is cyclic or detached",
        );
      }
      visited.add(cursor.sessionId);
      cursor = byId.get(cursor.parentSessionId);
      if (!cursor) {
        throw new RecoveryArtifactValidationError("artifact session parent is missing");
      }
    }
  }

  if (artifact.manifest.partitions.length === 0) {
    throw new RecoveryArtifactValidationError("artifact must contain at least one partition");
  }
  let partitionOffset = 0;
  let partitionEventCount = 0;
  let partitionCanonicalBytes = 0;
  for (const [index, partition] of artifact.manifest.partitions.entries()) {
    if (partition.index !== index) {
      throw new RecoveryArtifactValidationError("artifact partition indexes are not contiguous");
    }
    assertPositiveBoundedInteger(
      "partition sessionCount",
      partition.sessionCount,
      artifact.manifest.sessionCount,
    );
    assertNonNegativeSafeInteger("partition eventCount", partition.eventCount);
    assertNonNegativeSafeInteger("partition canonicalBytes", partition.canonicalBytes);
    if (!HASH_PATTERN.test(partition.partitionHash)) {
      throw new RecoveryArtifactValidationError("artifact contains an invalid partition digest");
    }
    const members = artifact.manifest.sessions.slice(
      partitionOffset,
      partitionOffset + partition.sessionCount,
    );
    if (
      members.length !== partition.sessionCount ||
      partition.firstSessionId !== members[0]!.sessionId ||
      partition.lastSessionId !== members[members.length - 1]!.sessionId ||
      partition.eventCount !== members.reduce((sum, member) => sum + member.eventCount, 0) ||
      partition.canonicalBytes !==
        members.reduce((sum, member) => sum + member.canonicalBytes, 0) ||
      partition.partitionHash !== sha256Canonical(members)
    ) {
      throw new RecoveryArtifactValidationError("artifact partition is inconsistent");
    }
    partitionOffset += partition.sessionCount;
    partitionEventCount = addSafeInteger(
      "partition eventCount",
      partitionEventCount,
      partition.eventCount,
    );
    partitionCanonicalBytes = addSafeInteger(
      "partition canonicalBytes",
      partitionCanonicalBytes,
      partition.canonicalBytes,
    );
  }
  if (
    partitionOffset !== artifact.manifest.sessionCount ||
    partitionEventCount !== artifact.manifest.eventCount ||
    partitionCanonicalBytes !== artifact.manifest.canonicalBytes
  ) {
    throw new RecoveryArtifactValidationError("artifact partitions do not cover the manifest");
  }
  if (sha256Canonical(artifact.manifest) !== artifact.artifactHash) {
    throw new RecoveryArtifactValidationError("artifact hash does not match canonical manifest");
  }
}

/** Persist immutable content-addressed truth before any admission lock is taken. */
export async function persistRecoveryArtifact(
  db: Database,
  input: PersistRecoveryArtifactInput,
): Promise<{ inserted: boolean }> {
  validateRecoveryArtifact(input.artifact);
  const { manifest, artifactHash } = input.artifact;
  const serializedManifest = JSON.stringify(manifest);
  return await db.transaction(async (rawTransaction) => {
    const tx = rawTransaction as unknown as Database;
    await setRecoveryRlsContext(tx, {
      accountId: input.accountId,
      workspaceId: manifest.workspaceId,
    });
    const inserted = await executeRows<{ artifact_hash: string }>(
      tx,
      sql`insert into recovery_history_artifacts (
            workspace_id, account_id, root_session_id, artifact_hash,
            format_version, workspace_control_revision, session_count,
            event_count, canonical_bytes, manifest
          ) values (
            ${manifest.workspaceId}::uuid, ${input.accountId}::uuid,
            ${manifest.rootSessionId}::uuid, ${artifactHash},
            ${manifest.formatVersion}, ${manifest.workspaceControlRevision}::bigint,
            ${manifest.sessionCount}, ${manifest.eventCount}::bigint,
            ${manifest.canonicalBytes}::bigint, ${serializedManifest}::jsonb
          )
          on conflict (workspace_id, artifact_hash) do nothing
          returning artifact_hash`,
    );
    const [stored] = await executeRows<{
      root_session_id: string;
      format_version: number;
      workspace_control_revision: string;
      session_count: number;
      event_count: string;
      canonical_bytes: string;
      manifest: unknown;
    }>(
      tx,
      sql`select root_session_id::text as root_session_id,
                 format_version,
                 workspace_control_revision::text as workspace_control_revision,
                 session_count,
                 event_count::text as event_count,
                 canonical_bytes::text as canonical_bytes,
                 manifest
          from recovery_history_artifacts
          where workspace_id = ${manifest.workspaceId}::uuid
            and artifact_hash = ${artifactHash}`,
    );
    if (
      !stored ||
      stored.root_session_id !== manifest.rootSessionId ||
      stored.format_version !== manifest.formatVersion ||
      stored.workspace_control_revision !== manifest.workspaceControlRevision ||
      stored.session_count !== manifest.sessionCount ||
      stored.event_count !== String(manifest.eventCount) ||
      stored.canonical_bytes !== String(manifest.canonicalBytes) ||
      canonicalJson(stored.manifest) !== canonicalJson(manifest)
    ) {
      throw new RecoveryArtifactValidationError(
        "stored artifact does not match its content address",
      );
    }
    return { inserted: inserted.length === 1 };
  });
}

function recordFinalLockMetric(
  observability: RecoveryArtifactObservability | undefined,
  kind: "wait" | "hold",
  seconds: number,
  outcome: "admitted" | "reused" | "stale" | "error",
): void {
  observability?.observeHistogram({
    name: `opengeni_recovery_artifact_final_lock_${kind}_seconds`,
    help: `Recovery artifact final barrier lock ${kind} time.`,
    value: seconds,
    labels: { outcome },
  });
}

/**
 * Final fenced phase. All serialization and temp-table population happens
 * before the exclusive barrier lock. The locked phase only checks idempotency,
 * the exact control revision, the exact session revision set, and inserts one
 * admission row. There is deliberately no callback for model/tool/provider or
 * any other external effect.
 */
export async function admitRecoveryArtifact(
  db: Database,
  input: AdmitRecoveryArtifactInput,
): Promise<RecoveryAdmissionResult> {
  validateRecoveryArtifact(input.artifact);
  if (!input.idempotencyKey.trim()) {
    throw new RecoveryArtifactValidationError("recovery admission idempotency key is required");
  }
  const { manifest, artifactHash } = input.artifact;
  let lockWaitSeconds: number | null = null;
  let lockHoldSeconds: number | null = null;
  let outcome: "admitted" | "reused" | "stale" | "error" = "error";
  const span = input.observability?.startSpan?.("db.recovery_artifact.final_admission", {
    format_version: RECOVERY_ARTIFACT_FORMAT_VERSION,
  });
  try {
    const result = await db.transaction(async (rawTransaction) => {
      const tx = rawTransaction as unknown as Database;
      await setRecoveryRlsContext(tx, {
        accountId: input.accountId,
        workspaceId: manifest.workspaceId,
      });
      const [admission] = await executeRows<{
        result_kind: "admitted" | "retry" | "conflict";
        retry_reason:
          | "workspace_control_changed"
          | "session_tree_changed"
          | "idempotency_conflict"
          | null;
        result_admission_id: string | null;
        result_reused: boolean;
        result_lock_wait_seconds: number;
        result_lock_hold_seconds: number;
      }>(
        tx,
        sql`select result_kind,
                   retry_reason,
                   result_admission_id::text as result_admission_id,
                   result_reused,
                   result_lock_wait_seconds,
                   result_lock_hold_seconds
            from opengeni_private.admit_recovery_history_artifact(
              current_schema()::name,
              ${input.accountId}::uuid,
              ${manifest.workspaceId}::uuid,
              ${manifest.rootSessionId}::uuid,
              ${artifactHash},
              ${manifest.workspaceControlRevision}::bigint,
              ${input.idempotencyKey}
            )`,
      );
      if (!admission) throw new Error("recovery admission function returned no row");
      lockWaitSeconds = admission.result_lock_wait_seconds;
      lockHoldSeconds = admission.result_lock_hold_seconds;
      if (admission.result_kind === "conflict") {
        throw new RecoveryAdmissionConflictError(
          "recovery admission idempotency key was used for different canonical input",
        );
      }
      if (admission.result_kind === "retry") {
        if (
          admission.retry_reason !== "workspace_control_changed" &&
          admission.retry_reason !== "session_tree_changed"
        ) {
          throw new Error("recovery admission function returned an invalid retry reason");
        }
        outcome = "stale";
        return { kind: "retry", reason: admission.retry_reason } as const;
      }
      if (!admission.result_admission_id) {
        throw new Error("recovery admission function returned no admission ID");
      }
      outcome = admission.result_reused ? "reused" : "admitted";
      return {
        kind: "admitted",
        admissionId: admission.result_admission_id,
        reused: admission.result_reused,
      } as const;
    });

    if (lockWaitSeconds !== null && lockHoldSeconds !== null) {
      recordFinalLockMetric(input.observability, "wait", lockWaitSeconds, outcome);
      recordFinalLockMetric(input.observability, "hold", lockHoldSeconds, outcome);
    }
    if (result.kind === "retry") {
      input.observability?.incrementCounter({
        name: "opengeni_recovery_artifact_stale_rejections_total",
        help: "Recovery artifacts rejected by the final revision fence.",
        labels: { reason: result.reason },
      });
    }
    span?.end({ attributes: { outcome } });
    return result;
  } catch (error) {
    if (lockWaitSeconds !== null && lockHoldSeconds !== null) {
      recordFinalLockMetric(input.observability, "wait", lockWaitSeconds, "error");
      recordFinalLockMetric(input.observability, "hold", lockHoldSeconds, "error");
    }
    span?.end({ attributes: { outcome: "error" } });
    throw error;
  }
}

/** Called by OPE-63's persistence-only SQLSTATE retry seam; never wraps effects. */
export function recordRecoveryArtifactPersistenceRetry(
  observability: RecoveryArtifactObservability | undefined,
  phase: RecoveryArtifactRetryPhase,
  reason: RecoveryArtifactRetryReason,
): void {
  observability?.incrementCounter({
    name: "opengeni_recovery_artifact_persistence_retries_total",
    help: "Persistence-only retries while storing or admitting recovery artifacts.",
    labels: { phase, reason },
  });
}
