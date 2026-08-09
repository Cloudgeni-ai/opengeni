import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";

import { createDb, type DbClient } from "../src/database";
import { PostgresEditableArtifactDurableExportStore } from "../src/editable-artifact-durable-export";
import {
  PostgresEditableArtifactMaterializationRepository,
  type ClaimedEditableArtifactMaterializationJob,
} from "../src/editable-artifact-materialization";
import { PostgresEditableArtifactStore } from "../src/editable-artifacts";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const materializerRole = "opengeni_artifact_materializer";
const materializerPassword = "artifact-materializer-test-password";

let shared: SharedTestDatabase | null = null;
let appClient: DbClient | null = null;
let materializerClient: DbClient | null = null;
let available = true;
let appStore: PostgresEditableArtifactStore;
let durableExports: PostgresEditableArtifactDurableExportStore;
let materializer: PostgresEditableArtifactMaterializationRepository;
let forbiddenAppMaterializer: PostgresEditableArtifactMaterializationRepository;
let idCounter = 1n;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("editable-artifact-materialization-postgres");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("[artifact-materializer] real PostgreSQL harness is unavailable");
    }
    available = false;
    return;
  }
  await provisionRoles(shared.adminUrl, {
    rlsStrategy: "scoped",
    artifactMaterializerRole: materializerRole,
    artifactMaterializerPassword: materializerPassword,
  });
  await provisionRoles(shared.adminUrl, {
    rlsStrategy: "scoped",
    artifactMaterializerRole: materializerRole,
    artifactMaterializerPassword: materializerPassword,
  });
  const materializerUrl = new URL(shared.adminUrl);
  materializerUrl.username = materializerRole;
  materializerUrl.password = materializerPassword;
  appClient = createDb(shared.appUrl, { max: 4 });
  materializerClient = createDb(materializerUrl.toString(), { max: 4 });
  appStore = new PostgresEditableArtifactStore(appClient.db);
  durableExports = new PostgresEditableArtifactDurableExportStore(appClient.db);
  materializer = new PostgresEditableArtifactMaterializationRepository(materializerClient.db);
  forbiddenAppMaterializer = new PostgresEditableArtifactMaterializationRepository(appClient.db);
}, 180_000);

afterAll(async () => {
  await appClient?.close();
  await materializerClient?.close();
  await shared?.release();
}, 180_000);

