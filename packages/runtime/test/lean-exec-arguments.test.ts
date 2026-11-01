import { afterEach, describe, expect, test } from "bun:test";
import { Agent, run as runAgent, type Tool } from "@openai/agents";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import {
  LEAN_EXEC_COMMAND_DEFAULTS,
  LEAN_EXEC_COMMAND_PARAMETERS,
  LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_FINISH_FLOOR,
  LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN,
  LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN_OR_FINISH_FLOOR,
  canonicalizeLeanExecCommandInput,
  withLeanExecCommandArguments,
} from "../src/sandbox/lean-exec-arguments";
import { buildAgentCapabilities, createSandboxClientForBackend } from "../src/index";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;

const sessions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
});

describe("canonicalizeLeanExecCommandInput", () => {
  test("fills omitted login, tty and yield_time_ms with today's canonical values", () => {
    expect(
      JSON.parse(
        canonicalizeLeanExecCommandInput(JSON.stringify({ cmd: "ls", max_output_tokens: 500 })),
      ),
    ).toEqual({ cmd: "ls", max_output_tokens: 500, ...LEAN_EXEC_COMMAND_DEFAULTS });
  });

  test("keeps every explicitly supplied value, including null", () => {
    const explicit = JSON.stringify({
      cmd: "ls",
      workdir: null,
      shell: null,
      login: true,
      tty: null,
      yield_time_ms: 60_000,
      max_output_tokens: 500,
    });
    expect(canonicalizeLeanExecCommandInput(explicit)).toBe(explicit);
    // A full strict-mode argument object (what models send today) is untouched.
    const strictShape = JSON.stringify({
      cmd: "ls",
      workdir: "/workspace",
      shell: "bash",
      login: false,
      tty: false,
      yield_time_ms: 10_000,
      max_output_tokens: 4000,
    });
    expect(canonicalizeLeanExecCommandInput(strictShape)).toBe(strictShape);
  });

  test("passes non-object and malformed input through unchanged", () => {
    for (const input of ["not json", "[1,2]", "null", '"ls"', "{"]) {
      expect(canonicalizeLeanExecCommandInput(input)).toBe(input);
    }
  });
});

describe("withLeanExecCommandArguments", () => {
  test("replaces only exec_command's schema and canonicalizes its input", async () => {
    const seen: unknown[] = [];
    const tools = [
      {
        type: "function",
        name: "exec_command",
        description: "original",
        parameters: { type: "object", properties: {}, required: [] },
        strict: true,
        invoke: async (_context: unknown, input: unknown) => {
          seen.push(input);
          return "ok";
        },
      },
      {
        type: "function",
        name: "write_stdin",
        description: "untouched",
        parameters: { type: "object" },
        strict: true,
        invoke: async () => "stdin",
      },
    ] as unknown as Tool<unknown>[];
    const [exec, stdin] = withLeanExecCommandArguments(tools) as FunctionTool[];
    expect(exec!.strict).toBe(false);
    expect(exec!.parameters as unknown).toEqual(LEAN_EXEC_COMMAND_PARAMETERS);
    expect(stdin).toBe(tools[1] as FunctionTool);

    await exec!.invoke({} as never, JSON.stringify({ cmd: "pwd", max_output_tokens: 100 }));
    expect(JSON.parse(seen[0] as string)).toEqual({
      cmd: "pwd",
      max_output_tokens: 100,
      login: false,
      tty: false,
      yield_time_ms: 10_000,
    });
  });

  test("names write_stdin in the tty hint only when the same list offers it", () => {
    const exec = {
      type: "function",
      name: "exec_command",
      description: "original",
      parameters: { type: "object", properties: {}, required: [] },
      strict: true,
      invoke: async () => "ok",
    } as unknown as Tool<unknown>;
    const stdin = {
      type: "function",
      name: "write_stdin",
      description: "untouched",
      parameters: { type: "object" },
      strict: true,
      invoke: async () => "stdin",
    } as unknown as Tool<unknown>;
    const [withStdin] = withLeanExecCommandArguments([exec, stdin]) as FunctionTool[];
    const [withoutStdin] = withLeanExecCommandArguments([exec]) as FunctionTool[];
    expect(withStdin!.parameters as unknown).toBe(LEAN_EXEC_COMMAND_PARAMETERS);
    expect(withoutStdin!.parameters as unknown).toBe(
      LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN,
    );
    // The two schemas differ only in that one hint; every other byte is shared.
    expect(JSON.stringify(LEAN_EXEC_COMMAND_PARAMETERS.properties.tty)).toBe(
      '{"type":"boolean","description":"Allocate a TTY (needed to interrupt the process later with Ctrl-C through write_stdin). Omit for the default of false."}',
    );
    expect(JSON.stringify(LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN.properties.tty)).toBe(
      '{"type":"boolean","description":"Allocate a TTY. Omit for the default of false."}',
    );
    expect(
      JSON.stringify({
        ...LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN,
        properties: { ...LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN.properties, tty: null },
      }),
    ).toBe(
      JSON.stringify({
        ...LEAN_EXEC_COMMAND_PARAMETERS,
        properties: { ...LEAN_EXEC_COMMAND_PARAMETERS.properties, tty: null },
      }),
    );
  });
});

