import { createHash } from "node:crypto";
import { EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES } from "@opengeni/contracts/editable-artifacts";
import { sql, type SQL } from "drizzle-orm";

import { rawRows, type Database } from "./database";

/**
 * Database boundary for the global artifact materializer.
 *
 * The worker connection is deliberately not tenant-scoped: it may claim jobs
 * from every workspace. It receives no table privileges. Every mutation below
 * goes through a narrowly granted SECURITY DEFINER function which owns the
 * global SKIP LOCKED scan and the exact owner + attempt-count lease fence.
 */

export const EDITABLE_ARTIFACT_MATERIALIZATION_MAX_CLAIM = 1_000;
export const EDITABLE_ARTIFACT_MATERIALIZATION_MAX_LEASE_MS = 86_400_000;
export const EDITABLE_ARTIFACT_MATERIALIZATION_MAX_ATTEMPTS = 1_000;
export const EDITABLE_ARTIFACT_MATERIALIZATION_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const EDITABLE_ARTIFACT_MATERIALIZATION_MAX_OPTIONS_BYTES = 256 * 1024;

export type EditableArtifactMaterializationFormat =
  | "xlsx"
  | "pptx"
  | "docx"
  | "pdf"
  | "png"
  | "webp";

export type EditableArtifactMaterializationMimeType =
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/pdf"
  | "image/png"
  | "image/webp";

export type EditableArtifactMaterializationScope = Readonly<{
  accountId: string;
  workspaceId: string;
}>;

export type EditableArtifactMaterializationModality = "spreadsheet" | "presentation" | "document";

export type ClaimedEditableArtifactMaterialization = Readonly<{
  scope: EditableArtifactMaterializationScope;
  artifactId: string;
  jobId: string;
  versionId: string | null;
  modality: EditableArtifactMaterializationModality;
  inputSnapshotId: string;
  targetHeadSequence: number;
  stateHash: string;
  sourceObjectReference: string;
  sourceByteSize: number;
  sourceContentHash: string;
  sourceMimeType: string;
  modelSchemaVersion: number;
  operationProtocolVersion: number;
  snapshotProtocolVersion: number;
  format: EditableArtifactMaterializationFormat;
  codecId: string;
  normalizedOptions: string;
  optionsHash: string;
  codecVersion: string;
  kernelVersion: string;
  fontRegistryHash: string;
  policyHash: string;
  attemptCount: number;
  leaseOwner: string;
  leaseExpiresAt: string;
}>;

/** @deprecated Use the self-contained pinned source manifest name. */
export type ClaimedEditableArtifactMaterializationJob = ClaimedEditableArtifactMaterialization;

export type ClaimEditableArtifactMaterializationsRequest = Readonly<{
  owner: string;
  leaseDurationMs: number;
  limit: number;
}>;

export type EditableArtifactMaterializationLease = Readonly<{
  scope: EditableArtifactMaterializationScope;
  artifactId: string;
  jobId: string;
  owner: string;
  attemptCount: number;
}>;

export type RenewEditableArtifactMaterializationRequest = EditableArtifactMaterializationLease &
  Readonly<{
    leaseDurationMs: number;
  }>;

export type SucceedEditableArtifactMaterializationRequest = EditableArtifactMaterializationLease &
  Readonly<{
    resultId: string;
    blobRefId: string;
    /** Immutable, content-addressed object-store reference written before settlement. */
    objectReference: string;
    byteSize: number;
    contentHash: string;
    mimeType: EditableArtifactMaterializationMimeType;
    verifiedAt: string;
  }>;

export type PersistedEditableArtifactMaterializationResult = Readonly<{
  scope: EditableArtifactMaterializationScope;
  artifactId: string;
  jobId: string;
  resultId: string;
  blobRefId: string;
  objectReference: string;
  byteSize: number;
  contentHash: string;
  mimeType: EditableArtifactMaterializationMimeType;
  verifiedAt: string;
  createdAt: string;
  replayed: boolean;
}>;

