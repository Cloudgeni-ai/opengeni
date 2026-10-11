import { describe, expect, test } from "bun:test";
import {
  Agent,
  Runner,
  setTracingDisabled,
  webSearchTool,
  type ModelRequest,
} from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  ANTHROPIC_PAUSE_TURN_MAX_REQUESTS,
  AnthropicMessagesModel,
  anthropicResponse,
  buildAnthropicRequest,
} from "../src/anthropic-messages";
import { anthropicWebSearchQueries } from "../src/anthropic-web-search";
import { renderCompactionPromptInputForChat } from "../src/context-compaction";
import { projectHostedSearchEvidence } from "../src/hosted-search-evidence";
import { projectHistoryForProvider } from "../src/provider-history-adapter";

setTracingDisabled(true);

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

const hostedSearch = webSearchTool();
const lookupTool = {
  type: "function" as const,
  name: "lookup",
  description: "Lookup",
  parameters: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  strict: true,
};
const serializedSearch = {
  type: "hosted_tool" as const,
  name: hostedSearch.name,
  providerData: (hostedSearch as any).providerData,
};

const request = (
  input: ModelRequest["input"],
  tools: ModelRequest["tools"] = [lookupTool, serializedSearch],
): ModelRequest => ({
  input,
  systemInstructions: "Instructions",
  modelSettings: {},
  tools,
  handoffs: [],
  outputType: "text",
  tracing: false,
});

const call = {
  type: "server_tool_use",
  id: "srvtoolu_1",
  name: "web_search",
  input: { query: "opengeni release notes" },
};
const results = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_1",
  content: [
    {
      type: "web_search_result",
      url: "https://example.com/notes",
      title: "Release notes",
      encrypted_content: "ENC_PAGE_1",
      page_age: "April 1, 2026",
    },
    {
      type: "web_search_result",
      url: "https://example.org/blog",
      title: "Blog",
      encrypted_content: "ENC_PAGE_2",
    },
  ],
};
const citation = {
  type: "web_search_result_location",
  url: "https://example.com/notes",
  title: "Release notes",
  encrypted_index: "ENC_INDEX_1",
  cited_text: "Version 2 adds search.",
};
const searchedContent = [
  { type: "text", text: "I'll look that up." },
  call,
  results,
  { type: "text", text: "Version 2 adds search.", citations: [citation] },
  { type: "text", text: " Anything else?" },
];

const message = (id: string, content: unknown[], stop = "end_turn", usage: object = {}) => ({
  id,
  type: "message",
  role: "assistant",
  content,
  stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 5, ...usage },
});

/** Request blocks without cache markers, which move with the conversation end. */
function unmarked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarked);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, entry]) => [key, unmarked(entry)]),
    );
  return value;
}

function stream(events: unknown[], requestId = "req_test") {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream", "request-id": requestId } },
  );
}

/** The wire events Anthropic streams for one response with these blocks. */
function frames(id: string, content: any[], stop = "end_turn", usage: object = {}) {
  const events: unknown[] = [
    {
      type: "message_start",
      message: { ...message(id, [], null as any), usage: { input_tokens: 10 } },
    },
  ];
  for (const [index, block] of content.entries()) {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
      for (const entry of block.citations ?? [])
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "citations_delta", citation: entry },
        });
    } else if (block.type === "server_tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "server_tool_use", id: block.id, name: block.name, input: {} },
      });
      const json = JSON.stringify(block.input);
      for (const partial_json of [json.slice(0, 5), json.slice(5)])
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json },
        });
    } else events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
  }
  events.push({
    type: "message_delta",
    delta: { stop_reason: stop },
    usage: { output_tokens: 5, ...usage },
  });
  events.push({ type: "message_stop" });
  return events;
}

async function collect(model: AnthropicMessagesModel, req: ModelRequest) {
  const events: any[] = [];
  for await (const event of model.getStreamedResponse(req)) events.push(event);
  return events;
}

