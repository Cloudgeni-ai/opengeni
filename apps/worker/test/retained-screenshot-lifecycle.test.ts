import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  claimRetainedScreenshotMaintenance,
  claimSessionWorkForAttempt,
  completeRetainedScreenshotMaintenance,
  createDb,
  createSession,
  getRetainedScreenshotArtifact,
  getWorkspaceScreenshotQuota,
  initializeSessionStartAtomically,
  prepareRetainedScreenshotArtifact,
  promoteRetainedScreenshotMaintenanceCleanup,
  settleRetainedScreenshotArtifactReady,
  type Database,
  type DbClient,
} from "@opengeni/db";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createRetainedScreenshotMaintenanceActivities,
  type RetainedScreenshotMaintenanceActivityOptions,
} from "../src/activities/retained-screenshot-reaper";
import {
  retainComputerScreenshot,
  validateComputerScreenshot,
} from "../src/activities/retained-screenshots";
import type { ActivityServices } from "../src/activities/types";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const SCREENSHOT = validateComputerScreenshot({ bytes: PNG, mediaType: "image/png" });
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const explicitAdminUrl = process.env.OPENGENI_RETAINED_SCREENSHOT_TEST_ADMIN_URL;
const explicitAppUrl = process.env.OPENGENI_RETAINED_SCREENSHOT_TEST_APP_URL;

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let appSql: postgres.Sql;
let client: DbClient;
let db: Database;
const cleanupRows: Array<{ accountId: string; workspaceId: string }> = [];

type WorkspaceFixture = {
  accountId: string;
  workspaceId: string;
};

type TurnFixture = WorkspaceFixture & {
  sessionId: string;
  turnId: string;
  attemptId: string;
};

type StoredObject = {
  bytes: Uint8Array;
  contentType: string;
  sha256: string | null;
};

function storageFixture() {
  const objects = new Map<string, StoredObject>();
  const deleteCalls: string[] = [];
  let afterPut: (() => Promise<void>) | null = null;
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected object-storage operation");
  };
  const storage: ObjectStorage = {
    bucket: "retained-screenshot-lifecycle",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    createPutUrl: unexpected,
    createGetUrl: unexpected,
    async headFile(file) {
      const object = objects.get(file.objectKey);
      if (!object) throw new Error(`object missing: ${file.objectKey}`);
      return {
        ContentLength: object.bytes.byteLength,
        ContentType: object.contentType,
        Metadata: object.sha256 ? { sha256: object.sha256 } : undefined,
      };
    },
    async fileExists(file) {
      return objects.has(file.objectKey);
    },
    async getFileBytes(file) {
      const object = objects.get(file.objectKey);
      if (!object) throw new Error(`object missing: ${file.objectKey}`);
      return Uint8Array.from(object.bytes);
    },
    async getFileRange(file, range) {
      const object = objects.get(file.objectKey);
      return object ? object.bytes.slice(range.start, range.end + 1) : null;
    },
    async getObjectBytes(key) {
      const object = objects.get(key);
      return object
        ? { bytes: Uint8Array.from(object.bytes), contentType: object.contentType }
        : null;
    },
    async putObject(input) {
      objects.set(input.key, {
        bytes: Uint8Array.from(input.body),
        contentType: input.contentType,
        sha256: input.sha256 ?? null,
      });
      await afterPut?.();
    },
    async deleteObject(key) {
      deleteCalls.push(key);
      objects.delete(key);
    },
  };
  return {
    storage,
    objects,
    deleteCalls,
    afterNextPut(callback: () => Promise<void>) {
      afterPut = async () => {
        afterPut = null;
        await callback();
      };
    },
  };
}

