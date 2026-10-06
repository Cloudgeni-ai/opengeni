import { expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import {
  createTurnInvocationDrain,
  invocationDrainedMcpServer,
} from "../src/turn-invocation-drain";

test("closed admission suppresses same-tick dispatch and does not swallow its error", async () => {
  const drain = createTurnInvocationDrain();
  let starts = 0;
  const pending = drain.run(async () => {
    starts++;
    return "must not run";
  });
  const reason = new Error("Synthetic cancelled turn");
  drain.cancel(reason);
  await expect(pending).rejects.toBe(reason);
  await drain.waitForDrain();
  await expect(
    drain.run(async () => {
      starts++;
      return "late";
    }),
  ).rejects.toBe(reason);
  expect(starts).toBe(0);
});

test("cancellation drains an uncooperative callback before returning", async () => {
  const upstream = new AbortController();
  const drain = createTurnInvocationDrain(upstream.signal);
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<string>();
  const pending = drain.run(async (signal) => {
    started.resolve(signal);
    return await release.promise;
  });
  const signal = await started.promise;
  upstream.abort(new Error("Synthetic stop"));
  expect(signal.aborted).toBe(true);
  let ended = false;
  const waiting = drain.waitForDrain().then(() => {
    ended = true;
  });
  await Bun.sleep(0);
  expect(ended).toBe(false);
  release.resolve("original reply");
  expect(await pending).toBe("original reply");
  await waiting;
  expect(ended).toBe(true);
});

test("a failed callback is locally drained without being interpreted as remote exit", async () => {
  const drain = createTurnInvocationDrain();
  const failure = new Error("Synthetic unknown remote outcome");
  await expect(
    drain.run(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await expect(drain.waitForDrain()).rejects.toThrow("closed admission");
  drain.cancel();
  await drain.waitForDrain();
});

test("MCP invocation drainage preserves private receivers, full result metadata and cancellation", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<AbortSignal>();
  const result = {
    content: [{ type: "text" as const, text: "original" }],
    structuredContent: { synthetic: true },
    isError: false,
  };
  class Server {
    #calls = 0;
    cacheToolsList = false;
    readonly name = "synthetic";
    async connect() {}
    async close() {}
    async listTools() {
      return [];
    }
    async invalidateToolsCache() {}
    async callTool(...args: Parameters<MCPServer["callTool"]>) {
      return (await this.callToolResult(...args)).content;
    }
    async callToolResult(
      _name: string,
      _args: unknown,
      _meta: unknown,
      options?: { signal?: AbortSignal },
    ) {
      this.#calls++;
      started.resolve(options!.signal!);
      await release.promise;
      return result;
    }
    count() {
      return this.#calls;
    }
  }
  const server = new Server();
  const drain = createTurnInvocationDrain();
  const bound = invocationDrainedMcpServer(server, drain);
  const reply = bound.callToolResult("synthetic", {}, null);
  const signal = await started.promise;
  drain.cancel();
  expect(signal.aborted).toBe(true);
  let ended = false;
  const waiting = drain.waitForDrain().then(() => {
    ended = true;
  });
  await Bun.sleep(0);
  expect(ended).toBe(false);
  expect(bound.count()).toBe(1);
  release.resolve();
  expect(await reply).toBe(result);
  await waiting;
  await expect(bound.callTool("late", {}, null)).rejects.toThrow("TURN_ATTEMPT_FINALIZED");
  expect(server.count()).toBe(1);
});
