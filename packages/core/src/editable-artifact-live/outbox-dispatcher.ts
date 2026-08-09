import {
  assertNonnegativeSafeInteger,
  assertPositiveSafeInteger,
  editableArtifactId,
  editableArtifactOutboxId,
  editableArtifactScope,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
  type EditableArtifactLiveOutboxRecord,
  type EditableArtifactModality,
  type EditableArtifactOutboxId,
  type EditableArtifactScope,
} from "../domain/editable-artifacts/types";
import type { EditableArtifactLiveClockPort, EditableArtifactLiveSchedulerPort } from "./ports";

const textEncoder = new TextEncoder();

export const EDITABLE_ARTIFACT_HINT_MAX_BYTES = 16 * 1024;
export const EDITABLE_ARTIFACT_HINT_SUBJECT_PREFIX = "editable_artifacts.v1";

type EditableArtifactBrokerHeadHintCommon = Readonly<{
  kind: "head_advanced";
  schemaVersion: 1;
  scope: EditableArtifactScope;
  artifactId: string;
  modality: EditableArtifactModality;
  headSequence: number;
  stateHash: string;
}>;

type EditableArtifactBrokerSnapshotHintCommon = Readonly<{
  kind: "snapshot_available";
  schemaVersion: 1;
  scope: EditableArtifactScope;
  artifactId: string;
  modality: EditableArtifactModality;
  headSequence: number;
  stateHash: string;
  snapshotId: string;
}>;

export type EditableArtifactBrokerHint =
  | (EditableArtifactBrokerHeadHintCommon &
      Readonly<{ modality: "spreadsheet"; operationProtocolVersion: number }>)
  | (EditableArtifactBrokerHeadHintCommon &
      Readonly<{
        modality: "document" | "presentation";
        commitProtocolVersion: number;
      }>)
  | (EditableArtifactBrokerSnapshotHintCommon &
      Readonly<{ modality: "spreadsheet"; operationProtocolVersion: number }>)
  | (EditableArtifactBrokerSnapshotHintCommon &
      Readonly<{ modality: "document" | "presentation" }>);

export type EditableArtifactEncodedBrokerHint = Readonly<{
  subject: string;
  payload: Uint8Array;
  hint: EditableArtifactBrokerHint;
}>;

export interface EditableArtifactOutboxDispatcherStorePort {
  claimLiveOutbox(input: {
    owner: string;
    leaseDurationMs: number;
    limit: number;
  }): Promise<readonly EditableArtifactLiveOutboxRecord[]>;
  renewLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
    leaseDurationMs: number;
  }): Promise<void>;
  markLiveOutboxPublished(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
  }): Promise<void>;
  retryLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
    retryDelayMs: number;
    errorCode: EditableArtifactOutboxRetryErrorCode;
  }): Promise<void>;
  deadLetterLiveOutbox(input: {
    outboxId: EditableArtifactOutboxId;
    owner: string;
    attemptCount: number;
    errorCode: EditableArtifactOutboxDeadLetterErrorCode;
  }): Promise<void>;
}

/** Resolves only after the broker has acknowledged every preceding publish. */
export interface EditableArtifactHintBrokerPort {
  publish(
    input: Readonly<{
      subject: string;
      payload: Uint8Array;
      signal: AbortSignal;
    }>,
  ): Promise<void>;
}

export interface EditableArtifactOutboxRandomPort {
  unit(): number;
}

export type EditableArtifactOutboxMetricOutcome =
  | "claimed"
  | "published"
  | "retried"
  | "dead_lettered"
  | "lease_lost"
  | "claim_failed"
  | "mark_failed"
  | "retry_store_failed"
  | "dead_letter_store_failed";

/** Labels are closed unions; artifact/workspace identities must never become metric labels. */
export interface EditableArtifactOutboxMetricsPort {
  increment(outcome: EditableArtifactOutboxMetricOutcome, count?: number): void;
  observePublishSeconds(outcome: "acked" | "failed" | "timed_out", seconds: number): void;
}

export interface EditableArtifactOutboxLoggerPort {
  warn(message: string, attributes: Readonly<Record<string, unknown>>): void;
}

export type EditableArtifactOutboxRetryErrorCode =
  | "broker_unavailable"
  | "broker_backpressure"
  | "publish_timeout";

