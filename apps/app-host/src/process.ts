import { getSettings } from "@opengeni/config";
import { createObservability, type Observability } from "@opengeni/observability";
import { createImmutableRawObjectReader, createObjectStorage } from "@opengeni/storage";

import {
  APP_HOST_LAUNCH_PATH_PREFIX,
  appHostSecurityHeaders,
  createAppHost,
  createHttpAppLaunchResolver,
  type AppHost,
} from "./server";

export type AppHostProcessConfiguration = Readonly<{
  hostname: string;
  port: number;
  metricsPort: number;
  metricsPath: string;
  resolverUrl: string;
  resolverKey: string;
  resolverTimeoutMs: number;
  frameAncestors: readonly string[];
}>;

export type AppHostProcess = Readonly<{
  appServer: ReturnType<typeof Bun.serve>;
  metricsServer: ReturnType<typeof Bun.serve> | null;
  stop(closeActiveConnections?: boolean): Promise<void>;
}>;

type AppHostRequestObservability = Pick<Observability, "recordHttpRequest">;
type AppHostMetricsObservability = Pick<Observability, "prometheusMetrics">;

type Environment = Readonly<Record<string, string | undefined>>;

export function appHostProcessConfiguration(
  environment: Environment = process.env,
): AppHostProcessConfiguration {
  const port = integer(environment, "OPENGENI_APP_HOST_PORT", 8_080, 1, 65_535);
  const metricsPort = integer(environment, "OPENGENI_APP_HOST_METRICS_PORT", 9_090, 1, 65_535);
  if (metricsPort === port) {
    throw new Error("OPENGENI_APP_HOST_METRICS_PORT must differ from OPENGENI_APP_HOST_PORT");
  }
  return Object.freeze({
    hostname: optional(environment, "OPENGENI_APP_HOST_HOST") ?? "0.0.0.0",
    port,
    metricsPort,
    metricsPath: httpPath(environment, "OPENGENI_APP_HOST_METRICS_PATH", "/metrics"),
    resolverUrl: required(environment, "OPENGENI_APP_HOST_RESOLVER_URL"),
    resolverKey: required(environment, "OPENGENI_APP_HOST_RESOLVER_KEY"),
    resolverTimeoutMs: integer(
      environment,
      "OPENGENI_APP_HOST_RESOLVER_TIMEOUT_MS",
      2_000,
      100,
      30_000,
    ),
    frameAncestors: commaSeparated(environment, "OPENGENI_APP_HOST_FRAME_ANCESTORS"),
  });
}

export function createObservedAppHostHandler(
  host: AppHost,
  observability: AppHostRequestObservability,
  now: () => number = Date.now,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const startMs = now();
    let status = 503;
    try {
      const result = await host.fetch(request);
      status = result.status;
      return result;
    } finally {
      try {
        observability.recordHttpRequest({
          method: appHostMetricMethod(request.method),
          route: appHostMetricRoute(new URL(request.url).pathname),
          status,
          durationSeconds: Math.max(0, now() - startMs) / 1_000,
        });
      } catch {
        // Metrics must never change immutable-byte serving behavior.
      }
    }
  };
}

export function createAppHostMetricsHandler(
  observability: AppHostMetricsObservability,
  metricsPath = "/metrics",
): (request: Request) => Promise<Response> {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname !== metricsPath) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }
    const body = await observability.prometheusMetrics();
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
      },
    });
  };
}

export function appHostMetricRoute(pathname: string): string {
  if (pathname === "/healthz") return "/healthz";
  if (pathname === "/readyz") return "/readyz";
  if (pathname.startsWith(APP_HOST_LAUNCH_PATH_PREFIX)) {
    return "/.opengeni/launch/:token/:path";
  }
  return "/other";
}

export function startAppHostProcess(): AppHostProcess {
  const configuration = appHostProcessConfiguration();
  const settings = getSettings();
  const storage = createObjectStorage(settings);
  if (!storage) throw new Error("App-host object storage is not configured");
  const observability = createObservability(
    {
      serviceName: settings.serviceName,
      environment: settings.environment,
      deploymentRevision: settings.deploymentRevision,
      observabilityStructuredLogs: settings.observabilityStructuredLogs,
      observabilityMetricsEnabled: settings.observabilityMetricsEnabled,
      observabilityOtlpEndpoint: settings.observabilityOtlpEndpoint,
      observabilityOtlpHeaders: settings.observabilityOtlpHeaders,
    },
    { component: "app-host" },
  );
  const securityHeaders = appHostSecurityHeaders(configuration.frameAncestors);
  const host = createAppHost({
    resolver: createHttpAppLaunchResolver({
      url: configuration.resolverUrl,
      sharedKey: configuration.resolverKey,
      timeoutMs: configuration.resolverTimeoutMs,
    }),
    storage: createImmutableRawObjectReader(storage),
    frameAncestors: configuration.frameAncestors,
  });
  const appServer = Bun.serve({
    hostname: configuration.hostname,
    port: configuration.port,
    fetch: createObservedAppHostHandler(host, observability),
    error() {
      const headers = new Headers(securityHeaders);
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(JSON.stringify({ error: "origin_unavailable" }), {
        status: 503,
        headers,
      });
    },
  });
  let metricsServer: ReturnType<typeof Bun.serve> | null = null;
  try {
    if (settings.observabilityMetricsEnabled) {
      metricsServer = Bun.serve({
        hostname: configuration.hostname,
        port: configuration.metricsPort,
        fetch: createAppHostMetricsHandler(observability, configuration.metricsPath),
        error() {
          return Response.json({ error: "metrics_unavailable" }, { status: 503 });
        },
      });
    }
  } catch (error) {
    void appServer.stop(true);
    throw error;
  }
  return Object.freeze({
    appServer,
    metricsServer,
    async stop(closeActiveConnections = false) {
      await Promise.all([
        appServer.stop(closeActiveConnections),
        metricsServer?.stop(closeActiveConnections),
      ]);
      await observability.flush();
    },
  });
}

function appHostMetricMethod(method: string): string {
  if (method === "GET" || method === "HEAD") return method;
  return "OTHER";
}

function httpPath(environment: Environment, name: string, fallback: string): string {
  const value = optional(environment, name) ?? fallback;
  if (
    value.length > 128 ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/u.test(value) ||
    value.includes("//") ||
    value.endsWith("/")
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optional(environment: Environment, name: string): string | null {
  const value = environment[name];
  if (value === undefined || value === "") return null;
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function required(environment: Environment, name: string): string {
  const value = optional(environment, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optional(environment, name);
  if (raw === null) return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function commaSeparated(environment: Environment, name: string): readonly string[] {
  const raw = optional(environment, name);
  if (raw === null) return Object.freeze([]);
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => value.length === 0)) throw new Error(`${name} is invalid`);
  return Object.freeze(values);
}

if (import.meta.main) {
  try {
    const appHostProcess = startAppHostProcess();
    const shutdown = () => {
      void appHostProcess.stop(false).finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    process.stderr.write("App-host startup failed\n");
    process.exit(1);
  }
}
