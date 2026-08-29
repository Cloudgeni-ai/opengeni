import { describe, expect, test } from "bun:test";
import {
  installWorkerUnhandledRejectionBoundary,
  isDetachedRuntimeMcpLifecycleRejection,
  type WorkerUnhandledRejectionProcess,
} from "../src/unhandled-rejection-boundary";

function fakeProcess() {
  let listener: ((reason: unknown) => void) | undefined;
  const runtimeProcess: WorkerUnhandledRejectionProcess = {
    on: (_event, next) => {
      listener = next;
    },
    off: (_event, current) => {
      if (listener === current) listener = undefined;
    },
  };
  return {
    runtimeProcess,
    emit: (reason: unknown) => listener?.(reason),
    hasListener: () => listener !== undefined,
  };
}

describe("worker unhandled rejection boundary", () => {
  test("keeps detached structural MCP lifecycle duplicates non-fatal", () => {
    const runtime = fakeProcess();
    const reports: string[] = [];
    const dispose = installWorkerUnhandledRejectionBoundary(runtime.runtimeProcess, (event) =>
      reports.push(event),
    );

    runtime.emit(
      Object.assign(new Error("MCP lifecycle connect failed"), {
        name: "McpLifecycleError",
        code: "mcp_connect_failed",
        origin: "runtime",
        serverId: "optional-slack",
      }),
    );

    expect(reports).toEqual(["detached_runtime_mcp_lifecycle"]);
    dispose();
    expect(runtime.hasListener()).toBe(false);
  });

  test("keeps unknown and malformed detached rejections non-fatal", () => {
    const runtime = fakeProcess();
    const reports: string[] = [];
    installWorkerUnhandledRejectionBoundary(runtime.runtimeProcess, (event) => reports.push(event));

    runtime.emit(new Error("unknown"));
    runtime.emit({ name: "McpLifecycleError", code: "mcp_connect_failed" });

    expect(reports).toEqual(["detached_unknown", "detached_unknown"]);
  });

  test("fails closed for hostile rejection objects", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
      },
    );
    expect(isDetachedRuntimeMcpLifecycleRejection(hostile)).toBe(false);
  });
});
