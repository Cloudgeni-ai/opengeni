import { describe, expect, test } from "bun:test";
import {
  projectHistoryForProvider,
  ProviderHistoryIncompatibleError,
} from "../src/provider-history-adapter";

describe("projectHistoryForProvider", () => {
  test("Responses uses canonical history by reference", () => {
    const items = [{ type: "tool_search_call", call_id: "search-1", execution: "client" }];
    const projected = projectHistoryForProvider(items, "responses");
    expect(projected).toBe(items);
    expect(projected[0]).toBe(items[0]);
  });

  test("Codex subscription A to B to A keeps the same opaque Responses history", () => {
    const reasoning = {
      type: "reasoning",
      id: "rs-transferable",
      content: [{ type: "input_text", text: "readable summary" }],
      providerData: { encrypted_content: "opaque-codex-history" },
    };
    const canonical = [reasoning];

    const onA = projectHistoryForProvider(canonical, "responses");
    const onB = projectHistoryForProvider(onA, "responses");
    const backOnA = projectHistoryForProvider(onB, "responses");

    expect(onA).toBe(canonical);
    expect(onB).toBe(canonical);
    expect(backOnA).toBe(canonical);
    expect(backOnA[0]).toBe(reasoning);
    expect(reasoning.providerData.encrypted_content).toBe("opaque-codex-history");
  });

  test("already portable Chat history remains byte-identical by reference", () => {
    const items = [
      { type: "message", role: "system", content: "rules" },
      { type: "message", role: "user", content: "question" },
      { type: "function_call", callId: "call-1", name: "lookup", arguments: "{}" },
      { type: "function_call_result", callId: "call-1", output: "answer" },
    ];
    const projected = projectHistoryForProvider(items, "chat");
    expect(projected).toBe(items);
  });

  test("Chat maps unsupported provider records to bounded historical facts without mutation", () => {
    const searchCall = {
      type: "tool_search_call",
      execution: "client",
      providerData: { callId: "search-1" },
      arguments: { query: "mail" },
    };
    const searchOutput = {
      type: "tool_search_output",
      execution: "client",
      providerData: { callId: "search-1" },
      tools: [{ type: "function", name: "codex_apps__gmail_search" }],
    };
    const namespacedCall = {
      type: "function_call",
      namespace: "gmail",
      name: "search",
      providerData: { callId: "call-1" },
      arguments: "{}",
    };
    const namespacedResult = {
      type: "function_call_result",
      providerData: { callId: "call-1" },
      output: "done",
    };
    const items = [searchCall, searchOutput, namespacedCall, namespacedResult];

    const projected = projectHistoryForProvider(items, "chat");

    expect(projected).not.toBe(items);
    expect(projected).toHaveLength(items.length);
    expect(projected.every((item) => item.type === "message" && item.role === "assistant")).toBe(
      true,
    );
    expect(searchCall.execution).toBe("client");
    expect(namespacedCall.namespace).toBe("gmail");
  });

  test("Chat preserves developer instructions by projecting their role to system", () => {
    const developer = { type: "message", role: "developer", content: "keep this instruction" };
    const projected = projectHistoryForProvider([developer], "chat");
    expect(projected).toEqual([
      { type: "message", role: "system", content: "keep this instruction" },
    ]);
    expect(developer.role).toBe("developer");
  });

  test("Chat keeps the SDK-supported file-search hosted record by reference", () => {
    const item = {
      type: "hosted_tool_call",
      name: "file_search_call",
      id: "file-search-1",
      status: "completed",
      providerData: { queries: ["invoice"] },
    };
    const items = [item];
    const projected = projectHistoryForProvider(items, "chat");
    expect(projected).toBe(items);
    expect(projected[0]).toBe(item);
  });

  test("remote compaction blocks a Chat switch and leaves canonical history intact", () => {
    const compaction = { type: "compaction", encrypted_content: "opaque" };
    const items = [compaction];
    expect(() => projectHistoryForProvider(items, "chat")).toThrow(
      ProviderHistoryIncompatibleError,
    );
    expect(items).toEqual([compaction]);
  });
});
