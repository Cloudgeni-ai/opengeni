import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AttemptToolCatalogIntegrityError, createAttemptToolEnvironment } from "@opengeni/codemode";
import type { AttemptToolCall, McpConnectionAccountBinding } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  getSessionTurn,
  settleSessionAttemptInterruptions,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  bindCodemodePreparation,
  requestSessionTurnRecovery,
  getToolActionReview,
  getToolReviewDetailsPage,
  prepareConnectorActionApproval,
  waitForCodemodeApproval,
  saveRunState,
  applySessionTurnSettlement,
  acceptSessionApprovalDecision,
  adoptCodemodeApproval,
  readTurnCodemodeOperation,
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
  appendSessionEventsForTurnAttempt,
  createConnection,
  encryptEnvironmentValue,
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

const fixtureSubjects = new Map<string, string>();
async function fixture(providerDomain?: string) {
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
  let bindings: McpConnectionAccountBinding[] | undefined;
  if (providerDomain) {
    const connection = await createConnection(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      providerDomain,
      kind: "oauth2",
      createdBySubjectId: grant.subjectId,
      credentialEncrypted: encryptEnvironmentValue(Buffer.alloc(32, 17), "fixture-only"),
    });
    bindings = [
      {
        serverId: "mail",
        canonicalServerId: "mail",
        connectionId: connection.id,
        originWorkspaceId: grant.workspaceId!,
        subjectScope: "workspace",
        ownerSubjectId: null,
        accountLabel: "mail@example.test",
        providerDomain,
        kind: "oauth2",
        connectionRef: {
          connectionId: connection.id,
          subjectScope: "workspace",
          providerDomain,
          kind: "oauth2",
        },
        connectionAuthorityGeneration: connection.connectionAuthorityGeneration ?? undefined,
      },
    ];
  }
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
    ...(bindings
      ? { mcpAccountBindings: bindings, tools: [{ kind: "mcp" as const, id: "mail" }] }
      : {}),
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
  fixtureSubjects.set(session.id, grant.subjectId);
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

