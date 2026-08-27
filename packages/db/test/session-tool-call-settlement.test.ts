import { describe, expect, test } from "bun:test";

import { historyCallId } from "../src/session-tool-call-settlement";

describe("session tool-call settlement identity", () => {
  test("prefers a native tool-search call id in provider data over the provider item id", () => {
    expect(
      historyCallId({
        id: "tso_provider_item_id",
        type: "tool_search_output",
        tools: [{ name: "lumen__get_organization_profile" }],
        providerData: { call_id: "call_native_tool_search" },
      }),
    ).toBe("call_native_tool_search");
  });

  test("keeps direct call ids authoritative and accepts the camel-case provider alias", () => {
    expect(
      historyCallId({
        id: "provider_item_id",
        callId: "call_direct",
        providerData: { call_id: "call_provider" },
      }),
    ).toBe("call_direct");
    expect(
      historyCallId({
        id: "provider_item_id",
        providerData: { callId: "call_provider_camel" },
      }),
    ).toBe("call_provider_camel");
    expect(historyCallId({ id: "provider_item_fallback" })).toBe("provider_item_fallback");
  });
});
