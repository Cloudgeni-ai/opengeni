import { describe, expect, test } from "bun:test";
import { historyCallId } from "../src/session-tool-call-settlement";

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
});
