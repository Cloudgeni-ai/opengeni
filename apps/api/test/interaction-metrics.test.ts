import { describe, expect, test } from "bun:test";
import {
  INTERACTION_PROTOCOL_VERSION,
  type BrowserActionReceipt,
  type BrowserActionRequest,
  type BrowserSessionMutationResponse,
  type ComputerActionReceipt,
  type ComputerActionRequest,
  type InteractionInterventionMutationResponse,
} from "@opengeni/contracts";
import { createObservability } from "@opengeni/observability";
import { BrowserControlRequestError } from "@opengeni/runtime/sandbox";
import {
  interactionFailureReasonFromError,
  observeBrowserActionResult,
  observeComputerActionResult,
  observeInteractionRouteOutcome,
  observeInterventionMutation,
  observeLifecycleResult,
} from "../src/interaction-metrics";

const settings = {
  serviceName: "opengeni",
  environment: "test",
  deploymentRevision: "revision-test",
  observabilityStructuredLogs: false,
  observabilityMetricsEnabled: true,
  observabilityOtlpEndpoint: "",
  observabilityOtlpHeaders: "",
};

describe("interaction metrics projection", () => {
  test("classifies semantic, keyboard, clipboard, permission, coordinate, and stale outcomes", async () => {
    const observability = createObservability(settings, { component: "api" });
    const browserReceipt = actionReceipt("browser", "completed") as BrowserActionReceipt;
    const staleComputerReceipt = actionReceipt(
      "computer",
      "failed",
      "target_stale",
    ) as ComputerActionReceipt;

    observeBrowserActionResult(
      observability,
      performance.now(),
      browserRequest({ type: "click", locator: { kind: "ref", ref: "node-1" } }),
      browserReceipt,
    );
    observeBrowserActionResult(
      observability,
      performance.now(),
      browserRequest({ type: "press", key: "Enter" }),
      browserReceipt,
    );
    observeBrowserActionResult(
      observability,
      performance.now(),
      browserRequest({ type: "clipboard", operation: "copy" }),
      browserReceipt,
    );
    observeBrowserActionResult(
      observability,
      performance.now(),
      browserRequest({ type: "permission", permission: "geolocation", setting: "denied" }),
      browserReceipt,
    );
    observeComputerActionResult(
      observability,
      performance.now(),
      computerRequest({
        type: "pointer",
        frameId: "frame-1",
        action: "click",
        x: 10,
        y: 20,
      }),
      staleComputerReceipt,
    );

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*mode="semantic"[^}]*operation="act"[^}]*outcome="completed"[^}]*resource="browser"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*mode="keyboard"[^}]*operation="act"[^}]*outcome="completed"[^}]*resource="browser"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*mode="clipboard"[^}]*operation="act"[^}]*outcome="completed"[^}]*resource="browser"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*mode="permission"[^}]*operation="act"[^}]*outcome="completed"[^}]*resource="browser"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*mode="coordinate"[^}]*operation="act"[^}]*outcome="stale"[^}]*resource="computer"[^}]*\} 1\b/,
    );
  });

  test("does not inflate lifecycle or intervention metrics on idempotent replay", async () => {
    const observability = createObservability(settings, { component: "api" });
    const lifecycle = {
      operation: {
        resourceKind: "browser_session",
        kind: "create",
        state: "completed",
        error: null,
        replayed: true,
      },
    } as unknown as BrowserSessionMutationResponse;
    const intervention = {
      replayed: true,
      intervention: {
        kind: "mfa",
        status: "completed",
        createdAt: "2026-08-10T12:00:00.000Z",
        settledAt: "2026-08-10T12:00:01.000Z",
      },
    } as unknown as InteractionInterventionMutationResponse;

    observeLifecycleResult(observability, performance.now(), lifecycle);
    observeInterventionMutation(observability, intervention);

    const metrics = await observability.prometheusMetrics();
    expect(metrics).not.toContain("opengeni_interaction_operations_total");
    expect(metrics).not.toContain("opengeni_interaction_interventions_total");
  });

  test("names why an action failed or its outcome is unknown, website failures apart", async () => {
    const observability = createObservability(settings, { component: "api" });
    const navigate = browserRequest({ type: "navigate", url: "https://example.test/" });
    // A website that never answered: the controller's reason beside the
    // receipt names it, not the generic outcome_unknown.
    observeBrowserActionResult(
      observability,
      performance.now(),
      navigate,
      actionReceipt("browser", "outcome_unknown", "outcome_unknown") as BrowserActionReceipt,
      "destination_not_answered",
    );
    // The specific failure behind a generic outcome_unknown.
    observeBrowserActionResult(
      observability,
      performance.now(),
      navigate,
      actionReceipt("browser", "outcome_unknown", "outcome_unknown") as BrowserActionReceipt,
      "timeout",
    );
    // Without a reason, an outcome_unknown keeps its own error code.
    observeBrowserActionResult(
      observability,
      performance.now(),
      navigate,
      actionReceipt("browser", "outcome_unknown", "controller_lost") as BrowserActionReceipt,
    );
    observeBrowserActionResult(
      observability,
      performance.now(),
      navigate,
      actionReceipt("browser", "outcome_unknown", "tab_not_responding") as BrowserActionReceipt,
    );
    // A reason from another process is checked against the closed set.
    observeBrowserActionResult(
      observability,
      performance.now(),
      navigate,
      actionReceipt("browser", "failed", "driver_failed") as BrowserActionReceipt,
      "https://example.test/" as never,
    );
    // A completed action has no failure reason, whatever was passed.
    observeBrowserActionResult(
      observability,
      performance.now(),
      navigate,
      actionReceipt("browser", "completed") as BrowserActionReceipt,
      "destination_not_answered",
    );

    const metrics = await observability.prometheusMetrics();
    const count = (outcome: string, reason: string) =>
      new RegExp(
        `opengeni_interaction_operations_total\\{[^}]*outcome="${outcome}"[^}]*reason="${reason}"[^}]*\\} 1\\b`,
      );
    expect(metrics).toMatch(count("outcome_unknown", "destination_not_answered"));
    expect(metrics).toMatch(count("outcome_unknown", "timeout"));
    expect(metrics).toMatch(count("outcome_unknown", "controller_lost"));
    expect(metrics).toMatch(count("outcome_unknown", "tab_not_responding"));
    expect(metrics).toMatch(count("failed", "driver_failed"));
    expect(metrics).toMatch(count("completed", "none"));
    expect(metrics).not.toMatch(/outcome="outcome_unknown"[^}]*reason="none"/);
    expect(metrics).not.toMatch(/opengeni_interaction_operations_total\{[^}]*reason="unknown"/);
  });

  test("names a website failure behind a refused tab open", async () => {
    const observability = createObservability(settings, { component: "api" });
    const route = "/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets";
    const refused = (failureReason: "destination_not_answered" | null) =>
      new BrowserControlRequestError(
        504,
        { code: "timeout", message: "server did not respond", retryable: true },
        null,
        failureReason,
      );
    // The API's HTTP error wraps the controller's refusal.
    const wrapped = new Error("route failed", { cause: refused("destination_not_answered") });
    expect(interactionFailureReasonFromError(wrapped)).toBe("destination_not_answered");
    expect(interactionFailureReasonFromError(refused(null))).toBeNull();
    expect(interactionFailureReasonFromError(new Error("other"))).toBeNull();
    expect(interactionFailureReasonFromError(undefined)).toBeNull();
    for (const [failureReason, method] of [
      [interactionFailureReasonFromError(wrapped), "POST"],
      [null, "POST"],
    ] as const) {
      observeInteractionRouteOutcome(observability, {
        method,
        route,
        status: 504,
        durationMs: 20_000,
        rejectionReason: "unclassified",
        failureReason,
      });
    }
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*operation="open_target"[^}]*outcome="failed"[^}]*reason="destination_not_answered"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_interaction_operations_total\{[^}]*operation="open_target"[^}]*outcome="failed"[^}]*reason="timeout"[^}]*\} 1\b/,
    );
  });
});

