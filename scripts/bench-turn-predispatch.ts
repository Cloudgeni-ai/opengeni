#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { Transform } from "node:stream";
import type postgres from "postgres";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  addSessionSystemUpdate,
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEvents,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createTurnActivities } from "../apps/worker/src/activities-turn";
import {
  recordModelTransportDispatched,
  recordModelTransportStarted,
} from "../packages/runtime/src/model-preparation-diagnostics";

// Real restricted-role PostgreSQL and production worker/runtime; only provider
// transport and live event fanout are local fakes. Temporal scheduling is not
// measured: the activity starts immediately after the admission commit.
const count = Number(process.env.OPENGENI_BENCH_SAMPLES ?? 30);
if (!Number.isInteger(count) || count < 20) throw new Error("Use at least 20 samples");
const output = resolve(process.argv[2] ?? ".predispatch/measurement.json");
const shared = await acquireSharedTestDatabase("turn-predispatch-benchmark");
if (!shared) throw new Error("Real PostgreSQL is required");
const oneWayDelayMs = Number(process.env.OPENGENI_BENCH_DB_ONE_WAY_MS ?? 0);
if (!Number.isFinite(oneWayDelayMs) || oneWayDelayMs < 0 || oneWayDelayMs > 20) {
  throw new Error("Database one-way delay must be between 0 and 20 ms");
}
const proxy = oneWayDelayMs ? await delayedDatabase(shared.appUrl, oneWayDelayMs) : null;
const databaseUrl = proxy?.url ?? shared.appUrl;
const client = createDb(databaseUrl);
const settings = testSettings({ databaseUrl, sandboxBackend: "none" });
const observability = createObservability(settings, { component: "worker" });
type Sample = {
  phases: Record<string, number[]>;
  queries: string[];
  providerDispatchMs: number;
  workerToDispatchMs: number;
  normalizedRequest?: string;
};
let current: Sample | null = null;
const observe = observability.observeHistogram.bind(observability);
observability.observeHistogram = (input) => {
  if (current && input.name === "opengeni_turn_startup_phase_duration_seconds") {
    (current.phases[String(input.labels?.phase)] ??= []).push(input.value * 1000);
  }
  observe(input);
};
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
driver.options.debug = (_connection, query) => current?.queries.push(query);
const model = new ScriptedModel("hello");
const stream = model.getStreamedResponse.bind(model);
let acceptedAt = 0;
let workerStarted = 0;
model.getStreamedResponse = async function* (request) {
  await recordModelTransportStarted();
  const now = performance.now();
  const dispatchedAt = Date.now();
  recordModelTransportDispatched(now);
  if (!current) throw new Error("Dispatch outside a sample");
  // Compare full ordered request JSON across revisions. Only fixture-generated
  // UUIDs and wall-clock timestamps differ; never sort model input or schemas.
  current.normalizedRequest = JSON.stringify(request)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>");
  current.providerDispatchMs = dispatchedAt - acceptedAt;
  current.workerToDispatchMs = now - workerStarted;
  // Freeze query/phase evidence at the wire boundary, not after settlement.
  current = null;
  yield* stream(request);
};
const runtime = createProductionAgentRuntime({ model });
runtime.generateSessionTitle = async () => ({ title: null, usage: null });
const activities = createTurnActivities({
  settings,
  db: client.db,
  bus: new MemoryEventBus(),
  requestWorkerDrain: () => {
    throw new Error("Unexpected worker drain");
  },
  runtime,
  observability,
});
const samples: Sample[] = [];
const continuationSamples: Sample[] = [];
try {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "benchmark",
    accountExternalId: crypto.randomUUID(),
    accountName: "Startup benchmark",
    workspaceExternalSource: "benchmark",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Startup benchmark",
    subjectId: "benchmark:startup",
  });
  const grant = access.workspaceGrants[0]!;
  for (let i = -5; i < count; i++) {
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "hello",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const admitted = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      grant.workspaceId,
      grant.subjectId,
      (tx) =>
        submitHumanPromptInTransaction(tx, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "hello",
          resources: [],
          reasoningEffortFallback: "medium",
          connectionAccountIntent: {
            version: 1,
            principal: { kind: "subject", subjectId: grant.subjectId },
            selections: [],
          },
          turnExecutionPolicy: resolveTurnExecutionPolicyV1(settings, {
            modelId: "scripted-model",
            requestedModelId: "scripted-model",
            modelSource: "explicit",
            reasoningEffort: "medium",
            reasoningSource: "explicit",
            latencyMode: "standard",
          }),
          source: "user",
        }),
    );
    acceptedAt = Date.parse(admitted.accepted.occurredAt);
    const sample: Sample = {
      phases: {},
      queries: [],
      providerDispatchMs: 0,
      workerToDispatchMs: 0,
    };
    current = sample;
    workerStarted = performance.now();
    const result = await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
    });
    current = null;
    if (result.status !== "idle" || !sample.providerDispatchMs) {
      const events = await listSessionEvents(client.db, grant.workspaceId, session.id, 0, 200);
      throw new Error(
        JSON.stringify({
          result,
          events: events.filter((e) => e.type === "turn.failed" || e.type === "agent.error"),
        }),
      );
    }
    if (i >= 0) samples.push(sample);
    const childSessionId = crypto.randomUUID();
    await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: childSessionId,
      dedupeKey: `child_terminal_result:${childSessionId}`,
      summary: "Child finished",
      lineage: { parentTurnId: admitted.turnId, parentSessionId: session.id },
      payload: { type: "child_terminal_result", childSessionId, status: "idle" },
      mcpAccountBindings: [],
      personalConnectionDelegations: [],
    });
    // Continuation has no foreground user.message; report commit-to-dispatch.
    acceptedAt = Date.now();
    const continuation: Sample = {
      phases: {},
      queries: [],
      providerDispatchMs: 0,
      workerToDispatchMs: 0,
    };
    current = continuation;
    workerStarted = performance.now();
    const continued = await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
    });
    current = null;
    if (
      continued.status !== "idle" ||
      !continuation.providerDispatchMs ||
      !continuation.phases.claim_continued_accounts
    ) {
      const events = await listSessionEvents(client.db, grant.workspaceId, session.id, 0, 200);
      throw new Error(
        JSON.stringify({
          continued,
          phases: continuation.phases,
          events: events.filter((e) => e.type === "turn.failed" || e.type === "agent.error"),
        }),
      );
    }
    if (i >= 0) continuationSamples.push(continuation);
  }
  const distribution = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      n: values.length,
      p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
      mean: values.reduce((a, b) => a + b, 0) / values.length,
    };
  };
  const summarize = (measured: Sample[]) => ({
    databaseOneWayDelayMs: oneWayDelayMs,
    samples: count,
    providerDispatchMs: distribution(measured.map((s) => s.providerDispatchMs)),
    workerToDispatchMs: distribution(measured.map((s) => s.workerToDispatchMs)),
    statements: distribution(measured.map((s) => s.queries.length)),
    transactions: distribution(
      measured.map((s) => s.queries.filter((q) => /^begin\b/i.test(q)).length),
    ),
    savepoints: distribution(
      measured.map((s) => s.queries.filter((q) => /^savepoint\b/i.test(q)).length),
    ),
    phases: Object.fromEntries(
      [...new Set(measured.flatMap((s) => Object.keys(s.phases)))]
        .sort()
        .map((phase) => [phase, distribution(measured.flatMap((s) => s.phases[phase] ?? []))]),
    ),
  });
  const summary = summarize(samples);
  const continuations = summarize(continuationSamples);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ summary, continuations, samples, continuationSamples }, null, 2),
  );
  console.log(JSON.stringify({ summary, continuations }, null, 2));
} finally {
  await client.close();
  await proxy?.close();
  await shared.release();
}

/** Optional loopback-only transport fixture, never a database/mock substitute.
 * Each stream chunk is delayed in order in both directions. This is a
 * controlled sensitivity experiment, not a measured production network RTT. */
async function delayedDatabase(url: string, delayMs: number) {
  const target = new URL(url);
  const databaseHost = target.hostname;
  const databasePort = Number(target.port || 5432);
  const sockets = new Set<Socket>();
  const delay = () =>
    new Transform({
      transform(chunk, _encoding, done) {
        setTimeout(() => done(null, chunk), delayMs);
      },
    });
  const server = createServer((incoming) => {
    const outgoing = connect(databasePort, databaseHost);
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        incoming.destroy();
        outgoing.destroy();
      });
    }
    incoming.pipe(delay()).pipe(outgoing);
    outgoing.pipe(delay()).pipe(incoming);
  });
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback listener");
  target.hostname = "127.0.0.1";
  target.port = String(address.port);
  return {
    url: target.toString(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}
