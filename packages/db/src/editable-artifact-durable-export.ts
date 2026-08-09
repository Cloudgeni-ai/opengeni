import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { rawRows, type Database, withRlsContext } from "./database";

export type PersistedEditableArtifactExportScope = Readonly<{
  accountId: string;
  workspaceId: string;
}>;

export type PersistedEditableArtifactExportActor =
  | Readonly<{ kind: "human"; subjectId: string; replicaId: string }>
  | Readonly<{
      kind: "agent";
      subjectId: string;
      replicaId: string;
      sessionId: string;
      turnId: string;
      attemptId: string;
      generation: number;
    }>
  | Readonly<{
      kind: "service";
      subjectId: string;
      replicaId: string;
      service: string;
    }>;

export type PersistedEditableArtifactExportModality = "spreadsheet" | "document" | "presentation";

export type PersistedEditableArtifactExportFormat =
  | "xlsx"
  | "pptx"
  | "docx"
  | "pdf"
  | "png"
  | "webp";

export type PersistedEditableArtifactExportProfile = Readonly<{
  modality: PersistedEditableArtifactExportModality;
  format: PersistedEditableArtifactExportFormat;
  codecId: string;
  codecVersion: string;
  kernelVersion: string;
  fontRegistryHash: string;
  policyHash: string;
  normalizedOptions: string;
}>;

export type PersistedEditableArtifactPinnedVersion = Readonly<{
  scope: PersistedEditableArtifactExportScope;
  artifactId: string;
  id: string;
  modality: PersistedEditableArtifactExportModality;
  snapshotId: string;
  headSequence: number;
  causalFrontier: readonly Readonly<{ replicaId: string; counter: number }>[] | null;
  nativeRevision: number | null;
  stateHash: string;
  name: string;
  pinned: true;
  createdBySubjectId: string;
  createdAt: string;
}>;

export type PersistedEditableArtifactMaterializationResult = Readonly<{
  id: string;
  byteSize: number;
  contentHash: string;
  mimeType: string;
  verifiedAt: string;
  createdAt: string;
}>;

export type PersistedEditableArtifactMaterializationJob = Readonly<{
  scope: PersistedEditableArtifactExportScope;
  artifactId: string;
  id: string;
  versionId: string;
  inputSnapshotId: string;
  targetHeadSequence: number;
  stateHash: string;
  format: PersistedEditableArtifactExportFormat;
  state: "pending" | "running" | "succeeded" | "failed";
  attemptCount: number;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: PersistedEditableArtifactMaterializationResult | null;
}>;

export type PersistedEditableArtifactExportSnapshot = Readonly<{
  modality: PersistedEditableArtifactExportModality;
  snapshotId: string;
  coveredHeadSequence: number;
  stateHash: string;
  coveredCausalFrontier: readonly Readonly<{ replicaId: string; counter: number }>[] | null;
  nativeRevision: number | null;
}>;

type ExportContext = Readonly<{
  scope: PersistedEditableArtifactExportScope;
  artifactId: string;
  actor: PersistedEditableArtifactExportActor;
}>;

export type PinPersistedEditableArtifactVersionRequest = ExportContext &
  Readonly<{
    expectedAuthorizationRevision: number;
    authorityKey: string;
    receiptId: string;
    versionId: string;
    idempotencyKey: string;
    requestHash: string;
    name: string;
    snapshot: PersistedEditableArtifactExportSnapshot;
  }>;

export type EnqueuePersistedEditableArtifactMaterializationRequest = ExportContext &
  Readonly<{
    expectedAuthorizationRevision: number;
    authorityKey: string;
    receiptId: string;
    jobId: string;
    idempotencyKey: string;
    requestHash: string;
    versionId: string;
    profile: PersistedEditableArtifactExportProfile;
  }>;

export type PersistedEditableArtifactAuthorizationResult<T> =
  | Readonly<{ kind: "result"; value: T }>
  | Readonly<{ kind: "authorization_stale" }>;

export class EditableArtifactDurableExportPersistenceError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "idempotency_conflict"
      | "snapshot_conflict"
      | "unsupported_format"
      | "database_contract_violation",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EditableArtifactDurableExportPersistenceError";
  }
}

type ArtifactRow = Record<string, unknown> & {
  modality: unknown;
  authorization_revision: unknown;
  head_sequence: unknown;
  state_hash: unknown;
  current_snapshot_id: unknown;
};

type VersionRow = Record<string, unknown> & {
  account_id: unknown;
  workspace_id: unknown;
  artifact_id: unknown;
  id: unknown;
  modality: unknown;
  snapshot_id: unknown;
  head_sequence: unknown;
  causal_frontier: unknown;
  native_revision: unknown;
  state_hash: unknown;
  name: unknown;
  pinned: unknown;
  created_by_subject_id: unknown;
  created_at: unknown;
};

