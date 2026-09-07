import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AttemptToolCatalogIntegrityError, createAttemptToolEnvironment } from "@opengeni/codemode";
import type { AttemptToolCall } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  AttemptToolCatalogAuthorityError,
  AttemptToolCatalogConflictError,
  CodemodeOperationConflictError,
  CodemodeToolApprovalRequiredError,
  CodemodeToolNotInCatalogError,
  bootstrapWorkspace,
  claimCodemodeOperation,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  completeCodemodeOperation,
  getCodemodeOperation,
  getAttemptToolCatalog,
  initializeSessionStartAtomically,
  markCodemodeOperationExecutionStarted,
  persistAttemptToolCatalog,
  submitCodemodeOperation,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("attempt-tool-catalogs");
  if (!shared) {
    available = false;
    console.warn("[attempt-tool-catalogs] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `catalog-account-${suffix}`,
    accountName: "Attempt catalog test",
    workspaceExternalSource: "test",
    workspaceExternalId: `catalog-workspace-${suffix}`,
    workspaceName: "Attempt catalog test",
    subjectId: `catalog-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

function catalog(
  scope: Awaited<ReturnType<typeof fixture>>,
  toolName = "search",
  createdAt = new Date("2026-08-09T12:00:00.000Z"),
) {
  return createAttemptToolEnvironment({
    scope,
    generation: 1,
    createdAt,
    definitions: [
      {
        identity: { serverId: "docs", toolName },
        modelName: `docs__${toolName}`,
        description: `Run ${toolName}`,
        inputSchema: { type: "object", additionalProperties: true },
        source: "docs",
        approval: "none",
        execute: async () => ({ content: [] }),
      },
    ],
  }).catalog;
}

function codemodeCall(
  catalogDigest: string,
  operationId = crypto.randomUUID(),
  argumentsValue: AttemptToolCall["arguments"] = { query: "hello" },
) {
  return {
    operationId,
    catalogDigest,
    identity: { serverId: "docs", toolName: "search" },
    arguments: argumentsValue,
    caller: { kind: "codemode" as const, subjectId: "agent:test" },
  };
}

describe("durable attempt tool catalogs", () => {
  test("persists one exact verified catalog idempotently and reads it under RLS", async () => {
    if (!available) return;
    const scope = await fixture();
    const first = catalog(scope);
    expect(await persistAttemptToolCatalog(client.db, first)).toEqual(first);

    const replay = catalog(scope, "search", new Date("2026-08-09T13:00:00.000Z"));
    expect(replay.digest).toBe(first.digest);
    expect(await persistAttemptToolCatalog(client.db, replay)).toEqual(first);
    expect(
      await getAttemptToolCatalog(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
      }),
    ).toEqual(first);
  });

  test("rejects a different immutable catalog for the same attempt", async () => {
    if (!available) return;
    const scope = await fixture();
    await persistAttemptToolCatalog(client.db, catalog(scope));
    await expect(
      persistAttemptToolCatalog(client.db, catalog(scope, "fetch")),
    ).rejects.toBeInstanceOf(AttemptToolCatalogConflictError);
  });

  test("rejects validly signed catalog content bound to the wrong durable owner", async () => {
    if (!available) return;
    const scope = await fixture();
    const wrongOwner = catalog({ ...scope, sessionId: crypto.randomUUID() });
    await expect(persistAttemptToolCatalog(client.db, wrongOwner)).rejects.toBeInstanceOf(
      AttemptToolCatalogAuthorityError,
    );
  });

  test("rejects catalog tampering before any database write", async () => {
    if (!available) return;
    const scope = await fixture();
    const valid = catalog(scope);
    await expect(
      persistAttemptToolCatalog(client.db, {
        ...valid,
        entries: [{ ...valid.entries[0]!, description: "tampered" }],
      }),
    ).rejects.toBeInstanceOf(AttemptToolCatalogIntegrityError);
    expect(
      await getAttemptToolCatalog(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
      }),
    ).toBeNull();
  });

  test("admits an exact Codemode call once without duplicating idempotent retries", async () => {
    if (!available) return;
    const scope = await fixture();
    const exactCatalog = catalog(scope);
    await persistAttemptToolCatalog(client.db, exactCatalog);
    const operationId = crypto.randomUUID();
    const call = codemodeCall(exactCatalog.digest, operationId);
    const first = await submitCodemodeOperation(client.db, {
      ...scope,
      call,
    });
    expect(first.created).toBe(true);
    expect(first.operation.state).toBe("queued");
    const replay = await submitCodemodeOperation(client.db, {
      ...scope,
      call,
    });
    expect(replay.created).toBe(false);
    expect(replay.operation.operationId).toBe(operationId);
    const second = await submitCodemodeOperation(client.db, {
      ...scope,
      call: codemodeCall(exactCatalog.digest),
    });
    expect(second.created).toBe(true);
    await expect(
      submitCodemodeOperation(client.db, {
        ...scope,
        call: codemodeCall(exactCatalog.digest, operationId, { query: "different" }),
      }),
    ).rejects.toBeInstanceOf(CodemodeOperationConflictError);
  });

  test("serializes concurrent first submissions into one creation and one replay", async () => {
    if (!available) return;
    const scope = await fixture();
    const exactCatalog = catalog(scope);
    await persistAttemptToolCatalog(client.db, exactCatalog);
    const call = codemodeCall(exactCatalog.digest, crypto.randomUUID());

    const submissions = await Promise.all([
      submitCodemodeOperation(client.db, { ...scope, call }),
      submitCodemodeOperation(client.db, { ...scope, call }),
    ]);

    expect(submissions.map(({ created }) => created).sort()).toEqual([false, true]);
    expect(submissions[0]!.operation).toEqual(submissions[1]!.operation);
  });

  test("claims once and records one durable result under the owning claim fence", async () => {
    if (!available) return;
    const scope = await fixture();
    const exactCatalog = catalog(scope);
    await persistAttemptToolCatalog(client.db, exactCatalog);
    const call = codemodeCall(exactCatalog.digest);
    await submitCodemodeOperation(client.db, { ...scope, call });
    const claimId = crypto.randomUUID();
    const claimed = await claimCodemodeOperation(client.db, {
      ...scope,
      catalogDigest: exactCatalog.digest,
      operationId: call.operationId,
      claimId,
    });
    expect(claimed.status).toBe("claimed");
    expect(
      (
        await claimCodemodeOperation(client.db, {
          ...scope,
          catalogDigest: exactCatalog.digest,
          operationId: call.operationId,
          claimId: crypto.randomUUID(),
        })
      ).status,
    ).toBe("already_running");
    expect(
      await markCodemodeOperationExecutionStarted(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
        operationId: call.operationId,
        claimId,
      }),
    ).toBe(true);
    expect(
      await completeCodemodeOperation(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
        operationId: call.operationId,
        claimId: crypto.randomUUID(),
        result: { content: [{ type: "text", text: "wrong owner" }] },
      }),
    ).toBe(false);
    expect(
      await completeCodemodeOperation(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
        operationId: call.operationId,
        claimId,
        result: { content: [{ type: "text", text: "done" }] },
      }),
    ).toBe(true);
    expect(
      await getCodemodeOperation(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
        operationId: call.operationId,
      }),
    ).toMatchObject({
      state: "completed",
      result: { content: [{ type: "text", text: "done" }] },
    });
  });

  test("rejects identities absent from the frozen catalog before reserving execution", async () => {
    if (!available) return;
    const scope = await fixture();
    const exactCatalog = catalog(scope);
    await persistAttemptToolCatalog(client.db, exactCatalog);
    await expect(
      submitCodemodeOperation(client.db, {
        ...scope,
        call: {
          ...codemodeCall(exactCatalog.digest),
          identity: { serverId: "docs", toolName: "missing" },
        },
      }),
    ).rejects.toBeInstanceOf(CodemodeToolNotInCatalogError);
  });

  test("recovers expired claims without ever replaying a crossed side-effect boundary", async () => {
    if (!available) return;
    const scope = await fixture();
    const exactCatalog = catalog(scope);
    await persistAttemptToolCatalog(client.db, exactCatalog);
    const startedAt = new Date("2026-08-09T12:00:00.000Z");

    const beforeBoundary = codemodeCall(exactCatalog.digest);
    await submitCodemodeOperation(client.db, {
      ...scope,
      call: beforeBoundary,
    });
    const abandonedClaimId = crypto.randomUUID();
    expect(
      (
        await claimCodemodeOperation(client.db, {
          ...scope,
          catalogDigest: exactCatalog.digest,
          operationId: beforeBoundary.operationId,
          claimId: abandonedClaimId,
          now: startedAt,
          claimLeaseMs: 1_000,
        })
      ).status,
    ).toBe("claimed");
    const recoveredClaimId = crypto.randomUUID();
    expect(
      await claimCodemodeOperation(client.db, {
        ...scope,
        catalogDigest: exactCatalog.digest,
        operationId: beforeBoundary.operationId,
        claimId: recoveredClaimId,
        now: new Date(startedAt.getTime() + 1_001),
        claimLeaseMs: 1_000,
      }),
    ).toMatchObject({ status: "claimed", reclaimed: true });
    expect(
      await markCodemodeOperationExecutionStarted(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
        operationId: beforeBoundary.operationId,
        claimId: abandonedClaimId,
      }),
    ).toBe(false);

    const afterBoundary = codemodeCall(exactCatalog.digest);
    await submitCodemodeOperation(client.db, {
      ...scope,
      call: afterBoundary,
    });
    const executingClaimId = crypto.randomUUID();
    await claimCodemodeOperation(client.db, {
      ...scope,
      catalogDigest: exactCatalog.digest,
      operationId: afterBoundary.operationId,
      claimId: executingClaimId,
      now: startedAt,
      claimLeaseMs: 1_000,
    });
    expect(
      await markCodemodeOperationExecutionStarted(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
        operationId: afterBoundary.operationId,
        claimId: executingClaimId,
        now: startedAt,
        claimLeaseMs: 1_000,
      }),
    ).toBe(true);
    const lostExecution = await claimCodemodeOperation(client.db, {
      ...scope,
      catalogDigest: exactCatalog.digest,
      operationId: afterBoundary.operationId,
      claimId: crypto.randomUUID(),
      now: new Date(startedAt.getTime() + 1_001),
      claimLeaseMs: 1_000,
    });
    expect(lostExecution).toMatchObject({
      status: "execution_owner_lost",
      claimId: executingClaimId,
      operation: {
        state: "running",
      },
    });
    expect(
      await getCodemodeOperation(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
        operationId: afterBoundary.operationId,
      }),
    ).toMatchObject({ state: "running", completedAt: null });
  });

  test("rejects human-approval tools before reserving execution", async () => {
    if (!available) return;
    const scope = await fixture();
    const exactCatalog = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        {
          identity: { serverId: "docs", toolName: "search" },
          modelName: "docs__search",
          inputSchema: { type: "object" },
          source: "docs",
          approval: "human",
          execute: async () => ({ content: [] }),
        },
      ],
    }).catalog;
    await persistAttemptToolCatalog(client.db, exactCatalog);
    await expect(
      submitCodemodeOperation(client.db, {
        ...scope,
        call: codemodeCall(exactCatalog.digest),
      }),
    ).rejects.toBeInstanceOf(CodemodeToolApprovalRequiredError);
    await expect(
      submitCodemodeOperation(client.db, {
        ...scope,
        call: codemodeCall(exactCatalog.digest),
      }),
    ).rejects.toBeInstanceOf(CodemodeToolApprovalRequiredError);
  });
});
