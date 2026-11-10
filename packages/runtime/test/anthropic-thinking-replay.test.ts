import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  AnthropicMessagesModel,
  CLAUDE_REASONING_REPLAY_REJECTED,
} from "../src/anthropic-messages";
import { AnthropicRequestError } from "../src/anthropic-request-error";

/**
 * Production chat ae0245f3 (10 November 2026): an Opus 5.5 high turn added a
 * repository Skill, so the next turn's system prompt listed it. Every earlier
 * signed thinking block was bound to the old system prompt, and Claude refused
 * the whole request with this 400 on every Retry.
 */
const PRODUCTION_REJECTION = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. The `system` prompt differs from the one this block was created with.',
  },
};

const BASE_SYSTEM = "Opengeni instructions.\n\n## Skills\n- documents";
const SYSTEM_WITH_NEW_SKILL = `${BASE_SYSTEM}\n\n## Repository skills\n- {"id":"repository:.claude/skills/opengeni/SKILL.md","name":"opengeni"}`;

/** A signature this fake Claude binds to the system prompt it was issued under. */
const signatureFor = (system: string) =>
  `sig-${createHash("sha256").update(system).digest("hex").slice(0, 16)}`;

const identity = { accountUuid: "10000000-0000-4000-8000-000000000001", deviceId: "a".repeat(64) };
let providers = 0;
function claudeProvider(transport: "api-key" | "subscription" | "gateway"): ResolvedModelProvider {
  providers += 1;
  return {
    id: `claude-${transport}-${providers}`,
    label: "Claude",
    kind: transport === "subscription" ? "claude-subscription-workspace" : "anthropic-workspace",
    api: "anthropic-messages",
    wireProfile: "openai",
    builtin: false,
    baseUrl:
      transport === "gateway" ? "https://gateway.example.test/v1" : "https://api.anthropic.com/v1",
    apiKey: "synthetic-key",
    credentialSource: { kind: "deployment", mechanism: "api_key" },
    billing: { upstreamPayer: "deployment", metering: "external" },
    anthropic: {
      auth: transport === "subscription" ? "oauth" : "api-key",
      cacheTtl: "5m",
      maxOutputTokens: 32000,
      streamIdleTimeoutMs: 600000,
      ...(transport === "subscription" ? { identity } : {}),
    },
  } as ResolvedModelProvider;
}

const signedEarlierThinking = {
  type: "thinking",
  thinking: "The delete action belongs in the agent tools.",
  signature: signatureFor(BASE_SYSTEM),
};

/** The chat's history: an earlier Opus turn whose thinking was signed under BASE_SYSTEM. */
function laterTurn(systemInstructions: string): ModelRequest {
  return {
    input: [
      { role: "user", content: "Add a delete action for the agent." },
      {
        type: "reasoning",
        content: [{ type: "input_text", text: signedEarlierThinking.thinking }],
        providerData: { anthropic: { block: signedEarlierThinking } },
      },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Added the delete action." }],
      },
      {
        role: "user",
        content: "Okay, and we added the delete action? And what did we decide on approvals?",
      },
    ] as ModelRequest["input"],
    systemInstructions,
    modelSettings: { reasoning: { effort: "high" } },
    tools: [],
    handoffs: [],
    outputType: "text",
    tracing: false,
  };
}

type Sent = { body: any; betas: string[] };

/**
 * A Claude that verifies every replayed signature against the request's own
 * system prompt (the Anthropic billing block a subscription adds is not part
 * of the binding). A mismatched block is refused unless the request opts into
 * the binding control and `honorsDropBlock` (a gateway can strip the beta).
 */