type JobRow = Record<string, unknown> & {
  account_id: unknown;
  workspace_id: unknown;
  artifact_id: unknown;
  id: unknown;
  version_id: unknown;
  input_snapshot_id: unknown;
  target_head_sequence: unknown;
  state_hash: unknown;
  format: unknown;
  state: unknown;
  attempt_count: unknown;
  error_code: unknown;
  created_at: unknown;
  started_at: unknown;
  completed_at: unknown;
  result_id: unknown;
  result_byte_size: unknown;
  result_content_hash: unknown;
  result_mime_type: unknown;
  result_verified_at: unknown;
  result_created_at: unknown;
  object_reference?: unknown;
};

type ReceiptRow = Record<string, unknown> & {
  request_hash: unknown;
  resource_id: unknown;
};

type AuthorizationRow = Record<string, unknown> & {
  allowed: unknown;
  authorization_revision: unknown;
};

/** Tenant-scoped public version/export persistence; global claiming remains separate. */
export class PostgresEditableArtifactDurableExportStore {
  constructor(private readonly db: Database) {}

  async pinVersion(
    requestInput: PinPersistedEditableArtifactVersionRequest,
  ): Promise<
    PersistedEditableArtifactAuthorizationResult<
      Readonly<{ version: PersistedEditableArtifactPinnedVersion; replayed: boolean }>
    >
  > {
    const request = validatePinRequest(requestInput);
    return await withRlsContext(
      this.db,
      request.scope,
      async (tx) => {
        const authorization = await authorize(tx, request);
        if (
          !authorization.allowed ||
          authorization.revision !== request.expectedAuthorizationRevision
        ) {
          return Object.freeze({ kind: "authorization_stale" as const });
        }
        await lockIdempotencyRequest(tx, request, "version");
        const replay = await findReceipt(tx, request, "version", request.idempotencyKey);
        if (replay) {
          if (replay.requestHash !== request.requestHash) throw idempotencyConflict();
          const version = await loadVersion(
            tx,
            request.scope,
            request.artifactId,
            replay.resourceId,
          );
          if (!version) throw contractViolation("Version receipt points to a missing version");
          return Object.freeze({
            kind: "result" as const,
            value: Object.freeze({ version, replayed: true }),
          });
        }

        const artifact = await lockArtifact(tx, request.scope, request.artifactId);
        if (!artifact) throw notFound();
        if (artifact.authorizationRevision !== request.expectedAuthorizationRevision) {
          return Object.freeze({ kind: "authorization_stale" as const });
        }
        assertSnapshotPinsArtifact(request.snapshot, artifact);
        const inserted = await rawRows<VersionRow>(
          tx,
          sql`insert into editable_artifact_versions (
            account_id, workspace_id, artifact_id, id, snapshot_id, head_sequence,
            causal_frontier, native_revision, state_hash, name, pinned, created_by_subject_id
          ) values (
            ${request.scope.accountId}::uuid, ${request.scope.workspaceId}::uuid,
            ${request.artifactId}, ${request.versionId}, ${request.snapshot.snapshotId},
            ${request.snapshot.coveredHeadSequence},
            ${request.snapshot.coveredCausalFrontier === null ? null : JSON.stringify(request.snapshot.coveredCausalFrontier)}::jsonb,
            ${request.snapshot.nativeRevision}, ${request.snapshot.stateHash}, ${request.name},
            true, ${request.actor.subjectId}
          ) returning
            account_id, workspace_id, artifact_id, id,
            ${artifact.modality}::text as modality, snapshot_id, head_sequence,
            causal_frontier, native_revision, state_hash, name, pinned,
            created_by_subject_id, created_at`,
        );
        const versionRow = exactRow(inserted, "Version insert");
        await insertReceipt(tx, {
          ...request,
          operationKind: "version",
          resourceType: "artifact_version",
          resourceId: request.versionId,
          result: {
            schemaVersion: 1,
            artifactId: request.artifactId,
            versionId: request.versionId,
          },
        });
        return Object.freeze({
          kind: "result" as const,
          value: Object.freeze({ version: versionFromRow(versionRow), replayed: false }),
        });
      },
      { isolationLevel: "serializable" },
    );
  }

