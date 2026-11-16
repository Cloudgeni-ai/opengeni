import { expect, test } from "bun:test";
import type { ModelContextSnapshot } from "@opengeni/contracts";
import {
  chunkTextByContent,
  encodeModelContextSnapshotContent,
  ModelContextSnapshotContentCache,
  modelContextSnapshotJsonUtf8Bytes,
} from "../src/session-content-blobs";

/**
 * The per-run memo must be invisible: every snapshot of a run encodes to the
 * same stored row, refs, blob digests and blob values, in the same order, and
 * measures the same JSON size as the uncached functions.
 */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  for (let i = 0; i < 8; i++) next();
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!,
  };
}
type Random = ReturnType<typeof random>;

const PIECES = [
  "user",
  "assistant",
  "é",
  "😀",
  "\ud83d",
  "\ude00",
  '"',
  "\\",
  "\n",
  "\u0001",
  "日本",
];

function message(rng: Random, index: number): string {
  let text = `{"role":"${rng.pick(["user", "assistant"])}","content":"${index} `;
  const length = rng.int(rng.next() < 0.1 ? 30_000 : 3_000);
  while (text.length < length) {
    text += rng.pick(PIECES);
    for (let i = rng.int(40); i > 0; i--) text += String.fromCharCode(97 + rng.int(26));
  }
  return `${text}"}`;
}

function tools(rng: Random, variant: number): ModelContextSnapshot["tools"] {
  return Array.from({ length: 3 + (variant % 3) }, (_, index) => ({
    name: `tool_${index}`,
    type: "function",
    visibility: "eager" as const,
    description: `Tool ${index} ${"d".repeat(200)} ${variant}`,
    schema: {
      type: "object",
      properties: { query: { type: "string", description: rng.pick(PIECES) } },
      required: ["query"],
    },
    utf8Bytes: 100 + index,
    estimatedTokens: 25,
  }));
}

function snapshot(
  requestIndex: number,
  body: string | null,
  toolList: ModelContextSnapshot["tools"],
  instructions: string,
): ModelContextSnapshot {
  return {
    version: 1,
    capturedAt: new Date(Date.UTC(2026, 10, 15, 12, 0, requestIndex)).toISOString(),
    source: "model_request",
    requestIndex,
    instructions,
    ...(body === null
      ? {}
      : {
          providerRequest: {
            provider: "openai",
            body,
            parts: [{ key: "input", estimatedTokens: 10, utf8Bytes: body.length }],
          },
        }),
    layers: [
      {
        id: "persona_and_core",
        title: "Core",
        content: instructions.slice(0, 500),
        utf8Bytes: 500,
        estimatedTokens: 100,
      },
    ],
    tools: toolList,
    skills: [],
    tokens: { instructions: 400, tools: 30, prefix: 430 },
  };
}

function encoded(value: ReturnType<typeof encodeModelContextSnapshotContent>): string {
  return JSON.stringify({ stored: value.stored, refs: value.refs, blobs: [...value.blobs] });
}

test("cached snapshot encoding and size equal the uncached result across runs", () => {
  let reusedBodies = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rng = random(seed);
    const cache = new ModelContextSnapshotContentCache();
    let history: string[] = Array.from({ length: rng.int(80) }, (_, i) => message(rng, i));
    let toolVariant = 0;
    let toolList = tools(rng, toolVariant);
    let instructions = "You are careful. ".repeat(50 + rng.int(50));
    for (let request = 0; request < 14; request++) {
      const roll = rng.int(10);
      if (roll < 5) history.push(message(rng, history.length));
      else if (roll === 5 && history.length) history[rng.int(history.length)] = message(rng, -1);
      else if (roll === 6) history = history.slice(0, rng.int(history.length + 1));
      else if (roll === 7) toolList = tools(rng, ++toolVariant);
      else if (roll === 8) instructions += rng.pick(PIECES);
      else if (roll === 9 && toolList.length) {
        // Same content, another key order: same digest, same bytes.
        toolList = [
          Object.fromEntries(Object.entries(toolList[0]!).reverse()) as (typeof toolList)[0],
          ...toolList.slice(1),
        ];
      }
      const body = `{"model":"m","input":[${history.join(",")}],"tools":${JSON.stringify(
        toolList.map((tool) => tool.name),
      )},"stream":true}`;
      // A run captures the SDK prefix and the provider body for each request.
      for (const value of [
        snapshot(request, null, toolList, instructions),
        snapshot(request, body, structuredClone(toolList), instructions),
      ]) {
        const expectedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
        expect(modelContextSnapshotJsonUtf8Bytes(value, cache)).toBe(expectedBytes);
        expect(modelContextSnapshotJsonUtf8Bytes(value)).toBe(expectedBytes);
        expect(encoded(encodeModelContextSnapshotContent(value, cache))).toBe(
          encoded(encodeModelContextSnapshotContent(value)),
        );
        if (value.providerRequest?.body) {
          const chunks = chunkTextByContent(value.providerRequest.body);
          expect(cache.bodyChunks(value.providerRequest.body).chunks).toEqual(chunks);
          if (chunks.length > 2) reusedBodies++;
        }
      }
    }
  }
  expect(reusedBodies).toBeGreaterThan(100);
});

test("a value changed in place after it was memoized is never mistaken for the memo", () => {
  const cache = new ModelContextSnapshotContentCache();
  const toolList = tools(random(3), 0);
  const first = snapshot(1, null, toolList, "instructions");
  encodeModelContextSnapshotContent(first, cache);
  (toolList[0]!.schema as { required: string[] }).required.push("extra");
  const second = snapshot(2, null, toolList, "instructions");
  expect(modelContextSnapshotJsonUtf8Bytes(second, cache)).toBe(
    Buffer.byteLength(JSON.stringify(second), "utf8"),
  );
  expect(encoded(encodeModelContextSnapshotContent(second, cache))).toBe(
    encoded(encodeModelContextSnapshotContent(second)),
  );
});

test("non-JSON content fails exactly as without the memo", () => {
  const cache = new ModelContextSnapshotContentCache();
  const bad = {
    ...snapshot(1, null, tools(random(4), 0), "x"),
    tools: [{ schema: { fn: () => 1 } }],
  } as unknown as ModelContextSnapshot;
  expect(() => encodeModelContextSnapshotContent(bad, cache)).toThrow("Content value is not JSON");
  expect(() => encodeModelContextSnapshotContent(bad)).toThrow("Content value is not JSON");
  expect(modelContextSnapshotJsonUtf8Bytes(bad, cache)).toBe(
    Buffer.byteLength(JSON.stringify(bad), "utf8"),
  );
});
