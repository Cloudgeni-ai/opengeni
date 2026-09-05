import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { parseWorkspaceArchiveObjectRef, workspaceArchiveObjectKey } from "@opengeni/contracts";
import {
  acquireLease,
  createDb,
  createSession,
  failWarmingToCold,
  readLease,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  captureVerifiedWorkspaceArchive,
  establishSandboxSessionFromEnvelope,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import type { ObjectStorage } from "@opengeni/storage";
import { establishApiSandboxSpawner } from "../src/sandbox/rematerialize";
import { attachViewer, detachViewer } from "../src/sandbox/viewer";

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql | undefined;
let client: DbClient | undefined;
let db: Database | undefined;
const seeded: EstablishedSandboxSession[] = [];

const backend = process.platform === "linux" ? ("local" as const) : ("docker" as const);
const settings = testSettings({
  sandboxBackend: backend,
  ...(backend === "docker" ? { dockerImage: "opengeni-sandbox:local" } : {}),
  sandboxOwnershipEnabled: true,
  sandboxLeaseTtlMs: 60_000,
  sandboxLeaseWarmingTtlMs: 60_000,
});

async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
  groupId: string;
}> {
  const [account] = await admin!<{ id: string }[]>`
    insert into managed_accounts (name) values ('api-rematerialize-ref') returning id`;
  const [workspace] = await admin!<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'api-rematerialize-ref') returning id`;
  await admin!`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id, groupId: crypto.randomUUID() };
}

async function closeSandbox(value: EstablishedSandboxSession | null): Promise<void> {
  if (!value) return;
  await value.session.close().catch(() => undefined);
}

async function closeLeaseProvider(
  fixture: ArchiveFixture,
  lease: Awaited<ReturnType<typeof readLease>>,
): Promise<void> {
  if (!lease?.resumeState) return;
  let resumed: EstablishedSandboxSession | null = null;
  try {
    resumed = await establishSandboxSessionFromEnvelope(settings, lease.resumeState, {
      sessionId: fixture.groupId,
      recovery: "resume-only",
      backendOverride: backend,
    });
  } catch {
    return;
  }
  await closeSandbox(resumed);
}

type ArchiveFixture = Awaited<ReturnType<typeof setupColdArchiveLease>>;

function objectStorageFor(
  ref: ArchiveFixture["ref"],
  reply: Uint8Array | null,
): { objectStorage: ObjectStorage; reads: () => number } {
  let readCount = 0;
  return {
    reads: () => readCount,
    objectStorage: {
      bucket: "test",
      backend: "s3-compatible" as const,
      maxSinglePutSizeBytes: 5_000_000_000,
      createPutUrl: async () => {
        throw new Error("not used");
      },
      createGetUrl: async () => {
        throw new Error("not used");
      },
      headFile: async () => {
        throw new Error("not used");
      },
      fileExists: async () => false,
      getFileBytes: async () => {
        throw new Error("not used");
      },
      getFileRange: async () => null,
      async getObjectBytes(key: string) {
        readCount += 1;
        expect(key).toBe(ref.key);
        return reply === null ? null : { bytes: reply };
      },
      putObject: async () => undefined,
      deleteObject: async () => undefined,
    },
  };
}

async function setupColdArchiveLease() {
  const { accountId, workspaceId, groupId } = await freshWorkspace();
  const seed = await establishSandboxSessionFromEnvelope(settings, null, {
    sessionId: groupId,
    recovery: "create-or-restore",
    backendOverride: backend,
  });
  const backendId = seed.backendId;
  seeded.push(seed);
  let archive;
  try {
    const write = await seed.session.exec({
      cmd: "printf 'api-object-ref-proof' > /workspace/api-object-ref-proof.txt",
    });
    expect(write.exitCode).toBe(0);
    archive = await captureVerifiedWorkspaceArchive(seed.session);
  } finally {
    await closeSandbox(seed);
    const index = seeded.indexOf(seed);
    if (index >= 0) seeded.splice(index, 1);
  }

  const ref = {
    schema: "sandbox_archive_object_v1" as const,
    key: workspaceArchiveObjectKey({
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      revision: archive.descriptor.revision,
    }),
    sha256: archive.descriptor.archiveSha256,
    bytes: archive.descriptor.archiveBytes,
    backend: "s3-compatible" as const,
  };
  const envelope = {
    backendId,
    sessionState: {
      workspaceArchiveRef: ref,
      workspaceArchiveMeta: archive.descriptor,
    },
  };
  await admin!.unsafe(
    `
      insert into sandbox_leases (
        account_id, workspace_id, sandbox_group_id, liveness, refcount,
        turn_holders, viewer_holders, backend, lease_epoch,
        workspace_generation, archive_generation,
        resume_backend_id, resume_state, expires_at
      ) values (
        $1, $2, $3, 'cold', 0, 0, 0,
        $5, 1, 0, 0, $6, $4::text::jsonb, now() + interval '60s'
      )`,
    [accountId, workspaceId, groupId, JSON.stringify(envelope), backend, backendId],
  );
  const acquired = await acquireLease(db!, {
    accountId,
    workspaceId,
    sandboxGroupId: groupId,
    kind: "turn",
    holderId: `api-ref-${groupId}`,
    subjectId: groupId,
    backend,
    leaseTtlMs: settings.sandboxLeaseTtlMs,
    warmingLeaseTtlMs: settings.sandboxLeaseWarmingTtlMs,
  });
  expect(acquired.role).toBe("spawner");
  if (acquired.role !== "spawner") throw new Error(`expected spawner, got ${acquired.role}`);
  if (!acquired.lease.archiveComplete) {
    throw new Error(
      `archive fixture was not complete: ${JSON.stringify({
        archive: acquired.lease.recovery.archive,
        workspaceGeneration: acquired.lease.workspaceGeneration,
        archiveGeneration: acquired.lease.archiveGeneration,
        descriptor: archive.descriptor,
        ref,
      })}`,
    );
  }
  return { accountId, workspaceId, groupId, archive, ref, acquired };
}

