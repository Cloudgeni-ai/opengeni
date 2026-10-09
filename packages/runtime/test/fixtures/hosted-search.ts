export function hostedSearchFixture() {
  return {
    type: "hosted_tool_call" as const,
    id: "ws_fixture",
    name: "web_search_call",
    status: "completed" as const,
    providerData: {
      type: "web_search_call",
      id: "ws_fixture",
      action: {
        type: "search",
        query: "synthetic documentation",
        sources: [{ type: "url", url: "https://example.test/docs" }],
      },
      results: [{
        type: "text_result",
        url: "https://example.test/docs",
        title: "Synthetic documentation",
        snippet: "The synthetic widget supports exactly seven colors.",
      }],
    },
  };
}
