import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { normalizeProtocolJsonValue, sanitizeHistoryItemsForModel } from "@opengeni/runtime";
import { HistoryPrefixGuard, sameCanonicalJson } from "../src/activities/agent-turn/history-prefix";

/**
 * The guard compares canonical item trees instead of hashing their JSON. This
 * keeps the former SHA-256 implementation as an oracle and requires the same
 * decision (accept, or reject at the same item) for every seed, verify and
 * acknowledge sequence, including tampered, reordered and shortened prefixes.
 */
class LegacyHistoryPrefixGuard {
  private persisted: string[] = [];

  seed(items: Array<Record<string, unknown>>, count: number, truncationTokens?: number) {
    const keys = this.keys(items, truncationTokens);
    if (keys.length < count)
      throw new Error("Conversation history seed is shorter than its durable prefix");
    this.persisted = keys.slice(0, count);
  }

  verify(items: Array<Record<string, unknown>>, truncationTokens?: number): string[] {
    const keys = this.keys(items, truncationTokens);
    for (let i = 0; i < this.persisted.length; i++) {
      if (keys[i] !== this.persisted[i]) {
        throw new Error(
          `Conversation history durable prefix changed at item ${i}; refusing to skip unsaved work`,
        );
      }
    }
    return keys;
  }

  acknowledge(keys: string[], count: number) {
    this.persisted = keys.slice(0, count);
  }

  private keys(items: Array<Record<string, unknown>>, truncationTokens?: number): string[] {
    return sanitizeHistoryItemsForModel(items, truncationTokens).map((item) =>
      createHash("sha256")
        .update(JSON.stringify(sorted(normalizeProtocolJsonValue(item, "$", MARKS_OMITTED))))
        .digest("hex"),
    );
  }
}

const MARKS_OMITTED = { onAdjustment: () => undefined } as const;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sorted(entry)]),
    );
  }
  return value;
}

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

const TEXT = ["", "a", "ok", "naïve", "日本語", "😀", "\u0000", "\ud800", "line\nbreak", '"q"'];

function text(rng: Random): string {
  const parts: string[] = [];
  const count = 1 + rng.int(4);
  for (let i = 0; i < count; i++) parts.push(rng.pick(TEXT));
  if (rng.next() < 0.15) parts.push("x".repeat(rng.int(20_000)));
  return parts.join(" ");
}

function jsonish(rng: Random, depth: number): unknown {
  const roll = rng.int(depth > 3 ? 6 : 9);
  switch (roll) {
    case 0:
      return text(rng);
    case 1:
      return rng.int(1000) - 500;
    case 2:
      return rng.pick([true, false, null, 0.5, 1e21, -0]);
    case 3:
      return rng.pick([undefined, Number.NaN, Number.POSITIVE_INFINITY]);
    case 4:
      return rng.pick(["a", "B", "b", "10", "2", "é", "e\u0301"]);
    case 5:
      return new Date(1_700_000_000_000 + rng.int(1000));
    case 6:
    case 7: {
      const out: Record<string, unknown> = {};
      const count = rng.int(5);
      for (let i = 0; i < count; i++) {
        out[rng.pick(["a", "b", "B", "Z", "10", "2", "é", "e\u0301", "key", "text"])] = jsonish(
          rng,
          depth + 1,
        );
      }
      return out;
    }
    default:
      return Array.from({ length: rng.int(4) }, () => jsonish(rng, depth + 1));
  }
}

function historyItem(rng: Random, index: number): Record<string, unknown> {
  const roll = rng.int(6);
  const callId = `call-${rng.int(6)}`;
  if (roll === 0) {
    return { type: "function_call", callId, name: "lookup", arguments: JSON.stringify({ index }) };
  }
  if (roll === 1) {
    return {
      type: "function_call_result",
      callId,
      name: "lookup",
      status: "completed",
      output: { type: "text", text: text(rng) },
    };
  }
  if (roll === 2) {
    return { type: "reasoning", id: `rs-${index}`, content: [], providerData: jsonish(rng, 1) };
  }
  const message: Record<string, unknown> = {
    type: "message",
    role: rng.pick(["user", "assistant"]),
    content: [{ type: "output_text", text: text(rng) }],
  };
  if (rng.next() < 0.5) message.providerData = jsonish(rng, 1);
  if (rng.next() < 0.2) message[Symbol("request-mark") as unknown as string] = "local";
  if (rng.next() < 0.2) message.extra = jsonish(rng, 1);
  return message;
}

/** An equal item under JSON identity, or an item that differs from it. */
function variant(rng: Random, source: Record<string, unknown>): Record<string, unknown> {
  switch (rng.int(9)) {
    case 0: {
      // Same content, keys in another insertion order.
      return Object.fromEntries(Object.entries(source).reverse());
    }
    case 1:
      return structuredClone(source);
    case 2:
      return { ...source, extra: jsonish(rng, 1) };
    case 3:
      return { ...source, content: [{ type: "output_text", text: text(rng) }] };
    case 4: {
      const copy = { ...source };
      delete copy[rng.pick(Object.keys(copy))];
      return copy;
    }
    case 5:
      return { ...source, unset: undefined };
    case 6:
      return { ...source, type: rng.pick(["message", "function_call", "reasoning"]) };
    case 7:
      return { ...source, providerData: { nested: { deep: [jsonish(rng, 3)] } } };
    default:
      return source;
  }
}