  async enqueueMaterialization(
    requestInput: EnqueuePersistedEditableArtifactMaterializationRequest,
  ): Promise<
    PersistedEditableArtifactAuthorizationResult<
      Readonly<{ job: PersistedEditableArtifactMaterializationJob; replayed: boolean }>
    >
  > {
    const request = validateEnqueueRequest(requestInput);
    return await withRlsContext(
      this.db,
      request.scope,
      async (tx) => {
        const authorization = await authorize(tx, request);
        if (
          !authorization.allowed ||
          authorization.revision !== request.expectedAuthorizationRevision
        ) {
          return Object.freeze({ kind: "authorization_stale" as const });
        }
        await lockIdempotencyRequest(tx, request, "materialize");
        const replay = await findReceipt(tx, request, "materialize", request.idempotencyKey);
        if (replay) {
          if (replay.requestHash !== request.requestHash) throw idempotencyConflict();
          const job = await loadJob(
            tx,
            request.scope,
            request.artifactId,
            replay.resourceId,
            false,
          );
          if (!job) throw contractViolation("Materialization receipt points to a missing job");
          return Object.freeze({
            kind: "result" as const,
            value: Object.freeze({ job: job.job, replayed: true }),
          });
        }

        const artifact = await lockArtifact(tx, request.scope, request.artifactId);
        if (!artifact) throw notFound();
        if (artifact.authorizationRevision !== request.expectedAuthorizationRevision) {
          return Object.freeze({ kind: "authorization_stale" as const });
        }
        if (
          artifact.modality !== request.profile.modality ||
          !formatMatchesModality(artifact.modality, request.profile.format)
        ) {
          throw unsupportedFormat();
        }
        const version = await loadVersion(tx, request.scope, request.artifactId, request.versionId);
        if (!version || version.modality !== artifact.modality) throw notFound();
        const optionsHash = sha256(request.profile.normalizedOptions);
        const inserted = await rawRows<Record<string, unknown> & { id: unknown }>(
          tx,
          sql`insert into editable_artifact_materialization_jobs (
            account_id, workspace_id, artifact_id, id, version_id, input_snapshot_id,
            target_head_sequence, state_hash, format, normalized_options, codec_id,
            codec_version, kernel_version, font_registry_hash, policy_hash
          ) values (
            ${request.scope.accountId}::uuid, ${request.scope.workspaceId}::uuid,
            ${request.artifactId}, ${request.jobId}, ${version.id}, ${version.snapshotId},
            ${version.headSequence}, ${version.stateHash}, ${request.profile.format},
            ${request.profile.normalizedOptions}, ${request.profile.codecId},
            ${request.profile.codecVersion}, ${request.profile.kernelVersion},
            ${request.profile.fontRegistryHash}, ${request.profile.policyHash}
          ) on conflict (
            account_id, workspace_id, artifact_id, input_snapshot_id, state_hash, format,
            options_hash, codec_id, codec_version, kernel_version, font_registry_hash, policy_hash
          ) do nothing returning id`,
        );
        let selectedJobId: string;
        if (inserted.length === 1) {
          selectedJobId = text(inserted[0]!.id, "inserted materialization job id");
        } else if (inserted.length === 0) {
          const cached = await rawRows<Record<string, unknown> & { id: unknown }>(
            tx,
            sql`select id from editable_artifact_materialization_jobs
              where account_id = ${request.scope.accountId}::uuid
                and workspace_id = ${request.scope.workspaceId}::uuid
                and artifact_id = ${request.artifactId}
                and input_snapshot_id = ${version.snapshotId}
                and state_hash = ${version.stateHash}
                and format = ${request.profile.format}
                and options_hash = ${optionsHash}
                and codec_id = ${request.profile.codecId}
                and codec_version = ${request.profile.codecVersion}
                and kernel_version = ${request.profile.kernelVersion}
                and font_registry_hash = ${request.profile.fontRegistryHash}
                and policy_hash = ${request.profile.policyHash}`,
          );
          selectedJobId = text(exactRow(cached, "Materialization cache read").id, "job id");
        } else {
          throw contractViolation("Materialization insert returned multiple rows");
        }
        await insertReceipt(tx, {
          ...request,
          operationKind: "materialize",
          resourceType: "materialization_job",
          resourceId: selectedJobId,
          result: {
            schemaVersion: 1,
            artifactId: request.artifactId,
            materializationJobId: selectedJobId,
          },
        });
        const loaded = await loadJob(tx, request.scope, request.artifactId, selectedJobId, false);
        if (!loaded) throw contractViolation("Inserted materialization job is missing");
        return Object.freeze({
          kind: "result" as const,
          value: Object.freeze({ job: loaded.job, replayed: false }),
        });
      },
      { isolationLevel: "serializable" },
    );
  }

  async readVersion(
    input: ExportContext & {
      expectedAuthorizationRevision: number;
      versionId: string;
    },
  ): Promise<
    PersistedEditableArtifactAuthorizationResult<PersistedEditableArtifactPinnedVersion | null>
  > {
    const request = validateReadRequest(input, "versionId");
    return await withRlsContext(this.db, request.scope, async (tx) => {
      const authorization = await authorize(tx, request);
      if (
        !authorization.allowed ||
        authorization.revision !== request.expectedAuthorizationRevision
      ) {
        return Object.freeze({ kind: "authorization_stale" as const });
      }
      return Object.freeze({
        kind: "result" as const,
        value: await loadVersion(tx, request.scope, request.artifactId, request.versionId),
      });
    });
  }

  async readMaterialization(
    input: ExportContext & {
      expectedAuthorizationRevision: number;
      jobId: string;
    },
  ): Promise<
    PersistedEditableArtifactAuthorizationResult<PersistedEditableArtifactMaterializationJob | null>
  > {
    const request = validateReadRequest(input, "jobId");
    return await withRlsContext(this.db, request.scope, async (tx) => {
      const authorization = await authorize(tx, request);
      if (
        !authorization.allowed ||
        authorization.revision !== request.expectedAuthorizationRevision
      ) {
        return Object.freeze({ kind: "authorization_stale" as const });
      }
      const loaded = await loadJob(tx, request.scope, request.artifactId, request.jobId, false);
      return Object.freeze({ kind: "result" as const, value: loaded?.job ?? null });
    });
  }

