import { describe, expect, test } from "bun:test";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import { boundModelToolOutputItem } from "@opengeni/codex";
import {
  TOOL_RESULT_STORED_META_KEY,
  isModelToolResultStoreView,
  type AttemptToolResult,
  type ToolResultStoredReceipt,
} from "@opengeni/contracts";
import {
  agentModelToolResultStoringTool,
  installModelToolResultStore,
  modelToolResultFits,
  projectAttemptToolResultForCaller,
  storeOversizedFunctionToolOutput,
  storedToolResultView,
  wrapAttemptToolDefinitions,
  wrapAttemptToolExecute,
  type ModelToolResultStore,
  type StoredToolResultKey,
  type StoredToolResultReaders,
} from "../src/model-tool-result-store";

const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESULT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INLINE_MAX = 100_000;

function context(kind: "model" | "codemode"): AttemptToolExecutionContext {
  return {
    operationId: OPERATION_ID,
    caller: { kind, subjectId: kind === "codemode" ? "codemode:test" : "worker:mcp-model" },
  };
}

/** An in-memory store: what a reader would read back by id and offset. */
function memoryStore(
  readers: StoredToolResultReaders = { reader: "searchable", shell: false },
  options: { fail?: boolean; sandboxPath?: string | null } = {},
) {
  const saved = new Map<string, { key: StoredToolResultKey; text: string }>();
  const store: ModelToolResultStore = {
    store: async ({ key, text }) => {
      if (options.fail) throw new Error("object storage unavailable");
      saved.set(RESULT_ID, { key, text });
      return {
        resultId: RESULT_ID,
        byteSize: Buffer.byteLength(text, "utf8"),
        sandboxPath: options.sandboxPath ?? null,
      };
    },
    inlineMaxBytes: () => INLINE_MAX,
    readers: () => readers,
  };
  return { store, saved };
}

/** Numbered lines, so a lost or repeated range is visible. */
function lines(bytes: number, prefix = "line"): string {
  const parts: string[] = [];
  let size = 0;
  for (let index = 0; size < bytes; index += 1) {
    const line = `${prefix} ${index.toString().padStart(7, "0")} ${"·".repeat(20)}\n`;
    parts.push(line);
    size += Buffer.byteLength(line);
  }
  return parts.join("");
}

