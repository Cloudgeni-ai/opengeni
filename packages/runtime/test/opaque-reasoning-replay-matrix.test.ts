import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ModelRequest } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import { canonicalizePersistedHistoryItem } from "@opengeni/codex";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  AnthropicMessagesModel,
  CLAUDE_REASONING_REPLAY_REJECTED,
  claudeReplayScope,
} from "../src/anthropic-messages";
import { AnthropicRequestError } from "../src/anthropic-request-error";
import { COMPACTION_SUMMARY_MARKER } from "../src/context-compaction";
import { sanitizeHistoryItemsForModel } from "../src/history-sanitizer";
import { modelRequestPolicyForProvider } from "../src/model-provider-request-policy";
import { OpenGeniResponsesModel } from "../src/model-provider-routing";
import { clearRefusedOpaqueReasoning } from "../src/opaque-reasoning-replay";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";

/**
 * Opaque reasoning (Claude's signed thinking, OpenAI's encrypted content) is
 * replayed natively only under the binding it was issued with, on every route
 * and across every switch a chat can make. Claude here is simulated with the
 * documented binding: a signature verifies only for the platform, account and
 * model that issued it, and for a prefix-bound model (Opus 5.5) under the same
 * system prompt. Anything else is refused with the 400 production chat
 * ae0245f3 hit on 10 November 2026.
 *
 * Claude transports: the Anthropic API with a key, a Claude subscription
 * (OAuth), and an Anthropic-compatible gateway. Opengeni has no native Bedrock
 * or Vertex Claude transport: Bedrock Claude runs through a Chat gateway that
 * never replays signed thinking (see provider-history-adapter).
 */

/** The production 400, naming the refused block's position as Claude does. */
const rejection = (at = "messages.7.content.0") => ({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: `${at}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block" (requires anthropic-beta thinking-binding-controls-2026-08-01). The \`system\` prompt differs from the one this block was created with.`,
  },
});
const HISTORICAL = "[Historical reasoning from another model]\\n";

const SKILLS = "Opengeni instructions.\n\n## Skills\n- documents\n\n## Repository skills\n";
const BASE_SYSTEM = `${SKILLS}- {"id":"repository:.agents/skills/release/SKILL.md"}`;
/** The ae0245f3 change: a turn added a repository Skill, so the next lists it. */
const WITH_NEW_SKILL = `${BASE_SYSTEM}\n- {"id":"repository:.claude/skills/opengeni/SKILL.md"}`;
/** A restored sandbox: the turn before ran while the workspace was unreachable. */
const WORKSPACE_UNREACHABLE = `${SKILLS}Repository skills could not be indexed because the workspace was unreachable when this run started.`;

const PREFIX_BOUND = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

type Transport = "api-key" | "subscription" | "gateway";
type Endpoint = { transport: Transport; account: string };
const API: Endpoint = { transport: "api-key", account: "a" };
const API_OTHER_KEY: Endpoint = { transport: "api-key", account: "b" };
const SUBSCRIPTION: Endpoint = { transport: "subscription", account: "a" };
const GATEWAY: Endpoint = { transport: "gateway", account: "a" };
const ENDPOINTS = { API, SUBSCRIPTION, GATEWAY };

