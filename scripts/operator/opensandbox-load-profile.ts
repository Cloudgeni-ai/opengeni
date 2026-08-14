import { writeFile } from "node:fs/promises";
import { Manifest } from "@openai/agents/sandbox";
import { OpenSandboxClient } from "@opengeni/runtime";

export type OpenSandboxLoadProfile = "5" | "50" | "500";
export type OpenSandboxStartupTier = "warm-pool" | "cached-node" | "cold-image" | "cold-node";

export interface OpenSandboxLoadArgs {
  profile: OpenSandboxLoadProfile;
  tier: OpenSandboxStartupTier;
  count: number;
  baseUrl: string;
  apiKey: string;
  image: string;
  poolRef: string | null;
  ttlSeconds: number;
  createConcurrency: number;
  commandConcurrency: number;
  readyTimeoutSeconds: number;
  minimumSuccessRate: number;
  output: string | null;
  runId: string;
}

type Sample = {
  index: number;
  sandboxId: string | null;
  acceptedMs: number | null;
  readyMs: number | null;
  firstCommandMs: number | null;
  totalStartupMs: number | null;
  waveMs: number[];
  status: "ready" | "failed";
  failureStage: string | null;
  failure: string | null;
  failureMessage: string | null;
};

const PROFILE_RESOURCES: Record<
  OpenSandboxLoadProfile,
  { requests: Record<string, string>; limits: Record<string, string> }
> = {
  "5": {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  },
  "50": {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  },
  "500": {
    requests: { cpu: "5m", memory: "16Mi" },
    limits: { cpu: "100m", memory: "64Mi" },
  },
};

export function parseOpenSandboxLoadArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): OpenSandboxLoadArgs {
  const args: OpenSandboxLoadArgs = {
    profile: "5",
    tier: "cached-node",
    count: 5,
    baseUrl: env.OPENGENI_OPENSANDBOX_BASE_URL ?? "http://127.0.0.1:18090",
    apiKey: env.OPENGENI_OPENSANDBOX_API_KEY ?? "",
    image: env.OPENGENI_OPENSANDBOX_IMAGE ?? "",
    poolRef: env.OPENGENI_OPENSANDBOX_POOL_REF
      ? labelValue(env.OPENGENI_OPENSANDBOX_POOL_REF, "OPENGENI_OPENSANDBOX_POOL_REF")
      : null,
    ttlSeconds: positiveInteger(env.OPENGENI_OPENSANDBOX_TTL_SECONDS ?? "3600", "ttl"),
    createConcurrency: 32,
    commandConcurrency: 64,
    readyTimeoutSeconds: 900,
    minimumSuccessRate: 0.99,
    output: null,
    runId: `load-${crypto.randomUUID()}`,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--profile") {
      args.profile = profile(requiredNext(argv, ++index, value));
      args.count = Number(args.profile);
    } else if (value === "--tier") args.tier = startupTier(requiredNext(argv, ++index, value));
    else if (value === "--count")
      args.count = positiveInteger(requiredNext(argv, ++index, value), value);
    else if (value === "--base-url") args.baseUrl = requiredNext(argv, ++index, value);
    else if (value === "--api-key") args.apiKey = requiredNext(argv, ++index, value);
    else if (value === "--image") args.image = requiredNext(argv, ++index, value);
    else if (value === "--pool-ref")
      args.poolRef = labelValue(requiredNext(argv, ++index, value), value);
    else if (value === "--ttl-seconds")
      args.ttlSeconds = positiveInteger(requiredNext(argv, ++index, value), value);
    else if (value === "--create-concurrency")
      args.createConcurrency = positiveInteger(requiredNext(argv, ++index, value), value);
    else if (value === "--command-concurrency")
      args.commandConcurrency = positiveInteger(requiredNext(argv, ++index, value), value);
    else if (value === "--ready-timeout-seconds")
      args.readyTimeoutSeconds = positiveInteger(requiredNext(argv, ++index, value), value);
    else if (value === "--minimum-success-rate")
      args.minimumSuccessRate = rate(requiredNext(argv, ++index, value), value);
    else if (value === "--output") args.output = requiredNext(argv, ++index, value);
    else if (value === "--run-id") args.runId = labelValue(requiredNext(argv, ++index, value));
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!URL.canParse(args.baseUrl)) throw new Error("--base-url must be a valid URL");
  if (!args.apiKey) throw new Error("Set --api-key or OPENGENI_OPENSANDBOX_API_KEY");
  if (!/@sha256:[0-9a-f]{64}$/iu.test(args.image))
    throw new Error("--image must be an immutable OCI digest");
  if (args.ttlSeconds < 60 || args.ttlSeconds > 86_400)
    throw new Error("--ttl-seconds must be between 60 and 86400");
  if (args.tier === "warm-pool" && !args.poolRef)
    throw new Error("--tier warm-pool requires --pool-ref or OPENGENI_OPENSANDBOX_POOL_REF");
  if (args.tier !== "warm-pool" && args.poolRef)
    throw new Error("--pool-ref requires --tier warm-pool");
  return args;
}

