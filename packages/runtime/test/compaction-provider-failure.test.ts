import { describe, expect, test } from "bun:test";
import { APIError } from "openai";
import { testSettings } from "@opengeni/testing/settings";
import {
  COMPACTION_PROVIDER_MESSAGE_MAX_CHARS,
  CompactionProviderResponseError,
  buildTrimmedCompactionReplacement,
  buildTrimmedContextCheckpointItem,
  compactionProviderMessage,
  isCompactionSummary,
  summarizeForCompaction,
  TRIMMED_CONTEXT_NOTICE,
} from "../src/index";
import { estimateTextTokens, USER_MESSAGE_TRUNCATION_MARKER } from "../src/context-compaction";

type Options = NonNullable<Parameters<typeof summarizeForCompaction>[2]>;
type Request = Record<string, unknown>;

const settings = testSettings({ contextWindowTokens: 128_000 });
const history = [{ type: "message", role: "user", content: "Keep the approved task" }];

function compatibleProvider(api: "chat" | "responses"): NonNullable<Options["provider"]> {
  return {
    id: "workspace-compatible-00000000-0000-4000-8000-000000000001",
    kind: "direct-compatible-workspace",
    api,
    wireProfile: "openai",
  } as unknown as NonNullable<Options["provider"]>;
}

function platformChatProvider(): NonNullable<Options["provider"]> {
  return {
    id: "fireworks",
    kind: "api-key",
    api: "chat",
    wireProfile: "openai",
  } as unknown as NonNullable<Options["provider"]>;
}

function chatClient(
  create: (request: Request) => Promise<unknown>,
): NonNullable<Options["client"]> {
  return { chat: { completions: { create } } } as unknown as NonNullable<Options["client"]>;
}

function rejection(status: number, message: string): APIError {
  return APIError.generate(
    status,
    { error: { message, type: "invalid_request_error", code: "invalid_request_error" } },
    undefined,
    new Headers({ "x-request-id": `req_${status}` }),
  );
}

const stop = (content: string) => ({
  choices: [{ finish_reason: "stop", message: { content } }],
});