describe("Claude web search tool declaration", () => {
  test("the agent's hosted web search becomes Claude's server tool at its own position", () => {
    const body = buildAnthropicRequest(request("Hi"), "claude-opus-5-5", provider, false);
    expect(unmarked(body.tools)).toEqual([
      { name: "lookup", description: "Lookup", input_schema: lookupTool.parameters },
      { type: "web_search_20250305", name: "web_search" },
    ]);
    // The tools prefix is cached up to its last entry, the search tool.
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  test("no search tool is declared when the agent has no hosted web search", () => {
    const body = buildAnthropicRequest(request("Hi", [lookupTool]), "claude", provider, false);
    expect(body.tools.some((tool: any) => tool.name === "web_search")).toBe(false);
  });

  test("other hosted tools are still refused", () => {
    expect(() =>
      buildAnthropicRequest(
        request("Hi", [{ type: "hosted_tool", name: "file_search", providerData: {} } as any]),
        "claude",
        provider,
        false,
      ),
    ).toThrow("does not support the hosted_tool tool transport");
  });
});

describe("Claude web search responses", () => {
  test("a search, its results and cited text become a hosted search item and one cited answer", () => {
    const response = anthropicResponse(
      message("msg_1", searchedContent, "end_turn", {
        server_tool_use: { web_search_requests: 1 },
      }),
    );
    const [intro, search, answer] = response.output as any[];
    expect(response.output).toHaveLength(3);
    expect(intro.content[0]).toEqual({ type: "output_text", text: "I'll look that up." });
    expect(search).toMatchObject({
      type: "hosted_tool_call",
      id: "msg_1:1",
      name: "web_search_call",
      status: "completed",
      arguments: JSON.stringify({ query: "opengeni release notes" }),
      providerData: {
        type: "web_search_call",
        call_id: "srvtoolu_1",
        action: {
          type: "search",
          query: "opengeni release notes",
          sources: [
            { type: "url", url: "https://example.com/notes" },
            { type: "url", url: "https://example.org/blog" },
          ],
        },
      },
    });
    expect(search.providerData.anthropic.blocks).toEqual([call, results]);
    // Claude splits a cited answer into adjacent text blocks: they stay one
    // message, one part per block, each with its own citations.
    expect(answer.id).toBe("msg_1:3");
    expect(answer.content).toEqual([
      {
        type: "output_text",
        text: "Version 2 adds search.",
        providerData: { anthropic: { citations: [citation] } },
      },
      { type: "output_text", text: " Anything else?" },
    ]);
    expect((response.providerData as any).anthropic.webSearchRequests).toBe(1);
  });

  test("a failed search keeps its provider error code and is marked failed", () => {
    const failed = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: { type: "web_search_tool_result_error", error_code: "too_many_requests" },
    };
    const response = anthropicResponse(
      message("msg_1", [call, failed, { type: "text", text: "Search failed." }]),
    );
    expect(response.output[0]).toMatchObject({
      type: "hosted_tool_call",
      status: "failed",
      providerData: { error: { code: "too_many_requests" }, anthropic: { blocks: [call, failed] } },
    });
  });

  test("unknown server tools are refused instead of silently dropped", () => {
    expect(() =>
      anthropicResponse(
        message("msg_1", [{ type: "server_tool_use", id: "srvtoolu_x", name: "code_execution" }]),
      ),
    ).toThrow("Unsupported Claude server tool");
  });

  test("streaming assembles the query, results and citations exactly like the JSON response", async () => {
    const model = new AnthropicMessagesModel(provider, "claude", (async () =>
      stream(
        frames("msg_1", searchedContent, "end_turn", {
          server_tool_use: { web_search_requests: 1 },
        }),
      )) as typeof fetch);
    const events = await collect(model, request("Search"));
    const done = events.at(-1);
    expect(done.type).toBe("response_done");
    const expected = anthropicResponse(
      message("msg_1", searchedContent, "end_turn", {
        server_tool_use: { web_search_requests: 1 },
      }),
    );
    expect(done.response.output).toEqual(expected.output);
    expect(done.response.providerData.anthropic.webSearchRequests).toBe(1);
    expect(
      events.filter((event) => event.type === "output_text_delta").map((event) => event.itemId),
    ).toEqual(["msg_1:0", "msg_1:3", "msg_1:3"]);
  });
});

describe("Claude web search replay", () => {
  const history = (): any[] => [
    { role: "user", content: "What changed?" },
    ...anthropicResponse(message("msg_1", searchedContent)).output,
  ];

  test("the next request sends every search block and citation back exactly as received", () => {
    const body = buildAnthropicRequest(
      request([...history(), { role: "user", content: "Thanks" }]),
      "claude",
      provider,
      false,
    );
    expect(unmarked(body.messages[1])).toEqual({ role: "assistant", content: searchedContent });
  });

  test("the conversation prefix is byte-identical on every later request", () => {
    const first = buildAnthropicRequest(
      request([...history(), { role: "user", content: "Thanks" }]),
      "claude-opus-5-5",
      provider,
      false,
    );
    const later = buildAnthropicRequest(
      request([
        ...history(),
        { role: "user", content: "Thanks" },
        ...anthropicResponse(message("msg_2", [{ type: "text", text: "Welcome" }])).output,
        { role: "user", content: "One more" },
      ]),
      "claude-opus-5-5",
      provider,
      false,
    );
    expect(JSON.stringify(unmarked(later.tools))).toBe(JSON.stringify(unmarked(first.tools)));
    expect(JSON.stringify(unmarked(later.system))).toBe(JSON.stringify(unmarked(first.system)));
    expect(JSON.stringify(unmarked(later.messages.slice(0, first.messages.length)))).toBe(
      JSON.stringify(unmarked(first.messages)),
    );
  });

  test("the SDK keeps searches and citations in history and Claude receives them unchanged", async () => {
    const sent: any[] = [];
    const model = new AnthropicMessagesModel(provider, "claude", (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify(
          sent.length === 1
            ? message("msg_1", searchedContent)
            : message("msg_2", [{ type: "text", text: "Sure." }]),
        ),
      );
    }) as typeof fetch);
    const agent = new Agent({ name: "Test", model, tools: [webSearchTool()] });
    const runner = new Runner({ tracingDisabled: true });
    const first = await runner.run(agent, "What changed?");
    // The whole cited answer is the reply, not its last fragment.
    expect(first.finalOutput).toBe("Version 2 adds search. Anything else?");
    expect(first.newItems.filter((item: any) => item.type === "message_output_item")).toHaveLength(
      2,
    );
    expect(sent[0].tools).toEqual([
      { type: "web_search_20250305", name: "web_search", cache_control: expect.any(Object) },
    ]);
    await runner.run(agent, [...first.history, { role: "user", content: "Thanks" }]);
    expect(unmarked(sent[1].messages[1])).toEqual({ role: "assistant", content: searchedContent });
  });

  test("without the search tool, stored searches become readable facts with no encrypted data", () => {
    const body = buildAnthropicRequest(
      request([...history(), { role: "user", content: "Thanks" }], [lookupTool]),
      "claude",
      provider,
      false,
    );
    const wire = JSON.stringify(body.messages);
    expect(wire).not.toContain("ENC_");
    expect(wire).not.toContain("server_tool_use");
    expect(wire).not.toContain("citations");
    expect(wire).toContain("https://example.com/notes");
    expect(wire).toContain("opengeni release notes");
  });

  test("a search deferred behind our tool call continues and its late result replays natively", () => {
    const deferred = anthropicResponse(
      message(
        "msg_1",
        [call, { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "a" } }],
        "tool_use",
      ),
      undefined,
      new Map([["lookup", { name: "lookup" }]]),
    ).output;
    const toolResult = {
      type: "function_call_result",
      callId: "toolu_1",
      name: "lookup",
      status: "completed",
      output: "a result",
    };
    const resume = request([{ role: "user", content: "Go" }, ...deferred, toolResult] as any);
    const resumed = buildAnthropicRequest(resume, "claude", provider, false);
    expect(unmarked(resumed.messages[1].content[0])).toEqual(call);
    expect(resumed.messages[2].content.map((block: any) => block.type)).toEqual(["tool_result"]);

    // Claude runs the deferred search first in the next response.
    const late = anthropicResponse(
      message("msg_2", [results, { type: "text", text: "Found it." }]),
      undefined,
      undefined,
      anthropicWebSearchQueries(resume.input),
    ).output as any[];
    expect(late[0]).toMatchObject({
      type: "hosted_tool_call",
      providerData: { call_id: "srvtoolu_1", action: { query: "opengeni release notes" } },
    });
    const next = buildAnthropicRequest(
      request([
        { role: "user", content: "Go" },
        ...deferred,
        toolResult,
        ...late,
        { role: "user", content: "Thanks" },
      ] as any),
      "claude",
      provider,
      false,
    );
    expect(unmarked(next.messages[1].content[0])).toEqual(call);
    expect(unmarked(next.messages[3].content[0])).toEqual(results);
    // The resumed request is an exact prefix of the next one.
    expect(JSON.stringify(unmarked(next.messages.slice(0, 3)))).toBe(
      JSON.stringify(unmarked(resumed.messages)),
    );
  });

  test("an interrupted search and an orphaned result become inert facts, stably", () => {
    const interrupted = anthropicResponse(
      message(
        "msg_1",
        [call, { type: "tool_use", id: "toolu_1", name: "lookup", input: {} }],
        "tool_use",
      ),
      undefined,
      new Map([["lookup", { name: "lookup" }]]),
    ).output;
    const steered = [
      { role: "user", content: "Go" },
      ...interrupted,
      { type: "function_call_result", callId: "toolu_1", name: "lookup", output: "r" },
      { role: "user", content: "Actually, stop" },
    ] as any[];
    const body = buildAnthropicRequest(request(steered), "claude", provider, false);
    const wire = JSON.stringify(body.messages);
    expect(wire).not.toContain("server_tool_use");
    expect(wire).toContain("historical web search fact");
    // The same history later yields the same projection.
    const later = buildAnthropicRequest(
      request([...steered, { role: "assistant", content: "Ok" }, { role: "user", content: "Hi" }]),
      "claude",
      provider,
      false,
    );
    expect(JSON.stringify(unmarked(later.messages.slice(0, body.messages.length)))).toBe(
      JSON.stringify(unmarked(body.messages)),
    );

    // A result whose call was compacted away cannot be sent, nor its citations.
    const orphan = anthropicResponse(
      message("msg_3", [results, { type: "text", text: "Cited.", citations: [citation] }]),
    ).output;
    const compacted = buildAnthropicRequest(
      request([{ role: "user", content: "Summary" }, ...orphan, { role: "user", content: "Next" }]),
      "claude",
      provider,
      false,
    );
    const compactedWire = JSON.stringify(compacted.messages);
    expect(compactedWire).not.toContain("web_search_tool_result");
    expect(compactedWire).not.toContain("ENC_");
    expect(compactedWire).toContain("https://example.com/notes");

    // A later answer citing that earlier search loses its citations too.
    const laterCited = anthropicResponse(
      message("msg_4", [{ type: "text", text: "Still cited.", citations: [citation] }]),
    ).output;
    const afterward = buildAnthropicRequest(
      request([
        { role: "user", content: "Summary" },
        ...orphan,
        { role: "user", content: "Next" },
        ...laterCited,
        { role: "user", content: "And?" },
      ]),
      "claude",
      provider,
      false,
    );
    expect(JSON.stringify(afterward.messages)).not.toContain("citations");
    expect(JSON.stringify(afterward.messages)).toContain("Still cited.");
  });
});