  async readMaterializationDownload(
    input: ExportContext & {
      expectedAuthorizationRevision: number;
      jobId: string;
    },
  ): Promise<
    PersistedEditableArtifactAuthorizationResult<
      Readonly<{
        job: PersistedEditableArtifactMaterializationJob | null;
        objectReference: string | null;
      }>
    >
  > {
    const request = validateReadRequest(input, "jobId");
    return await withRlsContext(this.db, request.scope, async (tx) => {
      const authorization = await authorize(tx, request);
      if (
        !authorization.allowed ||
        authorization.revision !== request.expectedAuthorizationRevision
      ) {
        return Object.freeze({ kind: "authorization_stale" as const });
      }
      const loaded = await loadJob(tx, request.scope, request.artifactId, request.jobId, true);
      return Object.freeze({
        kind: "result" as const,
        value: Object.freeze({
          job: loaded?.job ?? null,
          objectReference: loaded?.objectReference ?? null,
        }),
      });
    });
  }
}

async function authorize(
  tx: Database,
  request: ExportContext,
): Promise<Readonly<{ allowed: boolean; revision: number }>> {
  const actor = request.actor;
  const rows = await rawRows<AuthorizationRow>(
    tx,
    sql`select * from opengeni_private.authorize_editable_artifact_actor(
      ${request.scope.accountId}::uuid,
      ${request.scope.workspaceId}::uuid,
      ${request.artifactId},
      ${actor.kind},
      ${actor.subjectId},
      ${actor.kind === "agent" ? actor.sessionId : null},
      ${actor.kind === "agent" ? actor.turnId : null},
      ${actor.kind === "agent" ? actor.attemptId : null},
      ${actor.kind === "agent" ? actor.generation : null},
      ${actor.kind === "service" ? actor.service : null},
      'export',
      current_schema()
    )`,
  );
  const row = exactRow(rows, "Editable artifact export authorization");
  return Object.freeze({
    allowed: row.allowed === true,
    revision: integer(row.authorization_revision, "authorization revision", 1),
  });
}

async function lockArtifact(
  tx: Database,
  scope: PersistedEditableArtifactExportScope,
  artifactId: string,
): Promise<Readonly<{
  modality: PersistedEditableArtifactExportModality;
  authorizationRevision: number;
  headSequence: number;
  stateHash: string;
  currentSnapshotId: string;
}> | null> {
  const rows = await rawRows<ArtifactRow>(
    tx,
    sql`select modality, authorization_revision, head_sequence, state_hash, current_snapshot_id
      from editable_artifacts
      where account_id = ${scope.accountId}::uuid
        and workspace_id = ${scope.workspaceId}::uuid
        and id = ${artifactId}
      for share`,
  );
  if (rows.length === 0) return null;
  const row = exactRow(rows, "Editable artifact lock");
  return Object.freeze({
    modality: modality(row.modality),
    authorizationRevision: integer(row.authorization_revision, "authorization revision", 1),
    headSequence: integer(row.head_sequence, "artifact head sequence", 0),
    stateHash: hash(row.state_hash, "artifact state hash"),
    currentSnapshotId: stableId(row.current_snapshot_id, "artifact current snapshot id"),
  });
}

async function findReceipt(
  tx: Database,
  request: ExportContext & Readonly<{ authorityKey: string }>,
  operationKind: "version" | "materialize",
  requestIdempotencyKey: string,
): Promise<Readonly<{ requestHash: string; resourceId: string }> | null> {
  const rows = await rawRows<ReceiptRow>(
    tx,
    sql`select request_hash, resource_id
      from editable_artifact_idempotency_receipts
      where account_id = ${request.scope.accountId}::uuid
        and workspace_id = ${request.scope.workspaceId}::uuid
        and artifact_id = ${request.artifactId}
        and operation_kind = ${operationKind}
        and authority_key_digest = opengeni_private.editable_artifact_text_sha256(${request.authorityKey})
        and authority_key = ${request.authorityKey}
        and idempotency_key = ${requestIdempotencyKey}`,
  );
  if (rows.length === 0) return null;
  const row = exactRow(rows, "Editable artifact export receipt read");
  return Object.freeze({
    requestHash: hash(row.request_hash, "receipt request hash"),
    resourceId: stableId(row.resource_id, "receipt resource id"),
  });
}

