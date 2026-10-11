import { afterEach, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import {
  ANTHROPIC_COMPACTION_TEXT_ONLY_INSTRUCTION,
  ANTHROPIC_COMPACTION_THINKING_HEADROOM_TOKENS,
} from "../src/anthropic-compaction";
import { buildCompactionPromptInput, EmptyCompactionSummaryError } from "../src/context-compaction";
import { summarizeForCompaction } from "../src/index";

// Claude caches tools → system → messages, and the thinking mode, effort and
// tool choice are part of the cache key. A checkpoint request that differs in
// any of them rewrites the whole conversation instead of reading the cache.

const provider: ResolvedModelProvider = {
  id: "claude",
  label: "Claude",
  kind: "api-key",
  api: "anthropic-messages",
  wireProfile: "openai",
  builtin: false,
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "test-key",
  credentialSource: { kind: "deployment", mechanism: "api_key" },
  billing: { upstreamPayer: "deployment", metering: "external" },
};
const MODEL = "claude-opus-5-5";

const prepared: Omit<ModelRequest, "input"> = {
  systemInstructions: "Agent instructions after SDK preparation",
  modelSettings: {
    reasoning: { effort: "high" },
    providerData: { prompt_cache_key: "11111111-2222-4333-8444-555555555555" },
  },
  tools: [
    {
      type: "function",
      name: "read_file",
      description: "Read a workspace file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "run_command",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      },
      strict: true,
    },
  ],
  handoffs: [],
  outputType: "text",
  tracing: false,
};

const history = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the build" }] },
  {
    type: "reasoning",
    content: [{ type: "input_text", text: "Read the config first" }],
    providerData: {
      anthropic: {
        block: { type: "thinking", thinking: "Read the config first", signature: "sig-1" },
      },
    },
  },
  {
    type: "function_call",
    callId: "toolu_1",
    name: "read_file",
    arguments: JSON.stringify({ path: "package.json" }),
    status: "completed",
  },
  { type: "function_call_result", callId: "toolu_1", name: "read_file", output: "{}" },
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "The config is empty." }],
  },
  { type: "message", role: "user", content: [{ type: "input_text", text: "Keep going" }] },
];

const message = (content: unknown[], stop = "end_turn") => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  content,
  stop_reason: stop,
  usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
});

const withoutCacheMarkers = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function ordinaryBody(): Promise<any> {
  let body: any;
  const model = new AnthropicMessagesModel(provider, MODEL, (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(message([{ type: "text", text: "ok" }])));
  }) as typeof fetch);
  await model.getResponse({ ...prepared, input: history as ModelRequest["input"] });
  return body;
}

function captureCompaction(replies: unknown[][]): any[] {
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const content = replies[bodies.length - 1] ?? [{ type: "text", text: "unexpected" }];
    const stop = content.some((block: any) => block.type === "tool_use") ? "tool_use" : "end_turn";
    return new Response(JSON.stringify(message(content, stop)));
  }) as typeof fetch;
  return bodies;
}

const summarize = (onUsage?: () => void) =>
  summarizeForCompaction(testSettings(), buildCompactionPromptInput(history), {
    provider,
    api: "anthropic-messages",
    model: MODEL,
    maxOutputTokens: 4_000,
    preparedRequest: prepared,
    ...(onUsage ? { onUsage } : {}),
  });

test("a Claude checkpoint request keeps the ordinary request's cached prefix", async () => {
  const ordinary = await ordinaryBody();
  const bodies = captureCompaction([[{ type: "text", text: "Checkpoint summary" }]]);

  expect(await summarize()).toBe("Checkpoint summary");
  expect(bodies).toHaveLength(1);
  const compaction = bodies[0];

  expect(ordinary.tools).toHaveLength(2);
  expect(compaction.tools).toEqual(ordinary.tools);
  expect(compaction.system).toEqual(ordinary.system);
  expect(compaction.tool_choice).toEqual(ordinary.tool_choice);
  expect(compaction.output_config).toEqual(ordinary.output_config);
  const { block_binding: _binding, ...thinking } = compaction.thinking ?? {};
  expect(thinking).toEqual(ordinary.thinking);

  // Every earlier message is byte-identical; the checkpoint prompt is appended
  // to the final user turn after the content the ordinary request sent.
  const last = ordinary.messages.length - 1;
  expect(withoutCacheMarkers(compaction.messages.slice(0, last))).toEqual(
    withoutCacheMarkers(ordinary.messages.slice(0, last)),
  );
  const sent = ordinary.messages[last].content;
  expect(compaction.messages).toHaveLength(ordinary.messages.length);
  expect(withoutCacheMarkers(compaction.messages[last].content.slice(0, sent.length))).toEqual(
    withoutCacheMarkers(sent),
  );
  expect(
    compaction.messages[last].content.slice(sent.length).map((block: any) => block.text),
  ).toEqual([
    expect.stringContaining("CONTEXT CHECKPOINT COMPACTION"),
    ANTHROPIC_COMPACTION_TEXT_ONLY_INSTRUCTION,
  ]);
  // The agent thinks at high effort, so its reasoning gets room beyond the summary.
  expect(compaction.max_tokens).toBe(4_000 + ANTHROPIC_COMPACTION_THINKING_HEADROOM_TOKENS);
});