describe("composed shell capability", () => {
  test("the finish-floor variant describes the floor and offers background; the other keeps today's schema", () => {
    expect(LEAN_EXEC_COMMAND_PARAMETERS.properties.yield_time_ms.description).toContain(
      "Without `tty` or `background` the wait is at least 60000.",
    );
    expect(LEAN_EXEC_COMMAND_PARAMETERS.properties).toHaveProperty("background");
    expect(LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN.properties).toHaveProperty(
      "background",
    );
    for (const parameters of [
      LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_FINISH_FLOOR,
      LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN_OR_FINISH_FLOOR,
    ]) {
      expect(parameters.properties).not.toHaveProperty("background");
      expect(parameters.properties.yield_time_ms.description).toBe(
        "How long to wait (in milliseconds) for output before yielding. Omit for the default of 10000.",
      );
    }
    const exec = {
      type: "function",
      name: "exec_command",
      description: "original",
      parameters: { type: "object", properties: {}, required: [] },
      strict: true,
      invoke: async () => "ok",
    } as unknown as Tool<unknown>;
    const [withoutFloor] = withLeanExecCommandArguments([exec], {
      finishFloor: false,
    }) as FunctionTool[];
    expect(withoutFloor!.parameters as unknown).toBe(
      LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN_OR_FINISH_FLOOR,
    );
  });

  async function shellTools(
    lean: boolean,
    options: Parameters<typeof buildAgentCapabilities>[2] = {},
    sessionOverrides: Record<string, unknown> = {},
  ): Promise<Tool<unknown>[]> {
    const settings = testSettings({
      sandboxBackend: "local",
      webSearchEnabled: false,
      experimentOutputCost: lean,
    });
    const client = createSandboxClientForBackend("local", settings) as {
      create(manifest?: unknown): Promise<{ close(): Promise<void> }>;
    };
    const session = await client.create({});
    sessions.push(session);
    Object.assign(session, sessionOverrides);
    const capability = buildAgentCapabilities(settings, [], options).find(
      (cap) => cap.type === "shell",
    )!;
    return capability
      .clone()
      .bind(session as never)
      .tools();
  }

  async function execTool(
    lean: boolean,
    options: Parameters<typeof buildAgentCapabilities>[2] = {},
  ): Promise<FunctionTool> {
    const tools = await shellTools(lean, options);
    return tools.find(
      (tool): tool is FunctionTool => tool.type === "function" && tool.name === "exec_command",
    )!;
  }

  /** The tool block one provider request carries for these tools. */
  async function requestToolBlock(tools: Tool<unknown>[]): Promise<string> {
    const model = new ScriptedModel("done");
    await runAgent(new Agent({ name: "turn", model, tools }), "hi");
    return JSON.stringify(model.requests[0]!.tools);
  }

  test("a session without write_stdin sends a tool block that never names it", async () => {
    const interactive = await requestToolBlock(await shellTools(true));
    const noStdin = await requestToolBlock(
      await shellTools(true, {}, { supportsPty: () => false }),
    );
    expect(interactive).toContain('"name":"write_stdin"');
    expect(interactive).toContain("Ctrl-C through write_stdin");
    expect(noStdin).not.toContain("write_stdin");
    expect(noStdin).toContain('"description":"Allocate a TTY. Omit for the default of false."');
    // Every later request of the same placement repeats the block byte for byte.
    expect(await requestToolBlock(await shellTools(true, {}, { supportsPty: () => false }))).toBe(
      noStdin,
    );
    expect(await requestToolBlock(await shellTools(true))).toBe(interactive);
  });

  test("disabled keeps the strict SDK schema that requires every argument", async () => {
    const exec = await execTool(false);
    const parameters = exec.parameters as unknown as { required: string[] };
    expect(exec.strict).toBe(true);
    expect([...parameters.required].sort()).toEqual(
      ["cmd", "login", "max_output_tokens", "shell", "tty", "workdir", "yield_time_ms"].sort(),
    );
  });

  test("enabled exposes the lean schema and runs a call with only cmd and max_output_tokens", async () => {
    const exec = await execTool(true);
    expect(exec.strict).toBe(false);
    expect((exec.parameters as unknown as { required: string[] }).required).toEqual([
      "cmd",
      "max_output_tokens",
    ]);
    const output = String(
      await exec.invoke(
        {} as never,
        JSON.stringify({ cmd: "echo lean-exec-ok", max_output_tokens: 200 }),
      ),
    );
    expect(output).toContain("lean-exec-ok");
  });

  test("an omitted login runs a non-login shell, as models choose today", async () => {
    const probe = "shopt -q login_shell && echo LOGIN-SHELL || echo NON-LOGIN-SHELL";
    const exec = await execTool(true);
    const omitted = String(
      await exec.invoke(
        {} as never,
        JSON.stringify({ cmd: probe, shell: "bash", max_output_tokens: 200 }),
      ),
    );
    expect(omitted).toContain("NON-LOGIN-SHELL");
    const explicit = String(
      await exec.invoke(
        {} as never,
        JSON.stringify({ cmd: probe, shell: "bash", login: true, max_output_tokens: 200 }),
      ),
    );
    expect(explicit).toContain("LOGIN-SHELL");
    expect(explicit).not.toContain("NON-LOGIN-SHELL");
  });

  test("with the turn cancellation fence an omitted tty still runs without a TTY", async () => {
    const abort = new AbortController();
    const exec = await execTool(true, { turnCancellationSignal: abort.signal });
    const probe = "[ -t 1 ] && echo HAS-TTY || echo NO-TTY";
    const omitted = String(
      await exec.invoke({} as never, JSON.stringify({ cmd: probe, max_output_tokens: 200 })),
    );
    expect(omitted).toContain("NO-TTY");
    abort.abort(new Error("test done"));
  });
});
