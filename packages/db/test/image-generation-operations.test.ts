import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  beginImageGenerationOperation,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  completeImageGenerationOperation,
  createDb,
  createSession,
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
  await client?.close();
  await shared?.release();
}, 60_000);

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

    const reboundB = await prepareImageGenerationOperation(client.db, {
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

    const begunB = await beginImageGenerationOperation(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      operationKey,
      providerBindingHash: bindingB,
      expectedArtifactId: artifactB,
    });
    expect(begunB.started).toBe(true);
    expect(begunB.operation.status).toBe("provider_started");

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