async function establishArchiveFixture(fixture: ArchiveFixture, objectStorage: ObjectStorage) {
  return await establishApiSandboxSpawner({
    db: db!,
    settings,
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sandboxGroupId: fixture.groupId,
    sessionId: fixture.groupId,
    backend,
    environment: {},
    expectedEpoch: fixture.acquired.lease.leaseEpoch,
    acquiredLease: fixture.acquired.lease,
    fallbackEnvelope: null,
    dataPlaneUrl: null,
    objectStorage,
  });
}

function expectFailedArchiveRestore(
  lease: Awaited<ReturnType<typeof readLease>>,
  failureCode: string,
): void {
  expect(lease).not.toBeNull();
  expect(lease?.liveness).toBe("cold");
  expect(lease?.instanceId).toBeNull();
  expect(lease?.recovery.provider).toMatchObject({
    status: "missing",
    instanceId: null,
  });
  expect(lease?.recovery.restore).toMatchObject({
    status: "unrecoverable",
    failureCode,
    retryable: false,
  });
  expect(lease?.recovery.workspace.status).toBe("unrecoverable");
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-rematerialize-archive-ref");
  if (!shared) throw new Error("shared test database unavailable");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  for (const session of seeded.splice(0)) await closeSandbox(session);
  await client?.close();
  await shared?.release();
}, 180_000);

test("API cold spawner restores a valid object-storage archive ref", async () => {
  const fixture = await setupColdArchiveLease();
  const { archive, ref } = fixture;
  const storage = objectStorageFor(ref, archive.bytes);
  const result = await establishArchiveFixture(fixture, storage.objectStorage);
  seeded.push(result.established);
  const proof = await result.established.session.exec({
    cmd: "cat /workspace/api-object-ref-proof.txt",
  });
  expect(proof.exitCode).toBe(0);
  expect(proof.stdout).toContain("api-object-ref-proof");
  expect(storage.reads()).toBe(1);
  expect(result.established.restoredArchive?.revision).toBe(archive.descriptor.revision);
  const persistedState =
    result.lease.resumeState && typeof result.lease.resumeState === "object"
      ? result.lease.resumeState.sessionState
      : null;
  expect(persistedState && typeof persistedState === "object" ? persistedState : null).toBeTruthy();
  if (!persistedState || typeof persistedState !== "object")
    throw new Error("missing persisted state");
  expect(parseWorkspaceArchiveObjectRef(persistedState.workspaceArchiveRef)).not.toBeNull();
  expect(persistedState.workspaceArchive).toBeUndefined();
}, 120_000);

test("viewer attach forwards object storage and restores a cold archive ref", async () => {
  const fixture = await setupColdArchiveLease();
  const session = await createSession(db!, {
    requestedSessionId: fixture.groupId,
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    initialMessage: "viewer archive ref",
    resources: [],
    metadata: {},
    model: "m",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: backend,
  });
  await failWarmingToCold(db!, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sandboxGroupId: fixture.groupId,
    expectedEpoch: fixture.acquired.lease.leaseEpoch,
  });
  const storage = objectStorageFor(fixture.ref, fixture.archive.bytes);
  const attached = await attachViewer(
    { db: db!, settings, objectStorage: storage.objectStorage },
    { accountId: fixture.accountId, workspaceId: fixture.workspaceId, session },
  );
  try {
    expect(attached.liveness).toBe("warm");
    expect(storage.reads()).toBe(1);
    expect((await readLease(db!, fixture.workspaceId, fixture.groupId))?.archiveComplete).toBe(
      true,
    );
  } finally {
    const leaseBeforeDetach = await readLease(db!, fixture.workspaceId, fixture.groupId);
    await detachViewer(
      { db: db!, settings },
      {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sandboxGroupId: fixture.groupId,
        viewerId: attached.viewerId,
      },
    );
    await closeLeaseProvider(fixture, leaseBeforeDetach);
  }
}, 120_000);

test("API cold spawner records a missing object archive restore failure", async () => {
  const fixture = await setupColdArchiveLease();
  const storage = objectStorageFor(fixture.ref, null);
  await expect(establishArchiveFixture(fixture, storage.objectStorage)).rejects.toMatchObject({
    code: "archive_base64_invalid",
  });
  expect(storage.reads()).toBe(1);
  expectFailedArchiveRestore(
    await readLease(db!, fixture.workspaceId, fixture.groupId),
    "archive_base64_invalid",
  );
}, 120_000);

test("API cold spawner records a corrupt object archive restore failure", async () => {
  const fixture = await setupColdArchiveLease();
  const storage = objectStorageFor(fixture.ref, new Uint8Array([7]));
  await expect(establishArchiveFixture(fixture, storage.objectStorage)).rejects.toMatchObject({
    code: "archive_hash_mismatch",
  });
  expect(storage.reads()).toBe(1);
  expectFailedArchiveRestore(
    await readLease(db!, fixture.workspaceId, fixture.groupId),
    "archive_hash_mismatch",
  );
}, 120_000);