function mutate(rng: Random, items: Array<Record<string, unknown>>) {
  const next = [...items];
  const position = next.length ? rng.int(next.length) : 0;
  switch (rng.int(8)) {
    case 0:
      next.push(historyItem(rng, next.length));
      break;
    case 1:
      if (next.length) next[position] = variant(rng, next[position]!);
      break;
    case 2:
      next.splice(position, 1);
      break;
    case 3:
      next.splice(position, 0, historyItem(rng, position));
      break;
    case 4:
      if (next.length > 1) {
        const other = rng.int(next.length);
        [next[position], next[other]] = [next[other]!, next[position]!];
      }
      break;
    case 5:
      next.length = rng.int(next.length + 1);
      break;
    default:
      for (let i = 0; i < 1 + rng.int(3); i++) next.push(historyItem(rng, next.length));
  }
  return next;
}

function outcome(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return `throw:${(error as Error).message}`;
  }
}

test("canonical comparison decides exactly as the SHA-256 identity on randomized histories", () => {
  let rejected = 0;
  let accepted = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const rng = random(seed);
    const truncation = rng.pick([undefined, 32, 4_000]);
    const legacy = new LegacyHistoryPrefixGuard();
    const current = new HistoryPrefixGuard();
    let history = Array.from({ length: rng.int(30) }, (_, index) => historyItem(rng, index));
    const count = rng.int(history.length + 2);
    const seeded = outcome(() => legacy.seed(history, count, truncation));
    expect(outcome(() => current.seed(history, count, truncation))).toBe(seeded);
    if (seeded !== "ok") continue;
    for (let step = 0; step < 12; step++) {
      history =
        rng.next() < 0.6 ? mutate(rng, history) : [...history, historyItem(rng, history.length)];
      let legacyKeys: string[] = [];
      let currentKeys: unknown[] = [];
      const expected = outcome(() => (legacyKeys = legacy.verify(history, truncation)));
      expect(outcome(() => (currentKeys = current.verify(history, truncation)))).toBe(expected);
      if (expected !== "ok") {
        rejected++;
        continue;
      }
      accepted++;
      expect(currentKeys).toHaveLength(legacyKeys.length);
      if (rng.next() < 0.7) {
        const watermark = rng.int(legacyKeys.length + 1);
        legacy.acknowledge(legacyKeys, watermark);
        current.acknowledge(currentKeys, watermark);
      }
    }
  }
  // Both branches are exercised in volume.
  expect(rejected).toBeGreaterThan(200);
  expect(accepted).toBeGreaterThan(200);
});

test("a tampered, shortened or reordered durable prefix is still rejected at the same item", () => {
  const rng = random(99);
  const history = Array.from({ length: 40 }, (_, index) => ({
    type: "message",
    role: index % 2 ? "assistant" : "user",
    content: [{ type: "output_text", text: `${index} ${text(rng)}` }],
  })) as Array<Record<string, unknown>>;
  const cases: Array<[string, Array<Record<string, unknown>>]> = [
    [
      "one character",
      history.map((entry, i) => (i === 17 ? { ...entry, role: "assistant " } : entry)),
    ],
    ["shorter", history.slice(0, 25)],
    ["swapped", [...history.slice(0, 5), history[6]!, history[5]!, ...history.slice(7)]],
    ["removed", [...history.slice(0, 3), ...history.slice(4)]],
    [
      "number type",
      history.map((entry, i) => (i === 30 ? { ...entry, n: "1" } : { ...entry, n: 1 })),
    ],
  ];
  for (const [name, changed] of cases) {
    const legacy = new LegacyHistoryPrefixGuard();
    const current = new HistoryPrefixGuard();
    legacy.seed(history, history.length);
    current.seed(history, history.length);
    const expected = outcome(() => legacy.verify(changed));
    expect(expected, name).toStartWith("throw:Conversation history durable prefix changed");
    expect(
      outcome(() => current.verify(changed)),
      name,
    ).toBe(expected);
  }
  // In-place mutation after acknowledgment is caught: identities are copies.
  const current = new HistoryPrefixGuard();
  const live = history.map((entry) => structuredClone(entry));
  current.seed(live, live.length);
  (live[8]!.content as Array<{ text: string }>)[0]!.text += "!";
  expect(() => current.verify(live)).toThrow("durable prefix changed at item 8");
});

test("sameCanonicalJson matches JSON equality of canonical trees", () => {
  const values: unknown[] = [
    null,
    0,
    -0,
    1,
    "1",
    "",
    true,
    false,
    [],
    {},
    [null],
    [0],
    { a: 1 },
    { a: 1, b: 2 },
    { b: 2, a: 1 },
    { a: [1, { b: "x" }] },
    { a: [1, { b: "y" }] },
    { "10": 1, "2": 2 },
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];
  for (const left of values) {
    for (const right of values) {
      expect(sameCanonicalJson(left, right)).toBe(JSON.stringify(left) === JSON.stringify(right));
    }
  }
});
