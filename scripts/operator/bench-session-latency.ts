import { AsyncLocalStorage } from "node:async_hooks";
import { createConnection, createServer } from "node:net";
import type postgres from "postgres";
import { getSettings } from "@opengeni/config";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  withDatabaseTimingObserver,
} from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability, currentTraceContext } from "@opengeni/observability";
import { createApp } from "../../apps/api/src/app";
import { createTemporalWorkflowClient } from "../../apps/api/src/index";

// Uses the real HTTP adapter, restricted PostgreSQL role, NATS and Temporal.
// No worker polls this isolated task queue: admission is measured, not inference.
// Request content, SQL parameters, credentials and tenant IDs are never emitted.
type Sample = {
  route: string;
  durationMs: number;
  statements: number;
  transactions: number;
  savepoints: number;
  phases: Record<string, number[]>;
  databaseStages: Record<string, number[]>;
  sqlKinds: Record<string, number>;
  statementsByPhase: Record<string, number>;
  // Parameterized SQL text only (never bound values), when tracing is enabled.
  trace?: string[];
};
const traceSql = process.env.OPENGENI_BENCH_TRACE_SQL === "1";
const activeSample = new AsyncLocalStorage<Sample>();
const settings = getSettings();
const databaseUrl = new URL(settings.databaseUrl);
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)
  || !["local", "test"].includes(settings.environment)) {
  throw new Error("Session latency benchmark requires an isolated local/test PostgreSQL");
}
const responseDelayMs = Number(process.env.OPENGENI_BENCH_DB_RESPONSE_DELAY_MS ?? "0");
if (!Number.isFinite(responseDelayMs) || responseDelayMs < 0 || responseDelayMs > 100) {
  throw new Error("OPENGENI_BENCH_DB_RESPONSE_DELAY_MS must be between 0 and 100");
}
// An optional loopback TCP relay delays backend response chunks, without
// inspecting/changing SQL or authentication. This is a transport simulation,
// not a production RTT estimate or a replacement for the direct local run.
const relay = responseDelayMs > 0 ? createServer((frontend) => {
  const backend = createConnection({ host: databaseUrl.hostname, port: Number(databaseUrl.port || "5432") });
  frontend.pipe(backend);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  backend.on("data", (chunk: Buffer) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!frontend.destroyed) frontend.write(chunk);
    }, responseDelayMs);
    timers.add(timer);
  });
  const close = () => {
    for (const timer of timers) clearTimeout(timer);
    frontend.destroy();
    backend.destroy();
  };
  frontend.on("error", close);
  frontend.on("close", close);
  backend.on("error", close);
  backend.on("close", close);
}) : undefined;
if (relay) {
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const address = relay.address();
  if (!address || typeof address === "string") throw new Error("Benchmark relay did not bind");
  const proxiedUrl = new URL(databaseUrl);
  proxiedUrl.hostname = "127.0.0.1";
  proxiedUrl.port = String(address.port);
  settings.databaseUrl = proxiedUrl.href;
}
settings.sandboxBackend = "none";
settings.productAccessMode = "managed";
settings.delegationSecret = "session-latency-benchmark-delegation-secret";
settings.temporalTaskQueue = `session-latency-${crypto.randomUUID()}`;
settings.observabilityStructuredLogs = false;
settings.observabilityOtlpEndpoint = undefined;
const client = createDb(settings.databaseUrl, { max: settings.apiDatabasePoolMax });
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
const phaseBySpan = new Map<string, string>();
driver.options.debug = (_connection, query) => {
  const sample = activeSample.getStore();
  if (!sample) return;
  sample.statements++;
  if (traceSql) (sample.trace ??= []).push(query.replace(/\s+/gu, " ").slice(0, 400));
  const phase = phaseBySpan.get(currentTraceContext()?.spanId ?? "") ?? "outside_named_phase";
  sample.statementsByPhase[phase] = (sample.statementsByPhase[phase] ?? 0) + 1;
  const verb = query.trim().split(/\s+/u)[0]?.toLowerCase() ?? "unknown";
  if (verb === "begin") sample.transactions++;
  if (verb === "savepoint") sample.savepoints++;
  const table = query.match(/\b(?:from|into|update)\s+"?([a-z_][a-z_0-9]*)"?/iu)?.[1];
  const kind = `${verb}${table ? `:${table}` : ""}`;
  sample.sqlKinds[kind] = (sample.sqlKinds[kind] ?? 0) + 1;
};
const observability = createObservability(settings, { component: "api" });
const startSpan = observability.startSpan.bind(observability);
observability.startSpan = (name, ...args) => {
    const span = startSpan(name, ...args);
    const sample = activeSample.getStore();
    if (sample) phaseBySpan.set(span.spanId, name);
    const start = performance.now();
    return {
      ...span,
      end: (input) => {
        if (sample) (sample.phases[name] ??= []).push(performance.now() - start);
        phaseBySpan.delete(span.spanId);
        span.end(input);
      },
    };
};
const bus = await createNatsEventBus(settings.natsUrl);
const workflows = await createTemporalWorkflowClient(settings, client.db);
const app = createApp({
  settings,
  db: client.db,
  bus,
  workflowClient: workflows.client,
  observability,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const sample = samplesByRequest.get(request.headers.get("x-benchmark-request") ?? "");
    if (!sample) return app.fetch(request);
    return activeSample.run(sample, () =>
      withDatabaseTimingObserver((observation) => {
        (sample.databaseStages[observation.stage] ??= []).push(observation.durationMs);
      }, async () => await app.fetch(request)),
    );
  },
});
const samplesByRequest = new Map<string, Sample>();
const samples: Sample[] = [];
const count = Number(process.env.OPENGENI_BENCH_SAMPLES ?? "10");
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("Benchmark samples must be between 1 and 100");
try {
  for (let index = -1; index < count; index++) {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "session-latency-benchmark",
      accountExternalId: crypto.randomUUID(),
      accountName: "Latency benchmark",
      workspaceExternalSource: "session-latency-benchmark",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Latency benchmark",
      subjectId: `user:${crypto.randomUUID()}`,
    });
    const grant = access.workspaceGrants[0]!;
    const token = await signDelegatedAccessToken(settings.delegationSecret!, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      permissions: ["sessions:create", "sessions:read", "sessions:control", "goals:manage"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    });
    const request = async (route: string, path: string, body?: unknown) => {
      const id = crypto.randomUUID();
      const sample: Sample = {
        route, durationMs: 0, statements: 0, transactions: 0, savepoints: 0,
        phases: {}, databaseStages: {}, sqlKinds: {}, statementsByPhase: {},
      };
      samplesByRequest.set(id, sample);
      const started = performance.now();
      const response = await fetch(new URL(path, server.url), {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-benchmark-request": id,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      sample.durationMs = performance.now() - started;
      samplesByRequest.delete(id);
      if (!response.ok) throw new Error(`Benchmark ${route}: HTTP ${response.status} ${JSON.stringify(result)}`);
      if (index >= 0) samples.push(sample);
      return result as { id: string };
    };
    const session = await request("create", `/v1/workspaces/${grant.workspaceId}/sessions`, {
      initialMessage: "Hello",
      sandboxBackend: "none",
    });
    await request("get", `/v1/workspaces/${grant.workspaceId}/sessions/${session.id}`);
    await request("draft", `/v1/workspaces/${grant.workspaceId}/new-session-draft`);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const summary = Object.fromEntries(["create", "get", "draft"].map((route) => {
    const group = samples.filter((sample) => sample.route === route);
    return [route, {
      samples: group.length,
      wallP50Ms: median(group.map((sample) => sample.durationMs)),
      wallP95Ms: group.map((sample) => sample.durationMs).sort((a, b) => a - b)[Math.ceil(group.length * 0.95) - 1],
      statements: median(group.map((sample) => sample.statements)),
      transactions: median(group.map((sample) => sample.transactions)),
      savepoints: median(group.map((sample) => sample.savepoints)),
      phaseP50Ms: Object.fromEntries([...new Set(group.flatMap((sample) => Object.keys(sample.phases)))].map((phase) => [
        phase, median(group.map((sample) => (sample.phases[phase] ?? []).reduce((sum, duration) => sum + duration, 0))),
      ])),
      statementsByPhase: group[0]!.statementsByPhase,
    }];
  }));
  const output = JSON.stringify({ responseDelayMs, summary, samples }, null, 2);
  if (process.env.OPENGENI_BENCH_OUTPUT) await Bun.write(process.env.OPENGENI_BENCH_OUTPUT, output);
  console.log(output);
} finally {
  server.stop(true);
  await workflows.close();
  await bus.close();
  await client.close();
  if (relay) await new Promise<void>((resolve) => relay.close(() => resolve()));
  await observability.flush();
}