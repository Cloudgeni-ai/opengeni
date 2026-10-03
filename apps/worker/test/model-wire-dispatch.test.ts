import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync, type Node } from "oxc-parser";
import { InitialModelWireDispatchClock } from "../src/activities/agent-turn/model-wire-dispatch";

const identity = { provider: "azure", dispatchId: "dispatch-1" };
const firstUnixMs = Date.parse("2026-10-03T15:00:00.000Z");
const clock = { dispatchedAtUnixMs: firstUnixMs, monotonicTimeMs: 550 };
const field = { initialWireDispatchedAt: "2026-10-03T15:00:00.000Z" };

function nodes(root: Node): Node[] {
  const result: Node[] = [];
  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!("type" in value) || typeof value.type !== "string") return;
    result.push(value as Node);
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
  return result;
}

function sourceAst(path: string) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const parsed = parseSync(path, source);
  expect(parsed.errors).toEqual([]);
  return { source, nodes: nodes(parsed.program) };
}

describe("attempt-local initial wire dispatch clock", () => {
  test("has no timestamp until an actual fetch-entry observation", () => {
    expect(new InitialModelWireDispatchClock().payload(identity)).toEqual({});
  });

  test("keeps the first physical dispatch across retries and later model requests", () => {
    const observation = new InitialModelWireDispatchClock();
    observation.record(identity, clock);
    observation.record(identity, { ...clock, dispatchedAtUnixMs: firstUnixMs + 1_000 });
    observation.record(
      { ...identity, dispatchId: "later-dispatch" },
      {
        ...clock,
        dispatchedAtUnixMs: firstUnixMs + 2_000,
      },
    );
    expect(observation.payload(identity)).toEqual(field);
    expect(observation.payload({ ...identity, dispatchId: "later-dispatch" })).toEqual({});
  });

  test("never attaches the clock to another provider or dispatch", () => {
    const observation = new InitialModelWireDispatchClock();
    observation.record(identity, clock);
    expect(observation.payload({ ...identity, provider: "other-provider" })).toEqual({});
    expect(observation.payload({ ...identity, dispatchId: "other-attempt" })).toEqual({});
    expect(observation.payload(identity)).toEqual(field);
  });

  test("separate attempts never reuse a prior attempt's clock", () => {
    const first = new InitialModelWireDispatchClock();
    const next = new InitialModelWireDispatchClock();
    first.record(identity, clock);
    expect(next.payload(identity)).toEqual({});
    next.record(identity, { ...clock, dispatchedAtUnixMs: firstUnixMs + 5_000 });
    expect(first.payload(identity)).toEqual(field);
    expect(next.payload(identity)).toEqual({ initialWireDispatchedAt: "2026-10-03T15:00:05.000Z" });
  });

  test("invalid diagnostic clocks cannot populate event metadata", () => {
    const observation = new InitialModelWireDispatchClock();
    observation.record(identity, { ...clock, dispatchedAtUnixMs: NaN });
    expect(observation.payload(identity)).toEqual({});
    observation.record(identity, clock);
    expect(observation.payload(identity)).toEqual(field);
  });

  test("the real first-byte publisher adds the field once without changing duration or publication count", async () => {
    const parsed = sourceAst("../src/activities/agent-turn/stream-attempt.ts");
    const declaration = parsed.nodes.find(
      (node) =>
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.id.name === "settleFallbackProviderFirstByte",
    );
    if (declaration?.type !== "VariableDeclarator" || !declaration.init)
      throw new Error("Missing first-byte publisher");
    const expression = parsed.source.slice(declaration.init.start, declaration.init.end);
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
      `const settle = ${expression};`,
    );
    const observation = new InitialModelWireDispatchClock();
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const publisher = new Function(
      "eventing",
      `
      let fallbackProviderRequestStartedAt = 500;
      const performance = { now: () => 700 };
      const streamProvider = "azure";
      const activeTurnId = "turn-1";
      const input = { attemptId: "attempt-1" };
      const dispatchId = "dispatch-1";
      const attempt = { executionGeneration: 7 };
      ${compiled}
      return settle;
    `,
    )({
      initialModelWireDispatch: observation,
      publish: async (events: typeof published) => {
        published.push(...events);
      },
    }) as () => Promise<void>;
    observation.record(identity, clock);
    await publisher();
    await publisher();
    expect(published).toEqual([
      {
        type: "agent.model.request",
        payload: {
          phase: "first_byte",
          provider: "azure",
          durationMs: 200,
          turnId: "turn-1",
          attemptId: "attempt-1",
          dispatchId: "dispatch-1",
          executionGeneration: 7,
          ...field,
        },
      },
    ]);
  });

  test("production wiring is synchronous, generic-only and bound in both runtime branches", () => {
    const worker = sourceAst("../src/activities/agent-turn/stream-attempt.ts");
    const conditional = worker.nodes.find(
      (node) =>
        node.type === "ConditionalExpression" &&
        node.test.type === "UnaryExpression" &&
        node.test.operator === "!" &&
        node.test.argument.type === "Identifier" &&
        node.test.argument.name === "providerPublishesNativeRequestEvents" &&
        nodes(node.consequent).some(
          (child) =>
            child.type === "Property" &&
            child.key.type === "Identifier" &&
            child.key.name === "onModelTransportDispatched",
        ),
    );
    expect(conditional).toBeDefined();
    if (conditional?.type !== "ConditionalExpression")
      throw new Error("Missing generic dispatch binding");
    const diagnostic = nodes(conditional.consequent).find(
      (node) =>
        node.type === "Property" &&
        node.key.type === "Identifier" &&
        node.key.name === "onModelTransportDispatched",
    );
    if (diagnostic?.type !== "Property" || diagnostic.value.type !== "ArrowFunctionExpression")
      throw new Error("Missing synchronous callback");
    expect(diagnostic.value.async).toBe(false);
    expect(nodes(diagnostic.value).some((node) => node.type === "AwaitExpression")).toBe(false);
    const runtime = sourceAst("../../../packages/runtime/src/index.ts");
    const bindings = runtime.nodes.filter(
      (node) =>
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "withModelTransportStartedObserver",
    );
    expect(bindings).toHaveLength(2);
    for (const binding of bindings) {
      if (binding.type !== "CallExpression") throw new Error("Missing runtime binding");
      expect(runtime.source.slice(binding.arguments[2]!.start, binding.arguments[2]!.end)).toBe(
        "overrides.onModelTransportDispatched",
      );
    }
  });
});