export type FailEditableArtifactMaterializationRequest = EditableArtifactMaterializationLease &
  Readonly<{
    /** Bounded machine code only; never place provider diagnostics here. */
    errorCode: string;
  }>;

export type FailEditableArtifactMaterializationResult = Readonly<{
  replayed: boolean;
}>;

export interface EditableArtifactMaterializationRepository {
  claim(
    request: ClaimEditableArtifactMaterializationsRequest,
  ): Promise<readonly ClaimedEditableArtifactMaterialization[]>;
  renew(request: RenewEditableArtifactMaterializationRequest): Promise<string>;
  succeed(
    request: SucceedEditableArtifactMaterializationRequest,
  ): Promise<PersistedEditableArtifactMaterializationResult>;
  fail(
    request: FailEditableArtifactMaterializationRequest,
  ): Promise<FailEditableArtifactMaterializationResult>;
}

export class EditableArtifactMaterializationPersistenceError extends Error {
  constructor(
    readonly code: "lease_fenced" | "database_contract_violation",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EditableArtifactMaterializationPersistenceError";
  }
}

export type PostgresEditableArtifactMaterializationRepositoryOptions = Readonly<{
  /** Unquoted PostgreSQL schema. Unset resolves through current_schema() in SQL. */
  dataSchema?: string;
}>;

type MaterializerDatabase = Pick<Database, "execute">;

type ClaimRow = Record<string, unknown> & {
  account_id: unknown;
  workspace_id: unknown;
  artifact_id: unknown;
  job_id: unknown;
  version_id: unknown;
  modality: unknown;
  input_snapshot_id: unknown;
  target_head_sequence: unknown;
  state_hash: unknown;
  source_object_reference: unknown;
  source_byte_size: unknown;
  source_content_hash: unknown;
  source_mime_type: unknown;
  model_schema_version: unknown;
  operation_protocol_version: unknown;
  snapshot_protocol_version: unknown;
  format: unknown;
  codec_id: unknown;
  normalized_options: unknown;
  options_hash: unknown;
  codec_version: unknown;
  kernel_version: unknown;
  font_registry_hash: unknown;
  policy_hash: unknown;
  attempt_count: unknown;
  lease_owner: unknown;
  lease_expires_at: unknown;
};

type RenewalRow = Record<string, unknown> & {
  account_id: unknown;
  workspace_id: unknown;
  artifact_id: unknown;
  job_id: unknown;
  lease_owner: unknown;
  attempt_count: unknown;
  lease_expires_at: unknown;
};

type SuccessRow = Record<string, unknown> & {
  outcome: unknown;
  account_id: unknown;
  workspace_id: unknown;
  artifact_id: unknown;
  job_id: unknown;
  result_id: unknown;
  blob_ref_id: unknown;
  object_reference: unknown;
  byte_size: unknown;
  content_hash: unknown;
  mime_type: unknown;
  verified_at: unknown;
  created_at: unknown;
  settled_by_owner: unknown;
  attempt_count: unknown;
};

type FailureRow = Record<string, unknown> & {
  outcome: unknown;
  account_id: unknown;
  workspace_id: unknown;
  artifact_id: unknown;
  job_id: unknown;
  settled_by_owner: unknown;
  attempt_count: unknown;
  error_code: unknown;
};

export class PostgresEditableArtifactMaterializationRepository implements EditableArtifactMaterializationRepository {
  private readonly dataSchema: string | null;

  constructor(
    private readonly db: MaterializerDatabase,
    options: PostgresEditableArtifactMaterializationRepositoryOptions = {},
  ) {
    this.dataSchema =
      options.dataSchema === undefined ? null : validateDataSchema(options.dataSchema);
  }