test("a checkpoint reply that calls a tool is retried once with tools disabled", async () => {
  const bodies = captureCompaction([
    [
      { type: "text", text: "Let me check one more file." },
      { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "a" } },
    ],
    [{ type: "text", text: "Checkpoint summary" }],
  ]);
  let usageEvents = 0;

  expect(await summarize(() => void usageEvents++)).toBe("Checkpoint summary");
  expect(bodies).toHaveLength(2);
  expect(bodies[0].tool_choice).toBeUndefined();
  expect(bodies[1].tool_choice).toEqual({ type: "none" });
  // Tools and instructions stay identical, so they remain cached on the retry.
  expect(bodies[1].tools).toEqual(bodies[0].tools);
  expect(bodies[1].system).toEqual(bodies[0].system);
  expect(usageEvents).toBe(2);
});

test("text beside a tool call never becomes the checkpoint", async () => {
  const toolCall = [
    { type: "text", text: "Partial thought" },
    { type: "tool_use", id: "toolu_3", name: "read_file", input: { path: "b" } },
  ];
  captureCompaction([toolCall, toolCall]);

  await expect(summarize()).rejects.toBeInstanceOf(EmptyCompactionSummaryError);
});

test("with Claude web search, the checkpoint keeps the search tool and stored searches cached", async () => {
  const search = [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [
        {
          type: "web_search_result",
          url: "https://example.com",
          title: "T",
          encrypted_content: "E",
        },
      ],
    },
  ];
  const searchedHistory = [
    ...history.slice(0, -1),
    {
      type: "hosted_tool_call",
      name: "web_search_call",
      status: "completed",
      providerData: {
        type: "web_search_call",
        call_id: "srvtoolu_1",
        action: { type: "search", query: "q" },
        anthropic: { blocks: search },
      },
    },
    history.at(-1)!,
  ];
  const withSearch = {
    ...prepared,
    tools: [
      ...prepared.tools,
      { type: "hosted_tool" as const, name: "web_search", providerData: { type: "web_search" } },
    ],
  };
  let ordinary: any;
  await new AnthropicMessagesModel(provider, MODEL, (async (_url, init) => {
    ordinary = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(message([{ type: "text", text: "ok" }])));
  }) as typeof fetch).getResponse({
    ...withSearch,
    input: searchedHistory as ModelRequest["input"],
  });
  expect(ordinary.tools.at(-1)).toMatchObject({ type: "web_search_20250305", name: "web_search" });
  expect(JSON.stringify(ordinary.messages)).toContain("server_tool_use");

  // A checkpoint reply that searched is a tool call too: retried tool-free.
  const bodies = captureCompaction([
    [...search, { type: "text", text: "Looked it up." }],
    [{ type: "text", text: "Checkpoint summary" }],
  ]);
  const summary = await summarizeForCompaction(
    testSettings(),
    buildCompactionPromptInput(searchedHistory as any),
    {
      provider,
      api: "anthropic-messages",
      model: MODEL,
      maxOutputTokens: 4_000,
      preparedRequest: withSearch,
    },
  );
  expect(summary).toBe("Checkpoint summary");
  expect(bodies).toHaveLength(2);
  expect(bodies[1].tool_choice).toEqual({ type: "none" });
  for (const body of bodies) {
    expect(body.tools).toEqual(ordinary.tools);
    expect(body.system).toEqual(ordinary.system);
    const last = ordinary.messages.length - 1;
    expect(withoutCacheMarkers(body.messages.slice(0, last))).toEqual(
      withoutCacheMarkers(ordinary.messages.slice(0, last)),
    );
  }
});
