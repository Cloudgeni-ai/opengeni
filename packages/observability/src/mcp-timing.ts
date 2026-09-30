import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Observability } from "./index";
import { currentTraceContext, withTraceContext, type TraceContext } from "./trace-context";

export const MCP_EXECUTION_PHASES = [
  "gateway_policy",
  "preflight",
  "lifecycle_prepare",
  "lifecycle_begin",
  "lifecycle_complete",
  "client_setup",
  "credential_resolution",
  "oauth_refresh",
  "oauth_wait",
  "provider_authorization",
  "network_headers",
  "network_body",
  "execution",
  "event_persistence",
] as const;
export type McpExecutionPhase = (typeof MCP_EXECUTION_PHASES)[number];
export type McpPhaseOutcome = "completed" | "rejected" | "failed" | "cancelled";
type Context = { observer: Observability; scope: string; callKey?: string; nextRequest: number };
const storage = new AsyncLocalStorage<Context | undefined>();

/** Capture only diagnostic context for callbacks invoked by an external dispatcher. */
export function bindMcpTelemetry<A extends unknown[], R>(
  run: (...args: A) => R,
): (...args: A) => R {
  const context = storage.getStore();
  const trace = currentTraceContext();
  return (...args) => storage.run(context, () => withTraceContext(trace, () => run(...args)));
}

/** Host-owned scope only. Never install an observer or identity from transport metadata. */
export function withMcpTelemetry<T>(observer: Observability, scope: string, run: () => T): T {
  return storage.run({ observer, scope, nextRequest: 0 }, run);
}

/** Opaque identity for joining phases, not permission or an idempotency key. */
export function withMcpCallIdentity<T>(identity: string, run: () => T): T {
  const context = storage.getStore();
  if (!context || typeof identity !== "string") return run();
  let callKey: string;
  try {
    callKey = `mcp_${createHash("sha256")
      .update("opengeni:mcp-call:v1\0")
      .update(context.scope)
      .update("\0")
      .update(identity)
      .digest("hex")
      .slice(0, 32)}`;
  } catch {
    // Canonical input validation, not telemetry, owns malformed call errors.
    return run();
  }
  if (context.callKey === callKey) return run();
  return storage.run({ ...context, callKey, nextRequest: 0 }, run);
}

export function beginMcpPhase(phase: McpExecutionPhase) {
  const context = storage.getStore();
  const started = performance.now();
  const attributes = context?.callKey ? { mcpCallKey: context.callKey } : {};
  const requestIndex = phase === "network_headers" && context ? ++context.nextRequest : undefined;
  let span: ReturnType<Observability["startSpan"]> | undefined;
  try {
    span = context?.observer.startSpan(`mcp.phase.${phase}`, {
      ...attributes,
      ...(requestIndex === undefined ? {} : { attempt: requestIndex }),
    });
  } catch {
    /* Observation cannot alter execution. */
  }
  const traceContext: TraceContext | undefined = span ?? currentTraceContext();
  let ended = false;
  return {
    traceContext,
    run: <T>(run: () => T): T => withTraceContext(traceContext, run),
    end: (outcome: McpPhaseOutcome = "completed") => {
      if (ended) return;
      ended = true;
      const durationMs = Math.max(0, performance.now() - started);
      try {
        span?.end({
          attributes: { outcome, "opengeni.duration_ms": durationMs },
          ...(outcome === "completed" ? {} : { error: new Error(`MCP phase ${outcome}`) }),
        });
      } catch {
        /* Observation cannot alter execution. */
      }
      try {
        context?.observer.observeHistogram({
          name: "opengeni_mcp_phase_duration_seconds",
          help: "MCP execution phase duration; nested phases are not additive.",
          labels: { phase, outcome },
          value: durationMs / 1000,
        });
      } catch {
        /* Observation cannot alter execution. */
      }
    },
  };
}

export async function measureMcpPhase<T>(
  phase: McpExecutionPhase,
  run: () => T | Promise<T>,
  outcome?: (value: T) => McpPhaseOutcome,
): Promise<T> {
  const observation = beginMcpPhase(phase);
  try {
    const result = await observation.run(run);
    let classification: McpPhaseOutcome = "completed";
    try {
      classification = outcome?.(result) ?? classification;
    } catch {
      /* No behavioral effect. */
    }
    observation.end(classification);
    return result;
  } catch (error) {
    observation.end("failed");
    throw error;
  }
}
