import { describe, expect, test } from "bun:test";
import {
  CanonicalToolArgumentsTooLargeError,
  CanonicalToolInvocationTimeoutError,
  CanonicalToolResultTooLargeError,
  assertCanonicalToolResultSize,
  canonicalToolResultError,
  inspectCanonicalToolResult,
  invokeCanonicalTool,
  normalizeCanonicalToolResult,
} from "../src";

describe("canonical tool result and invocation mechanics", () => {
  test("preserves exact MCP results and extracts structured output honestly", () => {
    const result = normalizeCanonicalToolResult({
      content: [{ type: "text", text: "done", providerField: "retained" }],
      structuredContent: { count: 3 },
      _meta: { requestId: "request-1" },
      providerResultField: true,
    });
    expect(result.content[0]).toMatchObject({ providerField: "retained" });
    expect(result).toMatchObject({ providerResultField: true });
    expect(inspectCanonicalToolResult(result, { expectsStructured: true })).toEqual({
      kind: "structured",
      value: { count: 3 },
    });
    expect(inspectCanonicalToolResult(result, { expectsStructured: false })).toEqual({
      kind: "result",
      result,
    });
  });

  test("normalizes structured tool errors with stable fallbacks", () => {
    const result = normalizeCanonicalToolResult({
      content: [],
      structuredContent: {
        error: { code: "not_ready", message: "Not ready", retryable: true },
      },
      isError: true,
    });
    expect(canonicalToolResultError(result)).toEqual({
      code: "not_ready",
      message: "Not ready",
      retryable: true,
    });
    expect(inspectCanonicalToolResult(result, { expectsStructured: true }).kind).toBe("error");
    expect(inspectCanonicalToolResult(result, { expectsStructured: false })).toEqual({
      kind: "error",
      result,
      error: {
        code: "not_ready",
        message: "Not ready",
        retryable: true,
      },
    });
  });

  test("enforces argument, result, timeout, and external abort bounds", async () => {
    const invoker = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
    await expect(
      invokeCanonicalTool(
        invoker,
        { tooLarge: "value" },
        { operationId: crypto.randomUUID(), caller: { surface: "app" } },
        { maxArgumentsBytes: 1 },
      ),
    ).rejects.toBeInstanceOf(CanonicalToolArgumentsTooLargeError);

    const result = normalizeCanonicalToolResult({ content: [{ type: "text", text: "large" }] });
    expect(() => assertCanonicalToolResultSize(result, 1)).toThrow(
      CanonicalToolResultTooLargeError,
    );

    await expect(
      invokeCanonicalTool(
        async () => await new Promise<never>(() => {}),
        {},
        { operationId: crypto.randomUUID(), caller: { surface: "app" } },
        { timeoutMs: 5 },
      ),
    ).rejects.toBeInstanceOf(CanonicalToolInvocationTimeoutError);

    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      invokeCanonicalTool(
        invoker,
        {},
        {
          operationId: crypto.randomUUID(),
          caller: { surface: "app" },
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
  });
});
