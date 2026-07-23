import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { HostEventExportBatch, HostUsageExportBatch } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acknowledgeHostExportBatch,
  appendSessionEvents,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  claimHostExportBatch,
  createDb,
  createSession,
  deadLetterHostExportHead,
  failHostExportBatch,
  getHostExportConsumerStatus,
  initializeSessionStartAtomically,
  pruneHostExportOutbox,
  recordUsageEvent,
  registerHostExportConsumer,
  retireHostExportConsumer,
  resumeHostExportConsumer,
  type HostExportKind,
} from "../src/index";
import postgres from "postgres";

let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
let exporter: ReturnType<typeof createDb>;

setDefaultTimeout(180_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-export");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  app = createDb(shared.appUrl);
  exporter = createDb(shared.adminUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([app?.close(), exporter?.close()]);
  await shared?.release();
});

async function createStartedSession(label: string) {
  const subjectId = `subject:${label}:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "host-export-test",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Host export ${label}`,
    workspaceExternalSource: "host-export-test",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Host export ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: `initial ${label}`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId, label: `User ${label}` },
    createdByContext: { label: `User ${label}` },
  });
  const started = await initializeSessionStartAtomically(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  if (!started.turn) throw new Error("session did not create an initial turn");
  return { grant, session, turn: started.turn, started, subjectId };
}

function claim(
  kind: "session_event",
  consumerId: string,
  options?: { limit?: number; leaseToken?: string },
): Promise<HostEventExportBatch | null>;
function claim(
  kind: "usage_event",
  consumerId: string,
  options?: { limit?: number; leaseToken?: string },
): Promise<HostUsageExportBatch | null>;
async function claim(
  kind: HostExportKind,
  consumerId: string,
  options: { limit?: number; leaseToken?: string } = {},
): Promise<HostEventExportBatch | HostUsageExportBatch | null> {
  const common = {
    consumerId,
    leaseToken: options.leaseToken ?? crypto.randomUUID(),
    leaseHolderId: `test-${crypto.randomUUID()}`,
    leaseSeconds: 30,
    limit: options.limit ?? 256,
    maxBytes: 4_194_304,
  };
  return kind === "session_event"
    ? await claimHostExportBatch(exporter.db, { kind, ...common })
    : await claimHostExportBatch(exporter.db, { kind, ...common });
}

