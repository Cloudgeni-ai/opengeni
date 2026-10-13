import { afterEach, describe, expect, test } from "bun:test";
import { applyDiff, type Tool } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall, testSettings } from "@opengeni/testing";
import {
  EXEC_OUTPUT_SPILL_CUSTOM_DATA_KEY,
  EXEC_OUTPUT_SPILL_THRESHOLD_BYTES,
  exactContentCreateDiff,
  execOutputSpillPath,
  execOutputSpillProjection,
} from "../src/sandbox/exec-output-spill";
import { splitExecResponse } from "../src/sandbox/exec-banner";
import {
  buildAgentCapabilities,
  buildOpenGeniAgent,
  createSandboxClientForBackend,
  normalizeSdkEvent,
  releaseMcpResultCustomDataFromSdkEvent,
  runAgentStream,
} from "../src/index";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;
type LocalSession = {
  close(): Promise<void>;
  readFile(args: { path: string }): Promise<Uint8Array | string>;
};

const sessions: LocalSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
});

// 2,000 lines, ~19 KB: above the spill threshold, below the history truncation budget.
const BIG_CMD = "seq -f 'line %g' 1 2000";
const BIG_BODY = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");

function settingsFor(spill: boolean) {
  return testSettings({
    sandboxBackend: "local",
    webSearchEnabled: false,
    experimentExecOutputSpill: spill,
  });
}

async function localSession(spill: boolean): Promise<LocalSession> {
  const client = createSandboxClientForBackend("local", settingsFor(spill)) as {
    create(manifest?: unknown): Promise<LocalSession>;
  };
  const session = await client.create({});
  sessions.push(session);
  return session;
}

async function shellTools(
  spill: boolean,
  options: Parameters<typeof buildAgentCapabilities>[2] = {},
): Promise<{ session: LocalSession; exec: FunctionTool; stdin: FunctionTool }> {
  const session = await localSession(spill);
  const capability = buildAgentCapabilities(settingsFor(spill), [], options).find(
    (cap) => cap.type === "shell",
  )!;
  const tools = capability
    .clone()
    .bind(session as never)
    .tools();
  const find = (name: string) =>
    tools.find((tool): tool is FunctionTool => tool.type === "function" && tool.name === name)!;
  return { session, exec: find("exec_command"), stdin: find("write_stdin") };
}

function call(tool: FunctionTool, args: Record<string, unknown>, callId: string) {
  return tool
    .invoke({} as never, JSON.stringify(args), {
      toolCall: {
        type: "function_call",
        callId,
        name: tool.name,
        arguments: JSON.stringify(args),
      },
    } as never)
    .then(String);
}

