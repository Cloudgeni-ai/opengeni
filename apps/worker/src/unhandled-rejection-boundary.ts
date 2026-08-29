export type WorkerUnhandledRejectionProcess = {
  on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
  off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
};

export type WorkerUnhandledRejectionClassification =
  | "detached_runtime_mcp_lifecycle"
  | "detached_unknown";

type RuntimeMcpLifecycleError = {
  name: "McpLifecycleError";
  code: "mcp_connect_failed" | "mcp_close_failed";
  origin: "runtime";
  serverId: string;
};

/**
 * The Agents SDK owns MCP connect promises and also installs a process-global
 * unhandled-rejection listener. A best-effort lifecycle rejection can surface
 * twice under concurrent teardown: once through the awaited MCP result and once
 * through the SDK's detached worker promise. The first path already records and
 * degrades the server; the second must not terminate the whole turn-worker pod.
 */
export function isDetachedRuntimeMcpLifecycleRejection(
  reason: unknown,
): reason is RuntimeMcpLifecycleError {
  try {
    if (!reason || typeof reason !== "object") return false;
    const candidate = reason as Partial<RuntimeMcpLifecycleError>;
    return (
      candidate.name === "McpLifecycleError" &&
      (candidate.code === "mcp_connect_failed" || candidate.code === "mcp_close_failed") &&
      candidate.origin === "runtime" &&
      typeof candidate.serverId === "string" &&
      candidate.serverId.length > 0
    );
  } catch {
    return false;
  }
}

function reportIsolatedUnhandledRejection(
  classification: WorkerUnhandledRejectionClassification,
): void {
  // Never render the rejection itself: provider and transport errors can carry
  // request bodies or credentials. The durable activity path owns exact errors.
  console.error("[worker] isolated detached unhandled rejection", { classification });
}

/**
 * Keep process-global promise rejection handling observational. Turn activities
 * have their own durable failure/lease boundary; killing the shared worker here
 * converts one detached SDK/transport promise into unrelated lease losses across
 * every session assigned to the pod. The Agents SDK also checks for a consumer
 * listener before applying its own process.exit(1), so this boundary must never
 * reintroduce that fail-fast behavior for an unknown rejection shape.
 */
export function installWorkerUnhandledRejectionBoundary(
  runtimeProcess: WorkerUnhandledRejectionProcess = process,
  report: (
    classification: WorkerUnhandledRejectionClassification,
  ) => void = reportIsolatedUnhandledRejection,
): () => void {
  const onUnhandledRejection = (reason: unknown): void => {
    report(
      isDetachedRuntimeMcpLifecycleRejection(reason)
        ? "detached_runtime_mcp_lifecycle"
        : "detached_unknown",
    );
  };
  runtimeProcess.on("unhandledRejection", onUnhandledRejection);
  return () => runtimeProcess.off("unhandledRejection", onUnhandledRejection);
}
