import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import {
  boundedConnectReason,
  classifyOAuthCallback,
  connectMetricProvider,
  observeConnectAttemptTransition,
  observeOAuthCallback,
} from "../src/integration-connect-metrics";
import {
  interactionRouteFailureReason,
  interactionRouteOperation,
  observeInteractionRouteOutcome,
} from "../src/interaction-metrics";

const sentinel = "SECRET_PRODUCT_METRIC_SENTINEL_77a1";

function observability() {
  return createObservability(
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
}

async function series(observed: ReturnType<typeof observability>, name: string) {
  return (await observed.prometheusMetrics())
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`));
}

describe("Browser/Computer route outcomes", () => {
  const attachments = "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/attachments";

  test("a refused handoff attachment is a denied attach with its permission reason", async () => {
    const observed = observability();
    observeInteractionRouteOutcome(observed, {
      method: "POST",
      route: attachments,
      status: 403,
      durationMs: 12,
      rejectionReason: "permission:stream:view",
    });
    observeInteractionRouteOutcome(observed, {
      method: "POST",
      route: attachments,
      status: 200,
      durationMs: 12,
    });
    const lines = await series(observed, "opengeni_interaction_operations_total");
    const denied = lines.find((line) => line.includes('outcome="denied"'))!;
    expect(denied).toContain('operation="attach"');
    expect(denied).toContain('reason="permission_denied"');
    expect(
      lines.some((line) => line.includes('outcome="completed"') && line.includes('reason="none"')),
    ).toBe(true);
  });

  test("routes whose handler records success are counted here only on failure", async () => {
    const observed = observability();
    const actions = "/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/actions";
    observeInteractionRouteOutcome(observed, {
      method: "POST",
      route: actions,
      status: 200,
      durationMs: 5,
    });
    expect(await series(observed, "opengeni_interaction_operations_total")).toHaveLength(0);
    observeInteractionRouteOutcome(observed, {
      method: "POST",
      route: actions,
      status: 503,
      durationMs: 5,
      rejectionReason: "control:agent_offline",
    });
    const [line] = await series(observed, "opengeni_interaction_operations_total");
    expect(line).toContain('resource="computer"');
    expect(line).toContain('outcome="failed"');
    expect(line).toContain('reason="control_agent_offline"');
  });

  test("observe, tabs, and target routes are mapped; listing routes are not", () => {
    expect(
      interactionRouteOperation(
        "GET",
        "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/observation",
      )?.operation,
    ).toBe("observe");
    expect(
      interactionRouteOperation(
        "POST",
        "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets",
      )?.operation,
    ).toBe("open_target");
    expect(
      interactionRouteOperation("GET", "/v1/workspaces/:workspaceId/browser-sessions"),
    ).toBeNull();
    expect(interactionRouteFailureReason(409, "target_stale")).toBe("target_stale");
    expect(interactionRouteFailureReason(403, "unclassified")).toBe("access_denied");
    expect(interactionRouteFailureReason(404, undefined)).toBe("not_found");
  });
});

describe("connect telemetry", () => {
  test("bounds caller-chosen provider ids and reason codes", () => {
    expect(connectMetricProvider("gmail")).toBe("gmail");
    expect(connectMetricProvider("google-drive")).toBe("google-drive");
    expect(connectMetricProvider(`https://${sentinel}.example/mcp`)).toBe("other");
    expect(boundedConnectReason("upstream_http_502")).toBe("upstream_http_5xx");
    expect(boundedConnectReason("http_404")).toBe("http_4xx");
    expect(boundedConnectReason(`Bad ${sentinel}`)).toBe("other");
    expect(boundedConnectReason(undefined)).toBe("none");
  });

  test("counts attempt starts and terminal states", async () => {
    const observed = observability();
    observeConnectAttemptTransition(observed, {
      providerId: "mcp-oauth",
      previousState: null,
      state: "requires_user_action",
      errorCode: null,
    });
    observeConnectAttemptTransition(observed, {
      providerId: sentinel,
      previousState: "provider_wait",
      state: "failed",
      errorCode: "provider_denied",
    });
    const lines = await series(observed, "opengeni_connect_attempts_total");
    expect(
      lines.some(
        (line) => line.includes('state="started"') && line.includes('provider="mcp-oauth"'),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.includes('state="failed"') &&
          line.includes('provider="other"') &&
          line.includes('error="provider_denied"'),
      ),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain(sentinel);
  });

  test("classifies provider callbacks from the redirect marker only", async () => {
    expect(
      classifyOAuthCallback({
        route: "/v1/integrations/oauth/callback",
        status: 302,
        location:
          "/w/x/integrations?integration_oauth=error&stage=token_exchange&reason=token_exchange_failed",
      }),
    ).toEqual({
      flow: "mcp_oauth",
      provider: "mcp_oauth",
      outcome: "failure",
      stage: "token_exchange",
      reason: "token_exchange_failed",
    });
    expect(
      classifyOAuthCallback({
        route: "/v1/integrations/provider-oauth/callback",
        status: 302,
        location: "/x?integration_oauth=success&definitionId=google-drive",
      }),
    ).toMatchObject({ provider: "google-drive", outcome: "success" });
    expect(
      classifyOAuthCallback({
        route: "/v1/integrations/slack/callback",
        status: 302,
        location: "/x?slack=error&reason=access_denied",
      }),
    ).toMatchObject({ flow: "slack_bot", outcome: "cancelled" });
    expect(
      classifyOAuthCallback({
        route: "/v1/github/oauth/callback",
        status: 403,
        location: null,
      }),
    ).toMatchObject({ flow: "github_app", outcome: "failure", reason: "http_4xx" });
    expect(
      classifyOAuthCallback({
        route: "/v1/integrations/google-drive/callback",
        status: 302,
        location: "https://app.example/connect/return",
      }),
    ).toMatchObject({ outcome: "handoff" });
    const observed = observability();
    observeOAuthCallback(observed, {
      route: "/v1/integrations/oauth/callback",
      status: 302,
      location: `/x?integration_oauth=error&reason=${encodeURIComponent(sentinel)}`,
    });
    const lines = await series(observed, "opengeni_integration_oauth_callbacks_total");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('reason="other"');
    expect(lines[0]).not.toContain(sentinel);
  });
});
