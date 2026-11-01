import { expect, test } from "bun:test";
import { projectHistoryForProvider } from "@opengeni/runtime";
import { HistoryPrefixGuard } from "../src/activities/agent-turn/history-prefix";

const claudeSearch = {
  type: "hosted_tool_call",
  name: "web_search",
  status: "completed",
  providerData: {
    anthropic: {
      blocks: [
        {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "web_search",
          input: { query: "release notes" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [
            {
              type: "web_search_result",
              url: "https://example.com/notes",
              title: "Release notes",
              encrypted_content: "ENC_PAGE_1",
            },
          ],
        },
      ],
    },
  },
};

const history = [
  { type: "message", role: "user", content: "Find the release notes" },
  claudeSearch,
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Found them." }],
  },
  { type: "message", role: "user", content: "Thanks, next question" },
] as Array<Record<string, unknown>>;

test("a Claude search marked with the runtime record form seeds the next turn's history guard", () => {
  // The turn input is the provider projection, which marks a native Claude
  // search with a request-local symbol key in the runtime form.
  const input = projectHistoryForProvider(history, "anthropic-messages", {
    searchRecordForm: "runtime",
  });
  expect(Object.getOwnPropertySymbols(input[1]!)).toHaveLength(1);

  const guard = new HistoryPrefixGuard();
  expect(() => guard.seed(input, history.length)).not.toThrow();
  // The mark is not part of the item's identity: the unmarked history (as
  // the run's state holds it after a copy) verifies against the same prefix.
  expect(() => guard.verify(history)).not.toThrow();
  expect(guard.verify(input)).toEqual(guard.verify(history));
});