async function freshWorkspace(): Promise<WorkspaceFixture> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name)
    values (${`retained-screenshot-${crypto.randomUUID()}`})
    returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'retained screenshot lifecycle')
    returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  cleanupRows.push({ accountId: account!.id, workspaceId: workspace!.id });
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function freshTurn(): Promise<TurnFixture> {
  const workspace = await freshWorkspace();
  const session = await createSession(db, {
    ...workspace,
    initialMessage: "retain this screenshot",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    ...workspace,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, workspace.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `retained-screenshot-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") {
    throw new Error(`Could not claim retained screenshot fixture: ${claim.reason}`);
  }
  return {
    ...workspace,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
  };
}

async function prepareArtifact(
  fixture: TurnFixture,
  storage: ObjectStorage,
  input: { expiresAt?: Date } = {},
) {
  const artifactId = crypto.randomUUID();
  const objectKey = `workspaces/${fixture.workspaceId}/files/${artifactId}/retained/computer-screenshot.png`;
  const settlementKey = `test:${crypto.randomUUID()}`;
  const prepared = await prepareRetainedScreenshotArtifact(db, {
    artifactId,
    ...fixture,
    settlementKey,
    toolCallId: `call-${artifactId}`,
    toolOutputId: `output-${artifactId}`,
    mediaType: "image/png",
    sizeBytes: SCREENSHOT.sizeBytes,
    sha256: SCREENSHOT.sha256,
    width: SCREENSHOT.width,
    height: SCREENSHOT.height,
    retentionExpiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
    bucket: storage.bucket,
    objectKey,
    workspaceQuotaBytes: 1024 * 1024,
  });
  return { ...prepared, artifactId, objectKey, settlementKey };
}

function maintenanceActivity(
  storage: ObjectStorage,
  options: RetainedScreenshotMaintenanceActivityOptions = {},
) {
  const warnings: Array<Record<string, unknown>> = [];
  const activity = createRetainedScreenshotMaintenanceActivities(
    async () =>
      ({
        db,
        objectStorage: storage,
        observability: {
          warn(_message: string, fields: Record<string, unknown>) {
            warnings.push(fields);
          },
          info() {},
        },
      }) as unknown as ActivityServices,
    { pendingGraceMs: 0, claimTimeoutMs: 0, batchSize: 20, ...options },
  );
  return { ...activity, warnings };
}

async function artifactRow(artifactId: string) {
  const [row] = await admin<
    Array<{
      sessionId: string | null;
      turnId: string | null;
      attemptId: string | null;
      status: string;
      quotaState: string;
      cleanupReason: string | null;
      maintenanceClaimId: string | null;
    }>
  >`
    select session_id as "sessionId", turn_id as "turnId", attempt_id as "attemptId",
      status, quota_state as "quotaState", cleanup_reason as "cleanupReason",
      maintenance_claim_id as "maintenanceClaimId"
    from retained_screenshot_artifacts
    where artifact_id = ${artifactId}`;
  return row ?? null;
}

async function fileCount(workspaceId: string, artifactId: string): Promise<number> {
  const [row] = await admin<{ count: number }[]>`
    select count(*)::integer as count
    from files
    where workspace_id = ${workspaceId} and id = ${artifactId}`;
  return row!.count;
}

async function deleteTurnHierarchy(fixture: TurnFixture): Promise<void> {
  await admin`
    update session_turns
    set active_attempt_id = null
    where workspace_id = ${fixture.workspaceId} and id = ${fixture.turnId}`;
  await admin`
    delete from session_turn_attempts
    where workspace_id = ${fixture.workspaceId} and id = ${fixture.attemptId}`;
  await admin`
    update sessions
    set active_turn_id = null
    where workspace_id = ${fixture.workspaceId} and id = ${fixture.sessionId}`;
  await admin`
    delete from session_turns
    where workspace_id = ${fixture.workspaceId} and id = ${fixture.turnId}`;
  await admin`
    delete from sessions
    where workspace_id = ${fixture.workspaceId} and id = ${fixture.sessionId}`;
}

beforeAll(async () => {
  if (explicitAdminUrl || explicitAppUrl) {
    if (!explicitAdminUrl || !explicitAppUrl) {
      throw new Error(
        "Both OPENGENI_RETAINED_SCREENSHOT_TEST_ADMIN_URL and OPENGENI_RETAINED_SCREENSHOT_TEST_APP_URL are required",
      );
    }
    admin = postgres(explicitAdminUrl, { max: 4 });
    appSql = postgres(explicitAppUrl, { max: 1 });
    client = createDb(explicitAppUrl, { max: 4 });
    db = client.db;
    return;
  }
  shared = await acquireSharedTestDatabase("worker-retained-screenshot-lifecycle");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable");
    }
    available = false;
    return;
  }
  admin = shared.admin;
  appSql = postgres(shared.appUrl, { max: 1 });
  client = createDb(shared.appUrl, { max: 4 });
  db = client.db;
}, 180_000);

afterEach(async () => {
  if (!available) return;
  for (const fixture of cleanupRows.splice(0).reverse()) {
    await admin`delete from retained_screenshot_artifacts where workspace_id = ${fixture.workspaceId}`;
    await admin`delete from files where workspace_id = ${fixture.workspaceId}`;
    await admin`delete from workspaces where id = ${fixture.workspaceId}`;
    await admin`delete from managed_accounts where id = ${fixture.accountId}`;
  }
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    // noop
  }
  try {
    await appSql?.end();
  } catch {
    // noop
  }
  if (explicitAdminUrl) {
    try {
      await admin?.end();
    } catch {
      // noop
    }
  }
  await shared?.release();
}, 180_000);

describe("retained screenshot lifecycle fences", () => {
  test("session cascade preserves object, file, lifecycle evidence, and quota until owned cleanup", async () => {
    if (!available) return;
    const fixture = await freshTurn();
    const memory = storageFixture();
    const prepared = await prepareArtifact(fixture, memory.storage);
    await memory.storage.putObject({
      key: prepared.objectKey,
      contentType: "image/png",
      body: PNG,
      sha256: SCREENSHOT.sha256,
    });
    await settleRetainedScreenshotArtifactReady(db, {
      ...fixture,
      artifactId: prepared.artifactId,
      settlementKey: prepared.settlementKey,
    });
    expect(await getWorkspaceScreenshotQuota(db, fixture.workspaceId)).toEqual({
      reservedBytes: 0,
      readyBytes: PNG.byteLength,
    });

    let fileDeleteError: unknown;
    try {
      await admin`delete from files where workspace_id = ${fixture.workspaceId} and id = ${prepared.artifactId}`;
    } catch (error) {
      fileDeleteError = error;
    }
    expect(String((fileDeleteError as { constraint_name?: unknown })?.constraint_name)).toBe(
      "retained_screenshot_artifacts_workspace_file_fk",
    );

    await deleteTurnHierarchy(fixture);
    expect(await artifactRow(prepared.artifactId)).toMatchObject({
      sessionId: null,
      turnId: null,
      attemptId: null,
      status: "cleanup_queued",
      quotaState: "ready",
      cleanupReason: "session_deleted",
    });
    expect(await fileCount(fixture.workspaceId, prepared.artifactId)).toBe(1);
    expect(memory.objects.has(prepared.objectKey)).toBeTrue();
    expect(await getWorkspaceScreenshotQuota(db, fixture.workspaceId)).toEqual({
      reservedBytes: 0,
      readyBytes: PNG.byteLength,
    });

    const claims = await claimRetainedScreenshotMaintenance(db, {
      pendingGraceMs: 0,
      claimTimeoutMs: 0,
      limit: 10,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      action: "delete",
      artifactId: prepared.artifactId,
      sessionId: null,
      cleanupReason: "session_deleted",
    });
    await memory.storage.deleteObject(prepared.objectKey);
    const completion = {
      ...fixture,
      artifactId: prepared.artifactId,
      claimId: claims[0]!.claimId,
      outcome: "deleted" as const,
    };
    expect(await completeRetainedScreenshotMaintenance(db, completion)).toBeTrue();
    expect(await completeRetainedScreenshotMaintenance(db, completion)).toBeTrue();
    expect(await artifactRow(prepared.artifactId)).toBeNull();
    expect(await fileCount(fixture.workspaceId, prepared.artifactId)).toBe(0);
    expect(await getWorkspaceScreenshotQuota(db, fixture.workspaceId)).toEqual({
      reservedBytes: 0,
      readyBytes: 0,
    });
    expect(memory.deleteCalls).toEqual([prepared.objectKey]);
  }, 180_000);

  test("duplicate settlement and duplicate expiry completion move and release quota exactly once", async () => {
    if (!available) return;
    const fixture = await freshTurn();
    const memory = storageFixture();
    const prepared = await prepareArtifact(fixture, memory.storage, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    await memory.storage.putObject({
      key: prepared.objectKey,
      contentType: "image/png",
      body: PNG,
      sha256: SCREENSHOT.sha256,
    });
    const settlement = {
      ...fixture,
      artifactId: prepared.artifactId,
      settlementKey: prepared.settlementKey,
    };
    expect((await settleRetainedScreenshotArtifactReady(db, settlement)).status).toBe("ready");
    expect((await settleRetainedScreenshotArtifactReady(db, settlement)).status).toBe("ready");
    expect(await getWorkspaceScreenshotQuota(db, fixture.workspaceId)).toEqual({
      reservedBytes: 0,
      readyBytes: PNG.byteLength,
    });

    const [claim] = await claimRetainedScreenshotMaintenance(db, {
      pendingGraceMs: 0,
      claimTimeoutMs: 0,
      limit: 10,
    });
    expect(claim).toMatchObject({
      action: "delete",
      artifactId: prepared.artifactId,
      cleanupReason: "expired",
    });
    await memory.storage.deleteObject(prepared.objectKey);
    const completion = {
      ...fixture,
      artifactId: prepared.artifactId,
      claimId: claim!.claimId,
      outcome: "expired" as const,
    };
    expect(await completeRetainedScreenshotMaintenance(db, completion)).toBeTrue();
    expect(await completeRetainedScreenshotMaintenance(db, completion)).toBeTrue();
    expect(await artifactRow(prepared.artifactId)).toMatchObject({
      status: "expired",
      quotaState: "released",
      cleanupReason: "expired",
      maintenanceClaimId: null,
    });
    expect(await getWorkspaceScreenshotQuota(db, fixture.workspaceId)).toEqual({
      reservedBytes: 0,
      readyBytes: 0,
    });
  }, 180_000);

  test("mismatched reconciliation cannot delete after a concurrent ready settlement wins", async () => {
    if (!available) return;
    const fixture = await freshTurn();
    const memory = storageFixture();
    const prepared = await prepareArtifact(fixture, memory.storage);
    await memory.storage.putObject({
      key: prepared.objectKey,
      contentType: "image/png",
      body: PNG,
      sha256: SCREENSHOT.sha256,
    });
    const maintenance = maintenanceActivity(memory.storage, {
      fileExists: async () => true,
      headFile: async (): Promise<ObjectHead> => {
        await settleRetainedScreenshotArtifactReady(db, {
          ...fixture,
          artifactId: prepared.artifactId,
          settlementKey: prepared.settlementKey,
        });
        return {
          ContentLength: PNG.byteLength + 1,
          ContentType: "image/png",
          Metadata: { sha256: SCREENSHOT.sha256 },
        };
      },
      deleteObject: async (_storage, key) => {
        await memory.storage.deleteObject(key);
      },
    });

    expect(await maintenance.maintainRetainedScreenshots()).toEqual({
      claimed: 1,
      ready: 0,
      deleted: 0,
      failed: 0,
      retryable: 1,
    });
    expect(memory.deleteCalls).toHaveLength(0);
    expect(maintenance.warnings).toHaveLength(1);
    expect(
      await getRetainedScreenshotArtifact(
        db,
        fixture.workspaceId,
        fixture.sessionId,
        prepared.artifactId,
      ),
    ).toMatchObject({ status: "ready", quotaState: "ready", maintenanceClaimId: null });
    expect(await getWorkspaceScreenshotQuota(db, fixture.workspaceId)).toEqual({
      reservedBytes: 0,
      readyBytes: PNG.byteLength,
    });
  }, 180_000);

  test("reclaimed maintenance invalidates the stale claim before promotion or quota release", async () => {
    if (!available) return;
    const fixture = await freshTurn();
    const memory = storageFixture();
    const prepared = await prepareArtifact(fixture, memory.storage);
    const [first] = await claimRetainedScreenshotMaintenance(db, {
      pendingGraceMs: 0,
      claimTimeoutMs: 60_000,
      limit: 10,
    });
    expect(first).toMatchObject({ action: "reconcile", artifactId: prepared.artifactId });
    await admin`
      update retained_screenshot_artifacts
      set maintenance_claimed_at = now() - interval '1 hour'
      where artifact_id = ${prepared.artifactId}`;
    const [second] = await claimRetainedScreenshotMaintenance(db, {
      pendingGraceMs: 0,
      claimTimeoutMs: 0,
      limit: 10,
    });
    expect(second).toMatchObject({ action: "reconcile", artifactId: prepared.artifactId });
    expect(second!.claimId).not.toBe(first!.claimId);

    expect(
      await promoteRetainedScreenshotMaintenanceCleanup(db, {
        ...fixture,
        artifactId: prepared.artifactId,
        claimId: first!.claimId,
        cleanupReason: "failed",
      }),
    ).toBeFalse();
    expect(
      await completeRetainedScreenshotMaintenance(db, {
        ...fixture,
        artifactId: prepared.artifactId,
        claimId: first!.claimId,
        outcome: "failed",
      }),
    ).toBeFalse();
    expect(
      await promoteRetainedScreenshotMaintenanceCleanup(db, {
        ...fixture,
        artifactId: prepared.artifactId,
        claimId: second!.claimId,
        cleanupReason: "failed",
      }),
    ).toBeTrue();
    expect(
      await completeRetainedScreenshotMaintenance(db, {
        ...fixture,
        artifactId: prepared.artifactId,
        claimId: second!.claimId,
        outcome: "failed",
      }),
    ).toBeTrue();
    expect(await artifactRow(prepared.artifactId)).toMatchObject({
      status: "failed",
      quotaState: "released",
      maintenanceClaimId: null,
    });
    expect(await getWorkspaceScreenshotQuota(db, fixture.workspaceId)).toEqual({
      reservedBytes: 0,
      readyBytes: 0,
    });
  }, 180_000);

  test("a session deleted after provider PUT compensates the late object and remains cleanable", async () => {
    if (!available) return;
    const fixture = await freshTurn();
    const memory = storageFixture();
    memory.afterNextPut(async () => {
      await deleteTurnHierarchy(fixture);
    });
    const result = await retainComputerScreenshot({
      db,
      objectStorage: memory.storage,
      ...fixture,
      output: {
        callId: "call-late-delete",
        toolOutputId: "output-late-delete",
        bytes: PNG,
        mediaType: "image/png",
      },
      retentionMs: 60_000,
      workspaceQuotaBytes: 1024 * 1024,
    });
    expect(result).toMatchObject({ available: false, reason: "pending" });
    const artifactId = result.artifactId;
    const row = await artifactRow(artifactId);
    expect(row).toMatchObject({
      sessionId: null,
      turnId: null,
      attemptId: null,
      status: "cleanup_queued",
      quotaState: "reserved",
      cleanupReason: "session_deleted",
    });
    expect(memory.objects.size).toBe(0);
    expect(memory.deleteCalls).toHaveLength(1);
    expect(await getWorkspaceScreenshotQuota(db, fixture.workspaceId)).toEqual({
      reservedBytes: PNG.byteLength,
      readyBytes: 0,
    });

    const maintenance = maintenanceActivity(memory.storage);
    expect(await maintenance.maintainRetainedScreenshots()).toEqual({
      claimed: 1,
      ready: 0,
      deleted: 1,
      failed: 0,
      retryable: 0,
    });
    expect(memory.deleteCalls).toHaveLength(2);
    expect(await artifactRow(artifactId)).toBeNull();
    expect(await fileCount(fixture.workspaceId, artifactId)).toBe(0);
    expect(await getWorkspaceScreenshotQuota(db, fixture.workspaceId)).toEqual({
      reservedBytes: 0,
      readyBytes: 0,
    });
  }, 180_000);

  test("FORCE-RLS denies cross-workspace rows while the fixed SECURITY DEFINER claim sees both", async () => {
    if (!available) return;
    const first = await freshTurn();
    const second = await freshTurn();
    const memory = storageFixture();
    const firstArtifact = await prepareArtifact(first, memory.storage);
    const secondArtifact = await prepareArtifact(second, memory.storage);

    const [role] = await appSql<
      Array<{ currentUser: string; superuser: boolean; bypassRls: boolean }>
    >`
      select current_user as "currentUser", rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = current_user`;
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });

    const forced = await admin<Array<{ relname: string; forced: boolean }>>`
      select relname, relforcerowsecurity as forced
      from pg_class
      where relname in ('retained_screenshot_artifacts', 'workspace_screenshot_quotas')
      order by relname`;
    expect(forced).toEqual([
      { relname: "retained_screenshot_artifacts", forced: true },
      { relname: "workspace_screenshot_quotas", forced: true },
    ]);

    const visible = await appSql.begin(async (sql) => {
      await sql`select set_config('opengeni.account_id', ${first.accountId}, true)`;
      await sql`select set_config('opengeni.workspace_id', ${first.workspaceId}, true)`;
      return await sql<{ artifactId: string }[]>`
        select artifact_id as "artifactId"
        from retained_screenshot_artifacts
        where artifact_id in (${firstArtifact.artifactId}, ${secondArtifact.artifactId})`;
    });
    expect(visible).toEqual([{ artifactId: firstArtifact.artifactId }]);
    expect(
      await getRetainedScreenshotArtifact(
        db,
        first.workspaceId,
        second.sessionId,
        firstArtifact.artifactId,
      ),
    ).toBeNull();
    expect(
      await getRetainedScreenshotArtifact(
        db,
        first.workspaceId,
        first.sessionId,
        secondArtifact.artifactId,
      ),
    ).toBeNull();

    const [functionConfig] = await admin<{ config: string }[]>`
      select coalesce(array_to_string(proconfig, ','), '') as config
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private'
        and p.proname = 'claim_retained_screenshot_maintenance'`;
    expect(functionConfig!.config).toContain("search_path=pg_catalog, public");

    const claims = await claimRetainedScreenshotMaintenance(db, {
      pendingGraceMs: 0,
      claimTimeoutMs: 0,
      limit: 10,
    });
    expect(new Set(claims.map((claim) => claim.artifactId))).toEqual(
      new Set([firstArtifact.artifactId, secondArtifact.artifactId]),
    );
  }, 180_000);
});
