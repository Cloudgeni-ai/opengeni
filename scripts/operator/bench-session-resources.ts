import { AsyncLocalStorage } from "node:async_hooks";
import { createConnection, createServer } from "node:net";
import type postgres from "postgres";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  getSessionEventSequence,
} from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability, currentTraceContext } from "@opengeni/observability";
import { startTestServices } from "@opengeni/testing/compose";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../../apps/api/src/app";
import { createTemporalWorkflowClient } from "../../apps/api/src/index";
import { postgresWireBudget } from "./postgres-wire-budget";

// Local disposable services only. No inference worker or paid provider calls.
// OPENGENI_BENCH_SAMPLES=20 OPENGENI_BENCH_OUTPUT=/path/result.json bun ...
// Statement counts are not wire round trips: cold prepared queries may describe
// before binding. CPU is the API process, not PostgreSQL or Temporal CPU.
type Sample = {
  route: string;
  ms: number;
  cpuMs: number;
  statements: number;
  transactions: number;
  savepoints: number;
  wireResponseCycles: number;
  wireDescribes: number;
  phases: Record<string, number>;
  queries: Record<string, number>;
  timeline?: { atMs: number; query: string }[];
};
const count = Number(process.env.OPENGENI_BENCH_SAMPLES ?? "15");
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("Invalid samples");
const lineageSize = Number(process.env.OPENGENI_BENCH_LINEAGE_SIZE ?? "0");
if (!Number.isInteger(lineageSize) || lineageSize < 0 || lineageSize > 200)
  throw new Error("Invalid lineage fixture size");
