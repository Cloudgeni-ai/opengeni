import type { Settings } from "@opengeni/config";
import { dbSql, type Database } from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";

export type ReadinessCheckName = "db" | "nats" | "temporal";
export type ReadinessChecks = Record<ReadinessCheckName, () => Promise<void> | void>;

export type ReadinessResult = {
  ok: boolean;
  checks: Record<ReadinessCheckName, { ok: boolean; error?: string }>;
};

export function startWorkerHttpServer(input: {
  settings: Settings;
  observability: Observability;
  checks: ReadinessChecks;
  timeoutMs?: number;
}): ReturnType<typeof Bun.serve> {
  const { settings, observability, checks } = input;
  const timeoutMs = input.timeoutMs ?? 2_000;
  return Bun.serve({
    hostname: "0.0.0.0",
    port: settings.workerHttpPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET") {
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      }
      if (url.pathname === "/healthz") {
        return Response.json({
          service: settings.serviceName,
          environment: settings.environment,
          deploymentRevision: settings.deploymentRevision,
          ok: true,
        });
      }
      if (url.pathname === "/metrics") {
        return new Response(await observability.prometheusMetrics(), {
          status: 200,
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }
      if (url.pathname === "/readyz") {
        const result = await runReadinessChecks(checks, timeoutMs);
        return Response.json(result, { status: result.ok ? 200 : 503 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
}

export async function runReadinessChecks(checks: ReadinessChecks, timeoutMs = 2_000): Promise<ReadinessResult> {
  const entries = await Promise.all(
    (Object.entries(checks) as Array<[ReadinessCheckName, () => Promise<void> | void]>)
      .map(async ([name, check]) => {
        try {
          await withTimeout(Promise.resolve().then(check), timeoutMs);
          return [name, { ok: true }] as const;
        } catch (error) {
          return [name, { ok: false, error: error instanceof Error ? error.message : String(error) }] as const;
        }
      }),
  );
  const result = Object.fromEntries(entries) as ReadinessResult["checks"];
  return {
    ok: Object.values(result).every((check) => check.ok),
    checks: result,
  };
}

export function dbReadyCheck(db: Database): () => Promise<void> {
  return async () => {
    await db.execute(dbSql`select 1`);
  };
}

export function natsReadyCheck(bus: EventBus): () => void {
  return () => {
    if (bus.isConnected && !bus.isConnected()) {
      throw new Error("NATS is not connected");
    }
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`readiness check timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