describe("dedicated editable artifact materializer", () => {
  test("pins an exact version and idempotently enqueues its authoritative XLSX job", async () => {
    if (!available || !shared) return;
    const fixture = await createArtifact("public durable export workbook");
    const actor = {
      kind: "human" as const,
      subjectId: "materializer-test-user",
      replicaId: "9999999999999999",
    };
    const authorityKey = JSON.stringify(["human", actor.subjectId]);
    const versionRequest = {
      scope: { accountId: fixture.accountId, workspaceId: fixture.workspaceId },
      artifactId: fixture.artifactId,
      actor,
      expectedAuthorizationRevision: 1,
      authorityKey,
      receiptId: nextId(),
      versionId: nextId(),
      idempotencyKey: `pin:${fixture.artifactId}`,
      requestHash: hash("1"),
      name: "Verified workbook v1",
      snapshot: {
        modality: "spreadsheet" as const,
        snapshotId: fixture.snapshotId,
        coveredHeadSequence: 0,
        stateHash: fixture.stateHash,
        coveredCausalFrontier: [],
        nativeRevision: null,
      },
    };
    const pinned = await durableExports.pinVersion(versionRequest);
    expect(pinned).toMatchObject({
      kind: "result",
      value: {
        replayed: false,
        version: { id: versionRequest.versionId, snapshotId: fixture.snapshotId },
      },
    });
    expect(await durableExports.pinVersion(versionRequest)).toMatchObject({
      kind: "result",
      value: { replayed: true, version: { id: versionRequest.versionId } },
    });
    await expect(
      durableExports.pinVersion({ ...versionRequest, requestHash: hash("2") }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const enqueueRequest = {
      scope: versionRequest.scope,
      artifactId: fixture.artifactId,
      actor,
      expectedAuthorizationRevision: 1,
      authorityKey,
      receiptId: nextId(),
      jobId: nextId(),
      idempotencyKey: `xlsx:${fixture.artifactId}`,
      requestHash: hash("3"),
      versionId: versionRequest.versionId,
      profile: {
        modality: "spreadsheet" as const,
        format: "xlsx" as const,
        codecId: "opengeni.xlsx",
        codecVersion: "test-codec-1",
        kernelVersion: "test-kernel-1",
        fontRegistryHash: hash("4"),
        policyHash: hash("5"),
        normalizedOptions: "{}",
      },
    };
    const enqueued = await durableExports.enqueueMaterialization(enqueueRequest);
    expect(enqueued).toMatchObject({
      kind: "result",
      value: {
        replayed: false,
        job: {
          id: enqueueRequest.jobId,
          versionId: versionRequest.versionId,
          inputSnapshotId: fixture.snapshotId,
          state: "pending",
        },
      },
    });
    expect(await durableExports.enqueueMaterialization(enqueueRequest)).toMatchObject({
      kind: "result",
      value: { replayed: true, job: { id: enqueueRequest.jobId } },
    });
    const [cleanupClaim] = await materializer.claim({
      owner: "durable-export-test-cleanup",
      leaseDurationMs: 30_000,
      limit: 1,
    });
    expect(cleanupClaim?.jobId).toBe(enqueueRequest.jobId);
    await materializer.fail({
      ...leaseFrom(cleanupClaim!),
      errorCode: "test.completed",
    });
  }, 30_000);

  test("grants only the four functions and denies generic-app/function and direct-table access", async () => {
    if (!available || !shared || !materializerClient) return;
    const expectedFunctions = [
      "claim_editable_artifact_materializations(text, integer, integer, name)",
      "fail_editable_artifact_materialization(uuid, uuid, text, text, text, integer, text, name)",
      "renew_editable_artifact_materialization(uuid, uuid, text, text, text, integer, integer, name)",
      "succeed_editable_artifact_materialization(uuid, uuid, text, text, text, integer, text, text, text, bigint, text, text, timestamp with time zone, name)",
    ];
    const functionAcls = await shared.admin<
      Array<{
        signature: string;
        appExecute: boolean;
        materializerExecute: boolean;
        publicExecute: boolean;
      }>
    >`
      select
        procedure.proname || '(' || pg_catalog.oidvectortypes(procedure.proargtypes) || ')'
          as signature,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        has_function_privilege(${materializerRole}, procedure.oid, 'EXECUTE')
          as "materializerExecute",
        exists (
          select 1 from aclexplode(
            coalesce(procedure.proacl, acldefault('f', procedure.proowner))
          ) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private' and procedure.prokind = 'f'
      order by signature`;
    expect(
      functionAcls.filter((entry) => entry.materializerExecute).map((entry) => entry.signature),
    ).toEqual(expectedFunctions);
    for (const signature of expectedFunctions) {
      expect(functionAcls.find((entry) => entry.signature === signature)).toEqual({
        signature,
        appExecute: false,
        materializerExecute: true,
        publicExecute: false,
      });
    }
    const [directPrivileges] = await shared.admin<
      Array<{
        tablePrivileges: number;
        sequencePrivileges: number;
      }>
    >`
      select
        (select count(*)::int
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
            ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) privilege(name)
          where namespace.nspname = current_schema()
            and relation.relkind in ('r', 'p', 'v', 'm', 'f')
            and has_table_privilege(${materializerRole}, relation.oid, privilege.name)
        ) as "tablePrivileges",
        (select count(*)::int
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) privilege(name)
          where namespace.nspname = current_schema() and relation.relkind = 'S'
            and has_sequence_privilege(${materializerRole}, relation.oid, privilege.name)
        ) as "sequencePrivileges"`;
    expect(directPrivileges).toEqual({ tablePrivileges: 0, sequencePrivileges: 0 });

    await expectPermissionDenied(
      () =>
        forbiddenAppMaterializer.claim({
          owner: "forbidden-app",
          leaseDurationMs: 1_000,
          limit: 1,
        }),
      "claim_editable_artifact_materializations",
    );
    await expectPermissionDenied(() => {
      const client = materializerClient;
      if (!client) throw new Error("missing materializer client");
      return client.db.execute(sql`select id from editable_artifact_materialization_jobs limit 1`);
    }, "editable_artifact_materialization_jobs");
  }, 30_000);

  test("claims, renews, succeeds, replays, and reuses an exact immutable blob", async () => {
    if (!available || !shared) return;
    const fixture = await createArtifact("materializer success workbook");
    const firstJobId = await createJob(fixture, "1");
    const [claim] = await materializer.claim({
      owner: "renderer-a",
      leaseDurationMs: 30_000,
      limit: 1,
    });
    expect(claim?.jobId).toBe(firstJobId);
    const renewedAt = await materializer.renew({ ...leaseFrom(claim!), leaseDurationMs: 60_000 });
    expect(Date.parse(renewedAt)).toBeGreaterThan(Date.parse(claim!.leaseExpiresAt));
    await expect(
      materializer.renew({
        ...leaseFrom(claim!),
        attemptCount: claim!.attemptCount + 1,
        leaseDurationMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "lease_fenced" });

    const resultFacts = materializationResultFacts(fixture.artifactId, firstJobId, "a");
    const committed = await materializer.succeed({ ...leaseFrom(claim!), ...resultFacts });
    expect(committed.replayed).toBe(false);
    expect((await materializer.succeed({ ...leaseFrom(claim!), ...resultFacts })).replayed).toBe(
      true,
    );
    await expect(
      materializer.succeed({
        ...leaseFrom(claim!),
        ...resultFacts,
        contentHash: hash("9"),
      }),
    ).rejects.toMatchObject({ code: "lease_fenced" });

    const secondJobId = await createJob(fixture, "2");
    const [secondClaim] = await materializer.claim({
      owner: "renderer-b",
      leaseDurationMs: 30_000,
      limit: 1,
    });
    expect(secondClaim?.jobId).toBe(secondJobId);
    const reused = await materializer.succeed({
      ...leaseFrom(secondClaim!),
      ...resultFacts,
      resultId: nextId(),
    });
    expect(reused.blobRefId).toBe(resultFacts.blobRefId);
    const [blobCount] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from editable_artifact_blob_refs
      where account_id = ${fixture.accountId} and workspace_id = ${fixture.workspaceId}
        and artifact_id = ${fixture.artifactId} and kind = 'materialization'`;
    expect(blobCount?.count).toBe(1);
  }, 30_000);

  test("reclaims an expired lease, fences the stale owner, and replays exact failure", async () => {
    if (!available) return;
    const fixture = await createArtifact("materializer failure workbook");
    const jobId = await createJob(fixture, "3");
    const [stale] = await materializer.claim({
      owner: "stale-renderer",
      leaseDurationMs: 1,
      limit: 1,
    });
    expect(stale?.jobId).toBe(jobId);
    const reclaimed = await waitForReclaim("replacement-renderer");
    expect(reclaimed.jobId).toBe(jobId);
    expect(reclaimed.attemptCount).toBe(stale!.attemptCount + 1);
    await expect(
      materializer.succeed({
        ...leaseFrom(stale!),
        ...materializationResultFacts(fixture.artifactId, jobId, "b"),
      }),
    ).rejects.toMatchObject({ code: "lease_fenced" });

    const failure = { ...leaseFrom(reclaimed), errorCode: "codec.invalid_archive" };
    expect(await materializer.fail(failure)).toEqual({ replayed: false });
    expect(await materializer.fail(failure)).toEqual({ replayed: true });
    await expect(
      materializer.fail({ ...failure, errorCode: "codec.render_failed" }),
    ).rejects.toMatchObject({ code: "lease_fenced" });
  }, 30_000);

  test("uses SKIP LOCKED across claimers and serializes competing terminal settlements", async () => {
    if (!available || !shared) return;
    const fixture = await createArtifact("materializer concurrency workbook");
    const firstJobId = await createJob(fixture, "4");
    const secondJobId = await createJob(fixture, "5");
    const [[first], [second]] = await Promise.all([
      materializer.claim({ owner: "parallel-a", leaseDurationMs: 30_000, limit: 1 }),
      materializer.claim({ owner: "parallel-b", leaseDurationMs: 30_000, limit: 1 }),
    ]);
    expect(new Set([first?.jobId, second?.jobId])).toEqual(new Set([firstJobId, secondJobId]));

    const raceJob = first!;
    const race = await Promise.allSettled([
      materializer.succeed({
        ...leaseFrom(raceJob),
        ...materializationResultFacts(fixture.artifactId, raceJob.jobId, "c"),
      }),
      materializer.fail({ ...leaseFrom(raceJob), errorCode: "codec.render_failed" }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    if (race[0]?.status === "rejected")
      expect(race[0].reason).toMatchObject({ code: "lease_fenced" });
    if (race[1]?.status === "rejected")
      expect(race[1].reason).toMatchObject({ code: "lease_fenced" });

    await materializer.fail({ ...leaseFrom(second!), errorCode: "codec.cancelled" });
    const [terminal] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from editable_artifact_materialization_jobs
      where account_id = ${fixture.accountId} and workspace_id = ${fixture.workspaceId}
        and artifact_id = ${fixture.artifactId} and state in ('succeeded', 'failed')`;
    expect(terminal?.count).toBe(2);
  }, 30_000);

  test("terminally fails an exhausted lease without starving a healthy job", async () => {
    if (!available || !shared) return;
    const fixture = await createArtifact("materializer exhausted workbook");
    const exhaustedJobId = await createJob(fixture, "6");
    const [exhausted] = await materializer.claim({
      owner: "exhausted-renderer",
      leaseDurationMs: 30_000,
      limit: 1,
    });
    expect(exhausted?.jobId).toBe(exhaustedJobId);
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update editable_artifact_materialization_jobs
        set attempt_count = 1000,
            started_at = now() - interval '2 seconds',
            lease_expires_at = now() - interval '1 second'
        where account_id = ${fixture.accountId} and workspace_id = ${fixture.workspaceId}
          and artifact_id = ${fixture.artifactId} and id = ${exhaustedJobId}`;
    });

    const healthyJobId = await createJob(fixture, "7");
    const [healthy] = await materializer.claim({
      owner: "healthy-renderer",
      leaseDurationMs: 30_000,
      limit: 1,
    });
    expect(healthy?.jobId).toBe(healthyJobId);
    const [terminal] = await shared.admin<
      Array<{
        state: string;
        errorCode: string;
        attemptCount: number;
      }>
    >`
      select state, error_code as "errorCode", attempt_count::int as "attemptCount"
      from editable_artifact_materialization_jobs
      where account_id = ${fixture.accountId} and workspace_id = ${fixture.workspaceId}
        and artifact_id = ${fixture.artifactId} and id = ${exhaustedJobId}`;
    expect(terminal).toEqual({
      state: "failed",
      errorCode: "attempts_exhausted",
      attemptCount: 1000,
    });
  }, 30_000);
});

async function expectPermissionDenied(
  action: () => Promise<unknown>,
  resource: string,
): Promise<void> {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  const errors: unknown[] = [];
  let current = error;
  while (current instanceof Error && !errors.includes(current)) {
    errors.push(current);
    current = current.cause;
  }
  const messages = errors.map((candidate) => String(candidate)).join("\n");
  expect(messages).toContain("permission denied");
  expect(messages).toContain(resource);
  expect(errors.some((candidate) => getErrorCode(candidate) === "42501")).toBe(true);
}

function getErrorCode(value: unknown): unknown {
  return value !== null && typeof value === "object" && "code" in value ? value.code : undefined;
}

type ArtifactFixture = Readonly<{
  accountId: string;
  workspaceId: string;
  artifactId: string;
  snapshotId: string;
  stateHash: string;
}>;

async function createArtifact(title: string): Promise<ArtifactFixture> {
  if (!shared) throw new Error("missing PostgreSQL harness");
  const [account] = await shared.admin<Array<{ id: string }>>`
    insert into managed_accounts (name) values (${`${title} account`}) returning id`;
  const [workspace] = await shared.admin<Array<{ id: string }>>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`${title} workspace`}) returning id`;
  const artifactId = nextId();
  const snapshotId = nextId();
  const stateHash = hash("0");
  const publishedAt = new Date().toISOString();
  const scope = { accountId: account!.id, workspaceId: workspace!.id };
  await shared.admin`
    insert into workspace_memberships (
      account_id, workspace_id, subject_id, permissions
    ) values (
      ${scope.accountId}, ${scope.workspaceId}, 'materializer-test-user',
      '["artifacts:read","artifacts:publish"]'::jsonb
    )`;
  const created = await appStore.createArtifact({
    scope,
    artifactId,
    authorizationActor: {
      kind: "human",
      subjectId: "materializer-test-user",
      replicaId: "9999999999999999",
    },
    receiptId: nextId(),
    authorityKey: JSON.stringify(["human", "materializer-test-user"]),
    idempotencyKey: `create:${artifactId}`,
    requestHash: hash("f"),
    modality: "spreadsheet",
    title,
    expectedScopeAuthorizationRevision: 1,
    initialArtifactAuthorizationRevision: 1,
    createdBySubjectId: "materializer-test-user",
    genesisSnapshot: {
      scope,
      artifactId,
      modality: "spreadsheet",
      snapshotId,
      blobReference: `editable-artifacts/${artifactId}/${snapshotId}`,
      byteSize: 256,
      contentHash: hash("e"),
      mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
      coveredHeadSequence: 0,
      coveredCausalFrontier: [],
      stateHash,
      modelSchemaVersion: 1,
      operationProtocolVersion: 1,
      kernelVersion: "test-kernel-1",
      crdtStateVersion: 1,
      verifiedAt: publishedAt,
      publishedAt,
    },
    outbox: {
      outboxId: nextId(),
      event: {
        kind: "snapshot_published",
        schemaVersion: 1,
        scope,
        artifactId,
        modality: "spreadsheet",
        snapshotId,
        coveredHeadSequence: 0,
        stateHash,
        operationProtocolVersion: 1,
        publishedAt,
      },
      state: "pending",
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: publishedAt,
      lastErrorCode: null,
      publishedAt: null,
      deadLetteredAt: null,
      createdAt: publishedAt,
    },
  });
  if (created.kind !== "result") throw new Error("artifact creation authorization became stale");
  return { ...scope, artifactId, snapshotId, stateHash };
}

async function createJob(fixture: ArtifactFixture, cacheNibble: string): Promise<string> {
  if (!shared) throw new Error("missing PostgreSQL harness");
  const jobId = nextId();
  const receiptId = nextId();
  await shared.admin.begin(async (tx) => {
    await tx`
      insert into editable_artifact_idempotency_receipts (
        account_id, workspace_id, id, artifact_id, operation_kind,
        authority_key, idempotency_key, request_hash, resource_type,
        resource_id, server_transaction_id, result
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${receiptId}, ${fixture.artifactId},
        'materialize', ${JSON.stringify(["human", "materializer-test-user"])},
        ${`materialize:${jobId}`}, ${hash(cacheNibble)}, 'materialization_job',
        ${jobId}, null, ${tx.json({ schemaVersion: 1, jobId })}
      )`;
    await tx`
      insert into editable_artifact_materialization_jobs (
        account_id, workspace_id, artifact_id, id, version_id,
        input_snapshot_id, target_head_sequence, state_hash, format,
        normalized_options, codec_id, codec_version,
        kernel_version, font_registry_hash, policy_hash
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.artifactId}, ${jobId}, null,
        ${fixture.snapshotId}, 0, ${fixture.stateHash}, 'xlsx',
        ${JSON.stringify({ cache: cacheNibble })}, 'test-office-codec', 'test-codec-1',
        'test-kernel-1', ${hash("d")}, ${hash("c")}
      )`;
  });
  return jobId;
}

function leaseFrom(claim: ClaimedEditableArtifactMaterializationJob) {
  return {
    scope: claim.scope,
    artifactId: claim.artifactId,
    jobId: claim.jobId,
    owner: claim.leaseOwner,
    attemptCount: claim.attemptCount,
  } as const;
}

function materializationResultFacts(artifactId: string, jobId: string, hashNibble: string) {
  const contentHash = hash(hashNibble);
  return {
    resultId: stableDerivedId("result", jobId),
    blobRefId: stableDerivedId("blob", `${artifactId}:${contentHash}`),
    objectReference: `editable-artifacts/${artifactId}/materializations/${contentHash}`,
    byteSize: 4_096,
    contentHash,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,
    verifiedAt: new Date().toISOString(),
  };
}

async function waitForReclaim(owner: string): Promise<ClaimedEditableArtifactMaterializationJob> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [claim] = await materializer.claim({ owner, leaseDurationMs: 30_000, limit: 1 });
    if (claim) return claim;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("expired materialization lease was not reclaimable");
}

function stableDerivedId(kind: string, value: string): string {
  return new Bun.CryptoHasher("sha256").update(`${kind}\0${value}`).digest("hex").slice(0, 32);
}

function nextId(): string {
  const value = `fedcba9876543210${idCounter.toString(16).padStart(16, "0")}`;
  idCounter += 1n;
  return value;
}

function hash(nibble: string): string {
  return `sha256:${nibble.repeat(64)}`;
}
