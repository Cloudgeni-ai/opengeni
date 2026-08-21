import { writeFile } from "node:fs/promises";
import { Manifest } from "@openai/agents/sandbox";
import {
  OpenSandboxClient,
  SandboxExactResumeInstanceUnavailableError,
  runWithToolCallCorrelation,
} from "@opengeni/runtime";

const DEFAULT_IMAGE = "";
const DEFAULT_BASE_URL = "http://127.0.0.1:18090";
type LiveSession = Awaited<ReturnType<OpenSandboxClient["create"]>>;

export interface OpenSandboxConformanceArgs {
  baseUrl: string;
  apiKey: string;
  image: string;
  ttlSeconds: number;
  readyTimeoutSeconds: number;
  signedEndpoints: boolean;
  channelBPublicBaseUrl: string | null;
  output: string | null;
  runId: string;
}

type Step = {
  id: string;
  status: "passed" | "failed";
  durationMs: number;
  detail: string;
};

export function parseOpenSandboxConformanceArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): OpenSandboxConformanceArgs {
  const args: OpenSandboxConformanceArgs = {
    baseUrl: env.OPENGENI_OPENSANDBOX_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: env.OPENGENI_OPENSANDBOX_API_KEY ?? "",
    image: env.OPENGENI_OPENSANDBOX_IMAGE ?? DEFAULT_IMAGE,
    ttlSeconds: positiveInteger(env.OPENGENI_OPENSANDBOX_TTL_SECONDS ?? "3600", "ttl"),
    readyTimeoutSeconds: 600,
    signedEndpoints: env.OPENGENI_OPENSANDBOX_SIGNED_ENDPOINTS === "true",
    channelBPublicBaseUrl: env.OPENGENI_OPENSANDBOX_CHANNEL_B_PUBLIC_BASE_URL ?? null,
    output: null,
    runId: `conformance-${crypto.randomUUID()}`,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base-url") args.baseUrl = requiredNext(argv, ++index, value);
    else if (value === "--api-key") args.apiKey = requiredNext(argv, ++index, value);
    else if (value === "--image") args.image = requiredNext(argv, ++index, value);
    else if (value === "--ttl-seconds") {
      args.ttlSeconds = positiveInteger(requiredNext(argv, ++index, value), value);
    } else if (value === "--ready-timeout-seconds") {
      args.readyTimeoutSeconds = positiveInteger(requiredNext(argv, ++index, value), value);
    } else if (value === "--signed-endpoints") args.signedEndpoints = true;
    else if (value === "--channel-b-public-base-url") {
      args.channelBPublicBaseUrl = requiredNext(argv, ++index, value);
    } else if (value === "--output") args.output = requiredNext(argv, ++index, value);
    else if (value === "--run-id") args.runId = labelValue(requiredNext(argv, ++index, value));
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (args.channelBPublicBaseUrl && !URL.canParse(args.channelBPublicBaseUrl)) {
    throw new Error("--channel-b-public-base-url must be a valid URL");
  }
  if (!URL.canParse(args.baseUrl)) throw new Error("--base-url must be a valid URL");
  if (!args.apiKey) throw new Error("Set --api-key or OPENGENI_OPENSANDBOX_API_KEY");
  if (!/@sha256:[0-9a-f]{64}$/iu.test(args.image)) {
    throw new Error("--image must be an immutable OCI digest");
  }
  if (args.ttlSeconds < 60 || args.ttlSeconds > 86_400) {
    throw new Error("--ttl-seconds must be between 60 and 86400");
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseOpenSandboxConformanceArgs(process.argv.slice(2));
  const client = new OpenSandboxClient({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    image: args.image,
    ttlSeconds: args.ttlSeconds,
    useServerProxy: true,
    signedEndpoints: args.signedEndpoints,
    ...(args.channelBPublicBaseUrl
      ? { channelBPublicBaseUrl: args.channelBPublicBaseUrl }
      : {}),
    readyTimeoutSeconds: args.readyTimeoutSeconds,
    resourceLimits: { cpu: "1", memory: "1Gi" },
    resourceRequests: { cpu: "250m", memory: "512Mi" },
    environment: { OPENGENI_OPENSANDBOX_CONFORMANCE_RUN_ID: args.runId },
    exposedPorts: [8080],
  });
  const steps: Step[] = [];
  const startedAt = new Date().toISOString();
  let session: LiveSession | null = null;
  let serialized: Record<string, unknown> | null = null;
  let sandboxId: string | null = null;

  try {
    await step(steps, "create-acceptance", async () => {
      session = await client.create({
        manifest: new Manifest({
          environment: { OPENGENI_CONFORMANCE_MARKER: args.runId },
          entries: { "seed.txt": { type: "file", content: "seed" } },
        }),
      });
      sandboxId = session.state.sandboxId;
      return `sandbox=${sandboxId}`;
    });
    await step(steps, "readiness-first-command", async () => {
      await session!.start();
      const result = await session!.exec({
        cmd: "printf ready",
        yieldTimeMs: 30_000,
      });
      if (result.exitCode !== 0 || result.stdout !== "ready") {
        throw new Error(`unexpected command result exit=${String(result.exitCode)}`);
      }
      return "session start and first command succeeded";
    });
    await step(steps, "files-manifest", async () => {
      const seed = new TextDecoder().decode(await session!.readFile({ path: "seed.txt" }));
      if (seed !== "seed") throw new Error("initial manifest file mismatch");
      await session!.writeFile({ path: "nested/value.txt", content: "value" });
      const entries = await session!.listDir({ path: "nested" });
      if (!entries.some((entry) => entry.name === "value.txt" && entry.type === "file")) {
        throw new Error("written file missing from directory listing");
      }
      return "manifest, write, read, and list succeeded";
    });
    await step(steps, "retained-command-interrupt", async () => {
      const correlation = `opensandbox-conformance-${args.runId}`;
      const retained = await runWithToolCallCorrelation(correlation, () =>
        session!.exec({ cmd: "sleep 300", yieldTimeMs: 0 }),
      );
      if (retained.sessionId === undefined) throw new Error("command did not yield a session id");
      if (!(await session!.cancelExecCommand(`${correlation}:0`))) {
        throw new Error("exact provider command interrupt was not accepted");
      }
      const settled = await session!.writeStdinForProcessControl({
        sessionId: retained.sessionId,
        chars: "",
        yieldTimeMs: 5_000,
      });
      if (!settled.includes("Process exited with code")) {
        throw new Error("interrupted command did not settle");
      }
      return "exact retained command interrupted and settled";
    });
    await step(steps, "server-proxy-port", async () => {
      const correlation = `opensandbox-http-${args.runId}`;
      const retained = await runWithToolCallCorrelation(correlation, () =>
        session!.exec({
          cmd: "python3 -m http.server 8080 --directory /workspace",
          yieldTimeMs: 0,
        }),
      );
      if (retained.sessionId === undefined) throw new Error("HTTP server did not yield");
      try {
        const endpoint = await session!.resolveExposedPort(8080);
        const response = await retryFetch(endpoint.url!, stringHeaders(endpoint.headers), 30_000);
        if (!response.ok || !(await response.text()).includes("seed.txt")) {
          throw new Error(`proxied HTTP endpoint returned ${response.status}`);
        }
        return `private proxy endpoint=${new URL(endpoint.url!).pathname}`;
      } finally {
        await session!.cancelExecCommand(`${correlation}:0`).catch(() => false);
        await session!
          .writeStdinForProcessControl({
            sessionId: retained.sessionId,
            chars: "",
            yieldTimeMs: 5_000,
          })
          .catch(() => undefined);
      }
    });
    if (args.signedEndpoints) {
      await step(steps, "signed-channel-b-http", async () => {
        const correlation = `opensandbox-signed-${args.runId}`;
        const retained = await runWithToolCallCorrelation(correlation, () =>
          session!.exec({
            cmd: "python3 -m http.server 8080 --directory /workspace",
            yieldTimeMs: 0,
          }),
        );
        if (retained.sessionId === undefined) throw new Error("HTTP server did not yield");
        try {
          const endpoint = await session!.resolveExposedPort(8080);
          const path = new URL(endpoint.url!).pathname;
          if (/\/v1\/sandboxes\/[^/]+\/proxy\//u.test(path)) {
            throw new Error(`signed endpoint used lifecycle proxy path ${path}`);
          }
          if (!/^\/[^/]+\/8080\/[0-9a-z]+\/[0-9a-z]{8,64}(?:\/|$)/iu.test(path)) {
            throw new Error(`signed endpoint path was not OSEP-0011 URI mode: ${path}`);
          }
          const response = await retryFetch(endpoint.url!, stringHeaders(endpoint.headers), 30_000);
          if (!response.ok || !(await response.text()).includes("seed.txt")) {
            throw new Error(`signed HTTP endpoint returned ${response.status}`);
          }
          return `signed endpoint=${path}`;
        } finally {
          await session!.cancelExecCommand(`${correlation}:0`).catch(() => false);
          await session!
            .writeStdinForProcessControl({
              sessionId: retained.sessionId,
              chars: "",
              yieldTimeMs: 5_000,
            })
            .catch(() => undefined);
        }
      });
    }
    await step(steps, "portable-workspace-archive", async () => {
      await session!.writeFile({ path: "durable.txt", content: args.runId });
      const archive = await session!.persistWorkspace();
      await session!.writeFile({ path: "durable.txt", content: "changed" });
      await session!.hydrateWorkspace(archive);
      const restored = new TextDecoder().decode(await session!.readFile({ path: "durable.txt" }));
      if (restored !== args.runId) throw new Error("portable archive did not restore exact bytes");
      return `archiveBytes=${archive.byteLength}`;
    });
    await step(steps, "ttl-renewal", async () => {
      const renewed = await session!.renewExpiration();
      if (!renewed) throw new Error("provider returned no renewed expiration");
      return `expiresAt=${renewed}`;
    });
    await step(steps, "serialize-exact-resume", async () => {
      serialized = await client.serializeSessionState(session!.state);
      await session!.close();
      session = await client.resumeExact(await client.deserializeSessionState(serialized));
      await session.start();
      const result = await session.exec({
        cmd: "cat /workspace/durable.txt",
        yieldTimeMs: 30_000,
      });
      if (result.exitCode !== 0 || result.stdout !== args.runId) {
        throw new Error("exact resume did not preserve workspace bytes");
      }
      return `resumedSandbox=${session.state.sandboxId}`;
    });
    await step(steps, "exact-delete-and-loss", async () => {
      await session!.delete();
      session = null;
      await expectExactResumeMissing(client, serialized!);
      return `deletedSandbox=${sandboxId}`;
    });
  } finally {
    const cleanupSession = session as LiveSession | null;
    if (cleanupSession) await cleanupSession.delete().catch(() => undefined);
  }

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
      ttlSeconds: args.ttlSeconds,
    },
    sandboxId,
    steps,
    passed: steps.every((entry) => entry.status === "passed"),
  };
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  if (args.output) await writeFile(args.output, text, { mode: 0o600 });
  console.log(text.trimEnd());
  if (!artifact.passed) process.exitCode = 2;
}

async function step(steps: Step[], id: string, operation: () => Promise<string>): Promise<void> {
  const started = performance.now();
  try {
    const detail = await operation();
    steps.push({
      id,
      status: "passed",
      durationMs: rounded(performance.now() - started),
      detail,
    });
  } catch (error) {
    steps.push({
      id,
      status: "failed",
      durationMs: rounded(performance.now() - started),
      detail: errorMessage(error),
    });
    throw error;
  }
}

async function expectExactResumeMissing(
  client: OpenSandboxClient,
  serialized: Record<string, unknown>,
): Promise<void> {
  try {
    await client.resumeExact(await client.deserializeSessionState(serialized));
  } catch (error) {
    if (error instanceof SandboxExactResumeInstanceUnavailableError) return;
    throw error;
  }
  throw new Error("exact resume unexpectedly succeeded after exact delete");
}

async function retryFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return response;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await Bun.sleep(500);
  }
  throw last instanceof Error ? last : new Error("proxied endpoint did not become ready");
}

function stringHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
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

function labelValue(value: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(value)) {
    throw new Error("--run-id must be a Kubernetes label-safe lowercase value");
  }
  return value;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

if (import.meta.main) {
  await main();
  process.exit(process.exitCode ?? 0);
}