  async claim(
    request: ClaimEditableArtifactMaterializationsRequest,
  ): Promise<readonly ClaimedEditableArtifactMaterializationJob[]> {
    const owner = validateOwner(request.owner);
    const leaseDurationMs = validateInteger(
      request.leaseDurationMs,
      "materialization lease duration",
      1,
      EDITABLE_ARTIFACT_MATERIALIZATION_MAX_LEASE_MS,
    );
    const limit = validateInteger(
      request.limit,
      "materialization claim limit",
      1,
      EDITABLE_ARTIFACT_MATERIALIZATION_MAX_CLAIM,
    );
    const rows = await rawRows<ClaimRow>(
      this.db,
      sql`select * from opengeni_private.claim_editable_artifact_materializations(
        ${owner}, ${leaseDurationMs}, ${limit}, ${this.schemaArgument()}
      )`,
    );
    if (rows.length > limit) {
      throw contractViolation("Materialization claim returned more rows than requested");
    }
    const jobs = rows.map((row) => claimedJobFromRow(row, owner));
    const identities = new Set<string>();
    for (const job of jobs) {
      const identity = `${job.scope.accountId}\0${job.scope.workspaceId}\0${job.artifactId}\0${job.jobId}`;
      if (identities.has(identity)) {
        throw contractViolation("Materialization claim returned a duplicate job identity");
      }
      identities.add(identity);
    }
    return Object.freeze(jobs);
  }

  async renew(request: RenewEditableArtifactMaterializationRequest): Promise<string> {
    const lease = validateLease(request);
    const leaseDurationMs = validateInteger(
      request.leaseDurationMs,
      "materialization lease duration",
      1,
      EDITABLE_ARTIFACT_MATERIALIZATION_MAX_LEASE_MS,
    );
    const rows = await rawRows<RenewalRow>(
      this.db,
      sql`select * from opengeni_private.renew_editable_artifact_materialization(
        ${lease.scope.accountId}::uuid,
        ${lease.scope.workspaceId}::uuid,
        ${lease.artifactId},
        ${lease.jobId},
        ${lease.owner},
        ${lease.attemptCount},
        ${leaseDurationMs},
        ${this.schemaArgument()}
      )`,
    );
    if (rows.length === 0) throw leaseFenced();
    if (rows.length !== 1) {
      throw contractViolation("Materialization renewal returned an invalid row count");
    }
    assertReturnedLeaseFence(rows[0]!, lease, "lease_owner", "renewal");
    return databaseTimestamp(rows[0]!.lease_expires_at, "renewed lease expiration");
  }