function claudeProvider({ transport, account }: Endpoint): ResolvedModelProvider {
  return {
    id: `claude-${transport}-${account}`,
    label: "Claude",
    kind: transport === "subscription" ? "claude-subscription-workspace" : "anthropic-workspace",
    api: "anthropic-messages",
    wireProfile: "openai",
    builtin: false,
    baseUrl:
      transport === "gateway" ? "https://gateway.example.test/v1" : "https://api.anthropic.com/v1",
    apiKey: `${transport}-credential-${account}`,
    credentialSource: { kind: "deployment", mechanism: "api_key" },
    billing: { upstreamPayer: "deployment", metering: "external" },
    anthropic: {
      auth: transport === "subscription" ? "oauth" : "api-key",
      cacheTtl: "5m",
      maxOutputTokens: 32000,
      streamIdleTimeoutMs: 600000,
      ...(transport === "subscription"
        ? {
            identity: {
              accountUuid: `10000000-0000-4000-8000-00000000000${account === "a" ? 1 : 2}`,
              deviceId: "a".repeat(64),
            },
          }
        : {}),
    },
  } as ResolvedModelProvider;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * What a signature binds: platform and credential, model, and for a
 * prefix-bound model the system prompt, the tools and every message before
 * the block, without thinking blocks (see `boundPrefix`).
 */
function signature(issuer: string, model: string, system: string, prefix = ""): string {
  const bound =
    PREFIX_BOUND.has(model) && system !== INPUT_INDEPENDENT ? `${system}\0${prefix}` : "";
  return `sig-${digest(issuer).slice(0, 4)}${digest(model).slice(0, 4)}${digest(bound)}`;
}
/** Marks the platform, account and model part of a signature only. */
const INPUT_INDEPENDENT = "\0";

/**
 * The tools and the messages before `messages[m].content[c]`, as Claude
 * checks them. Thinking blocks are not part of it (so a dropped block changes
 * nothing, but thinking replayed as text does), and neither are cache markers.
 */
function boundPrefix(body: any, m: number, c: number): string {
  const unmarked = ({ cache_control: _marker, ...block }: any) => block;
  const messages = [
    ...body.messages.slice(0, m),
    {
      role: body.messages[m]?.role ?? "assistant",
      content: body.messages[m]?.content ?? [],
    },
  ].map((message: any, index: number) => ({
    role: message.role,
    content: (index === m ? message.content.slice(0, c) : message.content)
      .filter((block: any) => block.type !== "thinking" && block.type !== "redacted_thinking")
      .map(unmarked),
  }));
  return JSON.stringify({ tools: (body.tools ?? []).map(unmarked), messages });
}

/** Claude's reason for dropping a block: the part of its binding that failed first. */
function dropReason(secret: string, issuer: string, model: string): string {
  if (!secret.startsWith(`sig-${digest(issuer).slice(0, 4)}`))
    return "organization_binding_mismatch";
  if (secret.slice(8, 12) !== digest(model).slice(0, 4)) return "model_binding_mismatch";
  return "prefix_binding_mismatch";
}

type Drop = { type: "thinking_dropped"; path: string; reason: string };

const issuerOf = (provider: ResolvedModelProvider) =>
  `${new URL(provider.baseUrl!).host}|${provider.apiKey}`;

type Sent = { body: any; betas: string[]; refused: boolean; dropped: Drop[] };

/** Simulated Claude platforms behind every endpoint above. */
function claudePlatform(options: {
  streamed: boolean;
  honorsDropBlock?: boolean;
  /** Report drops without the `path` of each dropped block. */
  omitsDropPaths?: boolean;
  /** Refuse every replayed thinking block, valid or not. */
  refusesAllThinking?: boolean;
  /** Name the last refused block instead of the first. */
  namesLastRefused?: boolean;
}) {
  const sent: Sent[] = [];
  let issued = 0;
  const fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    const betas = (headers.get("anthropic-beta") ?? "").split(",");
    const credential =
      headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "");
    const issuer = `${new URL(String(url)).host}|${credential}`;
    // A subscription's per-request billing block is not part of the binding.
    const system = (body.system ?? [])
      .map((block: any) => block.text)
      .filter((text: string) => !text.startsWith("x-anthropic-billing-header"))
      .join("\n\n");
    const expected = (m: number, c: number) =>
      signature(issuer, body.model, system, boundPrefix(body, m, c));
    const bindingControls = betas.includes("thinking-binding-controls-2026-08-01");
    // Claude drops a block whose prefix no longer matches and every thinking
    // block after it; a block the model or account cannot read is dropped on
    // its own. Each one is listed in `input_transformations`.
    const dropsMismatched =
      options.honorsDropBlock === true &&
      body.thinking?.block_binding?.prefix_mismatch_behavior === "drop_block" &&
      bindingControls;
    // The reply in progress (after the last message the person wrote, not a
    // tool result) is checked only for platform, account and model: a new
    // chat's first request carries a one-shot system addition, and Claude
    // accepts that turn's thinking on its later requests.
    let lastUser = -1;
    body.messages.forEach((message: any, m: number) => {
      if (
        message.role === "user" &&
        message.content.some((block: any) => block.type !== "tool_result")
      )
        lastUser = m;
    });
    const inProgress = signature(issuer, body.model, INPUT_INDEPENDENT);
    let at: string | undefined;
    const dropped: Drop[] = [];
    let cascading = false;
    body.messages.forEach((message: any, m: number) =>
      message.content.forEach((block: any, c: number) => {
        const secret =
          block.type === "thinking"
            ? block.signature
            : block.type === "redacted_thinking"
              ? block.data
              : undefined;
        const path = `messages.${m}.content.${c}`;
        if (secret === undefined || (at && !options.namesLastRefused)) return;
        if (cascading) {
          dropped.push({
            type: "thinking_dropped",
            path,
            reason: "prefix_binding_mismatch",
          });
          return;
        }
        const valid =
          secret === expected(m, c) || (m > lastUser && secret.startsWith(inProgress.slice(0, 12)));
        if (options.refusesAllThinking || !valid) {
          if (dropsMismatched && !options.refusesAllThinking) {
            const reason = dropReason(secret, issuer, body.model);
            dropped.push({ type: "thinking_dropped", path, reason });
            cascading = reason === "prefix_binding_mismatch";
          } else at = path;
        }
      }),
    );
    const refused = at !== undefined;
    sent.push({ body, betas, refused, dropped });
    if (refused) return Response.json(rejection(at), { status: 400 });
    issued += 1;
    const content = [
      {
        type: "thinking",
        thinking: `Reasoning ${issued}.`,
        signature: expected(body.messages.length, 0),
      },
      { type: "text", text: `Answer ${issued}.` },
    ];
    const message = {
      id: `msg_${issued}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      ...(bindingControls
        ? {
            input_transformations: options.omitsDropPaths
              ? dropped.map(({ path: _path, ...entry }) => entry)
              : dropped,
          }
        : {}),
    };
    if (!options.streamed) return Response.json(message, { headers: { "request-id": "req_ok" } });
    const frames = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      ...content.flatMap((block, index) => [
        { type: "content_block_start", index, content_block: block },
        { type: "content_block_stop", index },
      ]),
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(""), {
      headers: { "content-type": "text/event-stream", "request-id": "req_ok" },
    });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

type Item = Record<string, any>;

const lookupTool = {
  type: "function",
  name: "lookup",
  description: "Look something up.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  strict: false,
};

function request(input: Item[], systemInstructions: string): ModelRequest {
  return {
    input: input as ModelRequest["input"],
    systemInstructions,
    modelSettings: { reasoning: { effort: "high" } },
    tools: [],
    handoffs: [],
    outputType: "text",
    tracing: false,
  };
}

async function run(
  model: { getResponse: Function; getStreamedResponse: Function },
  modelRequest: ModelRequest,
  streamed: boolean,
): Promise<Item[]> {
  // The Responses transport records spans, so every call runs inside a trace.
  return await getOrCreateTrace(async () => {
    if (!streamed) return (await model.getResponse(modelRequest)).output;
    const output: Item[] = [];
    for await (const event of model.getStreamedResponse(modelRequest))
      if (event.type === "response_done") output.push(...event.response.output);
    return output;
  });
}

/** Output as the worker stores it and loads it for the next turn. */
function persisted(output: Item[]): Item[] {
  return sanitizeHistoryItemsForModel(
    JSON.parse(JSON.stringify(output)).map(canonicalizePersistedHistoryItem),
  ) as Item[];
}

const user = (content: string) => ({ type: "message", role: "user", content });
const thinkingBlocks = (body: any): Item[] =>
  body.messages.flatMap((message: any) =>
    message.content.filter((block: any) => block.type === "thinking"),
  );
const reasoningBlock = (output: Item[]) =>
  output.find((item) => item.type === "reasoning")!.providerData.anthropic.block;

type Leg = {
  endpoint: Endpoint;
  model: string;
  system: string;
  tools?: ModelRequest["tools"];
};

beforeEach(() => clearRefusedOpaqueReasoning());
afterAll(() => clearRefusedOpaqueReasoning());

describe("Claude to Claude: every switch a chat can make", () => {
  const rows: Array<[string, Leg, Leg, "native" | "readable"]> = [];
  for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
    const same = { endpoint, model: "claude-opus-5-5", system: BASE_SYSTEM };
    rows.push(
      [`${name}: an unchanged binding keeps thinking native`, same, same, "native"],
      [
        `${name}: a repository Skill added mid-chat changes the system prompt (ae0245f3)`,
        same,
        { ...same, system: WITH_NEW_SKILL },
        "readable",
      ],
      [
        `${name}: a restored sandbox changes the Repository skills section`,
        { ...same, system: WORKSPACE_UNREACHABLE },
        same,
        "readable",
      ],
      [`${name}: a model switch`, { ...same, model: "claude-sonnet-5-5" }, same, "readable"],
      [
        `${name}: the tools changed since (an integration connected)`,
        same,
        { ...same, tools: [lookupTool] as ModelRequest["tools"] },
        "readable",
      ],
    );
  }
  const opus55 = (endpoint: Endpoint, system = BASE_SYSTEM) => ({
    endpoint,
    model: "claude-opus-5-5",
    system,
  });
  rows.push(
    ["account switch: another API key", opus55(API), opus55(API_OTHER_KEY), "readable"],
    [
      "account switch: Claude subscription to API key",
      opus55(SUBSCRIPTION),
      opus55(API),
      "readable",
    ],
    [
      "account switch: API key to Claude subscription",
      opus55(API),
      opus55(SUBSCRIPTION),
      "readable",
    ],
    ["transport switch: Anthropic API to a gateway", opus55(API), opus55(GATEWAY), "readable"],
    [
      "a model whose thinking is not prefix-bound keeps it across a system prompt change",
      { endpoint: API, model: "claude-opus-4-6", system: BASE_SYSTEM },
      { endpoint: API, model: "claude-opus-4-6", system: WITH_NEW_SKILL },
      "native",
    ],
  );

  for (const honorsDropBlock of [false, true])
    for (const streamed of [false, true])
      for (const [label, first, second, expected] of rows)
        test(`${label} (stream=${streamed}${honorsDropBlock ? ", drop_block honored" : ""})`, async () => {
          const platform = claudePlatform({ streamed, honorsDropBlock });
          const model = (leg: Leg) =>
            new AnthropicMessagesModel(claudeProvider(leg.endpoint), leg.model, platform.fetch);
          const legRequest = (input: Item[], leg: Leg) => ({
            ...request(input, leg.system),
            tools: leg.tools ?? [],
          });
          const opening = [user("Add a delete action for the agent.")];
          const earlier = await run(model(first), legRequest(opening, first), streamed);
          const history = [
            ...opening,
            ...persisted(earlier),
            user("Okay, and we added the delete action? And what did we decide on approvals?"),
          ];
          const canonical = JSON.stringify(history);

          const later = await run(model(second), legRequest(history, second), streamed);

          // Never refused: no failed request, no retry, and nothing for Claude to drop.
          expect(platform.sent.map(({ refused }) => refused)).toEqual([false, false]);
          expect(platform.sent.flatMap(({ dropped }) => dropped)).toEqual([]);
          expect(JSON.stringify(later)).toContain("Answer 2.");
          const body = platform.sent[1]!.body;
          const block = reasoningBlock(earlier);
          if (expected === "native") {
            expect(thinkingBlocks(body)).toEqual([block]);
          } else {
            expect(thinkingBlocks(body)).toEqual([]);
            expect(JSON.stringify(body)).not.toContain(block.signature);
            expect(JSON.stringify(body.messages)).toContain(`${HISTORICAL}Reasoning 1.`);
          }
          // Nothing reaches the wire that the provider did not issue.
          expect(JSON.stringify(body)).not.toContain("opengeni.artifact_origin");
          // Canonical history is untouched: a switch back replays it natively.
          expect(JSON.stringify(history)).toBe(canonical);
        });

  for (const streamed of [false, true])
    test(`switching back to the issuing binding replays the earlier thinking natively (stream=${streamed})`, async () => {
      const platform = claudePlatform({ streamed });
      const opus = new AnthropicMessagesModel(
        claudeProvider(API),
        "claude-opus-5-5",
        platform.fetch,
      );
      const sonnet = new AnthropicMessagesModel(
        claudeProvider(API),
        "claude-sonnet-5-5",
        platform.fetch,
      );
      const first = await run(opus, request([user("One")], BASE_SYSTEM), streamed);
      const history = [user("One"), ...persisted(first), user("Two")];
      const second = await run(sonnet, request(history, BASE_SYSTEM), streamed);
      history.push(...persisted(second), user("Three"));
      await run(opus, request(history, BASE_SYSTEM), streamed);
      expect(platform.sent.map(({ refused }) => refused)).toEqual([false, false, false]);
      expect(thinkingBlocks(platform.sent[2]!.body)).toEqual([reasoningBlock(first)]);
    });
});

describe("history stored before bindings were recorded (the exact ae0245f3 state)", () => {
  for (const streamed of [false, true])
    for (const [name, endpoint] of Object.entries(ENDPOINTS))
      test(`${name}: one refusal, one retry with the stale thinking as text, then straight through (stream=${streamed})`, async () => {
        const platform = claudePlatform({ streamed });
        const provider = claudeProvider(endpoint);
        const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", platform.fetch);
        // Signed under the earlier system prompt by build 6327db2c: no binding recorded.
        const stale = {
          type: "thinking",
          thinking: "The delete action belongs in the agent tools.",
          signature: signature(issuerOf(provider), "claude-opus-5-5", BASE_SYSTEM),
        };
        const history: Item[] = [
          user("Add a delete action for the agent."),
          {
            type: "reasoning",
            content: [{ type: "input_text", text: stale.thinking }],
            providerData: { anthropic: { block: stale } },
          },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Added the delete action." }],
          },
          user("Okay, and we added the delete action? And what did we decide on approvals?"),
        ];
        const canonical = JSON.stringify(history);

        const output = await run(model, request(history, WITH_NEW_SKILL), streamed);

        expect(JSON.stringify(output)).toContain("Answer 1.");
        expect(platform.sent.map(({ refused }) => refused)).toEqual([true, false]);
        expect(thinkingBlocks(platform.sent[0]!.body)).toEqual([stale]);
        const retry = platform.sent[1]!.body;
        expect(thinkingBlocks(retry)).toEqual([]);
        expect(JSON.stringify(retry)).not.toContain(stale.signature);
        expect(JSON.stringify(retry.messages)).toContain(
          `${HISTORICAL}The delete action belongs in the agent tools.`,
        );
        expect(JSON.stringify(history)).toBe(canonical);

        // The next turn goes straight through; the thinking issued since stays native.
        history.push(...persisted(output), user("Thanks"));
        await run(model, request(history, WITH_NEW_SKILL), streamed);
        expect(platform.sent.map(({ refused }) => refused)).toEqual([true, false, false]);
        expect(thinkingBlocks(platform.sent[2]!.body)).toEqual([reasoningBlock(output)]);
      });
});

describe("Claude drops a stale block itself (drop_block on the direct API)", () => {
  const tools = [lookupTool] as ModelRequest["tools"];
  /** Signed under the earlier system prompt by an earlier build: no binding recorded. */
  const legacyHistory = (provider: ResolvedModelProvider): Item[] => {
    const stale = {
      type: "thinking",
      thinking: "The delete action belongs in the agent tools.",
      signature: signature(issuerOf(provider), "claude-opus-5-5", BASE_SYSTEM),
    };
    return [
      user("Add a delete action for the agent."),
      {
        type: "reasoning",
        content: [{ type: "input_text", text: stale.thinking }],
        providerData: { anthropic: { block: stale } },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Added the delete action." }],
      },
      user("Okay, and we added the delete action?"),
    ];
  };
  const drops = (platform: { sent: Sent[] }) => platform.sent.map(({ dropped }) => dropped.length);

  for (const streamed of [false, true])
    for (const [name, endpoint] of Object.entries(ENDPOINTS))
      for (const next of ["the next turn", "the same turn's tool loop"] as const)
        test(`${name}: dropped once, then sent as text until it converges, in ${next} (stream=${streamed})`, async () => {
          const platform = claudePlatform({ streamed, honorsDropBlock: true });
          const provider = claudeProvider(endpoint);
          const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", platform.fetch);
          const history = legacyHistory(provider);
          const send = async () =>
            run(model, { ...request(history, WITH_NEW_SKILL), tools }, streamed);

          const first = await send();
          // Claude drops the stale block itself: the request succeeds.
          expect(platform.sent.map(({ refused }) => refused)).toEqual([false]);
          expect(platform.sent[0]!.dropped).toEqual([
            {
              type: "thinking_dropped",
              path: "messages.1.content.0",
              reason: "prefix_binding_mismatch",
            },
          ]);

          history.push(
            ...persisted(first),
            ...(next === "the next turn"
              ? [user("Thanks. Now the approvals?")]
              : [
                  {
                    type: "function_call",
                    callId: "call_1",
                    name: "lookup",
                    arguments: "{}",
                  },
                  {
                    type: "function_call_result",
                    callId: "call_1",
                    output: "found",
                  },
                ]),
          );
          const second = await send();
          // The stale block goes back as text, and so does the thinking Claude
          // signed while it was dropped: there is nothing left to drop.
          expect(drops(platform)).toEqual([1, 0]);
          const body = platform.sent[1]!.body;
          expect(thinkingBlocks(body)).toEqual([]);
          for (const thought of ["The delete action belongs in the agent tools.", "Reasoning 1."])
            expect(JSON.stringify(body.messages)).toContain(`${HISTORICAL}${thought}`);

          // Thinking signed with the text in place stays native from then on.
          history.push(...persisted(second), user("And the delete confirmation?"));
          await send();
          expect(drops(platform)).toEqual([1, 0, 0]);
          expect(platform.sent.map(({ refused }) => refused)).toEqual([false, false, false]);
          expect(thinkingBlocks(platform.sent[2]!.body)).toEqual([reasoningBlock(second)]);
        });

  test("Claude's drops are counted for operators, never shown to the person", async () => {
    const platform = claudePlatform({ streamed: false, honorsDropBlock: true });
    const provider = claudeProvider(API);
    const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", platform.fetch);
    const response = await model.getResponse(request(legacyHistory(provider), WITH_NEW_SKILL));
    expect(response.providerData?.anthropic?.thinkingBlocksDropped).toEqual({
      prefix_binding_mismatch: 1,
    });
    expect(JSON.stringify(response.output)).not.toContain("thinking_dropped");
  });

  for (const streamed of [false, true])
    test(`tools that change within a turn keep that turn's thinking native until the turn ends (stream=${streamed})`, async () => {
      const platform = claudePlatform({ streamed, honorsDropBlock: true });
      const model = new AnthropicMessagesModel(
        claudeProvider(API),
        "claude-opus-5-5",
        platform.fetch,
      );
      const first = await run(model, request([user("Look it up.")], BASE_SYSTEM), streamed);
      // An integration connects: the same turn continues with more tools.
      // (The simulator, like production evidence for the system prompt,
      // accepts the reply in progress; a drop of it would be learned.)
      const loop = [
        user("Look it up."),
        ...persisted(first),
        { type: "function_call", callId: "call_1", name: "lookup", arguments: "{}" },
        { type: "function_call_result", callId: "call_1", output: "found" },
      ];
      const second = await run(model, { ...request(loop, BASE_SYSTEM), tools }, streamed);
      expect(thinkingBlocks(platform.sent[1]!.body)).toEqual([reasoningBlock(first)]);

      // The next turn has the new tools: the earlier turn's thinking, issued
      // before the tool arrived, goes back as text, with nothing to drop.
      const next = [...loop, ...persisted(second), user("Next.")];
      await run(model, { ...request(next, BASE_SYSTEM), tools }, streamed);
      expect(platform.sent.map(({ refused }) => refused)).toEqual([false, false, false]);
      expect(drops(platform)).toEqual([0, 0, 0]);
      expect(thinkingBlocks(platform.sent[2]!.body)).toEqual([]);
    });

  test("thinking before the block Claude dropped stays native", async () => {
    const platform = claudePlatform({ streamed: false, honorsDropBlock: true });
    const model = new AnthropicMessagesModel(
      claudeProvider(API),
      "claude-opus-5-5",
      platform.fetch,
    );
    const first = await run(model, request([user("One")], BASE_SYSTEM), false);
    const history: Item[] = [
      user("One"),
      ...persisted(first),
      user("Two"),
      {
        type: "reasoning",
        content: [{ type: "input_text", text: "Stored before bindings." }],
        providerData: {
          anthropic: {
            block: {
              type: "thinking",
              thinking: "Stored before bindings.",
              signature: signature(issuerOf(claudeProvider(API)), "claude-opus-5-5", "Old system"),
            },
          },
        },
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ok." }] },
      user("Three"),
    ];
    const second = await run(model, request(history, BASE_SYSTEM), false);
    expect(drops(platform)).toEqual([0, 1]);
    history.push(...persisted(second), user("Four"));
    await run(model, request(history, BASE_SYSTEM), false);
    expect(drops(platform)).toEqual([0, 1, 0]);
    expect(thinkingBlocks(platform.sent[2]!.body)).toEqual([reasoningBlock(first)]);
  });

  test("a block the model cannot read is dropped on its own and nothing is learned", async () => {
    const platform = claudePlatform({ streamed: false, honorsDropBlock: true });
    const provider = claudeProvider(API);
    const model = new AnthropicMessagesModel(provider, "claude-sonnet-5-5", platform.fetch);
    // Opus 5.5 thinking stored before bindings were recorded; Sonnet 5.5 cannot read it.
    const history = legacyHistory(provider);
    const first = await run(model, request(history, BASE_SYSTEM), false);
    expect(platform.sent[0]!.dropped.map(({ reason }) => reason)).toEqual([
      "model_binding_mismatch",
    ]);
    history.push(...persisted(first), user("Thanks."));
    await run(model, request(history, BASE_SYSTEM), false);
    // Not an edit: Claude keeps dropping only that block, and the thinking
    // after it stays native and valid.
    expect(drops(platform)).toEqual([1, 1]);
    expect(thinkingBlocks(platform.sent[1]!.body)).toEqual([
      history[1]!.providerData.anthropic.block,
      reasoningBlock(first),
    ]);
  });

  test("a drop is learned even when the response itself is not kept", async () => {
    const provider = claudeProvider(API);
    const bodies: any[] = [];
    const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async (
      _url: unknown,
      init?: RequestInit,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: `msg_${bodies.length}`,
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: "refusal",
        usage: { input_tokens: 1, output_tokens: 1 },
        input_transformations:
          bodies.length === 1
            ? [
                {
                  type: "thinking_dropped",
                  path: "messages.1.content.0",
                  reason: "prefix_binding_mismatch",
                },
              ]
            : [],
      });
    }) as typeof globalThis.fetch);
    const history = legacyHistory(provider);
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(model.getResponse(request(history, WITH_NEW_SKILL))).rejects.toThrow();
    expect(thinkingBlocks(bodies[0])).toHaveLength(1);
    expect(thinkingBlocks(bodies[1])).toEqual([]);
  });

  test("a drop report without paths implicates the blocks sent with no recorded binding", async () => {
    const platform = claudePlatform({
      streamed: false,
      honorsDropBlock: true,
      omitsDropPaths: true,
    });
    const provider = claudeProvider(API);
    const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", platform.fetch);
    const history = legacyHistory(provider);
    const first = await run(model, request(history, WITH_NEW_SKILL), false);
    history.push(...persisted(first), user("Thanks."));
    await run(model, request(history, WITH_NEW_SKILL), false);
    expect(drops(platform)).toEqual([1, 0]);
    expect(thinkingBlocks(platform.sent[1]!.body)).toEqual([]);
  });

  test("a block bound to this very binding that Claude still drops is learned the same way", async () => {
    // A mismatch Opengeni's recorded binding does not cover: an earlier
    // message changed, so Claude drops the block.
    const platform = claudePlatform({ streamed: false, honorsDropBlock: true });
    const model = new AnthropicMessagesModel(
      claudeProvider(API),
      "claude-opus-5-5",
      platform.fetch,
    );
    const opening = [user("One")];
    const first = await run(model, request(opening, BASE_SYSTEM), false);
    const history = [user("Zero"), ...opening, ...persisted(first), user("Two")];
    const second = await run(model, request(history, BASE_SYSTEM), false);
    expect(drops(platform)).toEqual([0, 1]);
    history.push(...persisted(second), user("Three"));
    await run(model, request(history, BASE_SYSTEM), false);
    expect(drops(platform)).toEqual([0, 1, 0]);
    expect(thinkingBlocks(platform.sent[2]!.body)).toEqual([]);
    expect(JSON.stringify(platform.sent[2]!.body.messages)).toContain(`${HISTORICAL}Reasoning 1.`);
  });
});

