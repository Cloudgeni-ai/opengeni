import { afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import {
  LEAN_EXEC_COMMAND_DEFAULTS,
  LEAN_EXEC_COMMAND_PARAMETERS,
  OUTPUT_COST_EXPERIMENT_ENV,
  canonicalizeLeanExecCommandInput,
  outputCostExperimentEnabled,
  withLeanExecCommandArguments,
} from "../src/sandbox/lean-exec-arguments";
import { buildAgentCapabilities, createSandboxClientForBackend } from "../src/index";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;

const originalFlag = process.env[OUTPUT_COST_EXPERIMENT_ENV];
const sessions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  if (originalFlag === undefined) delete process.env[OUTPUT_COST_EXPERIMENT_ENV];
  else process.env[OUTPUT_COST_EXPERIMENT_ENV] = originalFlag;
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
});

describe("outputCostExperimentEnabled", () => {
  test("is on only for the exact value 1", () => {
    expect(outputCostExperimentEnabled({})).toBe(false);
    expect(outputCostExperimentEnabled({ [OUTPUT_COST_EXPERIMENT_ENV]: "0" })).toBe(false);
    expect(outputCostExperimentEnabled({ [OUTPUT_COST_EXPERIMENT_ENV]: "true" })).toBe(false);
    expect(outputCostExperimentEnabled({ [OUTPUT_COST_EXPERIMENT_ENV]: "1" })).toBe(true);
  });
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
});

describe("composed shell capability", () => {
  async function execTool(
    flag: string | undefined,
    options: Parameters<typeof buildAgentCapabilities>[2] = {},
  ): Promise<FunctionTool> {
    if (flag === undefined) delete process.env[OUTPUT_COST_EXPERIMENT_ENV];
    else process.env[OUTPUT_COST_EXPERIMENT_ENV] = flag;
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const client = createSandboxClientForBackend("local", settings) as {
      create(manifest?: unknown): Promise<{ close(): Promise<void> }>;
    };
    const session = await client.create({});
    sessions.push(session);
    const capability = buildAgentCapabilities(settings, [], options).find(
      (cap) => cap.type === "shell",
    )!;
    const tools = capability
      .clone()
      .bind(session as never)
      .tools();
    return tools.find(
      (tool): tool is FunctionTool => tool.type === "function" && tool.name === "exec_command",
    )!;
  }

  test("flag off keeps the strict SDK schema that requires every argument", async () => {
    const exec = await execTool(undefined);
    const parameters = exec.parameters as unknown as { required: string[] };
    expect(exec.strict).toBe(true);
    expect([...parameters.required].sort()).toEqual(
      ["cmd", "login", "max_output_tokens", "shell", "tty", "workdir", "yield_time_ms"].sort(),
    );
  });

  test("flag on exposes the lean schema and runs a call with only cmd and max_output_tokens", async () => {
    const exec = await execTool("1");
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
    const exec = await execTool("1");
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
    const exec = await execTool("1", { turnCancellationSignal: abort.signal });
    const probe = "[ -t 1 ] && echo HAS-TTY || echo NO-TTY";
    const omitted = String(
      await exec.invoke({} as never, JSON.stringify({ cmd: probe, max_output_tokens: 200 })),
    );
    expect(omitted).toContain("NO-TTY");
    abort.abort(new Error("test done"));
  });
});
