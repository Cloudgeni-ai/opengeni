import { describe, expect, test } from "bun:test";
import { modelResponseUsageFromResponse, modelResponseUsageFromSdkEvent } from "../src/index";

// Hosted web search is billed per search; settlement charges the count the
// response reports, so OpenAI's `web_search_call` items must be counted like
// Claude's reported server-tool searches.

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

describe("hosted web search request counts", () => {
  test("counts OpenAI web_search_call items in the SDK's response_done output", () => {
    const event = {
      type: "raw_model_stream_event",
      data: {
        type: "response_done",
        response: {
          id: "resp-openai",
          usage,
          output: [
            { type: "hosted_tool_call", name: "web_search_call", status: "completed" },
            { type: "hosted_tool_call", name: "web_search_call", status: "completed" },
            { type: "hosted_tool_call", name: "web_search_call", status: "failed" },
            { type: "hosted_tool_call", name: "image_generation_call", status: "completed" },
            { type: "message", role: "assistant", content: [] },
          ],
        },
      },
    } as any;
    expect(modelResponseUsageFromSdkEvent(event)?.webSearchRequests).toBe(2);
  });

  test("counts web_search_call items of a raw Responses terminal response", () => {
    expect(
      modelResponseUsageFromResponse({
        id: "resp-raw",
        usage,
        output: [
          { type: "web_search_call", status: "completed", action: { type: "search" } },
          { type: "reasoning" },
          { type: "web_search_call", status: "completed", action: { type: "open_page" } },
        ],
      })?.webSearchRequests,
    ).toBe(2);
  });

  test("Claude's reported count wins and its search blocks are not counted again", () => {
    expect(
      modelResponseUsageFromResponse({
        id: "msg-claude",
        usage,
        output: [
          { type: "hosted_tool_call", name: "web_search_call", status: "completed" },
          { type: "hosted_tool_call", name: "web_search_call", status: "completed" },
        ],
        providerData: { anthropic: { webSearchRequests: 1 } },
      })?.webSearchRequests,
    ).toBe(1);
    expect(
      modelResponseUsageFromResponse({
        id: "msg-claude-none",
        usage,
        output: [{ type: "hosted_tool_call", name: "web_search_call", status: "completed" }],
        providerData: { anthropic: { stopReason: "end_turn" } },
      }),
    ).not.toHaveProperty("webSearchRequests");
  });

  test("a response without searches reports none", () => {
    expect(
      modelResponseUsageFromResponse({ id: "resp-plain", usage, output: [] }),
    ).not.toHaveProperty("webSearchRequests");
  });
});
