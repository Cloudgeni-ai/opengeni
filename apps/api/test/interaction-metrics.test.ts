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
import {
  observeBrowserActionResult,
  observeComputerActionResult,
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
  test("classifies semantic, keyboard, clipboard, coordinate, and stale action outcomes", async () => {
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
