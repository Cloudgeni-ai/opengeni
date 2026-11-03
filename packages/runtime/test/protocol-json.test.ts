import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { JsonSafeAdjustment } from "@opengeni/contracts/json-safe";
import { normalizeProtocolJsonValue } from "../src/protocol-json";

describe("normalizeProtocolJsonValue", () => {
  let warn: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  test("omits JavaScript-only undefined object properties recursively without mutating input", () => {
    const input = {
      type: "hosted_tool_call",
      output: undefined,
      providerData: {
        type: "web_search_call",
        optional: undefined,
        result: { query: "Opengeni" },
      },
    };

    const normalized = normalizeProtocolJsonValue(input);

    expect(normalized).toEqual({
      type: "hosted_tool_call",
      providerData: {
        type: "web_search_call",
        result: { query: "Opengeni" },
      },
    });
    expect(Object.hasOwn(input, "output")).toBe(true);
    expect(Object.hasOwn(input.providerData, "optional")).toBe(true);
    // An absent optional property is ordinary JSON wire behaviour, not an adjustment.
    expect(warn).not.toHaveBeenCalled();
  });

  test("retains references for already-valid protocol JSON", () => {
    const input = { type: "message", content: [{ type: "output_text", text: "done" }] };
    expect(normalizeProtocolJsonValue(input)).toBe(input);
    expect(warn).not.toHaveBeenCalled();
  });

  test("normalizes plain JSON objects received from another JavaScript realm", () => {
    const input = runInNewContext('({ providerState: { manifest: { image: "node:22" } } })');

    const normalized = normalizeProtocolJsonValue(input);

    expect(normalized).toEqual({
      providerState: { manifest: { image: "node:22" } },
    });
    expect(normalized).not.toBe(input);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(normalized.providerState)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(normalized.providerState.manifest)).toBe(Object.prototype);
  });

  test("converts values JSON cannot carry, as JSON.stringify would, and logs their paths", () => {
    const mark = Symbol("request mark");
    const cyclic: Record<string, unknown> = { id: "c" };
    cyclic.self = cyclic;
    const input = {
      type: "hosted_tool_call",
      [mark]: "runtime",
      output: ["ok", undefined, () => "x"],
      usage: 2n,
      huge: 2n ** 80n,
      score: Number.NaN,
      zero: -0,
      createdAt: new Date(0),
      run: () => undefined,
      cyclic,
      failure: Object.assign(new Error("boom"), { code: "E_BOOM", secret: "kept out" }),
      headers: new Headers({ "x-request-id": "r1" }),
      signal: new AbortController().signal,
    };

    const normalized = normalizeProtocolJsonValue(input, '$["item"]');

    expect(normalized).toEqual({
      type: "hosted_tool_call",
      output: ["ok", null, null],
      usage: 2,
      huge: (2n ** 80n).toString(),
      score: null,
      zero: 0,
      createdAt: "1970-01-01T00:00:00.000Z",
      cyclic: { id: "c", self: null },
      failure: { name: "Error", message: "boom", code: "E_BOOM" },
      // Bun's Headers has toJSON, as JSON.stringify uses.
      headers: { "x-request-id": "r1" },
      signal: {},
    } as never);
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(normalized as never);
    expect(Object.getOwnPropertySymbols(input)).toEqual([mark]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, summary] = warn.mock.calls[0]! as [string, Record<string, unknown>];
    expect(message).toBe("Protocol JSON value adjusted");
    expect(summary).toMatchObject({ rootPath: '$["item"]', count: 13 });
    expect(summary.kinds).toEqual({
      symbol_key: 1,
      undefined: 1,
      function: 2,
      bigint: 2,
      non_finite_number: 1,
      negative_zero: 1,
      "to_json:Date": 1,
      "to_json:Headers": 1,
      cycle: 1,
      "error:Error": 1,
      "class_instance:AbortSignal": 1,
    });
    // Paths and kinds only: no value reaches the log.
    expect(JSON.stringify(summary)).not.toContain("kept out");
    expect(JSON.stringify(summary)).not.toContain("boom");
  });

  test("keeps prototype-sensitive keys", () => {
    const input = JSON.parse('{"__proto__":{"safe":true},"optional":null}') as Record<
      string,
      unknown
    >;
    const normalized = normalizeProtocolJsonValue(input);
    expect(normalized).toBe(input);
    expect(Object.hasOwn(normalized, "__proto__")).toBe(true);

    const converted = normalizeProtocolJsonValue(
      JSON.parse('{"__proto__":{"at":1},"n":-0}') as Record<string, unknown>,
    );
    expect(Object.hasOwn(converted, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(converted)).toBe(Object.prototype);
  });

  test("a boundary's own handler receives every adjustment instead of the log", () => {
    const mark = Symbol("request mark");
    const blocks = Object.assign([{ type: "server_tool_use", id: "srvtoolu_1" }], {
      [mark]: "array mark",
    });
    const input = {
      type: "hosted_tool_call",
      [mark]: "runtime",
      providerData: { anthropic: { blocks, [mark]: "nested" } },
      content: [{ type: "output_text", text: "done", [mark]: true }],
    };
    const adjustments: JsonSafeAdjustment[] = [];

    const normalized = normalizeProtocolJsonValue(input, "$", {
      onAdjustment: (adjustment) => adjustments.push(adjustment),
    });

    expect(normalized).toEqual({
      type: "hosted_tool_call",
      providerData: { anthropic: { blocks: [{ type: "server_tool_use", id: "srvtoolu_1" }] } },
      content: [{ type: "output_text", text: "done" }],
    } as never);
    expect(adjustments).toEqual([
      { path: '$["providerData"]["anthropic"]["blocks"]', kind: "symbol_key" },
      { path: '$["providerData"]["anthropic"]', kind: "symbol_key" },
      { path: '$["content"][0]', kind: "symbol_key" },
      { path: "$", kind: "symbol_key" },
    ]);
    expect(warn).not.toHaveBeenCalled();
    // The input keeps its marks; an unmarked subtree keeps its reference.
    expect(Object.getOwnPropertySymbols(input)).toEqual([mark]);
    expect(Object.getOwnPropertySymbols(blocks)).toEqual([mark]);
    const plain = { type: "message", content: [{ type: "input_text", text: "hi" }] };
    expect(normalizeProtocolJsonValue(plain, "$", { onAdjustment: () => undefined })).toBe(plain);
  });

  test("never throws, even for a hostile proxy or a throwing toJSON", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    const input = {
      hostile,
      later: { toJSON: undefined, nested: { toJSON() {} } },
      broken: {
        toJSON() {
          throw new Error("nope");
        },
      },
    };
    expect(() => normalizeProtocolJsonValue(input)).not.toThrow();
    expect(normalizeProtocolJsonValue(input)).toMatchObject({ hostile: null });
  });
});
