import { describe, expect, test } from "bun:test";
import type { AgentInputItem } from "@openai/agents";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  allAgentCapabilities,
  readStartingContext,
  repositorySkillsContextItem,
  startingContextItem,
} from "@opengeni/contracts";
import {
  PARALLEL_TOOL_CALLS_RULE,
  PARALLEL_TOOL_CALLS_RULE_WITH_EXAMPLE,
} from "../src/agent-instructions/base-behavior";
import { whitespaceTolerantDiff } from "../src/apply-patch-robust";
import {
  collapseRepeatedLines,
  compactCommandOutput,
  lastProgressStates,
  minifyJsonBody,
  stripAnsi,
} from "../src/command-output-compaction";
import {
  installModelToolResultStore,
  storeOversizedFunctionToolOutput,
  type ModelToolResultStore,
} from "../src/model-tool-result-store";
import {
  PASSING_CHECK_TRIM_MIN_BYTES,
  isCheckCommand,
  passingCheckOutput,
  passingCheckView,
} from "../src/passing-check-output";
import { repositorySkillsContextInputFilter } from "../src/repository-skills-context";
import { renderStartingContext, STARTING_CONTEXT_PROBE } from "../src/starting-context";
import {
  agentPromptExperimentsFor,
  composeModularAgentInstructions,
  DEFAULT_AGENT_IDENTITY,
  inspectPersistentAgentInstructions,
} from "../src/index";
import { ALL_RESOURCES } from "./agent-instructions/prompt-sentences";

const banner = (code: number) =>
  `Chunk ID: abc\nWall time: 1.0 seconds\nProcess exited with code ${code}\nOutput:\n`;

describe("command output compaction", () => {
  test("each transform keeps what the text says", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m 3 passed")).toBe("ok 3 passed");
    expect(lastProgressStates("Downloading 10%\rDownloading 50%\rDownloading 100%\nnext")).toBe(
      "Downloading 100%\nnext",
    );
    expect(lastProgressStates("crlf line\r\nnext")).toBe("crlf line\r\nnext");
    expect(collapseRepeatedLines("a\nwarn x\nwarn x\nwarn x\nb\nc\nc\n\n\n\n")).toBe(
      "a\nwarn x [repeated 3 times]\nb\nc\nc\n\n\n\n",
    );
    expect(minifyJsonBody('{\n  "a": [1, 2],\n  "b": "x  y"\n}\n')).toBe(
      '{"a":[1,2],"b":"x  y"}\n',
    );
    expect(minifyJsonBody('{"a": 1}\nnot json')).toBe('{"a": 1}\nnot json');
  });

  test("only the body after the banner changes, and file views keep their JSON", () => {
    const output = `${banner(0)}\x1b[1m{\n  "k": 1\n}\x1b[0m\n`;
    const compacted = compactCommandOutput(output);
    expect(compacted.text).toBe(`${banner(0)}{"k":1}\n`);
    expect(compacted.applied).toEqual(["ansi", "json"]);
    const file = compactCommandOutput(`${banner(0)}{\n  "k": 1\n}\n`, { command: "cat a.json" });
    expect(file.applied).toEqual([]);
    expect(compactCommandOutput("exec refused").text).toBe("exec refused");
  });
});

function passingTest(lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => `tests/test_m.py::test_${index} PASSED`);
  body.splice(Math.floor(lines / 2), 0, "tests/test_m.py:12: DeprecationWarning: old api");
  return `${banner(0)}${body.join("\n")}\n===== ${lines} passed in 1.2s =====\n`;
}

