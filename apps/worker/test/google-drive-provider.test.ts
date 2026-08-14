import { describe, expect, test } from "bun:test";
import {
  GOOGLE_DRIVE_PROVIDER_REQUEST_TIMEOUT_MAX_MS,
  GOOGLE_DRIVE_PROVIDER_RETRY_DELAY_MAX_MS,
  type GoogleDriveProviderRetryOptions,
} from "@opengeni/config";
import { createObservability } from "@opengeni/observability";
import {
  fetchGoogleDriveProvider,
  GoogleDriveProviderTransportError,
} from "../src/activities/google-drive-provider";
import {
  KNOWLEDGE_SOURCE_SYNC_ACTIVITY_HEARTBEAT_TIMEOUT_MS,
  KNOWLEDGE_SOURCE_SYNC_ACTIVITY_MAXIMUM_ATTEMPTS,
} from "../src/knowledge-source-sync-activity-policy";

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
  test("keeps each provider wait below the activity heartbeat timeout", () => {
    expect(GOOGLE_DRIVE_PROVIDER_REQUEST_TIMEOUT_MAX_MS).toBeLessThan(
      KNOWLEDGE_SOURCE_SYNC_ACTIVITY_HEARTBEAT_TIMEOUT_MS,
    );
    expect(GOOGLE_DRIVE_PROVIDER_RETRY_DELAY_MAX_MS).toBeLessThan(
      KNOWLEDGE_SOURCE_SYNC_ACTIVITY_HEARTBEAT_TIMEOUT_MS,
    );
  });

  test("does not let Temporal multiply the local provider-attempt bound", () => {
    expect(KNOWLEDGE_SOURCE_SYNC_ACTIVITY_MAXIMUM_ATTEMPTS).toBe(1);
  });

  test("retries 429 with bounded backoff and records low-cardinality telemetry", async () => {
    const delays: number[] = [];
    const heartbeatPhases: string[] = [];
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
      operation: "list_children",
      policy,
      observability: obs,
      heartbeat: ({ attempt, phase }) => heartbeatPhases.push(`${attempt}:${phase}`),
      now: () => nowMs,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        nowMs += delayMs;
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(delays).toEqual([200]);
    expect(heartbeatPhases).toEqual([
      "1:request_start",
      "1:request_end",
      "1:retry_delay_start",
      "1:retry_delay_end",
      "2:request_start",
      "2:request_end",
    ]);
    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_google_drive_provider_requests_total\{operation="list_children",outcome="retryable_error",[^}]+\} 1/,
    );
    expect(metrics).toMatch(
      /opengeni_google_drive_provider_requests_total\{operation="list_children",outcome="succeeded",[^}]+\} 1/,
    );
    expect(metrics).toMatch(
      /opengeni_google_drive_provider_retries_total\{operation="list_children",reason="rate_limited",[^}]+\} 1/,
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
      operation: "list_changes",
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
      operation: "get_file",
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
        operation: "download",
        policy: { ...policy, initialDelayMs: 500, budgetMs: 100 },
        observability: observability(),
        sleep: async () => {
          throw new Error("unexpected sleep");
        },
      }),
    ).rejects.toBeInstanceOf(GoogleDriveProviderTransportError);
    expect(calls).toBe(1);
  });

  test("keeps request execution time separate from the retry delay budget", async () => {
    let calls = 0;
    let nowMs = 0;
    const delays: number[] = [];
    const response = await fetchGoogleDriveProvider({
      fetchImpl: async () => {
        calls += 1;
        nowMs += 30_000;
        return calls === 1 ? new Response("busy", { status: 503 }) : Response.json({ ok: true });
      },
      url: "https://www.googleapis.com/drive/v3/files",
      init: {},
      operation: "list_children",
      policy: { ...policy, budgetMs: 100 },
      observability: observability(),
      now: () => nowMs,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(delays).toEqual([100]);
  });
});
