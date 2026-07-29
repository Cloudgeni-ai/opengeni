import { describe, expect, test } from "bun:test";
import { normalizeMcpOutput } from "../src";

describe("normalizeMcpOutput", () => {
  test("preserves a direct result object as canonical value", () => {
    const output = { id: "record-1", status: "updated" };
    expect(normalizeMcpOutput(output)).toEqual({
      raw: output,
      value: output,
      text: '{"id":"record-1","status":"updated"}',
      isError: false,
    });
  });

  test("parses a JSON string while preserving its presentation text", () => {
    expect(normalizeMcpOutput('{"id":"record-1"}')).toEqual({
      raw: '{"id":"record-1"}',
      value: { id: "record-1" },
      text: '{"id":"record-1"}',
      isError: false,
    });
  });

  test("normalizes a direct persisted MCP text block", () => {
    const output = { type: "text", text: '{"id":"record-1"}' };
    expect(normalizeMcpOutput(output)).toEqual({
      raw: output,
      value: { id: "record-1" },
      text: '{"id":"record-1"}',
      isError: false,
    });
  });

  test("normalizes standard MCP content and preserves isError", () => {
    const output = {
      isError: true,
      content: [
        { type: "image", data: "..." },
        { type: "text", text: '{"code":"CONFLICT"}' },
      ],
    };
    expect(normalizeMcpOutput(output)).toEqual({
      raw: output,
      value: { code: "CONFLICT" },
      text: '{"code":"CONFLICT"}',
      isError: true,
    });
  });

  test("prefers structuredContent for value and content text for presentation", () => {
    const output = {
      structuredContent: { id: "record-1", status: "updated" },
      content: [{ type: "text", text: "Record updated" }],
    };
    expect(normalizeMcpOutput(output)).toEqual({
      raw: output,
      value: { id: "record-1", status: "updated" },
      text: "Record updated",
      isError: false,
    });
  });

  test("unwraps bounded nested result and MCP envelopes", () => {
    const output = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        result: {
          content: [{ type: "text", text: '{"id":"record-1"}' }],
        },
      },
    };
    expect(normalizeMcpOutput(output)).toEqual({
      raw: output,
      value: { id: "record-1" },
      text: '{"id":"record-1"}',
      isError: false,
    });
  });

  test("does not unwrap an ordinary domain object that happens to have a result field", () => {
    const output = { operation: "check", result: { allowed: true } };
    expect(normalizeMcpOutput(output).value).toBe(output);
  });

  test("malformed or non-JSON text passes through without throwing", () => {
    expect(normalizeMcpOutput("{not json")).toEqual({
      raw: "{not json",
      value: "{not json",
      text: "{not json",
      isError: false,
    });
  });

  test("non-text MCP content and cyclic objects remain safe", () => {
    const imageOnly = { content: [{ type: "image", data: "..." }] };
    expect(normalizeMcpOutput(imageOnly).value).toBe(imageOnly);
    expect(normalizeMcpOutput(imageOnly).text).toBe('{"content":[{"type":"image","data":"..."}]}');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeMcpOutput(cyclic)).not.toThrow();
    expect(normalizeMcpOutput(cyclic).value).toBe(cyclic);
  });

  test("nullish and primitive values normalize predictably", () => {
    expect(normalizeMcpOutput(null)).toEqual({
      raw: null,
      value: null,
      text: "",
      isError: false,
    });
    expect(normalizeMcpOutput(42)).toEqual({
      raw: 42,
      value: 42,
      text: "42",
      isError: false,
    });
  });
});
