import { describe, expect, test } from "bun:test";
import {
  Agent,
  Runner,
  tool,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type Tool,
} from "@openai/agents";
import {
  appendToPlainTextToolOutput,
  commandCompletionRoomBytes,
  CommandCompletionDelivery,
  commandCompletionDeliveringTool,
  commandCompletionModelCallFilter,
  commandCompletionToolResolver,
  installCommandCompletionDelivery,
  renderCommandCompletionNotice,
  WAIT_AFTER_UNREAD_COMMAND_RESULTS,
  withoutAppendedCommandCompletions,
  type BackgroundCommandCompletion,
} from "../src/command-completion-delivery";

const finished = (
  commandId: string,
  output: string | null = "ok\n",
): BackgroundCommandCompletion => ({
  commandId,
  summary: `\`make ${commandId}\`: completed successfully.`,
  output,
  notice: null,
});

/** Pending results as the database holds them: each one is taken once. */
function pendingResults(initial: BackgroundCommandCompletion[] = []) {
  const pending = [...initial];
  const delivered: string[] = [];
  const takes: number[] = [];
  return {
    pending,
    delivered,
    takes,
    settle(completion: BackgroundCommandCompletion) {
      pending.push(completion);
    },
    source: {
      take: async ({ maxBytes }: { maxBytes: number }) => {
        takes.push(maxBytes);
        await Bun.sleep(0);
        return pending.splice(0, pending.length);
      },
      onDelivered: (appended: string) => {
        delivered.push(appended);
      },
    },
  };
}

const textTool = (name: string, output: unknown = `${name} done`) =>
  tool({
    name,
    description: name,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
    execute: async () => output as string,
  }) as Tool;

async function invoke(candidate: Tool, callId = crypto.randomUUID()): Promise<unknown> {
  if (candidate.type !== "function") throw new Error("not a function tool");
  return await candidate.invoke({ context: {} } as never, "{}", {
    toolCall: { type: "function_call", callId, name: candidate.name, arguments: "{}" },
  } as never);
}

