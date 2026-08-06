import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { HostEventExportBatch } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  claimHostExportBatch,
  createDb,
  createSession,
  deadLetterHostExportHead,
  getHostExportConsumerStatus,
  HostExportPayloadError,
  initializeSessionStartAtomically,
  LOSSLESS_TEXT_PREFIX,
  resumeHostExportConsumer,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createObservability } from "@opengeni/observability";
import { createHostExportPump } from "../src/host-export-pump";

let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
let exporter: ReturnType<typeof createDb>;

setDefaultTimeout(180_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-export-pump");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  app = createDb(shared.appUrl);
  exporter = createDb(shared.adminUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([app?.close(), exporter?.close()]);
  await shared?.release();
});

async function fixture(label: string) {
  const subjectId = `subject:${label}:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "host-export-pump",
    accountExternalId: `account:${crypto.randomUUID()}`,
    accountName: "Host export pump",
    workspaceExternalSource: "host-export-pump",
    workspaceExternalId: `workspace:${crypto.randomUUID()}`,
    workspaceName: "Host export pump",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "pump",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
  });
  const started = await initializeSessionStartAtomically(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  if (!started.turn) throw new Error("initial turn missing");
  return { grant, session, turn: started.turn };
}

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition did not become true");
}

describe("host export pump", () => {
  test("stores the exact sink failure while public logs stay structural", async () => {
    const target = await fixture("exact-last-error");
    const sentinel = "HOST_EXPORT_PUBLIC_BOUNDARY_SENTINEL_64c9ef";
    const nul = String.fromCharCode(0);
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    const exactMessage = [
      `sink response ${sentinel}`,
      `X-Synthetic-Header: ${sentinel}`,
      `https://provider.example/failure?synthetic=${sentinel}`,
      `nul:${nul}:end`,
      `lone-high:${loneHigh}:end`,
      `lone-low:${loneLow}:end`,
      `active-prefix:${LOSSLESS_TEXT_PREFIX}:end`,
      "x".repeat(800),
    ].join("\n");
    const exactError = Object.assign(new Error(exactMessage), {
      name: sentinel,
      code: sentinel,
      responseBody: { sentinel },
    });
    const consumerId = `pump-exact-${crypto.randomUUID()}`;
    const warnings: unknown[][] = [];
    const errors: unknown[][] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => warnings.push(args);
    console.error = (...args: unknown[]) => errors.push(args);
    const pump = createHostExportPump({
      db: exporter.db,
      eventSink: {
        consumerId,
        deliverEvents: async () => {
          throw exactError;
        },
      },
      observability: createObservability(
        {
          serviceName: "opengeni",
          environment: "test",
          observabilityStructuredLogs: true,
          observabilityMetricsEnabled: false,
          observabilityOtlpHeaders: "",
        },
        { component: "worker" },
      ),
      pollIntervalMs: 25,
      batchLimit: 1,
      maxFailures: 1,
    });
    try {
      await pump.start();
      await appendSessionEvents(app.db, target.grant.workspaceId!, target.session.id, [
        {
          type: "agent.message.completed",
          payload: { text: "trigger exact sink failure" },
          turnId: target.turn.id,
        },
      ]);
      await eventually(async () => {
        const status = await pump.status("session_event");
        return status?.blockedAt !== null && status?.lastError === exactMessage;
      });
      const status = await pump.status("session_event");
      expect(status?.lastError).toBe(exactMessage);
      expect(status?.lastError?.length).toBeGreaterThan(500);
      const [stored] = await shared.admin<
        Array<{ lastError: string; lastErrorCodecVersion: number | null }>
      >`
        select last_error as "lastError",
               last_error_codec_version as "lastErrorCodecVersion"
        from host_export_consumers
        where export_kind = 'session_event' and consumer_id = ${consumerId}
      `;
      expect(stored?.lastErrorCodecVersion).toBe(1);
      expect(stored?.lastError).toContain(LOSSLESS_TEXT_PREFIX);
      expect(stored?.lastError).not.toBe(exactMessage);
    } finally {
      await pump.stop();
      console.warn = originalWarn;
      console.error = originalError;
    }

    await resumeHostExportConsumer(exporter.db, {
      kind: "session_event",
      consumerId,
    });
    expect(
      (
        await getHostExportConsumerStatus(exporter.db, {
          kind: "session_event",
          consumerId,
        })
      )?.lastError,
    ).toBeNull();

    const oldWriterLeaseToken = crypto.randomUUID();
    const oldWriterBatch = await claimHostExportBatch(exporter.db, {
      kind: "session_event",
      consumerId,
      leaseToken: oldWriterLeaseToken,
      leaseHolderId: "synthetic-old-host-export-writer",
      limit: 1,
    });
    expect(oldWriterBatch).not.toBeNull();
    const validActiveMarkerLiteral = ` ${LOSSLESS_TEXT_PREFIX}0041; `;
    await exporter.db.execute(sql`
      select opengeni_host_export.fail_host_export_batch(
        'session_event', ${consumerId}, ${oldWriterLeaseToken}::uuid,
        ${validActiveMarkerLiteral}, 1
      )
    `);
    expect(
      (
        await getHostExportConsumerStatus(exporter.db, {
          kind: "session_event",
          consumerId,
        })
      )?.lastError,
    ).toBe(validActiveMarkerLiteral);
    const [oldWriterStored] = await shared.admin<
      Array<{ lastError: string; lastErrorCodecVersion: number | null }>
    >`
      select last_error as "lastError",
             last_error_codec_version as "lastErrorCodecVersion"
      from host_export_consumers
      where export_kind = 'session_event' and consumer_id = ${consumerId}
    `;
    expect(oldWriterStored).toEqual({
      lastError: validActiveMarkerLiteral,
      lastErrorCodecVersion: null,
    });
    await pump.retire("session_event");

    const renderedLogs = JSON.stringify([...warnings, ...errors]);
    expect(renderedLogs).toContain("HostExportOperationError");
    expect(renderedLogs).toContain("host_export_batch_delivery_failed");
    expect(renderedLogs).not.toContain(sentinel);
    expect(renderedLogs).not.toContain(consumerId);
    expect(exactError.message).toBe(exactMessage);
  });

  test("registers, drains, acknowledges, and blocks a repeatedly failing sink", async () => {
    const delivered: HostEventExportBatch[] = [];
    const pump = createHostExportPump({
      db: exporter.db,
      eventSink: {
        consumerId: "pump-success",
        deliverEvents: async (batch) => {
          delivered.push(batch);
        },
      },
      pollIntervalMs: 25,
      batchLimit: 32,
      pruneGraceSeconds: 0,
    });
    await pump.start();
    const success = await fixture("success");
    const [expected] = await appendSessionEvents(
      app.db,
      success.grant.workspaceId!,
      success.session.id,
      [
        {
          type: "agent.message.completed",
          payload: { text: "pump delivered" },
          turnId: success.turn.id,
        },
      ],
    );
    await eventually(async () =>
      delivered.some((batch) => batch.events.some((item) => item.event.id === expected!.id)),
    );
    await eventually(async () => {
      const status = await pump.status("session_event");
      return status !== null && status.checkpoint === status.maxCursor;
    });
    await pump.stop();
    const [pruned] = await shared.admin<Array<{ count: string }>>`
      select count(*)::text as count from host_export_outbox
      where export_kind = 'session_event' and source_id = ${expected!.id}::uuid`;
    expect(pruned?.count).toBe("0");

    const [afterRestart] = await appendSessionEvents(
      app.db,
      success.grant.workspaceId!,
      success.session.id,
      [
        {
          type: "agent.message.completed",
          payload: { text: "after restart" },
          turnId: success.turn.id,
        },
      ],
    );
    const restartedDelivered: HostEventExportBatch[] = [];
    const restarted = createHostExportPump({
      db: exporter.db,
      eventSink: {
        consumerId: "pump-success",
        deliverEvents: async (batch) => {
          restartedDelivered.push(batch);
        },
      },
      pollIntervalMs: 25,
    });
    await restarted.start();
    await eventually(async () =>
      restartedDelivered.some((batch) =>
        batch.events.some((item) => item.event.id === afterRestart!.id),
      ),
    );
    await expect(restarted.retire("session_event")).rejects.toThrow(
      "Stop the host export pump before retiring a consumer",
    );
    await restarted.stop();
    await restarted.retire("session_event");
    expect(await restarted.status("session_event")).toBeNull();

    const failing = createHostExportPump({
      db: exporter.db,
      eventSink: {
        consumerId: "pump-failure",
        deliverEvents: async () => {
          throw new Error("synthetic sink outage");
        },
      },
      pollIntervalMs: 25,
      batchLimit: 1,
      maxFailures: 1,
    });
    await failing.start();
    await eventually(async () => {
      const status = await getHostExportConsumerStatus(exporter.db, {
        kind: "session_event",
        consumerId: "pump-failure",
      });
      return status !== null && status.blockedAt !== null;
    });
    const blocked = await failing.drainOnce();
    expect(blocked).toEqual([{ kind: "session_event", outcome: "blocked", failures: 1 }]);
    await failing.stop();

    const poisonId = crypto.randomUUID();
    await shared.admin`
      insert into host_export_outbox (
        export_kind, source_id, account_id, workspace_id, event_type,
        idempotency_key, initiator_context, payload, envelope_bytes,
        occurred_at, source_recorded_at, enqueued_at
      ) values (
        'usage_event', ${poisonId}::uuid, ${success.grant.accountId}::uuid,
        ${success.grant.workspaceId!}::uuid, 'model.tokens',
        ${`usage-poison:${poisonId}`}, '{}'::jsonb,
        ${JSON.stringify({ invalid: true })}::jsonb, 128, now(), now(), now()
      )`;
    let poisonDelivered = false;
    const poison = createHostExportPump({
      db: exporter.db,
      usageSink: {
        consumerId: "pump-poison",
        deliverUsage: async () => {
          poisonDelivered = true;
        },
      },
      pollIntervalMs: 25,
      maxFailures: 1,
    });
    await poison.start();
    await eventually(async () => {
      const status = await poison.status("usage_event");
      return status !== null && status.blockedAt !== null && status.consecutiveFailures === 1;
    });
    expect(poisonDelivered).toBe(false);
    expect((await poison.status("usage_event"))?.lastError).toContain("schema validation");
    await poison.stop();

    await resumeHostExportConsumer(exporter.db, {
      kind: "usage_event",
      consumerId: "pump-poison",
    });
    const dispositionToken = crypto.randomUUID();
    let payloadError: unknown;
    try {
      await claimHostExportBatch(exporter.db, {
        kind: "usage_event",
        consumerId: "pump-poison",
        leaseToken: dispositionToken,
        leaseHolderId: "operator-disposition",
      });
    } catch (error) {
      payloadError = error;
    }
    expect(payloadError).toBeInstanceOf(HostExportPayloadError);
    const poisonCursor = (payloadError as HostExportPayloadError).cursor;
    expect(
      await deadLetterHostExportHead(exporter.db, {
        kind: "usage_event",
        consumerId: "pump-poison",
        leaseToken: dispositionToken,
        cursor: poisonCursor,
        reason: "explicit malformed-envelope disposition",
      }),
    ).toBe(poisonCursor);
    expect(
      (
        await getHostExportConsumerStatus(exporter.db, {
          kind: "usage_event",
          consumerId: "pump-poison",
        })
      )?.lastError,
    ).toBe("dead-lettered: explicit malformed-envelope disposition");
    const [deadLetterStatus] = await shared.admin<Array<{ lastErrorCodecVersion: number | null }>>`
      select last_error_codec_version as "lastErrorCodecVersion"
      from host_export_consumers
      where export_kind = 'usage_event' and consumer_id = 'pump-poison'
    `;
    expect(deadLetterStatus?.lastErrorCodecVersion).toBeNull();
  });
});
