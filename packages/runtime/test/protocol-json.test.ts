import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  normalizeProtocolJsonValue,
  UnsupportedProtocolJsonValueError,
} from "../src/protocol-json";

describe("normalizeProtocolJsonValue", () => {
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
  });

  test("retains references for already-valid protocol JSON", () => {
    const input = { type: "message", content: [{ type: "output_text", text: "done" }] };
    expect(normalizeProtocolJsonValue(input)).toBe(input);
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

  test("rejects undefined array elements with their exact path", () => {
    expect(() => normalizeProtocolJsonValue({ output: ["ok", undefined] })).toThrow(
      'Protocol JSON value at $["output"][1] cannot contain undefined',
    );
  });

  test("rejects non-JSON values instead of coercing them", () => {
    const cases: Array<[unknown, string]> = [
      [{ usage: 2n }, '$["usage"]'],
      [{ score: Number.NaN }, '$["score"]'],
      [{ createdAt: new Date(0) }, '$["createdAt"]'],
    ];
    for (const [value, path] of cases) {
      try {
        normalizeProtocolJsonValue(value);
        throw new Error("expected normalization to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedProtocolJsonValueError);
        expect((error as UnsupportedProtocolJsonValueError).path).toBe(path);
      }
    }
  });

  test("rejects cycles and preserves prototype-sensitive keys", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeProtocolJsonValue(cyclic)).toThrow(
      'Protocol JSON value at $["self"] cannot contain a cyclic reference',
    );

    const input = JSON.parse('{"__proto__":{"safe":true},"optional":null}') as Record<
      string,
      unknown
    >;
    const normalized = normalizeProtocolJsonValue(input);
    expect(normalized).toBe(input);
    expect(Object.hasOwn(normalized, "__proto__")).toBe(true);
  });

  test("rejects symbol keys at every depth by default", () => {
    const mark = Symbol("request mark");
    expect(() => normalizeProtocolJsonValue({ type: "message", [mark]: "runtime" })).toThrow(
      "Protocol JSON value at $ cannot contain symbol keys",
    );
    expect(() =>
      normalizeProtocolJsonValue({ content: [{ type: "output_text", [mark]: true }] }),
    ).toThrow('Protocol JSON value at $["content"][0] cannot contain symbol keys');
  });

  test("omitSymbolKeys leaves request-local marks out at every depth without mutating input", () => {
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

    const normalized = normalizeProtocolJsonValue(input, "$", { omitSymbolKeys: true });

    expect(normalized).toEqual({
      type: "hosted_tool_call",
      providerData: { anthropic: { blocks: [{ type: "server_tool_use", id: "srvtoolu_1" }] } },
      content: [{ type: "output_text", text: "done" }],
    } as never);
    const hasSymbolKey = (value: unknown): boolean =>
      value !== null &&
      typeof value === "object" &&
      (Object.getOwnPropertySymbols(value).length > 0 ||
        Object.values(value).some((entry) => hasSymbolKey(entry)));
    expect(hasSymbolKey(normalized)).toBe(false);
    // The input keeps its marks; the result is a copy wherever one was omitted.
    expect(Object.getOwnPropertySymbols(input)).toEqual([mark]);
    expect(Object.getOwnPropertySymbols(blocks)).toEqual([mark]);
    expect(Object.getOwnPropertySymbols(input.content[0]!)).toEqual([mark]);
    expect(normalized).not.toBe(input);
    // An unmarked subtree keeps its reference.
    const plain = { type: "message", content: [{ type: "input_text", text: "hi" }] };
    expect(normalizeProtocolJsonValue(plain, "$", { omitSymbolKeys: true })).toBe(plain);
  });

  test("omitSymbolKeys still rejects every other non-JSON value", () => {
    const mark = Symbol("request mark");
    const cyclic: Record<string | symbol, unknown> = { [mark]: true };
    cyclic.self = cyclic;
    const cases: Array<[unknown, string]> = [
      [{ [mark]: true, run: () => undefined }, '$["run"]'],
      [{ [mark]: true, nested: { at: new Date(0) } }, '$["nested"]["at"]'],
      [cyclic, '$["self"]'],
    ];
    for (const [value, path] of cases) {
      try {
        normalizeProtocolJsonValue(value, "$", { omitSymbolKeys: true });
        throw new Error("expected normalization to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedProtocolJsonValueError);
        expect((error as UnsupportedProtocolJsonValueError).path).toBe(path);
      }
    }
  });
});
