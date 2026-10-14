import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import {
  httpRejectionFactsFromEnvelope,
  httpRejectionFactsFromError,
  normalizeRejectionMessage,
  readRejectionEnvelope,
  rejectionFingerprint,
} from "../src/http/rejection-telemetry";

const sentinel = "SECRET_REJECTION_SENTINEL_5d1c";

describe("HTTP rejection telemetry", () => {
  test("names the missing catalog permission without copying the message", () => {
    const facts = httpRejectionFactsFromEnvelope(
      { error: { status: 403, code: "forbidden", message: "missing permission: stream:view" } },
      "forbidden",
    );
    expect(facts.code).toBe("forbidden");
    expect(facts.reason).toBe("permission:stream:view");
    expect(facts.fingerprint).toMatch(/^m_[0-9a-f]{10}$/);
    expect(JSON.stringify(facts)).not.toContain("missing permission");
  });

  test("an unknown permission name is never echoed as a reason", () => {
    const facts = httpRejectionFactsFromEnvelope(
      { error: { code: "forbidden", message: `missing permission: ${sentinel}:x` } },
      "forbidden",
    );
    expect(facts.reason).toBe("unclassified");
    expect(JSON.stringify(facts)).not.toContain(sentinel);
  });

  test("uses a typed detail code and falls back for a foreign envelope code", () => {
    const facts = httpRejectionFactsFromEnvelope(
      {
        error: {
          code: "not-a-public-code",
          message: `Workspace ${sentinel} is busy`,
          details: { code: "WORKSPACE_CONTROL_BUSY" },
        },
      },
      "upstream_unavailable",
    );
    expect(facts).toMatchObject({ code: "upstream_unavailable", reason: "WORKSPACE_CONTROL_BUSY" });
    expect(JSON.stringify(facts)).not.toContain(sentinel);
    const freeText = httpRejectionFactsFromEnvelope(
      { error: { code: "conflict", message: "x", details: { code: `has spaces ${sentinel}` } } },
      "conflict",
    );
    expect(freeText.reason).toBe("unclassified");
  });

  test("fingerprints ignore identifiers, quoted values, and numbers", () => {
    expect(
      rejectionFingerprint('Session 3f0c8a47-1d2e-4b6f-9a10-0123456789ab not found in "Acme"'),
    ).toBe(
      rejectionFingerprint("Session 11111111-2222-4333-8444-555555555555 not found in 'Other'"),
    );
    expect(normalizeRejectionMessage("limit 42 of 100")).toBe("limit 0 of 0");
    expect(rejectionFingerprint("workspace access denied")).not.toBe(
      rejectionFingerprint("organization is not available"),
    );
  });

  test("classifies a thrown error that escaped the error handler", () => {
    expect(
      httpRejectionFactsFromError(new Error("missing permission: members:manage"), "forbidden"),
    ).toMatchObject({ code: "forbidden", reason: "permission:members:manage" });
  });

  test("reads small JSON bodies without consuming the client response", async () => {
    const response = new Response(JSON.stringify({ error: { code: "forbidden" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    expect(await readRejectionEnvelope(response)).toEqual({ error: { code: "forbidden" } });
    expect(await response.json()).toEqual({ error: { code: "forbidden" } });
    const stream = new Response("data: x\n\n", {
      status: 409,
      headers: { "content-type": "text/event-stream" },
    });
    expect(await readRejectionEnvelope(stream)).toBeUndefined();
    const large = new Response("{}", {
      status: 400,
      headers: { "content-type": "application/json", "content-length": String(1 << 20) },
    });
    expect(await readRejectionEnvelope(large)).toBeUndefined();
  });

  test("structured logs keep bounded rejection fields and drop malformed ones", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const observability = createObservability(
        {
          serviceName: "opengeni",
          environment: "test",
          deploymentRevision: "revision-test",
          observabilityStructuredLogs: true,
          observabilityMetricsEnabled: true,
          observabilityOtlpEndpoint: "",
          observabilityOtlpHeaders: "",
        },
        { component: "api" },
      );
      observability.info("HTTP request completed", {
        route: "/v1/workspaces/:workspaceId/machines",
        status: 403,
        rejectionCode: "forbidden",
        rejectionReason: "permission:stream:view",
        rejectionFingerprint: "m_0123456789",
      });
      observability.info("HTTP request completed", {
        status: 403,
        rejectionCode: `forbidden ${sentinel}`,
        rejectionReason: `free text ${sentinel}`,
        rejectionFingerprint: sentinel,
      });
    } finally {
      console.log = original;
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({
      rejectionCode: "forbidden",
      rejectionReason: "permission:stream:view",
      rejectionFingerprint: "m_0123456789",
    });
    expect(lines[1]).not.toContain(sentinel);
  });

  test("the rejection counter collapses out-of-grammar values", async () => {
    const observability = createObservability(
      {
        serviceName: "opengeni",
        environment: "test",
        deploymentRevision: "revision-test",
        observabilityStructuredLogs: false,
        observabilityMetricsEnabled: true,
        observabilityOtlpEndpoint: "",
        observabilityOtlpHeaders: "",
      },
      { component: "api" },
    );
    observability.recordHttpRejection({
      method: "POST",
      route: "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/attachments",
      status: 403,
      code: "forbidden",
      reason: "permission:stream:view",
    });
    observability.recordHttpRejection({
      method: "GET",
      route: "/v1/workspaces/:workspaceId/machines",
      status: 403,
      code: sentinel,
      reason: `free text ${sentinel}`,
    });
    const metrics = await observability.prometheusMetrics();
    const series = metrics
      .split("\n")
      .filter((line) => line.startsWith("opengeni_http_request_rejections_total{"));
    expect(series).toHaveLength(2);
    const attachment = series.find((line) => line.includes("attachments"))!;
    for (const label of [
      'code="forbidden"',
      'reason="permission:stream:view"',
      'status="403"',
      'method="POST"',
    ])
      expect(attachment).toContain(label);
    expect(attachment.endsWith(" 1")).toBe(true);
    expect(metrics).toContain('code="other"');
    expect(metrics).not.toContain(sentinel);
  });
});

describe("API request middleware", () => {
  test("counts and logs a rejected request while the client still receives the envelope", async () => {
    const { createApp } = await import("../src/app");
    const { testSettings } = await import("@opengeni/testing");
    const settings = testSettings();
    const observability = createObservability(
      { ...settings, observabilityStructuredLogs: false, observabilityMetricsEnabled: true },
      { component: "api" },
    );
    const app = createApp({
      settings,
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
      observability,
    });
    const response = await app.request(
      "/v1/workspaces/00000000-0000-4000-8000-000000000001/not-a-route",
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
    const series = (await observability.prometheusMetrics())
      .split("\n")
      .filter((line) => line.startsWith("opengeni_http_request_rejections_total{"));
    expect(
      series.some((line) => line.includes('code="not_found"') && line.includes('status="404"')),
    ).toBe(true);
  });
});