describe("durable programmatic review", () => {
  for (const [provider, proof] of [
    ["gmailmcp.googleapis.com", true],
    ["mail.example.test", true],
    [undefined, true],
    ["gmailmcp.googleapis.com", false],
  ] as const) {
    test(`legacy reviews use immutable catalog/account proof: ${provider ?? "no binding"}${proof ? "" : ", no catalog"}`, async () => {
      if (!available) throw new Error("Real database is required");
      const scope = await fixture(provider);
      const turn = (await getSessionTurn(client.db, scope.workspaceId, scope.turnId))!;
      const approvalId = crypto.randomUUID();
      const args = {
        messageIds: ["synthetic-a", "synthetic-b"],
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
        privateNote: "hidden-by-schema",
      };
      const name = "opaque_wire_identity";
      const pending = [{ rawItem: { callId: approvalId, name, arguments: JSON.stringify(args) } }];
      const environment = createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions: [
          {
            identity: { serverId: "mail", toolName: "batch_modify_messages" },
            modelName: name,
            inputSchema: {
              type: "object",
              properties: { privateNote: { type: "string", writeOnly: true } },
            },
            source: "mcp",
            approval: "human",
            execute: () => ({ content: [] }),
          },
        ],
      });
      if (proof) await persistAttemptToolCatalog(client.db, environment.catalog);
      expect(
        await saveRunState(client.db, {
          ...scope,
          expectedExecutionGeneration: scope.executionGeneration,
          expectedAttemptId: scope.attemptId,
          serializedRunState: "{}",
          pendingApprovals: pending,
        }),
      ).toBe(true);
      const events = await appendSessionEventsForTurnAttempt(
        client.db,
        scope.workspaceId,
        scope.sessionId,
        scope.turnId,
        scope.executionGeneration,
        scope.attemptId,
        [
          {
            type: "agent.toolCall.created",
            payload: {
              id: approvalId,
              name,
              arguments: args,
              display: {
                toolName: "batch_modify_messages",
                accountLabel: "Untrusted display label Gmail",
              },
            },
          },
        ],
      );
      expect(events.accepted).toBe(true);
      await applySessionTurnSettlement(client.db, scope.workspaceId, {
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        attemptId: scope.attemptId,
        triggerEventId: turn.triggerEventId,
        turnStatus: "requires_action",
        sessionStatus: "requires_action",
        activeTurnId: scope.turnId,
        events: [{ type: "session.requiresAction", payload: { approvals: pending } }],
      });
      const input = { ...scope, approvalId };
      const review = await getToolActionReview(client.db, input);
      if (!proof) {
        // Without the catalog, schema-protected values cannot be identified: show
        // no argument value, offer no details, and let the person only decline.
        expect(review?.availableActions).toEqual(["reject"]);
        expect(review?.fields).toEqual([]);
        expect(review?.detailsAvailable).toBe(false);
        expect(JSON.stringify(review)).not.toContain("hidden-by-schema");
        expect(JSON.stringify(review)).not.toContain("synthetic-a");
        expect(
          await getToolReviewDetailsPage(client.db, {
            ...input,
            actionDigest: review!.actionDigest,
            path: "",
            offset: 0,
          }),
        ).toBeNull();
        expect(
          (
            await acceptSessionApprovalDecision(client.db, {
              accountId: scope.accountId,
              workspaceId: scope.workspaceId,
              sessionId: scope.sessionId,
              subjectId: "human:fixture",
              payload: { approvalId, decision: "reject" },
              clientEventId: crypto.randomUUID(),
            })
          ).action,
        ).toBe("accepted");
        return;
      }
      expect(review?.availableActions).toEqual(["approve", "reject"]);
      expect(review?.title).toBe(
        provider === "gmailmcp.googleapis.com" ? "Move 2 messages to Trash" : "Modify messages",
      );
      expect(review?.selectionCount).toBe(provider === "gmailmcp.googleapis.com" ? 2 : undefined);
      expect(JSON.stringify(review)).not.toContain("hidden-by-schema");
      if (provider) expect(review?.accountLabel).toBe("mail@example.test");
      const detail = await getToolReviewDetailsPage(client.db, {
        ...input,
        actionDigest: review!.actionDigest,
        path: "/messageIds",
        offset: 0,
      });
      expect(detail?.items.map((item) => item.value)).toEqual(["synthetic-a", "synthetic-b"]);
      expect(
        await getToolReviewDetailsPage(client.db, {
          ...input,
          actionDigest: "0".repeat(64),
          path: "",
          offset: 0,
        }),
      ).toBeNull();
      expect(
        await getToolActionReview(client.db, { ...input, accountId: crypto.randomUUID() }),
      ).toBeNull();
      expect(
        await getToolActionReview(client.db, { ...input, approvalId: crypto.randomUUID() }),
      ).toBeNull();
      const outcome = await acceptSessionApprovalDecision(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        subjectId: "human:fixture",
        payload: { approvalId, decision: "reject" },
        clientEventId: crypto.randomUUID(),
      });
      expect(outcome.action).toBe("accepted");
      expect(await getToolActionReview(client.db, input)).toMatchObject({
        status: "rejected",
        availableActions: [],
      });
    });
  }
  test("review facts and paginated details are bound to saved arguments and tenant", async () => {
    if (!available) throw new Error("Real database is required");
    const scope = await fixture();
    const turn = (await getSessionTurn(client.db, scope.workspaceId, scope.turnId))!;
    const approvalId = crypto.randomUUID();
    const args = {
      messageIds: Array.from({ length: 600 }, (_, i) => `synthetic-${i}`),
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX"],
      note: "a\u0000b",
      apiKey: "private-canary",
    };
    const prepared = await prepareConnectorActionApproval(
      client.db,
      { ...scope, initiator: turn.initiator },
      {
        approvalId,
        connectionId: "session-mcp:mail:synthetic",
        serverId: "mail",
        toolName: "batch_modify_messages",
        arguments: args,
        approvalMode: "session_mcp",
        reviewContext: { kind: "gmail", accountLabel: "mail@example.test" },
      },
    );
    if (!prepared.managed) throw new Error("Expected review");
    const input = { ...scope, approvalId };
    const review = await getToolActionReview(client.db, input);
    expect(review).toMatchObject({
      title: "Move 600 messages to Trash",
      selectionCount: 600,
      accountLabel: "mail@example.test",
      actionDigest: prepared.actionFingerprint,
      availableActions: [],
    });
    expect(JSON.stringify(review)).not.toContain("private-canary");
    const page = await getToolReviewDetailsPage(client.db, {
      ...input,
      actionDigest: prepared.actionFingerprint,
      path: "/messageIds",
      offset: 575,
    });
    expect(page).toMatchObject({ total: 600, nextOffset: null });
    expect(page!.items).toHaveLength(25);
    expect(page!.items[24]!.value).toBe("synthetic-599");
    const text = await getToolReviewDetailsPage(client.db, {
      ...input,
      actionDigest: prepared.actionFingerprint,
      path: "/note",
      offset: 0,
    });
    expect(text!.items[0]!.value).toBe("a\u0000b");
    expect(
      await getToolReviewDetailsPage(client.db, {
        ...input,
        actionDigest: "0".repeat(64),
        path: "",
        offset: 0,
      }),
    ).toBeNull();
    expect(
      await getToolActionReview(client.db, { ...input, accountId: crypto.randomUUID() }),
    ).toBeNull();
    await applySessionTurnSettlement(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      triggerEventId: turn.triggerEventId,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: scope.turnId,
      events: [],
    });
    expect(await getToolActionReview(client.db, input)).toMatchObject({
      availableActions: ["approve", "reject"],
    });
  });
  for (const crash of ["before_review", "after_review", "after_effect_start"] as const) {
    test(`recovers without replay after crash ${crash}`, async () => {
      if (!available) throw new Error("Real database is required");
      const original = await fixture();
      const turn = (await getSessionTurn(client.db, original.workspaceId, original.turnId))!;
      const definitions = [
        {
          identity: { serverId: "mail", toolName: "change" },
          modelName: "mail__change",
          inputSchema: { type: "object" },
          source: "mcp" as const,
          approval: "policy" as const,
          execute: () => ({ content: [] }),
        },
      ];
      const environment = createAttemptToolEnvironment({
        scope: original,
        generation: 1,
        definitions,
      });
      await persistAttemptToolCatalog(client.db, environment.catalog);
      const operationId = crypto.randomUUID(),
        claimId = crypto.randomUUID();
      const call = {
        operationId,
        catalogDigest: environment.catalog.digest,
        identity: definitions[0]!.identity,
        arguments: { ids: ["synthetic-message"] },
        caller: { kind: "codemode" as const, subjectId: `sandbox:${original.attemptId}` },
      };
      await submitCodemodeOperation(client.db, { ...original, call, durableApproval: true });
      expect(
        await claimCodemodeOperation(client.db, {
          ...original,
          operationId,
          claimId,
          catalogDigest: call.catalogDigest,
        }),
      ).toMatchObject({ status: "claimed" });
      const effectDigest = environment.effectDigest(call.identity);
      expect(
        await bindCodemodePreparation(client.db, {
          ...original,
          operationId,
          claimId,
          effectDigest,
        }),
      ).toBe(true);
      if (crash === "after_review") {
        const request = await prepareConnectorActionApproval(
          client.db,
          { ...original, initiator: turn.initiator },
          {
            approvalId: operationId,
            connectionId: "session-mcp:mail:synthetic",
            serverId: "mail",
            toolName: "change",
            arguments: call.arguments,
            approvalMode: "session_mcp",
          },
        );
        expect(request).toMatchObject({ managed: true, approvalStatus: "pending" });
      }
      if (crash === "after_effect_start")
        expect(
          await markCodemodeOperationExecutionStarted(client.db, {
            ...original,
            operationId,
            claimId,
          }),
        ).toBe(true);
      expect(
        await requestSessionTurnRecovery(client.db, original.workspaceId, {
          sessionId: original.sessionId,
          turnId: original.turnId,
          attemptId: original.attemptId,
          triggerEventId: turn.triggerEventId,
          reason: "worker_restart",
        }),
      ).toMatchObject({ action: "recovering" });
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client.db, original.workspaceId, {
        sessionId: original.sessionId,
        workflowId: `session-${original.sessionId}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId,
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error(`Recovery not claimed: ${claimed.reason}`);
      const current = {
        ...original,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
      };
      const next = createAttemptToolEnvironment({ scope: current, generation: 1, definitions });
      await persistAttemptToolCatalog(client.db, next.catalog);
      const adopted = await adoptCodemodeApproval(client.db, {
        ...current,
        operationId,
        callerSubjectId: `sandbox:${attemptId}`,
        catalogDigest: next.catalog.digest,
        effectDigest,
      });
      expect(adopted).toMatchObject({
        state:
          crash === "after_effect_start"
            ? "outcome_unknown"
            : crash === "after_review"
              ? "waiting_for_approval"
              : "queued",
        attemptId: original.attemptId,
        catalogDigest: environment.catalog.digest,
        arguments: call.arguments,
      });
      expect(
        await completeCodemodeOperation(client.db, {
          ...original,
          operationId,
          claimId,
          result: { content: [] },
        }),
      ).toBe(false);
      expect(
        await markCodemodeOperationExecutionStarted(client.db, {
          ...original,
          operationId,
          claimId,
        }),
      ).toBe(false);
    });
  }
  for (const outcome of ["approve", "reject", "stale"] as const) {
    test(`preserves origin and fences continuation: ${outcome}`, async () => {
      if (!available) throw new Error("Real database is required");
      const original = await fixture();
      const turn = (await getSessionTurn(client.db, original.workspaceId, original.turnId))!;
      const environment = createAttemptToolEnvironment({
        scope: original,
        generation: 1,
        definitions: [
          {
            identity: { serverId: "mail", toolName: "change" },
            modelName: "mail__change",
            inputSchema: { type: "object" },
            source: "mcp",
            approval: "policy",
            execute: () => ({ content: [] }),
          },
        ],
      });
      await persistAttemptToolCatalog(client.db, environment.catalog);
      const operationId = crypto.randomUUID(),
        claimId = crypto.randomUUID();
      const call = {
        operationId,
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "mail", toolName: "change" },
        arguments: { ids: ["synthetic-message"] },
        caller: { kind: "codemode" as const, subjectId: `sandbox:${original.attemptId}` },
      };
      const submitted = await submitCodemodeOperation(client.db, {
        ...original,
        call,
        durableApproval: true,
      });
      expect(submitted.operation.durableApproval).toBe(true);
      expect(
        await claimCodemodeOperation(client.db, {
          ...original,
          operationId,
          claimId,
          catalogDigest: environment.catalog.digest,
        }),
      ).toMatchObject({ status: "claimed" });
      const preparation = await prepareConnectorActionApproval(
        client.db,
        { ...original, initiator: turn.initiator },
        {
          approvalId: operationId,
          connectionId: "session-mcp:mail:synthetic",
          serverId: "mail",
          toolName: "change",
          arguments: call.arguments,
          approvalMode: "session_mcp",
        },
      );
      if (!preparation.managed || !preparation.requestId) throw new Error("Expected exact review");
      const effectDigest = environment.effectDigest(call.identity);
      expect(
        await waitForCodemodeApproval(client.db, {
          ...original,
          operationId,
          claimId,
          requestId: preparation.requestId,
          actionFingerprint: preparation.actionFingerprint,
          effectDigest,
        }),
      ).toBe(true);
      expect(await getCodemodeOperation(client.db, { ...original, operationId })).toMatchObject({
        state: "waiting_for_approval",
        executionStartedAt: null,
        claimedAt: null,
      });
      expect(
        await markCodemodeOperationExecutionStarted(client.db, {
          ...original,
          operationId,
          claimId,
        }),
      ).toBe(false);
      await saveRunState(client.db, {
        ...original,
        expectedExecutionGeneration: original.executionGeneration,
        expectedAttemptId: original.attemptId,
        serializedRunState: "{}",
        pendingApprovals: [{ id: operationId, source: "codemode" }],
      });
      await applySessionTurnSettlement(client.db, original.workspaceId, {
        sessionId: original.sessionId,
        turnId: original.turnId,
        triggerEventId: turn.triggerEventId,
        attemptId: original.attemptId,
        turnStatus: "requires_action",
        sessionStatus: "requires_action",
        activeTurnId: original.turnId,
        events: [],
      });
      const clientEventId = crypto.randomUUID();
      const decisionInput = {
        accountId: original.accountId,
        workspaceId: original.workspaceId,
        sessionId: original.sessionId,
        subjectId: "human:fixture",
        payload: { approvalId: operationId, decision: outcome === "reject" ? "reject" : "approve" },
        clientEventId,
      };
      const decision = await acceptSessionApprovalDecision(client.db, decisionInput);
      if (decision.action !== "accepted") throw new Error("Review was not accepted");
      const duplicate = await acceptSessionApprovalDecision(client.db, decisionInput);
      expect(duplicate.action).toBe("accepted");
      if (duplicate.action === "accepted") expect(duplicate.event.id).toBe(decision.event.id);
      const attemptId = crypto.randomUUID();
      const resumed = await claimSessionWorkForAttempt(client.db, original.workspaceId, {
        sessionId: original.sessionId,
        workflowId: `session-${original.sessionId}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId,
        trigger: { kind: "approval", triggerEventId: decision.event.id },
      });
      if (resumed.action !== "claimed") throw new Error("Resume not claimed");
      const current = {
        ...original,
        attemptId,
        executionGeneration: resumed.turn.executionGeneration,
      };
      const nextEnvironment = createAttemptToolEnvironment({
        scope: current,
        generation: 1,
        definitions: [
          {
            identity: call.identity,
            modelName: "mail__change",
            inputSchema: { type: "object" },
            source: "mcp",
            approval: "policy",
            execute: () => ({ content: [] }),
          },
          {
            identity: { serverId: "mail", toolName: "unrelated" },
            modelName: "mail__unrelated",
            inputSchema: { type: "object" },
            source: "mcp",
            approval: "none",
            execute: () => ({ content: [] }),
          },
        ],
      });
      await persistAttemptToolCatalog(client.db, nextEnvironment.catalog);
      expect(nextEnvironment.effectDigest(call.identity)).toBe(effectDigest);
      const continuation = {
        ...current,
        operationId,
        callerSubjectId: `sandbox:${attemptId}`,
        catalogDigest: nextEnvironment.catalog.digest,
        effectDigest: outcome === "stale" ? "0".repeat(64) : effectDigest,
      };
      expect(
        await adoptCodemodeApproval(client.db, {
          ...continuation,
          callerSubjectId: "different-caller",
        }),
      ).toBeNull();
      const adopted = await adoptCodemodeApproval(client.db, continuation);
      expect(adopted).toMatchObject({
        state: outcome === "approve" ? "queued" : "cancelled",
        attemptId: original.attemptId,
        catalogDigest: environment.catalog.digest,
        executionStartedAt: null,
      });
      expect(await readTurnCodemodeOperation(client.db, continuation)).toMatchObject({
        operationId,
      });
      await expect(
        readTurnCodemodeOperation(client.db, {
          ...original,
          operationId,
          callerSubjectId: call.caller.subjectId,
        }),
      ).rejects.toThrow("active running");
      expect(
        await claimCodemodeOperation(client.db, {
          ...original,
          operationId,
          claimId: crypto.randomUUID(),
          catalogDigest: environment.catalog.digest,
        }),
      ).toMatchObject({ status: "rejected" });
      if (outcome === "approve") {
        const nextClaimId = crypto.randomUUID();
        const claim = {
          ...current,
          operationId,
          claimId: nextClaimId,
          catalogDigest: nextEnvironment.catalog.digest,
        };
        const claims = await Promise.all([
          claimCodemodeOperation(client.db, claim),
          claimCodemodeOperation(client.db, { ...claim, claimId: crypto.randomUUID() }),
        ]);
        expect(claims.filter((value) => value.status === "claimed")).toHaveLength(1);
        expect(claims.filter((value) => value.status === "already_running")).toHaveLength(1);
        const winner = claims.find((value) => value.status === "claimed")!;
        if (winner.status !== "claimed") throw new Error("No winner");
        expect(
          await markCodemodeOperationExecutionStarted(client.db, {
            ...current,
            operationId,
            claimId: winner.claimId,
          }),
        ).toBe(true);
        expect(
          await completeCodemodeOperation(client.db, {
            ...current,
            operationId,
            claimId: winner.claimId,
            result: { content: [{ type: "text", text: "Synthetic effect completed" }] },
          }),
        ).toBe(true);
      }
    });
  }
});

