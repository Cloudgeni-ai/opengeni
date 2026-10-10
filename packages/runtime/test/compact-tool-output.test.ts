import { afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testSettings } from "@opengeni/testing";
import {
  COMPACT_TOOL_OUTPUT_ENV,
  commandReadsFiles,
  compactExecResponse,
  compactShellOutputBody,
  compactToolOutputEnabled,
  execCommandOutputPolicy,
  foldRepeatedLines,
  groupGrepRows,
  minifyJsonBody,
  renderTerminalText,
  splitExecResponse,
  withCompactShellToolOutput,
} from "../src/sandbox/compact-tool-output";
import { parseExecResponseBanner } from "../src/sandbox/exec-banner";
import { buildAgentCapabilities, createSandboxClientForBackend } from "../src/index";

// Real model-visible outputs recorded in the ab7 DeepSWE benchmark arm.
type Fixture = { source: string; tool: string; args: Record<string, unknown>; output: string };
const fixtures = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures/compact-tool-output/ab7-shell-outputs.json"),
    "utf8",
  ),
) as Record<string, Fixture>;
const fixture = (name: string): Fixture => {
  const value = fixtures[name];
  if (!value) throw new Error(`missing fixture ${name}`);
  return value;
};

type FakeTool = {
  type: "function";
  name: string;
  invoke: (runContext: unknown, input: string) => Promise<unknown>;
};

/** Fake shell tools that replay recorded outputs, wrapped like production. */
function replayTools(outputs: { exec?: string[]; poll?: string[] }) {
  const exec = [...(outputs.exec ?? [])];
  const poll = [...(outputs.poll ?? [])];
  const tools: FakeTool[] = [
    { type: "function", name: "exec_command", invoke: async () => exec.shift() },
    { type: "function", name: "write_stdin", invoke: async () => poll.shift() },
    {
      type: "function",
      name: "apply_patch",
      invoke: async () => "Process exited with code 0\n\nOutput:\nA\nA\nA\nA\n",
    },
  ];
  const wrapped = withCompactShellToolOutput(tools);
  const byName = (name: string) => wrapped.find((tool) => tool.name === name)!;
  return {
    exec: (args: Record<string, unknown>) =>
      byName("exec_command").invoke({}, JSON.stringify(args)),
    poll: (args: Record<string, unknown>) => byName("write_stdin").invoke({}, JSON.stringify(args)),
    other: () => byName("apply_patch").invoke({}, "{}"),
  };
}

/** Undo grep grouping: a bare path heading followed by `N:` / `N-` rows. */
function expandGrepGroups(text: string, paths: string[]): string {
  const out: string[] = [];
  let path: string | null = null;
  for (const line of text.split("\n")) {
    if (paths.includes(line)) {
      path = line;
      continue;
    }
    const row = path ? /^(\d+)([:-])(.*)$/su.exec(line) : null;
    if (path && row) {
      out.push(`${path}${row[2]}${row[1]}${row[2]}${row[3]}`);
      continue;
    }
    if (line === "--" && path) {
      out.push(line);
      continue;
    }
    path = null;
    out.push(line);
  }
  return out.join("\n");
}

describe("compact tool output flag", () => {
  test("is off unless explicitly set to 1", () => {
    expect(compactToolOutputEnabled({})).toBe(false);
    expect(compactToolOutputEnabled({ [COMPACT_TOOL_OUTPUT_ENV]: "0" })).toBe(false);
    expect(compactToolOutputEnabled({ [COMPACT_TOOL_OUTPUT_ENV]: "true" })).toBe(false);
    expect(compactToolOutputEnabled({ [COMPACT_TOOL_OUTPUT_ENV]: "1" })).toBe(true);
  });
});

