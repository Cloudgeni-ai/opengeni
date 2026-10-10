import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import {
  ANTHROPIC_CACHE_REUSE_COMPACTION_NOTE,
  anthropicCacheReuseSummaryUsable,
  anthropicCompactionRequest,
} from "../src/anthropic-compaction";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import { buildCompactionPromptInput, COMPACTION_PROMPT } from "../src/context-compaction";
import { summarizeForCompaction } from "../src/index";

type Body = Record<string, any>;
const MODEL = "claude-opus-5-5";
const bodies: Body[] = [];
let replies: Array<"text" | "tool_use"> = [];
let server: ReturnType<typeof Bun.serve>;
let provider: ResolvedModelProvider;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      bodies.push((await req.json()) as Body);
      const kind = replies.shift() ?? "text";
      return Response.json({
        id: `msg_${bodies.length}`,
        type: "message",
        role: "assistant",
        content:
          kind === "text"
            ? [{ type: "text", text: "Checkpoint summary" }]
            : [{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }],
        stop_reason: kind === "text" ? "end_turn" : "tool_use",
        usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 5 },
      });
    },
  });
  provider = {
    id: "claude",
    label: "Claude",
    kind: "api-key",
    api: "anthropic-messages",
    wireProfile: "openai",
    builtin: false,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "test-key",
    credentialSource: { kind: "deployment", mechanism: "api_key" },
    billing: { upstreamPayer: "deployment", metering: "external" },
  };
});
afterAll(() => server.stop(true));
beforeEach(() => {
  bodies.length = 0;
  replies = [];
});

const history = [
  { type: "message", role: "user", content: "Fix the failing build" },
  {
    type: "function_call",
    callId: "call_1",
    name: "lookup",
    arguments: "{}",
    status: "completed",
  },
  { type: "function_call_result", callId: "call_1", name: "lookup", output: "build log" },
];

function turnRequest(): ModelRequest {
  return {
    input: structuredClone(history) as ModelRequest["input"],
    systemInstructions: "You are the agent.",
    modelSettings: {
      reasoning: { effort: "high" },
      maxTokens: 64_000,
      providerData: { prompt_cache_key: "session-1" },
    },
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: {} },
        strict: false,
      } as any,
    ],
    handoffs: [],
    outputType: "text",
    tracing: false,
  };
}

function prepared(): Omit<ModelRequest, "input"> {
  const { input: _input, ...prefix } = turnRequest();
  return prefix;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, entry]) => [key, strip(entry)]),
  );
}

const settings = (reuse: boolean) => ({
  ...testSettings(),
  experimentCompactionCacheReuse: reuse,
});

test("the reused checkpoint request keeps the turn prefix and only appends the instruction", async () => {
  const model = new AnthropicMessagesModel(provider, MODEL);
  await model.getResponse(turnRequest());
  const usages: unknown[] = [];
  const summary = await summarizeForCompaction(
    settings(true),
    buildCompactionPromptInput(history),
    {
      provider,
      client: {} as any,
      model: MODEL,
      maxOutputTokens: 9_000,
      promptCacheKey: "session-1",
      preparedRequest: prepared(),
      onUsage: (usage) => void usages.push(usage),
    },
  );
  expect(summary).toBe("Checkpoint summary");
  expect(bodies).toHaveLength(2);
  expect(usages).toHaveLength(1);
  const [turn, checkpoint] = bodies.map(strip) as Body[];
  for (const key of ["tools", "system", "thinking", "output_config", "tool_choice"])
    expect(checkpoint[key]).toEqual(turn[key]);
  expect(checkpoint.tools).toHaveLength(1);
  expect(checkpoint.max_tokens).toBe(9_000);
  // Every turn message is an exact prefix of the checkpoint conversation.
  const last = turn.messages.length - 1;
  expect(checkpoint.messages.slice(0, last)).toEqual(turn.messages.slice(0, last));
  const tail = checkpoint.messages[last].content;
  expect(tail.slice(0, turn.messages[last].content.length)).toEqual(turn.messages[last].content);
  expect(JSON.stringify(checkpoint.messages.slice(last))).toContain(
    ANTHROPIC_CACHE_REUSE_COMPACTION_NOTE,
  );
  // Breakpoints remain so the request can read the warm entries.
  expect(JSON.stringify(bodies[1]!.messages)).toContain("cache_control");
});

test("a tool call instead of a summary retries once with the standalone request", async () => {
  replies = ["tool_use", "text"];
  const usages: unknown[] = [];
  const summary = await summarizeForCompaction(
    settings(true),
    buildCompactionPromptInput(history),
    {
      provider,
      client: {} as any,
      model: MODEL,
      maxOutputTokens: 9_000,
      systemInstructions: "Standalone instructions",
      preparedRequest: prepared(),
      onUsage: (usage) => void usages.push(usage),
    },
  );
  expect(summary).toBe("Checkpoint summary");
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.tools).toHaveLength(1);
  expect(bodies[1]!.tools ?? []).toHaveLength(0);
  expect(JSON.stringify(bodies[1]!.system)).toContain("Standalone instructions");
  expect(usages).toHaveLength(2);
});

test("with the experiment off the prepared prefix is ignored", async () => {
  await summarizeForCompaction(settings(false), buildCompactionPromptInput(history), {
    provider,
    client: {} as any,
    model: MODEL,
    maxOutputTokens: 9_000,
    preparedRequest: prepared(),
  });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.tools ?? []).toHaveLength(0);
  expect(JSON.stringify(bodies[0]!.messages)).not.toContain(ANTHROPIC_CACHE_REUSE_COMPACTION_NOTE);
});

test("request builder keeps model settings and never marks the request portable", () => {
  const request = anthropicCompactionRequest(buildCompactionPromptInput(history), {
    maxOutputTokens: 9_000,
    promptCacheKey: "other",
    preparedRequest: { ...prepared(), previousResponseId: "resp_1" } as never,
  });
  expect(request.tools).toHaveLength(1);
  expect(request.systemInstructions).toBe("You are the agent.");
  expect(request.modelSettings.reasoning).toEqual({ effort: "high" });
  expect(request.modelSettings.maxTokens).toBe(9_000);
  expect(request.modelSettings.toolChoice).toBeUndefined();
  expect(request.modelSettings.providerData).toEqual({ prompt_cache_key: "session-1" });
  expect(request.previousResponseId).toBeUndefined();
  const last = (request.input as any[]).at(-1);
  expect(last.content).toBe(`${COMPACTION_PROMPT}\n\n${ANTHROPIC_CACHE_REUSE_COMPACTION_NOTE}`);
  expect(history).toHaveLength(3);
});

test("only text responses count as a reused-prefix summary", () => {
  const message = { type: "message", content: [{ type: "output_text", text: "Summary" }] };
  expect(anthropicCacheReuseSummaryUsable({ output: [message] })).toBe(true);
  expect(anthropicCacheReuseSummaryUsable({ output: [{ type: "reasoning" }, message] })).toBe(true);
  expect(anthropicCacheReuseSummaryUsable({ output: [message, { type: "function_call" }] })).toBe(
    false,
  );
  expect(
    anthropicCacheReuseSummaryUsable({
      output: [message],
      providerData: { anthropic: { stopReason: "tool_use" } },
    }),
  ).toBe(false);
  expect(
    anthropicCacheReuseSummaryUsable({
      output: [{ type: "message", content: [{ type: "output_text", text: " " }] }],
    }),
  ).toBe(false);
});