for (const [control, started] of [
  ["pause", false],
  ["cancel", false],
  ["workspace_pause", false],
  ["steer", false],
  ["cancel", true],
] as const) {
  test(`programmatic admission and effect boundary obey canonical ${control}${started ? " after execution starts" : ""}`, async () => {
    if (!available) throw new Error("Real database is required");
    const scope = await fixture(),
      exactCatalog = catalog(scope);
    const subjectId = fixtureSubjects.get(scope.sessionId)!;
    await persistAttemptToolCatalog(client.db, exactCatalog);
    const call = codemodeCall(exactCatalog.digest),
      claimId = crypto.randomUUID();
    await submitCodemodeOperation(client.db, { ...scope, call, durableApproval: true });
    expect(
      await claimCodemodeOperation(client.db, {
        ...scope,
        operationId: call.operationId,
        claimId,
        catalogDigest: call.catalogDigest,
      }),
    ).toMatchObject({ status: "claimed" });
    if (started)
      expect(
        await markCodemodeOperationExecutionStarted(client.db, {
          ...scope,
          operationId: call.operationId,
          claimId,
        }),
      ).toBe(true);
    if (control === "steer") {
      await withWorkspaceSubjectSessionActivityRls(client.db, scope.workspaceId, subjectId, (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            ...scope,
            subjectId,
            actor: { type: "human", subjectId: subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "steer",
            text: "Use a new direction",
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
      );
    } else {
      await withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
        db.transaction(async (tx) => {
          if (control === "workspace_pause")
            await mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
              accountId: scope.accountId,
              workspaceId: scope.workspaceId,
              actor: { type: "human", subjectId: subjectId },
              operationKey: crypto.randomUUID(),
              action: "pause",
              reason: "fixture",
            });
          else
            await mutateSessionControlInTransaction(tx as unknown as typeof db, {
              ...scope,
              actor: { type: "human", subjectId: subjectId },
              operationKey: crypto.randomUUID(),
              action: control,
            });
        }),
      );
    }
    expect(
      await markCodemodeOperationExecutionStarted(client.db, {
        ...scope,
        operationId: call.operationId,
        claimId,
      }),
    ).toBe(false);
    await expect(
      submitCodemodeOperation(client.db, {
        ...scope,
        call: codemodeCall(exactCatalog.digest),
        durableApproval: true,
      }),
    ).rejects.toThrow("active running");
    await expect(
      bindCodemodePreparation(client.db, {
        ...scope,
        operationId: call.operationId,
        claimId,
        effectDigest: "1".repeat(64),
      }),
    ).rejects.toThrow("active running");
    await expect(
      adoptCodemodeApproval(client.db, {
        ...scope,
        operationId: call.operationId,
        callerSubjectId: call.caller.subjectId,
        catalogDigest: call.catalogDigest,
        effectDigest: "1".repeat(64),
      }),
    ).rejects.toThrow("active running");
    if (control === "cancel") {
      await settleSessionAttemptInterruptions(
        client.db,
        scope.workspaceId,
        scope.sessionId,
        scope.attemptId,
      );
    }
    expect(
      await getCodemodeOperation(client.db, { ...scope, operationId: call.operationId }),
    ).toMatchObject({
      executionStartedAt: started ? expect.any(String) : null,
      ...(control === "cancel" ? { state: started ? "outcome_unknown" : "cancelled" } : {}),
    });
  }, 30_000);
}
