import { describe, expect, test } from "bun:test";
import {
  buildCompactionReplacementHistory,
  normalizeProtocolJsonValue,
  prepareCompactionPromptInput,
  projectHistoryForProvider,
  projectModelInputForCapabilities,
  TURN_OPERATIONAL_NOTICE_PREFIX,
  type HistoryProviderApi,
  type SearchRecordForm,
} from "@opengeni/runtime";
import {
  fromPostgresLosslessJson,
  LOSSLESS_CONTENT_CODEC_VERSION,
  toPostgresLosslessJson,
} from "../../../packages/db/src/lossless-json";
import { anthropicMessages } from "../../../packages/runtime/src/anthropic-messages";
import { historyRowsToAppend } from "../src/activities/agent-turn/history";
import { HistoryPrefixGuard } from "../src/activities/agent-turn/history-prefix";
import { projectTurnHistoryForProvider } from "../src/activities/search-record-form";

/**
 * Turn preparation across every provider-native item kind Opengeni persists,
 * every provider projection and search-record form, before and after
 * compaction. Each history first goes through the real storage path (history
 * rows, the canonical JSON codec and back), so the matrix prepares exactly what
 * a next turn loads. A future marker or item shape that breaks preparation (as
 * the request-local symbol mark on Claude searches did on 2 November 2026)
 * fails here instead of failing a user's next turn.
 */

type Item = Record<string, unknown>;

const CLAUDE_ACCOUNT = "organization-claude-subscription:account-1";
const PNG = "data:image/png;base64,aGk=";
const PDF = "data:application/pdf;base64,JVBERi0=";

