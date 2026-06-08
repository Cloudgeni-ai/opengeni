import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface Args {
  baseUrl: string;
  workspaceId: string;
  token: string;
  outFile: string;
  environment: string;
  durationSeconds: number;
  concurrency: number;
  maxSessions: number;
  maxSessionSeconds: number;
  healthIntervalMs: number;
  pollIntervalMs: number;
  agentMessage: string;
  sandboxBackend: string | null;
}

type RequestMetric = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ok: boolean;
};

type SessionMetric = {
  id: string;
  status: string;
  durationMs: number;
};

const args = parseArgs(process.argv.slice(2), process.env);
const startedAt = Date.now();
const deadline = startedAt + args.durationSeconds * 1000;
const requestMetrics: RequestMetric[] = [];
const sessionMetrics: SessionMetric[] = [];
let sessionsStarted = 0;
let stop = false;

await Promise.all([
  healthLoop(),
  ...Array.from({ length: args.concurrency }, () => sessionWorker()),
]);

const endedAt = Date.now();
const failedRequests = requestMetrics.filter((metric) => !metric.ok).length;
const failedSessions = sessionMetrics.filter((metric) => metric.status !== "idle").length;
const metrics = {
  durationSeconds: Math.round((endedAt - startedAt) / 1000),
  requests: requestMetrics.length,
  failedRequests,
  errorRate: requestMetrics.length > 0 ? failedRequests / requestMetrics.length : 1,
  p95Ms: percentile(requestMetrics.map((metric) => metric.durationMs), 0.95),
  sessionsStarted,
  sessionsCompleted: sessionMetrics.filter((metric) => metric.status === "idle").length,
  sessionsFailed: failedSessions,
  sessionP95Ms: percentile(sessionMetrics.map((metric) => metric.durationMs), 0.95),
};
const ok = failedRequests === 0 && failedSessions === 0 && metrics.sessionsCompleted > 0;

const output = {
  ok,
  environment: args.environment,
  baseUrl: args.baseUrl,
  generatedAt: new Date().toISOString(),
  startedAt: new Date(startedAt).toISOString(),
  endedAt: new Date(endedAt).toISOString(),
  checks: [
    {
      id: "load-soak",
      status: ok ? "passed" : "failed",
      detail: `${metrics.sessionsCompleted}/${sessionsStarted} sessions idle, ${failedRequests}/${requestMetrics.length} failed requests`,
      evidence: [args.outFile],
      metrics,
    },
  ],
  samples: {
    failedRequests: requestMetrics.filter((metric) => !metric.ok).slice(0, 20),
    nonIdleSessions: sessionMetrics.filter((metric) => metric.status !== "idle").slice(0, 20),
  },
};

await mkdir(dirname(args.outFile), { recursive: true });
await Bun.write(args.outFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));

if (!ok) {
  process.exit(1);
}
process.exit(0);

async function healthLoop(): Promise<void> {
  while (Date.now() < deadline) {
    await getJson(new URL("/healthz", args.baseUrl), false).catch(() => undefined);
    await getJson(new URL("/v1/access/me", args.baseUrl), true).catch(() => undefined);
    await sleep(args.healthIntervalMs);
  }
  stop = true;
}

async function sessionWorker(): Promise<void> {
  while (!stop && Date.now() < deadline) {
    const sessionNumber = claimSessionNumber();
    if (sessionNumber === null) {
      await sleep(250);
      continue;
    }
    const sessionStartedAt = Date.now();
    let sessionId = `<uncreated-${sessionNumber}>`;
    let status = "failed";
    try {
      const payload: Record<string, unknown> = {
        initialMessage: args.agentMessage,
        metadata: { loadSoak: true, sessionNumber },
      };
      if (args.sandboxBackend) {
        payload.sandboxBackend = args.sandboxBackend;
      }
      const session = await postJson(workspaceUrl("/sessions"), payload);
      sessionId = stringField(session, "id");
      status = await waitForTerminalSession(sessionId);
    } catch {
      status = "failed";
    }
    sessionMetrics.push({ id: sessionId, status, durationMs: Date.now() - sessionStartedAt });
  }
}

function claimSessionNumber(): number | null {
  if (sessionsStarted >= args.maxSessions) {
    return null;
  }
  sessionsStarted += 1;
  return sessionsStarted;
}

async function waitForTerminalSession(sessionId: string): Promise<string> {
  const sessionDeadline = Date.now() + args.maxSessionSeconds * 1000;
  let lastStatus = "unknown";
  while (Date.now() < sessionDeadline) {
    const session = await getJson(workspaceUrl(`/sessions/${sessionId}`), true);
    lastStatus = stringField(session, "status");
    if (["idle", "failed", "cancelled"].includes(lastStatus)) {
      return lastStatus;
    }
    await sleep(args.pollIntervalMs);
  }
  return lastStatus;
}

