import { expect, spyOn, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { observedSdkVersion } from "../src/http/sdk-version";

test("SDK version telemetry is optional and bounds untrusted input without refusing a request", () => {
  expect(observedSdkVersion("4.6.1")).toBe("4.6.1");
  expect(observedSdkVersion("5.5.2-canary.41014501986001")).toBe("5.5.2-canary.41014501986001");
  for (const value of [
    undefined,
    "",
    "latest",
    "Bearer not-a-version",
    "1.2.3\n",
    `1.2.3-${"x".repeat(81)}`,
  ]) {
    expect(observedSdkVersion(value)).toBeUndefined();
  }
});

test("HTTP middleware accepts optional SDK diagnostics, records them outside metrics and permits CORS", async () => {
  const settings = testSettings({ observabilityMetricsEnabled: false });
  const observability = createObservability(settings, { component: "api" });
  const spans = spyOn(observability, "startSpan");
  const logs = spyOn(observability, "info").mockImplementation(() => {});
  const metrics = spyOn(observability, "recordHttpRequest");
  try {
    const app = createApp({
      settings,
      observability,
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    for (const value of [undefined, "unknown", "4.6.1"]) {
      const response = await app.request("/healthz", {
        headers: value ? { "x-opengeni-sdk-version": value } : {},
      });
      expect(response.status).toBe(200);
      expect(spans.mock.calls.at(-1)?.[1]?.["opengeni.sdk.version"]).toBe(
        value === "4.6.1" ? value : undefined,
      );
      expect(logs.mock.calls.at(-1)?.[1]?.sdkVersion).toBe(value === "4.6.1" ? value : undefined);
    }
    expect(JSON.stringify(metrics.mock.calls)).not.toContain("4.6.1");
    const preflight = await app.request("/v1/config/client", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-opengeni-sdk-version",
      },
    });
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "x-opengeni-sdk-version",
    );
  } finally {
    spans.mockRestore();
    logs.mockRestore();
    metrics.mockRestore();
  }
});
