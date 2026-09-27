import type { Settings } from "@opengeni/config";
import { Hono } from "hono";

import { requireAccessKey } from "./auth";

type PrometheusSource = { prometheusMetrics(): Promise<string> };

/** Register the Prometheus exposition route on one Hono app. */
export function registerPrometheusMetricsRoute(app: Hono, observability: PrometheusSource): void {
  app.get("/metrics", async (c) =>
    c.text(await observability.prometheusMetrics(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    }),
  );
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
): Hono {
  const app = new Hono();
  app.use("*", requireAccessKey(settings));
  registerPrometheusMetricsRoute(app, observability);
  return app;
}

/** Start the dedicated listener when configured; returns undefined otherwise. */
export function startApiMetricsListener(
  settings: Settings,
  observability: PrometheusSource,
): ReturnType<typeof Bun.serve> | undefined {
  const port = settings.apiMetricsPort;
  if (port === undefined) return undefined;
  if (port === settings.apiPort) {
    throw new Error("OPENGENI_API_METRICS_PORT must differ from OPENGENI_API_PORT");
  }
  const app = createMetricsListenerApp(settings, observability);
  return Bun.serve({
    hostname: settings.apiHost,
    port,
    fetch: (request) => app.fetch(request),
  });
}
