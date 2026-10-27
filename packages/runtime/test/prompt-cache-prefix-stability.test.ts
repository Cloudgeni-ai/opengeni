import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { ResolvedModelProvider } from "@opengeni/config";
import { firstDivergentHistoryCheckpoint } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import {
  buildCompactionPromptInput,
  CompactionNeededError,
  findCompactionNeededError,
} from "../src/context-compaction";
import {
  agentPromptResourcesFor,
  buildOpenGeniAgent,
  preparedCompactionRequest,
  queuePreparedCompaction,
  runAgentStream,
  summarizeForCompaction,
  takeWithheldCompactionInput,
} from "../src/index";
import { promptCacheRequestFingerprint } from "../src/prompt-cache-fingerprint";

// Prompt-cache guardrail. A provider serves its prompt cache only for the
// longest byte-identical prefix of tools → system → history it has seen. Each
// scenario below sends consecutive requests through the real agent, input
// filters and Claude wire conversion, and asserts that the later request
// extends the earlier one: no text an earlier request sent may change.

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
const FAMILY_MARKER = "opengeni.family_disclosure.v1";
const SEARCH_MARKER = "opengeni.lazy_search.v1";

type Body = {
  tools?: unknown[];
  system?: Array<{ text?: string }>;
  messages: Array<{ role: string; content: unknown }>;
  thinking?: Record<string, unknown>;
};

const withoutCacheMarkers = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)));

const systemBlocks = (body: Body) =>
  withoutCacheMarkers(body.system ?? []).filter(
    (block) => !block.text?.startsWith("x-anthropic-billing-header:"),
  );

/** Claude caches content blocks in order; a message may grow at its end. */
const historyUnits = (body: Body) =>
  withoutCacheMarkers(body.messages).flatMap((message) =>
    (Array.isArray(message.content) ? message.content : [message.content]).map((block) => ({
      role: message.role,
      block,
    })),
  );

/** The later request must extend the earlier one byte for byte. */
function expectExtends(earlier: Body, later: Body) {
  expect(withoutCacheMarkers(later.tools)).toEqual(withoutCacheMarkers(earlier.tools));
  expect(systemBlocks(later)).toEqual(systemBlocks(earlier));
  const before = historyUnits(earlier);
  const after = historyUnits(later);
  expect(after.length).toBeGreaterThanOrEqual(before.length);
  expect(after.slice(0, before.length)).toEqual(before);
  // The production diagnostics must agree with the byte comparison.
  const first = promptCacheRequestFingerprint(earlier)!;
  const second = promptCacheRequestFingerprint(later)!;
  expect(second.tools).toBe(first.tools);
  expect(second.system).toBe(first.system);
  expect(firstDivergentHistoryCheckpoint(first, second)).toBeNull();
}

function textStream(): Response {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "msg_ok",
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(
    new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function textMessage(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_summary",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Checkpoint summary" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
    }),
  );
}

/** One agent whose ordinary requests go through the real Claude wire conversion. */
function claudeAgent(
  options: { lazy?: boolean; resources?: Parameters<typeof buildOpenGeniAgent>[1] } = {},
) {
  const bodies: Body[] = [];
  const settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    lazyToolSearchEnabled: Boolean(options.lazy),
  });
  const model = new AnthropicMessagesModel(provider, MODEL, (async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    bodies.push(JSON.parse(String(init?.body)));
    return textStream();
  }) as typeof fetch);
  const agent = buildOpenGeniAgent(settings, options.resources ?? [], {
    model,
    hostedWebSearch: false,
    ...(options.lazy ? { lazyToolTransport: "generic_dispatch" as const } : {}),
  });
  agent.modelSettings = { ...agent.modelSettings, reasoning: { effort: "high" } };
  const run = async (history: Array<Record<string, unknown>>) => {
    const stream = await runAgentStream(
      agent,
      { input: history as never, persistedHistoryCount: history.length },
      settings,
    );
    for await (const event of stream) void event;
    await stream.completed;
  };
  return { agent, bodies, run, settings };
}

const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistant = (text: string) => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const signedThinking = (signature: string) => ({
  type: "reasoning",
  content: [],
  providerData: { anthropic: { block: { type: "thinking", thinking: "", signature } } },
});

