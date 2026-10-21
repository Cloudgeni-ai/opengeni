import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CancelledFailure } from "@temporalio/activity";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  isSessionCompactionRequested,
  listSessionEvents,
  recordStartedContextCompaction,
  requestSessionCompaction,
  withWorkspaceRls,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { CompactionProviderResponseError } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { SessionEvent } from "@opengeni/contracts";
import {
  isContextCompactionInterruption,
  settleContextCompactionInterruption,
} from "../src/activities/agent-turn/compaction-interruption";
import { TurnOperationCancelledError } from "../src/activities/agent-turn/sandbox-provision";

describe("context compaction interruption classification", () => {
  test("an aborted attempt signal classifies any compaction error as an interruption", () => {
    const controller = new AbortController();
    controller.abort(new CancelledFailure("WORKER_SHUTDOWN"));
    expect(isContextCompactionInterruption(new Error("socket hang up"), controller.signal)).toBe(
      true,
    );
    expect(
      isContextCompactionInterruption(
        new CompactionProviderResponseError({ status: 200 }),
        controller.signal,
      ),
    ).toBe(true);
  });

  test("typed turn cancellation errors are interruptions without a signal", () => {
    expect(
      isContextCompactionInterruption(
        new TurnOperationCancelledError(new CancelledFailure("WORKER_SHUTDOWN")),
        undefined,
      ),
    ).toBe(true);
    expect(isContextCompactionInterruption(new CancelledFailure("CANCELLED"), undefined)).toBe(
      true,
    );
  });

  test("message text never classifies an interruption", () => {
    const live = new AbortController().signal;
    const abortLike = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    expect(isContextCompactionInterruption(abortLike, live)).toBe(false);
    expect(isContextCompactionInterruption(new Error("cancelled"), undefined)).toBe(false);
    expect(isContextCompactionInterruption("worker shutdown", live)).toBe(false);
  });
});

describe("context compaction interruption landmark", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("context-compaction-interruption");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
    client = createDb(shared.appUrl);
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  async function startedCompaction() {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Compaction interruption",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Compaction interruption",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceRls(client.db, workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values({
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        position: 0,
        item: { type: "message", role: "assistant", content: "prior work ".repeat(200) },
      });
    });
    await requestSessionCompaction(client.db, workspaceId, session.id);
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("Expected a claimed compaction");
    const scope = {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      turnId: claimed.turn.id,
      executionGeneration: claimed.turn.executionGeneration,
      attemptId,
    };
    const started = await recordStartedContextCompaction(client.db, {
      ...scope,
      expectedExecutionGeneration: scope.executionGeneration,
      expectedAttemptId: scope.attemptId,
      trigger: "proactive",
      implementation: "responses_compaction_v2",
      estimatedTokensBefore: 291_549,
    });
    expect(started.recorded).toBe(true);
    return scope;
  }

  async function skippedEvents(scope: { workspaceId: string; sessionId: string }) {
    const events = await listSessionEvents(client.db, scope.workspaceId, scope.sessionId, {
      after: 0,
      limit: 100,
    });
    return events.filter((event) => event.type === "session.context.compaction.skipped");
  }

  test("records an interrupted skip, publishes it, and keeps the request pending", async () => {
    const scope = await startedCompaction();
    const published: SessionEvent[] = [];
    const warnings: string[] = [];

    await settleContextCompactionInterruption(client.db, scope, {
      publishLiveEvents: async (events) => {
        published.push(...events);
      },
      observability: { warn: (message) => warnings.push(message) },
    });

    const skipped = await skippedEvents(scope);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.payload).toEqual({ reason: "interrupted" });
    expect(skipped[0]!.payload).not.toHaveProperty("providerRejection");
    expect(published.map((event) => event.id)).toEqual([skipped[0]!.id]);
    expect(warnings).toEqual([]);
    // An interruption is not a terminal compaction outcome: the recovered
    // attempt of the same turn re-evaluates the still-pending request.
    expect(await isSessionCompactionRequested(client.db, scope.workspaceId, scope.sessionId)).toBe(
      true,
    );
  }, 60_000);

  test("a fenced attempt records nothing and does not throw", async () => {
    const scope = await startedCompaction();
    const published: SessionEvent[] = [];
    const warnings: string[] = [];

    await settleContextCompactionInterruption(
      client.db,
      { ...scope, attemptId: crypto.randomUUID() },
      {
        publishLiveEvents: async (events) => {
          published.push(...events);
        },
        observability: { warn: (message) => warnings.push(message) },
      },
    );

    expect(await skippedEvents(scope)).toEqual([]);
    expect(published).toEqual([]);
    expect(warnings).toEqual([]);
  }, 60_000);

  test("a landmark write failure is logged and never replaces the cancellation", async () => {
    const scope = await startedCompaction();
    const warnings: string[] = [];
    const broken = {
      transaction: () => {
        throw new Error("synthetic database outage");
      },
    } as unknown as Database;

    await settleContextCompactionInterruption(broken, scope, {
      observability: { warn: (message) => warnings.push(message) },
    });

    expect(warnings).toEqual(["context compaction interruption landmark was not recorded"]);
    expect(await skippedEvents(scope)).toEqual([]);
  }, 60_000);
});
