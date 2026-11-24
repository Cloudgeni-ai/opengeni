import { describe, expect, test } from "bun:test";
import {
  AuthenticationRequiredRefusal,
  MissingPermissionRefusal,
  WORKSPACE_SETTINGS_REFUSAL,
} from "@opengeni/core";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { createObservability, turnExecutionTelemetryKey } from "@opengeni/observability";
import {
  httpRejectionFactsFromEnvelope,
  httpRejectionFactsFromError,
  normalizeRejectionMessage,
  readRejectionEnvelope,
  rejectedCallerLogAttributes,
  rejectedCredentialTelemetryKey,
  rejectionFingerprint,
} from "../src/http/rejection-telemetry";
import { sitePublishingError } from "../src/site-publishing/service";

const sentinel = "SECRET_REJECTION_SENTINEL_5d1c";
const delegationSecret = "rejected-caller-test-delegation-secret";
const workspaceId = "00000000-0000-4000-8000-0000000000a1";
const sessionId = "00000000-0000-4000-8000-0000000000b2";
const attemptId = "00000000-0000-4000-8000-0000000000c3";

/** A Codemode attempt bearer like the worker mints, already expired. */
async function expiredAttemptBearer(secret = delegationSecret): Promise<string> {
  return await signDelegatedAccessToken(secret, {
    accountId: "00000000-0000-4000-8000-0000000000d4",
    workspaceId,
    subjectId: `sandbox:${attemptId}`,
    subjectLabel: "sandbox Codemode",
    permissions: ["codemode:call"],
    sessionId,
    turnId: "00000000-0000-4000-8000-0000000000e5",
    attemptId,
    executionGeneration: 1,
    principalKind: "agent_attempt",
    exp: Math.floor(Date.now() / 1000) - 3600,
  });
}

function callerHeaders(bearer: string | null, userAgent?: string): Headers {
  const headers = new Headers();
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (userAgent !== undefined) headers.set("user-agent", userAgent);
  return headers;
}