function fakeClaude(options: {
  honorsDropBlock: boolean;
  streamed?: boolean;
  alwaysRefuse?: boolean;
}) {
  const sent: Sent[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const betas = (new Headers(init?.headers).get("anthropic-beta") ?? "").split(",");
    sent.push({ body, betas });
    const system = (body.system ?? [])
      .map((block: any) => block.text)
      .filter((text: string) => !text.startsWith("x-anthropic-billing-header"))
      .join("\n\n");
    const dropsMismatched =
      options.honorsDropBlock &&
      body.thinking?.block_binding?.prefix_mismatch_behavior === "drop_block" &&
      betas.includes("thinking-binding-controls-2026-08-01");
    let dropped = 0;
    for (const message of body.messages)
      for (const block of message.content)
        if (block.type === "thinking" && block.signature !== signatureFor(system)) {
          if (dropsMismatched && !options.alwaysRefuse) dropped += 1;
          else return Response.json(PRODUCTION_REJECTION, { status: 400 });
        }
    if (options.alwaysRefuse) return Response.json(PRODUCTION_REJECTION, { status: 400 });
    const content = [
      { type: "thinking", thinking: "Answer from the PR.", signature: signatureFor(system) },
      { type: "text", text: "Yes, the delete action is in PR #107." },
    ];
    const message = {
      id: `msg_${sent.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      ...(dropped
        ? {
            input_transformations: Array.from({ length: dropped }, () => ({
              type: "thinking_dropped",
              reason: "prefix_binding_mismatch",
            })),
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

async function run(model: AnthropicMessagesModel, request: ModelRequest, streamed: boolean) {
  if (!streamed) return (await model.getResponse(request)).output;
  const output: unknown[] = [];
  for await (const event of model.getStreamedResponse(request))
    if (event.type === "response_done") output.push(...event.response.output);
  return output;
}

const signedBlocks = (body: any) =>
  body.messages.flatMap((message: any) =>
    message.content.filter((block: any) => block.type === "thinking"),
  );
const replyText = (output: unknown[]) =>
  JSON.stringify(output.filter((item: any) => item.type === "message"));

describe("replayed Claude thinking never breaks a chat", () => {
  for (const streamed of [false, true])
    for (const transport of ["api-key", "subscription"] as const)
      test(`the ae0245f3 shape: a system prompt change after an Opus 5.5 turn (${transport}, stream=${streamed})`, async () => {
        const claude = fakeClaude({ honorsDropBlock: true, streamed });
        const model = new AnthropicMessagesModel(
          claudeProvider(transport),
          "claude-opus-5-5",
          claude.fetch,
        );
        const request = laterTurn(SYSTEM_WITH_NEW_SKILL);
        const before = JSON.stringify(request);

        const output = await run(model, request, streamed);

        expect(replyText(output)).toContain("PR #107");
        // One request: the provider drops only the stale block. The signed
        // block is still sent verbatim, never stripped or rewritten by us.
        expect(claude.sent).toHaveLength(1);
        const [{ body, betas }] = claude.sent;
        expect(body.thinking).toMatchObject({
          type: "adaptive",
          block_binding: { prefix_mismatch_behavior: "drop_block" },
        });
        expect(betas).toContain("thinking-binding-controls-2026-08-01");
        expect(signedBlocks(body)).toEqual([signedEarlierThinking]);
        expect(JSON.stringify(request)).toBe(before);
      });

  test("every thinking request opts in, so the cached thinking mode never changes mid-chat", async () => {
    const claude = fakeClaude({ honorsDropBlock: true });
    const model = new AnthropicMessagesModel(
      claudeProvider("api-key"),
      "claude-opus-5-5",
      claude.fetch,
    );
    await model.getResponse({ ...laterTurn(BASE_SYSTEM), input: "First message of a new chat" });
    await model.getResponse(laterTurn(BASE_SYSTEM));
    expect(claude.sent.map(({ body }) => body.thinking)).toEqual([
      claude.sent[0]!.body.thinking,
      claude.sent[0]!.body.thinking,
    ]);
    expect(claude.sent[0]!.body.thinking.block_binding).toBeDefined();
  });

  for (const streamed of [false, true])
    for (const [label, modelId, transport] of [
      ["a gateway that drops the binding beta", "claude-opus-5-5", "gateway"],
      ["a model without the binding control", "claude-opus-4-6", "api-key"],
      ["a Claude subscription", "claude-opus-4-6", "subscription"],
    ] as const)
      test(`${label}: the refused blocks are resent once as readable history (stream=${streamed})`, async () => {
        const claude = fakeClaude({ honorsDropBlock: false, streamed });
        const model = new AnthropicMessagesModel(claudeProvider(transport), modelId, claude.fetch);
        const request = laterTurn(SYSTEM_WITH_NEW_SKILL);
        const before = JSON.stringify(request);

        const output = await run(model, request, streamed);

        expect(replyText(output)).toContain("PR #107");
        expect(claude.sent).toHaveLength(2);
        expect(signedBlocks(claude.sent[0]!.body)).toEqual([signedEarlierThinking]);
        const retry = claude.sent[1]!.body;
        expect(signedBlocks(retry)).toEqual([]);
        expect(JSON.stringify(retry.messages)).toContain(
          "[Historical reasoning from another model]\\nThe delete action belongs in the agent tools.",
        );
        expect(JSON.stringify(retry)).not.toContain(signedEarlierThinking.signature);
        expect(JSON.stringify(request)).toBe(before);

        // The refusal is remembered for this provider: the next request of the
        // chat goes straight through, and the block issued after the retry
        // stays native.
        const fresh = output.find((item: any) => item.type === "reasoning") as any;
        const next = laterTurn(SYSTEM_WITH_NEW_SKILL);
        (next.input as unknown[]).push(fresh, { role: "user", content: "Thanks" });
        await run(model, next, streamed);
        expect(claude.sent).toHaveLength(3);
        expect(signedBlocks(claude.sent[2]!.body)).toEqual([fresh.providerData.anthropic.block]);
      });

  test("a refusal that persists ends with a short human message, never the provider text", async () => {
    const claude = fakeClaude({ honorsDropBlock: true, alwaysRefuse: true });
    const model = new AnthropicMessagesModel(
      claudeProvider("api-key"),
      "claude-opus-5-5",
      claude.fetch,
    );
    const error = await model.getResponse(laterTurn(SYSTEM_WITH_NEW_SKILL)).catch((e) => e);
    expect(claude.sent).toHaveLength(2);
    expect(error).toBeInstanceOf(AnthropicRequestError);
    expect(error.code).toBe(CLAUDE_REASONING_REPLAY_REJECTED);
    expect(error.status).toBe(400);
    expect(error.message).toBe(
      "Claude couldn't reuse earlier reasoning from this chat. Try again, or choose another model.",
    );
    expect(error.message).not.toMatch(/signature|block_binding|anthropic-beta/);
    // Operators keep the provider's own text as the diagnostic.
    expect(error.detail).toContain("Invalid `signature` in `thinking` block");
  });

  test("other 400s are not retried and keep their classification", async () => {
    let calls = 0;
    const model = new AnthropicMessagesModel(
      claudeProvider("api-key"),
      "claude-opus-5-5",
      (async () => {
        calls += 1;
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "messages.1: bad" } },
          { status: 400 },
        );
      }) as typeof globalThis.fetch,
    );
    const error = await model.getResponse(laterTurn(BASE_SYSTEM)).catch((e) => e);
    expect(calls).toBe(1);
    expect(error.code).toBe("anthropic_http_error");
    expect(error.message).toBe("Claude request failed (HTTP 400)");
  });
});