export type EditableArtifactOutboxDeadLetterErrorCode = "invalid_hint" | "oversized_hint";

export type EditableArtifactOutboxDispatcherOptions = Readonly<{
  owner: string;
  batchSize?: number;
  concurrency?: number;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
  pollIntervalMs?: number;
  publishTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  retryJitterRatio?: number;
  claimBackoffBaseMs?: number;
  claimBackoffMaxMs?: number;
  maxHintBytes?: number;
}>;

export type EditableArtifactOutboxDispatcherDependencies = Readonly<{
  store: EditableArtifactOutboxDispatcherStorePort;
  broker: EditableArtifactHintBrokerPort;
  clock: EditableArtifactLiveClockPort;
  scheduler: EditableArtifactLiveSchedulerPort;
  random: EditableArtifactOutboxRandomPort;
  metrics?: EditableArtifactOutboxMetricsPort;
  logger?: EditableArtifactOutboxLoggerPort;
}>;

export type EditableArtifactOutboxDispatchSummary = Readonly<{
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  leaseLost: number;
  markFailed: number;
  claimFailed: boolean;
}>;

type NormalizedOptions = Required<EditableArtifactOutboxDispatcherOptions>;
type MutableSummary = {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  leaseLost: number;
  markFailed: number;
  claimFailed: boolean;
};

const DEFAULTS = Object.freeze({
  batchSize: 32,
  concurrency: 8,
  leaseDurationMs: 30_000,
  leaseRenewIntervalMs: 10_000,
  pollIntervalMs: 500,
  publishTimeoutMs: 5_000,
  retryBaseMs: 500,
  retryMaxMs: 60_000,
  retryJitterRatio: 0.2,
  claimBackoffBaseMs: 500,
  claimBackoffMaxMs: 30_000,
  maxHintBytes: EDITABLE_ARTIFACT_HINT_MAX_BYTES,
});

export class EditableArtifactLiveOutboxDispatcher {
  private readonly options: NormalizedOptions;
  private activeDispatch: Promise<EditableArtifactOutboxDispatchSummary> | null = null;

  constructor(
    private readonly dependencies: EditableArtifactOutboxDispatcherDependencies,
    options: EditableArtifactOutboxDispatcherOptions,
  ) {
    this.options = normalizeOptions(options);
  }

  /**
   * Long-running resilient loop. Abort stops new claims; an already-claimed
   * bounded batch drains before this promise resolves.
   */
  async run(signal: AbortSignal): Promise<void> {
    let consecutiveClaimFailures = 0;
    while (!signal.aborted) {
      const summary = await this.dispatchOnce();
      if (summary.claimFailed) consecutiveClaimFailures += 1;
      else consecutiveClaimFailures = 0;
      if (signal.aborted) break;
      const delay = summary.claimFailed
        ? exponentialDelay(
            consecutiveClaimFailures,
            this.options.claimBackoffBaseMs,
            this.options.claimBackoffMaxMs,
            this.options.retryJitterRatio,
            this.dependencies.random,
          )
        : summary.claimed === 0
          ? this.options.pollIntervalMs
          : 0;
      if (delay > 0 && !(await sleepUntilNextPoll(this.dependencies.scheduler, delay, signal))) {
        break;
      }
    }
    await this.drain();
  }

  /** Concurrent callers share one bounded claim/dispatch pass. */
  dispatchOnce(): Promise<EditableArtifactOutboxDispatchSummary> {
    if (this.activeDispatch) return this.activeDispatch;
    const dispatch = this.dispatchBatch();
    this.activeDispatch = dispatch;
    void dispatch.then(
      () => {
        if (this.activeDispatch === dispatch) this.activeDispatch = null;
      },
      () => {
        if (this.activeDispatch === dispatch) this.activeDispatch = null;
      },
    );
    return dispatch;
  }

  async drain(): Promise<void> {
    await this.activeDispatch;
  }