function textOf(result: AttemptToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function receiptOf(result: AttemptToolResult): ToolResultStoredReceipt {
  return (result._meta as Record<string, ToolResultStoredReceipt>)[TOOL_RESULT_STORED_META_KEY]!;
}

/** Read the stored text from `offset` on, as `tool_result_read` would. */
function readFrom(text: string, offset: number): string {
  return Buffer.from(text, "utf8").subarray(offset).toString("utf8");
}

describe("lossless model tool results", () => {
  test("Codemode receives the exact result, however large", async () => {
    const result: AttemptToolResult = { content: [{ type: "text", text: lines(3_000_000) }] };
    const { store, saved } = memoryStore();
    expect(await projectAttemptToolResultForCaller(result, context("codemode"), store)).toBe(
      result,
    );
    expect(saved.size).toBe(0);
  });

  test("a 60 KB result reaches the model whole", async () => {
    const result: AttemptToolResult = { content: [{ type: "text", text: lines(60_000) }] };
    const { store, saved } = memoryStore();
    expect(await projectAttemptToolResultForCaller(result, context("model"), store)).toBe(result);
    expect(saved.size).toBe(0);
  });

  test("a result over 100 KB is stored whole; the model sees its start, size and the read call", async () => {
    const full = lines(300_000);
    const result: AttemptToolResult = { content: [{ type: "text", text: full }] };
    const { store, saved } = memoryStore();
    const view = await projectAttemptToolResultForCaller(result, context("model"), store);
    expect(saved.get(RESULT_ID)).toEqual({
      key: { kind: "operation", operationId: OPERATION_ID },
      text: full,
    });
    const shown = textOf(view);
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(INLINE_MAX);
    const receipt = receiptOf(view);
    expect(receipt).toMatchObject({
      type: "tool_result_stored",
      resultId: RESULT_ID,
      byteSize: Buffer.byteLength(full),
      notShownTo: Buffer.byteLength(full),
      sandboxPath: null,
    });
    // The view ends on a line, then names the size and the exact next read.
    const head = Buffer.from(full).subarray(0, receipt.notShownFrom).toString("utf8");
    expect(head.endsWith("\n")).toBe(true);
    expect(shown).toBe(
      `${head}\n[Opengeni: this tool result is ${receipt.byteSize} bytes, more than the ${INLINE_MAX} bytes one result may show, so it is stored whole. Shown above: bytes 0 to ${receipt.notShownFrom}. Read on with tool_result_read {"resultId":"${RESULT_ID}","offset":${receipt.notShownFrom}}; load tool_result_read by that exact name with tool search first.]`,
    );
    // Nothing is lost: the shown start and the read from its offset are the whole.
    expect(head + readFrom(full, receipt.notShownFrom)).toBe(full);
    expect(isModelToolResultStoreView(view)).toBe(true);
    // The seam's safety net (1.2x the policy) never cuts the view.
    const item = { type: "function_call_result", callId: "c", output: shown };
    expect(boundModelToolOutputItem(item)).toBe(item);
  });

  test("a result over 1 MiB goes through the same store", async () => {
    const full = lines(2 * 1024 * 1024);
    const { store, saved } = memoryStore();
    const view = await projectAttemptToolResultForCaller(
      { content: [{ type: "text", text: full }] },
      context("model"),
      store,
    );
    expect(saved.get(RESULT_ID)?.text).toBe(full);
    expect(Buffer.byteLength(textOf(view))).toBeLessThanOrEqual(INLINE_MAX);
    expect(receiptOf(view).byteSize).toBe(Buffer.byteLength(full));
    expect(view.structuredContent).toBeUndefined();
  });

  test("the stored text is exactly what the model would have seen, structured part included", async () => {
    const result: AttemptToolResult = {
      content: [{ type: "text", text: lines(80_000) }],
      structuredContent: { rows: lines(80_000, "row").split("\n") },
    };
    expect(modelToolResultFits(result, INLINE_MAX)).toBe(false);
    const { store, saved } = memoryStore();
    await projectAttemptToolResultForCaller(result, context("model"), store);
    const stored = saved.get(RESULT_ID)!.text;
    expect(stored.startsWith(lines(80_000))).toBe(true);
    expect(stored).toContain(`Structured result: ${JSON.stringify(result.structuredContent)}`);
  });

  test("an error result keeps its error flag through the view", async () => {
    const { store } = memoryStore();
    const view = await projectAttemptToolResultForCaller(
      { isError: true, content: [{ type: "text", text: lines(200_000) }] },
      context("model"),
      store,
    );
    expect(view.isError).toBe(true);
    expect(receiptOf(view).resultId).toBe(RESULT_ID);
  });

  test("a store failure shows the start and says the rest could not be kept", async () => {
    const full = lines(200_000);
    const { store } = memoryStore(undefined, { fail: true });
    const view = await projectAttemptToolResultForCaller(
      { content: [{ type: "text", text: full }] },
      context("model"),
      store,
    );
    const shown = textOf(view);
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(INLINE_MAX);
    expect(shown).toContain("it could not be stored, so only bytes 0 to");
    expect(view._meta).toBeUndefined();
  });

  test("an image past the 1 MiB transport bound is withheld with a note; the text stays whole", async () => {
    const image = Buffer.alloc(1_200_000, 7).toString("base64");
    const { store, saved } = memoryStore();
    const view = await projectAttemptToolResultForCaller(
      {
        content: [
          { type: "text", text: "caption" },
          { type: "image", data: image, mimeType: "image/png" },
        ],
      },
      context("model"),
      store,
    );
    expect(saved.size).toBe(0);
    expect(view.content).toEqual([
      {
        type: "text",
        text: "[The tool returned an image (image/png, 1200000 bytes) too large to show.]",
      },
      { type: "text", text: "caption" },
    ]);
  });

  test("wrapped attempt tools branch on the caller", async () => {
    const full = lines(150_000);
    const { store } = memoryStore();
    const execute = wrapAttemptToolExecute(
      async () => ({ content: [{ type: "text", text: full }] }),
      store,
    );
    expect(textOf(await execute({}, context("codemode")))).toBe(full);
    expect(receiptOf(await execute({}, context("model"))).resultId).toBe(RESULT_ID);
    const [wrapped] = wrapAttemptToolDefinitions(
      [
        {
          identity: { serverId: "interaction", toolName: "echo" },
          modelName: "echo",
          inputSchema: { type: "object" },
          source: "interaction",
          approval: "none",
          execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
      store,
    );
    expect(await wrapped!.execute({}, context("model"))).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });
});

describe("stored result notes", () => {
  const stored = { resultId: RESULT_ID, byteSize: 300_000, sandboxPath: null };
  const note = (readers: StoredToolResultReaders, sandboxPath: string | null = null) => {
    const view = storedToolResultView({
      text: lines(300_000),
      stored: { ...stored, sandboxPath },
      inlineMaxBytes: INLINE_MAX,
      readers,
      shape: "head",
    });
    return view.text.slice(view.text.lastIndexOf("\n[Opengeni:"));
  };

  test("name the reader the session has", () => {
    expect(note({ reader: "searchable", shell: false })).toContain(
      `Read on with tool_result_read {"resultId":"${RESULT_ID}","offset":`,
    );
    expect(note({ reader: "searchable", shell: false })).toContain(
      "; load tool_result_read by that exact name with tool search first.]",
    );
    expect(note({ reader: "searchable", shell: true }, "/workspace/tool-results/x.txt")).toContain(
      " A copy is at /workspace/tool-results/x.txt where your shell runs.]",
    );
    expect(note({ reader: "none", shell: true }, "/workspace/tool-results/x.txt")).toMatch(
      /Read on from byte \d+ of the copy at \/workspace\/tool-results\/x\.txt with the shell \(for example with tail -c \+\d+, grep or jq\)\.\]$/,
    );
    expect(note({ reader: "none", shell: false })).toContain(
      "This session has no tool that reads it. If the tool can narrow its result",
    );
  });
});

describe("function tool output", () => {
  test("shell output keeps its head and tail; the middle is stored and readable", async () => {
    const full = lines(300_000, "out");
    const { store, saved } = memoryStore();
    const view = (await storeOversizedFunctionToolOutput({
      toolName: "exec_command",
      callId: "call-shell",
      output: full,
      store,
    })) as string;
    expect(saved.get(RESULT_ID)).toEqual({
      key: { kind: "call", callId: "call-shell" },
      text: full,
    });
    expect(Buffer.byteLength(view)).toBeLessThanOrEqual(INLINE_MAX);
    const match = view.match(
      /\n\[Opengeni: bytes (\d+) to (\d+) of this (\d+)-byte output are not shown; the whole output is stored\. Read on with tool_result_read \{"resultId":"[0-9a-f-]+","offset":(\d+)\}; load tool_result_read by that exact name with tool search first\.\]\n/,
    );
    expect(match).not.toBeNull();
    const [note, from, to, total, offset] = match!;
    expect(Number(total)).toBe(Buffer.byteLength(full));
    expect(offset).toBe(from);
    const [head, tail] = view.split(note);
    expect(full.startsWith(head!)).toBe(true);
    expect(full.endsWith(tail!)).toBe(true);
    expect(tail!.length).toBeGreaterThan(30_000);
    const bytes = Buffer.from(full);
    expect(head! + bytes.subarray(Number(from), Number(to)).toString("utf8") + tail!).toBe(full);
  });

  test("other function tools show their start; outputs that fit are untouched", async () => {
    const { store } = memoryStore();
    const fitting = lines(90_000);
    expect(
      await storeOversizedFunctionToolOutput({
        toolName: "skill_read",
        callId: "c1",
        output: fitting,
        store,
      }),
    ).toBe(fitting);
    const full = lines(250_000);
    const view = (await storeOversizedFunctionToolOutput({
      toolName: "skill_read",
      callId: "c2",
      output: { type: "text", text: full },
      store,
    })) as string;
    expect(view).toContain("so it is stored whole. Shown above: bytes 0 to");
    expect(full.startsWith(view.slice(0, view.indexOf("\n[Opengeni:")))).toBe(true);
  });

  test("the agent wrapper stores by call id for every function tool, clones included", async () => {
    const full = lines(200_000);
    const { store, saved } = memoryStore();
    const tool = {
      type: "function" as const,
      name: "sessions_list",
      invoke: async () => full,
    };
    const agent = {
      getAllTools: async () => [tool as any],
      clone(): typeof agent {
        return { ...agent, clone: agent.clone };
      },
    };
    installModelToolResultStore(agent, store);
    const [wrapped] = await agent.getAllTools();
    const view = await wrapped.invoke({}, "{}", { toolCall: { callId: "call-7" } });
    expect(saved.get(RESULT_ID)).toEqual({ key: { kind: "call", callId: "call-7" }, text: full });
    expect(Buffer.byteLength(view)).toBeLessThanOrEqual(INLINE_MAX);
    const [again] = await agent.getAllTools();
    expect(again).toBe(wrapped);
    const cloned = agent.clone();
    const [clonedTool] = await cloned.getAllTools();
    expect(clonedTool).toBe(wrapped);
    // A call resumed outside getAllTools (an approval resume) is stored the same way.
    expect(agentModelToolResultStoringTool(agent, tool as any)).toBe(wrapped);
    expect(agentModelToolResultStoringTool({}, tool as any)).toBe(tool);
  });
});