describe("compaction", () => {
  const compacted = (block: Item): Item[] => [
    {
      type: "message",
      role: "user",
      content: "Summary of the earlier conversation.",
      [COMPACTION_SUMMARY_MARKER]: true,
    },
    user("Continue."),
    {
      type: "reasoning",
      content: [{ type: "input_text", text: block.thinking }],
      providerData: { anthropic: { block } },
    },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Continuing." }],
    },
    user("And now?"),
  ];
  const staleBlock = (provider: ResolvedModelProvider) => ({
    type: "thinking",
    thinking: "Before the checkpoint.",
    signature: signature(issuerOf(provider), "claude-opus-5-5", "the prefix before compaction"),
  });

  test("a platform that honors drop_block drops the stale block itself", async () => {
    const platform = claudePlatform({ streamed: false, honorsDropBlock: true });
    const provider = claudeProvider(API);
    const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", platform.fetch);
    await run(model, request(compacted(staleBlock(provider)), BASE_SYSTEM), false);
    expect(platform.sent.map(({ refused }) => refused)).toEqual([false]);
    expect(platform.sent[0]!.body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: "drop_block",
    });
  });

  test("a gateway that strips the binding beta still never breaks the chat", async () => {
    const platform = claudePlatform({ streamed: false, honorsDropBlock: false });
    const provider = claudeProvider(GATEWAY);
    const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", platform.fetch);
    const output = await run(model, request(compacted(staleBlock(provider)), BASE_SYSTEM), false);
    expect(JSON.stringify(output)).toContain("Answer 1.");
    expect(platform.sent.map(({ refused }) => refused)).toEqual([true, false]);
    expect(thinkingBlocks(platform.sent[1]!.body)).toEqual([]);
  });
});

