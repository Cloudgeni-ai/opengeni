import { afterEach, describe, expect, test } from "bun:test";
import { MCPServers, TraceProvider, type MCPServer } from "@openai/agents-core";

const observedUnhandledRejections: unknown[] = [];
const observeUnhandledRejection = (reason: unknown): void => {
  observedUnhandledRejections.push(reason);
};

afterEach(() => {
  process.off("unhandledRejection", observeUnhandledRejection);
  observedUnhandledRejections.length = 0;
});

describe("Agents SDK async ownership", () => {
  test("settles a hostile parallel MCP rejection without a process-global rejection", async () => {
    process.on("unhandledRejection", observeUnhandledRejection);
    const hostileReason = new Proxy(Object.create(null) as object, {
      get() {
        throw new Error("hostile rejection getter");
      },
    });
    const server: MCPServer = {
      name: "hostile-test-server",
      connect: async () => {
        throw hostileReason;
      },
      close: async () => undefined,
      listTools: async () => [],
      callTool: async () => "unused",
    };

    await expect(
      MCPServers.open([server], {
        connectInParallel: true,
        connectTimeoutMs: 100,
        closeTimeoutMs: 100,
        strict: true,
      }),
    ).rejects.toThrow("Unknown MCP lifecycle failure");
    await Promise.resolve();

    expect(observedUnhandledRejections).toEqual([]);
  });

  test("does not let the tracing provider register host-process rejection policy", () => {
    const before = process.listenerCount("unhandledRejection");

    const provider = new TraceProvider();

    expect(provider).toBeInstanceOf(TraceProvider);
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