  private async dispatchBatch(): Promise<EditableArtifactOutboxDispatchSummary> {
    const summary = mutableSummary();
    let records: readonly EditableArtifactLiveOutboxRecord[];
    try {
      records = await this.dependencies.store.claimLiveOutbox({
        owner: this.options.owner,
        leaseDurationMs: this.options.leaseDurationMs,
        limit: this.options.batchSize,
      });
      if (!Array.isArray(records) || records.length > this.options.batchSize) {
        throw new TypeError("Outbox store returned an invalid claim batch");
      }
    } catch (error) {
      summary.claimFailed = true;
      this.metric("claim_failed");
      this.warn("Editable artifact outbox claim failed", "claim_failed", error);
      return freezeSummary(summary);
    }
    summary.claimed = records.length;
    if (records.length > 0) this.metric("claimed", records.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const record = records[index];
        if (!record) return;
        await this.dispatchRecord(record, summary);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(records.length, this.options.concurrency) },
        async () => await worker(),
      ),
    );
    return freezeSummary(summary);
  }

  private async dispatchRecord(
    record: EditableArtifactLiveOutboxRecord,
    summary: MutableSummary,
  ): Promise<void> {
    let outboxId: EditableArtifactOutboxId;
    try {
      outboxId = validateClaimedRecord(record, this.options.owner);
    } catch (error) {
      await this.deadLetter(record, "invalid_hint", summary, error);
      return;
    }
    let encoded: EditableArtifactEncodedBrokerHint;
    try {
      encoded = encodeEditableArtifactBrokerHint(record, this.options.maxHintBytes);
    } catch (error) {
      await this.deadLetter(
        record,
        error instanceof EditableArtifactHintEncodingError && error.code === "oversized_hint"
          ? "oversized_hint"
          : "invalid_hint",
        summary,
        error,
      );
      return;
    }

    const publishAbort = new AbortController();
    const renewalAbort = new AbortController();
    let leaseLost = false;
    const renewal = this.renewWhilePublishing(record, renewalAbort.signal, publishAbort, () => {
      leaseLost = true;
    }).catch((error: unknown) => {
      leaseLost = true;
      publishAbort.abort();
      this.warn("Editable artifact outbox renewal loop failed", "lease_lost", error);
    });
    let publishError: unknown = null;
    let timedOut = false;
    const startedAt = this.dependencies.clock.now().getTime();
    try {
      await withTimeout(
        this.dependencies.broker.publish({
          subject: encoded.subject,
          payload: encoded.payload.slice(),
          signal: publishAbort.signal,
        }),
        this.options.publishTimeoutMs,
        this.dependencies.scheduler,
        publishAbort,
        () => {
          timedOut = true;
        },
      );
    } catch (error) {
      publishError = error;
    } finally {
      renewalAbort.abort();
      await renewal;
      this.observePublish(timedOut ? "timed_out" : publishError ? "failed" : "acked", startedAt);
    }
    if (leaseLost) {
      summary.leaseLost += 1;
      this.metric("lease_lost");
      return;
    }
    if (publishError) {
      const errorCode: EditableArtifactOutboxRetryErrorCode = timedOut
        ? "publish_timeout"
        : brokerErrorCode(publishError);
      await this.retry(record, errorCode, summary, publishError);
      return;
    }

    // Extend once after broker ACK so the fenced mark cannot race a lease that
    // was nearly exhausted during publication.
    try {
      await this.dependencies.store.renewLiveOutbox({
        outboxId,
        owner: this.options.owner,
        attemptCount: record.attemptCount,
        leaseDurationMs: this.options.leaseDurationMs,
      });
    } catch (error) {
      summary.leaseLost += 1;
      this.metric("lease_lost");
      this.warn("Editable artifact outbox lease was lost after broker ACK", "lease_lost", error);
      return;
    }
    try {
      await this.dependencies.store.markLiveOutboxPublished({
        outboxId,
        owner: this.options.owner,
        attemptCount: record.attemptCount,
      });
      summary.published += 1;
      this.metric("published");
    } catch (error) {
      // The publish may have succeeded. Never turn an unknown mark outcome into
      // an eager retry; lease expiry safely permits an at-least-once duplicate.
      summary.markFailed += 1;
      this.metric("mark_failed");
      this.warn("Editable artifact outbox publish mark failed", "mark_failed", error);
    }
  }

  private async renewWhilePublishing(
    record: EditableArtifactLiveOutboxRecord,
    signal: AbortSignal,
    publishAbort: AbortController,
    onLeaseLost: () => void,
  ): Promise<void> {
    for (;;) {
      if (
        !(await sleepUntilNextPoll(
          this.dependencies.scheduler,
          this.options.leaseRenewIntervalMs,
          signal,
        ))
      ) {
        return;
      }
      try {
        await this.dependencies.store.renewLiveOutbox({
          outboxId: editableArtifactOutboxId(record.outboxId),
          owner: this.options.owner,
          attemptCount: record.attemptCount,
          leaseDurationMs: this.options.leaseDurationMs,
        });
      } catch (error) {
        onLeaseLost();
        publishAbort.abort();
        this.warn("Editable artifact outbox lease renewal failed", "lease_lost", error);
        return;
      }
    }
  }

  private async retry(
    record: EditableArtifactLiveOutboxRecord,
    errorCode: EditableArtifactOutboxRetryErrorCode,
    summary: MutableSummary,
    error: unknown,
  ): Promise<void> {
    const retryDelayMs = exponentialDelay(
      record.attemptCount,
      this.options.retryBaseMs,
      this.options.retryMaxMs,
      this.options.retryJitterRatio,
      this.dependencies.random,
    );
    try {
      await this.dependencies.store.retryLiveOutbox({
        outboxId: editableArtifactOutboxId(record.outboxId),
        owner: this.options.owner,
        attemptCount: record.attemptCount,
        retryDelayMs,
        errorCode,
      });
      summary.retried += 1;
      this.metric("retried");
    } catch (retryError) {
      this.metric("retry_store_failed");
      this.warn(
        "Editable artifact outbox retry persistence failed",
        "retry_store_failed",
        retryError,
      );
    }
    this.warn("Editable artifact hint publish failed", errorCode, error);
  }

  private async deadLetter(
    record: EditableArtifactLiveOutboxRecord,
    errorCode: EditableArtifactOutboxDeadLetterErrorCode,
    summary: MutableSummary,
    error: unknown,
  ): Promise<void> {
    try {
      await this.dependencies.store.deadLetterLiveOutbox({
        outboxId: editableArtifactOutboxId(record.outboxId),
        owner: this.options.owner,
        attemptCount: record.attemptCount,
        errorCode,
      });
      summary.deadLettered += 1;
      this.metric("dead_lettered");
    } catch (deadLetterError) {
      this.metric("dead_letter_store_failed");
      this.warn(
        "Editable artifact outbox dead-letter persistence failed",
        "dead_letter_store_failed",
        deadLetterError,
      );
    }
    this.warn("Editable artifact outbox contains an undeliverable hint", errorCode, error);
  }

  private metric(outcome: EditableArtifactOutboxMetricOutcome, count = 1): void {
    try {
      this.dependencies.metrics?.increment(outcome, count);
    } catch {
      // Metrics cannot affect delivery.
    }
  }

  private observePublish(outcome: "acked" | "failed" | "timed_out", startedAt: number): void {
    let elapsed = 0;
    const now = this.dependencies.clock.now().getTime();
    if (Number.isFinite(now) && Number.isFinite(startedAt)) elapsed = Math.max(0, now - startedAt);
    try {
      this.dependencies.metrics?.observePublishSeconds(outcome, elapsed / 1_000);
    } catch {
      // Metrics cannot affect delivery.
    }
  }

  private warn(message: string, code: string, error: unknown): void {
    try {
      this.dependencies.logger?.warn(message, {
        code,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
    } catch {
      // Logging cannot affect delivery.
    }
  }
}

export class EditableArtifactHintEncodingError extends Error {
  constructor(
    readonly code: EditableArtifactOutboxDeadLetterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditableArtifactHintEncodingError";
  }
}

export function encodeEditableArtifactBrokerHint(
  record: EditableArtifactLiveOutboxRecord,
  maxBytes = EDITABLE_ARTIFACT_HINT_MAX_BYTES,
): EditableArtifactEncodedBrokerHint {
  assertPositiveSafeInteger(maxBytes, "maximum broker hint bytes");
  let hint: EditableArtifactBrokerHint;
  try {
    const event = record.event;
    const scope = editableArtifactScope(event.scope);
    const artifactId = editableArtifactId(event.artifactId);
    const stateHash = editableArtifactStateHash(event.stateHash);
    if (event.schemaVersion !== 1) throw new TypeError("Unsupported artifact hint schema");
    if (event.kind === "transaction_committed") {
      assertPositiveSafeInteger(event.sequenceEnd, "hint head sequence");
      const common = {
        kind: "head_advanced",
        schemaVersion: 1,
        scope,
        artifactId,
        modality: event.modality,
        headSequence: event.sequenceEnd,
        stateHash,
      } as const;
      if (event.modality === "spreadsheet") {
        assertPositiveSafeInteger(
          event.operationProtocolVersion,
          "hint operation protocol version",
        );
        hint = Object.freeze({
          ...common,
          modality: "spreadsheet",
          operationProtocolVersion: event.operationProtocolVersion,
        });
      } else {
        assertPositiveSafeInteger(event.commitProtocolVersion, "hint commit protocol version");
        hint = Object.freeze({
          ...common,
          modality: event.modality,
          commitProtocolVersion: event.commitProtocolVersion,
        });
      }
    } else if (event.kind === "snapshot_published") {
      assertNonnegativeSafeInteger(event.coveredHeadSequence, "snapshot hint head sequence");
      const common = {
        kind: "snapshot_available",
        schemaVersion: 1,
        scope,
        artifactId,
        modality: event.modality,
        headSequence: event.coveredHeadSequence,
        stateHash,
        snapshotId: editableArtifactSnapshotId(event.snapshotId),
      } as const;
      if (event.modality === "spreadsheet") {
        assertPositiveSafeInteger(
          event.operationProtocolVersion,
          "hint operation protocol version",
        );
        hint = Object.freeze({
          ...common,
          modality: "spreadsheet",
          operationProtocolVersion: event.operationProtocolVersion,
        });
      } else {
        hint = Object.freeze({ ...common, modality: event.modality });
      }
    } else {
      throw new TypeError("Unknown editable artifact outbox event");
    }
    const payload = textEncoder.encode(JSON.stringify(hint));
    if (payload.byteLength > maxBytes) {
      throw new EditableArtifactHintEncodingError(
        "oversized_hint",
        "Editable artifact broker hint exceeds its byte limit",
      );
    }
    return Object.freeze({
      subject: editableArtifactLiveHintSubject(scope, artifactId),
      payload,
      hint,
    });
  } catch (error) {
    if (error instanceof EditableArtifactHintEncodingError) throw error;
    throw new EditableArtifactHintEncodingError(
      "invalid_hint",
      "Editable artifact outbox event cannot be projected to a broker hint",
    );
  }
}

export function editableArtifactLiveHintSubject(
  scope: EditableArtifactScope,
  artifactIdInput: string,
): string {
  const normalized = editableArtifactScope(scope);
  const artifactId = editableArtifactId(artifactIdInput);
  const subject = [
    EDITABLE_ARTIFACT_HINT_SUBJECT_PREFIX,
    base64Url(textEncoder.encode(normalized.accountId)),
    base64Url(textEncoder.encode(normalized.workspaceId)),
    artifactId,
  ].join(".");
  if (textEncoder.encode(subject).byteLength > 1_024) {
    throw new EditableArtifactHintEncodingError(
      "invalid_hint",
      "Editable artifact hint subject exceeds its byte limit",
    );
  }
  return subject;
}

export function decodeEditableArtifactBrokerHint(
  payload: Uint8Array,
  expected: Readonly<{ scope: EditableArtifactScope; artifactId: string }>,
  maxBytes = EDITABLE_ARTIFACT_HINT_MAX_BYTES,
): EditableArtifactBrokerHint {
  if (!(payload instanceof Uint8Array) || payload.byteLength < 2 || payload.byteLength > maxBytes) {
    throw new EditableArtifactHintEncodingError(
      "oversized_hint",
      "Editable artifact broker hint exceeds its byte limit",
    );
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("hint must be an object");
    }
    const record = value as Record<string, unknown>;
    if (JSON.stringify(record) !== text) throw new TypeError("hint must be canonical JSON");
    const kind = record.kind;
    const modality = record.modality;
    if (modality !== "spreadsheet" && modality !== "document" && modality !== "presentation") {
      throw new TypeError("hint modality invalid");
    }
    const keys = Object.keys(record);
    const expectedKeys =
      kind === "head_advanced"
        ? modality === "spreadsheet"
          ? [
              "kind",
              "schemaVersion",
              "scope",
              "artifactId",
              "modality",
              "headSequence",
              "stateHash",
              "operationProtocolVersion",
            ]
          : [
              "kind",
              "schemaVersion",
              "scope",
              "artifactId",
              "modality",
              "headSequence",
              "stateHash",
              "commitProtocolVersion",
            ]
        : modality === "spreadsheet"
          ? [
              "kind",
              "schemaVersion",
              "scope",
              "artifactId",
              "modality",
              "headSequence",
              "stateHash",
              "snapshotId",
              "operationProtocolVersion",
            ]
          : [
              "kind",
              "schemaVersion",
              "scope",
              "artifactId",
              "modality",
              "headSequence",
              "stateHash",
              "snapshotId",
            ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw new TypeError("hint fields invalid");
    }
    if (record.schemaVersion !== 1) throw new TypeError("hint schema invalid");
    const scope = editableArtifactScope(record.scope as EditableArtifactScope);
    const artifactId = editableArtifactId(record.artifactId as string);
    if (
      scope.accountId !== expected.scope.accountId ||
      scope.workspaceId !== expected.scope.workspaceId ||
      artifactId !== editableArtifactId(expected.artifactId)
    ) {
      throw new TypeError("hint authority mismatch");
    }
    assertNonnegativeSafeInteger(record.headSequence as number, "hint head sequence");
    if (modality === "spreadsheet") {
      assertPositiveSafeInteger(
        record.operationProtocolVersion as number,
        "hint operation protocol version",
      );
    } else if (kind === "head_advanced") {
      assertPositiveSafeInteger(
        record.commitProtocolVersion as number,
        "hint commit protocol version",
      );
    }
    editableArtifactStateHash(record.stateHash as string);
    if (kind === "head_advanced") return Object.freeze(record) as EditableArtifactBrokerHint;
    if (kind === "snapshot_available") {
      editableArtifactSnapshotId(record.snapshotId as string);
      return Object.freeze(record) as EditableArtifactBrokerHint;
    }
    throw new TypeError("hint kind invalid");
  } catch (error) {
    if (error instanceof EditableArtifactHintEncodingError) throw error;
    throw new EditableArtifactHintEncodingError(
      "invalid_hint",
      "Editable artifact broker hint is invalid",
    );
  }
}

