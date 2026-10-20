import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import type postgres from "postgres";
import { acquireSharedTestDatabase, MemoryEventBus } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createEnrollment,
  claimEnrollmentConnection,
} from "@opengeni/db";
import { AgentEvent } from "@opengeni/agent-proto";
import { startMetricsIngestion } from "../../apps/api/src/sandbox/metrics-ingestion";
import { postgresWireBudget } from "./postgres-wire-budget";

// Production ingestion and restricted-role PostgreSQL, with in-process broker
// queue delivery. Real NATS queue/failover coverage lives in events tests.
// Q/H/S boundaries measure protocol cycles, not TCP packets or critical-path RTTs.

const shared = await acquireSharedTestDatabase("heartbeat-resource-benchmark");
if (!shared) throw new Error("Local PostgreSQL required");
let current:
  | { statements: number; transactions: number; cycles: number; queries: Record<string, number> }
  | undefined;
const upstream = new URL(shared.appUrl);
const relay = createServer((frontend) => {
  const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
  frontend.on(
    "data",
    postgresWireBudget(() => {
      if (current) current.cycles++;
    }),
  );
  frontend.pipe(backend);
  backend.pipe(frontend);
  const close = () => {
    frontend.destroy();
    backend.destroy();
  };
  frontend.on("error", close);
  frontend.on("close", close);
  backend.on("error", close);
  backend.on("close", close);
});
await new Promise<void>((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(0, "127.0.0.1", resolve);
});
const address = relay.address();
if (!address || typeof address === "string") throw new Error("No relay address");
const url = new URL(shared.appUrl);
url.port = String(address.port);
const client = createDb(url.href);
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
driver.options.debug = (_id, query) => {
  if (!current) return;
  current.statements++;
  if (/^begin/i.test(query.trim())) current.transactions++;
  const key = query.replace(/\s+/g, " ");
  current.queries[key] = (current.queries[key] ?? 0) + 1;
};
const warnings: unknown[] = [];
try {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Heartbeat budget",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Heartbeat budget",
    subjectId: "heartbeat-observer",
  });
  const grant = access.workspaceGrants[0]!;
  const enrollment = await createEnrollment(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
    exposure: "whole-machine",
    hasDisplay: false,
    allowScreenControl: false,
    os: "linux",
    arch: "x86_64",
  });
  const instance = crypto.randomUUID();
  const claimed = await claimEnrollmentConnection(client.db, {
    workspaceId: grant.workspaceId,
    enrollmentId: enrollment.id,
    credentialGeneration: 1,
    connectionInstanceId: instance,
    leaseMs: 20_000,
  });
  assert(claimed.claimed);
  const bridge = crypto.randomUUID();
  const sampledAtMs = String(Date.now());
  const subject = `agent.${grant.workspaceId}.${enrollment.id}.connection.${instance}.events`;
  const samples: unknown[] = [];
  for (const inventory of [false, true]) {
    for (const replicas of [1, 2]) {
      const bus = new MemoryEventBus();
      const consumers = Array.from({ length: replicas }, () =>
        startMetricsIngestion({
          db: client.db,
          bus,
          observability: { warn: (...args: unknown[]) => warnings.push(args) } as never,
        }),
      );
      for (let iteration = 0; iteration < 6; iteration++) {
        const payload = AgentEvent.encode(
          AgentEvent.fromPartial({
            agentId: enrollment.id,
            event: {
              $case: "heartbeat",
              heartbeat: {
                seq: String(iteration + 1),
                uptimeMs: String(5000 * (iteration + 1)),
                metrics: {
                  sampledAtMs,
                  cpuPercent: 10,
                  memUsedBytes: "1024",
                  memTotalBytes: "4096",
                  diskUsedBytes: "2048",
                  diskTotalBytes: "8192",
                },
                ...(inventory
                  ? {
                      attachedBrowserInventory: {
                        bridgeGeneration: bridge,
                        revision: "1",
                        devices: [],
                        connectionEnds: [],
                      },
                    }
                  : {}),
              },
            },
          }),
        ).finish();
        current = { statements: 0, transactions: 0, cycles: 0, queries: {} };
        const start = performance.now();
        await bus.emitAgentEvent(subject, payload);
        await Promise.all(consumers.map((consumer) => consumer.whenIdle()));
        const ms = performance.now() - start;
        samples.push({ inventory, replicas, iteration, ms, ...current });
        current = undefined;
      }
      consumers.forEach((consumer) => consumer());
    }
  }
  assert.deepEqual(warnings, []);
  console.log(JSON.stringify({ samples }, null, 2));
} finally {
  current = undefined;
  await client.close();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await shared.release();
}
