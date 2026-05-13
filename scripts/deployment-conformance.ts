import { spawnSync } from "node:child_process";

interface Args {
  baseUrl: string;
  timeoutSeconds: number;
  agentMessage: string;
  sandboxBackend: string | null;
  objectConnectTo: string | null;
  skipAgent: boolean;
  skipStorage: boolean;
  skipObservability: boolean;
  skipScheduledTasks: boolean;
  json: boolean;
}

interface CheckResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
}

const args = parseArgs(process.argv.slice(2));
const results: CheckResult[] = [];

await runCheck("api-health", async () => {
  const health = await getJson(new URL("/healthz", args.baseUrl));
  if (health?.ok !== true) {
    throw new Error(`unexpected health response: ${JSON.stringify(health)}`);
  }
  return `service=${String(health.service ?? "unknown")} environment=${String(health.environment ?? "unknown")}`;
});

if (args.skipObservability) {
  results.push(skipped("observability", "--skip-observability was set"));
} else {
  await runCheck("observability", async () => {
    const metrics = await getText(new URL("/metrics", args.baseUrl));
    for (const required of ["opengeni_http_requests_total", "opengeni_http_request_duration_seconds_bucket"]) {
      if (!metrics.includes(required)) {
        throw new Error(`/metrics did not include ${required}`);
      }
    }
    return "Prometheus metrics endpoint exposed request counters and duration buckets";
  });
}

let sessionId: string | null = null;
if (args.skipAgent) {
  results.push(skipped("session-run", "--skip-agent was set"));
  results.push(skipped("event-replay", "--skip-agent was set"));
  results.push(skipped("sse-replay", "--skip-agent was set"));
  results.push(skipped("scheduled-task", "--skip-agent was set"));
} else {
  await runCheck("session-run", async () => {
    const payload: Record<string, unknown> = {
      initialMessage: args.agentMessage,
      metadata: { conformance: true },
    };
    if (args.sandboxBackend) {
      payload.sandboxBackend = args.sandboxBackend;
    }
    const session = await postJson(new URL("/v1/sessions", args.baseUrl), payload);
    sessionId = stringField(session, "id");
    const deadline = Date.now() + args.timeoutSeconds * 1000;
    let lastStatus = stringField(session, "status");
    while (Date.now() < deadline) {
      const current = await getJson(new URL(`/v1/sessions/${sessionId}`, args.baseUrl));
      lastStatus = stringField(current, "status");
      if (["idle", "failed", "cancelled"].includes(lastStatus)) {
        break;
      }
      await sleep(2_000);
    }
    if (lastStatus !== "idle") {
      throw new Error(`session ${sessionId} ended with status ${lastStatus}`);
    }
    return `session ${sessionId} reached idle`;
  });

  await runCheck("event-replay", async () => {
    const events = await getJson(new URL(`/v1/sessions/${sessionId}/events?limit=200`, args.baseUrl));
    if (!Array.isArray(events)) {
      throw new Error("events response was not an array");
    }
    const types = events.map((event) => event?.type);
    for (const required of ["session.created", "turn.started", "agent.message.completed", "turn.completed"]) {
      if (!types.includes(required)) {
        throw new Error(`missing event type ${required}`);
      }
    }
    return `${events.length} persisted events replayed`;
  });

  await runCheck("sse-replay", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(new URL(`/v1/sessions/${sessionId}/events/stream?after=0`, args.baseUrl), {
      signal: controller.signal,
    });
    const text = await readStreamUntilAbort(response, controller.signal);
    clearTimeout(timeout);
    if (!text.includes("event: session.created") || !text.includes("event: turn.completed")) {
      throw new Error("SSE replay did not include expected session and turn events");
    }
    return `${text.split(/\r?\n/).filter(Boolean).length} non-empty SSE lines`;
  });

  if (args.skipScheduledTasks) {
    results.push(skipped("scheduled-task", "--skip-scheduled-tasks was set"));
  } else {
    await runCheck("scheduled-task", async () => {
      const task = await postJson(new URL("/v1/scheduled-tasks", args.baseUrl), {
        name: `conformance-${crypto.randomUUID()}`,
        status: "paused",
        schedule: {
          type: "once",
          runAt: new Date(Date.now() + 86_400_000).toISOString(),
          timeZone: "UTC",
        },
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          prompt: args.agentMessage,
          resources: [],
          tools: [],
          metadata: { conformance: true },
          ...(args.sandboxBackend ? { sandboxBackend: args.sandboxBackend } : {}),
        },
        metadata: { conformance: true },
      });
      const taskId = stringField(task, "id");
      try {
        await postJson(new URL(`/v1/scheduled-tasks/${taskId}/trigger`, args.baseUrl), {});
        const deadline = Date.now() + args.timeoutSeconds * 1000;
        let runSessionId: string | null = null;
        while (Date.now() < deadline) {
          const runs = await getJson(new URL(`/v1/scheduled-tasks/${taskId}/runs?limit=5`, args.baseUrl));
          if (!Array.isArray(runs)) {
            throw new Error("scheduled task runs response was not an array");
          }
          const run = runs.find((item) => item?.status === "dispatched" && typeof item?.sessionId === "string");
          if (run) {
            runSessionId = run.sessionId;
            break;
          }
          await sleep(1_000);
        }
        if (!runSessionId) {
          throw new Error(`scheduled task ${taskId} did not dispatch a session`);
        }
        let status = "unknown";
        while (Date.now() < deadline) {
          const current = await getJson(new URL(`/v1/sessions/${runSessionId}`, args.baseUrl));
          status = stringField(current, "status");
          if (["idle", "failed", "cancelled"].includes(status)) {
            break;
          }
          await sleep(2_000);
        }
        if (status !== "idle") {
          throw new Error(`scheduled task session ${runSessionId} ended with status ${status}`);
        }
        return `task ${taskId} dispatched session ${runSessionId}`;
      } finally {
        await deleteJson(new URL(`/v1/scheduled-tasks/${taskId}`, args.baseUrl)).catch(() => undefined);
      }
    });
  }
}

