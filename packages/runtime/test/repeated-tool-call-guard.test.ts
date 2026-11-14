import { describe, expect, test } from "bun:test";
import { RunContext, tool } from "@openai/agents";
import { z } from "zod";
import {
  REPEATED_CALL_LIMIT,
  REPEATED_CALL_MEMORY,
  REPEATED_CALL_NOTICE,
  REPEATED_CALL_WINDOW_MS,
  createRepeatedToolCallGuard,
  guardRepeatedToolCall,
  installRepeatedToolCallGuard,
  repeatGuardedToolResolver,
} from "../src/repeated-tool-call-guard";

function clock() {
  let time = 1_000_000;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe("repeated tool call guard", () => {
  test("answers an identical call that keeps returning the same result with the notice", async () => {
    const time = clock();
    const guard = createRepeatedToolCallGuard(time.now);
    let runs = 0;
    const call = (args: string) =>
      guardRepeatedToolCall(guard, "privacy_facts", args, async () => {
        runs += 1;
        return '{"model":"m"}';
      });
    for (let index = 0; index < REPEATED_CALL_LIMIT; index += 1) {
      expect(await call("{}")).toBe('{"model":"m"}');
      time.advance(100);
    }
    expect(runs).toBe(REPEATED_CALL_LIMIT);
    expect(await call("{}")).toBe(REPEATED_CALL_NOTICE);
    expect(await call("{ }")).toBe(REPEATED_CALL_NOTICE);
    expect(runs).toBe(REPEATED_CALL_LIMIT);
    // Other arguments are another call, and run.
    expect(await call('{"detail":true}')).toBe('{"model":"m"}');
    expect(runs).toBe(REPEATED_CALL_LIMIT + 1);
  });

  test("remembers a bounded number of distinct calls, by digest, least recently run forgotten first", async () => {
    const guard = createRepeatedToolCallGuard(clock().now);
    const big = "x".repeat(100_000);
    for (let index = 0; index < REPEATED_CALL_LIMIT; index += 1)
      await guardRepeatedToolCall(guard, "write", `{"content":"${big}"}`, async () => "ok");
    for (let index = 0; index < REPEATED_CALL_MEMORY; index += 1)
      await guardRepeatedToolCall(guard, "read", `{"page":${index}}`, async () => "page");
    expect(guard.calls.size).toBe(REPEATED_CALL_MEMORY);
    expect([...guard.calls.keys()].every((key) => key.length === 64)).toBe(true);
    // The large call was forgotten, so it runs again.
    let ran = false;
    await guardRepeatedToolCall(guard, "write", `{"content":"${big}"}`, async () => {
      ran = true;
      return "ok";
    });
    expect(ran).toBe(true);
  });

  test("the same arguments in another key order are the same call", async () => {
    const guard = createRepeatedToolCallGuard(clock().now);
    let runs = 0;
    for (let index = 0; index < REPEATED_CALL_LIMIT; index += 1)
      await guardRepeatedToolCall(
        guard,
        "t",
        index % 2 ? '{"a":1,"b":2}' : '{"b":2,"a":1}',
        async () => {
          runs += 1;
          return "same";
        },
      );
    expect(await guardRepeatedToolCall(guard, "t", '{"a":1,"b":2}', async () => "same")).toBe(
      REPEATED_CALL_NOTICE,
    );
    expect(runs).toBe(REPEATED_CALL_LIMIT);
  });

  test("never affects a call whose result changes", async () => {
    const guard = createRepeatedToolCallGuard(clock().now);
    let runs = 0;
    for (let index = 0; index < REPEATED_CALL_LIMIT * 4; index += 1) {
      const output = await guardRepeatedToolCall(guard, "status", "{}", async () => {
        runs += 1;
        // The same result several times, then a change: the count starts over.
        return `state ${Math.floor(index / (REPEATED_CALL_LIMIT - 1))}`;
      });
      expect(output).not.toBe(REPEATED_CALL_NOTICE);
    }
    expect(runs).toBe(REPEATED_CALL_LIMIT * 4);
  });

  test("polling slower than the window always runs", async () => {
    const time = clock();
    const guard = createRepeatedToolCallGuard(time.now);
    let runs = 0;
    for (let index = 0; index < REPEATED_CALL_LIMIT * 2; index += 1) {
      await guardRepeatedToolCall(guard, "command_wait", '{"id":"c"}', async () => {
        runs += 1;
        return "running";
      });
      time.advance(REPEATED_CALL_WINDOW_MS);
    }
    expect(runs).toBe(REPEATED_CALL_LIMIT * 2);
  });

  test("a guarded call runs again once the window has passed, and counts its result", async () => {
    const time = clock();
    const guard = createRepeatedToolCallGuard(time.now);
    let result = "same";
    const call = () => guardRepeatedToolCall(guard, "t", "{}", async () => result);
    for (let index = 0; index < REPEATED_CALL_LIMIT; index += 1) await call();
    expect(await call()).toBe(REPEATED_CALL_NOTICE);
    time.advance(REPEATED_CALL_WINDOW_MS);
    result = "changed";
    expect(await call()).toBe("changed");
    expect(await call()).toBe("changed");
  });

  test("a failed call is not counted", async () => {
    const guard = createRepeatedToolCallGuard(clock().now);
    for (let index = 0; index < REPEATED_CALL_LIMIT * 2; index += 1)
      await expect(
        guardRepeatedToolCall(guard, "t", "{}", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
  });

  test("guards the agent's function tools, its clones and tools bound by name", async () => {
    let runs = 0;
    const facts = tool({
      name: "privacy_facts",
      description: "Facts.",
      parameters: z.object({}),
      execute: async () => {
        runs += 1;
        return "facts";
      },
    });
    type FakeAgent = {
      getAllTools: (runContext: unknown) => Promise<(typeof facts)[]>;
      clone: (config: unknown) => FakeAgent;
    };
    const makeAgent = (): FakeAgent => ({
      getAllTools: async () => [facts],
      clone: () => makeAgent(),
    });
    const agent = makeAgent();
    installRepeatedToolCallGuard(agent);
    const [first] = await agent.getAllTools(new RunContext());
    const [cloned] = await agent.clone({}).getAllTools(new RunContext());
    const resolve = repeatGuardedToolResolver(agent, async () => facts);
    const bound = await resolve!({});
    const tools = [first!, cloned!, bound!];
    const outputs: unknown[] = [];
    for (let index = 0; index <= REPEATED_CALL_LIMIT; index += 1)
      outputs.push(await tools[index % 3]!.invoke(new RunContext(), "{}"));
    expect(runs).toBe(REPEATED_CALL_LIMIT);
    expect(outputs.at(-1)).toBe(REPEATED_CALL_NOTICE);
    // Stable per tool.
    expect((await agent.getAllTools(new RunContext()))[0]).toBe(first);
  });
});