describe("the fallback chain always ends in a successful request", () => {
  const signedReasoning = (thinking: string, signed: string, origin?: string): Item => ({
    type: "reasoning",
    content: [{ type: "input_text", text: thinking }],
    providerData: {
      anthropic: { block: { type: "thinking", thinking, signature: signed } },
      ...(origin ? { "opengeni.artifact_origin.v1": origin } : {}),
    },
  });

  for (const streamed of [false, true])
    test(`a turn succeeds even when every replay attempt is refused (stream=${streamed})`, async () => {
      const platform = claudePlatform({
        streamed,
        refusesAllThinking: true,
        namesLastRefused: true,
      });
      const provider = claudeProvider(API);
      const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", platform.fetch);
      // Two blocks recorded under this very binding, which Claude refuses
      // anyway (a binding it checks that Opengeni does not record), and one
      // stored before bindings were recorded.
      const scope = claudeReplayScope(
        { systemInstructions: BASE_SYSTEM },
        "claude-opus-5-5",
        provider,
      );
      const reply = (text: string) => ({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
      const history = [
        user("One"),
        signedReasoning("Bound one.", "bound-1", scope),
        reply("Ok."),
        user("Two"),
        signedReasoning("Bound two.", "bound-2", scope),
        reply("Ok."),
        user("Three"),
        signedReasoning("Stored before bindings.", "legacy-signature"),
        reply("Ok."),
        user("Four"),
      ];

      const output = await run(model, request(history, BASE_SYSTEM), streamed);

      expect(JSON.stringify(output)).toContain("Answer 1.");
      // Refused natively, refused with the named and unbound blocks as text,
      // then accepted with no opaque state at all.
      expect(platform.sent.map(({ refused }) => refused)).toEqual([true, true, false]);
      expect(thinkingBlocks(platform.sent[1]!.body).map((block) => block.signature)).toEqual([
        "bound-1",
        "bound-2",
      ]);
      const plain = platform.sent[2]!.body;
      expect(thinkingBlocks(plain)).toEqual([]);
      expect(JSON.stringify(plain)).not.toContain("signature");
      for (const thought of ["Bound one.", "Bound two.", "Stored before bindings."])
        expect(JSON.stringify(plain.messages)).toContain(`${HISTORICAL}${thought}`);
    });

  test("a refusal converts the block it names and every signed block after it", async () => {
    const platform = claudePlatform({ streamed: false, refusesAllThinking: true });
    const provider = claudeProvider(API);
    const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", platform.fetch);
    const scope = claudeReplayScope(
      { systemInstructions: BASE_SYSTEM },
      "claude-opus-5-5",
      provider,
    );
    const reply = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Ok." }],
    };
    const history = [
      user("One"),
      signedReasoning("Bound one.", "bound-1", scope),
      reply,
      user("Two"),
      signedReasoning("Bound two.", "bound-2", scope),
      reply,
      user("Three"),
    ];
    await model.getResponse(request(history, BASE_SYSTEM));
    // The refusal names the first block; the second was signed with it native
    // before it, so one retry with both as text succeeds.
    expect(platform.sent.map(({ refused }) => refused)).toEqual([true, false]);
    expect(thinkingBlocks(platform.sent[1]!.body)).toEqual([]);
    for (const thought of ["Bound one.", "Bound two."])
      expect(JSON.stringify(platform.sent[1]!.body.messages)).toContain(`${HISTORICAL}${thought}`);
  });

  test("operators see each fallback; the person sees nothing", async () => {
    const platform = claudePlatform({ streamed: false, refusesAllThinking: true });
    const model = new AnthropicMessagesModel(
      claudeProvider(API),
      "claude-opus-5-5",
      platform.fetch,
    );
    const history = [
      user("One"),
      signedReasoning("Earlier.", "legacy-signature"),
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ok." }] },
      user("Two"),
    ];
    const response = await model.getResponse(request(history, BASE_SYSTEM));
    expect(platform.sent.map(({ refused }) => refused)).toEqual([true, false]);
    expect(response.providerData?.anthropic?.thinkingBlocksDropped).toEqual({
      opengeni_refused_replay: 1,
    });
    const visible = response.output.filter((item: Item) => item.type === "message");
    expect(JSON.stringify(visible)).toBe(
      JSON.stringify([{ ...visible[0], content: [{ type: "output_text", text: "Answer 1." }] }]),
    );

    // Remembered: the next request replays it as text straight away, which is
    // the steady-state projection, not a fallback, so nothing is recorded.
    const next = await model.getResponse(request(history, BASE_SYSTEM));
    expect(platform.sent).toHaveLength(3);
    expect(next.providerData?.anthropic?.thinkingBlocksDropped).toBeUndefined();
  });

  for (const streamed of [false, true])
    test(`a refusal of stale history keeps the current tool loop's thinking native (stream=${streamed})`, async () => {
      const platform = claudePlatform({ streamed });
      const provider = claudeProvider(API);
      const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", platform.fetch);
      const stale = signedReasoning("Stale.", "legacy-signature");
      const first = await run(
        model,
        request([user("One"), stale, user("Use a tool.")], BASE_SYSTEM),
        streamed,
      );
      expect(platform.sent.map(({ refused }) => refused)).toEqual([true, false]);
      // The same turn continues: the fresh block precedes a tool call.
      const fresh = persisted(first).find((item) => item.type === "reasoning")!;
      const loop = [
        user("One"),
        stale,
        user("Use a tool."),
        fresh,
        { type: "function_call", callId: "call_1", name: "lookup", arguments: "{}" },
        { type: "function_call_result", callId: "call_1", output: "found" },
      ];
      await run(
        model,
        { ...request(loop, BASE_SYSTEM), tools: [lookupTool] as ModelRequest["tools"] },
        streamed,
      );
      expect(platform.sent.map(({ refused }) => refused)).toEqual([true, false, false]);
      expect(thinkingBlocks(platform.sent[2]!.body)).toEqual([fresh.providerData.anthropic.block]);
    });

  for (const streamed of [false, true])
    test(`a one-shot system addition on a turn's first request keeps that turn's thinking native (stream=${streamed})`, async () => {
      const platform = claudePlatform({ streamed });
      const model = new AnthropicMessagesModel(
        claudeProvider(API),
        "claude-opus-5-5",
        platform.fetch,
      );
      const withTitleDirective = `${BASE_SYSTEM} Also give this chat a title.`;
      const tools = [lookupTool] as ModelRequest["tools"];
      const first = await run(
        model,
        { ...request([user("New chat.")], withTitleDirective), tools },
        streamed,
      );
      const loop = [
        user("New chat."),
        ...persisted(first),
        { type: "function_call", callId: "call_1", name: "lookup", arguments: "{}" },
        { type: "function_call_result", callId: "call_1", output: "found" },
      ];
      const second = await run(model, { ...request(loop, BASE_SYSTEM), tools }, streamed);
      expect(platform.sent.map(({ refused }) => refused)).toEqual([false, false]);
      expect(thinkingBlocks(platform.sent[1]!.body)).toEqual([reasoningBlock(first)]);

      // On the next turn it is earlier history and follows the binding check:
      // the first block was issued under the title directive, and the turn's
      // later thinking was signed with it native before it, so both go back
      // as text rather than under a prefix Claude never signed.
      const next = [...loop, ...persisted(second), user("Next.")];
      await run(model, { ...request(next, BASE_SYSTEM), tools }, streamed);
      expect(platform.sent.map(({ refused }) => refused)).toEqual([false, false, false]);
      expect(thinkingBlocks(platform.sent[2]!.body)).toEqual([]);
      for (const thought of ["Reasoning 1.", "Reasoning 2."])
        expect(JSON.stringify(platform.sent[2]!.body.messages)).toContain(
          `${HISTORICAL}${thought}`,
        );
    });

  for (const streamed of [false, true])
    test(`machine-input turns start a turn too, as Claude sees them (stream=${streamed})`, async () => {
      const platform = claudePlatform({ streamed });
      const model = new AnthropicMessagesModel(
        claudeProvider(API),
        "claude-opus-5-5",
        platform.fetch,
      );
      const machineInput = (content: string) => ({ type: "message", role: "system", content });
      const first = await run(model, request([user("Start the work.")], BASE_SYSTEM), streamed);
      const history: Item[] = [
        user("Start the work."),
        ...persisted(first),
        machineInput("Goal continuation."),
      ];
      const second = await run(model, request(history, BASE_SYSTEM), streamed);
      history.push(...persisted(second), machineInput("Goal continuation."));
      // A repository Skill is added before the next continuation turn.
      await run(model, request(history, WITH_NEW_SKILL), streamed);
      expect(platform.sent.map(({ refused }) => refused)).toEqual([false, false, false]);
      expect(thinkingBlocks(platform.sent[1]!.body)).toEqual([reasoningBlock(first)]);
      expect(thinkingBlocks(platform.sent[2]!.body)).toEqual([]);
      for (const thought of ["Reasoning 1.", "Reasoning 2."])
        expect(JSON.stringify(platform.sent[2]!.body.messages)).toContain(
          `${HISTORICAL}${thought}`,
        );
    });

  test("redacted thinking stored before bindings follows the same chain", async () => {
    const platform = claudePlatform({ streamed: false });
    const model = new AnthropicMessagesModel(
      claudeProvider(API),
      "claude-opus-5-5",
      platform.fetch,
    );
    const history = [
      user("One"),
      {
        type: "reasoning",
        content: [],
        providerData: { anthropic: { block: { type: "redacted_thinking", data: "opaque-data" } } },
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ok." }] },
      user("Two"),
    ];
    const output = await run(model, request(history, BASE_SYSTEM), false);
    expect(JSON.stringify(output)).toContain("Answer 1.");
    expect(platform.sent.map(({ refused }) => refused)).toEqual([true, false]);
    expect(JSON.stringify(platform.sent[1]!.body)).not.toContain("opaque-data");
  });

  test("if even plain history is refused, the failure carries only the generic line", async () => {
    let calls = 0;
    const model = new AnthropicMessagesModel(claudeProvider(API), "claude-opus-5-5", (async () => {
      calls += 1;
      return Response.json(rejection("messages.1.content.0"), { status: 400 });
    }) as typeof globalThis.fetch);
    const history = [user("One"), signedReasoning("", "x"), user("Two")];
    const error = await model.getResponse(request(history, BASE_SYSTEM)).catch((e) => e);
    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(AnthropicRequestError);
    expect(error.code).toBe(CLAUDE_REASONING_REPLAY_REJECTED);
    expect(error.message).toBe("Claude request failed (HTTP 400)");
    // Operators keep the provider's own text as the diagnostic.
    expect(error.detail).toContain("Invalid `signature` in `thinking` block");
  });

  test("other 400s are not retried and keep their classification", async () => {
    let calls = 0;
    const model = new AnthropicMessagesModel(claudeProvider(API), "claude-opus-5-5", (async () => {
      calls += 1;
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "messages.1: bad" } },
        { status: 400 },
      );
    }) as typeof globalThis.fetch);
    const error = await model.getResponse(request([user("One")], BASE_SYSTEM)).catch((e) => e);
    expect(calls).toBe(1);
    expect(error.code).toBe("anthropic_http_error");
    expect(error.message).toBe("Claude request failed (HTTP 400)");
  });
});