describe("durable host export (real PostgreSQL)", () => {
  test("exports bounded exact facts with ordered at-least-once checkpoints", async () => {
    const disabled = await createStartedSession("disabled");
    const [disabledCount] = await shared.admin<Array<{ count: string }>>`
      select count(*)::text as count from host_export_outbox
      where workspace_id = ${disabled.grant.workspaceId!}`;
    expect(disabledCount?.count).toBe("0");

    await expect(
      registerHostExportConsumer(app.db, {
        kind: "session_event",
        consumerId: "host-test-events",
      }),
    ).rejects.toThrow();

    await registerHostExportConsumer(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
    });
    await registerHostExportConsumer(exporter.db, {
      kind: "usage_event",
      consumerId: "host-test-usage",
    });

    const active = await createStartedSession("active");
    const [delta, completed] = await appendSessionEvents(
      app.db,
      active.grant.workspaceId!,
      active.session.id,
      [
        {
          type: "agent.message.delta",
          payload: { text: "not exported" },
          turnId: active.turn.id,
        },
        {
          type: "agent.message.completed",
          payload: { text: "exported" },
          turnId: active.turn.id,
        },
      ],
    );
    await recordUsageEvent(app.db, {
      accountId: active.grant.accountId,
      workspaceId: active.grant.workspaceId!,
      subjectId: active.subjectId,
      eventType: "model.tokens",
      quantity: 42,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: `${active.turn.id}:one`,
      sessionId: active.session.id,
      turnId: active.turn.id,
      idempotencyKey: `usage:test:${active.turn.id}`,
    });
    const child = await createSession(app.db, {
      accountId: active.grant.accountId,
      workspaceId: active.grant.workspaceId!,
      initialMessage: "child work",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: active.session.id,
      createdBy: { kind: "subject", subjectId: active.subjectId },
    });
    const childStarted = await initializeSessionStartAtomically(app.db, {
      accountId: active.grant.accountId,
      workspaceId: active.grant.workspaceId!,
      sessionId: child.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    const [childCompleted, childSecondCompleted] = await appendSessionEvents(
      app.db,
      active.grant.workspaceId!,
      child.id,
      [
        {
          type: "agent.message.completed",
          payload: { text: "child exported" },
          turnId: childStarted.turn!.id,
        },
        {
          type: "agent.message.completed",
          payload: { text: "second child export" },
          turnId: childStarted.turn!.id,
        },
      ],
    );
    await recordUsageEvent(app.db, {
      accountId: active.grant.accountId,
      workspaceId: active.grant.workspaceId!,
      subjectId: active.subjectId,
      eventType: "model.tokens",
      quantity: 7,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: `${childStarted.turn!.id}:one`,
      sessionId: child.id,
      turnId: childStarted.turn!.id,
      idempotencyKey: `usage:test:${childStarted.turn!.id}`,
    });

    const eventBatch = await claim("session_event", "host-test-events");
    expect(eventBatch?.events.length).toBeGreaterThan(0);
    expect(eventBatch?.events.some((item) => item.event.id === delta?.id)).toBe(false);
    const completedExport = eventBatch?.events.find((item) => item.event.id === completed?.id);
    expect(completedExport?.event.payload).toEqual({ text: "exported" });
    expect(completedExport?.event.turnId).toBe(active.turn.id);
    expect(completedExport?.rootSessionId).toBe(active.session.id);
    expect(completedExport?.origin).toBe("user");
    expect(completedExport?.initiator).toEqual({
      kind: "subject",
      subjectId: active.subjectId,
      label: "User active",
    });
    const createdExport = eventBatch?.events.find((item) => item.event.type === "session.created");
    expect(createdExport?.origin).toBeNull();
    expect(createdExport?.initiator?.subjectId).toBe(active.subjectId);
    const childExport = eventBatch?.events.find((item) => item.event.id === childCompleted?.id);
    expect(childExport?.event.sessionId).toBe(child.id);
    expect(childExport?.rootSessionId).toBe(active.session.id);
    const secondChildExport = eventBatch?.events.find(
      (item) => item.event.id === childSecondCompleted?.id,
    );
    expect(secondChildExport?.event.sessionId).toBe(child.id);
    expect(secondChildExport?.rootSessionId).toBe(active.session.id);
    expect(
      eventBatch?.events.every(
        (item, index, items) =>
          index === 0 || BigInt(item.cursor) > BigInt(items[index - 1]!.cursor),
      ),
    ).toBe(true);
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
      leaseToken: eventBatch!.leaseToken,
    });

    const usageBatch = await claim("usage_event", "host-test-usage");
    expect(usageBatch?.events).toHaveLength(2);
    const rootUsage = usageBatch?.events.find((item) => item.sessionId === active.session.id);
    expect(rootUsage?.usage.quantity).toBe(42);
    expect(rootUsage?.rootSessionId).toBe(active.session.id);
    expect(rootUsage?.turnId).toBe(active.turn.id);
    expect(rootUsage?.initiator?.subjectId).toBe(active.subjectId);
    const childUsage = usageBatch?.events.find((item) => item.sessionId === child.id);
    expect(childUsage?.usage.quantity).toBe(7);
    expect(childUsage?.rootSessionId).toBe(active.session.id);
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "usage_event",
      consumerId: "host-test-usage",
      leaseToken: usageBatch!.leaseToken,
    });

    const [futureEvent] = await appendSessionEvents(
      app.db,
      active.grant.workspaceId!,
      active.session.id,
      [
        {
          type: "future.semantic.event" as never,
          payload: { forwardCompatible: true },
          turnId: active.turn.id,
        },
      ],
    );
    // Simulate a newer rolling writer adding a bounded association value after
    // this build's closed application enum. The host wire must still carry it.
    await shared.admin`
      update host_export_outbox set turn_association = 'future_association'
      where export_kind = 'session_event' and source_id = ${futureEvent!.id}::uuid`;
    const futureBatch = await claim("session_event", "host-test-events");
    const futureExport = futureBatch?.events.find((item) => item.event.id === futureEvent!.id);
    expect(futureExport?.event.type).toBe("future.semantic.event");
    expect(futureExport?.event.turnAssociation).toBe("future_association");
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
      leaseToken: futureBatch!.leaseToken,
    });

    const foreignSession = await createSession(app.db, {
      accountId: active.grant.accountId,
      workspaceId: active.grant.workspaceId!,
      initialMessage: "foreign turn",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const foreignStarted = await initializeSessionStartAtomically(app.db, {
      accountId: active.grant.accountId,
      workspaceId: active.grant.workspaceId!,
      sessionId: foreignSession.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    await expect(
      recordUsageEvent(app.db, {
        accountId: active.grant.accountId,
        workspaceId: active.grant.workspaceId!,
        eventType: "agent_run.completed",
        quantity: 1,
        unit: "run",
        sourceResourceType: "session_turn",
        sourceResourceId: foreignStarted.turn!.id,
        sessionId: active.session.id,
        turnId: foreignStarted.turn!.id,
        idempotencyKey: `usage:mismatched:${foreignStarted.turn!.id}`,
      }),
    ).rejects.toThrow();

    const delayed = await createStartedSession("delayed-a");
    const fast = await createStartedSession("fast-b");
    const setupBatch = await claim("session_event", "host-test-events");
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
      leaseToken: setupBatch!.leaseToken,
    });

    const delayedSql = postgres(shared.appUrl, { max: 1, prepare: false });
    let releaseDelayed!: () => void;
    let markDelayedReady!: () => void;
    const delayedGate = new Promise<void>((resolve) => {
      releaseDelayed = resolve;
    });
    const delayedReady = new Promise<void>((resolve) => {
      markDelayedReady = resolve;
    });
    const delayedEventId = crypto.randomUUID();
    const delayedCommit = delayedSql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${delayed.grant.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${delayed.grant.workspaceId!}, true)`;
      const [sequence] = await tx<Array<{ value: number }>>`
        update sessions set last_sequence = last_sequence + 1
        where workspace_id = ${delayed.grant.workspaceId!} and id = ${delayed.session.id}
        returning last_sequence as value`;
      await tx`
        insert into session_events (
          id, account_id, workspace_id, session_id, sequence, type, payload
        ) values (
          ${delayedEventId}, ${delayed.grant.accountId}, ${delayed.grant.workspaceId!},
          ${delayed.session.id}, ${sequence!.value}, 'agent.message.completed',
          ${tx.json({ text: "delayed commit" })}
        )`;
      markDelayedReady();
      await delayedGate;
    });
    await delayedReady;
    const [fastEvent] = await appendSessionEvents(
      app.db,
      fast.grant.workspaceId!,
      fast.session.id,
      [{ type: "agent.message.completed", payload: { text: "fast commit" } }],
    );
    const fastBatch = await claim("session_event", "host-test-events", {
      limit: 1,
    });
    expect(fastBatch?.events[0]?.event.id).toBe(fastEvent?.id);
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
      leaseToken: fastBatch!.leaseToken,
    });
    releaseDelayed();
    await delayedCommit;
    await delayedSql.end();
    const delayedBatch = await claim("session_event", "host-test-events", {
      limit: 1,
    });
    expect(delayedBatch?.events[0]?.event.id).toBe(delayedEventId);
    expect(BigInt(delayedBatch!.events[0]!.cursor)).toBeGreaterThan(
      BigInt(fastBatch!.events[0]!.cursor),
    );
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
      leaseToken: delayedBatch!.leaseToken,
    });

    const [orderedFirst, orderedSecond] = await appendSessionEvents(
      app.db,
      delayed.grant.workspaceId!,
      delayed.session.id,
      [
        {
          type: "agent.message.completed",
          payload: { text: "sequence first" },
        },
        {
          type: "agent.message.completed",
          payload: { text: "sequence second" },
        },
      ],
    );
    await shared.admin`
      update host_export_outbox
      set enqueued_at = case
        when source_id = ${orderedFirst!.id}::uuid then now() + interval '1 hour'
        else now() - interval '1 hour'
      end
      where export_kind = 'session_event'
        and source_id in (${orderedFirst!.id}::uuid, ${orderedSecond!.id}::uuid)`;
    const orderedBatch = await claim("session_event", "host-test-events", {
      limit: 2,
    });
    expect(orderedBatch?.events.map((item) => item.event.id)).toEqual([
      orderedFirst!.id,
      orderedSecond!.id,
    ]);
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
      leaseToken: orderedBatch!.leaseToken,
    });

    const [redeliverySource] = await appendSessionEvents(
      app.db,
      active.grant.workspaceId!,
      active.session.id,
      [
        {
          type: "agent.message.completed",
          payload: { text: "redeliver me" },
          turnId: active.turn.id,
        },
      ],
    );
    const firstLease = await claim("session_event", "host-test-events", {
      limit: 1,
    });
    expect(firstLease?.events[0]?.event.id).toBe(redeliverySource?.id);
    const concurrentLease = await claim("session_event", "host-test-events", {
      limit: 1,
    });
    expect(concurrentLease).toBeNull();
    await shared.admin`
      update host_export_consumers set lease_expires_at = now() - interval '1 second'
      where export_kind = 'session_event' and consumer_id = 'host-test-events'`;
    const secondLease = await claim("session_event", "host-test-events", {
      limit: 1,
    });
    expect(secondLease?.events[0]?.idempotencyKey).toBe(firstLease?.events[0]?.idempotencyKey);
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
      leaseToken: secondLease!.leaseToken,
    });
    await expect(
      acknowledgeHostExportBatch(exporter.db, {
        kind: "session_event",
        consumerId: "host-test-events",
        leaseToken: firstLease!.leaseToken,
      }),
    ).rejects.toThrow();

    await appendSessionEvents(app.db, active.grant.workspaceId!, active.session.id, [
      {
        type: "agent.message.completed",
        payload: { text: "block once" },
        turnId: active.turn.id,
      },
    ]);
    const failedLease = await claim("session_event", "host-test-events", {
      limit: 1,
    });
    expect(
      await failHostExportBatch(exporter.db, {
        kind: "session_event",
        consumerId: "host-test-events",
        leaseToken: failedLease!.leaseToken,
        error: "host unavailable",
        maxFailures: 1,
      }),
    ).toBe(1);
    expect(
      (
        await getHostExportConsumerStatus(exporter.db, {
          kind: "session_event",
          consumerId: "host-test-events",
        })
      )?.blockedAt,
    ).not.toBeNull();
    expect(await claim("session_event", "host-test-events", { limit: 1 })).toBeNull();
    await resumeHostExportConsumer(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
    });
    const poisonLease = await claim("session_event", "host-test-events", {
      limit: 1,
    });
    const poison = poisonLease!.events[0]!;
    expect(
      await deadLetterHostExportHead(exporter.db, {
        kind: "session_event",
        consumerId: "host-test-events",
        leaseToken: poisonLease!.leaseToken,
        cursor: poison.cursor,
        reason: "explicit test disposition",
      }),
    ).toBe(poison.cursor);
    const [deadLetter] = await shared.admin<Array<{ sourceId: string }>>`
      select source_id as "sourceId" from host_export_dead_letters
      where export_kind = 'session_event' and consumer_id = 'host-test-events'
        and export_cursor = ${poison.cursor}::bigint`;
    expect(deadLetter?.sourceId).toBe(poison.event.id);

    const deletable = await createStartedSession("delete-with-attempt-usage");
    const deleteAttemptId = crypto.randomUUID();
    const deleteClaim = await claimSessionWorkForAttempt(app.db, deletable.grant.workspaceId!, {
      sessionId: deletable.session.id,
      workflowId: `session-${deletable.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: deleteAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(deleteClaim.action).toBe("claimed");
    if (deleteClaim.action !== "claimed") throw new Error("deletion fixture was not claimed");
    const deleteUsage = await recordUsageEvent(app.db, {
      accountId: deletable.grant.accountId,
      workspaceId: deletable.grant.workspaceId!,
      eventType: "model.tokens",
      quantity: 7,
      unit: "tokens",
      sessionId: deletable.session.id,
      turnId: deleteClaim.turn.id,
      turnAttemptId: deleteAttemptId,
      idempotencyKey: `usage:delete:${deleteAttemptId}`,
    });
    await shared.admin`delete from workspaces where id = ${deletable.grant.workspaceId!}`;
    const [retainedUsage] = await shared.admin<Array<{ count: string }>>`
      select count(*)::text as count from host_export_outbox
      where export_kind = 'usage_event' and source_id = ${deleteUsage.id}::uuid`;
    expect(retainedUsage?.count).toBe("1");

    const retained = await appendSessionEvents(
      app.db,
      active.grant.workspaceId!,
      active.session.id,
      [
        {
          type: "agent.message.completed",
          payload: { text: "survive delete" },
        },
      ],
    );
    await shared.admin`delete from workspaces where id = ${active.grant.workspaceId!}`;
    const [retainedOutbox] = await shared.admin<Array<{ count: string }>>`
      select count(*)::text as count from host_export_outbox
      where export_kind = 'session_event' and source_id = ${retained[0]!.id}::uuid`;
    expect(retainedOutbox?.count).toBe("1");

    const retainedBatch = await claim("session_event", "host-test-events");
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
      leaseToken: retainedBatch!.leaseToken,
    });
    expect(
      await pruneHostExportOutbox(exporter.db, {
        kind: "session_event",
        graceSeconds: 0,
        limit: 10_000,
      }),
    ).toBeGreaterThan(0);
    const originalStatus = await getHostExportConsumerStatus(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
    });
    await registerHostExportConsumer(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-after-prune",
    });
    const postPrune = await getHostExportConsumerStatus(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-after-prune",
    });
    expect(postPrune?.checkpoint).toBe(originalStatus?.prunedThrough);
    expect(postPrune?.pendingCount).toBe("0");

    const retirement = await createStartedSession("consumer-retirement");
    await appendSessionEvents(app.db, retirement.grant.workspaceId!, retirement.session.id, [
      {
        type: "agent.message.completed",
        payload: { text: "retirement floor" },
      },
    ]);
    const retirementBatch = await claim("session_event", "host-test-events");
    await acknowledgeHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-events",
      leaseToken: retirementBatch!.leaseToken,
    });
    expect(
      await pruneHostExportOutbox(exporter.db, {
        kind: "session_event",
        graceSeconds: 0,
        limit: 10_000,
      }),
    ).toBe(0);
    await retireHostExportConsumer(exporter.db, {
      kind: "session_event",
      consumerId: "host-test-after-prune",
    });
    expect(
      await getHostExportConsumerStatus(exporter.db, {
        kind: "session_event",
        consumerId: "host-test-after-prune",
      }),
    ).toBeNull();
    expect(
      await pruneHostExportOutbox(exporter.db, {
        kind: "session_event",
        graceSeconds: 0,
        limit: 10_000,
      }),
    ).toBeGreaterThan(0);
  });
});
