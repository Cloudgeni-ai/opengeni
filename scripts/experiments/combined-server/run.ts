// EXPERIMENT ONLY. Local fixtures, deterministic inference, real service boundaries.
import { openSync, closeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import * as z from "zod/v4";
import postgres from "postgres";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";

const require = createRequire(new URL("../../../packages/testing/package.json", import.meta.url));
const { McpServer } = await import(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const { WebStandardStreamableHTTPServerTransport } = await import(
  require.resolve("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js")
);

const root = resolve(import.meta.dir, "../../..");
const state = resolve(import.meta.dir, ".state");
const stack = await Bun.file(`${state}/stack.json`).json();
const infrastructurePidOutput = Bun.spawnSync([
  "docker",
  "inspect",
  "--format",
  "{{.State.Pid}}",
  ...["postgres", "nats", "temporal", "garage"].map((role) => `${stack.projectName}-${role}-1`),
]);
if (infrastructurePidOutput.exitCode !== 0)
  throw new Error("Experiment infrastructure is unavailable");
const infrastructureRoots = infrastructurePidOutput.stdout
  .toString()
  .trim()
  .split("\n")
  .map(Number);
const runtime = `${root}/.opengeni/artifact-runtime-development`;
const roles = ["control", "turn", "materializer", "outbox", "api", "web"];
const results: unknown[] = [];
const repeats = Number(process.env.EXPERIMENT_REPEATS ?? 3);
const layouts = process.env.EXPERIMENT_LAYOUTS?.split(",") ?? ["split", "combined"];
const resultName = process.env.EXPERIMENT_RESULT_NAME ?? "results";
const fault = process.env.EXPERIMENT_FAULT;
await mkdir(state, { recursive: true });

async function freePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function until<T>(fn: () => Promise<T | null | false>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await Bun.sleep(100);
  }
  throw new Error(`Experiment condition timed out after ${timeoutMs}ms`);
}

for (let repeat = 0; repeat < repeats; repeat++) {
  for (const layout of repeat % 2 ? [...layouts].reverse() : layouts) {
    const ports = Object.fromEntries(
      await Promise.all(roles.map(async (role) => [role, await freePort()])),
    );
    const base = `http://127.0.0.1:${ports.api}`;
    let workspaceId: string;
    const toolReceipts: Array<Record<string, unknown>> = [];
    let fixtureError: Error | undefined;
    let idempotentRetries = 0;
    async function request(path: string, body?: unknown, attempt = 0): Promise<any> {
      const response = await fetch(`${base}${path}`, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers: {
          "content-type": "application/json",
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      // The same receipt key recovers even an outcome-unknown write. Never
      // retry a non-idempotent request or mint a new key after contention.
      if (
        response.status === 503 &&
        body &&
        typeof body === "object" &&
        "idempotencyKey" in body &&
        attempt < 5
      ) {
        const parsed = JSON.parse(text);
        if (parsed.error?.details?.code === "DATABASE_CONTENTION") {
          idempotentRetries++;
          await Bun.sleep(100 * (attempt + 1));
          return request(path, body, attempt + 1);
        }
      }
      if (!response.ok) {
        fixtureError = new Error(`${path}: ${response.status} ${text.slice(0, 2000)}`);
        throw fixtureError;
      }
      return JSON.parse(text);
    }
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      async fetch(req) {
        if (new URL(req.url).pathname.startsWith("/unused-provider/")) {
          const input = (await req.json()) as {
            stream?: boolean;
            input?: Array<{ type?: string }>;
            tools?: Array<{ name?: string }>;
          };
          const hasTool = input.tools?.some((tool) => tool.name === "tool_search");
          const outputCount =
            input.input?.filter((item) => item.type === "function_call_output").length ?? 0;
          const toolCompleted = outputCount >= 2;
          const id = `resp_${crypto.randomUUID()}`;
          const itemId = `item_${crypto.randomUUID()}`;
          const text = hasTool
            ? "Measured work completed. ".repeat(fault ? 150 : 30)
            : "Experiment spreadsheet";
          const output =
            hasTool && !toolCompleted
              ? [
                  {
                    type: "function_call",
                    id: itemId,
                    call_id: `call_${crypto.randomUUID()}`,
                    name: outputCount === 0 ? "tool_search" : "bench__make_sheet",
                    arguments: JSON.stringify(
                      outputCount === 0
                        ? { query: "", names: ["bench__make_sheet"] }
                        : { title: "Experiment sheet" },
                    ),
                    status: "completed",
                  },
                ]
              : [
                  {
                    type: "message",
                    id: itemId,
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text, annotations: [] }],
                  },
                ];
          const response = {
            id,
            object: "response",
            status: "completed",
            model: "local-fixture",
            output,
            usage: { input_tokens: 1000, output_tokens: 250, total_tokens: 1250 },
          };
          if (!input.stream) return Response.json(response);
          let cancelled = false;
          const stream = new ReadableStream({
            async start(controller) {
              const send = (event: unknown) =>
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
              try {
                send({
                  type: "response.created",
                  response: { ...response, status: "in_progress", output: [] },
                });
                send({ type: "response.output_item.added", output_index: 0, item: output[0] });
                if (toolCompleted)
                  for (const delta of text.match(/.{1,25}/g) ?? []) {
                    await Bun.sleep(100);
                    if (cancelled) return;
                    send({
                      type: "response.output_text.delta",
                      item_id: itemId,
                      output_index: 0,
                      content_index: 0,
                      delta,
                    });
                  }
                if (cancelled) return;
                send({ type: "response.output_item.done", output_index: 0, item: output[0] });
                send({ type: "response.completed", response });
                controller.close();
              } catch (error) {
                if (!cancelled) controller.error(error);
              }
            },
            cancel() {
              cancelled = true;
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        const server = new McpServer({ name: "experiment-artifact-tool", version: "1" });
        server.registerTool(
          "make_sheet",
          {
            description:
              "Create a durable spreadsheet and export it to XLSX in the local experiment.",
            inputSchema: { title: z.string() },
          },
          async ({ title }: { title: string }) => {
            const replicaId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
            const collection = `/v1/workspaces/${workspaceId}/editable-artifacts`;
            const artifact = await request(collection, {
              modality: "spreadsheet",
              title,
              replicaId,
              idempotencyKey: crypto.randomUUID(),
            });
            const item = `${collection}/${artifact.id}`;
            const version = await request(`${item}/versions`, {
              replicaId,
              idempotencyKey: crypto.randomUUID(),
              name: "Experiment version",
            });
            const job = await request(`${item}/materializations`, {
              replicaId,
              idempotencyKey: crypto.randomUUID(),
              versionId: version.id,
              format: "xlsx",
            });
            const completed = await until(async () => {
              const current = await request(
                `${item}/materializations/${job.id}?replicaId=${replicaId}`,
              );
              if (current.state === "failed")
                throw new Error(`Materialization failed: ${JSON.stringify(current)}`);
              return current.state === "succeeded" ? current : null;
            });
            const download = await fetch(
              `${base}${item}/materializations/${job.id}/download?replicaId=${replicaId}`,
            );
            if (!download.ok) throw new Error(`Download failed ${download.status}`);
            const bytes = new Uint8Array(await download.arrayBuffer());
            if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
              throw new Error("XLSX has no ZIP signature");
            const receipt = {
              artifactId: artifact.id,
              jobId: job.id,
              bytes: bytes.byteLength,
              state: completed.state,
            };
            toolReceipts.push(receipt);
            return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }] };
          },
        );
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);
        return transport.handleRequest(req);
      },
    });
    const env = {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      TMPDIR: `${state}/tmp`,
      EXPERIMENT_DIAGNOSTICS: process.env.EXPERIMENT_DIAGNOSTICS ?? "false",
      EXPERIMENT_BLOCK_MS: process.env.EXPERIMENT_BLOCK_MS ?? "0",
      EXPERIMENT_STREAM_CHUNKS: fault ? "150" : "30",
      EXPERIMENT_FAULT: fault ?? "",
      EXPERIMENT_HTTP_MODEL: process.env.EXPERIMENT_HTTP_MODEL ?? "false",
      NODE_ENV: "development",
      OPENGENI_ENVIRONMENT: "local",
      OPENGENI_DATABASE_URL: stack.runtimeDatabaseUrl,
      OPENGENI_NATS_URL: stack.natsUrl,
      OPENGENI_TEMPORAL_HOST: stack.temporalHost,
      OPENGENI_TEMPORAL_TASK_QUEUE: "experiment-combined-server",
      OPENGENI_API_HOST: "127.0.0.1",
      OPENGENI_API_PORT: String(ports.api),
      OPENGENI_PUBLIC_BASE_URL: base,
      OPENGENI_WEB_BASE_URL: `http://127.0.0.1:${ports.web}`,
      OPENGENI_MCP_URL: `${base}/mcp`,
      OPENGENI_DELEGATION_SECRET: "local-experiment-not-a-secret",
      OPENGENI_SANDBOX_BACKEND: "none",
      OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "false",
      OPENGENI_OPENAI_API_KEY: "local-experiment-not-a-secret",
      OPENGENI_OPENAI_BASE_URL: `http://127.0.0.1:${fixture.port}/unused-provider`,
      OPENGENI_MCP_SERVERS: JSON.stringify([
        {
          id: "bench",
          name: "Experiment",
          url: `http://127.0.0.1:${fixture.port}/mcp`,
          allowedTools: ["make_sheet"],
          cacheToolsList: false,
        },
      ]),
      OPENGENI_OBJECT_STORAGE_BACKEND: "s3-compatible",
      OPENGENI_OBJECT_STORAGE_ENDPOINT: stack.objectStorageEndpoint,
      OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
      OPENGENI_OBJECT_STORAGE_REGION: "us-east-1",
      OPENGENI_OBJECT_STORAGE_S3_PROVIDER: stack.objectStorageS3Provider,
      OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: stack.objectStorageAccessKeyId,
      OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: stack.objectStorageSecretAccessKey,
      OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
      OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST: `${runtime}/installation.development.json`,
      OPENGENI_ARTIFACT_TOOL_ENTRY: `${runtime}/skill-facade-entry.mjs`,
      OPENGENI_ARTIFACT_MATERIALIZER_EXECUTABLE: `${runtime}/opengeni-artifact-materializer`,
      OPENGENI_ARTIFACT_LOCAL_DEVELOPMENT: "true",
      OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT: "true",
      OPENGENI_ARTIFACT_MATERIALIZER_HTTP_HOST: "127.0.0.1",
      OPENGENI_ARTIFACT_MATERIALIZER_ENABLED: "true",
      OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED: "true",
      OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL: `postgres://opengeni_artifact_materializer:experiment@127.0.0.1:${stack.postgresPort}/opengeni`,
      OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE: "opengeni_artifact_materializer",
      OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT: String(ports.materializer),
      OPENGENI_ARTIFACT_OUTBOX_ENABLED: "true",
      OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL: `postgres://opengeni_artifact_outbox_dispatcher:experiment@127.0.0.1:${stack.postgresPort}/opengeni`,
      OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE: "opengeni_artifact_outbox_dispatcher",
      OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT: String(ports.outbox),
      EXPERIMENT_CONTROL_PORT: String(ports.control),
      EXPERIMENT_TURN_PORT: String(ports.turn),
      EXPERIMENT_WEB_PORT: String(ports.web),
      EXPERIMENT_WEB_ROOT: `${root}/apps/web/dist`,
    };
    const children: Array<ReturnType<typeof Bun.spawn>> = [];
    const handles: number[] = [];
    const samples: Array<{
      phase: string;
      elapsedMs: number;
      rssMiB: number;
      infrastructureRssMiB: number;
      processes: Record<string, number>;
      apiMs: number | null;
    }> = [];
    let phase = "starting";
    let faultReceipt: Record<string, unknown> | undefined;
    let sampling = true;
    const start = performance.now();
    const processRoles =
      layout === "combined"
        ? ["combined"]
        : layout === "workers"
          ? ["workers", "materializer", "outbox", "api", "web"]
          : roles;
    for (const role of processRoles) {
      const fd = openSync(`${state}/${layout}-${repeat}-${role}.log`, "w");
      handles.push(fd);
      const entry =
        process.env.EXPERIMENT_BUNDLED === "true"
          ? `${import.meta.dir}/dist/host.js`
          : `${import.meta.dir}/host.ts`;
      const stockEntries: Record<string, string> = {
        api: "apps/api/dist/process/index.js",
        control: "apps/worker/dist/process/index.js",
        turn: "apps/worker/dist/process/index.js",
        materializer:
          "apps/worker/dist/process/artifact-materializer/artifact-materializer-entry.js",
        outbox: "apps/worker/dist/process/artifact-outbox/artifact-outbox-entry.js",
        web: "apps/web/src/server.ts",
      };
      const childEnvironment = {
        ...env,
        OPENGENI_WORKER_ROLE: role,
        OPENGENI_WORKER_HTTP_PORT: String(ports[role] ?? ports.control),
        PORT: String(ports.web),
        HOST: "127.0.0.1",
      };
      const stockRole = layout === "stock" || (layout === "workers" && role !== "workers");
      children.push(
        Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            stockRole ? `${root}/${stockEntries[role]}` : entry,
            role,
          ],
          {
            cwd: root,
            env: childEnvironment,
            stdout: fd,
            stderr: fd,
            stdin: "ignore",
          },
        ),
      );
    }
    await Bun.write(
      `${state}/active.json`,
      JSON.stringify({ pids: children.map((p) => p.pid), ports }),
    );
    const sampler = (async () => {
      // The trial's finally block stops this concurrent sampler.
      // eslint-disable-next-line no-unmodified-loop-condition
      while (sampling) {
        const output = Bun.spawnSync(["ps", "-e", "-o", "pid=,ppid=,rss="], { stdout: "pipe" });
        const rows = output.stdout
          .toString()
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number));
        const owned = new Set(children.map((child) => child.pid));
        const infrastructure = new Set(infrastructureRoots);
        for (let changed = true; changed;) {
          changed = false;
          for (const [pid, ppid] of rows)
            if (owned.has(ppid!) && !owned.has(pid!)) {
              owned.add(pid!);
              changed = true;
            }
          for (const [pid, ppid] of rows)
            if (infrastructure.has(ppid!) && !infrastructure.has(pid!)) {
              infrastructure.add(pid!);
              changed = true;
            }
        }
        const processes: Record<string, number> = Object.fromEntries(
          rows.filter(([pid]) => owned.has(pid!)).map(([pid, , rss]) => [pid, rss! / 1024]),
        );
        let apiMs: number | null = null;
        const requestStart = performance.now();
        try {
          const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
          await response.arrayBuffer();
          if (response.ok) apiMs = performance.now() - requestStart;
        } catch {
          /* A starting or stopped API is not ready. */
        }
        const infrastructureRssMiB = rows
          .filter(([pid]) => infrastructure.has(pid!))
          .reduce((sum, [, , rss]) => sum + rss! / 1024, 0);
        samples.push({
          phase,
          elapsedMs: performance.now() - start,
          rssMiB: Object.values(processes).reduce((a, b) => a + b, 0),
          infrastructureRssMiB,
          processes,
          apiMs,
        });
        await Bun.sleep(250);
      }
    })();
    try {
      await until(async () => {
        for (const child of children)
          if (child.exitCode !== null)
            throw new Error(`Host ${child.pid} exited ${child.exitCode}; see local logs`);
        const statuses = await Promise.all(
          roles.map(async (role) => {
            try {
              const res = await fetch(
                `http://127.0.0.1:${ports[role]}${role === "web" ? "/" : "/readyz"}`,
                { signal: AbortSignal.timeout(2000) },
              );
              await res.arrayBuffer();
              return res.ok;
            } catch {
              return false;
            }
          }),
        );
        return statuses.every(Boolean);
      }, 180_000);
      const readyMs = performance.now() - start;
      console.log(JSON.stringify({ layout, repeat, readyMs }));
      workspaceId = (await request("/v1/access/me")).defaultWorkspaceId;
      phase = "idle";
      await Bun.sleep(Number(process.env.EXPERIMENT_IDLE_MS ?? 20_000));
      if (process.env.EXPERIMENT_IDLE_ONLY === "true") {
        results.push({ layout, repeat, readyMs, samples });
        await Bun.write(`${state}/${resultName}.json`, JSON.stringify(results, null, 2));
        continue;
      }
      if (layout === "stock" && env.EXPERIMENT_HTTP_MODEL !== "true")
        throw new Error("Stock-entry load requires the local HTTP model fixture");
      phase = "load";
      const loadStart = performance.now();
      const sessions = await Promise.all(
        Array.from({ length: 4 }, async (_, i) => {
          const created = await request(`/v1/workspaces/${workspaceId}/sessions`, {
            initialMessage: `Create and export an experiment spreadsheet ${i}.`,
            tools: [{ kind: "mcp", id: "bench" }],
            sandboxBackend: "none",
            bundledSkillIds: [],
            memoryScope: "off",
          });
          return created.session?.id ?? created.id;
        }),
      );
      if (fault) {
        const audit = postgres(stack.databaseUrl, { max: 1 });
        try {
          await until(async () => {
            if (fixtureError) throw fixtureError;
            const rows =
              await audit`select count(*)::int as count from session_events where session_id in ${audit(sessions)} and type = 'agent.toolCall.output'`;
            return rows[0]?.count === 4;
          });
        } finally {
          await audit.end();
        }
        const index = layout === "split" ? roles.indexOf("turn") : 0;
        const victim = children[index]!;
        victim.kill(fault === "crash" ? "SIGKILL" : fault === "rejection" ? "SIGUSR1" : "SIGTERM");
        if (fault === "rejection") await Bun.sleep(2000);
        else await victim.exited;
        const apiSurvived = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) })
          .then((r) => r.ok)
          .catch(() => false);
        faultReceipt = {
          fault,
          apiSurvived,
          processExited: victim.exitCode !== null,
          exitCode: victim.exitCode,
        };
        console.log(JSON.stringify({ layout, ...faultReceipt }));
        if (victim.exitCode !== null) {
          const fd = openSync(`${state}/${layout}-${repeat}-restarted.log`, "w");
          handles.push(fd);
          const entry =
            process.env.EXPERIMENT_BUNDLED === "true"
              ? `${import.meta.dir}/dist/host.js`
              : `${import.meta.dir}/host.ts`;
          children[index] = Bun.spawn(
            [process.execPath, "--no-env-file", entry, processRoles[index]!],
            { cwd: root, env, stdout: fd, stderr: fd, stdin: "ignore" },
          );
          await until(async () =>
            fetch(`${base}/readyz`)
              .then((r) => r.ok)
              .catch(() => false),
          );
        }
      }
      await until(
        async () => {
          if (fixtureError) throw fixtureError;
          const states = await Promise.all(
            sessions.map(async (id) => request(`/v1/workspaces/${workspaceId}/sessions/${id}`)),
          );
          if (states.some((value) => (value.session ?? value).status === "failed"))
            throw new Error(`Session failed: ${JSON.stringify(states).slice(0, 3000)}`);
          return (
            toolReceipts.length === 4 &&
            states.every((value) => ["idle", "completed"].includes((value.session ?? value).status))
          );
        },
        fault ? 360_000 : 180_000,
      );
      const loadMs = performance.now() - loadStart;
      phase = "settled";
      await Bun.sleep(5000);
      const audit = postgres(stack.databaseUrl, { max: 1 });
      let publishedHints = 0;
      try {
        const artifactIds = toolReceipts.map((receipt) => String(receipt.artifactId));
        publishedHints = await until(async () => {
          const rows =
            await audit`select state, count(*)::int as count from editable_artifact_live_outbox where artifact_id in ${audit(artifactIds)} group by state`;
          return rows.length === 1 && rows[0]?.state === "published" && rows[0].count >= 4
            ? (rows[0].count as number)
            : null;
        });
        const completions =
          await audit`select count(*)::int as count from session_events where session_id in ${audit(sessions)} and type = 'turn.completed'`;
        if (completions[0]?.count !== 4)
          throw new Error("Expected exactly four durable turn completions");
      } finally {
        await audit.end();
      }
      const result = {
        layout,
        repeat,
        readyMs,
        loadMs,
        idempotentRetries,
        publishedHints,
        faultReceipt,
        sessions,
        toolReceipts,
        samples,
      };
      results.push(result);
      await Bun.write(`${state}/${resultName}.json`, JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ layout, repeat, loadMs, completedTools: toolReceipts.length }));
    } finally {
      phase = "shutdown";
      const shutdownStart = performance.now();
      for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
      let ceiling: ReturnType<typeof setTimeout> | undefined;
      const exits = await Promise.race([
        Promise.all(children.map((child) => child.exited)),
        new Promise<null>((resolveTimeout) => {
          ceiling = setTimeout(() => resolveTimeout(null), 115_000);
        }),
      ]);
      clearTimeout(ceiling);
      if (!exits) for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
      sampling = false;
      await sampler;
      fixture.stop(true);
      handles.forEach(closeSync);
      const shutdown = { layout, repeat, shutdownMs: performance.now() - shutdownStart, exits };
      await Bun.write(
        `${state}/${layout}-${repeat}-samples.json`,
        JSON.stringify({ samples, shutdown }, null, 2),
      );
      const completed = results.at(-1) as Record<string, unknown> | undefined;
      if (completed?.layout === layout && completed.repeat === repeat) {
        completed.shutdown = shutdown;
        await Bun.write(`${state}/${resultName}.json`, JSON.stringify(results, null, 2));
      }
      console.log(JSON.stringify(shutdown));
    }
  }
}
console.log(`Results: ${state}/${resultName}.json`);
