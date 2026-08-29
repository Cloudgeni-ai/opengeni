import { describe, expect, test } from "bun:test";
import {
  installWorkerUnhandledRejectionBoundary,
  isDetachedRuntimeMcpLifecycleRejection,
  type WorkerUnhandledRejectionProcess,
} from "../src/unhandled-rejection-boundary";

function fakeProcess() {
  let listener: ((reason: unknown) => void) | undefined;
  const exits: number[] = [];
  const runtimeProcess: WorkerUnhandledRejectionProcess = {
    on: (_event, next) => {
      listener = next;
    },
    off: (_event, current) => {
      if (listener === current) listener = undefined;
    },
    exit: (code) => {
      exits.push(code);
    },
  };
  return {
    runtimeProcess,
    emit: (reason: unknown) => listener?.(reason),
    exits,
    hasListener: () => listener !== undefined,
  };
}

describe("worker unhandled rejection boundary", () => {
  test("keeps detached structural MCP lifecycle duplicates non-fatal", () => {
    const runtime = fakeProcess();
    const dispose = installWorkerUnhandledRejectionBoundary(runtime.runtimeProcess);

    runtime.emit(
      Object.assign(new Error("MCP lifecycle connect failed"), {
        name: "McpLifecycleError",
        code: "mcp_connect_failed",
        origin: "runtime",
        serverId: "optional-slack",
      }),
    );

    expect(runtime.exits).toEqual([]);
    dispose();
    expect(runtime.hasListener()).toBe(false);
  });

  test("keeps unknown and malformed rejections fatal", () => {
    const runtime = fakeProcess();
    installWorkerUnhandledRejectionBoundary(runtime.runtimeProcess);

    runtime.emit(new Error("unknown"));
    runtime.emit({ name: "McpLifecycleError", code: "mcp_connect_failed" });

    expect(runtime.exits).toEqual([1, 1]);
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