async function getJson(url: URL, auth: boolean): Promise<any> {
  const response = await measuredFetch(url, { headers: auth ? authHeaders() : {} });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function postJson(url: URL, payload: unknown): Promise<any> {
  const response = await measuredFetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function measuredFetch(url: URL, init: RequestInit): Promise<Response> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    requestMetrics.push({
      method: init.method ?? "GET",
      path: url.pathname,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      ok: false,
    });
    throw error;
  }
  requestMetrics.push({
    method: init.method ?? "GET",
    path: url.pathname,
    status: response.status,
    durationMs: Math.round(performance.now() - started),
    ok: response.ok,
  });
  return response;
}

function workspaceUrl(path: string): URL {
  return new URL(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}${path}`, args.baseUrl);
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${args.token}` };
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
  return sorted[index] ?? 0;
}

function stringField(record: unknown, field: string): string {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${field} is missing`);
  }
  const value = (record as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is missing`);
  }
  return value;
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    baseUrl: env.OPENGENI_LOAD_SOAK_BASE_URL ?? env.OPENGENI_CONFORMANCE_BASE_URL ?? "",
    workspaceId: env.OPENGENI_LOAD_SOAK_WORKSPACE_ID ?? env.OPENGENI_CONFORMANCE_WORKSPACE_ID ?? "",
    token: env.OPENGENI_LOAD_SOAK_PRODUCT_TOKEN ?? env.OPENGENI_CONFORMANCE_PRODUCT_TOKEN ?? "",
    outFile: env.OPENGENI_LOAD_SOAK_OUT_FILE ?? ".agent/generated/staging/load-soak.json",
    environment: env.OPENGENI_LOAD_SOAK_ENVIRONMENT ?? "staging",
    durationSeconds: numberEnv(env.OPENGENI_LOAD_SOAK_DURATION_SECONDS, 1_800),
    concurrency: numberEnv(env.OPENGENI_LOAD_SOAK_CONCURRENCY, 2),
    maxSessions: numberEnv(env.OPENGENI_LOAD_SOAK_MAX_SESSIONS, 25),
    maxSessionSeconds: numberEnv(env.OPENGENI_LOAD_SOAK_MAX_SESSION_SECONDS, 180),
    healthIntervalMs: numberEnv(env.OPENGENI_LOAD_SOAK_HEALTH_INTERVAL_MS, 5_000),
    pollIntervalMs: numberEnv(env.OPENGENI_LOAD_SOAK_POLL_INTERVAL_MS, 2_000),
    agentMessage: env.OPENGENI_LOAD_SOAK_AGENT_MESSAGE ?? "Reply with exactly: ok",
    sandboxBackend: env.OPENGENI_LOAD_SOAK_SANDBOX_BACKEND ?? null,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--base-url") {
      out.baseUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--workspace-id") {
      out.workspaceId = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--token") {
      out.token = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--out-file") {
      out.outFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--environment") {
      out.environment = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--duration-seconds") {
      out.durationSeconds = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--concurrency") {
      out.concurrency = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--max-sessions") {
      out.maxSessions = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--max-session-seconds") {
      out.maxSessionSeconds = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--health-interval-ms") {
      out.healthIntervalMs = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--poll-interval-ms") {
      out.pollIntervalMs = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--agent-message") {
      out.agentMessage = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--sandbox-backend") {
      out.sandboxBackend = requiredNext(values, ++index, value);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!out.baseUrl) {
    throw new Error("Set --base-url or OPENGENI_LOAD_SOAK_BASE_URL");
  }
  if (!out.workspaceId) {
    throw new Error("Set --workspace-id or OPENGENI_LOAD_SOAK_WORKSPACE_ID");
  }
  if (!out.token) {
    throw new Error("Set --token or OPENGENI_LOAD_SOAK_PRODUCT_TOKEN");
  }
  if (!Number.isFinite(out.durationSeconds) || out.durationSeconds <= 0) {
    throw new Error("--duration-seconds must be positive");
  }
  if (!Number.isFinite(out.concurrency) || out.concurrency <= 0) {
    throw new Error("--concurrency must be positive");
  }
  if (!Number.isFinite(out.maxSessions) || out.maxSessions <= 0) {
    throw new Error("--max-sessions must be positive");
  }
  return out;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric environment value, got ${value}`);
  }
  return parsed;
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