export class MathEditableArtifactOutboxRandom implements EditableArtifactOutboxRandomPort {
  unit(): number {
    return Math.random();
  }
}

function validateClaimedRecord(
  record: EditableArtifactLiveOutboxRecord,
  owner: string,
): EditableArtifactOutboxId {
  const outboxId = editableArtifactOutboxId(record.outboxId);
  if (record.state !== "publishing") throw new TypeError("Claimed outbox row is not publishing");
  if (record.leaseOwner !== owner) throw new TypeError("Claimed outbox row has another owner");
  assertPositiveSafeInteger(record.attemptCount, "outbox attempt count");
  if (record.leaseExpiresAt === null) throw new TypeError("Claimed outbox row has no lease expiry");
  return outboxId;
}

function normalizeOptions(options: EditableArtifactOutboxDispatcherOptions): NormalizedOptions {
  const owner = boundedOwner(options.owner);
  const normalized = {
    owner,
    batchSize: options.batchSize ?? DEFAULTS.batchSize,
    concurrency: options.concurrency ?? DEFAULTS.concurrency,
    leaseDurationMs: options.leaseDurationMs ?? DEFAULTS.leaseDurationMs,
    leaseRenewIntervalMs: options.leaseRenewIntervalMs ?? DEFAULTS.leaseRenewIntervalMs,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
    publishTimeoutMs: options.publishTimeoutMs ?? DEFAULTS.publishTimeoutMs,
    retryBaseMs: options.retryBaseMs ?? DEFAULTS.retryBaseMs,
    retryMaxMs: options.retryMaxMs ?? DEFAULTS.retryMaxMs,
    retryJitterRatio: options.retryJitterRatio ?? DEFAULTS.retryJitterRatio,
    claimBackoffBaseMs: options.claimBackoffBaseMs ?? DEFAULTS.claimBackoffBaseMs,
    claimBackoffMaxMs: options.claimBackoffMaxMs ?? DEFAULTS.claimBackoffMaxMs,
    maxHintBytes: options.maxHintBytes ?? DEFAULTS.maxHintBytes,
  };
  for (const [label, value] of Object.entries(normalized)) {
    if (label === "owner" || label === "retryJitterRatio") continue;
    if (typeof value !== "number") throw new TypeError(`${label} must be numeric`);
    assertPositiveSafeInteger(value, label);
  }
  if (normalized.batchSize > 256) throw new TypeError("outbox batch size exceeds 256");
  if (normalized.concurrency > normalized.batchSize)
    throw new TypeError("outbox concurrency exceeds batch size");
  if (normalized.leaseDurationMs < 5_000 || normalized.leaseDurationMs > 300_000)
    throw new TypeError("outbox lease duration must be 5-300 seconds");
  if (normalized.leaseRenewIntervalMs * 2 >= normalized.leaseDurationMs)
    throw new TypeError("outbox lease renewal interval must be less than half the lease");
  if (normalized.publishTimeoutMs >= normalized.leaseDurationMs)
    throw new TypeError("outbox publish timeout must be shorter than the lease");
  if (normalized.retryBaseMs > normalized.retryMaxMs)
    throw new TypeError("outbox retry base exceeds retry maximum");
  if (normalized.claimBackoffBaseMs > normalized.claimBackoffMaxMs)
    throw new TypeError("outbox claim backoff base exceeds its maximum");
  if (
    !Number.isFinite(normalized.retryJitterRatio) ||
    normalized.retryJitterRatio < 0 ||
    normalized.retryJitterRatio > 1
  ) {
    throw new TypeError("outbox retry jitter ratio must be between zero and one");
  }
  if (normalized.maxHintBytes > EDITABLE_ARTIFACT_HINT_MAX_BYTES)
    throw new TypeError("outbox hint byte limit exceeds the protocol maximum");
  return Object.freeze(normalized);
}

