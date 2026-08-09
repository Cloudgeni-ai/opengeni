import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { QueryWithTypings, SQLWrapper } from "drizzle-orm/sql";

import type { Database } from "../src/database";
import {
  EditableArtifactMaterializationPersistenceError,
  type EditableArtifactMaterializationRepository,
  PostgresEditableArtifactMaterializationRepository,
  type SucceedEditableArtifactMaterializationRequest,
} from "../src/editable-artifact-materialization";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const artifactId = "a".repeat(32);
const jobId = "b".repeat(32);
const versionId = "c".repeat(32);
const resultId = "d".repeat(32);
const blobRefId = "e".repeat(32);
const stateHash = hash("1");
const normalizedOptions = "{}";
const optionsHash = sha256Text(normalizedOptions);
const fontRegistryHash = hash("3");
const policyHash = hash("4");
const contentHash = hash("5");

class ScriptedDatabase {
  readonly queries: QueryWithTypings[] = [];
  readonly db: Pick<Database, "execute">;
  private readonly responses: unknown[];

  constructor(...responses: unknown[]) {
    this.responses = [...responses];
    this.db = {
      execute: (async (query: SQLWrapper | string) => {
        if (typeof query === "string") throw new Error("Expected a parameterized SQL object");
        this.queries.push(new PgDialect().sqlToQuery(query.getSQL()));
        if (this.responses.length === 0) throw new Error("Unexpected database query");
        const response = this.responses.shift();
        if (response instanceof Error) throw response;
        return response;
      }) as Database["execute"],
    };
  }
}