const user = (text: string): Item => ({ type: "message", role: "user", content: text });
const userParts = (text: string): Item => ({
  type: "message",
  role: "user",
  content: [
    { type: "input_text", text },
    { type: "input_image", image: PNG },
    // A file inline and a file by provider ID.
    { type: "input_file", file: PDF, filename: "terms.pdf" },
    { type: "input_file", file: { id: "file-abc123" }, filename: "routing.pdf" },
  ],
});
const assistant = (text: string): Item => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const operationalNotice: Item = {
  type: "message",
  role: "system",
  content: `${TURN_OPERATIONAL_NOTICE_PREFIX}Web search is available for this turn.`,
};

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
        accountScope: CLAUDE_ACCOUNT,
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
const claudeRedactedThinking: Item = {
  type: "reasoning",
  content: [],
  providerData: { anthropic: { block: { type: "redacted_thinking", data: "REDACTED-1" } } },
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

/** Hosted and built-in tool items the Responses API returns. */
function openAiToolItems(round: string): Item[] {
  return [
    {
      type: "computer_call",
      callId: `cu_${round}`,
      status: "completed",
      actions: [{ type: "screenshot" }],
    },
    {
      type: "computer_call_result",
      callId: `cu_${round}`,
      output: { type: "computer_screenshot", data: PNG },
    },
    {
      type: "shell_call",
      callId: `shell_${round}`,
      status: "completed",
      action: { commands: ["cat routing.yaml"] },
    },
    {
      type: "shell_call_output",
      callId: `shell_${round}`,
      status: "completed",
      output: [{ stdout: "region: eu", stderr: "", outcome: { type: "exit", exitCode: 0 } }],
    },
    {
      type: "apply_patch_call",
      callId: `patch_${round}`,
      status: "completed",
      operation: { type: "create_file", path: "notes.md", diff: "+eu" },
    },
    {
      type: "apply_patch_call_output",
      callId: `patch_${round}`,
      status: "completed",
      output: "patched",
    },
    { type: "tool_search_call", callId: `ts_${round}`, arguments: { query: "regions" } },
    {
      type: "tool_search_output",
      callId: `ts_${round}`,
      status: "completed",
      tools: [{ name: "list_regions", description: "List regions" }],
    },
    {
      type: "hosted_tool_call",
      id: `ig_${round}`,
      name: "image_generation_call",
      status: "completed",
      // A generated image is retained and compacted out of history.
      providerData: { type: "image_generation_call" },
    },
    {
      type: "hosted_tool_call",
      id: `mcpr_${round}`,
      name: "mcp_approval_request",
      status: "completed",
      providerData: {
        type: "mcp_approval_request",
        id: `mcpr_${round}`,
        server_label: "docs",
        name: "search_docs",
        arguments: '{"q":"regions"}',
      },
    },
  ];
}

const remoteCompaction: Item = { type: "compaction", encrypted_content: "ENC_COMPACTION" };
const contextCompaction: Item = { type: "context_compaction", encrypted_content: "ENC_CONTEXT" };

/** One turn of every persisted kind, as a Claude turn and an OpenAI turn store them. */
function storedTurns(round: string): Item[] {
  return [
    userParts(`Where do we run the Claude models? (${round})`),
    operationalNotice,
    claudeThinking,
    claudeRedactedThinking,
    claudeSearch(`${round}a`, "Bedrock Claude regions", true),
    claudeSearch(`${round}b`, "Vertex Claude regions", false),
    toolCall(`toolu_${round}`),
    // Text PostgreSQL cannot store as is: NUL and a lone surrogate.
    toolResult(`toolu_${round}`, [{ type: "text", text: "region: eu\u0000central\ud800-1" }]),
    claudeCitedAssistant,
    user(`And the OpenAI ones? (${round})`),
    openAiReasoning,
    openAiSearch,
    toolCall(`call_${round}`, "not json {"),
    toolResult(`call_${round}`, "parse error"),
    toolCall(`call_${round}_image`),
    toolResult(`call_${round}_image`, { type: "image", image: PNG }),
    toolCall(`call_${round}_parts`),
    toolResult(`call_${round}_parts`, [
      { type: "input_text", text: "two attachments" },
      { type: "input_image", image: PNG },
      { type: "input_file", file: PDF, filename: "terms.pdf" },
    ]),
    ...openAiToolItems(round),
    assistant(`Sweden Central. (${round})`),
  ];
}

/**
 * What the next turn loads: history rows as the worker writes them, through
 * the canonical JSON codec and JSON text, and read back.
 */
function persistedAndLoaded(history: Item[]): Item[] {
  return historyRowsToAppend(history, 0).rows.map(({ item }) => {
    const loaded = fromPostgresLosslessJson(
      JSON.parse(JSON.stringify(toPostgresLosslessJson(item))) as Item,
      LOSSLESS_CONTENT_CODEC_VERSION,
    );
    expect(loaded).toEqual(item);
    return loaded;
  });
}

function historiesToPrepare(): Array<{
  name: string;
  history: Item[];
  apis?: HistoryProviderApi[];
}> {
  const before = persistedAndLoaded(storedTurns("1"));
  const compacted = buildCompactionReplacementHistory(before, "Earlier: routing questions.");
  return [
    { name: "before compaction", history: before },
    {
      name: "after compaction",
      history: persistedAndLoaded([...compacted, ...storedTurns("2")]),
    },
    {
      name: "after remote compaction",
      history: persistedAndLoaded([
        remoteCompaction,
        contextCompaction,
        user("Continue"),
        ...storedTurns("3"),
      ]),
      // An OpenAI compaction item is Responses-only; a switch to another API
      // compacts portably first (ProviderHistoryIncompatibleError).
      apis: ["responses"],
    },
    // A turn that stopped inside a Claude search (no reply yet).
    {
      name: "ending in a search",
      history: persistedAndLoaded([
        ...storedTurns("1"),
        user("Search again"),
        claudeSearch("4", "Claude EU", true),
      ]),
    },
  ];
}

const APIS: HistoryProviderApi[] = ["responses", "chat", "anthropic-messages"];
const FORMS: SearchRecordForm[] = ["assistant", "runtime"];

/**
 * Crossing the protocol JSON boundary, a prepared item may only lose
 * request-local marks (symbol keys) and `undefined` fields, as JSON text
 * would. Anything else (a function, a date, a class instance, a bigint, ...)
 * means preparation started producing a value the wire cannot carry.
 */
function expectOnlyRequestLocalAdjustments(item: unknown) {
  const kinds = new Set<string>();
  normalizeProtocolJsonValue(item, "$", { onAdjustment: ({ kind }) => kinds.add(kind) });
  expect([...kinds].filter((kind) => kind !== "symbol_key" && kind !== "undefined")).toEqual([]);
}

const hasSymbolMark = (item: Item) => Object.getOwnPropertySymbols(item).length > 0;

function anthropicData(item: Item): { blocks?: Item[]; block?: Item } | undefined {
  return (item.providerData as { anthropic?: { blocks?: Item[]; block?: Item } } | undefined)
    ?.anthropic;
}

function claudeSearchesWithResults(history: Item[]): string[] {
  return history.flatMap((item) => {
    const blocks = anthropicData(item)?.blocks ?? [];
    const use = blocks.find((block) => block.type === "server_tool_use");
    return use && blocks.some((block) => block.type === "web_search_tool_result")
      ? [String(use.id)]
      : [];
  });
}

const hasClaudeThinking = (history: Item[]) =>
  history.some(
    (item) => item.type === "reasoning" && anthropicData(item)?.block?.type === "thinking",
  );

describe("turn preparation for every persisted item kind", () => {
  for (const { name, history, apis = APIS } of historiesToPrepare()) {
    for (const api of apis) {
      for (const form of FORMS) {
        test(`${name}, ${api}, ${form} search records`, () => {
          // The turn input exactly as the worker projects it.
          const input = projectTurnHistoryForProvider(history, api, { form });
          const next = [...input, user("Can you check where we run the Claude models?")];

          // Only Claude's runtime search-record form marks items. If projection
          // stops marking them, this matrix no longer guards the 2 November
          // incident and must be revisited.
          const marked = next.filter(hasSymbolMark);
          if (api === "anthropic-messages" && form === "runtime") {
            expect(marked.length).toBeGreaterThan(0);
          } else {
            expect(marked).toEqual([]);
          }

          // The history guard seeds from the prepared input, and its identity
          // ignores request-local marks: a copy that lost them (the stored row,
          // the SDK's clone) verifies against the same durable prefix.
          const guard = new HistoryPrefixGuard();
          expect(() => guard.seed(next, input.length)).not.toThrow();
          const keys = guard.verify(next);
          expect(guard.verify(JSON.parse(JSON.stringify(next)))).toEqual(keys);
          expect(guard.verify(structuredClone(next))).toEqual(keys);

          // Every prepared item crosses the protocol JSON boundary losing
          // nothing but request-local marks.
          for (const item of next) expectOnlyRequestLocalAdjustments(item);

          // The Claude wire messages encode, with every search that has
          // results replayed natively and signed thinking kept exactly.
          if (api === "anthropic-messages") {
            const claudeInput = projectModelInputForCapabilities(next, {
              supportsImageInput: true,
              inputFileMediaTypes: [],
            });
            const messages = anthropicMessages(claudeInput as never, {
              webSearch: true,
              accountScope: CLAUDE_ACCOUNT,
            });
            expect(messages.length).toBeGreaterThan(0);
            expectOnlyRequestLocalAdjustments(messages);
            const blocks = messages.flatMap((message) => message.content as Item[]);
            const searches = claudeSearchesWithResults(history);
            expect(searches.length).toBeGreaterThan(0);
            for (const id of searches) {
              expect(blocks).toContainEqual(
                expect.objectContaining({ type: "server_tool_use", id }),
              );
              expect(blocks).toContainEqual(
                expect.objectContaining({ type: "web_search_tool_result", tool_use_id: id }),
              );
            }
            if (hasClaudeThinking(history)) {
              expect(blocks).toContainEqual(
                expect.objectContaining({ type: "thinking", signature: "sig-1" }),
              );
              expect(blocks).toContainEqual({ type: "redacted_thinking", data: "REDACTED-1" });
            }
          }
        });
      }
    }

    test(`${name}: compaction's own prompt input prepares`, () => {
      const prepared = prepareCompactionPromptInput(history, 1_000_000);
      expect(prepared.input.length).toBeGreaterThan(0);
      for (const item of prepared.input) expectOnlyRequestLocalAdjustments(item);
    });
  }
});

describe("projectHistoryForProvider output", () => {
  test("every projected item crosses the protocol JSON boundary losing only request-local marks", () => {
    for (const { history, apis = APIS } of historiesToPrepare()) {
      for (const api of apis) {
        for (const searchRecordForm of [undefined, ...FORMS]) {
          const projected = projectHistoryForProvider(
            history,
            api,
            searchRecordForm ? { searchRecordForm } : {},
          );
          expect(projected.length).toBeGreaterThan(0);
          for (const item of projected) {
            expectOnlyRequestLocalAdjustments(item);
            // The JSON text an item sends is exactly what the boundary keeps.
            const normalized = normalizeProtocolJsonValue(item, "$", { onAdjustment() {} });
            expect(JSON.stringify(normalized)).toBe(JSON.stringify(item));
          }
        }
      }
    }
  });
});
