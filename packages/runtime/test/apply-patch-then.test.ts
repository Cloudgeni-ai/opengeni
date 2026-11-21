import { describe, expect, test } from "bun:test";
import { Agent, Runner, tool as functionTool, type AgentOutputItem } from "@openai/agents";
import type { Tool } from "@openai/agents";
import { assistantMessage, ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import type { Settings } from "@opengeni/config";
import { allAgentCapabilities } from "@opengeni/contracts";
import {
  applyPatchSucceeded,
  APPLY_PATCH_THEN_DESCRIPTION,
  splitApplyPatchThenInput,
} from "../src/apply-patch-then";
import { APPLY_PATCH_THEN_GUIDANCE } from "../src/agent-instructions/modules/sandbox";
import { TurnSandboxCommandCancelledError } from "../src/sandbox/turn-tool-cancellation";
import {
  agentPromptExperimentsFor,
  buildAgentCapabilities,
  composeModularAgentInstructions,
  DEFAULT_AGENT_IDENTITY,
  inspectPersistentAgentInstructions,
} from "../src/index";
import { ALL_RESOURCES } from "./agent-instructions/prompt-sentences";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;

const ADD_A = "*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch";
const PLAIN_REFERENCE = ["{{", "secret:Plain}}"].join("");

type Exec = { cmd: string } & Record<string, unknown>;

/** One fake session serving both the editor and the shell. */
function fakeSession(
  options: {
    failPatch?: boolean;
    execResult?: (args: Exec) => Promise<string>;
  } = {},
) {
  const events: string[] = [];
  const operations: unknown[] = [];
  const commands: Exec[] = [];
  const session = {
    createEditor: () => ({
      createFile: async (operation: unknown) => {
        events.push("patch:start");
        await Bun.sleep(20);
        if (options.failPatch) throw new Error("file already exists");
        operations.push(operation);
        events.push("patch:end");
        return {};
      },
    }),
    execCommand: async (args: Exec) => {
      commands.push(args);
      events.push("then:start");
      await Bun.sleep(20);
      events.push("then:end");
      return options.execResult
        ? await options.execResult(args)
        : "Chunk ID: c1\nWall time: 0.0200 seconds\nProcess exited with code 0\nOutput:\n1 passed\n";
    },
  };
  return { session, operations, commands, events };
}

function boundTools(
  session: object,
  settings: Settings = testSettings(),
  options: Parameters<typeof buildAgentCapabilities>[2] = {},
): FunctionTool[] {
  const caps = buildAgentCapabilities(settings, [], { structuredToolTransport: false, ...options });
  // The SDK binds a clone of every capability to the same session, then reads
  // all their tools; apply_patch resolves exec_command at call time.
  return caps
    .filter((cap) => cap.type === "filesystem" || cap.type === "shell")
    .flatMap((cap) =>
      cap
        .clone()
        .bind(session as never)
        .tools(),
    )
    .filter((candidate): candidate is FunctionTool => candidate.type === "function");
}

function named(tools: FunctionTool[], name: string): FunctionTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No ${name}`);
  return found;
}

const callDetails = (callId: string) =>
  ({ toolCall: { type: "function_call", callId, name: "apply_patch", arguments: "{}" } }) as never;

describe("apply_patch `then` arguments", () => {
  test("splits `then` from the patch arguments", () => {
    expect(splitApplyPatchThenInput(JSON.stringify({ patch: ADD_A, then: "bun test" }))).toEqual({
      patchInput: JSON.stringify({ patch: ADD_A }),
      command: "bun test",
      invalid: null,
    });
    for (const then of [null, "", "  "]) {
      expect(splitApplyPatchThenInput(JSON.stringify({ patch: ADD_A, then }))).toEqual({
        patchInput: JSON.stringify({ patch: ADD_A }),
        command: null,
        invalid: null,
      });
    }
    expect(splitApplyPatchThenInput(JSON.stringify({ patch: ADD_A, then: ["ls"] })).invalid).toBe(
      "`then` must be a string command",
    );
    const raw = `${ADD_A}\nthen`;
    expect(splitApplyPatchThenInput(raw)).toEqual({
      patchInput: raw,
      command: null,
      invalid: null,
    });
  });

  test("only an all-success patch result counts as applied", () => {
    expect(applyPatchSucceeded("Patch applied.")).toBe(true);
    expect(applyPatchSucceeded("Patch applied.\nPatch applied.")).toBe(true);
    expect(applyPatchSucceeded("Patch applied.\nFailed to apply patch: missing")).toBe(false);
    expect(applyPatchSucceeded("Invalid apply_patch arguments: expected")).toBe(false);
    expect(applyPatchSucceeded("")).toBe(false);
    expect(applyPatchSucceeded({ type: "text" })).toBe(false);
  });

  test("the function tool offers `then` by default and can be switched off", () => {
    const { session } = fakeSession();
    const patch = named(boundTools(session), "apply_patch");
    expect(Object.keys(patch.parameters.properties ?? {})).toEqual(["patch", "then"]);
    expect(patch.parameters.required).toEqual(["patch"]);
    expect(patch.parameters.properties?.then).toEqual({
      type: "string",
      description: APPLY_PATCH_THEN_DESCRIPTION,
    });
    expect(patch.description).not.toContain("exactly one argument");
    // Still an exclusive edit (#4672).
    expect(patch.exclusiveExecution).toBe(true);

    const off = named(
      boundTools(session, testSettings({ experimentApplyPatchThen: false })),
      "apply_patch",
    );
    expect(Object.keys(off.parameters.properties ?? {})).toEqual(["patch"]);
    expect(off.description).toContain("Pass exactly one argument, `patch`");
  });

  test("only the `then` variant shows a multi-file example", () => {
    const { session } = fakeSession();
    const multi = JSON.stringify(
      '*** Begin Patch\n*** Update File: src/app.py\n@@\n-greeting = "hi"\n+greeting = "hello"\n*** Add File: notes/example.txt\n+first line\n*** End Patch',
    );
    const single = JSON.stringify(
      "*** Begin Patch\n*** Add File: notes/example.txt\n+first line\n+second line\n*** End Patch",
    );
    const on = named(boundTools(session), "apply_patch");
    expect(on.description).toContain('"+" (add). One patch can change several files. Example');
    expect(on.description).toContain(multi);
    expect(on.parameters.properties?.patch?.description).toContain(multi);

    const off = named(
      boundTools(session, testSettings({ experimentApplyPatchThen: false })),
      "apply_patch",
    );
    expect(off.description).not.toContain("several files");
    expect(off.description).toContain(single);
    expect(off.parameters.properties?.patch?.description).toContain(single);
    expect(JSON.stringify(off)).not.toContain("src/app.py");
  });
});

describe("apply_patch `then` execution", () => {
  test("runs the command through exec_command after the patch applies", async () => {
    const fake = fakeSession();
    const patch = named(boundTools(fake.session), "apply_patch");
    const output = (await patch.invoke(
      {} as never,
      JSON.stringify({ patch: ADD_A, then: "bun test a" }),
      callDetails("call-1"),
    )) as string;
    expect(fake.operations).toHaveLength(1);
    expect(fake.events).toEqual(["patch:start", "patch:end", "then:start", "then:end"]);
    // The lean exec_command defaults applied: it went through the final exec tool.
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]).toMatchObject({
      cmd: "bun test a",
      login: false,
      tty: false,
      yieldTimeMs: 10_000,
    });
    expect(output).toBe(
      "Patch applied.\n\nthen:\nChunk ID: c1\nWall time: 0.0200 seconds\nProcess exited with code 0\nOutput:\n1 passed\n",
    );
  });

  test("a patch without `then` keeps its result unchanged", async () => {
    const fake = fakeSession();
    const patch = named(boundTools(fake.session), "apply_patch");
    expect(await patch.invoke({} as never, JSON.stringify({ patch: ADD_A }))).toBe(
      "Patch applied.",
    );
    expect(await patch.invoke({} as never, JSON.stringify({ patch: ADD_A, then: "" }))).toBe(
      "Patch applied.",
    );
    expect(fake.commands).toEqual([]);
  });

  test("a failed patch does not run the command and says so", async () => {
    const fake = fakeSession({ failPatch: true });
    const patch = named(boundTools(fake.session), "apply_patch");
    const output = (await patch.invoke(
      {} as never,
      JSON.stringify({ patch: ADD_A, then: "bun test" }),
    )) as string;
    expect(fake.commands).toEqual([]);
    expect(output).toBe(
      "Add a.txt failed: file already exists\n\nthen: not run because the patch did not apply.",
    );
  });

  test("an unparseable patch does not run the command", async () => {
    const fake = fakeSession();
    const patch = named(boundTools(fake.session), "apply_patch");
    const output = (await patch.invoke(
      {} as never,
      JSON.stringify({ patch: "*** Begin Patch\n*** Add File: a.txt\n+a", then: "bun test" }),
    )) as string;
    expect(fake.commands).toEqual([]);
    expect(output).toContain("then: not run because the patch did not apply.");
  });

  test("a non-string `then` applies the patch and reports the command as not run", async () => {
    const fake = fakeSession();
    const patch = named(boundTools(fake.session), "apply_patch");
    const output = await patch.invoke({} as never, JSON.stringify({ patch: ADD_A, then: ["ls"] }));
    expect(fake.operations).toHaveLength(1);
    expect(fake.commands).toEqual([]);
    expect(output).toBe("Patch applied.\n\nthen: not run: `then` must be a string command.");
  });

  test("a thrown shell failure is part of the result, never a thrown edit call", async () => {
    const fake = fakeSession({
      execResult: async () => {
        throw new Error("sandbox unavailable");
      },
    });
    // Without a turn controller the SDK renders shell errors; with one, the
    // routing and start-proof wrappers may throw. Both must leave the edit
    // call settled with its applied patch.
    for (const options of [{}, { turnCancellationSignal: new AbortController().signal }]) {
      const patch = named(boundTools(fake.session, testSettings(), options), "apply_patch");
      const output = (await patch.invoke(
        {} as never,
        JSON.stringify({ patch: ADD_A, then: "bun test" }),
        callDetails("call-throw"),
      )) as string;
      expect(output.startsWith("Patch applied.\n\nthen:")).toBe(true);
      expect(output).toContain("sandbox unavailable");
    }
  });

  test("a turn cancelled during the command reports it as exec_command does, after the patch", async () => {
    const turn = new AbortController();
    const fake = fakeSession({
      execResult: async () => {
        turn.abort(new Error("steered"));
        throw new TurnSandboxCommandCancelledError(turn.signal.reason);
      },
    });
    const patch = named(
      boundTools(fake.session, testSettings(), { turnCancellationSignal: turn.signal }),
      "apply_patch",
    );
    const output = (await patch.invoke(
      {} as never,
      JSON.stringify({ patch: ADD_A, then: "sleep 100" }),
    )) as string;
    expect(fake.operations).toHaveLength(1);
    expect(output.startsWith("Patch applied.\n\nthen:")).toBe(true);
    expect(output).toContain("TurnSandboxCommandCancelledError: steered");
  });

  test("secret references in `then` resolve on the shell surface, like exec_command", async () => {
    const resolver = createStaticSecretResolver({ Plain: "plain-then-value" });
    const fake = fakeSession();
    const patch = named(
      boundTools(fake.session, testSettings(), { secretResolver: resolver }),
      "apply_patch",
    );
    await patch.invoke(
      {} as never,
      JSON.stringify({ patch: ADD_A, then: `echo "${PLAIN_REFERENCE}"` }),
      callDetails("call-secret"),
    );
    expect(resolver.calls).toEqual([
      {
        refs: [PLAIN_REFERENCE],
        use: expect.objectContaining({
          surface: "shell",
          toolName: "exec_command",
          sourceCallId: "call-secret:then",
        }),
      },
    ]);
    // The provider gets a variable name, never the value.
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]!.cmd).not.toContain("plain-then-value");
    expect(fake.commands[0]!.cmd).toContain("OPENGENI_SECRET_0");
  });

  test("the edit and its command finish before the next call of the response starts", async () => {
    const fake = fakeSession();
    const tools = boundTools(fake.session).filter((candidate) => candidate.name === "apply_patch");
    const probe = functionTool({
      name: "probe",
      description: "Records when it runs.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      strict: true,
      execute: async () => {
        fake.events.push("probe:start");
        await Bun.sleep(10);
        fake.events.push("probe:end");
        return "ok";
      },
    });
    const calls = [
      {
        id: "call-0",
        type: "function_call",
        callId: "call-0",
        name: "apply_patch",
        status: "completed",
        arguments: JSON.stringify({ patch: ADD_A, then: "bun test" }),
      },
      {
        id: "call-1",
        type: "function_call",
        callId: "call-1",
        name: "probe",
        status: "completed",
        arguments: "{}",
      },
    ] as AgentOutputItem[];
    const model = new ScriptedModel([{ output: calls }, { output: [assistantMessage("done")] }]);
    const agent = new Agent({ name: "patcher", model, tools: [...tools, probe] });
    const result = await new Runner({ tracingDisabled: true }).run(agent, "edit then check");
    expect(result.interruptions).toHaveLength(0);
    expect(fake.events).toEqual([
      "patch:start",
      "patch:end",
      "then:start",
      "then:end",
      "probe:start",
      "probe:end",
    ]);
    const output = result.newItems.find((item) => item.type === "tool_call_output_item");
    expect(JSON.stringify(output!.rawItem)).toContain("1 passed");
  });
});

describe("apply_patch `then` prompt guidance", () => {
  const sentence = APPLY_PATCH_THEN_GUIDANCE;

  test("is on by default and follows the `then` argument", () => {
    expect(agentPromptExperimentsFor(testSettings()).experiments?.applyPatchThenGuidance).toBe(
      true,
    );
    expect(
      agentPromptExperimentsFor(testSettings({ experimentApplyPatchThen: false })).experiments
        ?.applyPatchThenGuidance,
    ).toBe(undefined);
  });

  test("follows the apply_patch rule in the modular sandbox module", () => {
    const text = (experiments?: { applyPatchThenGuidance: true }) =>
      composeModularAgentInstructions({
        capabilities: allAgentCapabilities(),
        renderer: "opengeni",
        identity: DEFAULT_AGENT_IDENTITY,
        resources: ALL_RESOURCES,
        ...(experiments ? { experiments } : {}),
      }).composed;
    const off = text();
    expect(off).not.toContain(sentence);
    const on = text({ applyPatchThenGuidance: true });
    expect(on).toContain(
      `Do not use Python to read or write files when a simple shell command or \`apply_patch\` is enough. ${sentence}\n`,
    );
    expect(on.replace(` ${sentence}`, "")).toBe(off);
  });

  test("follows the apply_patch rule in the legacy operational contract", () => {
    const text = (settings: Settings) =>
      inspectPersistentAgentInstructions(settings, {} as never).layers.find(
        (layer) => layer.id === "operational_contract",
      )!.content;
    const off = text(testSettings({ experimentApplyPatchThen: false }));
    expect(off).not.toContain(sentence);
    const on = text(testSettings());
    expect(on).toContain(
      `Do not use Python to read or write files when a simple shell command or \`apply_patch\` is enough. ${sentence}\n`,
    );
    expect(on.replace(` ${sentence}`, "")).toBe(off);
  });
});
