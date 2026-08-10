import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  admitVideoGenerationOperation,
  getGeneratedVideoArtifact,
  getVideoGenerationOperationSummary,
  markVideoGenerationProviderStarted,
  markVideoGenerationRetaining,
  markVideoGenerationSubmissionIntent,
  mediaGenerationResultForStoredOperation,
  settleVideoGenerationReady,
  updateWorkspaceVideoGenerationPolicy,
} from "../src/video-generation";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createConnection,
  createDb,
  createSession,
  getVideoGenerationOperation,
  initializeSessionStartAtomically,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  type DbClient,
} from "../src";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("video-generation-operations");
  if (!shared) {
    if (requireRealDatabase)
      throw new Error("PostgreSQL is required for video operation tests");
    available = false;
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `video-account-${suffix}`,
    accountName: "Video test account",
    workspaceExternalSource: "test",
    workspaceExternalId: `video-workspace-${suffix}`,
    workspaceName: "Video test workspace",
    subjectId: `video-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Generate a short video",
    resources: [],
    metadata: {},
    model: "scripted-model",
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
    dispatchId: `video-test-${suffix}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed")
    throw new Error(`Could not claim video fixture: ${claim.reason}`);
  const connection = await createConnection(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: null,
    providerDomain: "ai-gateway.vercel.sh",
    kind: "api_key",
    credentialEncrypted: "test-encrypted-credential",
    metadata: { credentialRole: "vercel_ai_gateway" },
    createdBySubjectId: grant.subjectId,
  });
  const policy = await updateWorkspaceVideoGenerationPolicy(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    expectedRevision: 0,
    enabledModelIds: ["bytedance/seedance-2.5"],
    defaultModelId: "bytedance/seedance-2.5",
  });
  return { grant, session, claim, attemptId, connection, policy };
}

describe("durable video generation operation", () => {
  test("keeps one logical paid operation and settles a distinct artifact/File atomically", async () => {
    if (!available) return;
    const { grant, session, claim, attemptId, connection, policy } =
      await fixture();
    const operationId = crypto.randomUUID();
    const artifactId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    const requestDigest = "a".repeat(64);
    const admissionKey = "b".repeat(64);
    const common = {
      id: operationId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      toolCallId: "call-video-1",
      admissionKey,
      requestDigest,
      promptDigest: "c".repeat(64),
      requestEncrypted: "encrypted-request",
      modelId: "bytedance/seedance-2.5",
      sourceMode: "text",
      capabilityRevision: "e".repeat(64),
      policyRevision: policy.revision,
      connectionId: connection.id,
      credentialVersion: connection.version,
      credentialEncrypted: "encrypted-credential-lease",
      providerIdempotencyKey: "provider-idempotency-1",
      expectedArtifactId: artifactId,
      expectedFileId: fileId,
      workspaceQuotaBytes: 1024 * 1024 * 1024,
      maxConcurrentPerWorkspace: 2,
      recoveryDeadlineAt: new Date(Date.now() + 60_000),
      references: [],
    };
    const first = await admitVideoGenerationOperation(client.db, common);
    const replay = await admitVideoGenerationOperation(client.db, {
      ...common,
      id: crypto.randomUUID(),
      expectedArtifactId: crypto.randomUUID(),
      expectedFileId: crypto.randomUUID(),
    });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.operation.id).toBe(operationId);

    expect(
      await registerPendingSessionToolCall(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: claim.turn.id,
        executionGeneration: claim.turn.executionGeneration,
        attemptId,
        callId: common.toolCallId,
        callType: "function_call",
        callItem: {
          type: "function_call",
          callId: common.toolCallId,
          name: "generate_video",
          arguments: JSON.stringify({ prompt: "A quiet fjord at sunrise" }),
        },
      }),
    ).toEqual({ accepted: true, registered: true });
    expect(
      await recordPendingSessionToolCallResult(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: claim.turn.id,
        executionGeneration: claim.turn.executionGeneration,
        attemptId,
        callId: common.toolCallId,
        resultItem: {
          type: "function_call_result",
          callId: common.toolCallId,
          output: {
            type: "text",
            text: JSON.stringify({
              schemaVersion: 1,
              status: "accepted",
              operationId,
            }),
          },
        },
        videoGenerationAcceptance: { operationId, requestDigest },
      }),
    ).toEqual({ accepted: true, recorded: true });
    expect(
      (
        await getVideoGenerationOperation(
          client.db,
          grant.workspaceId,
          operationId,
        )
      )?.status,
    ).toBe("accepted");
    expect(
      (
        await getVideoGenerationOperation(
          client.db,
          grant.workspaceId,
          operationId,
        )
      )?.admissionOutputState,
    ).toBe("recorded");
    await markVideoGenerationSubmissionIntent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      requestDigest,
      encryptedProviderRequest: "encrypted-provider-request",
      providerRequestExpiresAt: new Date(Date.now() + 60_000),
      nextReconcileAt: new Date(),
    });
    await markVideoGenerationProviderStarted(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      requestDigest,
      providerJobId: "provider-job-1",
      nextReconcileAt: new Date(),
    });
    await markVideoGenerationRetaining(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      requestDigest,
    });
    const settled = await settleVideoGenerationReady(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      requestDigest,
      fileId,
      bucket: "video-test-bucket",
      objectKey: `video-generation/objects/sha256/${"d".repeat(64)}.mp4`,
      sizeBytes: 2_000_000,
      sha256: "d".repeat(64),
      facts: {
        durationSeconds: 5,
        width: 1280,
        height: 720,
        fps: 24,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
      },
    });
    expect(settled.artifact.id).toBe(artifactId);
    expect(settled.artifact.primaryFileId).toBe(fileId);
    expect(settled.artifact.id).not.toBe(fileId);
    const retained = await getGeneratedVideoArtifact(
      client.db,
      grant.workspaceId,
      artifactId,
    );
    expect(retained?.file.id).toBe(fileId);
    const terminal = await mediaGenerationResultForStoredOperation(
      client.db,
      settled.operation,
    );
    expect(terminal.status).toBe("ready");
    if (terminal.status === "ready") {
      expect(terminal.receipt.artifact.artifactId).toBe(artifactId);
      expect(terminal.receipt.sandboxPath).toBe(
        `/workspace/generated-videos/generated-video-${artifactId}.mp4`,
      );
    }
    expect(
      (
        await getVideoGenerationOperationSummary(
          client.db,
          grant.workspaceId,
          operationId,
        )
      )?.status,
    ).toBe("completed");
    expect(
      (
        await getVideoGenerationOperation(
          client.db,
          grant.workspaceId,
          operationId,
        )
      )?.status,
    ).toBe("completed");
  }, 60_000);
});