describe("finished commands follow the next tool result", () => {
  test("plain text results carry the notice; JSON, images and multi-part content never do", () => {
    expect(appendToPlainTextToolOutput("files changed", "N")).toBe("files changed\n\nN");
    expect(appendToPlainTextToolOutput("", "N")).toBe("N");
    expect(appendToPlainTextToolOutput({ type: "text", text: "read" }, "N")).toEqual({
      type: "text",
      text: "read\n\nN",
    });
    expect(appendToPlainTextToolOutput('{"ok":true}', "N")).toBeNull();
    expect(appendToPlainTextToolOutput("[1,2]", "N")).toBeNull();
    expect(appendToPlainTextToolOutput({ type: "text", text: '{"ok":true}' }, "N")).toBeNull();
    expect(appendToPlainTextToolOutput({ type: "image", image: "data:" }, "N")).toBeNull();
    expect(
      appendToPlainTextToolOutput({ type: "text", text: "x", providerData: {} }, "N"),
    ).toBeNull();
    expect(appendToPlainTextToolOutput([{ type: "text", text: "x" }], "N")).toBeNull();
    // Text that merely starts like JSON is still text.
    expect(appendToPlainTextToolOutput("{ not json", "N")).toBe("{ not json\n\nN");
  });

  test("the notice names each command, its status and its bounded output", () => {
    expect(
      renderCommandCompletionNotice([
        finished("a", "line 1\nline 2\n"),
        { ...finished("b", ""), summary: "`false`: exited with code 1." },
        { ...finished("c", null), notice: "Its background children were stopped." },
      ]),
    ).toBe(
      [
        "[Background command finished] `make a`: completed successfully.",
        "Command ID: a",
        "Output:",
        "line 1\nline 2\n",
        "",
        "[Background command finished] `false`: exited with code 1.",
        "Command ID: b",
        "Output: (none)",
        "",
        "[Background command finished] `make c`: completed successfully.",
        "Command ID: c",
        "Its background children were stopped.",
        "Output: read it with command_read.",
      ].join("\n"),
    );
  });

  test("a result settled during other work is appended once, and the timeline strips it", async () => {
    const results = pendingResults();
    const delivery = new CommandCompletionDelivery(results.source);
    const exec = commandCompletionDeliveringTool(textTool("exec_command", "sed output"), delivery);
    expect(await invoke(exec)).toBe("sed output");
    results.settle(finished("build"));
    const withNotice = await invoke(exec);
    const notice = renderCommandCompletionNotice([finished("build")]);
    expect(withNotice).toBe(`sed output\n\n${notice}`);
    expect(results.delivered).toEqual([notice]);
    expect(results.takes.every((bytes) => bytes === 16_384)).toBe(true);
    // Taken results are gone: the next result carries nothing.
    expect(await invoke(exec)).toBe("sed output");
    const appended = new Set(results.delivered);
    expect(withoutAppendedCommandCompletions(withNotice, appended)).toBe("sed output");
    expect(appended.size).toBe(0);
    expect(withoutAppendedCommandCompletions("other", new Set([notice]))).toBe("other");
    // A result can carry several appended texts in turn (a finished command,
    // then a setup notice); the audit view strips each of them.
    const both = new Set([notice, "[Opengeni setup notice] moved"]);
    expect(
      withoutAppendedCommandCompletions(
        `sed output\n\n${notice}\n\n[Opengeni setup notice] moved`,
        both,
      ),
    ).toBe("sed output");
    expect(both.size).toBe(0);
  });

  test("a JSON result takes nothing, so its pending result stays for the next text result", async () => {
    const results = pendingResults([finished("build")]);
    const delivery = new CommandCompletionDelivery(results.source);
    const json = commandCompletionDeliveringTool(textTool("session_get", '{"id":"s"}'), delivery);
    expect(await invoke(json)).toBe('{"id":"s"}');
    expect(results.takes).toEqual([]);
    expect(results.pending).toHaveLength(1);
    const exec = commandCompletionDeliveringTool(textTool("exec_command", "ls"), delivery);
    expect(String(await invoke(exec))).toContain("Command ID: build");
  });

  test("parallel tool calls share the settled results without duplicates", async () => {
    const results = pendingResults([finished("a"), finished("b")]);
    const delivery = new CommandCompletionDelivery(results.source);
    const tools = ["one", "two", "three"].map((name) =>
      commandCompletionDeliveringTool(textTool(name), delivery),
    );
    const outputs = (await Promise.all(tools.map((candidate) => invoke(candidate)))).map(String);
    const mentions = outputs.flatMap((output) => output.match(/Command ID: \w+/g) ?? []);
    expect(mentions.sort()).toEqual(["Command ID: a", "Command ID: b"]);
  });

  test("nothing is taken once the turn is cancelled", async () => {
    const controller = new AbortController();
    const results = pendingResults([finished("a")]);
    const delivery = new CommandCompletionDelivery({
      ...results.source,
      signal: controller.signal,
    });
    controller.abort();
    expect(await invoke(commandCompletionDeliveringTool(textTool("exec_command"), delivery))).toBe(
      "exec_command done",
    );
    expect(results.pending).toHaveLength(1);
  });

  test("a failed take leaves the tool result and the pending results unchanged", async () => {
    const errors: unknown[] = [];
    const delivery = new CommandCompletionDelivery({
      take: async () => {
        throw new Error("database unavailable");
      },
      onError: (error) => errors.push(error),
    });
    expect(await invoke(commandCompletionDeliveringTool(textTool("exec_command"), delivery))).toBe(
      "exec_command done",
    );
    expect(errors).toHaveLength(1);
  });

  test("notices only use the room the tool's own output leaves in the model budget", async () => {
    const results = pendingResults([finished("a")]);
    const delivery = new CommandCompletionDelivery({
      ...results.source,
      maxTextBytes: () => 8_192,
    });
    const small = commandCompletionDeliveringTool(textTool("small", "x".repeat(1_000)), delivery);
    const large = commandCompletionDeliveringTool(textTool("large", "y".repeat(7_000)), delivery);
    // 8192 - 7000 - 512 leaves less than the minimum room: nothing is taken.
    expect(await invoke(large)).toBe("y".repeat(7_000));
    expect(results.takes).toEqual([]);
    expect(results.pending).toHaveLength(1);
    expect(String(await invoke(small))).toContain("Command ID: a");
    expect(results.takes).toEqual([8_192 - 1_000 - 512]);
    expect(commandCompletionRoomBytes(0, 1_000_000)).toBe(16_384);
    expect(commandCompletionRoomBytes(50_000, 40_000)).toBe(0);
  });

  test("a wait in a step whose results already carried commands is refused; the next step may wait", async () => {
    expect(WAIT_AFTER_UNREAD_COMMAND_RESULTS).toContain("your reply was not shown");
    const results = pendingResults([finished("a")]);
    const delivery = new CommandCompletionDelivery(results.source);
    let waits = 0;
    const wait = commandCompletionDeliveringTool(
      tool({
        name: "opengeni__wait_for_input",
        description: "wait",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        strict: true,
        execute: async () => {
          waits++;
          return "Waiting.";
        },
      }) as Tool,
      delivery,
    );
    const exec = commandCompletionDeliveringTool(textTool("exec_command"), delivery);
    const [execOutput, waitOutput] = await Promise.all([
      invoke(exec),
      Bun.sleep(5).then(() => invoke(wait)),
    ]);
    expect(String(execOutput)).toContain("Command ID: a");
    expect(waitOutput).toBe(WAIT_AFTER_UNREAD_COMMAND_RESULTS);
    expect(waits).toBe(0);
    delivery.modelCallStarting();
    expect(await invoke(wait)).toBe("Waiting.");
    expect(waits).toBe(1);
  });

  test("a wait joins an in-flight take before deciding", async () => {
    let release!: (value: BackgroundCommandCompletion[]) => void;
    const delivery = new CommandCompletionDelivery({
      take: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    let waited = false;
    const wait = commandCompletionDeliveringTool(
      tool({
        name: "wait_for_input",
        description: "wait",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        strict: true,
        execute: async () => {
          waited = true;
          return "Waiting.";
        },
      }) as Tool,
      delivery,
    );
    const exec = invoke(commandCompletionDeliveringTool(textTool("exec_command"), delivery));
    await Bun.sleep(0);
    const waiting = invoke(wait);
    await Bun.sleep(5);
    release([finished("a")]);
    expect(String(await exec)).toContain("Command ID: a");
    expect(await waiting).toBe(WAIT_AFTER_UNREAD_COMMAND_RESULTS);
    expect(waited).toBe(false);
  });

  test("after a wait starts, later results in its step take nothing, so the results still wake it", async () => {
    const results = pendingResults([finished("a")]);
    const delivery = new CommandCompletionDelivery(results.source);
    const wait = commandCompletionDeliveringTool(
      textTool("opengeni__wait_for_input", "Waiting."),
      delivery,
    );
    expect(await invoke(wait)).toBe("Waiting.");
    expect(await invoke(commandCompletionDeliveringTool(textTool("exec_command"), delivery))).toBe(
      "exec_command done",
    );
    expect(results.pending).toHaveLength(1);
    expect(results.takes).toEqual([]);
  });

  test("hosted apply_patch edits carry the notice in their output", async () => {
    const results = pendingResults([finished("a")]);
    const delivery = new CommandCompletionDelivery(results.source);
    const editor = {
      createFile: async () => ({ status: "completed", output: "Created a.txt" }),
      updateFile: async () => undefined,
      deleteFile: async () => ({ status: "failed", output: "No such file" }),
    };
    const patch = commandCompletionDeliveringTool(
      { type: "apply_patch", name: "apply_patch", editor } as unknown as Tool,
      delivery,
    ) as unknown as { editor: typeof editor };
    const created = await patch.editor.createFile();
    expect(created).toEqual({
      status: "completed",
      output: `Created a.txt\n\n${renderCommandCompletionNotice([finished("a")])}`,
    });
    expect(await patch.editor.updateFile()).toBeUndefined();
    results.settle(finished("b"));
    expect(await patch.editor.deleteFile()).toEqual({
      status: "failed",
      output: `No such file\n\n${renderCommandCompletionNotice([finished("b")])}`,
    });
  });

  test("agent installation covers getAllTools, clones, late-bound tools and model calls", async () => {
    const results = pendingResults();
    const delivery = new CommandCompletionDelivery(results.source);
    const agent = new Agent({ name: "a", tools: [textTool("exec_command")] });
    expect(commandCompletionModelCallFilter(agent)).toBeUndefined();
    installCommandCompletionDelivery(agent, delivery);
    installCommandCompletionDelivery(agent, delivery);
    const [exec] = await agent.getAllTools({ context: {} } as never);
    const [again] = await agent.getAllTools({ context: {} } as never);
    expect(again).toBe(exec!);
    results.settle(finished("a"));
    expect(String(await invoke(exec!))).toContain("Command ID: a");
    const clone = agent.clone({});
    results.settle(finished("b"));
    const [cloned] = await clone.getAllTools({ context: {} } as never);
    expect(String(await invoke(cloned!))).toContain("Command ID: b");
    const resolver = commandCompletionToolResolver(agent, async () => textTool("late"));
    results.settle(finished("c"));
    expect(String(await invoke((await resolver!({} as never))!))).toContain("Command ID: c");
    expect(commandCompletionToolResolver(new Agent({ name: "b" }), undefined)).toBeUndefined();
    const filter = commandCompletionModelCallFilter(agent)!;
    const modelData = { input: [], instructions: "" };
    expect(await filter({ modelData, agent, context: {} } as never)).toBe(modelData);
  });
});

class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  constructor(
    private outputs: ModelResponse["output"][],
    private beforeResponse: (index: number) => void = () => {},
  ) {}
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    this.beforeResponse(this.requests.length - 1);
    return {
      usage: new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      output: this.outputs[this.requests.length - 1]!,
    };
  }
  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    throw new Error("not streamed");
  }
}

