import { getSettings } from "@opengeni/config";
import { createImmutableRawObjectReader, createObjectStorage } from "@opengeni/storage";

import { appHostSecurityHeaders, createAppHost, createHttpAppLaunchResolver } from "./server";

export type AppHostProcessConfiguration = Readonly<{
  hostname: string;
  port: number;
  resolverUrl: string;
  resolverKey: string;
  resolverTimeoutMs: number;
  frameAncestors: readonly string[];
}>;

type Environment = Readonly<Record<string, string | undefined>>;

export function appHostProcessConfiguration(
  environment: Environment = process.env,
): AppHostProcessConfiguration {
  return Object.freeze({
    hostname: optional(environment, "OPENGENI_APP_HOST_HOST") ?? "0.0.0.0",
    port: integer(environment, "OPENGENI_APP_HOST_PORT", 8_080, 1, 65_535),
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

export function startAppHostProcess(): ReturnType<typeof Bun.serve> {
  const configuration = appHostProcessConfiguration();
  const storage = createObjectStorage(getSettings());
  if (!storage) throw new Error("App-host object storage is not configured");
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
  return Bun.serve({
    hostname: configuration.hostname,
    port: configuration.port,
    fetch: host.fetch,
    error() {
      const headers = new Headers(securityHeaders);
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(JSON.stringify({ error: "origin_unavailable" }), {
        status: 503,
        headers,
      });
    },
  });
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
    const server = startAppHostProcess();
    const shutdown = () => {
      void server.stop(false).finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    process.stderr.write("App-host startup failed\n");
    process.exit(1);
  }
}
