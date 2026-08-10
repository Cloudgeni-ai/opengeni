import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  admitVideoGenerationOperation,
  getGeneratedVideoArtifact,
  getVideoGenerationOperationSummary,
  markVideoGenerationAccepted,
  markVideoGenerationProviderStarted,
  markVideoGenerationRetaining,
  markVideoGenerationSubmissionIntent,
  mediaGenerationResultForStoredOperation,
  settleVideoGenerationFailure,
  settleVideoGenerationReady,
  updateWorkspaceVideoGenerationPolicy,
} from "../src/video-generation";
import {
  bootstrapWorkspace,
  applyCreditLedgerEntry,
  claimSessionWorkForAttempt,
  createConnection,
  createDb,
  createSession,
  getVideoGenerationOperation,
  getBillingBalance,
  initializeSessionStartAtomically,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  type DbClient,
} from "../src";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("video-generation-operations");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL is required for video operation tests");
    available = false;
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function baseFixture() {
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
  if (claim.action !== "claimed") throw new Error(`Could not claim video fixture: ${claim.reason}`);
  return { grant, session, claim, attemptId };
}

async function fixture() {
  const base = await baseFixture();
  const { grant } = base;
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
    fundingSource: "workspace_gateway",
    enabledModelIds: ["bytedance/seedance-2.5"],
    defaultModelId: "bytedance/seedance-2.5",
  });
  return { ...base, connection, policy };
}

async function managedFixture(creditMicros: number) {
  const base = await baseFixture();
  const { grant } = base;
  if (creditMicros > 0) {
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      type: "test_credit",
      amountMicros: creditMicros,
      sourceType: "test",
      sourceId: grant.workspaceId,
      idempotencyKey: `test:video-credit:${grant.workspaceId}`,
    });
  }
  const policy = await updateWorkspaceVideoGenerationPolicy(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    expectedRevision: 0,
    fundingSource: "opengeni_credits",
    enabledModelIds: ["bytedance/seedance-2.5"],
    defaultModelId: "bytedance/seedance-2.5",
  });
  return { ...base, policy };
}

