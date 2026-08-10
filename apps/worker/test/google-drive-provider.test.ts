import { describe, expect, test } from "bun:test";
import type { GoogleDriveProviderRetryOptions } from "@opengeni/config";
import { createObservability } from "@opengeni/observability";
import {
  fetchGoogleDriveProvider,
  GoogleDriveProviderTransportError,
} from "../src/activities/google-drive-provider";

const policy: GoogleDriveProviderRetryOptions = {
  requestTimeoutMs: 1_000,
  attempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 1_000,
  budgetMs: 5_000,
};

function observability() {
  return createObservability(
    {
      serviceName: "opengeni-test",
      environment: "test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: true,
      observabilityOtlpHeaders: "",
    },
    { component: "worker-control" },
  );
}

describe("Google Drive provider retry budget", () => {
  test("retries 429 with bounded backoff and records low-cardinality telemetry", async () => {
    const delays: number[] = [];
    let calls = 0;
    let nowMs = 0;
    const obs = observability();
    const response = await fetchGoogleDriveProvider({
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response("busy", { status: 429, headers: { "retry-after": "0.2" } })
          : Response.json({ ok: true });
      },
      url: "https://www.googleapis.com/drive/v3/files",
      init: {},
      operation: "list",
      policy,
      observability: obs,
      now: () => nowMs,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        nowMs += delayMs;
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(delays).toEqual([200]);
    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_google_drive_provider_requests_total\{operation="list",outcome="retryable_error",[^}]+\} 1/,
    );
    expect(metrics).toMatch(
      /opengeni_google_drive_provider_requests_total\{operation="list",outcome="succeeded",[^}]+\} 1/,
    );
    expect(metrics).toMatch(
      /opengeni_google_drive_provider_retries_total\{operation="list",reason="rate_limited",[^}]+\} 1/,
    );
  });

  test("returns the final retryable response when attempts are exhausted", async () => {
    let calls = 0;
    const response = await fetchGoogleDriveProvider({
      fetchImpl: async () => {
        calls += 1;
        return new Response("unavailable", { status: 503 });
      },
      url: "https://www.googleapis.com/drive/v3/files",
      init: {},
      operation: "list",
      policy: { ...policy, attempts: 2 },
      observability: observability(),
      sleep: async () => undefined,
    });

    expect(calls).toBe(2);
    expect(response.status).toBe(503);
  });

  test("does not retry permanent provider responses", async () => {
    let calls = 0;
    const response = await fetchGoogleDriveProvider({
      fetchImpl: async () => {
        calls += 1;
        return new Response("forbidden", { status: 403 });
      },
      url: "https://www.googleapis.com/drive/v3/files",
      init: {},
      operation: "list",
      policy,
      observability: observability(),
      sleep: async () => {
        throw new Error("unexpected sleep");
      },
    });

    expect(calls).toBe(1);
    expect(response.status).toBe(403);
  });

  test("bounds transport retries by the configured delay budget", async () => {
    let calls = 0;
    await expect(
      fetchGoogleDriveProvider({
        fetchImpl: async () => {
          calls += 1;
          throw new Error("network unavailable");
        },
        url: "https://www.googleapis.com/drive/v3/files",
        init: {},
        operation: "list",
        policy: { ...policy, initialDelayMs: 500, budgetMs: 100 },
        observability: observability(),
        sleep: async () => {
          throw new Error("unexpected sleep");
        },
      }),
    ).rejects.toBeInstanceOf(GoogleDriveProviderTransportError);
    expect(calls).toBe(1);
  });
});