describe("Claude paused search turns", () => {
  test("a paused turn is continued with its content unchanged and merged into one response", async () => {
    const sent: any[] = [];
    const model = new AnthropicMessagesModel(provider, "claude", (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify(
          sent.length === 1
            ? message("msg_1", [{ type: "text", text: "Searching." }, call], "pause_turn", {
                cache_read_input_tokens: 100,
                server_tool_use: { web_search_requests: 0 },
              })
            : message("msg_2", [results, { type: "text", text: "Done." }], "end_turn", {
                cache_read_input_tokens: 200,
                server_tool_use: { web_search_requests: 1 },
              }),
        ),
        { headers: { "request-id": `req_${sent.length}` } },
      );
    }) as typeof fetch);
    const response = await model.getResponse(request([{ role: "user", content: "Search" }]));
    expect(sent).toHaveLength(2);
    expect(sent[1].tools).toEqual(sent[0].tools);
    expect(unmarked(sent[1].messages)).toEqual([
      { role: "user", content: [{ type: "text", text: "Search" }] },
      { role: "assistant", content: [{ type: "text", text: "Searching." }, call] },
    ]);
    expect(response.output.map((item: any) => item.id)).toEqual(["msg_1:0", "msg_1:1", "msg_1:3"]);
    expect((response.output[1] as any).providerData.anthropic.blocks).toEqual([call, results]);
    // Both requests are billed; each re-sent the whole prefix, so the
    // context size is the last request's input, not the sum.
    expect(response.usage.requests).toBe(2);
    expect(response.usage.inputTokens).toBe(320);
    expect(
      response.usage.requestUsageEntries?.map((entry) => [entry.inputTokens, entry.outputTokens]),
    ).toEqual([
      [110, 5],
      [210, 5],
    ]);
    expect(response.usage.requestUsageEntries?.[1]?.inputTokensDetails).toMatchObject({
      cached_tokens: 200,
    });
    expect((response.providerData as any).anthropic.webSearchRequests).toBe(1);
    expect(response.requestId).toBe("req_2");
  });

  test("streamed continuations keep one response and the merged item ids", async () => {
    let calls = 0;
    const model = new AnthropicMessagesModel(provider, "claude", (async () => {
      calls += 1;
      return calls === 1
        ? stream(frames("msg_1", [{ type: "text", text: "Searching." }, call], "pause_turn"))
        : stream(frames("msg_2", [results, { type: "text", text: "Done." }]));
    }) as typeof fetch);
    const events = await collect(model, request([{ role: "user", content: "Search" }]));
    expect(events.filter((event) => event.type === "response_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "response_done")).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "output_text_delta").map((event) => event.itemId),
    ).toEqual(["msg_1:0", "msg_1:3"]);
    expect(events.at(-1).response.output.map((item: any) => item.id)).toEqual([
      "msg_1:0",
      "msg_1:1",
      "msg_1:3",
    ]);
  });

  test("an answer that continues across a pause streams and stays one message", async () => {
    let calls = 0;
    const model = new AnthropicMessagesModel(provider, "claude", (async () => {
      calls += 1;
      return calls === 1
        ? stream(
            frames("msg_1", [call, results, { type: "text", text: "Part one." }], "pause_turn"),
          )
        : stream(frames("msg_2", [{ type: "text", text: " Part two." }]));
    }) as typeof fetch);
    const events = await collect(model, request([{ role: "user", content: "Search" }]));
    expect(
      events.filter((event) => event.type === "output_text_delta").map((event) => event.itemId),
    ).toEqual(["msg_1:2", "msg_1:2"]);
    const output = events.at(-1).response.output;
    expect(output.map((item: any) => item.id)).toEqual(["msg_1:0", "msg_1:2"]);
    expect(output[1].content.map((part: any) => part.text)).toEqual(["Part one.", " Part two."]);
  });

  test("a single request reports no per-request entries", async () => {
    const response = anthropicResponse(message("msg_1", [{ type: "text", text: "Hi" }]));
    expect(response.usage.requests).toBe(1);
    expect(response.usage.requestUsageEntries).toBeUndefined();
  });

  test("continuations are bounded", async () => {
    let calls = 0;
    const model = new AnthropicMessagesModel(provider, "claude", (async () => {
      calls += 1;
      return new Response(
        JSON.stringify(message(`msg_${calls}`, [{ type: "text", text: "." }], "pause_turn")),
      );
    }) as typeof fetch);
    await expect(model.getResponse(request([{ role: "user", content: "Go" }]))).rejects.toThrow(
      "paused its web search",
    );
    expect(calls).toBe(ANTHROPIC_PAUSE_TURN_MAX_REQUESTS);
  });
});