describe("compactExecResponse on recorded ab7 outputs", () => {
  test("grep rows group under one heading per file, losslessly", () => {
    const { output, args } = fixture("grep-rn");
    const policy = execCommandOutputPolicy(args);
    const compacted = compactExecResponse(output, policy);
    const split = splitExecResponse(compacted)!;
    expect(split.header).toBe("Process exited with code 127\n\nOutput:\n");
    expect(split.body).toContain(
      "./evaluator/evaluator.go\n207:\tcase *ast.IndexExpression:\n208:",
    );
    expect(split.body).toContain(
      "./parser/parser.go\n81:\tprevIndexExpression *ast.IndexExpression\n",
    );
    expect(compacted.length).toBeLessThan(output.length * 0.85);
    const paths = ["./evaluator/evaluator.go", "./parser/parser.go", "./ast/ast.go"];
    expect(expandGrepGroups(split.body, paths)).toBe(splitExecResponse(output)!.body);
  });

  test("go module download progress folds to first, count, last", () => {
    const { output, args } = fixture("go-downloading");
    // The heredoc writes a Go file; it is not a file read, so lossy folding applies.
    expect(commandReadsFiles(args.cmd as string)).toBe(false);
    const compacted = compactExecResponse(output, execCommandOutputPolicy(args));
    expect(compacted).toBe(
      [
        "Process exited with code 0",
        "",
        "Output:",
        "go: downloading k8s.io/client-go v0.35.1",
        "[... 18 more dependency download/install progress lines omitted; prefix the command with OPENGENI_RAW_OUTPUT=1 to see every line]",
        "go: downloading github.com/santhosh-tekuri/jsonschema/v6 v6.0.2",
        "",
      ].join("\n"),
    );
  });

  test("ANSI color is removed while tsc errors and vitest summary stay", () => {
    const { output } = fixture("vitest-tsc-color-poll");
    const compacted = compactExecResponse(output, {
      pty: true,
      terminal: true,
      lossy: true,
    });
    expect(compacted).not.toContain("\x1b");
    expect(compacted).toContain(
      "src/schema/requiredIf.unit.test.ts:70:31 - error TS2339: Property 'build' does not exist on type 'ItemSchema<ItemAttributes>'.",
    );
    expect(compacted).toContain("Found 1 error in src/schema/requiredIf.unit.test.ts:70");
    expect(compacted).toContain("Tests  1283 passed (1283)");
    expect(compacted.startsWith("Process running with session ID 10\n\nOutput:\n")).toBe(true);
  });

  test("carriage-return progress bars resolve to the final frame; errors stay", () => {
    const { output, args } = fixture("progress-bars");
    const compacted = compactExecResponse(output, execCommandOutputPolicy(args));
    expect(compacted).not.toContain("\r");
    expect(compacted).not.toContain("\x1b");
    expect(compacted).not.toContain("35%");
    expect(compacted).toContain("  [####################################]  100%\n0\n");
    expect(compacted).toContain("\nError: UNIQUE constraint failed: t.id\n");
    expect(compacted).toContain("E   ModuleNotFoundError: No module named 'hypothesis'\n");
    expect(compacted).toContain("\n1 error in 0.59s\n");
  });

  test("PTY CRLF becomes LF and git status color is removed", () => {
    const { output, args } = fixture("vitest-git-status-crlf");
    expect(commandReadsFiles(args.cmd as string)).toBe(false);
    const compacted = compactExecResponse(output, execCommandOutputPolicy(args));
    expect(compacted).not.toContain("\r");
    expect(compacted).toContain("\n M src/transformer.ts\n?? bun.lock\n");
    expect(compacted).toContain("stderr | src/index.test.ts > stringify & parse > regression #65");
    const lines = (text: string) => text.replace(/\r\n/gu, "\n").split("\n").length;
    expect(lines(compacted)).toBe(lines(output));
  });

  test("a file read only loses PTY carriage returns", () => {
    const { output, args } = fixture("sed-read-crlf");
    expect(commandReadsFiles(args.cmd as string)).toBe(true);
    const policy = execCommandOutputPolicy(args);
    expect(policy).toMatchObject({ terminal: false, lossy: false });
    const compacted = compactExecResponse(output, policy);
    expect(compacted.startsWith("Chunk ID: c1efe5\nWall time: 0.0650 seconds\n")).toBe(true);
    expect(compacted).toBe(output.replace(/\r\n/gu, "\n"));
  });
});

