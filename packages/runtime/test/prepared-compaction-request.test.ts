import { expect, test } from "bun:test";
import { OpenAIResponsesModel, type ModelRequest } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import OpenAI from "openai";
import { ScriptedModel, testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  CompactionNeededError,
  findCompactionNeededError,
  preparedCompactionRequest,
  queuePreparedCompaction,
  requestRemoteCompactionV2,
  runAgentStream,
  summarizeForCompaction,
} from "../src/index";

function sandbox(agent: ReturnType<typeof buildOpenGeniAgent>) {
  return {
    client: { backendId: "unix_local", serializeSessionState: async () => ({}) },
    session: {
      state: { manifest: (agent as SandboxAgent).defaultManifest },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      execCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      createEditor: () => ({}),
      listDir: async () => [],
      readFile: async () => "",
      pathExists: async () => false,
      materializeEntry: async () => undefined,
    },
  };
}

async function drain(stream: Awaited<ReturnType<typeof runAgentStream>>) {
  for await (const event of stream) void event;
  await stream.completed;
}

class WireModel extends OpenAIResponsesModel {
  wire(request: ModelRequest) {
    return this._buildResponsesCreateRequest(request, false).requestData;
  }
}

for (const lazy of [false, true]) {
  test(`compaction reuses real sandbox/lazy prepared wire prefix (lazy=${lazy})`, async () => {
    const settings = testSettings({
      sandboxBackend: "local",
      webSearchEnabled: false,
      codexToolSearchEnabled: true,
    });
    const model = new ScriptedModel("done");
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      hostedWebSearch: false,
      ...(lazy ? { lazyToolTransport: "codex_native" as const } : {}),
    });
    agent.modelSettings = {
      ...agent.modelSettings,
      text: { verbosity: "low" },
      providerData: { ...agent.modelSettings.providerData, prompt_cache_key: "stable-session-key" },
    };
    const options = { ownedSandbox: sandbox(agent) as never };
    await drain(await runAgentStream(agent, "test", settings, options));
    const ordinary = model.requests[0]!;
    const prefix = preparedCompactionRequest(agent);
    expect(prefix.systemInstructions).not.toBe(agent.instructions);
    expect(prefix.systemInstructions).toContain("# Sandbox capability instructions");
    expect(prefix.tools.some((tool) => tool.name === "exec_command")).toBe(true);
    expect(prefix.systemInstructions).toBe(ordinary.systemInstructions);
    expect(prefix.tools).toEqual(ordinary.tools);
    expect(prefix.modelSettings).toEqual(ordinary.modelSettings);

    let compactWire: any;
    const client = {
      responses: {
        create: async (body: unknown) => {
          compactWire = body;
          return {
            id: "compact",
            status: "completed",
            output: [{ type: "compaction", encrypted_content: "opaque" }],
          };
        },
      },
    } as unknown as OpenAI;
    const wire = new WireModel(client, "gpt-6-astra").wire(ordinary);
    await requestRemoteCompactionV2(settings, ordinary.input as Array<Record<string, unknown>>, {
      client,
      model: "gpt-6-astra",
      preparedRequest: prefix,
    });
    const { input: normalInput, ...normalPrefix } = wire;
    const { input: compactInput, ...compactPrefix } = compactWire;
    expect(compactPrefix).toEqual(normalPrefix);
    expect(compactInput.slice(0, -1)).toEqual(normalInput);
    expect(compactInput.at(-1)).toEqual({ type: "compaction_trigger" });
  });
}

test("portable Responses compaction keeps the prepared tool and instruction prefix", async () => {
  const settings = testSettings({
    sandboxBackend: "local",
    webSearchEnabled: false,
    codexToolSearchEnabled: true,
  });
  const model = new ScriptedModel("done");
  const agent = buildOpenGeniAgent(settings, [], { model, hostedWebSearch: false });
  await drain(
    await runAgentStream(agent, "test", settings, { ownedSandbox: sandbox(agent) as never }),
  );
  const ordinary = model.requests[0]!;
  const prefix = preparedCompactionRequest(agent);
  let compactWire: any;
  const client = {
    responses: {
      create: async (body: unknown) => {
        compactWire = body;
        return {
          id: "summary",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "summary" }],
            },
          ],
        };
      },
    },
  } as unknown as OpenAI;
  const summary = await summarizeForCompaction(
    settings,
    [
      ...(ordinary.input as Array<Record<string, unknown>>),
      {
        type: "message",
        role: "user",
        content: "Create a checkpoint",
      },
    ],
    { client, api: "responses", preparedRequest: prefix },
  );
  const normalWire = new WireModel(client, "gpt-6-astra").wire(ordinary);
  expect(summary).toBe("summary");
  expect(compactWire.tools).toEqual(normalWire.tools);
  expect(compactWire.instructions).toBe(normalWire.instructions);
  expect(compactWire.tool_choice).toBe("none");
  expect(compactWire.input.slice(0, -1)).toEqual(normalWire.input);
  expect(compactWire.input.at(-1)).toEqual({ role: "user", content: "Create a checkpoint" });
  expect(model.calls).toBe(1);
});

for (const queued of [false, true]) {
  test(`compaction prepares sandbox request but sends no ordinary inference (queued=${queued})`, async () => {
    const settings = testSettings({
      sandboxBackend: "local",
      webSearchEnabled: false,
      codexToolSearchEnabled: true,
    });
    const model = new ScriptedModel("must not run");
    const agent = buildOpenGeniAgent(settings, [], { model, hostedWebSearch: false });
    if (queued)
      queuePreparedCompaction(
        agent,
        new CompactionNeededError({
          trigger: "operator",
          signalSource: "operator",
          signalTokens: 10,
          thresholdTokens: 5,
        }),
      );
    let error: unknown;
    try {
      await drain(
        await runAgentStream(agent, "test", settings, {
          ownedSandbox: sandbox(agent) as never,
          contextCompactionRequested: () => !queued,
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(findCompactionNeededError(error)?.trigger).toBe("operator");
    expect(model.calls).toBe(0);
    expect(preparedCompactionRequest(agent).systemInstructions).toContain(
      "# Sandbox capability instructions",
    );
    // A new stream after compaction must not inherit the old stop request.
    await drain(
      await runAgentStream(agent, "shortened history", settings, {
        ownedSandbox: sandbox(agent) as never,
      }),
    );
    expect(model.calls).toBe(1);
    expect(() => preparedCompactionRequest({})).toThrow("prepared model request");
  });
}