function boundedOwner(value: string): string {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes < 1 || bytes > 200 || value.trim() !== value || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new TypeError("outbox owner is malformed");
  }
  return value;
}

function exponentialDelay(
  attempt: number,
  base: number,
  maximum: number,
  jitterRatio: number,
  random: EditableArtifactOutboxRandomPort,
): number {
  const exponent = Math.min(30, Math.max(0, attempt - 1));
  const withoutJitter = Math.min(maximum, base * 2 ** exponent);
  const sample = random.unit();
  const unit = Number.isFinite(sample) && sample >= 0 && sample < 1 ? sample : 0.5;
  const jitter = Math.floor(withoutJitter * jitterRatio * unit);
  return Math.min(maximum, withoutJitter + jitter);
}

async function withTimeout(
  operation: Promise<void>,
  timeoutMs: number,
  scheduler: EditableArtifactLiveSchedulerPort,
  operationAbort: AbortController,
  onTimeout: () => void,
): Promise<void> {
  const timeoutAbort = new AbortController();
  try {
    await Promise.race([
      operation,
      scheduler.sleep(timeoutMs, timeoutAbort.signal).then(() => {
        onTimeout();
        operationAbort.abort();
        throw new Error("Editable artifact broker publish timed out");
      }),
    ]);
  } finally {
    timeoutAbort.abort();
  }
}

async function sleepUntilNextPoll(
  scheduler: EditableArtifactLiveSchedulerPort,
  milliseconds: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await scheduler.sleep(milliseconds, signal);
    return true;
  } catch (error) {
    if (signal.aborted) return false;
    throw error;
  }
}

function brokerErrorCode(error: unknown): EditableArtifactOutboxRetryErrorCode {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "broker_backpressure"
  ) {
    return "broker_backpressure";
  }
  return "broker_unavailable";
}

function mutableSummary(): MutableSummary {
  return {
    claimed: 0,
    published: 0,
    retried: 0,
    deadLettered: 0,
    leaseLost: 0,
    markFailed: 0,
    claimFailed: false,
  };
}

function freezeSummary(summary: MutableSummary): EditableArtifactOutboxDispatchSummary {
  return Object.freeze({ ...summary });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
