import assert from "node:assert/strict";
import { AgentEvent, OpExit } from "@opengeni/agent-proto";
import { bootstrapWorkspace, createDb, createEnrollment } from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import type postgres from "postgres";
import {
  AGENT_EVENTS_SUBJECT,
  createAgentEventIngestionScheduler,
  handleAgentEventPayload,
  startMetricsIngestion,
} from "../../apps/api/src/sandbox/metrics-ingestion";

// Disposable real PG, actual API scheduler, no providers. Model twelve retry
// bursts without sleeping: both variants receive every notification and neither
// acknowledges missing rows. Timings are local processing time, not heartbeat
// latency or a live fleet claim. The scalar variant is the previous wiring.
const shared = await acquireSharedTestDatabase("bench-completion-lookups");
if (!shared) throw new Error("Real PostgreSQL required");
const client = createDb(shared.appUrl);
let statements = 0;
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
driver.options.debug = () => {
  statements++;
};
try {
  const key = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: key,
      accountName: "Completion lookup benchmark",
      workspaceExternalSource: "test",
      workspaceExternalId: key,
      workspaceName: "Completion lookup benchmark",
      subjectId: `benchmark-${key}`,
    })
  ).workspaceGrants[0]!;
  const enrollment = await createEnrollment(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    pubkey: `ed25519:${key}`,
  });
  const subject = `agent.${grant.workspaceId}.${enrollment.id}.connection.${crypto.randomUUID()}.events`;
  const samples = [];
  for (const operations of [1, 50]) {
    for (let round = 0; round < 6; round++) {
      const payloads = Array.from({ length: operations }, () =>
        AgentEvent.encode({
          event: {
            $case: "operationCompleted",
            operationCompleted: {
              opId: crypto.randomUUID(),
              exit: OpExit.fromPartial({ exitCode: 0 }),
            },
          },
        }).finish(),
      );
      for (const variant of round % 2 ? ["batched", "scalar"] : ["scalar", "batched"]) {
        let receipts = 0;
        const bus = Object.assign(new MemoryEventBus(), {
          getOpStreamConnection: () =>
            ({
              publish: () => {
                receipts++;
              },
            }) as unknown as ReturnType<NonNullable<EventBus["getOpStreamConnection"]>>,
        });
        const scalar =
          variant === "scalar"
            ? createAgentEventIngestionScheduler((payload, exactSubject) =>
                handleAgentEventPayload(client.db, undefined, payload, exactSubject, bus),
              )
            : undefined;
        const stop = scalar
          ? Object.assign(
              bus.subscribeAgentEvents(
                AGENT_EVENTS_SUBJECT,
                (payload, exactSubject) => scalar.enqueue(payload, exactSubject),
                { queue: "opengeni-agent-state-ingestion" },
              ),
              { whenIdle: () => scalar.whenIdle() },
            )
          : startMetricsIngestion({ db: client.db, bus });
        statements = 0;
        const start = performance.now(),
          cpu = process.cpuUsage();
        try {
          for (let tick = 0; tick < 12; tick++) {
            await Promise.all(payloads.map((payload) => bus.emitAgentEvent(subject, payload)));
            await stop.whenIdle();
          }
          const elapsedMs = performance.now() - start,
            used = process.cpuUsage(cpu);
          assert.equal(receipts, 0);
          // The first pair also initializes any new pool connections/types.
          if (round > 0) {
            assert.equal(
              statements,
              12 * (variant === "scalar" ? operations : Math.ceil(operations / 32)),
            );
            samples.push({
              operations,
              variant,
              statements,
              deliveries: 12 * operations,
              receipts,
              elapsedMs,
              cpuMs: (used.user + used.system) / 1000,
            });
          }
        } finally {
          stop();
          scalar?.close();
        }
      }
    }
  }
  console.log(
    JSON.stringify({
      samples,
      scope:
        "Synthetic retry bursts through actual API scheduler with real application-role SQL; no output release, receipt suppression, wall-clock heartbeat or live gain claim.",
    }),
  );
} finally {
  await client.close();
  await shared.release();
}
