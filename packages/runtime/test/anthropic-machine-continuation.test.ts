import { expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { buildAnthropicRequest } from "../src/anthropic-messages";

const project = (input: ModelRequest["input"], stream: boolean) =>
  buildAnthropicRequest(
    {
      input,
      systemInstructions: "Base instructions",
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    },
    "claude-test",
    {},
    stream,
  );

test.each([false, true])(
  "machine-only continuation keeps system authority and prior assistant output (stream=%s)",
  (stream) => {
    const input: ModelRequest["input"] = [
      { role: "user", content: "Task" },
      { role: "assistant", content: "Prior answer" },
      { role: "system", content: "First update" },
      { role: "system", content: "Second update" },
    ];
    const original = JSON.stringify(input);
    const body = project(input, stream);
    expect(body.messages.map((message: any) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "system",
    ]);
    expect(body.messages[1].content).toEqual([{ type: "text", text: "Prior answer" }]);
    expect(body.messages[2].content[0].text).toBe(
      "OpenGeni continuation (machine-origin input; no new human message).",
    );
    expect(body.messages[3].content.map((block: any) => block.text)).toEqual([
      "First update",
      "Second update",
    ]);
    expect(body.messages.at(-1).role).toBe("system");
    expect(JSON.stringify(input)).toBe(original);
  },
);

test("a real next user input anchors the system phase without a continuation marker", () => {
  const body = project(
    [
      { role: "user", content: "Task" },
      { role: "assistant", content: "Prior answer" },
      { role: "system", content: "Update" },
      { role: "user", content: "Next request" },
    ],
    false,
  );
  expect(body.messages.map((message: any) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "system",
  ]);
  expect(body.messages[2].content.map((block: any) => block.text)).toEqual(["Next request"]);
});

test("repeated machine continuations preserve assistant boundaries and exact system order", () => {
  const body = project(
    [
      { role: "user", content: "Task" },
      { role: "assistant", content: "First answer" },
      { role: "system", content: "First update" },
      { role: "assistant", content: "Second answer" },
      { role: "system", content: "Second update" },
    ],
    true,
  );
  expect(body.messages.map((message: any) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "system",
    "assistant",
    "user",
    "system",
  ]);
  expect(body.messages[3].content[0].text).toBe("First update");
  expect(body.messages[4].content[0].text).toBe("Second answer");
  expect(body.messages[6].content[0].text).toBe("Second update");
});

test("a missing tool result still fails before a continuation is projected", () => {
  expect(() =>
    project(
      [
        { role: "user", content: "Task" },
        { type: "function_call", name: "lookup", callId: "call_test", arguments: "{}" },
        { role: "system", content: "Update" },
      ],
      true,
    ),
  ).toThrow("tool results are missing");
});