/** A browser entry call that discloses its family's tools in history. */
const familyEntry = [
  {
    type: "function_call",
    callId: "toolu_open",
    name: "interaction__browser_open",
    arguments: "{}",
    status: "completed",
    providerData: {
      [FAMILY_MARKER]: {
        version: 1,
        tools: [
          {
            type: "function",
            name: "interaction__browser_observe",
            description: "Observe",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    },
  },
  {
    type: "function_call_result",
    callId: "toolu_open",
    name: "interaction__browser_open",
    status: "completed",
    output: { type: "text", text: "{}" },
  },
];

const baseHistory = [
  user("Open the dashboard"),
  signedThinking("sig-1"),
  ...familyEntry,
  signedThinking("sig-2"),
  assistant("Opened."),
  user("Now check the numbers"),
];

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function withheldAtNextBoundary(
  harness: ReturnType<typeof claudeAgent>,
  history: Array<Record<string, unknown>>,
) {
  queuePreparedCompaction(
    harness.agent,
    new CompactionNeededError({
      trigger: "threshold",
      signalSource: "provider",
      signalTokens: 200_000,
      thresholdTokens: 150_000,
    }),
  );
  const sent = harness.bodies.length;
  const failure = await harness.run(history).then(
    () => null,
    (error: unknown) => error,
  );
  expect(findCompactionNeededError(failure)).not.toBeNull();
  // Compaction became due: the ordinary request was prepared but never sent.
  expect(harness.bodies).toHaveLength(sent);
  return takeWithheldCompactionInput(harness.agent);
}

async function checkpointBody(
  harness: ReturnType<typeof claudeAgent>,
  input: Array<Record<string, unknown>>,
): Promise<Body> {
  const bodies: Body[] = [];
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return textMessage();
  }) as typeof fetch;
  const summary = await summarizeForCompaction(
    harness.settings,
    buildCompactionPromptInput(input),
    {
      provider,
      api: "anthropic-messages",
      model: MODEL,
      maxOutputTokens: 4_000,
      preparedRequest: preparedCompactionRequest(harness.agent),
    },
  );
  expect(summary).toBe("Checkpoint summary");
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe("prompt-cache prefix stability across consecutive requests", () => {
  test("a new turn, steer or recovery attempt extends the previous request", async () => {
    const harness = claudeAgent();
    await harness.run(baseHistory);
    // A recovery attempt or a later turn rebuilds the agent and reloads
    // history from durable items; a steer appends to the last user message.
    const next = claudeAgent();
    await next.run([...baseHistory, assistant("ok"), user("Steer: only the totals")]);
    expectExtends(harness.bodies[0]!, next.bodies[0]!);
  });

  test("the checkpoint call extends the previous ordinary request", async () => {
    const harness = claudeAgent();
    await harness.run(baseHistory);
    const history = [...baseHistory, assistant("ok"), user("Continue")];
    const withheld = await withheldAtNextBoundary(harness, history);
    expect(withheld).toBeDefined();
    // The ordinary projection inserts a tool disclosure after the entry
    // call's step. Re-deriving the checkpoint history from durable items
    // lacked it, diverged there and lost the rest of the cached history.
    expect(withheld!.length).toBe(history.length + 1);
    expect(withheld!.some((item) => item.role === "developer")).toBe(true);
    expectExtends(harness.bodies[0]!, await checkpointBody(harness, withheld!));
    // One compaction consumes the withheld request.
    expect(takeWithheldCompactionInput(harness.agent)).toBeUndefined();
  });

  test("a lazily loaded tool is disclosed in history, never by rewriting tools", async () => {
    const search = [
      {
        type: "function_call",
        callId: "toolu_search",
        name: "tool_search",
        arguments: JSON.stringify({ query: "calendar" }),
        status: "completed",
        providerData: {
          [SEARCH_MARKER]: { version: 1, output: "Loaded calendar tools: calendar_list" },
        },
      },
      {
        type: "function_call_result",
        callId: "toolu_search",
        name: "tool_search",
        status: "completed",
        output: { type: "text", text: "compact search receipt" },
      },
    ];
    const history = [...baseHistory, ...search, assistant("Found it."), user("List events")];
    const harness = claudeAgent({ lazy: true });
    await harness.run(history);
    const next = claudeAgent({ lazy: true });
    await next.run([...history, assistant("ok"), user("And tomorrow?")]);
    expectExtends(harness.bodies[0]!, next.bodies[0]!);
    // The checkpoint keeps the search transcript exactly as the ordinary request sent it.
    const withheld = await withheldAtNextBoundary(next, [
      ...history,
      assistant("ok"),
      user("And tomorrow?"),
    ]);
    expectExtends(next.bodies[0]!, await checkpointBody(next, withheld!));
  });

  test("a resized image keeps identical bytes in every later request", async () => {
    const large = (
      await sharp({
        create: { width: 3072, height: 1536, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");
    const history = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is in this screenshot?" },
          { type: "input_image", image: `data:image/png;base64,${large}` },
        ],
      },
      assistant("A blank screen."),
      user("Describe the colour"),
    ];
    const harness = claudeAgent();
    await harness.run(history);
    const next = claudeAgent();
    await next.run([...history, assistant("ok"), user("And the size?")]);
    expectExtends(harness.bodies[0]!, next.bodies[0]!);
  });

  test("goal updates and workspace governance changes append instead of rewriting", async () => {
    const harness = claudeAgent();
    await harness.run(baseHistory);
    const next = claudeAgent();
    await next.run([
      ...baseHistory,
      assistant("ok"),
      {
        type: "message",
        role: "developer",
        content:
          "<opengeni_workspace_governance>\nThis is the current workspace governance and replaces earlier workspace governance blocks.\n\nAlways answer in English.\n</opengeni_workspace_governance>",
      },
      user("Goal updated: also export a CSV"),
    ]);
    expectExtends(harness.bodies[0]!, next.bodies[0]!);
  });

  test("delivering a file attachment does not change the system prompt", () => {
    const settings = testSettings({
      sandboxBackend: "docker",
      objectStorageEndpoint: "https://storage.example.test",
      objectStorageAccessKeyId: "test-access-key",
      objectStorageSecretAccessKey: "test-secret-key",
    });
    const file = { kind: "file", fileId: "11111111-1111-4111-8111-111111111111" };
    const without = buildOpenGeniAgent(settings, [], {
      agentPromptResources: agentPromptResourcesFor(settings, [], {}),
    });
    const withFile = buildOpenGeniAgent(settings, [file] as never, {
      agentPromptResources: agentPromptResourcesFor(settings, [file] as never, {}),
    });
    expect(String(withFile.instructions)).toBe(String(without.instructions));
  });
});
