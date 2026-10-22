import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sdkResponseHasMeaningfulOutput } from "../src/activities/agent-turn/meaningful-output";

const done = (output: unknown) => ({
  type: "raw_model_stream_event",
  data: { type: "response_done", response: { id: "msg_1", output } },
});

describe("model-response progress for the shared capacity breaker", () => {
  test("completed assistant text or a complete function call is real work", () => {
    expect(
      sdkResponseHasMeaningfulOutput(
        done([
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done." }],
          },
        ]),
      ),
    ).toBe(true);
    expect(
      sdkResponseHasMeaningfulOutput(
        done([
          {
            type: "function_call",
            callId: "toolu_1",
            name: "read_file",
            arguments: '{"path":"a"}',
            status: "completed",
          },
        ]),
      ),
    ).toBe(true);
  });

  test("reasoning, blank or incomplete text, partial calls and other events are not", () => {
    expect(sdkResponseHasMeaningfulOutput(done([{ type: "reasoning", content: [] }]))).toBe(false);
    expect(
      sdkResponseHasMeaningfulOutput(
        done([
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "  " }],
          },
          {
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "output_text", text: "cut off" }],
          },
          { type: "function_call", callId: "", name: "x", arguments: "{}" },
          { type: "function_call", callId: "toolu_2", name: "x", arguments: "" },
        ]),
      ),
    ).toBe(false);
    expect(sdkResponseHasMeaningfulOutput(done([]))).toBe(false);
    expect(sdkResponseHasMeaningfulOutput({ type: "run_item_stream_event" })).toBe(false);
    expect(sdkResponseHasMeaningfulOutput(null)).toBe(false);
  });

  test("only a core-placed turn's fallback completed event carries the flag", () => {
    const source = readFileSync(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
      "utf8",
    );
    expect(source.replace(/\s+/g, " ")).toContain(
      "...(subscriptionCoreTurnOf(providerTurn) ? { meaningfulOutput: sdkResponseHasMeaningfulOutput(next.value) } : {})",
    );
  });
});
