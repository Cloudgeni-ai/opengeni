import { describe, expect, test } from "bun:test";
import {
  AuthenticationRequiredRefusal,
  MissingPermissionRefusal,
  WORKSPACE_SETTINGS_REFUSAL,
} from "@opengeni/core";
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

  test("a refused session create names its guard instead of logging unclassified", () => {
    // The create route answers with its own top-level body, not the envelope.
    const latency = httpRejectionFactsFromEnvelope(
      {
        code: "SESSION_CREATE_REJECTED",
        message: `latency mode fast is not runnable for model codex/${sentinel}`,
        details: {
          code: "UNSUPPORTED_LATENCY_MODE",
          modelId: `codex/${sentinel}`,
        },
      },
      "validation_failed",
    );
    expect(latency.code).toBe("validation_failed");
    expect(latency.reason).toBe("UNSUPPORTED_LATENCY_MODE");
    expect(latency.fingerprint).toMatch(/^m_[0-9a-f]{10}$/);
    expect(JSON.stringify(latency)).not.toContain(sentinel);

    const policy = httpRejectionFactsFromEnvelope(
      {
        code: "SESSION_CREATE_REJECTED",
        message: `model "codex/${sentinel}" is not allowed by this workspace's model policy`,
      },
      "validation_failed",
    );
    const unavailable = httpRejectionFactsFromEnvelope(
      {
        code: "SESSION_CREATE_REJECTED",
        message: `model "codex/${sentinel}" is not available`,
      },
      "validation_failed",
    );
    expect(policy.reason).toBe("SESSION_CREATE_REJECTED");
    expect(policy.fingerprint).toMatch(/^m_[0-9a-f]{10}$/);
    // Two different guards behind the same route code stay distinguishable.
    expect(policy.fingerprint).not.toBe(unavailable.fingerprint);
    expect(JSON.stringify(policy)).not.toContain(sentinel);

    expect(
      httpRejectionFactsFromEnvelope(
        {
          code: "INVALID_SESSION_CREATE_REQUEST",
          message: "Invalid session create request",
        },
        "validation_failed",
      ).reason,
    ).toBe("INVALID_SESSION_CREATE_REQUEST");
    // A free-text route code is never echoed.
    expect(
      httpRejectionFactsFromEnvelope({ code: `has spaces ${sentinel}` }, "validation_failed")
        .reason,
    ).toBe("unclassified");
    // A passed-through upstream body (lowercase code, its own details) is not
    // one of our route bodies, so it can't add reason values.
    expect(
      httpRejectionFactsFromEnvelope(
        { code: "model_not_found", details: { code: "upstream_detail" } },
        "validation_failed",
      ).reason,
    ).toBe("unclassified");
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

  test("names the permission a plain-sentence refusal carries in details", () => {
    const facts = httpRejectionFactsFromEnvelope(
      {
        error: {
          status: 403,
          code: "forbidden",
          message: "You don't have permission to manage this workspace's tools and integrations.",
          details: {
            code: "missing_permission",
            permission: "capabilities:manage",
          },
        },
      },
      "forbidden",
    );
    expect(facts.reason).toBe("permission:capabilities:manage");
    const foreign = httpRejectionFactsFromEnvelope(
      {
        error: {
          code: "forbidden",
          message: "x",
          details: { permission: `${sentinel}:x` },
        },
      },
      "forbidden",
    );
    expect(foreign.reason).toBe("unclassified");
    expect(JSON.stringify(foreign)).not.toContain(sentinel);
  });

  test("classifies the shared settings refusal as workspace:admin", () => {
    expect(
      httpRejectionFactsFromError(
        new MissingPermissionRefusal("workspace:admin", {
          message: WORKSPACE_SETTINGS_REFUSAL,
        }),
        "forbidden",
      ),
    ).toMatchObject({
      code: "forbidden",
      reason: "permission:workspace:admin",
    });
  });

  test("classifies a thrown error that escaped the error handler", () => {
    expect(
      httpRejectionFactsFromError(new Error("missing permission: members:manage"), "forbidden"),
    ).toMatchObject({ code: "forbidden", reason: "permission:members:manage" });
  });

  test("a lapsed or missing sign-in is classified, not unclassified", () => {
    expect(
      httpRejectionFactsFromEnvelope(
        {
          error: {
            code: "unauthenticated",
            message: "authentication required",
            details: { code: "session_missing" },
          },
        },
        "unauthenticated",
      ),
    ).toMatchObject({ code: "unauthenticated", reason: "session_missing" });
    expect(
      httpRejectionFactsFromError(
        new AuthenticationRequiredRefusal("session_expired"),
        "unauthenticated",
      ),
    ).toMatchObject({ code: "unauthenticated", reason: "session_expired" });
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
  test("a missing permission reaches the client as a plain sentence with typed details", async () => {
    const { createApp } = await import("../src/app");
    const { testSettings } = await import("@opengeni/testing/settings");
    const settings = testSettings();
    const observability = createObservability(
      {
        ...settings,
        observabilityStructuredLogs: false,
        observabilityMetricsEnabled: true,
      },
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
    app.get("/v1/test-only/refusal", () => {
      throw new MissingPermissionRefusal("capabilities:manage");
    });
    const response = await app.request("/v1/test-only/refusal");
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };
    expect(body.error).toMatchObject({
      code: "forbidden",
      message: "You don't have permission to manage this workspace's tools and integrations.",
      details: {
        code: "missing_permission",
        permission: "capabilities:manage",
      },
    });
    expect(body.error.message).not.toContain("missing permission");
    const series = (await observability.prometheusMetrics())
      .split("\n")
      .filter((line) => line.startsWith("opengeni_http_request_rejections_total{"));
    expect(
      series.some((line) => line.includes('reason="permission:capabilities:manage"')),
      series.join("\n"),
    ).toBe(true);
  });

  test("counts and logs a rejected request while the client still receives the envelope", async () => {
    const { createApp } = await import("../src/app");
    const { testSettings } = await import("@opengeni/testing/settings");
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

  test("a request without a sign-in says why, in the envelope and the rejection metric", async () => {
    const { createApp } = await import("../src/app");
    const { testSettings } = await import("@opengeni/testing/settings");
    const settings = testSettings({ productAccessMode: "managed" });
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
    // A lapsed sign-in (a cookie or app credential that no longer signs anyone
    // in) needs the database; the desktop sign-in integration test covers it.
    const response = await app.request("/v1/access/me");
    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { code: string; message: string; details?: { code?: string } };
    };
    expect(body.error).toMatchObject({
      code: "unauthenticated",
      message: "authentication required",
      details: { code: "session_missing" },
    });
    const series = (await observability.prometheusMetrics())
      .split("\n")
      .filter((line) => line.startsWith("opengeni_http_request_rejections_total{"));
    expect(
      series.some(
        (line) =>
          line.includes('code="unauthenticated"') && line.includes('reason="session_missing"'),
      ),
      series.join("\n"),
    ).toBe(true);
    expect(series.some((line) => line.includes('reason="unclassified"'))).toBe(false);
  });
});