if (args.skipStorage) {
  results.push(skipped("object-storage", "--skip-storage was set"));
} else {
  await runCheck("object-storage", async () => {
    const content = `opengeni conformance ${crypto.randomUUID()}`;
    const upload = await postJson(new URL("/v1/files/uploads", args.baseUrl), {
      filename: "conformance.txt",
      contentType: "text/plain",
      sizeBytes: new TextEncoder().encode(content).byteLength,
    });
    const putUrl = stringField(upload, "putUrl");
    const uploadId = stringField(upload, "uploadId");
    const fileId = stringField(upload, "fileId");
    const headers = recordField(upload, "requiredHeaders");
    await putObject(putUrl, content, headers, args.objectConnectTo);
    await postJson(new URL(`/v1/files/uploads/${uploadId}/complete`, args.baseUrl), {});
    const download = await postJson(new URL(`/v1/files/${fileId}/download-url`, args.baseUrl), {});
    const downloaded = await getObject(stringField(download, "url"), args.objectConnectTo);
    if (downloaded !== content) {
      throw new Error("downloaded object did not match uploaded content");
    }
    return `file ${fileId} uploaded and downloaded`;
  });
}

if (args.json) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  console.log("OpenGeni deployment conformance");
  for (const result of results) {
    console.log(`  - ${result.id}: ${result.status} - ${result.detail}`);
  }
}

if (results.some((result) => result.status === "failed")) {
  process.exit(1);
}

async function runCheck(id: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ id, status: "passed", detail: await fn() });
  } catch (error) {
    results.push({ id, status: "failed", detail: errorMessage(error) });
  }
}

async function getJson(url: URL): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }
  return await response.json();
}

async function getText(url: URL): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }
  return await response.text();
}