describe("rejected caller identity", () => {
  test("an expired attempt bearer is named by the worker's hashed attempt key", async () => {
    const bearer = await expiredAttemptBearer();
    const attributes = await rejectedCallerLogAttributes(
      callerHeaders(bearer, "opengeni-agent/0.1.171"),
      delegationSecret,
    );
    expect(attributes).toEqual({
      callerAgent: "opengeni-agent/0.1.171",
      callerCorrelationId: turnExecutionTelemetryKey(workspaceId, sessionId, attemptId),
    });
    const logged = JSON.stringify(attributes);
    for (const raw of [bearer, workspaceId, sessionId, attemptId]) {
      expect(logged).not.toContain(raw);
    }
  });

  test("a bearer that is not a verifiable attempt credential gets a stable hashed key", async () => {
    const forged = await expiredAttemptBearer("another-secret");
    for (const bearer of [forged, `og_${sentinel}`]) {
      const first = await rejectedCallerLogAttributes(callerHeaders(bearer), delegationSecret);
      const again = await rejectedCallerLogAttributes(callerHeaders(bearer), delegationSecret);
      expect(first).toEqual({ callerCredentialKey: rejectedCredentialTelemetryKey(bearer) });
      expect(again).toEqual(first);
      expect(first.callerCredentialKey).toMatch(/^cred_[0-9a-f]{32}$/);
      expect(JSON.stringify(first)).not.toContain(bearer);
      expect(JSON.stringify(first)).not.toContain(sentinel);
    }
    expect(rejectedCredentialTelemetryKey("a")).not.toBe(rejectedCredentialTelemetryKey("b"));
    // Without a delegation secret nothing is verified; the credential is still grouped.
    expect(
      await rejectedCallerLogAttributes(callerHeaders(await expiredAttemptBearer()), undefined),
    ).toEqual({
      callerCredentialKey: rejectedCredentialTelemetryKey(await expiredAttemptBearer()),
    });
  });

  test("names only the User-Agent product token, and nothing without a credential", async () => {
    expect(
      await rejectedCallerLogAttributes(
        callerHeaders(null, "Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0"),
        delegationSecret,
      ),
    ).toEqual({ callerAgent: "Mozilla/5.0" });
    expect(
      await rejectedCallerLogAttributes(callerHeaders(null, "curl"), delegationSecret),
    ).toEqual({ callerAgent: "curl" });
    for (const userAgent of ["", `"${sentinel}"`, `ok/${"9".repeat(40)}`, "-"]) {
      expect(
        await rejectedCallerLogAttributes(callerHeaders(null, userAgent), delegationSecret),
      ).toEqual({});
    }
    expect(await rejectedCallerLogAttributes(new Headers(), delegationSecret)).toEqual({});
  });
});

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

  test("a site gateway signature refusal logs its closed sub-reason", () => {
    const refusal = (reason: unknown) =>
      httpRejectionFactsFromEnvelope(
        {
          error: {
            code: "unauthenticated",
            message: "This request was not signed by the app gateway",
            details: { reason, code: "site_gateway_signature_invalid" },
          },
        },
        "unauthenticated",
      );
    expect(refusal("missing_headers")).toMatchObject({
      reason: "site_gateway_signature_invalid",
      detail: "missing_headers",
    });
    expect(refusal("bad_signature").detail).toBe("bad_signature");
    // Anything outside the closed set, or on another reason, is dropped.
    expect(refusal(`free ${sentinel}`)).not.toHaveProperty("detail");
    expect(refusal(7)).not.toHaveProperty("detail");
    expect(
      httpRejectionFactsFromEnvelope(
        { error: { code: "conflict", message: "x", details: { code: "busy", reason: "skew" } } },
        "conflict",
      ),
    ).not.toHaveProperty("detail");
    // The refusal the site-runtime route actually throws, as the error
    // handler serializes it into the envelope this classifier reads.
    const thrown = sitePublishingError(
      401,
      "unauthenticated",
      "site_gateway_signature_invalid",
      "This request was not signed by the app gateway",
      { reason: "skew" },
    );
    expect(
      httpRejectionFactsFromEnvelope(
        { error: { code: thrown.code, message: thrown.message, details: thrown.details } },
        "unauthenticated",
      ),
    ).toMatchObject({ reason: "site_gateway_signature_invalid", detail: "skew" });
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
        rejectionDetail: "missing_headers",
        callerCorrelationId: `turn_${"a".repeat(32)}`,
        callerCredentialKey: `cred_${"b".repeat(32)}`,
        callerAgent: "opengeni-agent/0.1.171",
      });
      observability.info("HTTP request completed", {
        status: 403,
        rejectionCode: `forbidden ${sentinel}`,
        rejectionReason: `free text ${sentinel}`,
        rejectionFingerprint: sentinel,
        rejectionDetail: `free text ${sentinel}`,
        callerCorrelationId: sentinel,
        callerCredentialKey: `cred_${sentinel}`,
        callerAgent: `agent ${sentinel}`,
      });
    } finally {
      console.log = original;
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({
      rejectionCode: "forbidden",
      rejectionReason: "permission:stream:view",
      rejectionFingerprint: "m_0123456789",
      rejectionDetail: "missing_headers",
      callerCorrelationId: `turn_${"a".repeat(32)}`,
      callerCredentialKey: `cred_${"b".repeat(32)}`,
      callerAgent: "opengeni-agent/0.1.171",
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

  test("a refused request's log names the attempt whose process is still calling", async () => {
    const { createApp } = await import("../src/app");
    const { testSettings } = await import("@opengeni/testing/settings");
    const settings = testSettings({ delegationSecret });
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const observability = createObservability(
        { ...settings, observabilityStructuredLogs: true, observabilityMetricsEnabled: true },
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
      app.get("/v1/test-only/refused-caller", () => {
        throw new AuthenticationRequiredRefusal("credential_invalid");
      });
      const bearer = await expiredAttemptBearer();
      const response = await app.request("/v1/test-only/refused-caller", {
        headers: { authorization: `Bearer ${bearer}`, "user-agent": "opengeni-agent/0.1.171" },
      });
      expect(response.status).toBe(401);
      const completed = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((line) => line?.message === "HTTP request completed");
      expect(completed).toMatchObject({
        status: 401,
        rejectionReason: "credential_invalid",
        callerCorrelationId: turnExecutionTelemetryKey(workspaceId, sessionId, attemptId),
        callerAgent: "opengeni-agent/0.1.171",
      });
      expect(lines.join("\n")).not.toContain(bearer);
      expect(lines.join("\n")).not.toContain(sessionId);
    } finally {
      console.log = original;
    }
  });
});