describe("shell tool wrapper", () => {
  const okPoll = fixture("go-test-ok-poll");
  const running = "Process running with session ID 7\n\nOutput:\n";

  test("polls of a yielded go test follow the exec policy and fold passing packages", async () => {
    const tools = replayTools({ exec: [running], poll: [okPoll.output] });
    expect(
      await tools.exec({ cmd: "cd /workspace/repo && go test ./pkg/... 2>&1 | tail -40" }),
    ).toBe(running);
    const polled = (await tools.poll(okPoll.args)) as string;
    expect(polled).toContain("?   \thelm.sh/helm/v4/pkg/chart\t[no test files]\n");
    expect(polled).toContain(
      "ok  \thelm.sh/helm/v4/pkg/chart/common\t0.023s\n[... 18 more passing-test lines",
    );
    expect(polled.endsWith("ok  \thelm.sh/helm/v4/pkg/cmd/search\t0.010s\n")).toBe(true);
  });

  test("polls of an unknown session stay lossless", async () => {
    const tools = replayTools({ poll: [okPoll.output] });
    expect(await tools.poll(okPoll.args)).toBe(okPoll.output);
  });

  test("OPENGENI_RAW_OUTPUT=1 returns exec and poll output byte-for-byte", async () => {
    const download = fixture("go-downloading").output;
    const tools = replayTools({ exec: [download, running], poll: [okPoll.output] });
    expect(await tools.exec({ cmd: "OPENGENI_RAW_OUTPUT=1 go build ./..." })).toBe(download);
    await tools.exec({ cmd: "OPENGENI_RAW_OUTPUT=1 go test ./..." });
    expect(await tools.poll(okPoll.args)).toBe(okPoll.output);
  });

  test("a failing test inside a passing run stays verbatim and splits the fold", async () => {
    const pass = (n: number) => `--- PASS: TestCase${n} (0.00s)`;
    const body = [
      ...Array.from({ length: 14 }, (_, n) => pass(n)),
      "--- FAIL: TestMerge (0.01s)",
      "    merge_test.go:42: got 1, want 2",
      ...Array.from({ length: 14 }, (_, n) => pass(n + 14)),
      "FAIL",
      "",
    ].join("\n");
    const output = `Process exited with code 1\n\nOutput:\n${body}`;
    const tools = replayTools({ exec: [output] });
    const compacted = (await tools.exec({ cmd: "go test -v ./...", tty: false })) as string;
    expect(compacted).toContain(
      `${pass(13)}\n--- FAIL: TestMerge (0.01s)\n    merge_test.go:42: got 1, want 2\n${pass(14)}\n`,
    );
    expect(compacted.match(/12 more passing-test lines omitted/gu)).toHaveLength(2);
    expect(compacted.endsWith("\nFAIL\n")).toBe(true);
  });

  test("non-shell tools are untouched", async () => {
    expect(await replayTools({}).other()).toBe(
      "Process exited with code 0\n\nOutput:\nA\nA\nA\nA\n",
    );
  });
});

describe("lossless transforms", () => {
  test("consecutive identical lines fold with an exact count", () => {
    expect(foldRepeatedLines("a\nwarn x\nwarn x\nwarn x\nwarn x\nb\n\n\n\n")).toBe(
      "a\nwarn x\n[previous line repeated 3 more times]\nb\n\n\n\n",
    );
    expect(foldRepeatedLines("x\nx\ny")).toBe("x\nx\ny");
  });

  test("JSON minification keeps every lexeme", () => {
    const pretty = JSON.stringify(
      { version: "1.0", ratio: 1.0, exp: 1e-7, text: "a  b\n  c", nested: [{ "k ": " v " }] },
      null,
      2,
    ).replace('"ratio": 1', '"ratio": 1.0');
    const minified = minifyJsonBody(`${pretty}\n`);
    expect(minified).toBe(
      '{"version":"1.0","ratio":1.0,"exp":1e-7,"text":"a  b\\n  c","nested":[{"k ":" v "}]}\n',
    );
    expect(JSON.parse(minified)).toEqual(JSON.parse(pretty));
    expect(minifyJsonBody("not json {\n  }")).toBe("not json {\n  }");
  });

  test("grep groups are not formed when the next line looks like a numbered row", () => {
    const text = "a/b.go:1:x\na/b.go:2:y\na/b.go:3:z\n4:loose";
    expect(groupGrepRows(text)).toBe(text);
    expect(groupGrepRows("12:30:45 started\n12:30:46 done\n12:30:47 x")).toBe(
      "12:30:45 started\n12:30:46 done\n12:30:47 x",
    );
  });

  test("an erase-line sequence clears the rest of an overwritten line", () => {
    expect(renderTerminalText("downloading 100 files\r\x1b[2Kdone")).toBe("done");
    expect(renderTerminalText("abcdef\rXY")).toBe("XYcdef");
  });

  test("non-PTY output keeps literal carriage returns in CRLF data", () => {
    const body = "a,b\r\nc,d\r\n";
    expect(compactShellOutputBody(body, { pty: false, terminal: false, lossy: false })).toBe(body);
  });

  test("file-read classification", () => {
    expect(commandReadsFiles("cat foo.go")).toBe(true);
    expect(commandReadsFiles("cd x && sed -n 1,20p a.py")).toBe(true);
    expect(commandReadsFiles("grep -rn foo . | head")).toBe(true);
    expect(commandReadsFiles("git diff --stat")).toBe(true);
    expect(commandReadsFiles("go test ./... 2>&1 | tail -30")).toBe(false);
    expect(commandReadsFiles("npm test | grep -v PASS")).toBe(false);
    expect(commandReadsFiles("cat > t.py <<'EOF'\nhead = 1\ncat x\nEOF\npython3 t.py")).toBe(false);
    expect(
      commandReadsFiles("cat > t.py <<'EOF'\nprint(1)\nEOF\npython3 t.py && cat out.txt"),
    ).toBe(true);
  });
});

