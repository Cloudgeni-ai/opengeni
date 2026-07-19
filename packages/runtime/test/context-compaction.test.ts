import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  COMPACTION_PROMPT,
  COMPACTION_SUMMARY_MARKER,
  CompactionNeededError,
  CompactionProviderResponseError,
  EmptyCompactionSummaryError,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  MAX_COMPACTION_THRESHOLD_RATIO,
  MIN_COMPACTION_THRESHOLD_RATIO,
  SUMMARY_PREFIX,
  USER_MESSAGE_TRUNCATION_MARKER,
  buildCompactionPromptInput,
  buildCompactionReplacementHistory,
  buildSummaryItem,
  compactionThresholdTokens,
  clampCompactionThresholdRatio,
  decideCompaction,
  estimateCompleteModelInput,
  estimateSerializedValueTokens,
  findCompactionNeededError,
  compactionReplacementFingerprint,
  latestCompactionReplacementFingerprint,
  isCompactionSummary,
  isEphemeralInternalContext,
  isUserMessage,
  jsonSerializedLength,
  jsonSerializedUtf8ByteLength,
  renderCompactionPromptInputForChat,
  type CompactionItem,
  utf8ByteLength,
} from "../src/context-compaction";
import { extractResponseOutputText, summarizeForCompaction } from "../src/index";
import { sanitizeHistoryItemsForModel } from "../src/history-sanitizer";
import { testSettings } from "@opengeni/testing";

function user(text: string): CompactionItem {
  return { type: "message", role: "user", content: text };
}

function userParts(parts: unknown[]): CompactionItem {
  return { type: "message", role: "user", content: parts };
}

