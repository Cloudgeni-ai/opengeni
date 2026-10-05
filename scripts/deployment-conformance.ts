import { spawnSync } from "node:child_process";

interface Args {
  baseUrl: string;
  timeoutSeconds: number;
  agentMessage: string;
  model: string | null;
  sandboxBackend: string | null;
  objectConnectTo: string | null;
  browserOrigin: string | null;
  denyForeignBrowserOrigin: boolean;
  deploymentAccessKey: string | null;
  productToken: string | null;
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
let workspaceId: string | null = null;

await runCheck("api-health", async () => {
  const health = await getJson(new URL("/healthz", args.baseUrl));
  if (health?.ok !== true) {
    throw new Error(`unexpected health response: ${JSON.stringify(health)}`);
  }
  return `service=${String(health.service ?? "unknown")} environment=${String(health.environment ?? "unknown")}`;
});

await runCheck("access-boundary", async () => {
  const config = await getJson(new URL("/v1/config/client", args.baseUrl), { auth: false });
  const authMode = config?.auth?.mode ?? "unknown";
  if (authMode === "deploymentKey") {
    if (!args.deploymentAccessKey) {
      throw new Error(
        "client config requires x-opengeni-access-key; set OPENGENI_CONFORMANCE_DEPLOYMENT_ACCESS_KEY or --deployment-access-key",
      );
    }
    const response = await fetch(new URL("/v1/access/me", args.baseUrl));
    if (response.status !== 401) {
      throw new Error(
        `/v1/access/me without deployment access key returned HTTP ${response.status}, expected 401`,
      );
    }
    return "client config is secret-free and protected API routes reject missing deployment access keys";
  }
  if (authMode === "configuredToken") {
    if (!args.deploymentAccessKey && !args.productToken) {
      throw new Error(
        "configured-token auth requires --deployment-access-key or --product-token (OPENGENI_CONFORMANCE_DEPLOYMENT_ACCESS_KEY or OPENGENI_CONFORMANCE_PRODUCT_TOKEN)",
      );
    }
    const response = await fetch(new URL("/v1/access/me", args.baseUrl));
    if (response.status !== 401) {
      throw new Error(
        `/v1/access/me without conformance credentials returned HTTP ${response.status}, expected 401`,
      );
    }
    // The advertised mode does not distinguish shared-key bootstrap from an
    // explicit host signing root. Let the API authenticate the supplied key or
    // bearer; never synthesize a token or fall back after credential rejection.
    await getJson(new URL("/v1/access/me", args.baseUrl));
    return "configured-token routes reject anonymous access and authenticate supplied credentials; workspace discovery is checked separately";
  }
  if (args.deploymentAccessKey) {
    throw new Error(`deployment access key was provided, but client auth mode is ${authMode}`);
  }
  if (authMode === "managedSession") {
    return "client config advertises managed session auth; product API probes require a conformance product token";
  }
  return `client config auth mode is ${authMode}; deployment shared-key boundary is disabled`;
});

await runCheck("workspace-discovery", async () => {
  const context = await getJson(new URL("/v1/access/me", args.baseUrl));
  workspaceId = typeof context?.defaultWorkspaceId === "string" ? context.defaultWorkspaceId : null;
  if (!workspaceId) {
    const workspaces = await getJson(new URL("/v1/workspaces", args.baseUrl));
    const first = Array.isArray(workspaces)
      ? workspaces.find((workspace) => typeof workspace?.id === "string")
      : null;
    workspaceId = first?.id ?? null;
  }
  if (!workspaceId) {
    throw new Error(
      "/v1/access/me and /v1/workspaces did not expose a workspace id for conformance",
    );
  }
  return `workspace=${workspaceId}`;
});

if (args.skipObservability) {
  results.push(skipped("observability", "--skip-observability was set"));
} else {
  await runCheck("observability", async () => {
    const metrics = await getText(new URL("/metrics", args.baseUrl));
    for (const required of [
      "opengeni_http_requests_total",
      "opengeni_http_request_duration_seconds_bucket",
    ]) {
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
  results.push(skipped("mcp-tool-session", "--skip-agent was set"));
  results.push(skipped("scheduled-task", "--skip-agent was set"));
} else {
  await runCheck("session-run", async () => {
    const payload: Record<string, unknown> = {
      initialMessage: args.agentMessage,
      metadata: { conformance: true },
      ...(args.model ? { model: args.model } : {}),
    };
    if (args.sandboxBackend) {
      payload.sandboxBackend = args.sandboxBackend;
    }
    const session = await postJson(workspaceUrl("/sessions"), payload);
    sessionId = stringField(session, "id");
    const deadline = Date.now() + args.timeoutSeconds * 1000;
    let lastStatus = stringField(session, "status");
    while (Date.now() < deadline) {
      const current = await getJson(workspaceUrl(`/sessions/${sessionId}`));
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
    const events = await getJson(workspaceUrl(`/sessions/${sessionId}/events?limit=200`));
    if (!Array.isArray(events)) {
      throw new Error("events response was not an array");
    }
    const types = events.map((event) => event?.type);
    for (const required of [
      "session.created",
      "turn.started",
      "agent.message.completed",
      "turn.completed",
    ]) {
      if (!types.includes(required)) {
        throw new Error(`missing event type ${required}`);
      }
    }
    return `${events.length} persisted events replayed`;
  });

  await runCheck("sse-replay", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(workspaceUrl(`/sessions/${sessionId}/events/stream?after=0`), {
      headers: requestHeaders(true),
      signal: controller.signal,
    });
    const text = await readStreamUntilAbort(response, controller.signal);
    clearTimeout(timeout);
    if (!text.includes("event: session.created") || !text.includes("event: turn.completed")) {
      throw new Error("SSE replay did not include expected session and turn events");
    }
    return `${text.split(/\r?\n/).filter(Boolean).length} non-empty SSE lines`;
  });

  await runCheck("mcp-tool-session", async () => {
    const payload: Record<string, unknown> = {
      initialMessage: args.agentMessage,
      tools: [{ kind: "mcp", id: "opengeni" }],
      metadata: { conformance: true, mcpToolSession: true },
      ...(args.model ? { model: args.model } : {}),
    };
    if (args.sandboxBackend) {
      payload.sandboxBackend = args.sandboxBackend;
    }
    const session = await postJson(workspaceUrl("/sessions"), payload);
    const toolSessionId = stringField(session, "id");
    const status = await waitForTerminalSessionStatus(toolSessionId, args.timeoutSeconds);
    if (status !== "idle") {
      const events = await getJson(
        workspaceUrl(`/sessions/${toolSessionId}/events?limit=200`),
      ).catch(() => []);
      throw new Error(
        `session ${toolSessionId} with selected MCP tool ended with status ${status}${turnFailureSuffix(events)}`,
      );
    }
    return `session ${toolSessionId} reached idle with OpenGeni MCP selected`;
  });

  if (args.skipScheduledTasks) {
    results.push(skipped("scheduled-task", "--skip-scheduled-tasks was set"));
  } else {
    await runCheck("scheduled-task", async () => {
      const task = await postJson(workspaceUrl("/scheduled-tasks"), {
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
          ...(args.model ? { model: args.model } : {}),
          ...(args.sandboxBackend ? { sandboxBackend: args.sandboxBackend } : {}),
        },
        metadata: { conformance: true },
      });
      const taskId = stringField(task, "id");
      try {
        await postJson(workspaceUrl(`/scheduled-tasks/${taskId}/trigger`), {});
        const deadline = Date.now() + args.timeoutSeconds * 1000;
        let runSessionId: string | null = null;
        while (Date.now() < deadline) {
          const runs = await getJson(workspaceUrl(`/scheduled-tasks/${taskId}/runs?limit=5`));
          if (!Array.isArray(runs)) {
            throw new Error("scheduled task runs response was not an array");
          }
          const run = runs.find(
            (item) => item?.status === "dispatched" && typeof item?.sessionId === "string",
          );
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
          const current = await getJson(workspaceUrl(`/sessions/${runSessionId}`));
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
        await deleteJson(workspaceUrl(`/scheduled-tasks/${taskId}`)).catch(() => undefined);
      }
    });
  }
}

if (args.skipStorage) {
  results.push(skipped("object-storage", "--skip-storage was set"));
} else {
  await runCheck("object-storage", async () => {
    const content = `opengeni conformance ${crypto.randomUUID()}`;
    const upload = await postJson(workspaceUrl("/files/uploads"), {
      filename: "conformance.txt",
      contentType: "text/plain",
      sizeBytes: new TextEncoder().encode(content).byteLength,
    });
    const putUrl = stringField(upload, "putUrl");
    const uploadId = stringField(upload, "uploadId");
    const fileId = stringField(upload, "fileId");
    const headers = recordField(upload, "requiredHeaders");
    // Preserve the generic embeddable-SDK probe by default. Restricted-origin
    // deployments must explicitly select their real browser origin instead.
    const browserOrigin =
      args.browserOrigin ?? `https://${crypto.randomUUID()}.sdk-conformance.invalid`;
    await preflightObjectPut(putUrl, browserOrigin, Object.keys(headers), args.objectConnectTo);
    if (args.denyForeignBrowserOrigin) {
      const foreignOrigin = `https://${crypto.randomUUID()}.foreign-conformance.invalid`;
      await denyForeignObjectPut(putUrl, foreignOrigin, Object.keys(headers), args.objectConnectTo);
    }
    await putObject(putUrl, content, headers, args.objectConnectTo);
    await postJson(workspaceUrl(`/files/uploads/${uploadId}/complete`), {});
    const download = await postJson(workspaceUrl(`/files/${fileId}/download-url`), {});
    const downloaded = await getObject(stringField(download, "url"), args.objectConnectTo);
    if (downloaded !== content) {
      throw new Error("downloaded object did not match uploaded content");
    }
    const foreignWorkspace = crypto.randomUUID();
    const foreignRead = await fetch(
      new URL(`/v1/workspaces/${foreignWorkspace}/files/${fileId}`, args.baseUrl),
      { headers: requestHeaders(true) },
    );
    if (foreignRead.status !== 403 && foreignRead.status !== 404) {
      throw new Error(
        `cross-workspace file read returned HTTP ${foreignRead.status}, expected 403 or 404`,
      );
    }
    return `file ${fileId} uploaded/downloaded and cross-workspace read denied${args.denyForeignBrowserOrigin ? "; foreign browser origin denied" : ""}`;
  });
}

const ok = !results.some((result) => result.status === "failed");

if (args.json) {
  console.log(JSON.stringify({ ok, results }, null, 2));
} else {
  console.log("OpenGeni deployment conformance");
  for (const result of results) {
    console.log(`  - ${result.id}: ${result.status} - ${result.detail}`);
  }
}

if (!ok) {
  process.exit(1);
}

async function runCheck(id: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ id, status: "passed", detail: await fn() });
  } catch (error) {
    results.push({ id, status: "failed", detail: errorMessage(error) });
  }
}

async function getJson(url: URL, options: { auth?: boolean } = {}): Promise<any> {
  const response = await fetch(url, { headers: requestHeaders(options.auth !== false) });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }
  return await response.json();
}

