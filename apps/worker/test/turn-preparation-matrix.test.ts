import { describe, expect, test } from "bun:test";
import {
  buildCompactionReplacementHistory,
  normalizeProtocolJsonValue,
  prepareCompactionPromptInput,
  projectHistoryForProvider,
  type HistoryProviderApi,
  type SearchRecordForm,
} from "@opengeni/runtime";
import { anthropicMessages } from "../../../packages/runtime/src/anthropic-messages";
import { HistoryPrefixGuard } from "../src/activities/agent-turn/history-prefix";
import { projectTurnHistoryForProvider } from "../src/activities/search-record-form";

/**
 * Turn preparation across every provider-native item kind Opengeni persists,
 * every provider projection and search-record form, before and after
 * compaction. A future marker or item shape that breaks preparation (as the
 * request-local symbol mark on Claude searches did on 2 November 2026) fails
 * here instead of failing a user's next turn.
 */

type Item = Record<string, unknown>;

const user = (text: string): Item => ({ type: "message", role: "user", content: text });
const userParts = (text: string): Item => ({
  type: "message",
  role: "user",
  content: [
    { type: "input_text", text },
    // Files reach the model as images or text after attachment projection.
    { type: "input_image", image: "data:image/png;base64,aGk=" },
  ],
});
const assistant = (text: string): Item => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});

/** A Claude reply part with a citation into an earlier search. */
const claudeCitedAssistant: Item = {
  type: "message",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "Section 5(c) is the overage clause.",
      providerData: {
        anthropic: {
          citations: [
            {
              type: "web_search_result_location",
              url: "https://vercel.com/legal/enterprise-terms",
              title: "Enterprise Terms",
              encrypted_index: "ENC_INDEX_1",
              cited_text: "Overage; Expiry",
            },
          ],
        },
      },
    },
  ],
};

