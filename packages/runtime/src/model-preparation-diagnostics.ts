import { AsyncLocalStorage } from "node:async_hooks";
import { addTraceProcessor, type Span, type Trace, type TracingProcessor } from "@openai/agents";

export type ModelPreparationPhase =
  | "sandbox_agent_preparation"
  | "sandbox_agent_manifest_inventory"
  | "sandbox_session_manifest_inventory"
  | "sandbox_manifest_apply"
  | "sandbox_entry_materialization"
  | "sandbox_running_check"
  | "sandbox_start"
  | "sandbox_client_create"
  | "sandbox_client_resume"
  | "sandbox_client_delete"
  | "sandbox_client_state_serialize"
  | "sandbox_client_reuse_check"
  | "sandbox_workspace_mutation_admission"
  | "sandbox_workspace_mutation_provider"
  | "sandbox_workspace_mutation_settlement"
  | "sandbox_first_routed_resolution_other"
  | "sandbox_first_routed_mutation_admission"
  | "sandbox_first_routed_provider_operation"
  | "sandbox_first_routed_mutation_settlement"
  | "sandbox_first_routed_other"
  | "sandbox_snapshot_wait"
  | "runner_before_first_sandbox_operation"
  | "sdk_after_first_sandbox_operation"
  | "runner_before_mcp_tools"
  | "mcp_tools_snapshot"
  | "mcp_tools_before_input_filter"
  | "input_filter_base"
  | "input_filter_genesis"
  | "input_filter_host"
  | "input_filter_tool_output"
  | "input_filter_modality"
  | "input_filter_context"
  | "responses_input_conversion"
  | "responses_request_build";

export type ModelPreparationMeasurement = {
  phase: ModelPreparationPhase;
  outcome: "completed" | "failed";
  durationSeconds: number;
  count?: number;
};

type ModelPreparationObserver = (measurement: ModelPreparationMeasurement) => void;

type ModelPreparationObservation = {
  observer: ModelPreparationObserver;
  startedAt: number;
  mcpToolsEndedAt?: number;
  firstSandboxOperationEndedAt?: number;
  runnerGapRecorded: boolean;
  postMcpGapRecorded: boolean;
  sdkAfterSandboxRecorded: boolean;
};

const modelPreparationObserver = new AsyncLocalStorage<ModelPreparationObservation>();
const modelTransportStartedObserver = new AsyncLocalStorage<() => Promise<void> | void>();

class ModelPreparationTraceProcessor implements TracingProcessor {
  async onTraceStart(_trace: Trace): Promise<void> {}
  async onTraceEnd(_trace: Trace): Promise<void> {}
  async onSpanStart(_span: Span<any>): Promise<void> {}

  async onSpanEnd(span: Span<any>): Promise<void> {
    if (
      span.spanData.type !== "custom" ||
      span.spanData.name !== "sandbox.prepare_agent" ||
      !span.startedAt ||
      !span.endedAt
    ) {
      return;
    }
    recordModelPreparationMeasurement({
      phase: "sandbox_agent_preparation",
      outcome: span.error ? "failed" : "completed",
      durationSeconds: Math.max(0, (Date.parse(span.endedAt) - Date.parse(span.startedAt)) / 1_000),
    });
  }