function assistant(text: string): CompactionItem {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

function call(id: string, name = "shell"): CompactionItem {
  return { type: "function_call", callId: id, name, arguments: "{}" };
}

function result(id: string, output = "ok"): CompactionItem {
  return { type: "function_call_result", callId: id, status: "completed", output };
}

function bigUser(tokens: number, char: string): CompactionItem {
  return user(char.repeat(tokens * 4));
}

const WINDOW = 1_050_000;
const RESERVED_OUTPUT = 128_000;
const THRESHOLD = Math.floor(WINDOW * DEFAULT_COMPACTION_THRESHOLD_RATIO);

describe("non-materializing plain JSON length", () => {
  test("matches JSON.stringify for persisted history shapes and escapes", () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      1.25,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "plain",
      'quotes " slash \\ controls \b\f\n\r\t\u0000',
      "unicode 🦄 café 中文",
      "lone-high-\ud800",
      "lone-low-\udfff",
      [1, undefined, "three", null],
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "x".repeat(4_096) }],
        omitted: undefined,
      },
      { nested: { array: [{ ok: true }, { value: 42 }] } },
    ];

    for (const value of values) {
      expect(jsonSerializedLength(value)).toBe(JSON.stringify(value)!.length);
      expect(jsonSerializedUtf8ByteLength(value)).toBe(
        Buffer.byteLength(JSON.stringify(value)!, "utf8"),
      );
    }
  });

  test("matches raw UTF-8 instruction and serialized descriptor token estimates", () => {
    const rawStrings = [
      "plain",
      'quotes " slash \\ controls \b\f\n\r\t\u0000',
      "unicode 🦄 café 中文",
      "lone-high-\ud800",
      "lone-low-\udfff",
    ];
    for (const value of rawStrings) {
      // TextEncoder follows the UTF-8 replacement contract for lone UTF-16
      // surrogates. Bun 1.3.14's Buffer.byteLength SIMD path undercounts these
      // by one byte on some CPUs, while Node and TextEncoder report three.
      const encodedLength = new TextEncoder().encode(value).length;
      expect(utf8ByteLength(value)).toBe(encodedLength);
      expect(estimateSerializedValueTokens(value)).toBe(Math.ceil(encodedLength / 4));
    }

    const descriptors: unknown[] = [
      { name: "shell", description: "ASCII" },
      { name: "搜索🦄", inputSchema: { type: "object", description: "café 中文" } },
      { escaped: 'quotes " slash \\ controls \u0000', lone: "\ud800" },
      [undefined, "three", null],
    ];
    for (const value of descriptors) {
      expect(estimateSerializedValueTokens(value)).toBe(
        Math.ceil(Buffer.byteLength(JSON.stringify(value)!, "utf8") / 4),
      );
    }
  });

  test("rejects values JSON.stringify cannot represent at the root", () => {
    expect(() => jsonSerializedLength(undefined)).toThrow();
    expect(() => jsonSerializedUtf8ByteLength(undefined)).toThrow();
    expect(() => jsonSerializedLength(1n)).toThrow();
    expect(() => jsonSerializedUtf8ByteLength(1n)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => jsonSerializedLength(cyclic)).toThrow();
    expect(() => jsonSerializedUtf8ByteLength(cyclic)).toThrow();
    expect(() => estimateSerializedValueTokens(undefined)).toThrow();
    expect(() => estimateSerializedValueTokens(1n)).toThrow();
    expect(() => estimateSerializedValueTokens(cyclic)).toThrow();
  });

  test("uses real JSON.stringify semantics for unusual non-persisted values", () => {
    const getter = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });
    const proxy = new Proxy({ value: 1 }, {});
    const crossRealm = runInNewContext("({ value: 1 })");
    const boxedBigInt = Object(1n);
    const hiddenToJson: Record<string, unknown> = { safe: true };
    Object.defineProperty(hiddenToJson, "toJSON", {
      value: () => ({ changed: true }),
      enumerable: false,
    });
    const arrayToJson = [1, 2];
    Object.defineProperty(arrayToJson, "toJSON", {
      value: () => [3],
      enumerable: false,
    });
    const serializableValues = [
      new Date("2026-07-18T00:00:00.000Z"),
      new Number(7),
      { toJSON: () => ({ value: 1 }) },
      hiddenToJson,
      arrayToJson,
      getter,
      proxy,
      crossRealm,
    ];
    for (const value of serializableValues) {
      expect(() => jsonSerializedLength(value)).toThrow();
      expect(() => jsonSerializedUtf8ByteLength(value)).toThrow();
      expect(estimateSerializedValueTokens(value)).toBe(
        Math.ceil(Buffer.byteLength(JSON.stringify(value)!, "utf8") / 4),
      );
    }
    expect(() => estimateSerializedValueTokens(boxedBigInt)).toThrow();
  });

  test("does not copy a wide persisted object while counting its exact JSON form", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 50_000; index += 1) {
      wide[`property_${index}`] = index;
    }
    const serialized = JSON.stringify(wide);
    expect(jsonSerializedLength(wide)).toBe(serialized.length);
    expect(jsonSerializedUtf8ByteLength(wide)).toBe(Buffer.byteLength(serialized, "utf8"));
  });

  test("counts a large custom toJSON result instead of its object tag", () => {
    const value = {
      toJSON: () => ({ text: "🦄".repeat(256 * 1024) }),
    };
    const serialized = JSON.stringify(value);
    expect(estimateSerializedValueTokens(value)).toBe(
      Math.ceil(Buffer.byteLength(serialized, "utf8") / 4),
    );
  });
});

describe("codex-parity constants and summary marker", () => {
  test("uses Codex's checkpoint prompt and summary prefix verbatim", () => {
    expect(COMPACTION_PROMPT).toBe(
      [
        "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
        "",
        "Include:",
        "- Current progress and key decisions made",
        "- Important context, constraints, or user preferences",
        "- What remains to be done (clear next steps)",
        "- Any critical data, examples, or references needed to continue",
        "",
        "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
      ].join("\n"),
    );
    expect(SUMMARY_PREFIX).toBe(
      "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:",
    );
  });

  test("buildSummaryItem preserves the OpenGeni marker for UI rendering", () => {
    const item = buildSummaryItem("handoff body");
    expect(isUserMessage(item)).toBe(true);
    expect(isCompactionSummary(item)).toBe(true);
    expect(item[COMPACTION_SUMMARY_MARKER]).toBe(true);
    expect(item.content).toBe(`${SUMMARY_PREFIX}\nhandoff body`);
  });

  test("an empty provider summary fails without manufacturing durable history", () => {
    expect(() => buildSummaryItem("   ")).toThrow(EmptyCompactionSummaryError);
  });
});