/** The stored shape of a Claude web search, with or without its results. */
function claudeSearch(id: string, query: string, withResults: boolean): Item {
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
          ? { sources: [{ url: "https://vercel.com/legal/enterprise-terms", type: "url" }] }
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

/** The stored shape of an OpenAI Responses web search. */
const openAiSearch: Item = {
  type: "hosted_tool_call",
  id: "ws_openai",
  name: "web_search_call",
  status: "completed",
  providerData: {
    type: "web_search_call",
    id: "ws_openai",
    action: {
      type: "search",
      query: "Claude model hosting regions",
      sources: [{ type: "url", url: "https://example.test/regions" }],
    },
    results: [
      {
        type: "text_result",
        url: "https://example.test/regions",
        title: "Regions",
        snippet: "Claude runs on Bedrock in eu-central-1.",
      },
    ],
  },
};

const claudeThinking: Item = {
  type: "reasoning",
  content: [{ type: "input_text", text: "Check the routing table" }],
  providerData: {
    anthropic: {
      block: { type: "thinking", thinking: "Check the routing table", signature: "sig-1" },
    },
  },
};
const openAiReasoning: Item = {
  type: "reasoning",
  id: "rs_1",
  content: [],
  providerData: { encrypted_content: "ENC_REASONING" },
};
const toolCall = (callId: string, args = JSON.stringify({ path: "routing.yaml" })): Item => ({
  type: "function_call",
  callId,
  name: "read_file",
  arguments: args,
  status: "completed",
});
const toolResult = (callId: string, output: unknown = "{}"): Item => ({
  type: "function_call_result",
  callId,
  name: "read_file",
  status: "completed",
  output,
});
const remoteCompaction: Item = { type: "compaction", encrypted_content: "ENC_COMPACTION" };

/** One turn of every persisted kind, as a Claude turn and an OpenAI turn store them. */
function storedTurns(round: string): Item[] {
  return [
    userParts(`Where do we run the Claude models? (${round})`),
    claudeThinking,
    claudeSearch(`${round}a`, "Bedrock Claude regions", true),
    claudeSearch(`${round}b`, "Vertex Claude regions", false),
    toolCall(`toolu_${round}`),
    toolResult(`toolu_${round}`, [{ type: "text", text: "region: eu-central-1" }]),
    claudeCitedAssistant,
    user(`And the OpenAI ones? (${round})`),
    openAiReasoning,
    openAiSearch,
    toolCall(`call_${round}`, "not json {"),
    toolResult(`call_${round}`, "parse error"),
    toolCall(`call_${round}_image`),
    toolResult(`call_${round}_image`, {
      type: "image",
      image: "data:image/png;base64,aGk=",
    }),
    assistant(`Sweden Central. (${round})`),
  ];
}

function historiesToPrepare(): Array<{
  name: string;
  history: Item[];
  apis?: HistoryProviderApi[];
}> {
  const before = storedTurns("1");
  const compacted = buildCompactionReplacementHistory(before, "Earlier: routing questions.");
  return [
    { name: "before compaction", history: before },
    {
      name: "after compaction",
      history: [...compacted, ...storedTurns("2")],
    },
    {
      name: "after remote compaction",
      history: [remoteCompaction, user("Continue"), ...storedTurns("3")],
      // An OpenAI compaction item is Responses-only; a switch to another API
      // compacts portably first (ProviderHistoryIncompatibleError).
      apis: ["responses"],
    },
    // A turn that stopped inside a Claude search (no reply yet).
    {
      name: "ending in a search",
      history: [...before, user("Search again"), claudeSearch("4", "Claude EU", true)],
    },
  ];
}

const APIS: HistoryProviderApi[] = ["responses", "chat", "anthropic-messages"];
const FORMS: SearchRecordForm[] = ["assistant", "runtime"];

function isStrictJson(value: unknown): boolean {
  const text = JSON.stringify(value);
  return text !== undefined && JSON.stringify(JSON.parse(text)) === text;
}

describe("turn preparation for every persisted item kind", () => {
  for (const { name, history, apis = APIS } of historiesToPrepare()) {
    for (const api of apis) {
      for (const form of FORMS) {
        test(`${name}, ${api}, ${form} search records`, () => {
          // The turn input exactly as the worker projects it.
          const input = projectTurnHistoryForProvider(history, api, { form });
          const next = [...input, user("Can you check where we run the Claude models?")];

          // The history guard seeds from the prepared input and its identity
          // ignores request-local marks: the stored history verifies the same.
          const guard = new HistoryPrefixGuard();
          expect(() => guard.seed(next, input.length)).not.toThrow();
          expect(guard.verify(next).slice(0, input.length)).toEqual(
            new HistoryPrefixGuard().verify(projectTurnHistoryForProvider(history, api, { form })),
          );

          // Every prepared item crosses the protocol JSON boundary as plain JSON.
          for (const item of next) {
            const normalized = normalizeProtocolJsonValue(item);
            expect(isStrictJson(normalized)).toBe(true);
          }

          // The Claude wire messages encode.
          if (api === "anthropic-messages") {
            const messages = anthropicMessages(next as never, {
              webSearch: true,
              accountScope: "organization-claude-subscription:account-1",
            });
            expect(messages.length).toBeGreaterThan(0);
            expect(isStrictJson(messages)).toBe(true);
          }
        });
      }
    }

    test(`${name}: compaction's own prompt input prepares`, () => {
      const prepared = prepareCompactionPromptInput(history, 1_000_000);
      for (const item of prepared.input) {
        expect(isStrictJson(normalizeProtocolJsonValue(item))).toBe(true);
      }
    });
  }
});

describe("projectHistoryForProvider output", () => {
  test("every projected item survives the protocol JSON boundary unchanged in JSON", () => {
    for (const { history, apis = APIS } of historiesToPrepare()) {
      for (const api of apis) {
        for (const searchRecordForm of [undefined, ...FORMS]) {
          const projected = projectHistoryForProvider(
            history,
            api,
            searchRecordForm ? { searchRecordForm } : {},
          );
          for (const item of projected) {
            const normalized = normalizeProtocolJsonValue(item);
            // Only request-local marks (symbol keys) may differ: the JSON
            // text an item sends is exactly what the boundary keeps.
            expect(JSON.stringify(normalized)).toBe(JSON.stringify(item));
          }
        }
      }
    }
  });
});