function browserRequest(action: BrowserActionRequest["action"]): BrowserActionRequest {
  return {
    operationId: "00000000-0000-4000-8000-000000000001",
    targetId: "target-1",
    expectedTargetGeneration: "generation-1",
    expectedDocumentGeneration: "document-1",
    expectedFrameId: null,
    action,
  };
}

function computerRequest(action: ComputerActionRequest["action"]): ComputerActionRequest {
  return {
    operationId: "00000000-0000-4000-8000-000000000002",
    targetId: "target-1",
    expectedTargetGeneration: "generation-1",
    expectedObservationId: "observation-1",
    expectedFrameId: action.type === "pointer" ? action.frameId : null,
    action,
  };
}

function actionReceipt(
  resource: "browser" | "computer",
  state: BrowserActionReceipt["state"],
  errorCode?: NonNullable<BrowserActionReceipt["error"]>["code"],
): BrowserActionReceipt | ComputerActionReceipt {
  const receipt = {
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    operationId: "00000000-0000-4000-8000-000000000003",
    controllerGeneration: "generation-1",
    targetId: "target-1",
    state,
    dispatchedAt: "2026-08-10T12:00:00.000Z",
    settledAt: "2026-08-10T12:00:00.100Z",
    observation: null,
    error: errorCode ? { code: errorCode, message: "bounded failure", retryable: false } : null,
  };
  return resource === "browser"
    ? { ...receipt, browserSessionId: "00000000-0000-4000-8000-000000000004" }
    : { ...receipt, computerSessionId: "00000000-0000-4000-8000-000000000005" };
}
