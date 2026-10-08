import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CUA_DESKTOP_TOOLS, type ComputerNativeCommand } from "@opengeni/contracts";
import {
  ComputerInteractionController,
  recoverComputerOperationJournalRecord,
  boundComputerNativeReceipt,
} from "@opengeni/interaction";
import { CuaNativeTools } from "../src/cua/native-tools";
import type { CuaDesktopRuntime } from "../src/cua/wire";

const computerSessionId = randomUUID();
const command = (): ComputerNativeCommand => ({
  protocolVersion: 1,
  operationId: randomUUID(),
  computerSessionId,
  controllerGeneration: "controller-fixture",
  targetId: null,
  actor: { kind: "agent", subjectId: "agent:fixture" },
  tool: "run_actions",
  arguments: {
    steps: [{ tool: "click", args: { pid: 42, window_id: 1, element_token: "s1:0" } }],
    observe: true,
  },
});

test("native calls retain raw partial results and share one journal with legacy actions", async () => {
  const content = [
    { type: "text", text: "One step ran before failure" },
    { type: "image", mimeType: "image/png", data: "AA==" },
  ];
  const raw = {
    content,
    structuredContent: { effect: "partial", steps: [{ ok: true }, { ok: false }] },
    isError: true,
  };
  const calls: unknown[] = [];
  const runtime: CuaDesktopRuntime = {
    listToolsJson: async () => JSON.stringify({ tools: CUA_DESKTOP_TOOLS }),
    callTool: async (tool, args) => {
      calls.push({ tool, args: JSON.parse(args) });
      return {
        text: "",
        images: [],
        isError: true,
        degraded: false,
        structuredJson: JSON.stringify(raw.structuredContent),
        rawJson: JSON.stringify(raw),
      };
    },
    shutdown: async () => {},
  };
  const native = new CuaNativeTools(runtime, "private-controller-session");
  const records = new Map();
  const driver = {
    target: async () => {
      throw new Error("Native session calls must not invent a window");
    },
    observe: async () => {
      throw new Error("unexpected observation");
    },
    dispatch: async () => {
      throw new Error("unexpected legacy dispatch");
    },
    validateNative: (request: ComputerNativeCommand) => native.validate(request),
    dispatchNative: async (request: ComputerNativeCommand) => ({
      target: null,
      computerSessionId,
      controllerGeneration: "controller-fixture",
      tool: request.tool,
      ...(await native.call(request)),
    }),
  };
  const options = {
    computerSessionId,
    controllerGeneration: "controller-fixture",
    driver,
    onJournalRecord: (record: any) => {
      records.set(record.operationId, record);
    },
    loadJournalRecord: (id: string) => records.get(id) ?? null,
  };
  const controller = new ComputerInteractionController(options);
  const input = command();
  const pending = controller.runNative(input);
  expect(controller.runNative(input)).toBe(pending);
  const receipt = await pending;
  expect(receipt.state).toBe("outcome_unknown");
  expect(receipt.observation?.result).toEqual(raw);
  expect(boundComputerNativeReceipt(receipt)).toBe(receipt);
  const oversized = structuredClone(receipt);
  oversized.observation!.result.content.push({
    type: "image",
    mimeType: "image/png",
    data: "A".repeat(42 * 1024 * 1024),
  });
  const bounded = boundComputerNativeReceipt(oversized);
  expect(JSON.stringify(bounded).length).toBeLessThan(12 * 1024 * 1024);
  expect(bounded.state).toBe("outcome_unknown");
  expect(bounded.observation!.result.content).toContainEqual(raw.content[1]!);
  expect(JSON.stringify(bounded)).toContain("Do not repeat the action");
  expect(oversized.observation!.result.content).toHaveLength(3);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    args: { session: "private-controller-session", observe: true },
  });
  const restored = new ComputerInteractionController({
    ...options,
    initialJournal: records.values(),
  });
  expect(await restored.runNative(input)).toEqual(receipt);
  expect(calls).toHaveLength(1);
  expect(() =>
    restored.run({
      ...input,
      targetId: "window:42",
      expectedTargetGeneration: "t1",
      expectedObservationId: null,
      expectedFrameId: null,
      action: { type: "keyboard", action: "text", text: "x" },
    } as any),
  ).toThrow();
  const recovered = recoverComputerOperationJournalRecord(
    {
      operationId: input.operationId,
      commandDigest: "digest",
      receipt: { ...receipt, state: "dispatched", settledAt: null, observation: null, error: null },
    },
    new Date().toISOString(),
  );
  expect(recovered.receipt.state).toBe("outcome_unknown");
});

test("native admission refuses session escape, unselected host tools and schema mismatch before callTool", async () => {
  let calls = 0;
  let tools = structuredClone(CUA_DESKTOP_TOOLS);
  const runtime: CuaDesktopRuntime = {
    listToolsJson: async () => JSON.stringify({ tools }),
    callTool: async () => {
      calls++;
      throw new Error("must not dispatch");
    },
    shutdown: async () => {},
  };
  for (const request of [
    { ...command(), tool: "escalate_session" },
    { ...command(), arguments: { session: "other" } },
    { ...command(), arguments: { steps: [{ tool: "click", args: { session: "other" } }] } },
  ])
    await expect(new CuaNativeTools(runtime, "owned").validate(request)).rejects.toThrow();
  tools = tools.map((tool) =>
    tool.name === "run_actions" ? { ...tool, inputSchema: { type: "object" } } : tool,
  );
  await expect(new CuaNativeTools(runtime, "owned").validate(command())).rejects.toThrow(
    "schema differs",
  );
  expect(calls).toBe(0);
});