describe("single portable compaction threshold", () => {
  test("derives the trigger from the raw window independently of the effective ceiling", () => {
    expect(
      compactionThresholdTokens({
        contextWindowTokens: WINDOW,
        contextReservedOutputTokens: RESERVED_OUTPUT,
      }),
    ).toBe(THRESHOLD);
  });

  test("uses 90% of a 250k raw model window by default", () => {
    expect(
      compactionThresholdTokens({
        contextWindowTokens: 250_000,
        contextReservedOutputTokens: 128_000,
      }),
    ).toBe(225_000);
  });

  test("honors a model-catalog auto-compact limit and clamps it to 90%", () => {
    expect(
      compactionThresholdTokens({
        contextWindowTokens: 272_000,
        contextReservedOutputTokens: 128_000,
        contextAutoCompactThresholdTokens: 244_800,
      }),
    ).toBe(244_800);
    expect(
      compactionThresholdTokens({
        contextWindowTokens: 272_000,
        contextReservedOutputTokens: 128_000,
        contextAutoCompactThresholdTokens: 260_000,
      }),
    ).toBe(244_800);
  });

  test("supports an env-configurable ratio with a defensive clamp", () => {
    expect(clampCompactionThresholdRatio(0.1)).toBe(MIN_COMPACTION_THRESHOLD_RATIO);
    expect(clampCompactionThresholdRatio(2)).toBe(MAX_COMPACTION_THRESHOLD_RATIO);
    expect(
      compactionThresholdTokens({
        contextWindowTokens: 1000,
        contextReservedOutputTokens: 0,
        contextCompactionThresholdRatio: 0.75,
      }),
    ).toBe(750);
  });

  test("never lets a stale provider count hide larger active history", () => {
    const items = [bigUser(1_000_000, "x")];
    const decision = decideCompaction({
      items,
      lastInputTokens: 10,
      contextWindowTokens: WINDOW,
      contextReservedOutputTokens: RESERVED_OUTPUT,
    });
    expect(decision.signalTokens).toBeGreaterThan(1_000_000);
    expect(decision.shouldCompact).toBe(true);
  });

  test("uses char/4 estimate only when there is no provider signal yet", () => {
    const items = [bigUser(THRESHOLD + 1, "x")];
    const decision = decideCompaction({
      items,
      lastInputTokens: null,
      contextWindowTokens: WINDOW,
      contextReservedOutputTokens: RESERVED_OUTPUT,
    });
    expect(decision.signalTokens).toBeGreaterThan(THRESHOLD);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("above_threshold");
  });

  test("compacts when the token signal reaches the threshold exactly", () => {
    const decision = decideCompaction({
      items: [user("history")],
      lastInputTokens: 244_800,
      contextWindowTokens: 272_000,
      contextReservedOutputTokens: 128_000,
      contextAutoCompactThresholdTokens: 244_800,
    });
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("above_threshold");
  });

  test("force keeps manual /compact working below the threshold", () => {
    const decision = decideCompaction({
      items: [user("small")],
      lastInputTokens: 1,
      contextWindowTokens: WINDOW,
      contextReservedOutputTokens: RESERVED_OUTPUT,
      force: true,
    });
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("force");
  });
});

describe("complete outgoing model-input accounting", () => {
  test("counts history, instructions, and tool schemas before a provider anchor exists", () => {
    const estimate = estimateCompleteModelInput({
      current: {
        input: [user("u".repeat(400))],
        instructionsTokens: 700,
        toolSchemaTokens: 900,
      },
    });
    expect(estimate.source).toBe("complete_estimate");
    expect(estimate.tokens).toBe(
      estimate.inputTokens + estimate.instructionsTokens + estimate.toolSchemaTokens,
    );
  });

  test("anchors to provider total tokens and adds every item after the last model output", () => {
    const prior = {
      input: [user("question"), assistant("answer"), call("c1")],
      instructionsTokens: 100,
      toolSchemaTokens: 200,
    };
    const current = {
      input: [...prior.input, result("c1", "x".repeat(4_000))],
      instructionsTokens: 100,
      toolSchemaTokens: 200,
    };
    const estimate = estimateCompleteModelInput({
      current,
      provider: { revision: 1, totalTokens: 12_345 },
      providerRequestFootprint: prior,
    });
    expect(estimate.source).toBe("provider_plus_local");
    expect(estimate.appendedAfterModelTokens).toBeGreaterThan(1_000);
    expect(estimate.tokens).toBe(12_345 + estimate.appendedAfterModelTokens);
  });

  test("adds positive instruction and tool-schema growth to a provider anchor", () => {
    const prior = {
      input: [user("question"), assistant("answer")],
      instructionsTokens: 100,
      toolSchemaTokens: 200,
    };
    const estimate = estimateCompleteModelInput({
      current: { ...prior, instructionsTokens: 130, toolSchemaTokens: 270 },
      provider: { revision: 2, totalTokens: 10_000 },
      providerRequestFootprint: prior,
    });
    expect(estimate.tokens).toBe(10_100);
  });

  test("treats an anchor without a model-generated boundary as unbound at the caller", () => {
    const current = {
      input: [user("only user input")],
      instructionsTokens: 10,
      toolSchemaTokens: 20,
    };
    const estimate = estimateCompleteModelInput({ current });
    expect(estimate.source).toBe("complete_estimate");
  });
});