describe("passing check trim", () => {
  test("recognises tests and builds that passed with long output", () => {
    expect(isCheckCommand("cd /app && python -m pytest -q")).toBe(true);
    expect(isCheckCommand("cargo build --release")).toBe(true);
    expect(isCheckCommand("grep -rn foo .")).toBe(false);
    const long = passingTest(300);
    expect(
      passingCheckOutput("exec_command", JSON.stringify({ cmd: "pytest" }), long),
    ).not.toBeNull();
    const failed = long.replace("code 0", "code 1");
    expect(
      passingCheckOutput("exec_command", JSON.stringify({ cmd: "pytest" }), failed),
    ).toBeNull();
    expect(passingCheckOutput("exec_command", JSON.stringify({ cmd: "cat log" }), long)).toBeNull();
    expect(
      passingCheckOutput("exec_command", JSON.stringify({ cmd: "pytest" }), passingTest(5)),
    ).toBeNull();
    const then = `Success. Updated: a.py\n\nthen:\n${long}`;
    const check = passingCheckOutput(
      "apply_patch",
      JSON.stringify({ patch: "x", then: "pytest" }),
      then,
    );
    expect(check?.prefix).toBe("Success. Updated: a.py\n\nthen:\n");
  });

  test("the view keeps head, tail and flagged lines, and points at the exact stored range", () => {
    const text = passingTest(300);
    const check = passingCheckOutput("exec_command", JSON.stringify({ cmd: "pytest" }), text)!;
    const view = passingCheckView({
      check,
      readInstruction: (offset) => `Read on from ${offset}.`,
      storedOffset: 0,
    })!;
    expect(view.text.length).toBeLessThan(text.length / 2);
    expect(view.text).toStartWith(banner(0));
    expect(view.text).toEndWith("===== 300 passed in 1.2s =====\n");
    expect(view.text).toContain("DeprecationWarning: old api");
    const bytes = Buffer.from(text, "utf8");
    const shown = view.text.split("[Opengeni:")[0]!;
    expect(bytes.subarray(0, view.hiddenFrom).toString("utf8")).toBe(shown);
    expect(view.text).toContain(`Read on from ${view.hiddenFrom}.`);
  });

  test("the store trims only when enabled and the result can be read back", async () => {
    const text = passingTest(300);
    expect(Buffer.byteLength(text)).toBeGreaterThan(PASSING_CHECK_TRIM_MIN_BYTES);
    const saved: string[] = [];
    const make = (reader: "searchable" | "none"): ModelToolResultStore => ({
      store: async ({ text: stored }) => {
        saved.push(stored);
        return { resultId: "r1", byteSize: Buffer.byteLength(stored), sandboxPath: null };
      },
      inlineMaxBytes: () => 100_000,
      readers: () => ({ reader, shell: false }),
    });
    const call = (store: ModelToolResultStore) =>
      storeOversizedFunctionToolOutput({
        toolName: "exec_command",
        callId: "call_1",
        output: text,
        store,
        toolInput: JSON.stringify({ cmd: "pytest -q" }),
      });
    const off = make("searchable");
    expect(await call(off)).toBe(text);
    const on = make("searchable");
    installModelToolResultStore({ getAllTools: async () => [] }, on, { trimPassingChecks: true });
    const view = (await call(on)) as string;
    expect(view).toContain('tool_result_read {"resultId":"r1"');
    expect(saved.at(-1)).toBe(text);
    const unreadable = make("none");
    installModelToolResultStore({ getAllTools: async () => [] }, unreadable, {
      trimPassingChecks: true,
    });
    expect(await call(unreadable)).toBe(text);
  });
});

describe("whitespace-tolerant patch", () => {
  const file = "func a() {\n\tx  := 1\n\treturn x\n}\n";
  test("a hunk that differs only in whitespace quotes the file's own lines", () => {
    const diff = "@@\n func a() {\n-    x := 1\n+\tx := 2\n \treturn x\n";
    expect(whitespaceTolerantDiff(file, diff)).toBe(
      "@@\n func a() {\n-\tx  := 1\n+\tx := 2\n \treturn x\n",
    );
  });
  test("an exact match, an ambiguous match or no match keeps today's error", () => {
    expect(whitespaceTolerantDiff(file, "@@\n func a() {\n-\tx  := 1\n+\tx := 2\n")).toBeNull();
    expect(whitespaceTolerantDiff("a \na \n", "@@\n-a\n+b\n")).toBeNull();
    expect(whitespaceTolerantDiff(file, "@@\n-y := 1\n+y := 2\n")).toBeNull();
  });
});

