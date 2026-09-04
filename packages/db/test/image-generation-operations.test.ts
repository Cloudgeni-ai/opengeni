import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  beginImageGenerationOperation,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  completeImageGenerationOperation,
  createDb,
  createSession,
  getImageGenerationOperation,
  initializeSessionStartAtomically,
  prepareGeneratedImageArtifact,
  prepareImageGenerationOperation,
  resetImageGenerationOperationBeforeProviderDispatch,
  settleGeneratedImageArtifactReady,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
const auxiliaryClients: DbClient[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("image-generation-operations");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL is required for image operation tests");
    available = false;
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await Promise.all(auxiliaryClients.map(async (auxiliaryClient) => await auxiliaryClient.close()));
  await client?.close();
  await shared?.release();
}, 60_000);

async function waitForImageOperationLockWait(
  connection: postgres.Sql,
  minimumWaiters: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await connection<{ count: number }[]>`
      select count(*)::integer as count
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'
        and query like '%image_generation_operations%'`;
    if ((row?.count ?? 0) >= minimumWaiters) return;
    await Bun.sleep(10);
  }
  throw new Error(
    `timed out waiting for ${minimumWaiters} image-generation operation lock waiter(s)`,
  );
}

describe("durable image generation operation rebinding", () => {
  test("rebinds only before provider admission and completes with the failover credential", async () => {
    if (!available) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `image-operation-account-${suffix}`,
      accountName: "Image operation test account",
      workspaceExternalSource: "test",
      workspaceExternalId: `image-operation-workspace-${suffix}`,
      workspaceName: "Image operation test workspace",
      subjectId: `image-operation-subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Generate an image",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `image-operation-${suffix}`,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed")
      throw new Error(`Could not claim image fixture: ${claim.reason}`);

    const staleClient = createDb(shared!.appUrl, { max: 1 });
    const rebindClient = createDb(shared!.appUrl, { max: 1 });
    auxiliaryClients.push(staleClient, rebindClient);

    const operationKey = "d".repeat(64);
    const operationId = crypto.randomUUID();
    const providerId = "codex-subscription";
    const modelId = "gpt-image-2";
    const requestDigest = "e".repeat(64);
    const bindingA = "a".repeat(64);
    const bindingB = "b".repeat(64);
    const bindingC = "c".repeat(64);
    const artifactA = crypto.randomUUID();
    const artifactB = crypto.randomUUID();
    const artifactC = crypto.randomUUID();
    const toolCallId = "call-image-rebind";
    const common = {
      id: operationId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      operationKey,
      toolCallId,
      providerId,
      modelId,
      requestDigest,
    };

    const preparedA = await prepareImageGenerationOperation(client.db, {
      ...common,
      providerBindingHash: bindingA,
      expectedArtifactId: artifactA,
    });
    expect(preparedA.created).toBe(true);
    expect(preparedA.operation.status).toBe("prepared");

    const begunA = await beginImageGenerationOperation(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      operationKey,
      providerBindingHash: bindingA,
      expectedArtifactId: artifactA,
    });
    expect(begunA.started).toBe(true);
    expect(begunA.operation.status).toBe("provider_started");

    const reset = await resetImageGenerationOperationBeforeProviderDispatch(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      operationKey,
      error: "Codex credential lease was lost before provider dispatch",
    });
    expect(reset.status).toBe("prepared");

    const reboundB = await prepareImageGenerationOperation(rebindClient.db, {
      ...common,
      providerBindingHash: bindingB,
      expectedArtifactId: artifactB,
    });
    expect(reboundB.created).toBe(false);
    expect(reboundB.operation).toMatchObject({
      id: operationId,
      operationKey,
      providerBindingHash: bindingB,
      expectedArtifactId: artifactB,
      status: "prepared",
    });

    await expect(
      beginImageGenerationOperation(staleClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        operationId,
        operationKey,
        providerBindingHash: bindingA,
        expectedArtifactId: artifactA,
      }),
    ).rejects.toThrow("binding changed");
    await expect(
      getImageGenerationOperation(staleClient.db, grant.workspaceId, operationId),
    ).resolves.toMatchObject({
      providerBindingHash: bindingB,
      expectedArtifactId: artifactB,
      status: "prepared",
    });

    const begunB = await beginImageGenerationOperation(rebindClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      operationKey,
      providerBindingHash: bindingB,
      expectedArtifactId: artifactB,
    });
    expect(begunB.started).toBe(true);
    expect(begunB.operation.status).toBe("provider_started");

    const raceOperationId = crypto.randomUUID();
    const raceOperationKey = "r".repeat(64);
    const raceArtifactA = crypto.randomUUID();
    const raceArtifactB = crypto.randomUUID();
    const raceCommon = {
      ...common,
      id: raceOperationId,
      operationKey: raceOperationKey,
      toolCallId: "call-image-rebind-race",
    };
    const preparedRace = await prepareImageGenerationOperation(client.db, {
      ...raceCommon,
      providerBindingHash: bindingA,
      expectedArtifactId: raceArtifactA,
    });
    expect(preparedRace.created).toBe(true);

    const barrierKey = 2_240_271;
    const blocker = postgres(shared!.adminUrl, { max: 1, prepare: false });
    let barrierHeld = false;
    try {
      await shared!.admin.unsafe(`
        CREATE OR REPLACE FUNCTION image_generation_operation_test_begin_barrier()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF OLD.id = '${raceOperationId}'::uuid
            AND OLD.status = 'prepared'
            AND NEW.status = 'provider_started'
          THEN
            PERFORM pg_advisory_xact_lock(${barrierKey});
          END IF;
          RETURN NEW;
        END;
        $$;
        DROP TRIGGER IF EXISTS image_generation_operation_test_begin_barrier
          ON image_generation_operations;
        CREATE TRIGGER image_generation_operation_test_begin_barrier
          BEFORE UPDATE OF status ON image_generation_operations
          FOR EACH ROW EXECUTE FUNCTION image_generation_operation_test_begin_barrier();
      `);
      await blocker`select pg_advisory_lock(${barrierKey})`;
      barrierHeld = true;

      const raceBeginA = beginImageGenerationOperation(staleClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        operationId: raceOperationId,
        operationKey: raceOperationKey,
        providerBindingHash: bindingA,
        expectedArtifactId: raceArtifactA,
      });
      await waitForImageOperationLockWait(shared!.admin, 1);

      const raceRebindB = prepareImageGenerationOperation(rebindClient.db, {
        ...raceCommon,
        providerBindingHash: bindingB,
        expectedArtifactId: raceArtifactB,
      });
      await waitForImageOperationLockWait(shared!.admin, 2);
      await expect(
        getImageGenerationOperation(client.db, grant.workspaceId, raceOperationId),
      ).resolves.toMatchObject({
        providerBindingHash: bindingA,
        expectedArtifactId: raceArtifactA,
        status: "prepared",
      });

      const [unlocked] = await blocker<Array<{ unlocked: boolean }>>`
        select pg_advisory_unlock(${barrierKey}) as unlocked`;
      expect(unlocked?.unlocked).toBe(true);
      barrierHeld = false;

      const begunRaceA = await raceBeginA;
      expect(begunRaceA.started).toBe(true);
      expect(begunRaceA.operation.status).toBe("provider_started");
      await expect(raceRebindB).rejects.toThrow("reserved operation");
      await expect(
        getImageGenerationOperation(client.db, grant.workspaceId, raceOperationId),
      ).resolves.toMatchObject({
        providerBindingHash: bindingA,
        expectedArtifactId: raceArtifactA,
        status: "provider_started",
      });
    } finally {
      if (barrierHeld) {
        await blocker`select pg_advisory_unlock(${barrierKey})`.catch(() => undefined);
      }
      await shared!.admin.unsafe(`
        DROP TRIGGER IF EXISTS image_generation_operation_test_begin_barrier
          ON image_generation_operations;
        DROP FUNCTION IF EXISTS image_generation_operation_test_begin_barrier();
      `);
      await blocker.end();
    }

    await expect(
      prepareImageGenerationOperation(client.db, {
        ...common,
        providerBindingHash: bindingC,
        expectedArtifactId: artifactC,
      }),
    ).rejects.toThrow("reserved operation");

    const uploadId = crypto.randomUUID();
    const imageHash = "f".repeat(64);
    const filename = `generated-image-${artifactB}.png`;
    await prepareGeneratedImageArtifact(client.db, {
      artifactId: artifactB,
      uploadId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      settlementKey: operationKey,
      toolCallId,
      sourceStrategy: "provider_adapter",
      providerId,
      providerBindingHash: bindingB,
      providerItemId: null,
      mediaType: "image/png",
      sizeBytes: 1,
      sha256: imageHash,
      width: 1,
      height: 1,
      sandboxPath: `/workspace/generated-images/${filename}`,
      filename,
      safeFilename: filename,
      bucket: "test",
      objectKey: `generated-images/${artifactB}`,
      uploadExpiresAt: new Date(Date.now() + 60_000),
    });
    await shared!.admin`
      update files
      set status = 'ready'
      where id = ${artifactB}`;
    await shared!.admin`
      update file_uploads
      set status = 'completed', completed_at = now()
      where id = ${uploadId}`;
    const ready = await settleGeneratedImageArtifactReady(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      artifactId: artifactB,
      settlementKey: operationKey,
    });
    expect(ready.status).toBe("ready");

    const completed = await completeImageGenerationOperation(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      operationKey,
    });
    expect(completed).toMatchObject({
      id: operationId,
      providerBindingHash: bindingB,
      expectedArtifactId: artifactB,
      status: "completed",
    });
  }, 180_000);
});