async function lockIdempotencyRequest(
  tx: Database,
  request: ExportContext & Readonly<{ authorityKey: string; idempotencyKey: string }>,
  operationKind: "version" | "materialize",
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(
      ${`editable-artifact:${operationKind}:${request.scope.accountId}:${request.scope.workspaceId}:${request.artifactId}:${request.authorityKey}:${request.idempotencyKey}`},
      0
    ))`,
  );
}

async function insertReceipt(
  tx: Database,
  input: ExportContext &
    Readonly<{
      receiptId: string;
      authorityKey: string;
      idempotencyKey: string;
      requestHash: string;
      operationKind: "version" | "materialize";
      resourceType: "artifact_version" | "materialization_job";
      resourceId: string;
      result: Readonly<Record<string, unknown>>;
    }>,
): Promise<void> {
  await tx.execute(sql`insert into editable_artifact_idempotency_receipts (
    account_id, workspace_id, id, artifact_id, operation_kind, authority_key,
    idempotency_key, request_hash, resource_type, resource_id, server_transaction_id, result
  ) values (
    ${input.scope.accountId}::uuid, ${input.scope.workspaceId}::uuid,
    ${input.receiptId}, ${input.artifactId}, ${input.operationKind}, ${input.authorityKey},
    ${input.idempotencyKey}, ${input.requestHash}, ${input.resourceType}, ${input.resourceId},
    null, ${JSON.stringify(input.result)}::jsonb
  )`);
}

async function loadVersion(
  tx: Database,
  scope: PersistedEditableArtifactExportScope,
  artifactId: string,
  versionId: string,
): Promise<PersistedEditableArtifactPinnedVersion | null> {
  const rows = await rawRows<VersionRow>(
    tx,
    sql`select
      version.account_id, version.workspace_id, version.artifact_id, version.id,
      artifact.modality, version.snapshot_id, version.head_sequence,
      version.causal_frontier, version.native_revision, version.state_hash,
      version.name, version.pinned, version.created_by_subject_id, version.created_at
    from editable_artifact_versions version
    join editable_artifacts artifact
      on artifact.account_id = version.account_id
      and artifact.workspace_id = version.workspace_id
      and artifact.id = version.artifact_id
    where version.account_id = ${scope.accountId}::uuid
      and version.workspace_id = ${scope.workspaceId}::uuid
      and version.artifact_id = ${artifactId}
      and version.id = ${versionId}`,
  );
  if (rows.length === 0) return null;
  return versionFromRow(exactRow(rows, "Editable artifact version read"));
}

async function loadJob(
  tx: Database,
  scope: PersistedEditableArtifactExportScope,
  artifactId: string,
  jobId: string,
  includeObjectReference: boolean,
): Promise<Readonly<{
  job: PersistedEditableArtifactMaterializationJob;
  objectReference: string | null;
}> | null> {
  const rows = await rawRows<JobRow>(
    tx,
    sql`select
      job.account_id, job.workspace_id, job.artifact_id, job.id, job.version_id,
      job.input_snapshot_id, job.target_head_sequence, job.state_hash, job.format,
      job.state, job.attempt_count, job.error_code, job.created_at, job.started_at,
      job.completed_at, result.id as result_id, result.byte_size as result_byte_size,
      result.content_hash as result_content_hash, result.mime_type as result_mime_type,
      result.verified_at as result_verified_at, result.created_at as result_created_at,
      ${includeObjectReference ? sql`blob.object_reference` : sql`null::text`} as object_reference
    from editable_artifact_materialization_jobs job
    left join editable_artifact_materialization_results result
      on result.account_id = job.account_id and result.workspace_id = job.workspace_id
      and result.artifact_id = job.artifact_id and result.job_id = job.id
    left join editable_artifact_blob_refs blob
      on blob.account_id = result.account_id and blob.workspace_id = result.workspace_id
      and blob.artifact_id = result.artifact_id and blob.id = result.blob_ref_id
    where job.account_id = ${scope.accountId}::uuid
      and job.workspace_id = ${scope.workspaceId}::uuid
      and job.artifact_id = ${artifactId}
      and job.id = ${jobId}`,
  );
  if (rows.length === 0) return null;
  const row = exactRow(rows, "Editable artifact materialization read");
  const job = jobFromRow(row);
  const objectReference = nullableText(row.object_reference, "materialization object reference");
  if ((job.result === null) !== (objectReference === null) && includeObjectReference) {
    throw contractViolation("Materialization result object reference is inconsistent");
  }
  return Object.freeze({ job, objectReference });
}

function versionFromRow(row: VersionRow): PersistedEditableArtifactPinnedVersion {
  const rowModality = modality(row.modality);
  const causalFrontier = causalFrontierFromRow(row.causal_frontier);
  const nativeRevision = nullableInteger(row.native_revision, "version native revision", 0);
  if (
    (rowModality === "spreadsheet" && (causalFrontier === null || nativeRevision !== null)) ||
    (rowModality !== "spreadsheet" && (causalFrontier !== null || nativeRevision === null))
  ) {
    throw contractViolation("Version modality state is inconsistent");
  }
  if (row.pinned !== true) throw contractViolation("Public artifact version is not pinned");
  return Object.freeze({
    scope: Object.freeze({
      accountId: uuid(row.account_id, "version account id"),
      workspaceId: uuid(row.workspace_id, "version workspace id"),
    }),
    artifactId: stableId(row.artifact_id, "version artifact id"),
    id: stableId(row.id, "version id"),
    modality: rowModality,
    snapshotId: stableId(row.snapshot_id, "version snapshot id"),
    headSequence: integer(row.head_sequence, "version head sequence", 0),
    causalFrontier,
    nativeRevision,
    stateHash: hash(row.state_hash, "version state hash"),
    name: boundedText(row.name, "version name", 256),
    pinned: true,
    createdBySubjectId: boundedText(row.created_by_subject_id, "version creator", 1_024),
    createdAt: timestamp(row.created_at, "version creation time"),
  });
}

function jobFromRow(row: JobRow): PersistedEditableArtifactMaterializationJob {
  const state = jobState(row.state);
  const format = exportFormat(row.format);
  const resultId = nullableStableId(row.result_id, "materialization result id");
  let result: PersistedEditableArtifactMaterializationResult | null = null;
  if (resultId !== null) {
    result = Object.freeze({
      id: resultId,
      byteSize: integer(row.result_byte_size, "materialization result byte size", 1),
      contentHash: hash(row.result_content_hash, "materialization result hash"),
      mimeType: mimeType(row.result_mime_type, format),
      verifiedAt: timestamp(row.result_verified_at, "materialization verification time"),
      createdAt: timestamp(row.result_created_at, "materialization result creation time"),
    });
  } else if (
    row.result_byte_size !== null ||
    row.result_content_hash !== null ||
    row.result_mime_type !== null ||
    row.result_verified_at !== null ||
    row.result_created_at !== null
  ) {
    throw contractViolation("Materialization result columns are partial");
  }
  if ((state === "succeeded") !== (result !== null)) {
    throw contractViolation("Materialization state and result are inconsistent");
  }
  return Object.freeze({
    scope: Object.freeze({
      accountId: uuid(row.account_id, "job account id"),
      workspaceId: uuid(row.workspace_id, "job workspace id"),
    }),
    artifactId: stableId(row.artifact_id, "job artifact id"),
    id: stableId(row.id, "job id"),
    versionId: stableId(row.version_id, "job version id"),
    inputSnapshotId: stableId(row.input_snapshot_id, "job snapshot id"),
    targetHeadSequence: integer(row.target_head_sequence, "job target head", 0),
    stateHash: hash(row.state_hash, "job state hash"),
    format,
    state,
    attemptCount: integer(row.attempt_count, "job attempt count", 0),
    errorCode: nullableText(row.error_code, "job error code"),
    createdAt: timestamp(row.created_at, "job creation time"),
    startedAt: nullableTimestamp(row.started_at, "job start time"),
    completedAt: nullableTimestamp(row.completed_at, "job completion time"),
    result,
  });
}

function assertSnapshotPinsArtifact(
  snapshot: PersistedEditableArtifactExportSnapshot,
  artifact: Readonly<{
    modality: PersistedEditableArtifactExportModality;
    headSequence: number;
    stateHash: string;
    currentSnapshotId: string;
  }>,
): void {
  if (
    snapshot.modality !== artifact.modality ||
    snapshot.snapshotId !== artifact.currentSnapshotId ||
    snapshot.coveredHeadSequence !== artifact.headSequence ||
    snapshot.stateHash !== artifact.stateHash ||
    (snapshot.modality === "spreadsheet" &&
      (snapshot.coveredCausalFrontier === null || snapshot.nativeRevision !== null)) ||
    (snapshot.modality !== "spreadsheet" &&
      (snapshot.coveredCausalFrontier !== null || snapshot.nativeRevision === null))
  ) {
    throw new EditableArtifactDurableExportPersistenceError(
      "snapshot_conflict",
      "Pinned version source is no longer the exact current verified snapshot",
    );
  }
}

function validatePinRequest(
  input: PinPersistedEditableArtifactVersionRequest,
): PinPersistedEditableArtifactVersionRequest {
  const context = validateContext(input);
  const snapshot = validateSnapshot(input.snapshot);
  const request = Object.freeze({
    ...input,
    ...context,
    expectedAuthorizationRevision: integer(
      input.expectedAuthorizationRevision,
      "expected authorization revision",
      1,
    ),
    authorityKey: boundedText(input.authorityKey, "authority key", 8_192),
    receiptId: stableId(input.receiptId, "receipt id"),
    versionId: stableId(input.versionId, "version id"),
    idempotencyKey: idempotencyKey(input.idempotencyKey),
    requestHash: hash(input.requestHash, "request hash"),
    name: boundedText(input.name, "version name", 256),
    snapshot,
  });
  validateAuthorityKey(request.actor, request.authorityKey);
  return request;
}

function validateEnqueueRequest(
  input: EnqueuePersistedEditableArtifactMaterializationRequest,
): EnqueuePersistedEditableArtifactMaterializationRequest {
  const context = validateContext(input);
  const request = Object.freeze({
    ...input,
    ...context,
    expectedAuthorizationRevision: integer(
      input.expectedAuthorizationRevision,
      "expected authorization revision",
      1,
    ),
    authorityKey: boundedText(input.authorityKey, "authority key", 8_192),
    receiptId: stableId(input.receiptId, "receipt id"),
    jobId: stableId(input.jobId, "job id"),
    idempotencyKey: idempotencyKey(input.idempotencyKey),
    requestHash: hash(input.requestHash, "request hash"),
    versionId: stableId(input.versionId, "version id"),
    profile: validateProfile(input.profile),
  });
  validateAuthorityKey(request.actor, request.authorityKey);
  return request;
}

function validateReadRequest<T extends "versionId" | "jobId">(
  input: ExportContext & { expectedAuthorizationRevision: number } & Record<T, string>,
  key: T,
): ExportContext & { expectedAuthorizationRevision: number } & Record<T, string> {
  return Object.freeze({
    ...input,
    ...validateContext(input),
    expectedAuthorizationRevision: integer(
      input.expectedAuthorizationRevision,
      "expected authorization revision",
      1,
    ),
    [key]: stableId(input[key], key === "versionId" ? "version id" : "job id"),
  }) as ExportContext & { expectedAuthorizationRevision: number } & Record<T, string>;
}

function validateContext(input: ExportContext): ExportContext {
  const scope = Object.freeze({
    accountId: uuid(input.scope.accountId, "account id"),
    workspaceId: uuid(input.scope.workspaceId, "workspace id"),
  });
  const artifactId = stableId(input.artifactId, "artifact id");
  const actor = validateActor(input.actor);
  return Object.freeze({ scope, artifactId, actor });
}

function validateActor(
  actor: PersistedEditableArtifactExportActor,
): PersistedEditableArtifactExportActor {
  if (!plainRecord(actor)) throw new TypeError("Editable artifact export actor is invalid");
  const replicaId = text(actor.replicaId, "actor replica id");
  if (!/^[0-9a-f]{16}$/u.test(replicaId) || /^0+$/u.test(replicaId)) {
    throw new TypeError("Editable artifact export actor replica id is invalid");
  }
  const subjectId = boundedText(actor.subjectId, "actor subject id", 1_024);
  if (actor.kind === "human") {
    exactKeys(actor, ["kind", "subjectId", "replicaId"]);
    return Object.freeze({ kind: "human", subjectId, replicaId });
  }
  if (actor.kind === "agent") {
    exactKeys(actor, [
      "kind",
      "subjectId",
      "replicaId",
      "sessionId",
      "turnId",
      "attemptId",
      "generation",
    ]);
    return Object.freeze({
      kind: "agent",
      subjectId,
      replicaId,
      sessionId: boundedText(actor.sessionId, "agent session id", 1_024),
      turnId: boundedText(actor.turnId, "agent turn id", 1_024),
      attemptId: boundedText(actor.attemptId, "agent attempt id", 1_024),
      generation: integer(actor.generation, "agent generation", 0),
    });
  }
  if (actor.kind === "service") {
    exactKeys(actor, ["kind", "subjectId", "replicaId", "service"]);
    return Object.freeze({
      kind: "service",
      subjectId,
      replicaId,
      service: boundedText(actor.service, "service name", 1_024),
    });
  }
  throw new TypeError("Editable artifact export actor kind is invalid");
}

function validateSnapshot(
  snapshot: PersistedEditableArtifactExportSnapshot,
): PersistedEditableArtifactExportSnapshot {
  const snapshotModality = modality(snapshot.modality);
  const coveredCausalFrontier = causalFrontierFromRow(snapshot.coveredCausalFrontier);
  const nativeRevision = nullableInteger(snapshot.nativeRevision, "snapshot native revision", 0);
  if (
    (snapshotModality === "spreadsheet" &&
      (coveredCausalFrontier === null || nativeRevision !== null)) ||
    (snapshotModality !== "spreadsheet" &&
      (coveredCausalFrontier !== null || nativeRevision === null))
  ) {
    throw new TypeError("Editable artifact export snapshot modality state is invalid");
  }
  return Object.freeze({
    modality: snapshotModality,
    snapshotId: stableId(snapshot.snapshotId, "snapshot id"),
    coveredHeadSequence: integer(snapshot.coveredHeadSequence, "snapshot head", 0),
    stateHash: hash(snapshot.stateHash, "snapshot state hash"),
    coveredCausalFrontier,
    nativeRevision,
  });
}

function validateProfile(
  profile: PersistedEditableArtifactExportProfile,
): PersistedEditableArtifactExportProfile {
  if (!plainRecord(profile)) throw new TypeError("Materialization profile is invalid");
  const profileModality = modality(profile.modality);
  const format = exportFormat(profile.format);
  if (!formatMatchesModality(profileModality, format)) throw unsupportedFormat();
  const normalizedOptions = boundedText(
    profile.normalizedOptions,
    "normalized materialization options",
    256 * 1024,
  );
  let options: unknown;
  try {
    options = JSON.parse(normalizedOptions) as unknown;
  } catch {
    throw new TypeError("Normalized materialization options are invalid JSON");
  }
  if (!plainRecord(options) || JSON.stringify(sortRecord(options)) !== normalizedOptions) {
    throw new TypeError("Normalized materialization options are not canonical");
  }
  return Object.freeze({
    modality: profileModality,
    format,
    codecId: boundedText(profile.codecId, "codec id", 128),
    codecVersion: boundedText(profile.codecVersion, "codec version", 128),
    kernelVersion: boundedText(profile.kernelVersion, "kernel version", 512),
    fontRegistryHash: hash(profile.fontRegistryHash, "font registry hash"),
    policyHash: hash(profile.policyHash, "policy hash"),
    normalizedOptions,
  });
}

function formatMatchesModality(
  artifactModality: PersistedEditableArtifactExportModality,
  format: PersistedEditableArtifactExportFormat,
): boolean {
  return (
    (artifactModality === "spreadsheet" && ["xlsx", "pdf", "png", "webp"].includes(format)) ||
    (artifactModality === "presentation" && ["pptx", "pdf", "png", "webp"].includes(format)) ||
    (artifactModality === "document" && ["docx", "pdf", "png", "webp"].includes(format))
  );
}

function persistedActorKey(actor: PersistedEditableArtifactExportActor): string {
  switch (actor.kind) {
    case "human":
      return JSON.stringify([actor.kind, actor.subjectId]);
    case "agent":
      return JSON.stringify([
        actor.kind,
        actor.subjectId,
        actor.sessionId,
        actor.turnId,
        actor.attemptId,
        actor.generation,
      ]);
    case "service":
      return JSON.stringify([actor.kind, actor.subjectId, actor.service]);
  }
}

function validateAuthorityKey(
  actor: PersistedEditableArtifactExportActor,
  authorityKey: string,
): void {
  if (authorityKey !== persistedActorKey(actor)) {
    throw new TypeError("Editable artifact export authority key does not match its actor");
  }
}

function exactRow<T>(rows: readonly T[], label: string): T {
  if (rows.length !== 1 || !rows[0])
    throw contractViolation(`${label} returned an invalid row count`);
  return rows[0];
}

function stableId(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^[0-9a-f]{32}$/u.test(parsed) || /^0+$/u.test(parsed)) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed;
}

function nullableStableId(value: unknown, label: string): string | null {
  return value === null ? null : stableId(value, label);
}

function uuid(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed)) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed;
}

function hash(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function idempotencyKey(value: unknown): string {
  const parsed = text(value, "idempotency key");
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(parsed)) throw new TypeError("Idempotency key is invalid");
  return parsed;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  return value;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  const parsed = text(value, label);
  const bytes = new TextEncoder().encode(parsed).byteLength;
  if (
    bytes < 1 ||
    bytes > maximumBytes ||
    parsed.trim() !== parsed ||
    /[\u0000-\u001f\u007f]/u.test(parsed)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : boundedText(value, label, 2_048);
}

function integer(value: unknown, label: string, minimum: number): number {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < minimum) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed as number;
}

function nullableInteger(value: unknown, label: string, minimum: number): number | null {
  return value === null ? null : integer(value, label, minimum);
}

function timestamp(value: unknown, label: string): string {
  const parsed = value instanceof Date ? value.toISOString() : text(value, label);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${label} is invalid`);
  }
  return new Date(milliseconds).toISOString();
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function modality(value: unknown): PersistedEditableArtifactExportModality {
  if (value !== "spreadsheet" && value !== "document" && value !== "presentation") {
    throw new TypeError("Artifact modality is invalid");
  }
  return value;
}