describe("durable compaction progress identity", () => {
  test("is stable across PostgreSQL JSONB object-key reordering", () => {
    expect(
      compactionReplacementFingerprint([
        { type: "message", role: "user", content: "same", nested: { z: 1, a: 2 } },
      ]),
    ).toBe(
      compactionReplacementFingerprint([
        { nested: { a: 2, z: 1 }, content: "same", role: "user", type: "message" },
      ]),
    );
  });

  test("recognizes an exact repeat of the latest replacement across attempts", () => {
    const replacement = buildCompactionReplacementHistory([user("question")], "same summary");
    expect(latestCompactionReplacementFingerprint(replacement)).toBe(
      compactionReplacementFingerprint(replacement),
    );
    expect(
      compactionReplacementFingerprint(
        buildCompactionReplacementHistory(replacement, "same summary"),
      ),
    ).toBe(compactionReplacementFingerprint(replacement));
  });

  test("does not conflate a genuinely changed checkpoint with a repeat", () => {
    const first = buildCompactionReplacementHistory([user("question")], "first summary");
    const second = buildCompactionReplacementHistory(first, "second summary");
    expect(compactionReplacementFingerprint(second)).not.toBe(
      latestCompactionReplacementFingerprint(first),
    );
  });
});

describe("codex-parity rebuild", () => {
  test("summarizer input is current active history plus the checkpoint prompt", () => {
    const active = [user("u1"), assistant("a1"), call("c1"), result("c1")];
    const promptInput = buildCompactionPromptInput(active);
    expect(promptInput.slice(0, -1)).toEqual(active);
    expect(promptInput.at(-1)).toEqual({
      type: "message",
      role: "user",
      content: COMPACTION_PROMPT,
    });
  });

  test("replacement history keeps only real user messages plus one summary", () => {
    const prior = buildSummaryItem("prior summary");
    const active = [
      user("first user"),
      assistant("assistant dropped"),
      call("c1"),
      result("c1"),
      prior,
      user("second user"),
    ];
    const rebuilt = buildCompactionReplacementHistory(active, "new summary");
    expect(rebuilt).toHaveLength(3);
    expect(rebuilt[0]).toMatchObject(user("first user"));
    expect(rebuilt[1]).toMatchObject(user("second user"));
    expect(rebuilt[2]).toMatchObject({
      type: "message",
      role: "user",
      [COMPACTION_SUMMARY_MARKER]: true,
    });
    expect(rebuilt.some((item) => item === prior)).toBe(false);
    expect(rebuilt.some((item) => item.type === "function_call")).toBe(false);
  });

  test("ephemeral internal context never becomes permanent user history", () => {
    const internalContext = {
      type: "message",
      role: "system",
      content: "continue the same inference",
    };
    expect(isEphemeralInternalContext(internalContext)).toBe(true);

    const rebuilt = buildCompactionReplacementHistory(
      [user("real request"), internalContext],
      "summary",
    );
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0]).toMatchObject(user("real request"));
  });

  test("drops images from retained user messages", () => {
    const rebuilt = buildCompactionReplacementHistory(
      [
        userParts([
          { type: "input_text", text: "look at this" },
          { type: "input_image", image_url: "data:image/png;base64,abc" },
        ]),
      ],
      "summary",
    );
    expect((rebuilt[0] as { content?: unknown }).content).toEqual([
      { type: "input_text", text: "look at this" },
    ]);
  });

  test("caps an oversized newest user message at 20k estimated tokens with a middle marker", () => {
    const long = `${"a".repeat(COMPACT_USER_MESSAGE_MAX_TOKENS * 2 * 4)}TAIL`;
    const rebuilt = buildCompactionReplacementHistory([user(long)], "summary");
    const content = String(rebuilt[0]!.content);
    expect(content).toContain(USER_MESSAGE_TRUNCATION_MARKER.trim());
    expect(content.startsWith("aaaa")).toBe(true);
    expect(content.endsWith("TAIL")).toBe(true);
    expect(Math.ceil(content.length / 4)).toBeLessThanOrEqual(COMPACT_USER_MESSAGE_MAX_TOKENS);
  });

  test("shares one 20k budget across newest retained user messages", () => {
    const oldest = bigUser(5_000, "a");
    const boundary = bigUser(15_000, "b");
    const newest = bigUser(10_000, "c");
    const rebuilt = buildCompactionReplacementHistory(
      [oldest, assistant("drop"), boundary, newest],
      "summary",
    );

    expect(rebuilt).toHaveLength(3);
    expect(String(rebuilt[0]!.content).startsWith("b")).toBe(true);
    expect(String(rebuilt[0]!.content)).toContain(USER_MESSAGE_TRUNCATION_MARKER.trim());
    expect(Math.ceil(String(rebuilt[0]!.content).length / 4)).toBeLessThanOrEqual(10_000);
    expect(rebuilt[1]!.content).toBe(newest.content);
    expect(isCompactionSummary(rebuilt[2])).toBe(true);
  });

  test("rebuilt active history is orphan-clean because tool items are dropped", () => {
    const rebuilt = buildCompactionReplacementHistory(
      [user("old"), call("c0"), result("c0"), assistant("done"), user("new")],
      "summary",
    );
    expect(sanitizeHistoryItemsForModel(rebuilt)).toEqual(rebuilt);
  });
});

