import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { toJsonSafeValue } from "@opengeni/contracts/json-safe";
import { fingerprint, hostileGraph, isStrictJson } from "../../contracts/test/hostile-values";
import { estimateSerializedValueTokens } from "../src/context-compaction";
import { McpResultCustomDataBridge } from "../src/mcp-result-custom-data";
import { functionCallResultItem } from "../src/open-suffix";
import { normalizeSdkEvent, serializeApprovals } from "../src/run-events";
import { sandboxStateEntryFromRunState } from "../src/sandbox";

/**
 * Every protocol JSON boundary in the runtime takes values from SDKs, tools,
 * errors and events. None of them may fail on a value JSON cannot carry: it
 * stores the converted value and logs the paths it changed.
 */
describe("runtime protocol JSON boundaries with hostile values", () => {
  let warn: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const seeds = Array.from({ length: 60 }, (_, index) => index * 31 + 5);

  test("an SDK tool-call event", () => {
    for (const seed of seeds) {
      const graph = hostileGraph(seed);
      const rawItem = {
        type: "function_call",
        callId: `call-${seed}`,
        name: "tool",
        arguments: "{}",
        providerData: graph.value,
        [Symbol("request mark")]: "runtime",
      };
      const before = fingerprint(rawItem);
      const events = normalizeSdkEvent({
        type: "run_item_stream_event",
        item: { id: "item-1", type: "tool_call_item", rawItem },
      } as never);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(isStrictJson(event)).toBe(true);
      const raw = (events[0]!.payload as { raw: { providerData?: unknown } }).raw;
      expect(raw.providerData ?? null).toEqual((toJsonSafeValue(graph.value) ?? null) as never);
      expect(fingerprint(rawItem)).toBe(before);
      expect(graph.getterCalls()).toBe(0);
    }
  });

  test("approval interruptions", () => {
    for (const seed of seeds) {
      const graph = hostileGraph(seed);
      const approvals = serializeApprovals([
        {
          name: "dangerous_tool",
          rawItem: {
            callId: `approval-${seed}`,
            name: "dangerous_tool",
            arguments: "{}",
            providerData: graph.value,
          },
          agent: { name: "agent", run: () => undefined },
        },
      ]);
      expect(approvals).toHaveLength(1);
      expect(isStrictJson(approvals)).toBe(true);
    }
  });

  test("the sandbox session envelope", () => {
    for (const seed of seeds) {
      const graph = hostileGraph(seed);
      const entry = sandboxStateEntryFromRunState({
        _sandbox: {
          backendId: "docker",
          currentAgentKey: "agent",
          currentAgentName: "Agent",
          sessionState: { providerState: graph.value, startedAt: new Date(0), pid: 12n },
        },
      });
      expect(entry).not.toBeNull();
      expect(isStrictJson(entry)).toBe(true);
    }
  });

  test("a resumed tool result becomes model text", () => {
    for (const seed of seeds) {
      const graph = hostileGraph(seed);
      const item = functionCallResultItem({ callId: "c", name: "tool", output: graph.value });
      const text = (item.output as { text: string }).text;
      expect(typeof text).toBe("string");
      // The native serializer's text where it succeeds, the converted value's otherwise.
      expect(() => JSON.parse(text)).not.toThrow();
    }
    const cyclic: Record<string, unknown> = { big: 2n };
    cyclic.self = cyclic;
    const item = functionCallResultItem({ callId: "c", name: "tool", output: cyclic });
    expect(JSON.parse((item.output as { text: string }).text)).toEqual({ big: 2, self: null });
  });

  test("token estimates of values JSON cannot carry", () => {
    for (const seed of seeds) {
      const estimate = estimateSerializedValueTokens(hostileGraph(seed).value);
      expect(Number.isFinite(estimate)).toBe(true);
    }
    const cyclic: Record<string, unknown> = { big: 2n };
    cyclic.self = cyclic;
    expect(estimateSerializedValueTokens(cyclic)).toBeGreaterThan(0);
    expect(Number.isFinite(estimateSerializedValueTokens(undefined))).toBe(true);
  });

  test("an MCP tool result", async () => {
    for (const seed of seeds) {
      const graph = hostileGraph(seed);
      const bridge = new McpResultCustomDataBridge();
      const result = await bridge.captureResult(null, async () => ({
        content: [{ type: "text", text: "ok", extra: graph.value }],
        structuredContent: { value: graph.value },
        _meta: { [Symbol("mark")]: true, at: new Date(0) },
      }));
      expect(isStrictJson(result)).toBe(true);
    }
    // A value the schema refuses even after conversion is kept as text.
    class Stringly {
      toJSON() {
        return "not an object";
      }
    }
    const bridge = new McpResultCustomDataBridge();
    const result = await bridge.captureResult(null, async () => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: new Stringly(),
    }));
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            structuredContent: "not an object",
          }),
        },
      ],
    });
    // The fallback keeps an error result an error and `_meta` out of the model's view.
    const failed = await new McpResultCustomDataBridge().captureResult(null, async () => ({
      content: [{ type: "text", text: "permission denied" }],
      structuredContent: new Stringly(),
      isError: true,
      _meta: { "io.example/trace": "trace-token" },
    }));
    expect((failed as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("trace-token");
  });

  test("the adjustment log names paths and kinds, never values", () => {
    normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "item-1",
        type: "tool_call_item",
        rawItem: {
          type: "function_call",
          callId: "call-secret",
          name: "tool",
          arguments: "{}",
          providerData: { token: 1n, error: new Error("private detail") },
        },
      },
    } as never);
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("Protocol JSON value adjusted");
    expect(logged).toContain('$[\\"event\\"]');
    expect(logged).not.toContain("private detail");
  });
});
