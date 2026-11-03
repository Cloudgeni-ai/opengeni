/**
 * Agent-visible content is append-only and never rewritten for secrecy
 * (AGENTS.md, "Agent-visible content"). Across several model requests in
 * which the agent uses new secrets by reference, every item an earlier
 * request sent is sent again byte for byte, the instructions never change,
 * and each tool output reaches the model exactly as the tool wrote it. Every
 * value here is fake.
 */
import { afterAll, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import { ScriptedModel, assistantMessage, functionCall } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { Manifest } from "@openai/agents/sandbox";
import { buildOpenGeniAgent, createSandboxClientForBackend, runAgentStream } from "../src/index";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";

/** A secret reference, assembled so no tool on the way resolves it early. */
const ref = (path: string) => ["{", "{secret:", path, "}}"].join("");
const VALUES = {
  "Fake/first/password": "fake-first-value-0001",
  "Fake/second/password": "hunter2",
};

type LocalSession = { close(): Promise<void> };
const sessions: LocalSession[] = [];
afterAll(async () => {
  for (const session of sessions) await session.close().catch(() => undefined);
});

function inputItems(request: ModelRequest): string[] {
  const input = request.input;
  return (typeof input === "string" ? [input] : input).map((item) => JSON.stringify(item));
}

/** The text of a tool output, as a model input item or a stream event holds it. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(outputText).join("");
  if (output && typeof output === "object" && "text" in output)
    return String((output as { text: unknown }).text);
  return JSON.stringify(output);
}

function toolOutputs(request: ModelRequest): string[] {
  const input = request.input;
  if (typeof input === "string") return [];
  return input
    .filter((item) => (item as { type?: string }).type === "function_call_result")
    .map((item) => outputText((item as { output?: unknown }).output));
}

test("items already sent never change and tool output reaches the model as written", async () => {
  const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
  const client = createSandboxClientForBackend("local", settings) as unknown as {
    create(manifest?: unknown): Promise<LocalSession>;
  };
  // The host's PATH, so commands run under the in-sandbox process supervisor.
  const local = await client.create(
    new Manifest({ environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }),
  );
  sessions.push(local);
  // Resolved values reach a command through the routing session's delivery.
  const session = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({
      session: local as never,
      sandboxId: null,
      kind: "local",
      leaseEpoch: 1,
      providerInstanceId: "instance",
      activeEpoch: 0,
    }),
    beforeMutation: async () => ({}),
    afterMutation: async () => undefined,
  } as never);
  await session.prime();
  const model = new ScriptedModel([
    {
      output: [
        functionCall(
          "exec_command",
          { cmd: `printf 'first=%s\\n' "${ref("Fake/first/password")}"` },
          "call-first",
        ),
      ],
    },
    {
      output: [
        functionCall(
          "exec_command",
          {
            cmd: `printf 'second=%s path=/tmp/hunter2/notes.txt\\n' "${ref("Fake/second/password")}"`,
          },
          "call-second",
        ),
      ],
    },
    { output: [assistantMessage("done")] },
  ]);
  const agent = buildOpenGeniAgent(settings, [], {
    model,
    hostedWebSearch: false,
    secretResolver: createStaticSecretResolver(VALUES),
  });
  const run = await runAgentStream(
    agent,
    `Use the first secret. An earlier note mentioned ${VALUES["Fake/first/password"]}.`,
    settings,
    { ownedSandbox: { client, session } },
  );
  const toolEvents: string[] = [];
  for await (const event of run.toStream()) {
    const item = (event as { type?: string; item?: { type?: string; output?: unknown } }).item;
    if (event.type === "run_item_stream_event" && item?.type === "tool_call_output_item")
      toolEvents.push(outputText(item.output));
  }
  await run.completed;

  expect(model.requests).toHaveLength(3);
  // Every request repeats the earlier one's items byte for byte, then appends.
  for (let index = 1; index < model.requests.length; index++) {
    const earlier = inputItems(model.requests[index - 1]!);
    const later = inputItems(model.requests[index]!);
    expect(later.length).toBeGreaterThan(earlier.length);
    expect(later.slice(0, earlier.length)).toEqual(earlier);
    expect(model.requests[index]!.systemInstructions).toBe(
      model.requests[0]!.systemInstructions,
    );
  }
  // The user's own text keeps the value it holds.
  expect(inputItems(model.requests[0]!)[0]).toContain(VALUES["Fake/first/password"]);

  // The tool outputs reach the model exactly as the tools produced them, with
  // the resolved values and the path that contains one of them.
  const outputs = toolOutputs(model.requests[2]!);
  expect(outputs).toHaveLength(2);
  expect(outputs).toEqual(toolEvents);
  expect(outputs[0]).toContain(`first=${VALUES["Fake/first/password"]}`);
  expect(outputs[1]).toContain(`second=${VALUES["Fake/second/password"]}`);
  expect(outputs[1]).toContain("path=/tmp/hunter2/notes.txt");
  for (const output of outputs) {
    expect(output).not.toContain("[secret");
    expect(output).not.toContain("[masked");
  }
  // The calls the model wrote keep their references.
  const calls = JSON.stringify(model.requests[2]!.input);
  expect(calls).toContain(ref("Fake/first/password").replaceAll('"', '\\"'));
});