describe("provider-proof compaction transcript", () => {
  test("uses the SDK Responses adapter to preserve structured history on the wire", async () => {
    let seenInput: unknown;
    const fakeClient = {
      responses: {
        create: async (request: { input?: unknown }) => {
          seenInput = request.input;
          return {
            id: "resp_summary",
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "structured summary" }],
              },
            ],
          };
        },
      },
    };
    const input = buildCompactionPromptInput([
      user("deploy it"),
      call("call_vern"),
      result("call_vern"),
    ]);

    const summary = await summarizeForCompaction(testSettings({ openaiProvider: "azure" }), input, {
      client: fakeClient as any,
      api: "responses",
      model: "scripted-model",
    });

    expect(summary).toBe("structured summary");
    expect(Array.isArray(seenInput)).toBe(true);
    expect(seenInput).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "call_vern" }),
    );
    expect(seenInput).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call_vern" }),
    );
    expect(JSON.stringify(seenInput)).not.toContain("callId");
  });

  test("passes prompt_cache_key through summarizer Responses calls when provided", async () => {
    let seenKey: unknown;
    const usages: unknown[] = [];
    const fakeClient = {
      responses: {
        create: async (request: { prompt_cache_key?: unknown }) => {
          seenKey = request.prompt_cache_key;
          return {
            id: "resp_summary",
            usage: {
              input_tokens: 321,
              output_tokens: 12,
              total_tokens: 333,
            },
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "rendered summary" }],
              },
            ],
          };
        },
      },
    };

    const summary = await summarizeForCompaction(
      testSettings({ openaiProvider: "azure" }),
      buildCompactionPromptInput([user("deploy it")]),
      {
        client: fakeClient as any,
        api: "responses",
        model: "scripted-model",
        promptCacheKey: "session-123",
        onUsage: async (usage) => usages.push(usage),
      },
    );

    expect(summary).toBe("rendered summary");
    expect(seenKey).toBe("session-123");
    expect(usages).toEqual([
      {
        responseId: "resp_summary",
        usage: { inputTokens: 321, outputTokens: 12, totalTokens: 333 },
      },
    ]);
  });

  test("rejects a semantically empty provider response with content-free diagnostics", async () => {
    const fakeClient = {
      responses: {
        create: async () => ({
          id: "resp_empty",
          status: "completed",
          usage: { input_tokens: 321, output_tokens: 0, total_tokens: 321 },
          output: [{ type: "reasoning", content: [] }],
        }),
      },
    };
    try {
      await summarizeForCompaction(
        testSettings({ openaiProvider: "azure" }),
        buildCompactionPromptInput([user("deploy it")]),
        {
          client: fakeClient as any,
          api: "responses",
          model: "scripted-model",
        },
      );
      throw new Error("expected empty compaction response to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EmptyCompactionSummaryError);
      expect((error as EmptyCompactionSummaryError).diagnostics).toMatchObject({
        responseId: "resp_empty",
        status: "completed",
        incompleteReason: null,
        extractedTextLength: 0,
      });
      expect(JSON.stringify((error as EmptyCompactionSummaryError).diagnostics)).not.toContain(
        "deploy it",
      );
    }
  });

  test("classifies a thrown provider failure without persisting its message or model input", async () => {
    const providerError = Object.assign(
      new Error("provider echoed deploy it and other sensitive request content"),
      {
        status: 502,
        code: "server_error",
        type: "server_error",
        error: { code: "server_error", message: "nested sensitive provider text" },
        headers: new Headers({ "x-request-id": "req_compaction_failed" }),
      },
    );
    const fakeClient = {
      responses: {
        create: async () => {
          throw providerError;
        },
      },
    };
    try {
      await summarizeForCompaction(
        testSettings({ openaiProvider: "azure" }),
        buildCompactionPromptInput([user("deploy it")]),
        {
          client: fakeClient as any,
          api: "responses",
          model: "scripted-model",
        },
      );
      throw new Error("expected provider compaction failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CompactionProviderResponseError);
      expect((error as CompactionProviderResponseError).diagnostics).toEqual({
        errorName: "Error",
        httpStatus: 502,
        responseStatus: null,
        responseId: null,
        code: "server_error",
        type: "server_error",
        requestId: "req_compaction_failed",
      });
      expect(JSON.stringify(error)).not.toContain("deploy it");
      expect(JSON.stringify(error)).not.toContain("nested sensitive provider text");
      expect((error as Error).message).not.toContain("sensitive request content");
    }
  });

  test("classifies a failed Responses object even when a custom client returns HTTP-200 data", async () => {
    const fakeClient = {
      responses: {
        create: async () => ({
          id: "resp_failed",
          status: "failed",
          error: { code: "server_error", message: "must not persist this provider text" },
          output: [],
        }),
      },
    };
    await expect(
      summarizeForCompaction(
        testSettings({ openaiProvider: "azure" }),
        buildCompactionPromptInput([user("deploy it")]),
        {
          client: fakeClient as any,
          api: "responses",
          model: "scripted-model",
        },
      ),
    ).rejects.toMatchObject({
      name: "CompactionProviderResponseError",
      diagnostics: {
        responseStatus: "failed",
        responseId: "resp_failed",
        code: "server_error",
      },
    });
  });

  test("renders the full checkpoint input without silently dropping old records", () => {
    const rendered = renderCompactionPromptInputForChat(
      buildCompactionPromptInput([
        user("old ".repeat(400)),
        assistant("middle ".repeat(400)),
        user("recent user message"),
      ]),
    );

    expect(rendered).toContain("old old");
    expect(rendered).toContain("middle middle");
    expect(rendered).toContain("recent user message");
    expect(rendered).toContain("CONTEXT CHECKPOINT COMPACTION");
  });
});

describe("CompactionNeededError", () => {
  test("carries signal metadata and can be found through causes", () => {
    const error = new CompactionNeededError({
      signalTokens: 12,
      thresholdTokens: 10,
      signalSource: "provider",
    });
    expect(error.signalTokens).toBe(12);
    expect(findCompactionNeededError({ cause: error })).toBe(error);
  });
});

describe("extractResponseOutputText", () => {
  test("reads output_text directly", () => {
    expect(extractResponseOutputText({ output_text: "hello" })).toBe("hello");
  });

  test("reads assistant message content parts", () => {
    const response = {
      output: [
        { type: "reasoning", content: [] },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "part-A" },
            { type: "output_text", text: "-B" },
          ],
        },
      ],
    };
    expect(extractResponseOutputText(response)).toBe("part-A-B");
  });

  test("skips input-echo message items", () => {
    const response = {
      output: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "ECHOED PROMPT" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "real-summary" }],
        },
      ],
    };
    expect(extractResponseOutputText(response)).toBe("real-summary");
  });

  test("returns empty string for unknown shapes", () => {
    expect(extractResponseOutputText(null)).toBe("");
    expect(extractResponseOutputText({})).toBe("");
  });
});
