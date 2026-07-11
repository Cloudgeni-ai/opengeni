import type { Settings } from "@opengeni/config";
import { dbSql, type Database } from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";

export type ReadinessCheckName = "db" | "nats" | "temporal" | "schema";
export type ReadinessCheckDetails = Record<string, unknown> | void;
export type ReadinessChecks = Record<
  ReadinessCheckName,
  () => Promise<ReadinessCheckDetails> | ReadinessCheckDetails
>;

export type ReadinessResult = {
  ok: boolean;
  checks: Record<ReadinessCheckName, { ok: boolean; error?: string } & Record<string, unknown>>;
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
          ...(settings.deploymentImageDigests
            ? {
                images: Object.fromEntries(
                  Object.entries(settings.deploymentImageDigests).map(([name, digest]) => [
                    name,
                    { digest },
                  ]),
                ),
              }
            : {}),
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

export async function runReadinessChecks(
  checks: ReadinessChecks,
  timeoutMs = 2_000,
): Promise<ReadinessResult> {
  const entries = await Promise.all(
    (
      Object.entries(checks) as Array<
        [ReadinessCheckName, () => Promise<ReadinessCheckDetails> | ReadinessCheckDetails]
      >
    ).map(async ([name, check]) => {
      try {
        const details = await withTimeout(Promise.resolve().then(check), timeoutMs);
        return [name, { ok: true, ...(details ?? {}) }] as const;
      } catch (error) {
        return [
          name,
          { ok: false, error: error instanceof Error ? error.message : String(error) },
        ] as const;
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

export function schemaReadyCheck(
  db: Database,
  expected: Settings["releaseSchema"],
): () => Promise<Record<string, unknown> | void> {
  return async () => {
    if (!expected) return;
    const rows = (await db.execute(
      dbSql`select name from schema_migrations order by name`,
    )) as unknown as Array<{ name?: unknown }>;
    const applied = rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string");
    if (JSON.stringify(applied) !== JSON.stringify(expected.migrations)) {
      throw new Error("applied migration names do not match the reviewed release schema");
    }
    return {
      migrations: expected.migrations,
      migrationSetSha256: expected.migrationSetSha256,
      contractsSha256: expected.contractsSha256,
    };
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`readiness check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
