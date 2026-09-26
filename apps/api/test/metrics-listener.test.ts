import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";

import { createApp } from "../src/app";
import { createMetricsListenerApp, startApiMetricsListener } from "../src/http/metrics-listener";

const exposition = "# TYPE opengeni_test_total counter\nopengeni_test_total 1\n";
const observability = { prometheusMetrics: async () => exposition };

function publicApp(settings = testSettings()) {
  return createApp({
    settings,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
}

describe("API metrics listener", () => {
  test("the public listener keeps serving /metrics when no metrics port is configured", async () => {
    const response = await publicApp().request("http://localhost/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  test("a configured metrics port removes /metrics from the public listener", async () => {
    const response = await publicApp(testSettings({ apiMetricsPort: 9464 })).request(
      "http://app.example.test/metrics",
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("opengeni_");
  });

  test("the dedicated listener serves only the exposition", async () => {
    const app = createMetricsListenerApp(testSettings({ apiMetricsPort: 9464 }), observability);
    const metrics = await app.request("http://10.0.0.1:9464/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await metrics.text()).toBe(exposition);
    for (const path of ["/", "/healthz", "/v1/config/client", "/metrics/extra"]) {
      expect((await app.request(`http://10.0.0.1:9464${path}`)).status).toBe(404);
    }
  });

  test("the dedicated listener keeps the deployment-key perimeter rules", async () => {
    const accessKey = "metrics-listener-access-key";
    const guarded = createMetricsListenerApp(
      testSettings({ apiMetricsPort: 9464, authRequired: true, accessKey }),
      observability,
    );
    expect((await guarded.request("http://10.0.0.1:9464/metrics")).status).toBe(401);
    expect(
      (
        await guarded.request("http://10.0.0.1:9464/metrics", {
          headers: { authorization: `Bearer ${accessKey}` },
        })
      ).status,
    ).toBe(200);
    const allowed = createMetricsListenerApp(
      testSettings({ apiMetricsPort: 9464, authRequired: true, accessKey, authAllowMetrics: true }),
      observability,
    );
    expect((await allowed.request("http://10.0.0.1:9464/metrics")).status).toBe(200);
  });

  test("starts a real listener only when configured, on a port distinct from the API", async () => {
    expect(startApiMetricsListener(testSettings(), observability)).toBeUndefined();
    expect(() =>
      startApiMetricsListener(testSettings({ apiPort: 8000, apiMetricsPort: 8000 }), observability),
    ).toThrow("OPENGENI_API_METRICS_PORT must differ from OPENGENI_API_PORT");

    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const server = startApiMetricsListener(
      testSettings({ apiHost: "127.0.0.1", apiMetricsPort: port }),
      observability,
    )!;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(exposition);
      expect((await fetch(`http://127.0.0.1:${port}/v1/config/client`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("reads the port from OPENGENI_API_METRICS_PORT and leaves it unset by default", () => {
    expect(getSettings({}).apiMetricsPort).toBeUndefined();
    expect(getSettings({ OPENGENI_API_METRICS_PORT: "9464" }).apiMetricsPort).toBe(9464);
  });
});