describe("across Claude and Responses providers", () => {
  const ciphertext = "openai-ciphertext";
  function responsesProvider(id: string, sent: Item[]) {
    const provider: ResolvedModelProvider = {
      id,
      label: id,
      kind: "api-key",
      api: "responses",
      builtin: false,
      baseUrl: `https://${id}.example.test/v1`,
      apiKey: `${id}-key`,
    };
    const fetch = (async (_url, init) => {
      const body = JSON.parse(await requestBodyText(init?.body));
      sent.push(body);
      if (
        JSON.stringify(body).includes(ciphertext) &&
        id !== "openai" // only the issuer can decrypt
      )
        return Response.json(
          { error: { message: "Could not decrypt the provided encrypted_content." } },
          { status: 400 },
        );
      return Response.json({
        id: `resp_${sent.length}`,
        object: "response",
        status: "completed",
        output: [
          {
            id: `rs_${sent.length}`,
            type: "reasoning",
            summary: [{ type: "summary_text", text: "OpenAI reasoning." }],
            encrypted_content: ciphertext,
          },
          {
            id: `msg_${sent.length}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "OpenAI answer.", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof globalThis.fetch;
    const client = new ReplayableJsonOpenAI(
      { apiKey: provider.apiKey!, baseURL: provider.baseUrl, maxRetries: 0, fetch },
      { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
    );
    return new OpenGeniResponsesModel(client, "gpt-fixture", provider);
  }

  test("Claude thinking reaches a Responses provider only as readable text", async () => {
    const platform = claudePlatform({ streamed: false });
    const claude = new AnthropicMessagesModel(
      claudeProvider(API),
      "claude-opus-5-5",
      platform.fetch,
    );
    const earlier = await run(claude, request([user("One")], BASE_SYSTEM), false);
    const sent: Item[] = [];
    const openai = responsesProvider("openai", sent);
    await run(
      openai,
      request([user("One"), ...persisted(earlier), user("Two")], BASE_SYSTEM),
      false,
    );
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain(reasoningBlock(earlier).signature);
    expect(JSON.stringify(sent[0])).toContain("Reasoning 1.");
  });

  test("OpenAI encrypted reasoning reaches Claude, or another Responses provider, only as readable text", async () => {
    const sent: Item[] = [];
    const earlier = await run(
      responsesProvider("openai", sent),
      request([user("One")], BASE_SYSTEM),
      false,
    );
    const history = [user("One"), ...persisted(earlier), user("Two")];

    const platform = claudePlatform({ streamed: false });
    const claude = new AnthropicMessagesModel(
      claudeProvider(API),
      "claude-opus-5-5",
      platform.fetch,
    );
    await run(claude, request(history, BASE_SYSTEM), false);
    expect(platform.sent.map(({ refused }) => refused)).toEqual([false]);
    expect(JSON.stringify(platform.sent[0]!.body)).not.toContain(ciphertext);
    expect(JSON.stringify(platform.sent[0]!.body)).toContain("OpenAI reasoning.");

    const other: Item[] = [];
    await run(responsesProvider("azure", other), request(history, BASE_SYSTEM), false);
    expect(other).toHaveLength(1);
    expect(JSON.stringify(other[0])).not.toContain(ciphertext);
  });
});