const call = (id: string, name: string) => ({
  type: "function_call" as const,
  callId: id,
  name,
  arguments: "{}",
});
const done = {
  type: "message" as const,
  role: "assistant" as const,
  status: "completed" as const,
  content: [{ type: "output_text" as const, text: "done" }],
};

test("in a run, the model reads a result settled during its tool call, and earlier input never changes", async () => {
  const results = pendingResults();
  const delivery = new CommandCompletionDelivery(results.source);
  const agent = new Agent({
    name: "runner",
    model: "scripted",
    tools: [
      tool({
        name: "exec_command",
        description: "exec",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        strict: true,
        execute: async () => {
          // The background build finishes while the model's sed runs.
          results.settle(finished("build", "PASS 12 tests\n"));
          return "sed: 3 lines";
        },
      }),
      textTool("apply_patch_fn", "Done!"),
    ],
  });
  installCommandCompletionDelivery(agent, delivery);
  const model = new ScriptedModel([
    [call("c1", "exec_command")],
    [call("c2", "apply_patch_fn")],
    [done],
  ]);
  const filter = commandCompletionModelCallFilter(agent)!;
  const result = await new Runner({ modelProvider: { getModel: () => model } }).run(agent, "go", {
    callModelInputFilter: filter,
  });
  expect(result.finalOutput).toBe("done");
  const outputs = (request: ModelRequest) =>
    (request.input as Array<{ type?: string; callId?: string; output?: unknown }>).filter(
      (item) => item.type === "function_call_result",
    );
  const second = outputs(model.requests[1]!);
  expect(JSON.stringify(second[0]!.output)).toContain("PASS 12 tests");
  expect(JSON.stringify(second[0]!.output)).toContain("Command ID: build");
  // The third request repeats the second request's input byte for byte.
  const third = model.requests[2]!.input as unknown[];
  const secondInput = model.requests[1]!.input as unknown[];
  expect(third.slice(0, secondInput.length)).toEqual(secondInput);
  expect(JSON.stringify(outputs(model.requests[2]!)[1]!.output)).not.toContain("Command ID");
});