function exportFormat(value: unknown): PersistedEditableArtifactExportFormat {
  if (!["xlsx", "pptx", "docx", "pdf", "png", "webp"].includes(String(value))) {
    throw new TypeError("Materialization format is invalid");
  }
  return value as PersistedEditableArtifactExportFormat;
}

function jobState(value: unknown): PersistedEditableArtifactMaterializationJob["state"] {
  if (!["pending", "running", "succeeded", "failed"].includes(String(value))) {
    throw contractViolation("Materialization state is invalid");
  }
  return value as PersistedEditableArtifactMaterializationJob["state"];
}

function mimeType(value: unknown, format: PersistedEditableArtifactExportFormat): string {
  const expected = {
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    png: "image/png",
    webp: "image/webp",
  }[format];
  if (value !== expected) throw contractViolation("Materialization MIME type is inconsistent");
  return expected;
}

function causalFrontierFromRow(
  value: unknown,
): readonly Readonly<{ replicaId: string; counter: number }>[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new TypeError("Causal frontier is invalid");
  }
  let previous = "";
  const result = value.map((entry) => {
    if (!plainRecord(entry)) throw new TypeError("Causal frontier entry is invalid");
    const replicaId = text(entry.replicaId, "causal replica id");
    if (!/^[0-9a-f]{16}$/u.test(replicaId) || /^0+$/u.test(replicaId) || replicaId <= previous) {
      throw new TypeError("Causal frontier is not canonical");
    }
    previous = replicaId;
    return Object.freeze({
      replicaId,
      counter: integer(entry.counter, "causal counter", 1),
    });
  });
  return Object.freeze(result);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Editable artifact export actor contains unknown properties");
  }
}

function notFound(): EditableArtifactDurableExportPersistenceError {
  return new EditableArtifactDurableExportPersistenceError(
    "not_found",
    "Editable artifact export source was not found",
  );
}

function idempotencyConflict(): EditableArtifactDurableExportPersistenceError {
  return new EditableArtifactDurableExportPersistenceError(
    "idempotency_conflict",
    "Editable artifact export idempotency key was reused with another request",
  );
}

function unsupportedFormat(): EditableArtifactDurableExportPersistenceError {
  return new EditableArtifactDurableExportPersistenceError(
    "unsupported_format",
    "Editable artifact export format is incompatible",
  );
}

function contractViolation(message: string): EditableArtifactDurableExportPersistenceError {
  return new EditableArtifactDurableExportPersistenceError("database_contract_violation", message);
}