describe("durable video generation operation", () => {
  test("keeps one logical paid operation and settles a distinct artifact/File atomically", async () => {
    if (!available) return;
    const { grant, session, claim, attemptId, connection, policy } = await fixture();
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
      fundingSource: "workspace_gateway" as const,
      pricedCostMicros: 0,
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
      (await getVideoGenerationOperation(client.db, grant.workspaceId, operationId))?.status,
    ).toBe("accepted");
    expect(
      (await getVideoGenerationOperation(client.db, grant.workspaceId, operationId))
        ?.admissionOutputState,
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
    const retained = await getGeneratedVideoArtifact(client.db, grant.workspaceId, artifactId);
    expect(retained?.file.id).toBe(fileId);
    const terminal = await mediaGenerationResultForStoredOperation(client.db, settled.operation);
    expect(terminal.status).toBe("ready");
    if (terminal.status === "ready") {
      expect(terminal.receipt.artifact.artifactId).toBe(artifactId);
      expect(terminal.receipt.sandboxPath).toBe(
        `/workspace/generated-videos/generated-video-${artifactId}.mp4`,
      );
    }
    expect(
      (await getVideoGenerationOperationSummary(client.db, grant.workspaceId, operationId))?.status,
    ).toBe("completed");
    expect(
      (await getVideoGenerationOperation(client.db, grant.workspaceId, operationId))?.status,
    ).toBe("completed");
  }, 60_000);

  test("debits one exact managed-video price, refunds failure, and retains a successful debit", async () => {
    if (!available) return;
    const { grant, session, claim, attemptId, policy } = await managedFixture(2_000_000);
    const operationId = crypto.randomUUID();
    const requestDigest = "1".repeat(64);
    const common = {
      id: operationId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      toolCallId: "call-managed-video",
      admissionKey: "2".repeat(64),
      requestDigest,
      promptDigest: "3".repeat(64),
      requestEncrypted: "encrypted-request",
      modelId: "bytedance/seedance-2.5",
      sourceMode: "text",
      capabilityRevision: "4".repeat(64),
      policyRevision: policy.revision,
      fundingSource: "opengeni_credits" as const,
      pricedCostMicros: 620_000,
      connectionId: null,
      credentialVersion: 1,
      credentialEncrypted: "encrypted-managed-credential",
      providerIdempotencyKey: "provider-managed-video",
      expectedArtifactId: crypto.randomUUID(),
      expectedFileId: crypto.randomUUID(),
      workspaceQuotaBytes: 1024 * 1024 * 1024,
      maxConcurrentPerWorkspace: 2,
      recoveryDeadlineAt: new Date(Date.now() + 60_000),
      references: [],
    };
    const admitted = await admitVideoGenerationOperation(client.db, common);
    expect(admitted.operation.creditState).toBe("debited");
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(1_380_000);

    const replay = await admitVideoGenerationOperation(client.db, {
      ...common,
      id: crypto.randomUUID(),
      expectedArtifactId: crypto.randomUUID(),
      expectedFileId: crypto.randomUUID(),
    });
    expect(replay.created).toBe(false);
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(1_380_000);

    await markVideoGenerationAccepted(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      requestDigest,
    });
    const failed = await settleVideoGenerationFailure(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId,
      requestDigest,
      status: "provider_failed",
      publicReason: "Provider rejected the request.",
    });
    expect(failed.creditState).toBe("refunded");
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(2_000_000);

    const successfulOperationId = crypto.randomUUID();
    const successfulRequestDigest = "d".repeat(64);
    const successful = await admitVideoGenerationOperation(client.db, {
      ...common,
      id: successfulOperationId,
      toolCallId: "call-managed-video-success",
      admissionKey: "e".repeat(64),
      requestDigest: successfulRequestDigest,
      promptDigest: "f".repeat(64),
      providerIdempotencyKey: "provider-managed-video-success",
      expectedArtifactId: crypto.randomUUID(),
      expectedFileId: crypto.randomUUID(),
    });
    expect(successful.operation.creditState).toBe("debited");
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(1_380_000);
    await markVideoGenerationAccepted(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId: successfulOperationId,
      requestDigest: successfulRequestDigest,
    });
    await markVideoGenerationSubmissionIntent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId: successfulOperationId,
      requestDigest: successfulRequestDigest,
      encryptedProviderRequest: "encrypted-successful-provider-request",
      providerRequestExpiresAt: new Date(Date.now() + 60_000),
      nextReconcileAt: new Date(),
    });
    await markVideoGenerationProviderStarted(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId: successfulOperationId,
      requestDigest: successfulRequestDigest,
      providerJobId: "provider-managed-video-success-job",
      nextReconcileAt: new Date(),
    });
    await markVideoGenerationRetaining(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId: successfulOperationId,
      requestDigest: successfulRequestDigest,
    });
    const retained = await settleVideoGenerationReady(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationId: successfulOperationId,
      requestDigest: successfulRequestDigest,
      fileId: successful.operation.expectedFileId,
      bucket: "video-test-bucket",
      objectKey: `video-generation/objects/sha256/${"7".repeat(64)}.mp4`,
      sizeBytes: 2_000_000,
      sha256: "7".repeat(64),
      facts: {
        durationSeconds: 4,
        width: 854,
        height: 480,
        fps: 24,
        hasAudio: false,
        videoCodec: "h264",
        audioCodec: null,
      },
    });
    expect(retained.operation.creditState).toBe("debited");
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(1_380_000);
  }, 60_000);

  test("refunds managed credits when preparation returns a tool error before acceptance", async () => {
    if (!available) return;
    const { grant, session, claim, attemptId, policy } = await managedFixture(1_000_000);
    const operationId = crypto.randomUUID();
    const requestDigest = "9".repeat(64);
    const toolCallId = "call-managed-video-preparation-error";
    await admitVideoGenerationOperation(client.db, {
      id: operationId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      toolCallId,
      admissionKey: "a".repeat(64),
      requestDigest,
      promptDigest: "b".repeat(64),
      requestEncrypted: "encrypted-request",
      modelId: "bytedance/seedance-2.5",
      sourceMode: "first_frame",
      capabilityRevision: "c".repeat(64),
      policyRevision: policy.revision,
      fundingSource: "opengeni_credits",
      pricedCostMicros: 620_000,
      connectionId: null,
      credentialVersion: 1,
      credentialEncrypted: "encrypted-managed-credential",
      providerIdempotencyKey: "provider-managed-video-preparation-error",
      expectedArtifactId: crypto.randomUUID(),
      expectedFileId: crypto.randomUUID(),
      workspaceQuotaBytes: 1024 * 1024 * 1024,
      maxConcurrentPerWorkspace: 2,
      recoveryDeadlineAt: new Date(Date.now() + 60_000),
      references: [],
    });
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(380_000);
    await registerPendingSessionToolCall(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      executionGeneration: claim.turn.executionGeneration,
      attemptId,
      callId: toolCallId,
      callType: "function_call",
      callItem: {
        type: "function_call",
        callId: toolCallId,
        name: "generate_video",
        arguments: JSON.stringify({ prompt: "Animate the frame" }),
      },
    });
    expect(
      await recordPendingSessionToolCallResult(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: claim.turn.id,
        executionGeneration: claim.turn.executionGeneration,
        attemptId,
        callId: toolCallId,
        resultItem: {
          type: "function_call_result",
          callId: toolCallId,
          output: {
            type: "text",
            text: "The reference image could not be prepared.",
          },
        },
      }),
    ).toEqual({ accepted: true, recorded: true });
    const cancelled = await getVideoGenerationOperation(client.db, grant.workspaceId, operationId);
    expect(cancelled?.status).toBe("cancelled_before_submit");
    expect(cancelled?.creditState).toBe("refunded");
    expect(cancelled?.admissionOutputState).toBe("pending");
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(1_000_000);
  }, 60_000);

  test("rejects managed video before admission when the exact price is unavailable", async () => {
    if (!available) return;
    const { grant, session, claim, attemptId, policy } = await managedFixture(100_000);
    await expect(
      admitVideoGenerationOperation(client.db, {
        id: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: claim.turn.id,
        attemptId,
        toolCallId: "call-insufficient-video",
        admissionKey: "5".repeat(64),
        requestDigest: "6".repeat(64),
        promptDigest: "7".repeat(64),
        requestEncrypted: "encrypted-request",
        modelId: "bytedance/seedance-2.5",
        sourceMode: "text",
        capabilityRevision: "8".repeat(64),
        policyRevision: policy.revision,
        fundingSource: "opengeni_credits",
        pricedCostMicros: 620_000,
        connectionId: null,
        credentialVersion: 1,
        credentialEncrypted: "encrypted-managed-credential",
        providerIdempotencyKey: "provider-insufficient-video",
        expectedArtifactId: crypto.randomUUID(),
        expectedFileId: crypto.randomUUID(),
        workspaceQuotaBytes: 1024 * 1024 * 1024,
        maxConcurrentPerWorkspace: 2,
        recoveryDeadlineAt: new Date(Date.now() + 60_000),
        references: [],
      }),
    ).rejects.toThrow("insufficient OpenGeni credits");
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(100_000);
  }, 60_000);
});