// End to end through the production capability composition and a real local
// sandbox PTY: what the model would receive with the flag on.
describe.skipIf(process.platform !== "linux")("production composition with the flag on", () => {
  const sessions: Array<{ close(): Promise<void> }> = [];
  const previous = process.env[COMPACT_TOOL_OUTPUT_ENV];

  afterEach(async () => {
    if (previous === undefined) delete process.env[COMPACT_TOOL_OUTPUT_ENV];
    else process.env[COMPACT_TOOL_OUTPUT_ENV] = previous;
    for (const session of sessions.splice(0)) await session.close();
  });

  async function shellTools(flag: string | undefined) {
    if (flag === undefined) delete process.env[COMPACT_TOOL_OUTPUT_ENV];
    else process.env[COMPACT_TOOL_OUTPUT_ENV] = flag;
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const client = createSandboxClientForBackend("local", settings) as {
      create(manifest?: unknown): Promise<{ close(): Promise<void> }>;
    };
    const session = await client.create({});
    sessions.push(session);
    const capability = buildAgentCapabilities(settings, []).find((cap) => cap.type === "shell")!;
    const tools = capability
      .clone()
      .bind(session as never)
      .tools();
    const find = (name: string) =>
      tools.find(
        (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
          tool.type === "function" && tool.name === name,
      )!;
    return { exec: find("exec_command"), write: find("write_stdin") };
  }

  async function run(flag: string | undefined, cmd: string): Promise<string> {
    const { exec, write } = await shellTools(flag);
    let current = String(
      await exec.invoke({} as never, JSON.stringify({ cmd, yield_time_ms: 10_000 })),
    );
    let output = current;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const banner = parseExecResponseBanner(current);
      if (banner.kind !== "running") break;
      current = String(
        await write.invoke(
          {} as never,
          JSON.stringify({ session_id: banner.sessionId, chars: "", yield_time_ms: 1_000 }),
        ),
      );
      output += current;
    }
    return output;
  }

  const cmd = [
    'for i in $(seq 1 20); do echo "go: downloading example.com/mod$i v1.0.$i"; done',
    "printf '\\033[31mred\\033[0m\\n'",
    "printf 'step 1\\rstep 2\\rstep 3\\n'",
    "echo 'error: build failed'",
  ].join("; ");

  test("flag on: the model sees compacted output with failures intact", async () => {
    const output = await run("1", cmd);
    expect(output).not.toContain("\r");
    expect(output).not.toContain("\x1b");
    expect(output).toContain("go: downloading example.com/mod1 v1.0.1\n[... 18 more dependency");
    expect(output).toContain(
      "go: downloading example.com/mod20 v1.0.20\nred\nstep 3\nerror: build failed",
    );
  }, 30_000);

  test("flag off: output is unchanged", async () => {
    const output = await run(undefined, cmd);
    expect(output).toContain("\x1b[31mred");
    expect(output).toContain("go: downloading example.com/mod2 v1.0.2");
  }, 30_000);
});
