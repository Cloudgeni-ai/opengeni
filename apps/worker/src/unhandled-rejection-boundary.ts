export type WorkerUnhandledRejectionProcess = {
  on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
  off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
  exit: (code: number) => never | void;
};

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

/** Keep known duplicate MCP lifecycle rejections non-fatal; preserve fail-fast
 * behavior for every unknown process-level rejection. */
export function installWorkerUnhandledRejectionBoundary(
  runtimeProcess: WorkerUnhandledRejectionProcess = process,
): () => void {
  const onUnhandledRejection = (reason: unknown): void => {
    if (isDetachedRuntimeMcpLifecycleRejection(reason)) return;
    runtimeProcess.exit(1);
  };
  runtimeProcess.on("unhandledRejection", onUnhandledRejection);
  return () => runtimeProcess.off("unhandledRejection", onUnhandledRejection);
}