const activeSample = new AsyncLocalStorage<Sample>();
const samples: Sample[] = [];
const services = await startTestServices();
let client: ReturnType<typeof createDb> | undefined;
let bus: Awaited<ReturnType<typeof createNatsEventBus>> | undefined;
let workflows: Awaited<ReturnType<typeof createTemporalWorkflowClient>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let currentWireSample: Sample | undefined;
const relay = createServer((frontend) => {
  const backend = createConnection({ host: "127.0.0.1", port: services.postgresPort });
  const countFrames = postgresWireBudget((type) => {
    if (currentWireSample) {
      currentWireSample.wireResponseCycles++;
      if (type === "H") currentWireSample.wireDescribes++;
    }
  });
  frontend.on("data", countFrames);
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
try {
  await services.migrate();
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayAddress = relay.address();
  if (!relayAddress || typeof relayAddress === "string") throw new Error("No local relay");
  const databaseUrl = new URL(services.runtimeDatabaseUrl);
  databaseUrl.port = String(relayAddress.port);
  const settings = testSettings({
    databaseUrl: databaseUrl.href,
    natsUrl: services.natsUrl,
    temporalHost: services.temporalHost,
    sandboxBackend: "none",
    productAccessMode: "managed",
    delegationSecret: "resource-benchmark-local-delegation-secret",
  });
  client = createDb(settings.databaseUrl, { max: settings.apiDatabasePoolMax });
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const phaseBySpan = new Map<string, string>();
  driver.options.debug = (_connection, query) => {
    // A queued pool BEGIN can execute from an earlier request's async context.
    // This isolated harness issues one measured request at a time, so the wire
    // owner is authoritative even when that stale context is still present.
    const sample = currentWireSample;
    if (!sample) return;
    sample.statements++;
    const verb = query.trim().split(/\s+/u)[0]?.toLowerCase();
    if (verb === "begin") sample.transactions++;
    if (verb === "savepoint") sample.savepoints++;
    const phase = phaseBySpan.get(currentTraceContext()?.spanId ?? "") ?? "other";
    sample.phases[phase] = (sample.phases[phase] ?? 0) + 1;
    // Driver debug text is parameterized; never retain parameters or requests.
    const key = query.replace(/\s+/gu, " ").slice(0, 300);
    sample.queries[key] = (sample.queries[key] ?? 0) + 1;
    sample.timeline?.push({ atMs: performance.now(), query: key });
  };
  const observability = createObservability(settings, { component: "api" });
  const startSpan = observability.startSpan.bind(observability);
  observability.startSpan = (name, ...args) => {
    const span = startSpan(name, ...args);
    phaseBySpan.set(span.spanId, name);
    return {
      ...span,
      end: (input) => {
        phaseBySpan.delete(span.spanId);
        span.end(input);
      },
    };
  };
  bus = await createNatsEventBus(settings.natsUrl);
  workflows = await createTemporalWorkflowClient(settings, client.db);
  const app = createApp({
    settings,
    db: client.db,
    bus,
    workflowClient: workflows.client,
    observability,
  });
  const byRequest = new Map<string, Sample>();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Match the production API listener so its 15-second SSE heartbeat is not
    // cut off by Bun's shorter default idle timeout in this local fixture.
    idleTimeout: 255,
    fetch: (request) => {
      const sample = byRequest.get(request.headers.get("x-benchmark-request") ?? "");
      return sample ? activeSample.run(sample, () => app.fetch(request)) : app.fetch(request);
    },
  });
  for (let index = -2; index < count; index++) {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "resource-benchmark",
      accountExternalId: crypto.randomUUID(),
      accountName: "Resource benchmark",
      workspaceExternalSource: "resource-benchmark",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Resource benchmark",
      subjectId: `benchmark:${crypto.randomUUID()}`,
    });
    const grant = access.workspaceGrants[0]!;
    const token = await signDelegatedAccessToken(settings.delegationSecret!, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      permissions: ["sessions:create", "sessions:read", "sessions:control", "goals:manage"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const request = async (route: string, path: string, body?: unknown) => {
      const id = crypto.randomUUID();
      const sample: Sample = {
        route,
        ms: 0,
        cpuMs: 0,
        statements: 0,
        transactions: 0,
        savepoints: 0,
        wireResponseCycles: 0,
        wireDescribes: 0,
        phases: {},
        queries: {},
      };
      byRequest.set(id, sample);
      currentWireSample = sample;
      const started = performance.now();
      const cpu = process.cpuUsage();
      const response = await fetch(new URL(path, server!.url), {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-benchmark-request": id,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      sample.ms = performance.now() - started;
      const used = process.cpuUsage(cpu);
      sample.cpuMs = (used.user + used.system) / 1000;
      byRequest.delete(id);
      currentWireSample = undefined;
      if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(result)}`);
      if (index >= 0) samples.push(sample);
      return result as { id: string };
    };
    const prefix = `/v1/workspaces/${grant.workspaceId}`;
    const session = await request("create", `${prefix}/sessions`, {
      initialMessage: "Benchmark",
      sandboxBackend: "none",
    });
    if (lineageSize > 0) {
      const root = await getSession(client.db, grant.workspaceId, session.id);
      if (!root?.agent) throw new Error("Lineage fixture requires a configured agent");
      for (let child = 0; child < lineageSize; child++) {
        await createSession(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          parentSessionId: root.id,
          initialMessage: "Synthetic child",
          resources: [],
          metadata: {},
          model: root.model,
          reasoningEffort: root.reasoningEffort,
          latencyMode: root.latencyMode,
          sandboxBackend: "none",
          agentConfig: root.agent,
        });
      }
      await request("lineage", `${prefix}/sessions/${session.id}/lineage`);
      continue;
    }
    await request("get", `${prefix}/sessions/${session.id}`);
    await request("list", `${prefix}/sessions`);
    await request(
      "list-summary-roots",
      `${prefix}/sessions?view=page&projection=summary&limit=4&parentSessionId=null&includePinned=false&includeTotals=true&sortBy=updatedAt&archiveStatus=active`,
    );
    await request(
      "list-summary-pins",
      `${prefix}/sessions?view=page&projection=summary&limit=1&pinsOnly=true`,
    );
    await request(
      "list-summary-project",
      `${prefix}/sessions?view=page&projection=summary&limit=4&parentSessionId=null&channelId=null&includePinned=false&sortBy=updatedAt&archiveStatus=active`,
    );
    await request("events-poll", `${prefix}/sessions/${session.id}/events?after=0`);
    await request("draft", `${prefix}/new-session-draft`);
    if (process.env.OPENGENI_BENCH_IDLE_STREAM === "1" && index === count - 1) {
      const after = await getSessionEventSequence(client.db, grant.workspaceId, session.id);
      const id = crypto.randomUUID();
      const started = performance.now();
      const cpu = process.cpuUsage();
      const sample: Sample = {
        route: "idle-stream-32s",
        ms: 0,
        cpuMs: 0,
        statements: 0,
        transactions: 0,
        savepoints: 0,
        wireResponseCycles: 0,
        wireDescribes: 0,
        phases: {},
        queries: {},
        timeline: [],
      };
      byRequest.set(id, sample);
      currentWireSample = sample;
      const abort = new AbortController();
      // Measurement window only; this does not change application deadlines.
      const stop = setTimeout(() => abort.abort(), 32_000);
      try {
        const response = await fetch(
          new URL(`${prefix}/sessions/${session.id}/events/stream?after=${after}`, server!.url),
          {
            headers: { authorization: `Bearer ${token}`, "x-benchmark-request": id },
            signal: abort.signal,
          },
        );
        if (!response.ok) throw new Error(`Idle stream: ${response.status}`);
        const reader = response.body!.getReader();
        while (!(await reader.read()).done) {
          /* drain heartbeats */
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        clearTimeout(stop);
        abort.abort();
        byRequest.delete(id);
        currentWireSample = undefined;
        sample.ms = performance.now() - started;
        const used = process.cpuUsage(cpu);
        sample.cpuMs = (used.user + used.system) / 1000;
        for (const entry of sample.timeline!) entry.atMs -= started;
        samples.push(sample);
      }
      if (sample.ms < 31_000) throw new Error("Idle stream closed before the measurement window");
    }
  }
  const percentile = (values: number[], p: number) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
  const summary = Object.fromEntries(
    [...new Set(samples.map((s) => s.route))].map((route) => {
      const rows = samples.filter((s) => s.route === route);
      return [
        route,
        {
          samples: rows.length,
          p50Ms: percentile(
            rows.map((s) => s.ms),
            0.5,
          ),
          p95Ms: percentile(
            rows.map((s) => s.ms),
            0.95,
          ),
          p50CpuMs: percentile(
            rows.map((s) => s.cpuMs),
            0.5,
          ),
          statements: percentile(
            rows.map((s) => s.statements),
            0.5,
          ),
          transactions: percentile(
            rows.map((s) => s.transactions),
            0.5,
          ),
          savepoints: percentile(
            rows.map((s) => s.savepoints),
            0.5,
          ),
          phases: rows[0]!.phases,
          wireResponseCycles: percentile(
            rows.map((s) => s.wireResponseCycles),
            0.5,
          ),
          wireDescribes: percentile(
            rows.map((s) => s.wireDescribes),
            0.5,
          ),
        },
      ];
    }),
  );
  const result = {
    generatedAt: new Date().toISOString(),
    summary,
    memory: process.memoryUsage(),
    samples,
  };
  if (process.env.OPENGENI_BENCH_OUTPUT)
    await Bun.write(process.env.OPENGENI_BENCH_OUTPUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ summary, memory: result.memory }, null, 2));
  await observability.flush();
} finally {
  server?.stop(true);
  await workflows?.close();
  await bus?.close();
  await client?.close();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await services.down();
}
// Imported API modules may own process-lifetime timers. All benchmark resources
// have been closed above; do not keep a disposable operator process alive.
process.exit(0);
