#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import type postgres from "postgres";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
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
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { ScriptedModel, functionCall } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createTurnActivities } from "../apps/worker/src/activities-turn";
import {
  recordModelTransportDispatched,
  recordModelTransportStarted,
} from "../packages/runtime/src/model-preparation-diagnostics";

// Production worker, SDK runner, MCP HTTP transport and restricted-role database.
// Only the model and remote tool work are scripted; no paid provider is called.
export async function measureAgentSteps(steps = 30, runs = 3) {
  const shared = await acquireSharedTestDatabase("agent-steps-benchmark");
  if (!shared) throw new Error("Real PostgreSQL is required");
  const oneWayDelayMs = Number(process.env.OPENGENI_BENCH_DB_ONE_WAY_MS ?? 0);
  if (!Number.isFinite(oneWayDelayMs) || oneWayDelayMs < 0 || oneWayDelayMs > 20)
    throw new Error("Invalid database delay");
  const databaseProxy = oneWayDelayMs ? await delayedDatabase(shared.appUrl, oneWayDelayMs) : null;
  const client = createDb(databaseProxy?.url ?? shared.appUrl);
  const mcp = startTestMcpServer();
  type Mark = {
    kind: "dispatch" | "model_done" | "tool_start" | "tool_done";
    at: number;
    queries: number;
  };
  const samples: Array<{
    marks: Mark[];
    phases: Record<string, number[]>;
    queries: string[];
    queryTimes: number[];
    requests: string[];
    lifecycle: string[];
  }> = [];
  let sample: (typeof samples)[number] | null = null;
  const mark = (kind: Mark["kind"]) =>
    sample?.marks.push({ kind, at: performance.now(), queries: sample.queries.length });
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = request.method === "POST" ? await request.clone().json() : null;
      const tool = body?.method === "tools/call";
      if (tool) mark("tool_start");
      const response = await fetch(new Request(mcp.url, request));
      const bytes = await response.arrayBuffer();
      if (tool) mark("tool_done");
      return new Response(bytes, { status: response.status, headers: response.headers });
    },
  });
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    sandboxBackend: "none",
    mcpServers: [
      {
        id: "docs",
        name: "Documents",
        url: `http://127.0.0.1:${proxy.port}/mcp`,
        allowedTools: ["search_documents"],
        cacheToolsList: false,
      },
    ],
  });
  const observability = createObservability(settings, { component: "worker" });
  const observe = observability.observeHistogram.bind(observability);
  observability.observeHistogram = (input) => {
    if (
      sample &&
      [
        "opengeni_model_step_phase_duration_seconds",
        "opengeni_model_request_pre_dispatch_stage_seconds",
      ].includes(input.name)
    ) {
      (sample.phases[
        input.labels?.stage ? `predispatch_${input.labels.stage}` : String(input.labels?.phase)
      ] ??= []).push(input.value * 1000);
    }
    observe(input);
  };
  (client.db as unknown as { $client: postgres.Sql }).$client.options.debug = (
    _connection,
    query,
  ) => {
    sample?.queries.push(query);
    sample?.queryTimes.push(performance.now());
  };
  try {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "benchmark",
      accountExternalId: crypto.randomUUID(),
      accountName: "Step benchmark",
      workspaceExternalSource: "benchmark",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Step benchmark",
      subjectId: "benchmark:steps",
    });
    const grant = access.workspaceGrants[0]!;
    for (let run = -1; run < runs; run++) {
      const model = new ScriptedModel([
        ...Array.from({ length: steps }, (_, step) => ({
          id: `response-${step}`,
          output: [functionCall("docs__search_documents", { query: "example" }, `call-${step}`)],
        })),
        { id: "response-final", outputText: "Done", chunks: ["Done"] },
      ]);
      const streamed = model.getStreamedResponse.bind(model);
      model.getStreamedResponse = async function* (request) {
        await recordModelTransportStarted();
        recordModelTransportDispatched(performance.now());
        mark("dispatch");
        sample?.requests.push(
          JSON.stringify(request)
            .replace(
              /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
              "<uuid>",
            )
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>"),
        );
        for await (const event of streamed(request)) {
          if (event.type === "response_done") mark("model_done");
          yield event;
        }
      };
      const runtime = createProductionAgentRuntime({ model });
      runtime.generateSessionTitle = async () => ({ title: null, usage: null });
      const activities = createTurnActivities({
        settings,
        db: client.db,
        bus: new MemoryEventBus(),
        runtime,
        observability,
        requestWorkerDrain: () => {
          throw new Error("Unexpected worker drain");
        },
      });
      const session = await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: "Search documents",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
      await withWorkspaceSubjectSessionActivityRls(
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
            text: "Search documents",
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
      sample = { marks: [], phases: {}, queries: [], queryTimes: [], requests: [], lifecycle: [] };
      const result = await activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
      });
      const completed = sample;
      sample = null;
      const events = await listSessionEvents(client.db, grant.workspaceId, session.id, 0, 10_000);
      completed.lifecycle = events
        .filter((event) => event.type === "agent.model.request")
        .map((event) => String(event.payload.phase));
      if (
        result.status !== "idle" ||
        model.calls !== steps + 1 ||
        completed.marks.filter((m) => m.kind === "tool_done").length !== steps
      ) {
        throw new Error(
          JSON.stringify({
            result,
            calls: model.calls,
            events: events.filter((e) => e.type === "turn.failed" || e.type === "agent.error"),
          }),
        );
      }
      if (run >= 0) samples.push(completed);
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
    const gaps = (from: Mark["kind"], to: Mark["kind"], field: "at" | "queries") =>
      samples.flatMap((s) =>
        s.marks.flatMap((entry, i) =>
          entry.kind === from && s.marks[i + 1]?.kind === to
            ? [s.marks[i + 1]![field] - entry[field]]
            : [],
        ),
      );
    const summary = {
      databaseOneWayDelayMs: oneWayDelayMs,
      steps,
      runs,
      modelToToolMs: distribution(gaps("model_done", "tool_start", "at")),
      toolToModelMs: distribution(gaps("tool_done", "dispatch", "at")),
      modelToToolStatements: distribution(gaps("model_done", "tool_start", "queries")),
      toolToModelStatements: distribution(gaps("tool_done", "dispatch", "queries")),
      phases: Object.fromEntries(
        [...new Set(samples.flatMap((s) => Object.keys(s.phases)))]
          .sort()
          .map((phase) => [phase, distribution(samples.flatMap((s) => s.phases[phase] ?? []))]),
      ),
      lifecycle: samples.map((s) =>
        s.lifecycle.reduce<Record<string, number>>((counts, phase) => {
          counts[phase] = (counts[phase] ?? 0) + 1;
          return counts;
        }, {}),
      ),
    };
    return { summary, samples };
  } finally {
    proxy.stop(true);
    mcp.close();
    await client.close();
    await databaseProxy?.close();
    await shared.release();
  }
}