describe("PostgresEditableArtifactMaterializationRepository", () => {
  test("globally claims a bounded batch and validates every lease fact", async () => {
    const database = new ScriptedDatabase({ rows: [claimRow()] });
    const repository = new PostgresEditableArtifactMaterializationRepository(database.db, {
      dataSchema: "artifact_data",
    });
    const jobs = await repository.claim({
      owner: "materializer-01",
      leaseDurationMs: 30_000,
      limit: 8,
    });

    expect(jobs).toEqual([
      {
        scope: { accountId, workspaceId },
        artifactId,
        jobId,
        versionId,
        modality: "spreadsheet",
        inputSnapshotId: "6".repeat(32),
        targetHeadSequence: 42,
        stateHash,
        sourceObjectReference: "editable-artifacts/source/snapshot",
        sourceByteSize: 4_096,
        sourceContentHash: hash("7"),
        sourceMimeType: "application/vnd.opengeni.editable-artifact-snapshot",
        modelSchemaVersion: 1,
        operationProtocolVersion: 1,
        snapshotProtocolVersion: 1,
        format: "xlsx",
        codecId: "office-codec",
        normalizedOptions,
        optionsHash,
        codecVersion: "office-codec/1",
        kernelVersion: "artifact-kernel/1",
        fontRegistryHash,
        policyHash,
        attemptCount: 3,
        leaseOwner: "materializer-01",
        leaseExpiresAt: "2026-08-08T12:01:00.000Z",
      },
    ]);
    expect(Object.isFrozen(jobs)).toBe(true);
    expect(Object.isFrozen(jobs[0])).toBe(true);
    expect(Object.isFrozen(jobs[0]!.scope)).toBe(true);
    expect(normalizeSql(database.queries[0]!.sql)).toContain(
      "opengeni_private.claim_editable_artifact_materializations",
    );
    expect(database.queries[0]!.params).toEqual(["materializer-01", 30_000, 8, "artifact_data"]);
  });

  test("uses current_schema without manufacturing a public-schema assumption", async () => {
    const database = new ScriptedDatabase([]);
    const repository = new PostgresEditableArtifactMaterializationRepository(database.db);
    expect(await repository.claim({ owner: "worker", leaseDurationMs: 1_000, limit: 1 })).toEqual(
      [],
    );
    expect(normalizeSql(database.queries[0]!.sql)).toContain("pg_catalog.current_schema()");
    expect(database.queries[0]!.params).toEqual(["worker", 1_000, 1]);
  });

  test("renews only the exact scope, owner, and attempt fence", async () => {
    const database = new ScriptedDatabase([
      {
        account_id: accountId,
        workspace_id: workspaceId,
        artifact_id: artifactId,
        job_id: jobId,
        lease_owner: "materializer-01",
        attempt_count: 3,
        lease_expires_at: new Date("2026-08-08T12:02:00.000Z"),
      },
    ]);
    const repository = new PostgresEditableArtifactMaterializationRepository(database.db);
    const expiresAt = await repository.renew({
      ...lease(),
      leaseDurationMs: 60_000,
    });

    expect(expiresAt).toBe("2026-08-08T12:02:00.000Z");
    expect(normalizeSql(database.queries[0]!.sql)).toContain(
      "opengeni_private.renew_editable_artifact_materialization",
    );
    expect(database.queries[0]!.params).toEqual([
      accountId,
      workspaceId,
      artifactId,
      jobId,
      "materializer-01",
      3,
      60_000,
    ]);
  });

  test("atomically registers exact immutable blob/result facts and identifies replay", async () => {
    const committedDatabase = new ScriptedDatabase([successRow("committed")]);
    const committedRepository = new PostgresEditableArtifactMaterializationRepository(
      committedDatabase.db,
    );
    const committed = await committedRepository.succeed(successRequest());
    expect(committed).toEqual({
      scope: { accountId, workspaceId },
      artifactId,
      jobId,
      resultId,
      blobRefId,
      objectReference: `artifacts/${contentHash}`,
      byteSize: 12_345,
      contentHash,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      verifiedAt: "2026-08-08T12:00:00.000Z",
      createdAt: "2026-08-08T12:00:01.000Z",
      replayed: false,
    });
    expect(normalizeSql(committedDatabase.queries[0]!.sql)).toContain(
      "opengeni_private.succeed_editable_artifact_materialization",
    );
    expect(committedDatabase.queries[0]!.params).toEqual([
      accountId,
      workspaceId,
      artifactId,
      jobId,
      "materializer-01",
      3,
      resultId,
      blobRefId,
      `artifacts/${contentHash}`,
      12_345,
      contentHash,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "2026-08-08T12:00:00.000Z",
    ]);

    const replayDatabase = new ScriptedDatabase([successRow("replayed")]);
    const replay = await new PostgresEditableArtifactMaterializationRepository(
      replayDatabase.db,
    ).succeed(successRequest());
    expect(replay.replayed).toBe(true);
  });

  test("fails terminally with idempotent lost-response replay", async () => {
    const database = new ScriptedDatabase(failureRow("failed"), failureRow("replayed"));
    const repository = new PostgresEditableArtifactMaterializationRepository(database.db);
    const request = { ...lease(), errorCode: "codec.invalid_archive" };

    expect(await repository.fail(request)).toEqual({ replayed: false });
    expect(await repository.fail(request)).toEqual({ replayed: true });
    expect(normalizeSql(database.queries[0]!.sql)).toContain(
      "opengeni_private.fail_editable_artifact_materialization",
    );
    expect(database.queries[0]!.params).toEqual([
      accountId,
      workspaceId,
      artifactId,
      jobId,
      "materializer-01",
      3,
      "codec.invalid_archive",
    ]);
  });

  test("surfaces stale renew, success, and failure attempts as one typed fence", async () => {
    const renewDatabase = new ScriptedDatabase([]);
    await expect(
      new PostgresEditableArtifactMaterializationRepository(renewDatabase.db).renew({
        ...lease(),
        leaseDurationMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "lease_fenced" });

    const successDatabase = new ScriptedDatabase([]);
    await expect(
      new PostgresEditableArtifactMaterializationRepository(successDatabase.db).succeed(
        successRequest(),
      ),
    ).rejects.toMatchObject({ code: "lease_fenced" });

    const failDatabase = new ScriptedDatabase([{ outcome: "fenced" }]);
    await expect(
      new PostgresEditableArtifactMaterializationRepository(failDatabase.db).fail({
        ...lease(),
        errorCode: "worker.crashed",
      }),
    ).rejects.toMatchObject({ code: "lease_fenced" });
  });

  test("rejects invalid caller facts before issuing SQL", async () => {
    const database = new ScriptedDatabase();
    const repository = new PostgresEditableArtifactMaterializationRepository(database.db);

    expect(
      () =>
        new PostgresEditableArtifactMaterializationRepository(database.db, {
          dataSchema: "",
        }),
    ).toThrow(TypeError);

    await expect(
      repository.claim({ owner: " worker ", leaseDurationMs: 1_000, limit: 1 }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      repository.renew({ ...lease(), attemptCount: 0, leaseDurationMs: 1_000 }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      repository.succeed({ ...successRequest(), contentHash: "not-a-hash" }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      repository.succeed({ ...successRequest(), verifiedAt: "not-a-date" }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      repository.fail({ ...lease(), errorCode: "Provider said something private" }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      repository.succeed({ ...successRequest(), objectReference: "artifact\0object" }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(database.queries).toHaveLength(0);
  });

  test("fails closed on corrupt, mismatched, duplicate, or oversized SQL output", async () => {
    const wrongOwner = new ScriptedDatabase([{ ...claimRow(), lease_owner: "other-worker" }]);
    await expect(
      new PostgresEditableArtifactMaterializationRepository(wrongOwner.db).claim({
        owner: "materializer-01",
        leaseDurationMs: 1_000,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "database_contract_violation" });

    const duplicate = new ScriptedDatabase([claimRow(), claimRow()]);
    await expect(
      new PostgresEditableArtifactMaterializationRepository(duplicate.db).claim({
        owner: "materializer-01",
        leaseDurationMs: 1_000,
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: "database_contract_violation" });

    const oversized = new ScriptedDatabase([claimRow(), claimRow()]);
    await expect(
      new PostgresEditableArtifactMaterializationRepository(oversized.db).claim({
        owner: "materializer-01",
        leaseDurationMs: 1_000,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "database_contract_violation" });

    const mismatchedResult = new ScriptedDatabase([
      { ...successRow("committed"), content_hash: hash("9") },
    ]);
    await expect(
      new PostgresEditableArtifactMaterializationRepository(mismatchedResult.db).succeed(
        successRequest(),
      ),
    ).rejects.toMatchObject({ code: "database_contract_violation" });

    const mismatchedFence = new ScriptedDatabase([
      { ...failureRow("replayed")[0], attempt_count: 2 },
    ]);
    await expect(
      new PostgresEditableArtifactMaterializationRepository(mismatchedFence.db).fail({
        ...lease(),
        errorCode: "codec.invalid_archive",
      }),
    ).rejects.toMatchObject({ code: "database_contract_violation" });
  });

  test("satisfies the public repository contract at compile time", () => {
    const database = new ScriptedDatabase();
    const implementation: EditableArtifactMaterializationRepository =
      new PostgresEditableArtifactMaterializationRepository(database.db);
    expect(implementation).toBeInstanceOf(PostgresEditableArtifactMaterializationRepository);
  });
});

function lease() {
  return {
    scope: { accountId, workspaceId },
    artifactId,
    jobId,
    owner: "materializer-01",
    attemptCount: 3,
  } as const;
}

function successRequest(): SucceedEditableArtifactMaterializationRequest {
  return {
    ...lease(),
    resultId,
    blobRefId,
    objectReference: `artifacts/${contentHash}`,
    byteSize: 12_345,
    contentHash,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    verifiedAt: "2026-08-08T12:00:00.000Z",
  };
}

function claimRow() {
  return {
    account_id: accountId,
    workspace_id: workspaceId,
    artifact_id: artifactId,
    job_id: jobId,
    version_id: versionId,
    modality: "spreadsheet",
    input_snapshot_id: "6".repeat(32),
    target_head_sequence: "42",
    state_hash: stateHash,
    source_object_reference: "editable-artifacts/source/snapshot",
    source_byte_size: 4_096,
    source_content_hash: hash("7"),
    source_mime_type: "application/vnd.opengeni.editable-artifact-snapshot",
    model_schema_version: 1,
    operation_protocol_version: 1,
    snapshot_protocol_version: 1,
    format: "xlsx",
    codec_id: "office-codec",
    normalized_options: normalizedOptions,
    options_hash: optionsHash,
    codec_version: "office-codec/1",
    kernel_version: "artifact-kernel/1",
    font_registry_hash: fontRegistryHash,
    policy_hash: policyHash,
    state: "running",
    attempt_count: 3,
    lease_owner: "materializer-01",
    lease_expires_at: "2026-08-08T12:01:00.000Z",
    started_at: "2026-08-08T12:00:00.000Z",
    created_at: "2026-08-08T11:00:00.000Z",
  };
}

function successRow(outcome: "committed" | "replayed") {
  return {
    outcome,
    account_id: accountId,
    workspace_id: workspaceId,
    artifact_id: artifactId,
    job_id: jobId,
    result_id: resultId,
    blob_ref_id: blobRefId,
    object_reference: `artifacts/${contentHash}`,
    byte_size: 12_345n,
    content_hash: contentHash,
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    verified_at: "2026-08-08T12:00:00.000Z",
    created_at: "2026-08-08T12:00:01.000Z",
    settled_by_owner: "materializer-01",
    attempt_count: 3,
  };
}

function failureRow(outcome: "failed" | "replayed") {
  return [
    {
      outcome,
      account_id: accountId,
      workspace_id: workspaceId,
      artifact_id: artifactId,
      job_id: jobId,
      settled_by_owner: "materializer-01",
      attempt_count: 3,
      error_code: "codec.invalid_archive",
    },
  ];
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function sha256Text(value: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

test("materializer fencing errors retain their stable typed identity", () => {
  const error = new EditableArtifactMaterializationPersistenceError("lease_fenced", "fenced");
  expect(error.name).toBe("EditableArtifactMaterializationPersistenceError");
  expect(error.code).toBe("lease_fenced");
});
