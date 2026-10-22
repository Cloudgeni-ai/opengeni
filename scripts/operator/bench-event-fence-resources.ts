import { createConnection, createServer } from "node:net";
import { isDeepStrictEqual } from "node:util";
import type postgres from "postgres";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
} from "@opengeni/db";
import { submitTestHumanPrompt } from "../../test/integration/helpers/session-control";
import { postgresWireBudget } from "./postgres-wire-budget";

// The full-row no-op mutation reproduces the old event-only append path. Both
// variants use the same current schema, rows, payloads, locks and transactions.
// This is a local restricted-role fixture, never a production benchmark.
type Sample = {
  shape: string;
  lane: string;
  count: number;
  projection: string;
  statements: number;
  cycles: number;
  responseBytes: number;
  ms: number;
  cpuMs: number;
};
let current: Sample | undefined;
const samples: Sample[] = [];
const generic = process.env.OPENGENI_BENCH_GENERIC_EVENTS === "1";
const shared = await acquireSharedTestDatabase("event-fence-benchmark");
if (!shared) throw new Error("Local PostgreSQL required");
const upstream = new URL(shared.appUrl);
const relay = createServer((frontend) => {
  const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
  frontend.on(
    "data",
    postgresWireBudget(() => {
      if (current) current.cycles++;
    }),
  );
  backend.on("data", (chunk: Buffer) => {
    if (current) current.responseBytes += chunk.length;
  });
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
const client = createDb(url.href, { max: 1 });
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
driver.options.debug = () => {
  if (current) current.statements++;
};
try {
  for (const shape of ["small", "wide"]) {
    const id = crypto.randomUUID();
    const {
      workspaceGrants: [grant],
    } = await bootstrapWorkspace(client.db, {
      accountExternalSource: "benchmark",
      accountExternalId: id,
      accountName: "Event benchmark",
      workspaceExternalSource: "benchmark",
      workspaceExternalId: id,
      workspaceName: "Event benchmark",
      subjectId: id,
    });
    if (!grant) throw new Error("No fixture grant");
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "benchmark",
      instructions: shape === "wide" ? "synthetic instructions ".repeat(1_000) : "instructions",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await submitTestHumanPrompt(client.db, {
      ...grant,
      sessionId: session.id,
      text: shape === "wide" ? "synthetic prompt ".repeat(900) : "prompt",
      resources: [],
      tools: [],
      reasoningEffortFallback: "medium",
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      attemptId,
      dispatchId: crypto.randomUUID(),
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("No fixture attempt");
    for (const type of ["agent.message.completed", "agent.message.delta"] as const) {
      for (const count of [1, 10]) {
        const inputs = Array.from({ length: count }, (_, index) => ({
          type,
          payload: { text: `exact bytes ${index}` },
        }));
        for (let run = -3; run < Number(process.env.OPENGENI_BENCH_SAMPLES ?? "20"); run++) {
          for (const projection of generic
            ? ["generic"]
            : run % 2 === 0
              ? ["full", "event", "checkpoint"]
              : ["checkpoint", "event", "full"]) {
            const sample: Sample = {
              shape,
              lane: type,
              count,
              projection,
              statements: 0,
              cycles: 0,
              responseBytes: 0,
              ms: 0,
              cpuMs: 0,
            };
            current = sample;
            const started = performance.now(),
              cpu = process.cpuUsage();
            const result = generic
              ? {
                  accepted: true,
                  events: await appendSessionEvents(
                    client.db,
                    grant.workspaceId,
                    session.id,
                    inputs.map((input) => ({
                      ...input,
                      turnId: claim.turn.id,
                      turnGeneration: claim.turn.executionGeneration,
                      turnAttemptId: attemptId,
                    })),
                  ),
                }
              : await appendSessionEventsForTurnAttempt(
                  client.db,
                  grant.workspaceId,
                  session.id,
                  claim.turn.id,
                  claim.turn.executionGeneration,
                  attemptId,
                  inputs,
                  undefined,
                  projection === "full"
                    ? async () => true
                    : projection === "checkpoint"
                      ? { rowProjection: "event", mutate: async () => true }
                      : undefined,
                );
            sample.ms = performance.now() - started;
            const used = process.cpuUsage(cpu);
            sample.cpuMs = (used.user + used.system) / 1000;
            current = undefined;
            if (
              !result.accepted ||
              !isDeepStrictEqual(
                result.events.map((event) => ({ type: event.type, payload: event.payload })),
                inputs,
              )
            )
              throw new Error("Append changed the event payload or rejected the fixture");
            if (run >= 0) samples.push(sample);
          }
        }
      }
    }
  }
  const groups = Map.groupBy(
    samples,
    (sample) => `${sample.shape}/${sample.lane}/${sample.count}/${sample.projection}`,
  );
  const summary = Object.fromEntries(
    [...groups].map(([key, rows]) => [
      key,
      Object.fromEntries(
        (["statements", "cycles", "responseBytes", "ms", "cpuMs"] as const).map((metric) => [
          metric,
          rows.reduce((sum, row) => sum + row[metric], 0) / rows.length,
        ]),
      ),
    ]),
  );
  console.log(JSON.stringify({ summary, samples }, null, 2));
} finally {
  current = undefined;
  await client.close();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await shared.release();
}
process.exit(0);
