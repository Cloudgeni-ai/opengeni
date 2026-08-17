import { performance } from "node:perf_hooks";
import {
  AttemptToolInputValidationError,
  createAttemptToolEnvironment,
  type AttemptToolDefinition,
} from "@opengeni/codemode";

type Shape = "simple" | "nested";

const FIXED_SCOPE = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  executionGeneration: 1,
};
const CREATED_AT = new Date("2026-08-14T00:00:00.000Z");

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const parsed = Number.parseInt(index < 0 ? "" : (process.argv[index + 1] ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function shapeArgument(): Shape {
  const index = process.argv.indexOf("--shape");
  return process.argv[index + 1] === "nested" ? "nested" : "simple";
}

function schema(index: number, shape: Shape, namespace: string): Record<string, unknown> {
  const marker = `${namespace}:${index}`;
  if (shape === "simple") {
    return {
      type: "object",
      properties: { value: { type: "string", const: marker } },
      required: ["value"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: {
      marker: { type: "string", const: marker },
      query: { type: "string", minLength: 1, maxLength: 256 },
      filters: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: ["title", "body", "author"] },
            operator: { type: "string", enum: ["eq", "contains", "prefix"] },
            value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
          },
          required: ["field", "operator", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["marker", "query"],
    additionalProperties: false,
  };
}

function validArguments(index: number, shape: Shape, namespace: string): Record<string, unknown> {
  const marker = `${namespace}:${index}`;
  return shape === "simple" ? { value: marker } : { marker, query: "cache probe" };
}

function definition(index: number, shape: Shape, namespace: string): AttemptToolDefinition {
  const toolName = `tool_${namespace}_${index}`;
  return {
    identity: { serverId: "bench", toolName },
    modelName: `bench__${toolName}`,
    description: `Validator cache benchmark ${index}`,
    inputSchema: schema(index, shape, namespace),
    source: "mcp",
    approval: "none",
    execute: async (argumentsValue) => ({
      content: [{ type: "text", text: JSON.stringify(argumentsValue) }],
    }),
  };
}

function definitions(count: number, shape: Shape, namespace: string): AttemptToolDefinition[] {
  return Array.from({ length: count }, (_, index) => definition(index, shape, namespace));
}

function environment(items: readonly AttemptToolDefinition[]) {
  return createAttemptToolEnvironment({
    scope: { ...FIXED_SCOPE, attemptId: crypto.randomUUID() },
    generation: 1,
    createdAt: CREATED_AT,
    definitions: items,
  });
}

function measuredBuild(items: readonly AttemptToolDefinition[]) {
  const startedAt = performance.now();
  const built = environment(items);
  return { built, durationMs: performance.now() - startedAt };
}

async function proveValidation(
  built: ReturnType<typeof environment>,
  item: AttemptToolDefinition,
  index: number,
  shape: Shape,
  namespace: string,
): Promise<void> {
  await built.callModel({
    modelName: item.modelName,
    arguments: validArguments(index, shape, namespace),
    subjectId: "bench",
  });
  let rejected = false;
  try {
    await built.callModel({
      modelName: item.modelName,
      arguments:
        shape === "simple" ? { value: "invalid" } : { marker: "invalid", query: "cache probe" },
      subjectId: "bench",
    });
  } catch (error) {
    rejected = error instanceof AttemptToolInputValidationError;
  }
  if (!rejected) throw new Error(`invalid arguments passed validator for ${item.modelName}`);
}

async function runCase(count: number, shape: Shape): Promise<void> {
  Bun.gc(true);
  const rssBefore = process.memoryUsage().rss;
  const original = definitions(count, shape, "original");
  const hotCount = Math.min(80, count);
  const hotStart = count - hotCount;
  const hot = original.slice(hotStart);

  const cold = measuredBuild(original);
  Bun.gc(true);
  const rssAfterCold = process.memoryUsage().rss;
  const hotHit = measuredBuild(hot);

  // Each churn schema is structurally distinct from the original set. Below
  // capacity, both sets can coexist; at/above capacity, old entries are evicted.
  const churn = measuredBuild(definitions(count, shape, "churn"));
  Bun.gc(true);
  const rssAfterChurn = process.memoryUsage().rss;
  const hotAfterChurn = measuredBuild(hot);
  const fullReplay = measuredBuild(original);

  // Prove an active environment remains functional after its validator was old
  // enough to be evicted, and prove a rebuilt environment still rejects the same
  // invalid value. The cache bounds reuse only; it never bounds tool availability.
  await proveValidation(cold.built, original[hotStart]!, hotStart, shape, "original");
  await proveValidation(hotAfterChurn.built, hot[0]!, hotStart, shape, "original");

  console.log(
    JSON.stringify({
      count,
      shape,
      cacheCapacity: 512,
      hotCount,
      timingsMs: {
        coldCatalog: cold.durationMs,
        immediateHotSubset: hotHit.durationMs,
        distinctChurnCatalog: churn.durationMs,
        hotSubsetAfterChurn: hotAfterChurn.durationMs,
        fullOriginalReplay: fullReplay.durationMs,
      },
      memoryBytes: {
        rssBefore,
        rssAfterCold,
        rssAfterChurn,
        coldDelta: rssAfterCold - rssBefore,
        churnDelta: rssAfterChurn - rssAfterCold,
      },
      validationParity: "pass",
    }),
  );
}

await runCase(integerArgument("--count", 512), shapeArgument());