describe("starting context", () => {
  test("renders bounded sections and nothing for foreign output", () => {
    const output = [
      "@@opengeni-starting-context:git",
      "## main...origin/main",
      " M src/a.ts",
      "@@opengeni-starting-context:ls",
      ".git",
      "AGENTS.md",
      "src",
      "@@opengeni-starting-context:agents",
      "# Rules\nUse bun.\n",
    ].join("\n");
    expect(renderStartingContext(output)).toBe(
      "$ git status --short --branch\n## main...origin/main\n M src/a.ts\n\n$ ls -A\n.git\nAGENTS.md\nsrc\n\n$ cat AGENTS.md\n# Rules\nUse bun.",
    );
    const many = `@@opengeni-starting-context:ls\n${Array.from({ length: 81 }, (_, i) => `f${i}`).join("\n")}\n`;
    expect(renderStartingContext(many)).toEndWith("f79\n[more entries not shown]");
    expect(renderStartingContext("sh: not found")).toBeNull();
    expect(STARTING_CONTEXT_PROBE).toContain("git -c core.quotepath=off status --short --branch");
    expect(readStartingContext(startingContextItem("x"))).toBe("x");
  });

  test("the run shows published items where later turns load them", async () => {
    const user = (content: string) =>
      ({ type: "message", role: "user", content }) as AgentInputItem;
    const history = [user("earlier")];
    const original = [...history, user("now")];
    const state = {
      visible: "Index A" as string | null,
      starting: "ls" as string | null,
      order: ["repository", "starting"] as ("repository" | "starting")[],
    };
    let received: readonly Record<string, unknown>[] = [];
    const filter = repositorySkillsContextInputFilter(
      state,
      original,
      history.length,
      async () => null,
      async (items) => {
        received = items;
        return [...history, ...([...items].reverse() as unknown as AgentInputItem[])];
      },
    )!;
    const result = await filter({
      modelData: { input: [...original], instructions: "system" },
      agent: {} as never,
      context: undefined,
    });
    expect(received).toEqual([repositorySkillsContextItem("Index A"), startingContextItem("ls")]);
    expect(result.input).toEqual([
      history[0],
      startingContextItem("ls"),
      repositorySkillsContextItem("Index A"),
      original[1],
    ] as unknown as AgentInputItem[]);
    // A retry that loaded the stored items already shows them.
    const loaded = result.input;
    const again = await filter({
      modelData: { input: loaded, instructions: "system" },
      agent: {} as never,
      context: undefined,
    });
    expect(again.input).toBe(loaded);
  });
});

describe("parallel tool calls guidance", () => {
  const text = (experiments?: { parallelToolCallsGuidance: true }) =>
    composeModularAgentInstructions({
      capabilities: allAgentCapabilities(),
      renderer: "opengeni",
      identity: DEFAULT_AGENT_IDENTITY,
      resources: ALL_RESOURCES,
      ...(experiments ? { experiments } : {}),
    }).composed;

  test("follows the setting and changes only the one rule", () => {
    expect(agentPromptExperimentsFor(testSettings()).experiments?.parallelToolCallsGuidance).toBe(
      undefined,
    );
    expect(
      agentPromptExperimentsFor(testSettings({ experimentToolEfficiency: true })).experiments
        ?.parallelToolCallsGuidance,
    ).toBe(true);
    const off = text();
    const on = text({ parallelToolCallsGuidance: true });
    expect(off).toContain(`- ${PARALLEL_TOOL_CALLS_RULE}\n`);
    expect(on).toContain(`- ${PARALLEL_TOOL_CALLS_RULE_WITH_EXAMPLE}\n`);
    expect(on.replace(PARALLEL_TOOL_CALLS_RULE_WITH_EXAMPLE, PARALLEL_TOOL_CALLS_RULE)).toBe(off);
  });

  test("the legacy operational contract changes the same way", () => {
    const contract = (settings: Settings) =>
      inspectPersistentAgentInstructions(settings, {} as never).layers.find(
        (layer) => layer.id === "operational_contract",
      )!.content;
    const off = contract(testSettings());
    const on = contract(testSettings({ experimentToolEfficiency: true }));
    expect(on).toContain(PARALLEL_TOOL_CALLS_RULE_WITH_EXAMPLE);
    expect(on.replace(PARALLEL_TOOL_CALLS_RULE_WITH_EXAMPLE, PARALLEL_TOOL_CALLS_RULE)).toBe(off);
  });
});