async function readText(session: LocalSession, path: string): Promise<string> {
  const value = await session.readFile({ path });
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

describe("exec output spill projection", () => {
  test("a 2,000-line output becomes banner + notice + head/tail + elision marker", () => {
    const header =
      "Chunk ID: abc123\nWall time: 0.0123 seconds\nProcess exited with code 0\nOutput:\n";
    const path = execOutputSpillPath("call_big");
    const projected = execOutputSpillProjection(header, `${BIG_BODY}\n`, path);
    const lines = projected.split("\n");
    expect(projected.startsWith(header)).toBe(true);
    expect(lines[4]).toBe(
      "Output was 2,000 lines (~4,724 tokens); showing the first 60 and last 25. Full output: tool-results/exec-call_big.txt. Search it with rg or page it with sed -n.",
    );
    expect(lines[5]).toBe("line 1");
    expect(lines[64]).toBe("line 60");
    expect(lines[65]).toBe(
      "[... 1,915 lines omitted; full output in tool-results/exec-call_big.txt ...]",
    );
    expect(lines[66]).toBe("line 1976");
    expect(lines.at(-1)).toBe("line 2000");
    expect(Buffer.byteLength(projected) * 4).toBeLessThan(EXEC_OUTPUT_SPILL_THRESHOLD_BYTES * 4);
    expect(splitExecResponse(projected)?.header).toBe(header);
    // Deterministic for replay and prompt caching.
    expect(execOutputSpillProjection(header, `${BIG_BODY}\n`, path)).toBe(projected);
  });

  test("very long lines are bounded so the preview stays small", () => {
    const header =
      "Chunk ID: abc123\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n";
    const projected = execOutputSpillProjection(header, "x".repeat(200_000), "tool-results/a.txt");
    expect(projected).toContain(
      "Output was 1 line (~50,000 tokens); showing the first 1 and last 0.",
    );
    expect(projected).toContain("[... 199,600 more chars]");
    expect(projected.length).toBeLessThan(1_000);
    const wide = Array.from({ length: 500 }, () => "y".repeat(1_000)).join("\n");
    expect(execOutputSpillProjection(header, wide, "tool-results/b.txt").length).toBeLessThan(
      6_000,
    );
  });

  test("exact-content create diffs round-trip through the SDK create mode", () => {
    for (const content of [
      "",
      "\n",
      "a",
      "a\nb",
      "a\nb\n",
      "\n\nlead\n\n\ntrail\n\n",
      "+plus\n-minus\n@@ hunk\n*** End Patch\n*** Add File: x\n",
      `${BIG_BODY}\n`,
    ]) {
      expect(applyDiff("", exactContentCreateDiff(content), "create")).toBe(content);
    }
  });
});

describe("composed shell capability with a real local sandbox", () => {
  test("flag off (today): the full output reaches the caller unchanged", async () => {
    const { exec } = await shellTools(false);
    const output = await call(exec, { cmd: BIG_CMD, max_output_tokens: 20_000 }, "call_off");
    expect(splitExecResponse(output)?.body.trimEnd()).toBe(BIG_BODY);
    expect(output).not.toContain("Full output:");
  });

  for (const fenced of [false, true]) {
    test(`flag on spills large output, keeps small output byte-identical (turn fence: ${fenced})`, async () => {
      const abort = new AbortController();
      const { session, exec } = await shellTools(
        true,
        fenced ? { turnCancellationSignal: abort.signal } : {},
      );
      const output = await call(exec, { cmd: BIG_CMD, max_output_tokens: 20_000 }, "call_big");
      const parts = splitExecResponse(output)!;
      expect(parts.header).toMatch(/Process exited with code 0\nOutput:\n$/u);
      expect(parts.body.split("\n")[0]).toBe(
        "Output was 2,000 lines (~4,724 tokens); showing the first 60 and last 25. Full output: tool-results/exec-call_big.txt. Search it with rg or page it with sed -n.",
      );
      expect(Buffer.byteLength(parts.body)).toBeLessThan(5_000);
      // The file holds the exact full output body.
      expect(await readText(session, "tool-results/exec-call_big.txt")).toBe(`${BIG_BODY}\n`);
      expect(await readText(session, "tool-results/.gitignore")).toBe("*\n");
      // ...and the model can page it with the shell from its default cwd.
      const page = await call(
        exec,
        { cmd: "sed -n '1000,1002p' tool-results/exec-call_big.txt", max_output_tokens: 200 },
        "call_page",
      );
      expect(splitExecResponse(page)?.body).toBe("line 1000\nline 1001\nline 1002\n");

      // Small output: identical to the flag-off path apart from the random chunk id.
      const small = await call(exec, { cmd: "seq 1 50", max_output_tokens: 2_000 }, "call_small");
      expect(splitExecResponse(small)?.body).toBe(
        `${Array.from({ length: 50 }, (_, i) => i + 1).join("\n")}\n`,
      );

      // A non-zero exit keeps its exit code in the unchanged banner.
      const failed = await call(
        exec,
        { cmd: `${BIG_CMD}; exit 3`, max_output_tokens: 20_000 },
        "call_fail",
      );
      expect(failed).toContain("Process exited with code 3\nOutput:\nOutput was 2,000 lines");

      // The model's own max_output_tokens applies first: below the threshold, nothing spills.
      const capped = await call(exec, { cmd: BIG_CMD, max_output_tokens: 1_000 }, "call_capped");
      expect(capped).not.toContain("Full output:");
      expect(capped).toContain("tokens truncated");
      abort.abort(new Error("test done"));
    });
  }

  test("a running command spills only the returned chunk and write_stdin polls still work", async () => {
    const { session, exec, stdin } = await shellTools(true);
    const first = await call(
      exec,
      {
        cmd: "seq -f 'early %g' 1 1500; sleep 2; seq -f 'late %g' 1 1500",
        max_output_tokens: 20_000,
        yield_time_ms: 1_000,
      },
      "call_running",
    );
    const running = /Process running with session ID (\d+)\nOutput:\nOutput was 1,500 lines/u.exec(
      first,
    );
    expect(running).not.toBeNull();
    expect(await readText(session, "tool-results/exec-call_running.txt")).toBe(
      `${Array.from({ length: 1500 }, (_, i) => `early ${i + 1}`).join("\n")}\n`,
    );
    const sessionId = Number(running![1]);
    let polled = "";
    for (let attempt = 0; attempt < 10 && !polled.includes("Process exited"); attempt += 1) {
      polled = await call(
        stdin,
        { session_id: sessionId, chars: "", yield_time_ms: 2_000, max_output_tokens: 20_000 },
        `call_poll_${attempt}`,
      );
    }
    expect(polled).toContain("Process exited with code 0\nOutput:\nOutput was 1,500 lines");
    const pollPath = /Full output: (tool-results\/exec-call_poll_\d+\.txt)/u.exec(polled)![1]!;
    expect(await readText(session, pollPath)).toBe(
      `${Array.from({ length: 1500 }, (_, i) => `late ${i + 1}`).join("\n")}\n`,
    );
  });
});

describe("agent run with a real local sandbox", () => {
  async function runBigCommand(spill: boolean) {
    const settings = settingsFor(spill);
    const session = await localSession(spill);
    const model = new ScriptedModel([
      {
        output: [
          functionCall("exec_command", { cmd: BIG_CMD, max_output_tokens: 20_000 }, "call_run"),
        ],
      },
      { output: [assistantMessage("done")] },
    ]);
    const agent = buildOpenGeniAgent(settings, [], { model, hostedWebSearch: false });
    const result = await runAgentStream(agent, "show the build log", settings, {
      ownedSandbox: { client: createSandboxClientForBackend("local", settings), session } as never,
    });
    const streamed: any[] = [];
    for await (const event of result.toStream()) streamed.push(event);
    await result.completed;
    const outputEvent = streamed.find(
      (event) =>
        event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
    );
    const modelInput = JSON.stringify(model.requests[1]!.input);
    const historyOutput = JSON.stringify(outputEvent.item.rawItem);
    const [timeline] = normalizeSdkEvent(outputEvent).filter(
      (event) => event.type === "agent.toolCall.output",
    );
    return { session, modelInput, historyOutput, outputEvent, timeline, result };
  }

  test("flag off (today): the model receives every one of the 2,000 lines", async () => {
    const { modelInput, timeline } = await runBigCommand(false);
    expect(modelInput).toContain("line 1000");
    expect(modelInput).not.toContain("Full output:");
    expect(String((timeline!.payload as { output: unknown }).output)).toContain("line 1000");
  });

  test("flag on: model and history get the projection, the timeline keeps the full output", async () => {
    const { session, modelInput, historyOutput, outputEvent, timeline, result } =
      await runBigCommand(true);
    expect(modelInput).toContain("Full output: tool-results/exec-call_run.txt");
    expect(modelInput).toContain("line 60");
    expect(modelInput).not.toContain("line 1000");
    expect(modelInput).toContain("line 2000");
    // History persists the rawItem: the same projection the model saw.
    expect(historyOutput).toContain("Full output: tool-results/exec-call_run.txt");
    expect(historyOutput).not.toContain("line 1000");
    // The timeline event carries the full response.
    const eventOutput = String((timeline!.payload as { output: unknown }).output);
    expect(splitExecResponse(eventOutput)?.body.trimEnd()).toBe(BIG_BODY);
    expect(await readText(session, "tool-results/exec-call_run.txt")).toBe(`${BIG_BODY}\n`);
    // After the durable append the worker drops the duplicate full text.
    expect(outputEvent.item.customData[EXEC_OUTPUT_SPILL_CUSTOM_DATA_KEY]).toBeString();
    expect(releaseMcpResultCustomDataFromSdkEvent(outputEvent)).toBe(true);
    expect(outputEvent.item.customData).toBeUndefined();
    expect(result.state.toString()).not.toContain("line 1000");
  });
});
