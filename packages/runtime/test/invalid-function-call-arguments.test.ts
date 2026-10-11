import { describe, expect, test } from "bun:test";
import { withTrace } from "@openai/agents";
import { OpenGeniChatCompletionsModel } from "../src/model-provider-routing";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";
import {
  INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS,
  projectHistoryForProvider,
} from "../src/provider-history-adapter";

// Production: a chat-wire model leaked a control token into its tool-call
// arguments. The SDK answered the call with a parse error, but every later
// request replayed the invalid text and the provider rejected the whole
// request ("Assistant tool call function.arguments must be valid JSON").
const leaked =
  '{"path": "/workspace/primes.py", "diff": "*** Begin Patch\\n+x\\n*** End Patch</｜DSML｜ parameter>';

function history(args: string) {
  return [
    { type: "message", role: "user", content: "Create primes.py" },
    {
      type: "function_call",
      callId: "call-invalid",
      name: "apply_patch",
      status: "completed",
      arguments: args,
    },
    {
      type: "function_call_result",
      callId: "call-invalid",
      name: "apply_patch",
      status: "completed",
      output: { type: "text", text: "An error occurred while parsing tool arguments." },
    },
  ] as Array<Record<string, unknown>>;
}

describe("request-local invalid function-call arguments", () => {
  for (const api of ["chat", "responses", "anthropic-messages"] as const) {
    test(`${api}: invalid arguments become a deterministic JSON object without mutating history`, () => {
      const items = history(leaked);
      const before = JSON.stringify(items);
      const first = projectHistoryForProvider(items, api);
      const second = projectHistoryForProvider(items, api);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      const call = first.find((item) => item.type === "function_call")!;
      expect(JSON.parse(call.arguments as string)).toEqual({ _invalid_arguments: leaked });
      expect(call.callId).toBe("call-invalid");
      expect(JSON.stringify(items)).toBe(before);
    });
  }

  test("oversized invalid arguments are bounded; empty arguments become {}", () => {
    const huge = `{"patch": "${"*** End Patch\\n".repeat(20_000)}`;
    const [, call] = projectHistoryForProvider(history(huge), "chat");
    const wrapped = JSON.parse(call!.arguments as string)._invalid_arguments as string;
    expect(wrapped.startsWith(huge.slice(0, INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS))).toBe(true);
    expect(wrapped).toContain(
      `[truncated ${huge.length - INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS} chars]`,
    );
    const [, empty] = projectHistoryForProvider(history(""), "chat");
    expect(empty!.arguments).toBe("{}");
  });

  test("valid arguments keep canonical history by reference", () => {
    const items = history(JSON.stringify({ patch: "*** Begin Patch\n*** End Patch" }));
    expect(projectHistoryForProvider(items, "chat")).toBe(items);
    expect(projectHistoryForProvider(items, "responses")).toBe(items);
  });

  test("the Chat Completions wire request carries valid JSON tool-call arguments", async () => {
    const requests: Array<Record<string, any>> = [];
    const client = new ReplayableJsonOpenAI({
      apiKey: "fixture-key",
      baseURL: "https://example.test/v1",
      maxRetries: 0,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(await requestBodyText(init?.body)));
        return Response.json({
          id: "reply-fixture",
          model: "fixture-chat",
          created: 1,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Retrying." },
              finish_reason: "stop",
            },
          ],
        });
      },
    });
    const model = new OpenGeniChatCompletionsModel(client, "fixture-chat");
    await withTrace("invalid-arguments-fixture", () =>
      model.getResponse({
        input: history(leaked) as never,
        modelSettings: {},
        tools: [],
        outputType: "text",
        handoffs: [],
        tracing: false,
      } as never),
    );
    const toolCalls = requests[0]!.messages.flatMap(
      (message: { tool_calls?: Array<{ function: { arguments: string } }> }) =>
        message.tool_calls ?? [],
    );
    expect(toolCalls).toHaveLength(1);
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ _invalid_arguments: leaked });
  });
});