export async function executeBounded(
  total: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      await task(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(total, concurrency) }, () => worker()));
}

export function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((value / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
}

async function main(): Promise<void> {
  const args = parseOpenSandboxLoadArgs(process.argv.slice(2));
  const resources = PROFILE_RESOURCES[args.profile];
  const sessions: Array<Awaited<ReturnType<OpenSandboxClient["create"]>> | null> = new Array(
    args.count,
  ).fill(null);
  const samples: Sample[] = Array.from({ length: args.count }, (_, index) => ({
    index,
    sandboxId: null,
    acceptedMs: null,
    readyMs: null,
    firstCommandMs: null,
    totalStartupMs: null,
    waveMs: [],
    status: "failed",
    failureStage: "create",
    failure: "not-started",
    failureMessage: null,
  }));
  const client = new OpenSandboxClient({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    image: args.image,
    ...(args.poolRef ? { poolRef: args.poolRef } : {}),
    ttlSeconds: args.ttlSeconds,
    useServerProxy: true,
    readyTimeoutSeconds: args.readyTimeoutSeconds,
    resourceLimits: resources.limits,
    resourceRequests: resources.requests,
    environment: { OPENGENI_OPENSANDBOX_LOAD_RUN_ID: args.runId },
  });
  const startedAt = new Date().toISOString();
  const runStarted = performance.now();
  let cleanupResult = {
    exactDeleteAttempted: 0,
    exactDeleteRequests: 0,
    exactDeleteSucceeded: 0,
    failureCounts: {} as Record<string, number>,
  };
  const writeCheckpoint = async (phase: string): Promise<void> => {
    if (!args.output) return;
    const checkpoint = {
      schemaVersion: 1,
      partial: true,
      sourceSha: process.env.OPENGENI_SOURCE_SHA ?? null,
      upstreamSourceSha: "88004c989e334ffd7811acbe193cddcd9014f14e",
      runId: args.runId,
      startedAt,
      checkpointedAt: new Date().toISOString(),
      phase,
      target: {
        baseUrl: new URL(args.baseUrl).origin,
        image: args.image,
        poolRef: args.poolRef,
        profile: args.profile,
        tier: args.tier,
        count: args.count,
        resourceRequests: resources.requests,
        resourceLimits: resources.limits,
      },
      workload: {
        createConcurrency: args.createConcurrency,
        commandConcurrency: args.commandConcurrency,
        waves: 2,
      },
      cleanup: {
        ...cleanupResult,
        retainedSessions: sessions.filter(Boolean).length,
      },
      samples,
    };
    try {
      await writeFile(args.output, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(`[opensandbox-load] checkpoint ${phase} failed: ${errorMessage(error)}`);
    }
  };
  try {
    await executeBounded(args.count, args.createConcurrency, async (index) => {
      const started = performance.now();
      const sample = samples[index]!;
      try {
        const session = await client.create({ manifest: new Manifest() });
        sessions[index] = session;
        sample.sandboxId = session.state.sandboxId;
        sample.acceptedMs = rounded(performance.now() - started);
        sample.failureStage = "start";
        await session.start();
        sample.readyMs = rounded(performance.now() - started);
        sample.failureStage = "first-command";
        const commandStarted = performance.now();
        const command = await session.exec({
          cmd: "true",
          yieldTimeMs: 30_000,
        });
        sample.firstCommandMs = rounded(performance.now() - commandStarted);
        sample.totalStartupMs = rounded(performance.now() - started);
        if (command.exitCode !== 0)
          throw new Error(`first command exit=${String(command.exitCode)}`);
        sample.status = "ready";
        sample.failureStage = null;
        sample.failure = null;
        sample.failureMessage = null;
      } catch (error) {
        sample.failure = errorClass(error);
        sample.failureMessage = errorMessage(error);
      }
    });
    await writeCheckpoint("create-complete");
    for (let wave = 0; wave < 2; wave += 1) {
      await executeBounded(args.count, args.commandConcurrency, async (index) => {
        const session = sessions[index];
        const sample = samples[index]!;
        if (!session || sample.status !== "ready") return;
        const started = performance.now();
        try {
          sample.failureStage = `wave-${wave}`;
          const result = await session.exec({
            cmd: `test ${wave} -ge 0`,
            yieldTimeMs: 30_000,
          });
          if (result.exitCode !== 0) throw new Error(`wave exit=${String(result.exitCode)}`);
          sample.waveMs.push(rounded(performance.now() - started));
          sample.failureStage = null;
        } catch (error) {
          sample.status = "failed";
          sample.failure = errorClass(error);
          sample.failureMessage = errorMessage(error);
        }
      });
      await writeCheckpoint(`wave-${wave}-complete`);
    }
  } finally {
    await writeCheckpoint("cleanup-started");
    await executeBounded(args.count, args.commandConcurrency, async (index) => {
      const session = sessions[index];
      if (!session) return;
      cleanupResult.exactDeleteAttempted += 1;
      let finalError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        cleanupResult.exactDeleteRequests += 1;
        try {
          await session.delete();
          sessions[index] = null;
          cleanupResult.exactDeleteSucceeded += 1;
          return;
        } catch (error) {
          finalError = error;
          if (attempt < 3) await Bun.sleep(attempt * 500);
        }
      }
      const key = errorClass(finalError);
      cleanupResult.failureCounts[key] = (cleanupResult.failureCounts[key] ?? 0) + 1;
    });
    await writeCheckpoint("cleanup-complete");
  }

  const ready = samples.filter((sample) => sample.status === "ready");
  const startup = ready.map((sample) => sample.totalStartupMs!).sort((left, right) => left - right);
  const commands = ready.flatMap((sample) => sample.waveMs).sort((left, right) => left - right);
  const failureCounts: Record<string, number> = {};
  for (const sample of samples.filter((entry) => entry.status === "failed")) {
    const key = sample.failure ?? "unknown";
    failureCounts[key] = (failureCounts[key] ?? 0) + 1;
  }
  const successRate = ready.length / args.count;
  const artifact = {
    schemaVersion: 1,
    sourceSha: process.env.OPENGENI_SOURCE_SHA ?? null,
    upstreamSourceSha: "88004c989e334ffd7811acbe193cddcd9014f14e",
    runId: args.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    target: {
      baseUrl: new URL(args.baseUrl).origin,
      image: args.image,
      poolRef: args.poolRef,
      profile: args.profile,
      tier: args.tier,
      count: args.count,
      resourceRequests: resources.requests,
      resourceLimits: resources.limits,
    },
    workload: {
      createConcurrency: args.createConcurrency,
      commandConcurrency: args.commandConcurrency,
      waves: 2,
    },
    result: {
      ready: ready.length,
      failed: args.count - ready.length,
      successRate: rounded(successRate, 4),
      wallTimeMs: rounded(performance.now() - runStarted),
      startupMs: statistics(startup),
      waveCommandMs: statistics(commands),
      failureCounts,
    },
    cleanup: {
      ...cleanupResult,
      retainedSessions: sessions.filter(Boolean).length,
    },
    samples,
    verdict: {
      minimumSuccessRate: args.minimumSuccessRate,
      passed: loadProfilePassed({
        successRate,
        minimumSuccessRate: args.minimumSuccessRate,
        exactDeleteAttempted: cleanupResult.exactDeleteAttempted,
        exactDeleteSucceeded: cleanupResult.exactDeleteSucceeded,
        retainedSessions: sessions.filter(Boolean).length,
      }),
    },
  };
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  if (args.output) await writeFile(args.output, text, { mode: 0o600 });
  console.log(text.trimEnd());
  if (!artifact.verdict.passed) process.exitCode = 2;
}

export function loadProfilePassed(input: {
  successRate: number;
  minimumSuccessRate: number;
  exactDeleteAttempted: number;
  exactDeleteSucceeded: number;
  retainedSessions: number;
}): boolean {
  return (
    input.successRate >= input.minimumSuccessRate &&
    input.exactDeleteSucceeded === input.exactDeleteAttempted &&
    input.retainedSessions === 0
  );
}

function statistics(values: number[]) {
  return {
    samples: values.length,
    min: rounded(values[0] ?? 0),
    p50: rounded(percentile(values, 50)),
    p95: rounded(percentile(values, 95)),
    p99: rounded(percentile(values, 99)),
    max: rounded(values.at(-1) ?? 0),
  };
}

function profile(value: string): OpenSandboxLoadProfile {
  if (value === "5" || value === "50" || value === "500") return value;
  throw new Error("--profile must be 5, 50, or 500");
}

function startupTier(value: string): OpenSandboxStartupTier {
  if (
    value === "warm-pool" ||
    value === "cached-node" ||
    value === "cold-image" ||
    value === "cold-node"
  )
    return value;
  throw new Error("--tier must be warm-pool, cached-node, cold-image, or cold-node");
}

function requiredNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function rate(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
    throw new Error(`${label} must be between 0 and 1`);
  return parsed;
}

function labelValue(value: string, label = "--run-id"): string {
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(value))
    throw new Error(`${label} must be Kubernetes label-safe lowercase text`);
  return value;
}

function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function errorClass(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const value = error as {
    name?: unknown;
    statusCode?: unknown;
    error?: { code?: unknown };
  };
  const code = typeof value.error?.code === "string" ? value.error.code : null;
  const status = typeof value.statusCode === "number" ? value.statusCode : null;
  return [
    typeof value.name === "string" ? value.name : "Error",
    code,
    status === null ? null : `http-${status}`,
  ]
    .filter(Boolean)
    .join(":");
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/gu, " ").slice(0, 500);
}

if (import.meta.main) {
  await main();
  process.exit(process.exitCode ?? 0);
}