// Controlled propagation delay, not a claim about production RTT. Schedule
// each chunk from its arrival time, rather than sleeping serially per chunk:
// the latter would impose bandwidth throttling and conceal pipelining gains.
async function delayedDatabase(url: string, delayMs: number) {
  const target = new URL(url);
  const host = target.hostname;
  const port = Number(target.port || 5432);
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (work: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      work();
    }, delayMs);
    timers.add(timer);
  };
  const forward = (source: Socket, destination: Socket) => {
    source.on("data", (chunk) =>
      later(() => {
        if (!destination.destroyed) destination.write(chunk);
      }),
    );
    source.on("end", () =>
      later(() => {
        if (!destination.destroyed) destination.end();
      }),
    );
  };
  const server = createServer((incoming) => {
    const outgoing = connect(port, host);
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        incoming.destroy();
        outgoing.destroy();
      });
    }
    forward(incoming, outgoing);
    forward(outgoing, incoming);
  });
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing database proxy");
  target.hostname = "127.0.0.1";
  target.port = String(address.port);
  return {
    url: target.toString(),
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}

if (import.meta.main) {
  const result = await measureAgentSteps(
    Number(process.env.OPENGENI_BENCH_STEPS ?? 30),
    Number(process.env.OPENGENI_BENCH_RUNS ?? 3),
  );
  const output = resolve(process.argv[2] ?? ".agent-steps/measurement.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
}
