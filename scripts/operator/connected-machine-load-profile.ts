const DEFAULT_MARKER = "opengeni-load-probe";

export interface ConnectedMachineLoadArgs {
  baseUrl: string;
  workspaceId: string;
  sessionIds: string[];
  stages: number[];
  requestsPerStage: number | null;
  timeoutMs: number;
  requestTimeoutMs: number;
  pauseMs: number;
  maxErrorRate: number;
  command: string;
  expectedOutput: string | null;
  deploymentAccessKey: string | null;
  productToken: string | null;
  json: boolean;
}

interface RequestResult {
  ok: boolean;
  latencyMs: number;
  failure: string | null;
}

interface StageResult {
  concurrency: number;
  requests: number;
  successes: number;
  failures: number;
  errorRate: number;
  wallTimeMs: number;
  throughputPerSecond: number;
  latencyMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  failureCounts: Record<string, number>;
}

export function parseConnectedMachineLoadArgs(
  values: string[],
  env: Record<string, string | undefined> = process.env,
): ConnectedMachineLoadArgs {
  const out: ConnectedMachineLoadArgs = {
    baseUrl: env.OPENGENI_LOAD_BASE_URL ?? "",
    workspaceId: env.OPENGENI_LOAD_WORKSPACE_ID ?? "",
    sessionIds: splitList(env.OPENGENI_LOAD_SESSION_IDS),
    stages: [1, 10, 25, 50, 100, 200],
    requestsPerStage: null,
    timeoutMs: 30_000,
    requestTimeoutMs: 45_000,
    pauseMs: 1_000,
    maxErrorRate: 0,
    command: `echo ${DEFAULT_MARKER}`,
    expectedOutput: DEFAULT_MARKER,
    deploymentAccessKey: env.OPENGENI_LOAD_DEPLOYMENT_ACCESS_KEY ?? null,
    productToken: env.OPENGENI_LOAD_PRODUCT_TOKEN ?? null,
    json: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") {
      out.json = true;
      continue;
    }
    if (value === "--no-output-check") {
      out.expectedOutput = null;
      continue;
    }
    if (value === "--base-url") {
      out.baseUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--workspace-id") {
      out.workspaceId = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--session-id") {
      out.sessionIds.push(...splitList(requiredNext(values, ++index, value)));
      continue;
    }
    if (value === "--stages") {
      out.stages = parsePositiveIntegerList(requiredNext(values, ++index, value), value);
      continue;
    }
    if (value === "--requests-per-stage") {
      out.requestsPerStage = positiveInteger(requiredNext(values, ++index, value), value);
      continue;
    }
    if (value === "--timeout-ms") {
      out.timeoutMs = positiveInteger(requiredNext(values, ++index, value), value);
      continue;
    }
    if (value === "--request-timeout-ms") {
      out.requestTimeoutMs = positiveInteger(requiredNext(values, ++index, value), value);
      continue;
    }
    if (value === "--pause-ms") {
      out.pauseMs = nonnegativeInteger(requiredNext(values, ++index, value), value);
      continue;
    }
    if (value === "--max-error-rate") {
      out.maxErrorRate = boundedRate(requiredNext(values, ++index, value), value);
      continue;
    }
    if (value === "--command") {
      out.command = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--expected-output") {
      out.expectedOutput = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--deployment-access-key") {
      out.deploymentAccessKey = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--product-token") {
      out.productToken = requiredNext(values, ++index, value);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!out.baseUrl) throw new Error("Set --base-url or OPENGENI_LOAD_BASE_URL");
  if (!out.workspaceId) throw new Error("Set --workspace-id or OPENGENI_LOAD_WORKSPACE_ID");
  if (out.sessionIds.length === 0) {
    throw new Error("Pass at least one --session-id or set OPENGENI_LOAD_SESSION_IDS");
  }
  out.sessionIds = [...new Set(out.sessionIds)];
  if (!URL.canParse(out.baseUrl)) throw new Error("--base-url must be a valid URL");
  if (out.timeoutMs > 120_000) {
    throw new Error("--timeout-ms cannot exceed the terminal exec API maximum of 120000");
  }
  if (out.requestTimeoutMs <= out.timeoutMs) {
    throw new Error("--request-timeout-ms must be greater than --timeout-ms");
  }
  return out;
}

export function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))] ?? 0;
}

export async function executeBounded(
  total: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= total) return;
      await task(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(total, concurrency) }, () => worker()));
}

async function main(): Promise<void> {
  const args = parseConnectedMachineLoadArgs(process.argv.slice(2));
  const headers = {
    "content-type": "application/json",
    ...(args.deploymentAccessKey ? { "x-opengeni-access-key": args.deploymentAccessKey } : {}),
    ...(args.productToken ? { authorization: `Bearer ${args.productToken}` } : {}),
  };

  await warmUp(args, headers);
  const stages: StageResult[] = [];
  for (const concurrency of args.stages) {
    if (stages.length > 0 && args.pauseMs > 0) await Bun.sleep(args.pauseMs);
    const requests = args.requestsPerStage ?? Math.max(20, concurrency * 2);
    stages.push(await runStage(args, headers, concurrency, requests));
  }

  const result = {
    schemaVersion: 1,
    target: {
      baseUrl: new URL(args.baseUrl).origin,
      workspaceId: args.workspaceId,
      sessionCount: args.sessionIds.length,
    },
    workload: {
      stages: args.stages,
      requestsPerStage: args.requestsPerStage ?? "2x concurrency (minimum 20)",
      commandTimeoutMs: args.timeoutMs,
      requestTimeoutMs: args.requestTimeoutMs,
    },
    stages,
    verdict: {
      maxErrorRate: args.maxErrorRate,
      passed: stages.every((stage) => stage.failures / stage.requests <= args.maxErrorRate),
    },
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanResult(result);
  }
  if (!result.verdict.passed) process.exitCode = 2;
}

