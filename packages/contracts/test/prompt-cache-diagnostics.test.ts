import { describe, expect, test } from "bun:test";
import {
  classifyPromptCacheWarmMiss,
  firstDivergentHistoryCheckpoint,
  parsePromptCacheObservation,
  type PromptCacheCallSample,
  type PromptCacheRequestFingerprint,
} from "../src/prompt-cache-diagnostics";

const digest = (seed: string) => seed.repeat(16).slice(0, 16);

function fingerprint(
  items: number,
  overrides: Partial<PromptCacheRequestFingerprint> & { rewrittenFrom?: number } = {},
): PromptCacheRequestFingerprint {
  const history: Array<[number, string]> = [];
  for (let count = 1; count <= items; count *= 2) history.push([count, digest(String(count % 10))]);
  if (history.at(-1)?.[0] !== items) history.push([items, digest("f")]);
  const rewrittenFrom = overrides.rewrittenFrom;
  return {
    v: 1,
    tools: overrides.tools ?? digest("a"),
    system: overrides.system ?? digest("b"),
    items,
    history:
      rewrittenFrom === undefined
        ? history
        : history.map(([count, value]) => [count, count >= rewrittenFrom ? digest("e") : value]),
  };
}

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds));

function sample(overrides: Partial<PromptCacheCallSample>): PromptCacheCallSample {
  return {
    sourceKey: "call",
    inputTokens: 200_000,
    cachedTokens: 199_000,
    connectionId: null,
    occurredAt: at(0),
    observation: null,
    ...overrides,
  };
}

describe("prompt-cache warm-miss classification", () => {
  const previous = sample({
    sourceKey: "previous",
    observation: { request: fingerprint(100) },
  });

  test("a call that reads the warm prefix is not a miss", () => {
    expect(
      classifyPromptCacheWarmMiss(
        previous,
        sample({ inputTokens: 205_000, cachedTokens: 199_500, occurredAt: at(20) }),
      ),
    ).toBeNull();
    expect(classifyPromptCacheWarmMiss(null, sample({ cachedTokens: 0 }))).toBeNull();
  });

  test("the request change that broke the prefix wins over its effects", () => {
    const current = (request: PromptCacheRequestFingerprint, thinking = 0) =>
      sample({
        sourceKey: "current",
        inputTokens: 190_000,
        cachedTokens: 29_739,
        occurredAt: at(30),
        observation: {
          request,
          ...(thinking ? { thinkingBlocksDropped: { prefix_binding_mismatch: thinking } } : {}),
        },
      });
    expect(
      classifyPromptCacheWarmMiss(previous, current(fingerprint(110, { system: digest("c") }), 39)),
    ).toMatchObject({
      class: "system_changed",
      expectedCachedTokens: 190_000,
      previousSourceKey: "previous",
      gapMs: 30_000,
    });
    expect(
      classifyPromptCacheWarmMiss(previous, current(fingerprint(110, { tools: digest("d") }))),
    ).toMatchObject({ class: "tools_changed" });
    expect(
      classifyPromptCacheWarmMiss(previous, current(fingerprint(110, { rewrittenFrom: 32 }), 12)),
    ).toMatchObject({ class: "history_rewritten", divergedWithinItems: 32 });
    expect(classifyPromptCacheWarmMiss(previous, current(fingerprint(110), 12))).toMatchObject({
      class: "thinking_dropped",
    });
  });

  test("without a request explanation, account and time are reported", () => {
    const miss = { inputTokens: 201_000, cachedTokens: 29_739 };
    expect(
      classifyPromptCacheWarmMiss(
        { ...previous, connectionId: "a" },
        sample({ ...miss, connectionId: "b", occurredAt: at(10) }),
      ),
    ).toMatchObject({ class: "account_changed" });
    expect(
      classifyPromptCacheWarmMiss(
        previous,
        sample({ ...miss, occurredAt: new Date(at(0).getTime() + 6 * 60_000) }),
      ),
    ).toMatchObject({ class: "idle_gap" });
    expect(
      classifyPromptCacheWarmMiss(previous, sample({ ...miss, occurredAt: at(10) })),
    ).toMatchObject({ class: "unexplained" });
  });

  test("a replaced history is an expected miss", () => {
    expect(
      classifyPromptCacheWarmMiss(
        previous,
        sample({ inputTokens: 60_000, cachedTokens: 29_739, occurredAt: at(10) }),
      ),
    ).toMatchObject({ class: "context_replaced" });
  });

  test("only shared checkpoints are compared", () => {
    const longer = fingerprint(300);
    expect(firstDivergentHistoryCheckpoint(fingerprint(100), longer)).toBeNull();
    expect(
      firstDivergentHistoryCheckpoint(fingerprint(100), fingerprint(300, { rewrittenFrom: 64 })),
    ).toBe(64);
  });
});

describe("prompt-cache observation parsing", () => {
  test("keeps valid parts and drops malformed ones", () => {
    expect(
      parsePromptCacheObservation({
        thinkingBlocksDropped: { prefix_binding_mismatch: 3 },
        request: fingerprint(5),
      }),
    ).toEqual({ thinkingBlocksDropped: { prefix_binding_mismatch: 3 }, request: fingerprint(5) });
    expect(
      parsePromptCacheObservation({
        thinkingBlocksDropped: { "Not A Reason": 1 },
        request: { ...fingerprint(5), tools: "text that is not a digest" },
      }),
    ).toBeNull();
    expect(
      parsePromptCacheObservation({ request: { ...fingerprint(5), history: [[8, digest("a")]] } }),
    ).toBeNull();
    expect(parsePromptCacheObservation("nope")).toBeNull();
  });
});
