import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync, type Node } from "oxc-parser";
import { prepareFileTurnStartup } from "../src/activities/agent-turn/file-startup";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fileTurn = {
  establishPolicy: "eager" as const,
  machinePrimary: false,
  backend: "docker" as const,
  hasFileResources: true,
};

describe("managed file startup", () => {
  test("the turn joins overlapping preparation before building the agent", () => {
    const source = readFileSync(
      new URL("../src/activities/agent-turn/run.ts", import.meta.url),
      "utf8",
    );
    const parsed = parseSync("run.ts", source);
    expect(parsed.errors).toEqual([]);
    const calls: Node[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.type === "CallExpression") calls.push(node as Node);
      for (const value of Object.values(record)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") walk(value);
      }
    };
    walk(parsed.program);
    const named = (name: string) =>
      calls.find(
        (node) =>
          node.type === "CallExpression" &&
          node.callee.type === "Identifier" &&
          node.callee.name === name,
      );
    const startup = named("prepareFileTurnStartup");
    expect(startup).toBeDefined();
    if (!startup) throw new Error("Missing joined file startup");
    for (const name of [
      "establishTurnSandbox",
      "sandboxFileDownloadsForRun",
      "prepareTurnToolRuntime",
    ]) {
      const call = named(name)!;
      expect(call.start).toBeGreaterThan(startup.start);
      expect(call.end).toBeLessThan(startup.end);
    }
    expect(named("buildTurnAgent")!.start).toBeGreaterThan(startup.end);
    expect(source.slice(startup.start - 6, startup.start)).toBe("await ");
  });

  test("prepares tools while the box starts but joins both before agent build", async () => {
    const box = deferred();
    const tools = deferred();
    const calls: string[] = [];
    const payload = { files: [{ path: "/workspace/file.txt" }], tools: ["read"] };
    const result = prepareFileTurnStartup({
      ...fileTurn,
      establish: async () => {
        calls.push("box");
        await box.promise;
      },
      prepare: async () => {
        calls.push("tools");
        await tools.promise;
        return payload;
      },
    });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(calls).toEqual(["box", "tools"]);
    tools.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    box.resolve();
    expect(await result).toBe(payload);
  });

  for (const [name, overrides] of [
    ["ordinary turn", { hasFileResources: false }],
    ["lazy turn", { establishPolicy: "on-demand" as const }],
    ["machine primary", { machinePrimary: true }],
    ["machine backend", { backend: "selfhosted" as const }],
    ["sandboxless", { backend: "none" as const }],
  ] as const) {
    test(`${name} retains sequential preparation`, async () => {
      const box = deferred();
      const calls: string[] = [];
      const result = prepareFileTurnStartup({
        ...fileTurn,
        ...overrides,
        establish: async () => {
          calls.push("box");
          await box.promise;
        },
        prepare: async () => {
          calls.push("tools");
          return "prepared";
        },
      });
      await Promise.resolve();
      expect(calls).toEqual(["box"]);
      box.resolve();
      expect(await result).toBe("prepared");
      expect(calls).toEqual(["box", "tools"]);
    });
  }

  test("a preparation failure joins the pending box before outer cleanup", async () => {
    const box = deferred();
    const failure = new Error("metadata unavailable");
    let settled = false;
    let boxReady = false;
    const result = prepareFileTurnStartup({
      ...fileTurn,
      establish: async () => {
        await box.promise;
        boxReady = true;
      },
      prepare: async () => {
        throw failure;
      },
    });
    const observed = result.catch((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    box.resolve();
    expect(await observed).toBe(failure);
    expect(boxReady).toBe(true);
  });

  test("a box failure joins pending tools and retains establishment failure priority", async () => {
    const tools = deferred();
    const boxFailure = new Error("box unavailable");
    let settled = false;
    const result = prepareFileTurnStartup({
      ...fileTurn,
      establish: async () => {
        throw boxFailure;
      },
      prepare: async () => {
        await tools.promise;
        throw new Error("tool preparation failed");
      },
    });
    const observed = result.catch((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    tools.resolve();
    expect(await observed).toBe(boxFailure);
  });

  test("sequential establishment failure does not start tools", async () => {
    let prepared = false;
    const failure = new Error("machine unavailable");
    await expect(
      prepareFileTurnStartup({
        ...fileTurn,
        machinePrimary: true,
        establish: async () => {
          throw failure;
        },
        prepare: async () => {
          prepared = true;
        },
      }),
    ).rejects.toBe(failure);
    expect(prepared).toBe(false);
  });
});