async function getText(url: URL): Promise<string> {
  const response = await fetch(url, { headers: requestHeaders(true) });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }
  return await response.text();
}

async function postJson(url: URL, payload: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders(true, { "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function deleteJson(url: URL): Promise<any> {
  const response = await fetch(url, { method: "DELETE", headers: requestHeaders(true) });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function waitForTerminalSessionStatus(
  targetSessionId: string,
  timeoutSeconds: number,
): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let status = "unknown";
  while (Date.now() < deadline) {
    const current = await getJson(workspaceUrl(`/sessions/${targetSessionId}`));
    status = stringField(current, "status");
    if (["idle", "failed", "cancelled"].includes(status)) {
      break;
    }
    await sleep(2_000);
  }
  return status;
}

async function putObject(
  url: string,
  content: string,
  headers: Record<string, string>,
  connectTo: string | null,
): Promise<void> {
  if (connectTo) {
    runCurl(
      [
        "-fsS",
        "-X",
        "PUT",
        url,
        "--connect-to",
        connectTo,
        ...headerArgs(headers),
        "--data-binary",
        "@-",
      ],
      content,
    );
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

async function preflightObjectPut(
  url: string,
  origin: string,
  requiredHeaderNames: string[],
  connectTo: string | null,
): Promise<void> {
  const response = await objectPutPreflight(url, origin, requiredHeaderNames, connectTo);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`browser upload CORS preflight returned HTTP ${response.status}`);
  }
  const allowedOrigin = response.headers.get("access-control-allow-origin");
  // Some object stores preserve the literal wildcard while others echo the
  // requesting origin after matching a wildcard rule. Restricted deployments
  // additionally prove that a foreign origin is denied.
  if (allowedOrigin !== "*" && allowedOrigin !== origin) {
    throw new Error("browser upload CORS preflight did not allow the selected browser origin");
  }
  const allowedMethods = (response.headers.get("access-control-allow-methods") ?? "")
    .toLowerCase()
    .split(/\s*,\s*/);
  if (!allowedMethods.includes("put")) {
    throw new Error("browser upload CORS preflight did not allow PUT");
  }
}

async function denyForeignObjectPut(
  url: string,
  origin: string,
  requiredHeaderNames: string[],
  connectTo: string | null,
): Promise<void> {
  const response = await objectPutPreflight(url, origin, requiredHeaderNames, connectTo);
  if (response.status === 0 || response.status >= 500) {
    throw new Error("foreign-origin CORS denial was not observable");
  }
  const allowedOrigin = response.headers.get("access-control-allow-origin");
  if (allowedOrigin === "*" || allowedOrigin === origin) {
    throw new Error("browser upload CORS preflight allowed a foreign browser origin");
  }
}

async function objectPutPreflight(
  url: string,
  origin: string,
  requiredHeaderNames: string[],
  connectTo: string | null,
): Promise<{ status: number; headers: Headers; body: string }> {
  const accessControlHeaders = [
    ...new Set(requiredHeaderNames.map((header) => header.toLowerCase())),
  ]
    .sort()
    .join(", ");
  const preflightHeaders = {
    origin,
    "access-control-request-method": "PUT",
    ...(accessControlHeaders ? { "access-control-request-headers": accessControlHeaders } : {}),
  };
  return connectTo
    ? curlPreflight(url, preflightHeaders, connectTo)
    : await fetchPreflight(url, preflightHeaders);
}

async function fetchPreflight(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(url, {
    method: "OPTIONS",
    headers,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text().catch(() => ""),
  };
}

function curlPreflight(
  url: string,
  headers: Record<string, string>,
  connectTo: string,
): { status: number; headers: Headers; body: string } {
  const output = runCurl([
    "-sS",
    "-i",
    "-X",
    "OPTIONS",
    url,
    "--connect-to",
    connectTo,
    ...headerArgs(headers),
  ]);
  const blocks = output.split(/\r?\n\r?\n/);
  const headerBlock = blocks.find((block) => /^HTTP\//i.test(block)) ?? "";
  const status = Number(headerBlock.match(/^HTTP\/\S+\s+(\d+)/i)?.[1] ?? 0);
  const parsedHeaders = new Headers();
  for (const line of headerBlock.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) {
      parsedHeaders.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  }
  return { status, headers: parsedHeaders, body: blocks.slice(1).join("\n\n") };
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

function runCurl(curlArgs: string[], input?: string): string {
  const result = spawnSync("curl", curlArgs, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `curl exited ${result.status}`).trim());
  }
  return result.stdout;
}

function turnFailureSuffix(events: unknown): string {
  if (!Array.isArray(events)) {
    return "";
  }
  const failed = [...events].reverse().find((event) => event?.type === "turn.failed");
  const error =
    failed?.payload && typeof failed.payload === "object" && "error" in failed.payload
      ? failed.payload.error
      : null;
  return typeof error === "string" && error.length > 0 ? `: ${error}` : "";
}

function headerArgs(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([key, value]) => ["-H", `${key}: ${value}`]);
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    baseUrl: process.env.OPENGENI_CONFORMANCE_BASE_URL ?? "",
    timeoutSeconds: Number(process.env.OPENGENI_CONFORMANCE_TIMEOUT_SECONDS ?? 180),
    agentMessage:
      process.env.OPENGENI_CONFORMANCE_AGENT_MESSAGE ??
      "Reply with exactly: opengeni conformance ok",
    model: process.env.OPENGENI_CONFORMANCE_MODEL?.trim() || null,
    sandboxBackend: process.env.OPENGENI_CONFORMANCE_SANDBOX_BACKEND ?? "none",
    objectConnectTo: process.env.OPENGENI_CONFORMANCE_OBJECT_CONNECT_TO ?? null,
    browserOrigin: process.env.OPENGENI_CONFORMANCE_BROWSER_ORIGIN ?? null,
    denyForeignBrowserOrigin: false,
    deploymentAccessKey:
      process.env.OPENGENI_CONFORMANCE_DEPLOYMENT_ACCESS_KEY ??
      process.env.OPENGENI_CONFORMANCE_ACCESS_KEY ??
      null,
    productToken:
      process.env.OPENGENI_CONFORMANCE_PRODUCT_TOKEN ??
      process.env.OPENGENI_CONFORMANCE_ACCESS_TOKEN ??
      null,
    skipAgent: false,
    skipStorage: false,
    skipObservability: false,
    skipScheduledTasks: false,
    json: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
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
    if (value === "--deny-foreign-browser-origin") {
      out.denyForeignBrowserOrigin = true;
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
    if (value === "--model") {
      out.model = requiredNext(values, ++index, value);
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
    if (value === "--browser-origin") {
      out.browserOrigin = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--deployment-access-key" || value === "--access-key") {
      out.deploymentAccessKey = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--product-token" || value === "--access-token") {
      out.productToken = requiredNext(values, ++index, value);
      continue;
    }
    if (value.startsWith("--base-url=")) {
      out.baseUrl = value.slice("--base-url=".length);
      continue;
    }
    if (value.startsWith("--model=")) {
      out.model = value.slice("--model=".length);
      continue;
    }
    if (value.startsWith("--object-connect-to=")) {
      out.objectConnectTo = value.slice("--object-connect-to=".length);
      continue;
    }
    if (value.startsWith("--browser-origin=")) {
      out.browserOrigin = value.slice("--browser-origin=".length);
      continue;
    }
    if (value.startsWith("--deployment-access-key=")) {
      out.deploymentAccessKey = value.slice("--deployment-access-key=".length);
      continue;
    }
    if (value.startsWith("--access-key=")) {
      out.deploymentAccessKey = value.slice("--access-key=".length);
      continue;
    }
    if (value.startsWith("--product-token=")) {
      out.productToken = value.slice("--product-token=".length);
      continue;
    }
    if (value.startsWith("--access-token=")) {
      out.productToken = value.slice("--access-token=".length);
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
  if (out.model !== null) {
    out.model = out.model.trim();
    if (!out.model) {
      throw new Error("--model requires a non-empty value");
    }
  }
  if (out.browserOrigin !== null) {
    let origin: URL;
    try {
      origin = new URL(out.browserOrigin);
    } catch {
      throw new Error("--browser-origin must be an HTTP(S) origin without credentials or a path");
    }
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    ) {
      throw new Error("--browser-origin must be an HTTP(S) origin without credentials or a path");
    }
    out.browserOrigin = origin.origin;
  }
  if (out.denyForeignBrowserOrigin && !out.browserOrigin) {
    throw new Error("--deny-foreign-browser-origin requires an explicit --browser-origin");
  }
  return out;
}

function requestHeaders(auth: boolean, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(auth && args.deploymentAccessKey
      ? { "x-opengeni-access-key": args.deploymentAccessKey }
      : {}),
    ...(auth && args.productToken ? { authorization: `Bearer ${args.productToken}` } : {}),
    ...extra,
  };
}

function workspaceUrl(path: string): URL {
  if (!workspaceId) {
    throw new Error("workspace-discovery did not run or did not find a workspace id");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`/v1/workspaces/${workspaceId}${suffix}`, args.baseUrl);
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
  return Object.fromEntries(
    Object.entries(field).map(([entryKey, entryValue]) => [entryKey, String(entryValue)]),
  );
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