  async succeed(
    request: SucceedEditableArtifactMaterializationRequest,
  ): Promise<PersistedEditableArtifactMaterializationResult> {
    const lease = validateLease(request);
    const resultId = validateStableId(request.resultId, "materialization result id");
    const blobRefId = validateStableId(request.blobRefId, "materialization blob id");
    const objectReference = validateBoundedText(
      request.objectReference,
      "materialization object reference",
      1_024,
    );
    const byteSize = validateInteger(
      request.byteSize,
      "materialization byte size",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const contentHash = validateHash(request.contentHash, "materialization content hash");
    const mimeType = validateMimeType(request.mimeType);
    const verifiedAt = validateTimestamp(request.verifiedAt, "materialization verification time");
    const rows = await rawRows<SuccessRow>(
      this.db,
      sql`select * from opengeni_private.succeed_editable_artifact_materialization(
        ${lease.scope.accountId}::uuid,
        ${lease.scope.workspaceId}::uuid,
        ${lease.artifactId},
        ${lease.jobId},
        ${lease.owner},
        ${lease.attemptCount},
        ${resultId},
        ${blobRefId},
        ${objectReference},
        ${byteSize},
        ${contentHash},
        ${mimeType},
        ${verifiedAt}::timestamptz,
        ${this.schemaArgument()}
      )`,
    );
    if (rows.length === 0) throw leaseFenced();
    if (rows.length !== 1) {
      throw contractViolation("Materialization success returned an invalid row count");
    }
    return resultFromRow(rows[0]!, {
      lease,
      resultId,
      blobRefId,
      objectReference,
      byteSize,
      contentHash,
      mimeType,
      verifiedAt,
    });
  }

  async fail(
    request: FailEditableArtifactMaterializationRequest,
  ): Promise<FailEditableArtifactMaterializationResult> {
    const lease = validateLease(request);
    const errorCode = validateErrorCode(request.errorCode);
    const rows = await rawRows<FailureRow>(
      this.db,
      sql`select * from opengeni_private.fail_editable_artifact_materialization(
        ${lease.scope.accountId}::uuid,
        ${lease.scope.workspaceId}::uuid,
        ${lease.artifactId},
        ${lease.jobId},
        ${lease.owner},
        ${lease.attemptCount},
        ${errorCode},
        ${this.schemaArgument()}
      )`,
    );
    if (rows.length !== 1) {
      throw contractViolation("Materialization failure returned an invalid row count");
    }
    const outcome = rows[0]!.outcome;
    if (outcome === "fenced") throw leaseFenced();
    if (outcome !== "failed" && outcome !== "replayed") {
      throw contractViolation("Materialization failure returned an invalid outcome");
    }
    assertReturnedLeaseFence(rows[0]!, lease, "settled_by_owner", "failure");
    if (rows[0]!.error_code !== errorCode) {
      throw contractViolation("Materialization failure returned a different error code");
    }
    return Object.freeze({ replayed: outcome === "replayed" });
  }

  private schemaArgument(): SQL {
    return this.dataSchema === null
      ? sql`pg_catalog.current_schema()`
      : sql`${this.dataSchema}::name`;
  }
}

function claimedJobFromRow(
  row: ClaimRow,
  expectedOwner: string,
): ClaimedEditableArtifactMaterialization {
  const leaseOwner = validateDatabaseOwner(row.lease_owner);
  if (leaseOwner !== expectedOwner) {
    throw contractViolation("Claimed materialization lease owner differs from the claimant");
  }
  const leaseExpiresAt = databaseTimestamp(
    row.lease_expires_at,
    "materialization lease expiration",
  );
  const modality = validateDatabaseModality(row.modality);
  const format = validateDatabaseFormat(row.format);
  validateFormatForModality(modality, format);
  const optionsHash = validateDatabaseHash(row.options_hash, "materialization options hash");
  const sourceMimeType = validateDatabaseText(
    row.source_mime_type,
    "materialization source MIME type",
    256,
  );
  if (sourceMimeType !== "application/vnd.opengeni.editable-artifact-snapshot") {
    throw contractViolation("Materialization source is not an editable artifact snapshot");
  }
  return Object.freeze({
    scope: validateDatabaseScope(row.account_id, row.workspace_id),
    artifactId: validateDatabaseStableId(row.artifact_id, "artifact id"),
    jobId: validateDatabaseStableId(row.job_id, "materialization job id"),
    versionId:
      row.version_id === null
        ? null
        : validateDatabaseStableId(row.version_id, "artifact version id"),
    modality,
    inputSnapshotId: validateDatabaseStableId(
      row.input_snapshot_id,
      "materialization input snapshot id",
    ),
    targetHeadSequence: databaseInteger(
      row.target_head_sequence,
      "materialization target head sequence",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    stateHash: validateDatabaseHash(row.state_hash, "materialization state hash"),
    sourceObjectReference: validateDatabaseText(
      row.source_object_reference,
      "materialization source object reference",
      1_024,
    ),
    sourceByteSize: databaseInteger(
      row.source_byte_size,
      "materialization source byte size",
      1,
      EDITABLE_ARTIFACT_MATERIALIZATION_MAX_SOURCE_BYTES,
    ),
    sourceContentHash: validateDatabaseHash(
      row.source_content_hash,
      "materialization source content hash",
    ),
    sourceMimeType,
    modelSchemaVersion: databaseInteger(
      row.model_schema_version,
      "materialization source model schema version",
      1,
      2_147_483_647,
    ),
    operationProtocolVersion: databaseInteger(
      row.operation_protocol_version,
      "materialization source operation protocol version",
      1,
      2_147_483_647,
    ),
    snapshotProtocolVersion: databaseInteger(
      row.snapshot_protocol_version,
      "materialization source snapshot protocol version",
      1,
      2_147_483_647,
    ),
    format,
    codecId: validateDatabaseText(row.codec_id, "codec id", 128),
    normalizedOptions: validateDatabaseNormalizedOptions(row.normalized_options, optionsHash),
    optionsHash,
    codecVersion: validateDatabaseText(row.codec_version, "codec version", 128),
    kernelVersion: validateDatabaseText(
      row.kernel_version,
      "kernel version",
      EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES,
    ),
    fontRegistryHash: validateDatabaseHash(row.font_registry_hash, "font registry hash"),
    policyHash: validateDatabaseHash(row.policy_hash, "materialization policy hash"),
    attemptCount: databaseInteger(
      row.attempt_count,
      "materialization attempt count",
      1,
      EDITABLE_ARTIFACT_MATERIALIZATION_MAX_ATTEMPTS,
    ),
    leaseOwner,
    leaseExpiresAt,
  });
}

function resultFromRow(
  row: SuccessRow,
  expected: Readonly<{
    lease: EditableArtifactMaterializationLease;
    resultId: string;
    blobRefId: string;
    objectReference: string;
    byteSize: number;
    contentHash: string;
    mimeType: EditableArtifactMaterializationMimeType;
    verifiedAt: string;
  }>,
): PersistedEditableArtifactMaterializationResult {
  if (row.outcome !== "committed" && row.outcome !== "replayed") {
    throw contractViolation("Materialization success returned an invalid outcome");
  }
  assertReturnedLeaseFence(row, expected.lease, "settled_by_owner", "success");
  const scope = validateDatabaseScope(row.account_id, row.workspace_id);
  const artifactId = validateDatabaseStableId(row.artifact_id, "artifact id");
  const jobId = validateDatabaseStableId(row.job_id, "materialization job id");
  const resultId = validateDatabaseStableId(row.result_id, "materialization result id");
  const blobRefId = validateDatabaseStableId(row.blob_ref_id, "materialization blob id");
  const objectReference = validateDatabaseText(
    row.object_reference,
    "materialization object reference",
    1_024,
  );
  const byteSize = databaseInteger(
    row.byte_size,
    "materialization byte size",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const contentHash = validateDatabaseHash(row.content_hash, "materialization content hash");
  const mimeType = validateDatabaseMimeType(row.mime_type);
  const verifiedAt = databaseTimestamp(row.verified_at, "materialization verification time");
  const createdAt = databaseTimestamp(row.created_at, "materialization result creation time");
  if (
    scope.accountId !== expected.lease.scope.accountId ||
    scope.workspaceId !== expected.lease.scope.workspaceId ||
    artifactId !== expected.lease.artifactId ||
    jobId !== expected.lease.jobId ||
    resultId !== expected.resultId ||
    blobRefId !== expected.blobRefId ||
    objectReference !== expected.objectReference ||
    byteSize !== expected.byteSize ||
    contentHash !== expected.contentHash ||
    mimeType !== expected.mimeType ||
    verifiedAt !== expected.verifiedAt
  ) {
    throw contractViolation("Materialization result differs from the exact settlement facts");
  }
  if (Date.parse(verifiedAt) > Date.parse(createdAt)) {
    throw contractViolation("Materialization result predates its verification");
  }
  return Object.freeze({
    scope,
    artifactId,
    jobId,
    resultId,
    blobRefId,
    objectReference,
    byteSize,
    contentHash,
    mimeType,
    verifiedAt,
    createdAt,
    replayed: row.outcome === "replayed",
  });
}

function validateLease(
  input: EditableArtifactMaterializationLease,
): EditableArtifactMaterializationLease {
  return Object.freeze({
    scope: validateScope(input.scope),
    artifactId: validateStableId(input.artifactId, "artifact id"),
    jobId: validateStableId(input.jobId, "materialization job id"),
    owner: validateOwner(input.owner),
    attemptCount: validateInteger(
      input.attemptCount,
      "materialization attempt count",
      1,
      EDITABLE_ARTIFACT_MATERIALIZATION_MAX_ATTEMPTS,
    ),
  });
}

function assertReturnedLeaseFence(
  row: Record<string, unknown>,
  expected: EditableArtifactMaterializationLease,
  ownerColumn: "lease_owner" | "settled_by_owner",
  operation: string,
): void {
  const scope = validateDatabaseScope(row.account_id, row.workspace_id);
  const artifactId = validateDatabaseStableId(row.artifact_id, "artifact id");
  const jobId = validateDatabaseStableId(row.job_id, "materialization job id");
  const owner = validateDatabaseOwner(row[ownerColumn]);
  const attemptCount = databaseInteger(
    row.attempt_count,
    "materialization attempt count",
    1,
    EDITABLE_ARTIFACT_MATERIALIZATION_MAX_ATTEMPTS,
  );
  if (
    scope.accountId !== expected.scope.accountId ||
    scope.workspaceId !== expected.scope.workspaceId ||
    artifactId !== expected.artifactId ||
    jobId !== expected.jobId ||
    owner !== expected.owner ||
    attemptCount !== expected.attemptCount
  ) {
    throw contractViolation(`Materialization ${operation} returned a different lease fence`);
  }
}

function validateScope(
  scope: EditableArtifactMaterializationScope,
): EditableArtifactMaterializationScope {
  if (!scope || typeof scope !== "object") throw new TypeError("Materialization scope is invalid");
  return Object.freeze({
    accountId: validateUuid(scope.accountId, "account id"),
    workspaceId: validateUuid(scope.workspaceId, "workspace id"),
  });
}

function validateDatabaseScope(
  accountId: unknown,
  workspaceId: unknown,
): EditableArtifactMaterializationScope {
  try {
    return Object.freeze({
      accountId: validateUuid(accountId, "account id"),
      workspaceId: validateUuid(workspaceId, "workspace id"),
    });
  } catch (error) {
    throw contractViolation("Materialization row contains an invalid tenant scope", error);
  }
}

function validateUuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new TypeError(`${label} must be a canonical lowercase UUID`);
  }
  return value;
}

function validateStableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value) || /^0+$/.test(value)) {
    throw new TypeError(`${label} must be fixed-width lowercase nonzero hexadecimal text`);
  }
  return value;
}

function validateHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
  return value;
}

function validateOwner(value: unknown): string {
  return validateBoundedText(value, "materialization lease owner", 256);
}

function validateErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new TypeError("Materialization error code must be a bounded machine code");
  }
  return value;
}

function validateDataSchema(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z_][a-z0-9_$]{0,62}$/.test(value) ||
    utf8Length(value) > 63
  ) {
    throw new TypeError("Materialization data schema must be an unquoted PostgreSQL identifier");
  }
  return value;
}

function validateBoundedText(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    utf8Length(value) > maxBytes
  ) {
    throw new TypeError(`${label} must be non-empty, trimmed, and at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function validateInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function databaseInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^[0-9]+$/.test(value)
        ? Number(value)
        : value;
  try {
    return validateInteger(parsed, label, minimum, maximum);
  } catch (error) {
    throw contractViolation(`Materialization row contains an invalid ${label}`, error);
  }
}

function validateTimestamp(value: unknown, label: string): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function databaseTimestamp(value: unknown, label: string): string {
  try {
    return validateTimestamp(value, label);
  } catch (error) {
    throw contractViolation(`Materialization row contains an invalid ${label}`, error);
  }
}

const formats = new Set<EditableArtifactMaterializationFormat>([
  "xlsx",
  "pptx",
  "docx",
  "pdf",
  "png",
  "webp",
]);

const modalities = new Set<EditableArtifactMaterializationModality>([
  "spreadsheet",
  "presentation",
  "document",
]);

function validateDatabaseModality(value: unknown): EditableArtifactMaterializationModality {
  if (
    typeof value !== "string" ||
    !modalities.has(value as EditableArtifactMaterializationModality)
  ) {
    throw contractViolation("Materialization row contains an invalid modality");
  }
  return value as EditableArtifactMaterializationModality;
}

const mimeTypes = new Set<EditableArtifactMaterializationMimeType>([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "image/png",
  "image/webp",
]);

function validateDatabaseFormat(value: unknown): EditableArtifactMaterializationFormat {
  if (typeof value !== "string" || !formats.has(value as EditableArtifactMaterializationFormat)) {
    throw contractViolation("Materialization row contains an invalid format");
  }
  return value as EditableArtifactMaterializationFormat;
}

function validateFormatForModality(
  modality: EditableArtifactMaterializationModality,
  format: EditableArtifactMaterializationFormat,
): void {
  const valid =
    (modality === "spreadsheet" && ["xlsx", "pdf", "png", "webp"].includes(format)) ||
    (modality === "presentation" && ["pptx", "pdf", "png", "webp"].includes(format)) ||
    (modality === "document" && ["docx", "pdf", "png", "webp"].includes(format));
  if (!valid) {
    throw contractViolation("Materialization row contains a format incompatible with its modality");
  }
}

function validateDatabaseNormalizedOptions(value: unknown, expectedHash: string): string {
  let normalized: string;
  try {
    normalized = validateBoundedText(
      value,
      "normalized materialization options",
      EDITABLE_ARTIFACT_MATERIALIZATION_MAX_OPTIONS_BYTES,
    );
    const parsed = JSON.parse(normalized) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      JSON.stringify(parsed) !== normalized
    ) {
      throw new TypeError("normalized materialization options are not a canonical JSON object");
    }
  } catch (error) {
    throw contractViolation("Materialization row contains invalid normalized options", error);
  }
  const actualHash = `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
  if (actualHash !== expectedHash) {
    throw contractViolation("Materialization options hash does not bind its exact canonical bytes");
  }
  return normalized;
}

function validateMimeType(value: unknown): EditableArtifactMaterializationMimeType {
  if (
    typeof value !== "string" ||
    !mimeTypes.has(value as EditableArtifactMaterializationMimeType)
  ) {
    throw new TypeError("Materialization MIME type is unsupported");
  }
  return value as EditableArtifactMaterializationMimeType;
}

function validateDatabaseMimeType(value: unknown): EditableArtifactMaterializationMimeType {
  try {
    return validateMimeType(value);
  } catch (error) {
    throw contractViolation("Materialization row contains an invalid MIME type", error);
  }
}

function validateDatabaseOwner(value: unknown): string {
  try {
    return validateOwner(value);
  } catch (error) {
    throw contractViolation("Materialization row contains an invalid lease owner", error);
  }
}

function validateDatabaseStableId(value: unknown, label: string): string {
  try {
    return validateStableId(value, label);
  } catch (error) {
    throw contractViolation(`Materialization row contains an invalid ${label}`, error);
  }
}

function validateDatabaseHash(value: unknown, label: string): string {
  try {
    return validateHash(value, label);
  } catch (error) {
    throw contractViolation(`Materialization row contains an invalid ${label}`, error);
  }
}

function validateDatabaseText(value: unknown, label: string, maxBytes: number): string {
  try {
    return validateBoundedText(value, label, maxBytes);
  } catch (error) {
    throw contractViolation(`Materialization row contains an invalid ${label}`, error);
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function leaseFenced(): EditableArtifactMaterializationPersistenceError {
  return new EditableArtifactMaterializationPersistenceError(
    "lease_fenced",
    "Editable artifact materialization lease is no longer authoritative",
  );
}

function contractViolation(
  message: string,
  cause?: unknown,
): EditableArtifactMaterializationPersistenceError {
  return new EditableArtifactMaterializationPersistenceError(
    "database_contract_violation",
    message,
    cause === undefined ? undefined : { cause },
  );
}
