import type { Settings } from "@opengeni/config";
import { withDatabaseStatementTimeout, type Database } from "@opengeni/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import { requireAccessKey } from "./auth";
import type { HttpServerDrain } from "./server-drain";

type PrometheusSource = { prometheusMetrics(): Promise<string> };
type MetricsSettings = Pick<
  Settings,
  "serviceName" | "environment" | "deploymentRevision" | "observabilityMetricsEnabled"
>;

const AUTOMATION_TRIGGERS = [
  "clock",
  "event",
  "once",
  "initial",
  "manual",
  "retry",
  "repair",
] as const;
const AUTOMATION_OUTCOMES = ["ok", "failed", "skipped"] as const;
type AutomationRunCounterRow = { trigger_kind: string; outcome: string; runs: string };

/** Each API replica reads the same durable deployment-wide counter. */
export async function automationRunMetrics(
  db: Database,
  settings: MetricsSettings,
): Promise<string> {
  if (!settings.observabilityMetricsEnabled) return "";
  const result: AutomationRunCounterRow[] | { rows: AutomationRunCounterRow[] } =
    await withDatabaseStatementTimeout(db, 1_000, (bounded) =>
      bounded.execute<AutomationRunCounterRow>(sql`
        select trigger_kind, outcome, sum(runs)::text as runs
        from automation_run_counters group by trigger_kind, outcome`),
    );
  const rows = Array.isArray(result) ? result : result.rows;
  const values = new Map(rows.map((row) => [`${row.trigger_kind}:${row.outcome}`, row.runs]));
  const name = "opengeni_automation_runs_total";
  const quote = (label: string) =>
    `"${label.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`;
  const base = `service=${quote(settings.serviceName)},environment=${quote(settings.environment)},component="api",deployment_revision=${quote(settings.deploymentRevision ?? "dev")}`;
  const lines = [
    `# HELP ${name} Persisted automation runs reaching a terminal outcome, shared by all API replicas.`,
    `# TYPE ${name} counter`,
  ];
  for (const kind of AUTOMATION_TRIGGERS) {
    for (const outcome of AUTOMATION_OUTCOMES) {
      lines.push(
        `${name}{trigger_kind="${kind}",outcome="${outcome}",${base}} ${values.get(`${kind}:${outcome}`) ?? "0"}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Register the Prometheus exposition route on one Hono app. */
export function registerPrometheusMetricsRoute(
  app: Hono,
  observability: PrometheusSource,
  automation?: () => Promise<string>,
): void {
  app.get("/metrics", async (c) => {
    // If PostgreSQL is unreachable, omit this family rather than exporting a
    // false reset or preventing collection of process-local telemetry.
    const [metrics, runs] = await Promise.all([
      observability.prometheusMetrics(),
      automation?.().catch(() => "") ?? "",
    ]);
    return c.text(metrics + runs, 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
}

/**
 * Whether the public API listener serves `GET /metrics`. A deployment that sets
 * `OPENGENI_API_METRICS_PORT` moves the exposition to a dedicated internal
 * listener, so an ingress that forwards every path to the API cannot publish it.
 */
export function publicListenerServesMetrics(settings: Pick<Settings, "apiMetricsPort">): boolean {
  return settings.apiMetricsPort === undefined;
}

/**
 * The dedicated metrics listener: only `GET /metrics`, behind the same
 * deployment-key perimeter rules as the public listener. Nothing else is
 * routed here, so exposing this port to a scraper exposes nothing else.
 */
export function createMetricsListenerApp(
  settings: Settings,
  observability: PrometheusSource,
  db?: Database,
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("x-content-type-options")) c.header("x-content-type-options", "nosniff");
  });
  app.use("*", requireAccessKey(settings));
  registerPrometheusMetricsRoute(
    app,
    observability,
    db ? () => automationRunMetrics(db, settings) : undefined,
  );
  return app;
}

/** Start the dedicated listener when configured; returns undefined otherwise. */
export function startApiMetricsListener(
  settings: Settings,
  observability: PrometheusSource,
  drain?: Pick<HttpServerDrain, "fetch">,
  db?: Database,
): ReturnType<typeof Bun.serve> | undefined {
  const port = settings.apiMetricsPort;
  if (port === undefined) return undefined;
  if (port === settings.apiPort) {
    throw new Error("OPENGENI_API_METRICS_PORT must differ from OPENGENI_API_PORT");
  }
  const app = createMetricsListenerApp(settings, observability, db);
  const fetch = (request: Request) => app.fetch(request);
  return Bun.serve({
    hostname: settings.apiHost,
    port,
    fetch: drain ? drain.fetch(fetch) : fetch,
  });
}
