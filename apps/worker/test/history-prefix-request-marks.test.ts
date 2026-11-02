import { expect, test } from "bun:test";
import { projectHistoryForProvider } from "@opengeni/runtime";
import { HistoryPrefixGuard } from "../src/activities/agent-turn/history-prefix";
import { projectTurnHistoryForProvider } from "../src/activities/search-record-form";

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

// The stored shape of the Claude searches in the staging session whose next
// turn failed with "Protocol JSON value at $ cannot contain symbol keys"
// (2 November 2026): a completed search with results and a search that only
// got as far as its server_tool_use block, both from the previous turn.
function storedClaudeSearch(id: string, query: string, withResults: boolean) {
  const callId = `srvtoolu_${id}`;
  return {
    id: `ws_${id}`,
    name: "web_search_call",
    type: "hosted_tool_call",
    status: "completed",
    arguments: JSON.stringify({ query }),
    providerData: {
      type: "web_search_call",
      action: {
        type: "search",
        query,
        ...(withResults
          ? {
              sources: [
                { url: "https://vercel.com/legal/enterprise-terms", type: "url" },
                { url: "https://vercel.com/docs/pricing/flex-commit", type: "url" },
              ],
            }
          : {}),
      },
      call_id: callId,
      anthropic: {
        blocks: [
          { id: callId, name: "web_search", type: "server_tool_use", input: { query } },
          ...(withResults
            ? [
                {
                  type: "web_search_tool_result",
                  caller: { type: "direct" },
                  content: [
                    {
                      url: "https://vercel.com/legal/enterprise-terms",
                      type: "web_search_result",
                      title: "Enterprise Terms",
                      page_age: "2 weeks ago",
                      encrypted_content: "ENC_PAGE_1",
                    },
                    {
                      url: "https://vercel.com/docs/pricing/flex-commit",
                      type: "web_search_result",
                      title: "Flex commit pricing",
                      page_age: "1 month ago",
                      encrypted_content: "ENC_PAGE_2",
                    },
                  ],
                  tool_use_id: callId,
                },
              ]
            : []),
        ],
        accountScope: "organization-claude-subscription:account-1",
      },
    },
  };
}

test("the next turn after Claude searches in a runtime-form session seeds its history guard", () => {
  const searchedHistory = [
    { type: "message", role: "user", content: "What does section 5(c) say?" },
    storedClaudeSearch("1", "Vercel enterprise terms section 5", true),
    storedClaudeSearch("2", "Vercel flex commit overage", false),
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Section 5(c) is the overage clause." }],
    },
    { type: "message", role: "user", content: "Can you check where we run the Claude models?" },
  ] as Array<Record<string, unknown>>;

  // Exactly what the worker builds as the turn input for a Claude
  // subscription turn in a session whose search records reach the model as
  // runtime input.
  const input = projectTurnHistoryForProvider(searchedHistory, "anthropic-messages", {
    form: "runtime",
  });
  expect(input.filter((item) => Object.getOwnPropertySymbols(item).length > 0)).toHaveLength(2);

  const guard = new HistoryPrefixGuard();
  expect(() => guard.seed(input, searchedHistory.length - 1)).not.toThrow();
  expect(guard.verify(input)).toEqual(guard.verify(searchedHistory));
  // A retry of the same turn prepares the same input and seeds again.
  expect(() => new HistoryPrefixGuard().seed(input, searchedHistory.length - 1)).not.toThrow();
});

test("a request-local mark below the top level is not part of an item's identity", () => {
  const mark = Symbol("request-local mark");
  const item = storedClaudeSearch("3", "release notes", true);
  const marked = {
    ...item,
    providerData: {
      ...item.providerData,
      anthropic: { ...item.providerData.anthropic, [mark]: "runtime" },
    },
  };
  const guard = new HistoryPrefixGuard();
  expect(() => guard.seed([marked], 1)).not.toThrow();
  expect(guard.verify([item])).toEqual(guard.verify([marked]));
});

test("the history guard still refuses a value no storage can hold", () => {
  const guard = new HistoryPrefixGuard();
  expect(() =>
    guard.seed(
      [{ type: "message", role: "user", content: [{ type: "input_text", text: () => "" }] }],
      1,
    ),
  ).toThrow("cannot contain function");
});
