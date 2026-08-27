import { describe, expect, test } from "bun:test";
import { historyCallId, interruptedToolCallResult } from "../src/session-tool-call-settlement";

describe("session tool-call settlement identity", () => {
  test("accepts native tool-search ids carried only in provider data", () => {
    expect(
      historyCallId({
        type: "tool_search_output",
        tools: [{ name: "matching_tool" }],
        providerData: { call_id: "tool-search-provider-id" },
      }),
    ).toBe("tool-search-provider-id");
  });

  test("keeps direct SDK aliases ahead of provider metadata and item ids", () => {
    expect(
      historyCallId({
        type: "tool_search_output",
        callId: "direct-id",
        id: "item-id",
        providerData: { call_id: "provider-id" },
      }),
    ).toBe("direct-id");
  });

  test("ignores malformed provider metadata", () => {
    expect(
      historyCallId({
        type: "tool_search_output",
        id: "item-id",
        providerData: ["provider-id"],
      }),
    ).toBe("item-id");
  });

  test("falls back when a provider id is not a non-empty string", () => {
    expect(
      historyCallId({
        type: "tool_search_output",
        id: "item-id",
        providerData: { call_id: 42 },
      }),
    ).toBe("item-id");
  });

  test("uses one provider id for an interrupted native tool-search pair", () => {
    const callId = "call_native_search_1";
    const call = {
      id: "tsc_provider_item_1",
      type: "tool_search_call",
      arguments: { query: "mail" },
      providerData: { call_id: callId, execution: "client" },
    };
    const result = interruptedToolCallResult({
      callType: "tool_search_call",
      callId,
      callItem: call,
      reason: "worker_shutdown",
    });

    expect(historyCallId(call)).toBe(callId);
    expect(historyCallId(result!)).toBe(callId);
  });
});