describe("Claude searches outside the Claude transport", () => {
  const item = anthropicResponse(message("msg_1", [call, results])).output[0] as any;
  const cited = anthropicResponse(
    message("msg_1", [{ type: "text", text: "Cited.", citations: [citation] }]),
  ).output[0] as any;

  test("other providers receive readable search facts and plain cited text", () => {
    for (const api of ["responses", "chat"] as const) {
      const projected = projectHistoryForProvider([item, cited], api);
      const wire = JSON.stringify(projected);
      expect(wire).not.toContain("ENC_");
      expect(wire).not.toContain("anthropic");
      expect(wire).toContain("https://example.com/notes");
      expect(wire).toContain("Release notes");
      expect(wire).toContain("opengeni release notes");
    }
    // Canonical history is untouched for a later switch back to Claude.
    expect(item.providerData.anthropic.blocks).toEqual([call, results]);
    expect(projectHistoryForProvider([item, cited], "anthropic-messages")).toEqual([item, cited]);
  });

  test("the compaction transcript names the query and sources without encrypted pages", () => {
    const rendered = renderCompactionPromptInputForChat([item]);
    expect(rendered).toContain("opengeni release notes");
    expect(rendered).toContain("https://example.com/notes");
    expect(rendered).not.toContain("ENC_");
    expect(projectHostedSearchEvidence(item, { preserveAnthropicNative: true })).toBe(item);
  });
});

test("an organization that switched web search off fails with a clear, typed error", async () => {
  const model = new AnthropicMessagesModel(
    provider,
    "claude",
    (async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "web search is not enabled for this organization",
          },
        }),
        { status: 400 },
      )) as typeof fetch,
  );
  await expect(model.getResponse(request([{ role: "user", content: "Go" }]))).rejects.toMatchObject(
    {
      code: "anthropic_web_search_disabled",
      message: expect.stringContaining("Web search is turned off for this Claude organization"),
    },
  );
});
