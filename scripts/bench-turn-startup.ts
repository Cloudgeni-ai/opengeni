#!/usr/bin/env bun
/** Real HTTP, Temporal control/turn workers, NATS and restricted PostgreSQL.
 * Only model transport is scripted, so latency stops at the first request.
 * All rows and task queues are isolated; shared infrastructure is never stopped.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import { bootstrapWorkspace, createDb, listSessionEvents } from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { createApp } from "../apps/api/src/app";
import { createTemporalWorkflowClient } from "../apps/api/src/index";
import { createControlActivities } from "../apps/worker/src/activities-control";
import { createTurnActivities } from "../apps/worker/src/activities-turn";
import { turnTaskQueue } from "../apps/worker/src/workflows/activities";
import {
  recordModelTransportDispatched,
  recordModelTransportStarted,
} from "../packages/runtime/src/model-preparation-diagnostics";

const count = Number(process.env.OPENGENI_BENCH_SAMPLES ?? 30);
if (!Number.isInteger(count) || count < 1) throw new Error("Invalid sample count");
const output = resolve(process.argv[2] ?? ".startup/measurement.json");
const shared = await acquireSharedTestDatabase("startup-http-temporal");
if (!shared) throw new Error("Real PostgreSQL required");
const client = createDb(shared.appUrl);
const settings = testSettings({
  databaseUrl: shared.appUrl,
  natsUrl: process.env.OPENGENI_TEST_NATS_URL ?? "nats://127.0.0.1:5222",
  temporalHost: process.env.OPENGENI_TEST_TEMPORAL_HOST ?? "127.0.0.1:8235",
  sandboxBackend: "none",
  environment: "test",
});
const bus = await createNatsEventBus(settings.natsUrl);
const workflow = await createTemporalWorkflowClient(settings, client.db);
const connection = await NativeConnection.connect({ address: settings.temporalHost });
const observability = createObservability(settings, { component: "worker" });
type Sample = {
  httpStart: number;
  dispatchedAt: number;
  httpToDispatchMs: number;
  queuedToDispatchMs: number;
  queuedToStartedMs: number;
  phases: Record<string, number[]>;
  request: string;
  events: unknown[];
};
let current: Sample | null = null;
const observe = observability.observeHistogram.bind(observability);
observability.observeHistogram = (input) => {
  if (current && input.name === "opengeni_turn_startup_phase_duration_seconds") {
    (current.phases[String(input.labels?.phase)] ??= []).push(input.value * 1000);
  }
  observe(input);
};
const model = new ScriptedModel("OK");
const stream = model.getStreamedResponse.bind(model);
model.getStreamedResponse = async function* (request) {
  await recordModelTransportStarted();
  recordModelTransportDispatched(performance.now());
  if (!current) throw new Error("Unmeasured model request");
  current.dispatchedAt = Date.now();
  current.httpToDispatchMs = performance.now() - current.httpStart;
  current.request = JSON.stringify(request);
  yield* stream(request);
};
const runtime = createProductionAgentRuntime({ model });
runtime.generateSessionTitle = async () => ({ title: null, usage: null });
const dependencies = { settings, db: client.db, bus, observability };
const control = await Worker.create({
  connection,
  taskQueue: settings.temporalTaskQueue,
  workflowsPath: new URL("../apps/worker/src/workflows.ts", import.meta.url).pathname,
  activities: createControlActivities(dependencies),
});
const turns = await Worker.create({
  connection,
  taskQueue: turnTaskQueue(settings.temporalTaskQueue),
  activities: createTurnActivities({
    ...dependencies,
    runtime,
    requestWorkerDrain: () => {
      throw new Error("Unexpected worker drain");
    },
  }),
});
const runs = [control.run(), turns.run()];
const app = createApp({ ...dependencies, workflowClient: workflow.client });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
const samples: Sample[] = [];
try {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:local",
    accountExternalId: "default",
    accountName: "Local account",
    workspaceExternalSource: "opengeni:local",
    workspaceExternalId: "default",
    workspaceName: "Local workspace",
    subjectId: "dev",
  });
  const grant = access.workspaceGrants[0]!;
  for (let index = -3; index < count; index++) {
    const sample: Sample = {
      httpStart: performance.now(),
      dispatchedAt: 0,
      httpToDispatchMs: 0,
      queuedToDispatchMs: 0,
      queuedToStartedMs: 0,
      phases: {},
      request: "",
      events: [],
    };
    current = sample;
    const response = await fetch(`${server.url}v1/workspaces/${grant.workspaceId}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "Reply with OK.",
        model: "scripted-model",
        sandboxBackend: "none",
        resources: [],
      }),
    });
    if (!response.ok) throw new Error(`Create ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { id?: string; session?: { id: string } };
    const sessionId = body.id ?? body.session?.id;
    if (!sessionId) throw new Error(`No session: ${JSON.stringify(body)}`);
    const deadline = performance.now() + 60_000;
    let events: Awaited<ReturnType<typeof listSessionEvents>> = [];
    for (;;) {
      events = await listSessionEvents(client.db, grant.workspaceId, sessionId, 0, 500);
      if (events.some((e) => e.type === "turn.failed")) throw new Error(JSON.stringify(events));
      if (events.some((e) => e.type === "turn.completed")) break;
      if (performance.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(events)}`);
      await Bun.sleep(50);
    }
    const queued = events.find((e) => e.type === "turn.queued")!;
    const started = events.find((e) => e.type === "turn.started")!;
    if (!queued || !started || !sample.request) throw new Error("Missing startup evidence");
    sample.queuedToDispatchMs = sample.dispatchedAt - Date.parse(queued.occurredAt);
    sample.queuedToStartedMs = Date.parse(started.occurredAt) - Date.parse(queued.occurredAt);
    sample.events = events.filter(
      (e) =>
        e.type === "turn.queued" ||
        e.type === "turn.started" ||
        e.type.startsWith("turn.startup") ||
        e.type === "agent.model.request",
    );
    current = null;
    if (index >= 0) samples.push(sample);
    console.log(
      `sample ${index}: queued ${sample.queuedToDispatchMs} ms, HTTP ${Math.round(sample.httpToDispatchMs)} ms`,
    );
  }
  const distribution = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      n: sorted.length,
      median: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
    };
  };
  const summary = {
    httpToDispatchMs: distribution(samples.map((s) => s.httpToDispatchMs)),
    queuedToDispatchMs: distribution(samples.map((s) => s.queuedToDispatchMs)),
    queuedToStartedMs: distribution(samples.map((s) => s.queuedToStartedMs)),
    phases: Object.fromEntries(
      [...new Set(samples.flatMap((s) => Object.keys(s.phases)))]
        .sort()
        .map((phase) => [phase, distribution(samples.flatMap((s) => s.phases[phase] ?? []))]),
    ),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ summary, samples }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  server.stop(true);
  control.shutdown();
  turns.shutdown();
  await Promise.all(runs);
  await connection.close();
  await workflow.close();
  await bus.close();
  await client.close();
  await shared.release();
}