  async shutdown(_timeout?: number): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

addTraceProcessor(new ModelPreparationTraceProcessor());

export function withModelPreparationObserver<T>(
  observer: ModelPreparationObserver | undefined,
  callback: () => T,
): T {
  return observer
    ? modelPreparationObserver.run(
        {
          observer,
          startedAt: performance.now(),
          runnerGapRecorded: false,
          postMcpGapRecorded: false,
          sdkAfterSandboxRecorded: false,
        },
        callback,
      )
    : callback();
}

/** Bind one attempt-local durable checkpoint immediately before generic model
 * transport enters fetch. Cached provider clients are process-global, so this
 * authority must be async-local rather than stored on the client instance. */
export function withModelTransportStartedObserver<T>(
  observer: (() => Promise<void> | void) | undefined,
  callback: () => T,
): T {
  return observer ? modelTransportStartedObserver.run(observer, callback) : callback();
}

export async function recordModelTransportStarted(): Promise<void> {
  await modelTransportStartedObserver.getStore()?.();
}

/** Record the first routed sandbox operation boundary without publishing an
 * overlapping parent duration. The observer receives only exclusive leaf
 * buckets; this boundary exists solely to split the surrounding SDK work. */
export function markModelPreparationFirstSandboxOperation(durationSeconds: number): void {
  try {
    const observation = modelPreparationObserver.getStore();
    if (!observation || observation.firstSandboxOperationEndedAt !== undefined) return;
    const endedAt = performance.now();
    const startedAt = endedAt - Math.max(0, durationSeconds) * 1_000;
    observation.firstSandboxOperationEndedAt = endedAt;
    if (!observation.runnerGapRecorded) {
      observation.runnerGapRecorded = true;
      observation.observer({
        phase: "runner_before_first_sandbox_operation",
        outcome: "completed",
        durationSeconds: Math.max(0, startedAt - observation.startedAt) / 1_000,
      });
    }
  } catch {
    // Diagnostics must never affect model preparation or provider dispatch.
  }
}

export function recordModelPreparationMeasurement(measurement: ModelPreparationMeasurement): void {
  try {
    const observation = modelPreparationObserver.getStore();
    if (!observation) return;

    const endedAt = performance.now();
    const startedAt = endedAt - measurement.durationSeconds * 1_000;
    if (measurement.phase === "mcp_tools_snapshot") {
      if (!observation.runnerGapRecorded) {
        observation.runnerGapRecorded = true;
        observation.observer({
          phase: "runner_before_mcp_tools",
          outcome: measurement.outcome,
          durationSeconds: Math.max(0, startedAt - observation.startedAt) / 1_000,
        });
      }
      if (
        !observation.sdkAfterSandboxRecorded &&
        observation.firstSandboxOperationEndedAt !== undefined
      ) {
        observation.sdkAfterSandboxRecorded = true;
        observation.observer({
          phase: "sdk_after_first_sandbox_operation",
          outcome: measurement.outcome,
          durationSeconds:
            Math.max(0, startedAt - observation.firstSandboxOperationEndedAt) / 1_000,
        });
      }
      observation.mcpToolsEndedAt = endedAt;
    } else if (measurement.phase.startsWith("input_filter_")) {
      if (!observation.postMcpGapRecorded && observation.mcpToolsEndedAt !== undefined) {
        observation.postMcpGapRecorded = true;
        observation.observer({
          phase: "mcp_tools_before_input_filter",
          outcome: measurement.outcome,
          durationSeconds: Math.max(0, startedAt - observation.mcpToolsEndedAt) / 1_000,
        });
      }
      if (
        !observation.sdkAfterSandboxRecorded &&
        observation.firstSandboxOperationEndedAt !== undefined &&
        observation.mcpToolsEndedAt === undefined
      ) {
        observation.sdkAfterSandboxRecorded = true;
        observation.observer({
          phase: "sdk_after_first_sandbox_operation",
          outcome: measurement.outcome,
          durationSeconds:
            Math.max(0, startedAt - observation.firstSandboxOperationEndedAt) / 1_000,
        });
      }
    }
    observation.observer(measurement);
  } catch {
    // Diagnostics must never affect model preparation or provider dispatch.
  }
}

/** Observe provider session work performed by the Agents SDK before its first model call. */
export function withModelPreparationSessionDiagnostics<T extends object>(session: T): T {
  return new Proxy(session, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof value !== "function" ||
        !["applyManifest", "materializeEntry", "running", "start"].includes(String(property))
      ) {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return async (...args: unknown[]) => {
        const startedAt = performance.now();
        let outcome: ModelPreparationMeasurement["outcome"] = "completed";
        try {
          return await (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          outcome = "failed";
          throw error;
        } finally {
          const phase: ModelPreparationPhase =
            property === "applyManifest"
              ? "sandbox_manifest_apply"
              : property === "materializeEntry"
                ? "sandbox_entry_materialization"
                : property === "running"
                  ? "sandbox_running_check"
                  : "sandbox_start";
          recordModelPreparationMeasurement({
            phase,
            outcome,
            durationSeconds: (performance.now() - startedAt) / 1_000,
          });
        }
      };
    },
  });
}

export function withModelPreparationClientDiagnostics<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      const method = String(property);
      if (
        typeof value !== "function" ||
        ![
          "create",
          "resume",
          "delete",
          "serializeSessionState",
          "canReusePreservedOwnedSession",
        ].includes(method)
      ) {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return async (...args: unknown[]) => {
        const startedAt = performance.now();
        let outcome: ModelPreparationMeasurement["outcome"] = "completed";
        try {
          const result = await (value as (...callArgs: unknown[]) => unknown).apply(target, args);
          return (method === "create" || method === "resume") &&
            result &&
            typeof result === "object"
            ? withModelPreparationSessionDiagnostics(result)
            : result;
        } catch (error) {
          outcome = "failed";
          throw error;
        } finally {
          const phase: ModelPreparationPhase =
            method === "create"
              ? "sandbox_client_create"
              : method === "resume"
                ? "sandbox_client_resume"
                : method === "delete"
                  ? "sandbox_client_delete"
                  : method === "serializeSessionState"
                    ? "sandbox_client_state_serialize"
                    : "sandbox_client_reuse_check";
          recordModelPreparationMeasurement({
            phase,
            outcome,
            durationSeconds: (performance.now() - startedAt) / 1_000,
          });
        }
      };
    },
  });
}

export function recordModelPreparationManifestInventory(
  phase: "sandbox_agent_manifest_inventory" | "sandbox_session_manifest_inventory",
  manifest: unknown,
): void {
  const startedAt = performance.now();
  let outcome: ModelPreparationMeasurement["outcome"] = "completed";
  let count = 0;
  try {
    if (
      manifest &&
      typeof manifest === "object" &&
      "iterEntries" in manifest &&
      typeof manifest.iterEntries === "function"
    ) {
      for (const _entry of manifest.iterEntries()) count += 1;
    }
  } catch {
    outcome = "failed";
  } finally {
    recordModelPreparationMeasurement({
      phase,
      outcome,
      durationSeconds: (performance.now() - startedAt) / 1_000,
      count,
    });
  }
}
