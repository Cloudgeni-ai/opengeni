import { afterAll, beforeAll, expect, test } from "bun:test";
import { createObservability, withTraceContext } from "@opengeni/observability";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";

import { createDb, rawRows, withDatabaseMaintenanceLifetime } from "../src/database";

// Statements and transactions run while serving an API request become child
// spans of its request span, against a real server and the real driver path.

const SENTINEL = "s3cr3t-bound-value";

type ExportedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number };
};

let shared: SharedTestDatabase;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("database-spans");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

function tracing() {
  const bodies: unknown[] = [];
  const observability = createObservability(
    {
      serviceName: "test",
      environment: "test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: false,
      observabilityOtlpEndpoint: "http://collector",
      observabilityOtlpHeaders: "",
    },
    {
      component: "api",
      exporter: async (_url, body) => {
        bodies.push(body);
      },
    },
  );
  const spans = async (): Promise<ExportedSpan[]> => {
    await observability.flush();
    return bodies.flatMap((body) =>
      (
        body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: ExportedSpan[] }> }> }
      ).resourceSpans.flatMap((resource) => resource.scopeSpans[0]!.spans),
    );
  };
  return { observability, spans, bodies };
}

const attribute = (span: ExportedSpan | undefined, key: string) => {
  const value = span?.attributes.find((entry) => entry.key === key)?.value;
  return value ? Object.values(value)[0] : undefined;
};

test("request-scoped statements and transactions export as nested spans without SQL or values", async () => {
  const pool = createDb(shared.appUrl, { max: 2 });
  const { observability, spans, bodies } = tracing();
  try {
    // Outside a request nothing is recorded.
    await rawRows(pool.db, sql`select 1 as value`);
    const root = observability.startSpan(
      "HTTP GET /v1/x",
      {},
      { kind: "server", childSpanLimit: 64 },
    );
    await withTraceContext(root, async () => {
      const rows = await rawRows<{ value: string }>(
        pool.db,
        sql`select ${SENTINEL}::text as value from generate_series(1, 3)`,
      );
      expect(rows).toHaveLength(3);
      await pool.db.transaction(async (tx) => {
        await rawRows(tx, sql`select pg_backend_pid() as pid`);
        await tx.transaction(async (savepoint) => {
          await rawRows(savepoint, sql`select ${SENTINEL}::text as value`);
        });
      });
      await expect(
        rawRows(pool.db, sql`select * from missing_relation_for_span_test where v = ${SENTINEL}`),
      ).rejects.toThrow();
    });
    root.end();
    const exported = await spans();
    expect(exported.every((span) => span.traceId === root.traceId)).toBe(true);
    expect(exported.some((span) => span.name === "SELECT" && !span.parentSpanId)).toBe(false);
    const named = (name: string) => exported.filter((span) => span.name === name);

    const [series] = named("SELECT generate_series");
    expect(series).toMatchObject({ kind: 3, parentSpanId: root.spanId });
    expect(attribute(series, "db.system.name")).toBe("postgresql");
    expect(attribute(series, "db.operation.name")).toBe("SELECT");
    expect(attribute(series, "db.collection.name")).toBe("generate_series");
    expect(attribute(series, "db.response.returned_rows")).toBe(3);

    const [transaction] = named("db transaction");
    expect(transaction).toMatchObject({ kind: 1, parentSpanId: root.spanId });
    const [pid] = named("SELECT pg_backend_pid");
    expect(pid?.parentSpanId).toBe(transaction!.spanId);
    const [savepoint] = named("db savepoint");
    expect(savepoint?.parentSpanId).toBe(transaction!.spanId);
    const inner = exported.find(
      (span) => span.name === "SELECT" && span.parentSpanId === savepoint!.spanId,
    );
    expect(inner).toBeDefined();

    const [missing] = named("SELECT missing_relation_for_span_test");
    expect(missing?.status.code).toBe(2);
    expect(attribute(missing, "db.response.status_code")).toBe("42P01");

    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("::text");
    expect(serialized).not.toContain("where v");
  } finally {
    await pool.close();
  }
});

test("a cancelled request-scoped statement still cancels and ends its span as failed", async () => {
  const pool = createDb(shared.appUrl, { max: 1 });
  const { observability, spans } = tracing();
  try {
    const root = observability.startSpan(
      "HTTP POST /v1/x",
      {},
      { kind: "server", childSpanLimit: 64 },
    );
    const controller = new AbortController();
    const started = Date.now();
    await withTraceContext(root, async () => {
      const pending = withDatabaseMaintenanceLifetime(
        pool.db,
        { signal: controller.signal },
        async (tx) => {
          setTimeout(() => controller.abort(new Error("caller gone")), 100);
          await rawRows(tx, sql`select pg_sleep(30)`);
        },
      );
      await expect(pending).rejects.toThrow();
    });
    root.end();
    expect(Date.now() - started).toBeLessThan(10_000);
    // The pool's one connection is usable again: the cancel was joined.
    expect(await rawRows(pool.db, sql`select 1 as value`)).toEqual([{ value: 1 }]);
    const exported = await spans();
    const sleep = exported.find((span) => span.name === "SELECT pg_sleep");
    expect(sleep?.status.code).toBe(2);
    expect(exported.find((span) => span.name === "db transaction")?.status.code).toBe(2);
  } finally {
    await pool.close();
  }
}, 30_000);
