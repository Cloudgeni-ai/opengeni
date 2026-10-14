import type { ToolGatewayCatalogEntry } from "@opengeni/contracts";
import type { Observability } from "@opengeni/observability";

export type WorkspaceToolGatewayAdapter = "http" | "mcp";
export type WorkspaceToolGatewayOperation = "approval" | "call";
export type WorkspaceToolGatewayOutcome =
  | "ok"
  | "tool_error"
  | "approval_required"
  | "catalog_stale"
  | "invalid_input"
  | "not_found"
  | "rate_limited"
  | "failed";

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export function recordWorkspaceToolTargetOperation(
  observability: Observability | null | undefined,
  input: {
    operation: "resolve" | "invoke" | "target-approvals" | "manifest";
    outcome: "ok" | "failed";
    durationSeconds: number;
  },
): void {
  try {
    const labels = { operation: input.operation, outcome: input.outcome };
    observability?.incrementCounter({
      name: "opengeni_tool_target_operations_total",
      help: "Targeted workspace tool requests; never full-catalog fallback.",
      labels,
    });
    observability?.observeHistogram({
      name: "opengeni_tool_target_duration_seconds",
      help: "Total targeted request time including metadata, provider preparation and execution.",
      labels,
      buckets: DURATION_BUCKETS,
      value: Math.max(0, input.durationSeconds),
    });
  } catch {
    /* Observation never changes execution. */
  }
}

/**
 * Bounded preparation telemetry: how long the request spent constructing,
 * credentialing, connecting, and listing connectors before any execution, and
 * whether a call used target-only preparation through a catalog attestation.
 */
export function recordWorkspaceToolGatewayPreparation(
  observability: Observability | null | undefined,
  input: {
    operation: "catalog" | "call";
    scope: "complete" | "target";
    attestation: "hit" | "miss" | "mismatch" | "bypass" | "record";
    durationSeconds: number;
  },
): void {
  try {
    const labels = {
      operation: input.operation,
      scope: input.scope,
      attestation: input.attestation,
    };
    observability?.incrementCounter({
      name: "opengeni_tool_gateway_preparations_total",
      help: "Workspace tool gateway HTTP preparations by bounded operation, scope, and catalog attestation outcome.",
      labels,
    });
    observability?.observeHistogram({
      name: "opengeni_tool_gateway_preparation_duration_seconds",
      help: "Workspace tool gateway HTTP preparation wall time in seconds, before execution.",
      labels,
      buckets: DURATION_BUCKETS,
      value: Math.max(0, input.durationSeconds),
    });
  } catch {
    // Telemetry must never change gateway execution truth.
  }
}

/**
 * Low-cardinality gateway telemetry shared by HTTP/SDK/Site and aggregate MCP
 * adapters. Tool names, workspace/subject ids, arguments, results, credentials,
 * and approval tokens are excluded by construction.
 */
export function startWorkspaceToolGatewayObservation(
  observability: Observability | null | undefined,
  input: {
    adapter: WorkspaceToolGatewayAdapter;
    operation: WorkspaceToolGatewayOperation;
    source: ToolGatewayCatalogEntry["source"] | "aggregate";
  },
): { end: (outcome: WorkspaceToolGatewayOutcome) => void } {
  const startedAt = performance.now();
  let span: ReturnType<Observability["startSpan"]> | undefined;
  try {
    span = observability?.startSpan("opengeni.tool_gateway.operation", {
      surface: "workspace_tool_gateway",
      op: `${input.adapter}.${input.operation}`,
      provider: input.source,
    });
  } catch {
    // Telemetry must never change gateway execution truth.
  }
  let ended = false;
  return {
    end: (outcome) => {
      if (ended) return;
      ended = true;
      const durationMs = Math.max(0, performance.now() - startedAt);
      try {
        observability?.incrementCounter({
          name: "opengeni_tool_gateway_operations_total",
          help: "Workspace tool gateway operations by bounded adapter, operation, source, and outcome.",
          labels: {
            adapter: input.adapter,
            operation: input.operation,
            source: input.source,
            outcome,
          },
        });
        observability?.observeHistogram({
          name: "opengeni_tool_gateway_operation_duration_seconds",
          help: "Workspace tool gateway operation duration in seconds.",
          labels: {
            adapter: input.adapter,
            operation: input.operation,
            source: input.source,
          },
          buckets: DURATION_BUCKETS,
          value: durationMs / 1_000,
        });
        observability?.info("Workspace tool gateway operation completed", {
          surface: "workspace_tool_gateway",
          op: `${input.adapter}.${input.operation}`,
          provider: input.source,
          outcome,
          durationMs: Math.round(durationMs),
        });
      } catch {
        try {
          observability?.incrementCounter({
            name: "opengeni_observability_observer_errors_total",
            help: "Observability observer failures isolated from product execution.",
            labels: { observer: "workspace_tool_gateway" },
          });
        } catch {
          // Telemetry must never change gateway execution truth.
        }
      }
      try {
        span?.end({
          attributes: {
            outcome,
            "opengeni.duration_ms": Math.round(durationMs),
          },
        });
      } catch {
        // Telemetry must never change gateway execution truth.
      }
    },
  };
}