async function warmUp(
  args: ConnectedMachineLoadArgs,
  headers: Record<string, string>,
): Promise<void> {
  const results: RequestResult[] = [];
  await executeBounded(
    args.sessionIds.length,
    Math.min(4, args.sessionIds.length),
    async (index) => {
      results.push(await executeProbe(args, headers, args.sessionIds[index]!));
    },
  );
  const failure = results.find((result) => !result.ok);
  if (failure) {
    throw new Error(`Connected Machine warm-up failed: ${failure.failure ?? "unknown failure"}`);
  }
}

async function runStage(
  args: ConnectedMachineLoadArgs,
  headers: Record<string, string>,
  concurrency: number,
  requests: number,
): Promise<StageResult> {
  const results: RequestResult[] = new Array(requests);
  const started = performance.now();
  await executeBounded(requests, concurrency, async (index) => {
    const sessionId = args.sessionIds[index % args.sessionIds.length]!;
    results[index] = await executeProbe(args, headers, sessionId);
  });
  const wallTimeMs = performance.now() - started;
  const successes = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  const latencies = successes.map((result) => result.latencyMs).sort((a, b) => a - b);
  const failureCounts: Record<string, number> = {};
  for (const failure of failures) {
    const key = failure.failure ?? "unknown";
    failureCounts[key] = (failureCounts[key] ?? 0) + 1;
  }
  return {
    concurrency,
    requests,
    successes: successes.length,
    failures: failures.length,
    errorRate: rounded(failures.length / requests, 4),
    wallTimeMs: rounded(wallTimeMs),
    throughputPerSecond: rounded((requests * 1_000) / wallTimeMs),
    latencyMs: {
      min: rounded(latencies[0] ?? 0),
      p50: rounded(percentile(latencies, 50)),
      p95: rounded(percentile(latencies, 95)),
      p99: rounded(percentile(latencies, 99)),
      max: rounded(latencies.at(-1) ?? 0),
    },
    failureCounts,
  };
}

async function executeProbe(
  args: ConnectedMachineLoadArgs,
  headers: Record<string, string>,
  sessionId: string,
): Promise<RequestResult> {
  const started = performance.now();
  try {
    const endpoint = new URL(
      `/v1/workspaces/${encodeURIComponent(args.workspaceId)}/sessions/${encodeURIComponent(sessionId)}/terminal/exec`,
      args.baseUrl,
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: args.command,
        timeoutMs: args.timeoutMs,
        emitStream: false,
      }),
      signal: AbortSignal.timeout(args.requestTimeoutMs),
    });
    if (!response.ok) {
      return failed(started, await httpFailure(response));
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return failed(started, "invalid-response");
    if (payload.running !== false) return failed(started, "response-still-running");
    if (payload.exitCode !== 0) return failed(started, `exit:${String(payload.exitCode)}`);
    if (
      args.expectedOutput !== null &&
      (typeof payload.stdout !== "string" || payload.stdout.trim() !== args.expectedOutput)
    ) {
      return failed(started, "unexpected-output");
    }
    return { ok: true, latencyMs: performance.now() - started, failure: null };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return failed(started, `transport:${name}`);
  }
}

async function httpFailure(response: Response): Promise<string> {
  let code = "";
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload)) {
      const errorCode =
        typeof payload.code === "string"
          ? payload.code
          : isRecord(payload.error) && typeof payload.error.code === "string"
            ? payload.error.code
            : null;
      if (errorCode) code = `:${errorCode}`;
    }
  } catch {
    // The status is sufficient; never echo arbitrary response bodies.
  }
  return `http:${response.status}${code}`;
}

function failed(started: number, failure: string): RequestResult {
  return { ok: false, latencyMs: performance.now() - started, failure };
}

function printHumanResult(result: {
  target: { baseUrl: string; sessionCount: number };
  stages: StageResult[];
  verdict: { maxErrorRate: number; passed: boolean };
}): void {
  console.log(
    `OpenGeni Connected Machine load profile: ${result.target.baseUrl} (${result.target.sessionCount} session route${result.target.sessionCount === 1 ? "" : "s"})`,
  );
  for (const stage of result.stages) {
    console.log(
      [
        `  concurrency ${stage.concurrency}`,
        `${stage.successes}/${stage.requests} succeeded`,
        `${stage.throughputPerSecond} req/s`,
        `p50 ${stage.latencyMs.p50}ms`,
        `p95 ${stage.latencyMs.p95}ms`,
        `p99 ${stage.latencyMs.p99}ms`,
      ].join(" | "),
    );
    for (const [failure, count] of Object.entries(stage.failureCounts)) {
      console.log(`    ${failure}: ${count}`);
    }
  }
  console.log(
    `Verdict: ${result.verdict.passed ? "passed" : "failed"} (max error rate ${result.verdict.maxErrorRate})`,
  );
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveIntegerList(value: string, flag: string): number[] {
  const parsed = splitList(value).map((item) => positiveInteger(item, flag));
  if (parsed.length === 0) throw new Error(`${flag} requires at least one integer`);
  if (new Set(parsed).size !== parsed.length) throw new Error(`${flag} cannot contain duplicates`);
  return parsed;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function nonnegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function boundedRate(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be between 0 and 1`);
  }
  return parsed;
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) throw new Error(`${flag} requires a value`);
  return next;
}

function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) await main();