describe("compaction on an OpenAI-compatible endpoint", () => {
  test("a rejected summary request is sent once more without max_tokens", async () => {
    const requests: Request[] = [];
    const summary = await summarizeForCompaction(settings, history, {
      api: "chat",
      provider: compatibleProvider("chat"),
      client: chatClient(async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          throw rejection(400, "max_tokens must be at most 8192");
        }
        return stop("Continue the approved task");
      }),
    });

    expect(summary).toBe("Continue the approved task");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("max_tokens", 20_000);
    expect(requests[1]).not.toHaveProperty("max_tokens");
    expect(requests[1]!.messages).toEqual(requests[0]!.messages);
  });

  test("a summary requested without the cap is held to the cap, cut from the middle", async () => {
    const long = `Start of the summary. ${"middle detail ".repeat(400)}End of the summary.`;
    let calls = 0;
    const summary = await summarizeForCompaction(settings, history, {
      api: "chat",
      provider: compatibleProvider("chat"),
      maxOutputTokens: 100,
      client: chatClient(async () => {
        calls += 1;
        if (calls === 1) throw rejection(400, "max_tokens must be at most 64");
        return stop(long);
      }),
    });

    expect(calls).toBe(2);
    expect(estimateTextTokens(summary)).toBeLessThanOrEqual(100);
    expect(summary.startsWith("Start of the summary.")).toBe(true);
    expect(summary.endsWith("End of the summary.")).toBe(true);
    expect(summary).toContain(USER_MESSAGE_TRUNCATION_MARKER);

    // A summary the endpoint produced under the cap is returned as it came.
    const capped = await summarizeForCompaction(settings, history, {
      api: "chat",
      provider: compatibleProvider("chat"),
      maxOutputTokens: 100,
      client: chatClient(async () => stop(long)),
    });
    expect(capped).toBe(long);
  });

  test("a 422 validation refusal is retried the same way", async () => {
    let calls = 0;
    await summarizeForCompaction(settings, history, {
      api: "chat",
      provider: compatibleProvider("chat"),
      client: chatClient(async () => {
        calls += 1;
        if (calls === 1) throw rejection(422, "unprocessable max_tokens");
        return stop("Summary");
      }),
    });
    expect(calls).toBe(2);
  });

  test("a second refusal fails once, marked as retried, with the provider's message", async () => {
    let calls = 0;
    const failure = await summarizeForCompaction(settings, history, {
      api: "chat",
      provider: compatibleProvider("chat"),
      client: chatClient(async () => {
        calls += 1;
        throw rejection(400, calls === 1 ? "first refusal" : "Unsupported parameter: messages");
      }),
    }).catch((error: unknown) => error);

    expect(calls).toBe(2);
    expect(failure).toBeInstanceOf(CompactionProviderResponseError);
    const error = failure as CompactionProviderResponseError;
    expect(error.diagnostics).toMatchObject({ httpStatus: 400, outputCapRetried: true });
    expect(error.providerMessage).toBe("Unsupported parameter: messages");
  });

  test.each([401, 404, 429, 500])("an HTTP %i failure is not retried", async (status) => {
    let calls = 0;
    const failure = await summarizeForCompaction(settings, history, {
      api: "chat",
      provider: compatibleProvider("chat"),
      client: chatClient(async () => {
        calls += 1;
        throw rejection(status, "refused");
      }),
    }).catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(CompactionProviderResponseError);
  });

  test("a Responses-API endpoint is retried without max_output_tokens", async () => {
    const requests: Request[] = [];
    const summary = await summarizeForCompaction(settings, history, {
      api: "responses",
      provider: compatibleProvider("responses"),
      client: {
        responses: {
          create: async (request: Request) => {
            requests.push(JSON.parse(JSON.stringify(request)) as Request);
            if (requests.length === 1) throw rejection(400, "max_output_tokens is too large");
            return {
              id: "resp_summary",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "Responses summary" }],
                },
              ],
            };
          },
        },
      } as unknown as NonNullable<Options["client"]>,
    });

    expect(summary).toBe("Responses summary");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("max_output_tokens", 20_000);
    expect(requests[1]).not.toHaveProperty("max_output_tokens");
  });

  test("other providers keep a single request", async () => {
    let calls = 0;
    const failure = await summarizeForCompaction(settings, history, {
      api: "chat",
      provider: platformChatProvider(),
      client: chatClient(async () => {
        calls += 1;
        throw rejection(400, "bad request");
      }),
    }).catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect((failure as CompactionProviderResponseError).providerMessage).toBe("bad request");
  });

  test.each([
    ["a compatible endpoint", compatibleProvider("responses")],
    ["a platform provider", { ...platformChatProvider(), api: "responses" }],
  ] as const)(
    "an error from usage accounting on %s passes through unchanged and is not retried",
    async (_label, provider) => {
      class UsageRecordingFailed extends Error {}
      let calls = 0;
      const failure = await summarizeForCompaction(settings, history, {
        api: "responses",
        provider: provider as NonNullable<Options["provider"]>,
        client: {
          responses: {
            create: async () => {
              calls += 1;
              return {
                id: "resp_summary",
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Responses summary" }],
                  },
                ],
              };
            },
          },
        } as unknown as NonNullable<Options["client"]>,
        onUsage: () => {
          throw new UsageRecordingFailed("usage could not be recorded");
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(UsageRecordingFailed);
      expect(failure).not.toBeInstanceOf(CompactionProviderResponseError);
      expect(calls).toBe(1);
    },
  );

  test("an error from usage accounting on the chat path passes through unchanged", async () => {
    class UsageRecordingFailed extends Error {}
    const failure = await summarizeForCompaction(settings, history, {
      api: "chat",
      provider: compatibleProvider("chat"),
      client: chatClient(async () => ({
        ...stop("Continue the approved task"),
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })),
      onUsage: () => {
        throw new UsageRecordingFailed("usage could not be recorded");
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageRecordingFailed);
  });
});

describe("the provider's error message", () => {
  test("is kept on the error but out of its content-free message and diagnostics", async () => {
    const secretish = "Your input mentions Project Falcon, which is not allowed";
    const failure = await summarizeForCompaction(settings, history, {
      api: "chat",
      provider: platformChatProvider(),
      client: chatClient(async () => {
        throw rejection(400, secretish);
      }),
    }).catch((error: unknown) => error);

    const error = failure as CompactionProviderResponseError;
    expect(error.providerMessage).toBe(secretish);
    expect(error.message).not.toContain("Falcon");
    expect(JSON.stringify(error.diagnostics)).not.toContain("Falcon");
    expect(error.diagnostics).toMatchObject({
      httpStatus: 400,
      type: "invalid_request_error",
      requestId: "req_400",
    });
  });

  test("is single-line and bounded", () => {
    const long = `line one\n\tline\u0000two ${"x".repeat(2_000)}`;
    const message = compactionProviderMessage({ error: { message: long } })!;
    expect(message.startsWith("line one line two x")).toBe(true);
    expect(message).not.toMatch(/[\u0000-\u001f]/);
    expect(message.length).toBe(COMPACTION_PROVIDER_MESSAGE_MAX_CHARS);
    expect(message.endsWith("…")).toBe(true);
  });

  test("reads a bare string error body, never SDK or transport text", () => {
    expect(compactionProviderMessage({ error: "model not loaded" })).toBe("model not loaded");
    expect(
      compactionProviderMessage(
        Object.assign(new Error("400 status code (no body)"), { status: 400 }),
      ),
    ).toBeNull();
    expect(
      compactionProviderMessage(
        new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND gateway.internal") }),
      ),
    ).toBeNull();
    // A wrapped error keeps the message its cause chain carried.
    const inner = new CompactionProviderResponseError(
      { httpStatus: 400 },
      {
        error: { message: "max_tokens too large" },
      },
    );
    expect(compactionProviderMessage(inner)).toBe("max_tokens too large");
    expect(compactionProviderMessage({ error: { message: "  " } })).toBeNull();
    expect(compactionProviderMessage(undefined)).toBeNull();
  });

  test("is read from a failed response object", () => {
    const error = new CompactionProviderResponseError({ httpStatus: 200 }, undefined, {
      status: "failed",
      error: { code: "server_error", message: "The model crashed" },
    });
    expect(error.providerMessage).toBe("The model crashed");
  });
});

describe("trimmed checkpoint", () => {
  const turnA = "turn-a";
  const active = "turn-active";
  const items = [
    { type: "message", role: "user", content: "Set up the release branch" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Release branch is ready." }],
    },
    { type: "message", role: "user", content: "Now update the changelog" },
    { type: "function_call", name: "shell", callId: "c1", arguments: "{}" },
    { type: "function_call_result", name: "shell", callId: "c1", output: "ok" },
    { type: "function_call", name: "shell", callId: "c2", arguments: "{}" },
    { type: "function_call_result", name: "shell", callId: "c2", output: "ok" },
    { type: "function_call", name: "apply_patch", callId: "c3", arguments: "{}" },
    { type: "function_call_result", name: "apply_patch", callId: "c3", output: "ok" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Changelog drafted; running checks next." }],
    },
  ];
  const itemTurnIds = [
    turnA,
    turnA,
    active,
    active,
    active,
    active,
    active,
    active,
    active,
    active,
  ];

  test("keeps recent requests, notes the current turn and is read as a summary", () => {
    const replacement = buildTrimmedCompactionReplacement(items, undefined, undefined, undefined, {
      itemTurnIds,
      activeTurnId: active,
    });
    const rebuilt = replacement.history;
    const checkpoint = rebuilt.at(-1)!;

    expect(isCompactionSummary(checkpoint)).toBe(true);
    expect(checkpoint.content).toBe(
      [
        TRIMMED_CONTEXT_NOTICE,
        "Tool calls made earlier in the current turn: shell (2), apply_patch.",
        "Your latest message in the current turn, before the removal:\nChangelog drafted; running checks next.",
      ].join("\n\n"),
    );
    expect(rebuilt).toContainEqual(
      expect.objectContaining({ role: "user", content: "Set up the release branch" }),
    );
    expect(rebuilt).toContainEqual(
      expect.objectContaining({ role: "user", content: "Now update the changelog" }),
    );
    expect(rebuilt.some((item) => item.type === "function_call")).toBe(false);
    expect(rebuilt.some((item) => item.type === "function_call_result")).toBe(false);
  });

  test("carries an earlier summary forward once, without nesting notices", () => {
    const summarized = [
      {
        type: "message",
        role: "user",
        content:
          "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\nThe release is version 4.2.",
        opengeni_context_summary: true,
      },
      ...items,
    ];
    const first = buildTrimmedContextCheckpointItem(summarized, {
      itemTurnIds: [null, ...itemTurnIds],
      activeTurnId: active,
    });
    expect(first.content).toContain(
      "Summary from an earlier checkpoint:\nThe release is version 4.2.",
    );

    const second = buildTrimmedContextCheckpointItem([first, items[0]!], {
      itemTurnIds: [null, "turn-later"],
      activeTurnId: "turn-later",
    });
    const text = second.content as string;
    expect(text.split(TRIMMED_CONTEXT_NOTICE)).toHaveLength(2);
    expect(text).toBe(
      `${TRIMMED_CONTEXT_NOTICE}\n\nSummary from an earlier checkpoint:\nThe release is version 4.2.`,
    );
  });
});