async function postJson(url: URL, payload: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function deleteJson(url: URL): Promise<any> {
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function putObject(url: string, content: string, headers: Record<string, string>, connectTo: string | null): Promise<void> {
  if (connectTo) {
    runCurl(["-fsS", "-X", "PUT", url, "--connect-to", connectTo, ...headerArgs(headers), "--data-binary", "@-"], content);
    return;
  }
  const response = await fetch(url, {
    method: "PUT",
    headers,
    body: content,
  });
  if (!response.ok) {
    throw new Error(`object PUT returned HTTP ${response.status}: ${await response.text()}`);
  }
}

async function getObject(url: string, connectTo: string | null): Promise<string> {
  if (connectTo) {
    return runCurl(["-fsS", url, "--connect-to", connectTo]);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`object GET returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.text();
}

async function readStreamUntilAbort(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.ok) {
    throw new Error(`SSE stream returned HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("SSE stream did not include a body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!signal.aborted) {
    try {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      text += decoder.decode(result.value, { stream: true });
      if (text.includes("event: session.created") && text.includes("event: turn.completed")) {
        break;
      }
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      throw error;
    }
  }
  await reader.cancel().catch(() => undefined);
  return text + decoder.decode();
}

function runCurl(args: string[], input?: string): string {
  const result = spawnSync("curl", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `curl exited ${result.status}`).trim());
  }
  return result.stdout;
}

function headerArgs(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([key, value]) => ["-H", `${key}: ${value}`]);
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    baseUrl: process.env.OPENGENI_CONFORMANCE_BASE_URL ?? "",
    timeoutSeconds: Number(process.env.OPENGENI_CONFORMANCE_TIMEOUT_SECONDS ?? 180),
    agentMessage: process.env.OPENGENI_CONFORMANCE_AGENT_MESSAGE ?? "Reply with exactly: opengeni conformance ok",
    sandboxBackend: process.env.OPENGENI_CONFORMANCE_SANDBOX_BACKEND ?? "none",
    objectConnectTo: process.env.OPENGENI_CONFORMANCE_OBJECT_CONNECT_TO ?? null,
    skipAgent: false,
    skipStorage: false,
    skipObservability: false,
    skipScheduledTasks: false,
    json: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") {
      out.json = true;
      continue;
    }
    if (value === "--skip-agent") {
      out.skipAgent = true;
      continue;
    }
    if (value === "--skip-storage") {
      out.skipStorage = true;
      continue;
    }
    if (value === "--skip-observability") {
      out.skipObservability = true;
      continue;
    }
    if (value === "--skip-scheduled-tasks") {
      out.skipScheduledTasks = true;
      continue;
    }
    if (value === "--base-url") {
      out.baseUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--timeout-seconds") {
      out.timeoutSeconds = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--agent-message") {
      out.agentMessage = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--sandbox-backend") {
      const next = requiredNext(values, ++index, value);
      out.sandboxBackend = next === "default" ? null : next;
      continue;
    }
    if (value === "--object-connect-to") {
      out.objectConnectTo = requiredNext(values, ++index, value);
      continue;
    }
    if (value.startsWith("--base-url=")) {
      out.baseUrl = value.slice("--base-url=".length);
      continue;
    }
    if (value.startsWith("--object-connect-to=")) {
      out.objectConnectTo = value.slice("--object-connect-to=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!out.baseUrl) {
    throw new Error("Set --base-url or OPENGENI_CONFORMANCE_BASE_URL");
  }
  if (!Number.isFinite(out.timeoutSeconds) || out.timeoutSeconds <= 0) {
    throw new Error("--timeout-seconds must be a positive number");
  }
  return out;
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

function stringField(value: any, key: string): string {
  const field = value?.[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`response missing string field ${key}`);
  }
  return field;
}

function recordField(value: any, key: string): Record<string, string> {
  const field = value?.[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`response missing object field ${key}`);
  }
  return Object.fromEntries(Object.entries(field).map(([entryKey, entryValue]) => [entryKey, String(entryValue)]));
}

function skipped(id: string, detail: string): CheckResult {
  return { id, status: "skipped", detail };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
