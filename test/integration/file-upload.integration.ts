import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  allAccountPermissions,
  allWorkspacePermissions,
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  completeFileUpload,
  createDb,
  dbSql,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { createObservability } from "@opengeni/observability";
import { createObjectStorage, type ObjectStorage } from "@opengeni/storage";
import {
  MemoryEventBus,
  startTestServices,
  testSettings,
  waitFor,
  type TestServices,
} from "@opengeni/testing";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { createFileUploadReaperActivities } from "../../apps/worker/src/activities/file-upload-reaper";
import type { ActivityServices } from "../../apps/worker/src/activities/types";
import {
  FILE_UPLOAD_REAPER_PERIOD_MS,
  FILE_UPLOAD_REAPER_SCHEDULE_ID,
  registerFileUploadReaperSchedule,
} from "../../apps/worker/src/index";

const APP_ROLE_PASSWORD = "ope19-app-role-password";
const DELEGATION_SECRET = "ope19-file-upload-delegation-secret";

describe("file upload crash, concurrency, RLS, and object cleanup", () => {
  let services: UploadTestServices;
  let admin: postgres.Sql;
  let appDb: DbClient;
  let storage: ObjectStorage;
  let settings: ReturnType<typeof uploadSettings>;

  beforeAll(async () => {
    services = await startUploadTestServices();
    admin = postgres(services.databaseUrl, { max: 6 });
    // The role must exist BEFORE migrations so every IF-EXISTS grant block runs.
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
          CREATE ROLE opengeni_app LOGIN PASSWORD '${APP_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
        ELSE
          ALTER ROLE opengeni_app WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
    `);
    await services.migrate();
    const appUrl = new URL(services.databaseUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = APP_ROLE_PASSWORD;
    appDb = createDb(appUrl.toString(), { max: 6, rlsStrategy: "force" });
    settings = uploadSettings(services.databaseUrl, services.objectStorageEndpoint!);
    storage = createObjectStorage(settings)!;
  }, 180_000);

  afterAll(async () => {
    await appDb?.close();
    await admin?.end().catch(() => undefined);
    await services?.down();
  }, 60_000);

  test("repairs exactly one usage event after crash and duplicate row-locked finalize", async () => {
    const roleRows = (await appDb.db.execute(dbSql`
      select current_user,
             (select rolsuper from pg_roles where rolname = current_user) as rolsuper,
             (select rolbypassrls from pg_roles where rolname = current_user) as rolbypassrls
    `)) as unknown as Array<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>;
    expect(roleRows[0]).toEqual({
      current_user: "opengeni_app",
      rolsuper: false,
      rolbypassrls: false,
    });
    const forceRls = await admin<
      Array<{ relname: string; relforcerowsecurity: boolean; relrowsecurity: boolean }>
    >`
      select relname, relforcerowsecurity, relrowsecurity
      from pg_class
      where relname in ('files', 'file_uploads', 'usage_events')
      order by relname
    `;
    expect(forceRls).toHaveLength(3);
    expect(forceRls.every((row) => row.relforcerowsecurity && row.relrowsecurity)).toBe(true);
    const functionAcl = await admin<Array<{ public_execute: boolean; app_execute: boolean }>>`
      select
        coalesce(bool_or(A.grantee = 0 and A.privilege_type = 'EXECUTE'), false) as public_execute,
        coalesce(bool_or(
          A.grantee = (select oid from pg_roles where rolname = 'opengeni_app')
          and A.privilege_type = 'EXECUTE'
        ), false) as app_execute
      from pg_proc P
      cross join lateral aclexplode(coalesce(P.proacl, acldefault('f', P.proowner))) A
      where P.oid = 'opengeni_private.claim_expired_file_upload_cleanup(bigint,bigint,integer)'::regprocedure
    `;
    expect(functionAcl[0]).toEqual({ public_execute: false, app_execute: true });

    const fixture = await workspaceFixture(appDb, settings);
    const app = fileApp(fixture.settings);
    const image = pngBytes();

    // Both requests complete their real MinIO HEAD, enter completeFileUpload,
    // and then WAIT on this independently held file_uploads row lock.
    const checksum = await sha256Hex(image);
    const concurrent = await beginAndPut(app, fixture, image, "locked-finalize.png", {
      sha256: checksum,
    });
    let releaseLock!: () => void;
    let lockAcquired!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const lockTask = admin.begin(async (sql) => {
      await sql`select id from file_uploads where id = ${concurrent.uploadId} for update`;
      lockAcquired();
      await release;
    });
    await acquired;
    const finalize = () => completeRequest(app, fixture, concurrent.uploadId);
    const firstPromise = finalize();
    const secondPromise = finalize();
    try {
      await waitFor(
        async () => {
          const rows = await admin<Array<{ waiting: number }>>`
            select count(*)::int as waiting
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%file_uploads%for update%'
          `;
          return (rows[0]?.waiting ?? 0) >= 2;
        },
        { timeoutMs: 10_000, intervalMs: 25 },
      );
    } finally {
      releaseLock();
      await lockTask;
    }
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstFile = ((await first.json()) as { file: { id: string } }).file;
    const secondFile = ((await second.json()) as { file: { id: string } }).file;
    expect(firstFile.id).toBe(concurrent.fileId);
    expect(secondFile).toEqual(firstFile);
    expect(await usageRows(concurrent.fileId)).toEqual([
      {
        event_type: "file.uploaded",
        quantity: image.byteLength,
        unit: "byte",
        source_resource_type: "file",
        source_resource_id: concurrent.fileId,
        idempotency_key: `file.uploaded:${fixture.workspaceId}:${concurrent.fileId}`,
      },
    ]);

    // Deterministic request-death boundary: commit ready/completed directly,
    // before the route can write usage. A later duplicate completion must repair
    // the missing event and repeated repair attempts must still total exactly 1.
    const crashed = await beginAndPut(app, fixture, image, "crash-boundary.png");
    await completeFileUpload(appDb.db, fixture.workspaceId, crashed.uploadId);
    expect(await usageCount(crashed.fileId)).toBe(0);
    const other = await workspaceFixture(appDb, settings);
    expect((await completeRequest(app, other, crashed.uploadId)).status).toBe(404);
    expect(
      (
        await app.request(workspacePath(other.workspaceId, `/files/${crashed.fileId}`), {
          headers: other.headers,
        })
      ).status,
    ).toBe(404);
    const repairs = await Promise.all([
      completeRequest(app, fixture, crashed.uploadId),
      completeRequest(app, fixture, crashed.uploadId),
      completeRequest(app, fixture, crashed.uploadId),
    ]);
    expect(repairs.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await usageCount(crashed.fileId)).toBe(1);

    // Storage staging remains separate from inference admission. A zero-credit
    // turn fails, then the funded retry reuses the SAME durable file id.
    const blocked = await app.request(workspacePath(fixture.workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...fixture.headers },
      body: JSON.stringify({
        initialMessage: "inspect the preserved image",
        resources: [{ kind: "file", fileId: crashed.fileId }],
      }),
    });
    expect(blocked.status).toBe(402);
    await applyCreditLedgerEntry(appDb.db, {
      accountId: fixture.accountId,
      type: "credit_topup",
      amountMicros: 1_000_000,
      sourceType: "test",
      sourceId: `ope19:${crashed.fileId}`,
      idempotencyKey: `ope19-credit:${crashed.fileId}`,
    });
    const retried = await app.request(workspacePath(fixture.workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...fixture.headers },
      body: JSON.stringify({
        initialMessage: "inspect the preserved image",
        resources: [{ kind: "file", fileId: crashed.fileId }],
      }),
    });
    expect(retried.status).toBe(202);
    expect((await retried.json()) as { resources: unknown[] }).toMatchObject({
      resources: [{ kind: "file", fileId: crashed.fileId }],
    });

    async function usageCount(fileId: string): Promise<number> {
      const rows = await admin<Array<{ count: number }>>`
        select count(*)::int as count
        from usage_events
        where event_type = 'file.uploaded' and source_resource_id = ${fileId}
      `;
      return rows[0]!.count;
    }

    async function usageRows(fileId: string) {
      return await admin<
        Array<{
          event_type: string;
          quantity: number;
          unit: string;
          source_resource_type: string;
          source_resource_id: string;
          idempotency_key: string;
        }>
      >`
        select event_type,
               quantity::int,
               unit,
               source_resource_type,
               source_resource_id::text,
               idempotency_key
        from usage_events
        where event_type = 'file.uploaded' and source_resource_id = ${fileId}
      `;
    }
  }, 60_000);

  test("reclaims expired MinIO objects after injected delete failure without touching live uploads", async () => {
    const fixture = await workspaceFixture(appDb, settings);
    const app = fileApp(fixture.settings);
    const expired = await beginAndPut(app, fixture, pngBytes(), "orphan-after-put.png");
    const live = await beginAndPut(app, fixture, pngBytes(), "still-live.png");
    const completed = await beginAndPut(app, fixture, pngBytes(), "completed.png");
    expect((await completeRequest(app, fixture, completed.uploadId)).status).toBe(200);
    await admin`
      update file_uploads
      set expires_at = now() - interval '2 hours', updated_at = now() - interval '2 hours'
      where id in (${expired.uploadId}, ${completed.uploadId})
    `;
    expect(await storage.getObjectBytes(expired.objectKey)).not.toBeNull();
    expect(await storage.getObjectBytes(live.objectKey)).not.toBeNull();
    expect(await storage.getObjectBytes(completed.objectKey)).not.toBeNull();

    let injected = false;
    const activities = createFileUploadReaperActivities(reaperServices(fixture.settings), {
      graceMs: 0,
      claimTimeoutMs: 0,
      batchSize: 10,
      deleteObject: async (provider, key) => {
        if (!injected) {
          injected = true;
          throw new Error("injected provider delete outage");
        }
        await provider.deleteObject(key);
      },
    });
    const first = await activities.reapExpiredFileUploads();
    expect(first).toEqual({ claimed: 1, deleted: 0, failed: 1 });
    expect(await storage.getObjectBytes(expired.objectKey)).not.toBeNull();
    const afterFailure = await admin<Array<{ upload_status: string; file_status: string }>>`
      select U.status as upload_status, F.status as file_status
      from file_uploads U join files F on F.id = U.file_id
      where U.id = ${expired.uploadId}
    `;
    expect(afterFailure[0]).toEqual({ upload_status: "cleanup_pending", file_status: "failed" });
    const claimedRetry = await completeRequest(app, fixture, expired.uploadId);
    expect(claimedRetry.status).toBe(409);
    expect(await claimedRetry.text()).toBe("file upload is failed");

    const second = await activities.reapExpiredFileUploads();
    expect(second).toEqual({ claimed: 1, deleted: 1, failed: 0 });
    expect(await storage.getObjectBytes(expired.objectKey)).toBeNull();
    expect(await storage.getObjectBytes(live.objectKey)).not.toBeNull();
    expect(await storage.getObjectBytes(completed.objectKey)).not.toBeNull();
    const afterRecovery = await admin<Array<{ upload_status: string; file_status: string }>>`
      select U.status as upload_status, F.status as file_status
      from file_uploads U join files F on F.id = U.file_id
      where U.id = ${expired.uploadId}
    `;
    expect(afterRecovery[0]).toEqual({ upload_status: "expired", file_status: "failed" });

    const concurrentOrphan = await beginAndPut(app, fixture, pngBytes(), "concurrent-orphan.png");
    await admin`
      update file_uploads
      set expires_at = now() - interval '2 hours', updated_at = now() - interval '2 hours'
      where id = ${concurrentOrphan.uploadId}
    `;
    const concurrentActivities = createFileUploadReaperActivities(
      reaperServices(fixture.settings),
      { graceMs: 0, claimTimeoutMs: 60_000, batchSize: 10 },
    );
    const concurrentResults = await Promise.all([
      concurrentActivities.reapExpiredFileUploads(),
      concurrentActivities.reapExpiredFileUploads(),
    ]);
    expect(concurrentResults.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(concurrentResults.reduce((sum, result) => sum + result.deleted, 0)).toBe(1);
    expect(concurrentResults.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
    expect(await storage.getObjectBytes(concurrentOrphan.objectKey)).toBeNull();

    // Provider metadata is not trusted. Even when the signed PUT originally
    // matched, a mismatched content type or checksum injected before finalize
    // is rejected and the provider object is deleted before the row is terminal.
    const contentTypeMismatch = await beginAndPut(
      app,
      fixture,
      pngBytes(),
      "content-type-mismatch.png",
    );
    await storage.putObject({
      key: contentTypeMismatch.objectKey,
      contentType: "text/plain",
      body: pngBytes(),
    });
    expect((await completeRequest(app, fixture, contentTypeMismatch.uploadId)).status).toBe(422);
    expect(await storage.getObjectBytes(contentTypeMismatch.objectKey)).toBeNull();

    const checksum = await sha256Hex(pngBytes());
    const checksumMismatch = await beginAndPut(app, fixture, pngBytes(), "checksum-mismatch.png", {
      sha256: checksum,
    });
    await storage.putObject({
      key: checksumMismatch.objectKey,
      contentType: "image/png",
      body: pngBytes(),
      sha256: "0".repeat(64),
    });
    expect((await completeRequest(app, fixture, checksumMismatch.uploadId)).status).toBe(422);
    expect(await storage.getObjectBytes(checksumMismatch.objectKey)).toBeNull();

    // A metadata rejection deletes the real provider object before making the
    // row terminal, so malformed uploads cannot become unreapable orphans.
    const mismatched = await beginAndPut(
      app,
      fixture,
      pngBytes().slice(0, 4),
      "declared-larger-than-put.png",
      { declaredSize: pngBytes().byteLength },
    );
    const rejected = await completeRequest(app, fixture, mismatched.uploadId);
    expect(rejected.status).toBe(422);
    expect(await storage.getObjectBytes(mismatched.objectKey)).toBeNull();

    // The request-side cleanup boundary is independently failure-injected. A
    // provider outage must NOT terminally settle the row while the object still
    // exists; the ordinary reaper later reclaims, deletes, and settles it.
    const routeFailure = await beginAndPut(
      app,
      fixture,
      pngBytes().slice(0, 4),
      "route-delete-outage.png",
      { declaredSize: pngBytes().byteLength },
    );
    const failingDeleteStorage: ObjectStorage = {
      ...storage,
      deleteObject: async () => {
        throw new Error("injected route provider delete outage");
      },
    };
    const routeFailureResponse = await completeRequest(
      fileApp(fixture.settings, failingDeleteStorage),
      fixture,
      routeFailure.uploadId,
    );
    expect(routeFailureResponse.status).toBe(422);
    expect(await storage.getObjectBytes(routeFailure.objectKey)).not.toBeNull();
    const routeFailureState = await admin<Array<{ upload_status: string; file_status: string }>>`
      select U.status as upload_status, F.status as file_status
      from file_uploads U join files F on F.id = U.file_id
      where U.id = ${routeFailure.uploadId}
    `;
    expect(routeFailureState[0]).toEqual({
      upload_status: "cleanup_pending",
      file_status: "failed",
    });
    const routeRecovery = await createFileUploadReaperActivities(reaperServices(fixture.settings), {
      graceMs: 0,
      claimTimeoutMs: 0,
      batchSize: 10,
    }).reapExpiredFileUploads();
    expect(routeRecovery).toEqual({ claimed: 1, deleted: 1, failed: 0 });
    expect(await storage.getObjectBytes(routeFailure.objectKey)).toBeNull();

    // Expiry cleanup and finalize use the same upload -> file lock order. Hold
    // the upload row so both paths are observably waiting, then release them to
    // race: either finalize wins and the provider object remains ready, or the
    // cleanup claim wins and no ready row/usage can point at a deleted object.
    const raced = await beginAndPut(app, fixture, pngBytes(), "expiry-finalize-race.png");
    await admin`
      update file_uploads
      set expires_at = now() - interval '2 hours', updated_at = now() - interval '2 hours'
      where id = ${raced.uploadId}
    `;
    let releaseRaceLock!: () => void;
    let raceLockAcquired!: () => void;
    const releaseRace = new Promise<void>((resolve) => {
      releaseRaceLock = resolve;
    });
    const raceAcquired = new Promise<void>((resolve) => {
      raceLockAcquired = resolve;
    });
    const raceLockTask = admin.begin(async (sql) => {
      await sql`select id from file_uploads where id = ${raced.uploadId} for update`;
      raceLockAcquired();
      await releaseRace;
    });
    await raceAcquired;
    const expiryRequest = completeRequest(app, fixture, raced.uploadId);
    const finalizeDirect = completeFileUpload(appDb.db, fixture.workspaceId, raced.uploadId);
    try {
      await waitFor(
        async () => {
          const rows = await admin<Array<{ waiting: number }>>`
            select count(*)::int as waiting
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%file_uploads%for update%'
          `;
          return (rows[0]?.waiting ?? 0) >= 2;
        },
        { timeoutMs: 10_000, intervalMs: 25 },
      );
    } finally {
      releaseRaceLock();
      await raceLockTask;
    }
    const [expiryOutcome, finalizeOutcome] = await Promise.allSettled([
      expiryRequest,
      finalizeDirect,
    ]);
    const state = await admin<Array<{ upload_status: string; file_status: string }>>`
      select U.status as upload_status, F.status as file_status
      from file_uploads U join files F on F.id = U.file_id
      where U.id = ${raced.uploadId}
    `;
    if (state[0]?.upload_status === "completed") {
      expect(finalizeOutcome.status).toBe("fulfilled");
      expect(expiryOutcome.status).toBe("fulfilled");
      expect(expiryOutcome.status === "fulfilled" ? expiryOutcome.value.status : undefined).toBe(
        200,
      );
      expect(state[0]).toEqual({ upload_status: "completed", file_status: "ready" });
      expect(await storage.getObjectBytes(raced.objectKey)).not.toBeNull();
      expect(await usageCountForFile(admin, raced.fileId)).toBe(1);
    } else {
      expect(expiryOutcome.status).toBe("fulfilled");
      expect(expiryOutcome.status === "fulfilled" ? expiryOutcome.value.status : undefined).toBe(
        409,
      );
      expect(finalizeOutcome.status).toBe("rejected");
      expect(state[0]).toEqual({ upload_status: "expired", file_status: "failed" });
      expect(await storage.getObjectBytes(raced.objectKey)).toBeNull();
      expect(await usageCountForFile(admin, raced.fileId)).toBe(0);
    }
  }, 60_000);

  test("registers one SKIP Temporal schedule and dispatches one activity under overlapping fires", async () => {
    const taskQueue = `ope19-file-upload-reaper-${crypto.randomUUID()}`;
    const temporalSettings = {
      ...settings,
      temporalHost: services.temporalHost,
      temporalTaskQueue: taskQueue,
    };
    const connection = await Connection.connect({ address: services.temporalHost });
    const nativeConnection = await NativeConnection.connect({ address: services.temporalHost });
    const client = new Client({ connection, namespace: temporalSettings.temporalNamespace });
    const handle = client.schedule.getHandle(FILE_UPLOAD_REAPER_SCHEDULE_ID);
    // External/manual test services can outlive a failed test process. Delete
    // only this deterministic test schedule before registration so a stale
    // task queue cannot make the proof accidentally green or hang.
    await handle.delete().catch(() => undefined);

    let activityCalls = 0;
    let activityStarted!: () => void;
    let releaseActivity!: () => void;
    const started = new Promise<void>((resolve) => {
      activityStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    const worker = await Worker.create({
      connection: nativeConnection,
      namespace: temporalSettings.temporalNamespace,
      taskQueue,
      workflowsPath: new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname,
      activities: {
        reapExpiredFileUploads: async () => {
          activityCalls += 1;
          activityStarted();
          await release;
          return { claimed: 0, deleted: 0, failed: 0 };
        },
      },
    });
    const run = worker.run();
    const observability = createObservability(temporalSettings, {
      component: "ope19-file-schedule-test",
    });
    let registration: Awaited<ReturnType<typeof registerFileUploadReaperSchedule>> | undefined;
    try {
      registration = await registerFileUploadReaperSchedule(temporalSettings, observability);
      expect(registration.registered).toBe(true);
      const description = await handle.describe();
      expect(description.scheduleId).toBe(FILE_UPLOAD_REAPER_SCHEDULE_ID);
      expect(description.action).toMatchObject({
        type: "startWorkflow",
        workflowType: "fileUploadReaperWorkflow",
        taskQueue,
        args: [],
      });
      expect(description.spec.intervals).toContainEqual(
        expect.objectContaining({ every: FILE_UPLOAD_REAPER_PERIOD_MS }),
      );
      expect(description.policies).toMatchObject({
        overlap: ScheduleOverlapPolicy.SKIP,
        pauseOnFailure: false,
      });

      await handle.trigger(description.policies.overlap);
      await started;
      await handle.trigger(description.policies.overlap);
      await Bun.sleep(500);
      expect(activityCalls).toBe(1);
      releaseActivity();
      await waitFor(async () => {
        const current = await handle.describe();
        return (
          current.info.numActionsTaken === 1 &&
          current.info.numActionsSkippedOverlap >= 1 &&
          current.info.runningActions.length === 0
        );
      });
      expect(activityCalls).toBe(1);

      // A second worker replica must adopt the same schedule rather than
      // creating another cadence or workflow target.
      const duplicate = await registerFileUploadReaperSchedule(temporalSettings, observability);
      expect(duplicate.registered).toBe(false);
      await duplicate.close();
    } finally {
      releaseActivity?.();
      await handle.delete().catch(() => undefined);
      await registration?.close();
      worker.shutdown();
      await run;
      await connection.close();
      await nativeConnection.close();
    }
  }, 60_000);

  function fileApp(appSettings: ReturnType<typeof uploadSettings>, objectStorage?: ObjectStorage) {
    return createApp({
      settings: appSettings,
      db: appDb.db,
      bus: new MemoryEventBus(),
      workflowClient: noopWorkflowClient(),
      ...(objectStorage ? { objectStorage } : {}),
    });
  }

  function reaperServices(appSettings: ReturnType<typeof uploadSettings>) {
    const observability = createObservability(appSettings, { component: "ope19-file-test" });
    return async (): Promise<ActivityServices> => ({
      settings: appSettings,
      db: appDb.db,
      bus: null as never,
      runtime: null as never,
      objectStorage: storage,
      documentServices: null as never,
      observability,
      wakeSessionWorkflow: null,
    });
  }
});

type WorkspaceFixture = {
  accountId: string;
  workspaceId: string;
  headers: Record<string, string>;
  settings: ReturnType<typeof uploadSettings>;
};

type UploadTestServices = Pick<
  TestServices,
  "databaseUrl" | "objectStorageEndpoint" | "temporalHost" | "migrate" | "down"
>;

async function usageCountForFile(sql: postgres.Sql, fileId: string): Promise<number> {
  const rows = await sql<Array<{ count: number }>>`
    select count(*)::int as count
    from usage_events
    where event_type = 'file.uploaded' and source_resource_id = ${fileId}
  `;
  return rows[0]!.count;
}

async function startUploadTestServices(): Promise<UploadTestServices> {
  const databaseUrl = process.env.OPENGENI_TEST_FILE_UPLOAD_DATABASE_URL;
  const objectStorageEndpoint = process.env.OPENGENI_TEST_FILE_UPLOAD_OBJECT_STORAGE_ENDPOINT;
  const temporalHost = process.env.OPENGENI_TEST_FILE_UPLOAD_TEMPORAL_HOST;
  if (databaseUrl || objectStorageEndpoint || temporalHost) {
    if (!databaseUrl || !objectStorageEndpoint || !temporalHost) {
      throw new Error(
        "OPENGENI_TEST_FILE_UPLOAD_DATABASE_URL, OPENGENI_TEST_FILE_UPLOAD_OBJECT_STORAGE_ENDPOINT, and OPENGENI_TEST_FILE_UPLOAD_TEMPORAL_HOST must be set together",
      );
    }
    return {
      databaseUrl,
      objectStorageEndpoint,
      temporalHost,
      migrate: async () => await migrate(databaseUrl),
      down: async () => {},
    };
  }
  return await startTestServices({ temporal: true, objectStorage: true });
}

async function workspaceFixture(
  appDb: DbClient,
  settings: ReturnType<typeof uploadSettings>,
): Promise<WorkspaceFixture> {
  const access = await bootstrapWorkspace(appDb.db, {
    accountExternalSource: "test:ope19-file",
    accountExternalId: crypto.randomUUID(),
    accountName: "OPE-19 file account",
    workspaceExternalSource: "test:ope19-file",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "OPE-19 file workspace",
    subjectId: `test:ope19:${crypto.randomUUID()}`,
    accountPermissions: allAccountPermissions,
    workspacePermissions: allWorkspacePermissions,
  });
  const accountId = access.defaultAccountId!;
  const workspaceId = access.defaultWorkspaceId!;
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId: access.subjectId,
    permissions: [...allAccountPermissions, ...allWorkspacePermissions],
    exp: Math.floor(Date.now() / 1_000) + 120,
  });
  return {
    accountId,
    workspaceId,
    headers: { authorization: `Bearer ${token}` },
    settings,
  };
}

function uploadSettings(databaseUrl: string, endpoint: string) {
  return testSettings({
    databaseUrl,
    productAccessMode: "managed",
    usageLimitsMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    betterAuthSecret: "ope19-better-auth-secret-at-least-32-bytes",
    publicBaseUrl: "http://127.0.0.1:3000",
    objectStorageBackend: "s3-compatible",
    objectStorageEndpoint: endpoint,
    objectStorageSandboxEndpoint: endpoint,
    objectStorageBucket: "opengeni-files",
    objectStorageAccessKeyId: "minioadmin",
    objectStorageSecretAccessKey: "minioadmin",
    objectStorageForcePathStyle: true,
  });
}

async function beginAndPut(
  app: ReturnType<typeof createApp>,
  fixture: WorkspaceFixture,
  bytes: Uint8Array,
  filename: string,
  options: { declaredSize?: number; sha256?: string } = {},
): Promise<{ uploadId: string; fileId: string; objectKey: string }> {
  const response = await app.request(workspacePath(fixture.workspaceId, "/files/uploads"), {
    method: "POST",
    headers: { "content-type": "application/json", ...fixture.headers },
    body: JSON.stringify({
      filename,
      contentType: "image/png",
      sizeBytes: options.declaredSize ?? bytes.byteLength,
      ...(options.sha256 ? { sha256: options.sha256 } : {}),
    }),
  });
  expect(response.status).toBe(201);
  const upload = (await response.json()) as {
    uploadId: string;
    fileId: string;
    putUrl: string;
    requiredHeaders: Record<string, string>;
  };
  const put = await fetch(upload.putUrl, {
    method: "PUT",
    headers: upload.requiredHeaders,
    body: bytes,
  });
  if (put.status !== 200) {
    const detail = (await put.text())
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    throw new Error(`provider PUT failed with HTTP ${put.status}: ${detail.slice(0, 300)}`);
  }
  const objectKey = `workspaces/${fixture.workspaceId}/files/${upload.fileId}/original/${filename}`;
  return { uploadId: upload.uploadId, fileId: upload.fileId, objectKey };
}

function completeRequest(
  app: ReturnType<typeof createApp>,
  fixture: WorkspaceFixture,
  uploadId: string,
): Promise<Response> {
  return app.request(workspacePath(fixture.workspaceId, `/files/uploads/${uploadId}/complete`), {
    method: "POST",
    headers: fixture.headers,
  });
}

function pngBytes(): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2GQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

function workspacePath(workspaceId: string, path: string): string {
  return `/v1/workspaces/${workspaceId}${path}`;
}

function noopWorkflowClient(): SessionWorkflowClient {
  return {
    signalUserMessage: async () => {},
    wakeSessionWorkflow: async () => {},
    signalApprovalDecision: async () => {},
    signalSessionControl: async () => {},
    syncScheduledTask: async () => {},
    deleteScheduledTaskSchedule: async () => {},
    triggerScheduledTask: async () => {},
    startRigVerification: async () => {},
  };
}
