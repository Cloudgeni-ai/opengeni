import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { hostedSearchFixture } from "./fixtures/hosted-search";
import { anthropicMessages } from "../src/anthropic-messages";
import {
  projectHistoryForProvider,
  ProviderHistoryIncompatibleError,
} from "../src/provider-history-adapter";

type Item = Record<string, unknown>;
const C = (id: string): Item => ({
  type: "function_call",
  callId: id,
  name: "run",
  arguments: "{}",
});
const R = (id: string): Item => ({ type: "function_call_result", callId: id, output: id });
const ids = (items: Item[]) =>
  items.map((item) =>
    item.type === "function_call"
      ? `C(${item.callId})`
      : item.type === "function_call_result"
        ? `R(${item.callId})`
        : String(item.role ?? item.type),
  );

/** Chat Completions: a step's tool messages must directly answer all of its calls. */
function expectChatResultsContiguous(items: Item[]): void {
  const pending = new Set<string>();
  let answering = false;
  for (const item of items) {
    const call =
      item.type === "function_call"
        ? String(item.callId)
        : item.type === "hosted_tool_call"
          ? String(item.id)
          : null;
    if (item.type === "function_call_result") {
      expect(pending.delete(String(item.callId))).toBe(true);
      answering = pending.size > 0;
      continue;
    }
    expect(answering).toBe(false);
    if (call) pending.add(call);
  }
  expect(pending.size).toBe(0);
}

describe("parallel tool results stay contiguous on Claude and Chat", () => {
  test("an item between a step's results moves after them, Responses is untouched", () => {
    const disclosure = [C("search"), R("search")];
    const history = [C("a"), C("b"), C("c"), R("a"), R("b"), ...disclosure, R("c")];
    expect(() => anthropicMessages(history as ModelRequest["input"])).toThrow(
      "Claude tool results are incomplete",
    );
    for (const api of ["chat", "anthropic-messages"] as const) {
      const projected = projectHistoryForProvider(history, api);
      expect(ids(projected)).toEqual([
        "C(a)",
        "C(b)",
        "C(c)",
        "R(a)",
        "R(b)",
        "R(c)",
        "C(search)",
        "R(search)",
      ]);
      expect(projectHistoryForProvider(projected, api)).toBe(projected);
    }
    expect(projectHistoryForProvider(history, "responses")).toBe(history);
  });

  test("calls moved out of a run keep their own results together in one pass", () => {
    const nested = [
      ...[C("a"), C("b"), R("a"), C("c"), C("d"), R("c"), C("e"), R("e"), R("d"), R("b")],
    ];
    const late = [C("a"), C("b"), R("a"), C("c"), C("d"), R("c"), R("b"), R("d")];
    for (const history of [nested, late]) {
      for (const api of ["chat", "anthropic-messages"] as const) {
        const projected = projectHistoryForProvider(history, api);
        if (api === "chat") expectChatResultsContiguous(projected);
        else expect(() => anthropicMessages(projected as ModelRequest["input"])).not.toThrow();
        expect(projectHistoryForProvider(projected, api)).toBe(projected);
      }
    }
    expect(ids(projectHistoryForProvider(nested, "anthropic-messages"))).toEqual([
      "C(a)",
      "C(b)",
      "R(a)",
      "R(b)",
      "C(c)",
      "C(d)",
      "R(c)",
      "R(d)",
      "C(e)",
      "R(e)",
    ]);
  });

  test("a system notice inside a run moves on both; a person message stays on Claude only", () => {
    const system: Item = { type: "message", role: "system", content: "notice" };
    const person: Item = { type: "message", role: "user", content: "also check this" };
    const history = [C("a"), C("b"), R("a"), system, person, C("s"), R("s"), R("b")];
    const claude = projectHistoryForProvider(history, "anthropic-messages");
    expect(ids(claude)).toEqual(["C(a)", "C(b)", "R(a)", "user", "R(b)", "system", "C(s)", "R(s)"]);
    expect(() => anthropicMessages(claude as ModelRequest["input"])).not.toThrow();
    const chat = projectHistoryForProvider(history, "chat");
    expect(ids(chat)).toEqual(["C(a)", "C(b)", "R(a)", "R(b)", "system", "user", "C(s)", "R(s)"]);
    expectChatResultsContiguous(chat);

    // A person message Claude already accepted between results is left as it was.
    const accepted = [C("a"), C("b"), R("a"), person, R("b")];
    expect(projectHistoryForProvider(accepted, "anthropic-messages")).toBe(accepted);
  });

  test("an accepted Chat step with a stored file search call is unchanged", () => {
    const fileSearch: Item = {
      type: "hosted_tool_call",
      id: "fs_1",
      name: "file_search_call",
      status: "completed",
    };
    const history = [C("a"), fileSearch, C("b"), R("a"), R("fs_1"), R("b")];
    expect(projectHistoryForProvider(history, "chat")).toBe(history);
    const moved = [C("a"), C("b"), R("a"), fileSearch, R("fs_1"), R("b")];
    const projected = projectHistoryForProvider(moved, "chat");
    expect(projected.map((item) => item.callId ?? item.id)).toEqual([
      "a",
      "b",
      "a",
      "b",
      "fs_1",
      "fs_1",
    ]);
    expectChatResultsContiguous(projected);
  });

  test("results without a call, and calls without a result, keep their place", () => {
    const history = [C("a"), C("b"), R("a"), R("orphan"), R("b"), C("unanswered")];
    for (const api of ["chat", "anthropic-messages"] as const) {
      expect(projectHistoryForProvider(history, api)).toBe(history);
    }
  });

  test("a very large interrupted run is projected without exhausting the stack", () => {
    const inside = Array.from({ length: 300_000 }, (_, index) => ({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: String(index) }],
    }));
    const history = [C("a"), C("b"), R("a"), ...inside, R("b")];
    const projected = projectHistoryForProvider(history, "anthropic-messages");
    expect(projected).toHaveLength(history.length);
    expect(ids(projected.slice(0, 4))).toEqual(["C(a)", "C(b)", "R(a)", "R(b)"]);
    expect(projected.at(-1)).toBe(inside.at(-1)!);
  });
});

describe("projectHistoryForProvider", () => {
  test("included search evidence stays inert and in order on every provider API", () => {
    const items = [
      { type: "message", role: "user", content: "Find docs" },
      hostedSearchFixture(),
      { type: "function_call", callId: "checkpoint", name: "checkpoint", arguments: "{}" },
      { type: "function_call_result", callId: "checkpoint", output: "ACK" },
    ];
    const before = structuredClone(items);
    for (const api of ["responses", "chat", "anthropic-messages"] as const) {
      const projected = projectHistoryForProvider(items, api);
      expect(projected).toHaveLength(items.length);
      expect(projected[1]).toMatchObject({ type: "message", role: "assistant" });
      expect(JSON.stringify(projected[1]!.content)).toContain("exactly seven colors");
      expect(projected[2]).toBe(items[2]);
      expect(projected[3]).toBe(items[3]);
      expect(projectHistoryForProvider(projected, api)).toBe(projected);
      expect(items).toEqual(before);
    }
  });
  test("legacy Chat raw reasoning becomes inert assistant context without truncation or mutation", () => {
    const text = "Synthetic reasoning. ".repeat(2000);
    const items = [
      { type: "reasoning", content: [], rawContent: [{ type: "reasoning_text", text }] },
    ];
    const before = JSON.stringify(items);
    for (const api of ["responses", "anthropic-messages"] as const) {
      const projected = projectHistoryForProvider(items, api);
      expect(projected).toEqual([
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: `[Historical reasoning from another model]\n${text}` },
          ],
        },
      ]);
      expect(projectHistoryForProvider(projected, api)).toBe(projected);
      expect(JSON.stringify(items)).toBe(before);
    }
  });

  test("native encrypted/signed reasoning keeps references only on its own API", () => {
    const rawContent = [{ type: "reasoning_text", text: "Native raw text" }];
    const items = [
      { type: "reasoning", content: [], rawContent, providerData: { encrypted_content: "opaque" } },
      { type: "reasoning", content: [], rawContent, encrypted_content: "opaque" },
      {
        type: "reasoning",
        content: [],
        rawContent,
        providerData: {
          anthropic: {
            block: {
              type: "thinking",
              thinking: "Native raw text",
              signature: "signature-fixture",
            },
          },
        },
      },
      { type: "reasoning", content: [{ type: "input_text", text: "Native summary" }], rawContent },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Answer",
            providerData: {
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.test/source",
                  title: "Fixture",
                  start_index: 0,
                  end_index: 6,
                },
              ],
            },
          },
        ],
      },
    ];
    const responses = [items[0]!, items[1]!, items[3]!, items[4]!];
    expect(projectHistoryForProvider(responses, "responses")).toBe(responses);
    const claude = [items[2]!, items[4]!];
    expect(projectHistoryForProvider(claude, "anthropic-messages")).toBe(claude);
  });

  test("Responses removes only Chat reply metadata from assistant text/refusal parts", () => {
    const items = [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Answer",
            providerData: { role: "assistant", tools: [], reasoning_content: "Summary" },
          },
          {
            type: "refusal",
            refusal: "Cannot help",
            providerData: { role: "assistant", refusal: "Cannot help", annotations: [] },
          },
          { type: "output_text", text: "Cited", providerData: { annotations: [] } },
        ],
      },
    ];
    const before = JSON.stringify(items);
    const projected = projectHistoryForProvider(items, "responses");
    expect(projected[0]!.content).toEqual([
      { type: "output_text", text: "[Historical reasoning from another model]\nSummary" },
      { type: "output_text", text: "Answer" },
      { type: "refusal", refusal: "Cannot help" },
      items[0]!.content[2],
    ]);
    expect((projected[0]!.content as unknown[])[3]).toBe(items[0]!.content[2]);
    expect(JSON.stringify(items)).toBe(before);
    expect(projectHistoryForProvider(projected, "responses")).toBe(projected);
    const claude = projectHistoryForProvider(items, "anthropic-messages");
    expect(claude).toEqual(projected);
    expect(projectHistoryForProvider(claude, "anthropic-messages")).toBe(claude);
  });

  test("Responses uses canonical history by reference", () => {
    const items = [{ type: "tool_search_call", call_id: "search-1", execution: "client" }];
    const projected = projectHistoryForProvider(items, "responses");
    expect(projected).toBe(items);
    expect(projected[0]).toBe(items[0]);
  });

  test("Responses strips the Chat function envelope while retaining independent call extensions", () => {
    const items = [
      {
        type: "function_call",
        name: "lookup",
        arguments: "{}",
        callId: "call-fixture",
        providerData: {
          type: "function",
          function: { name: "lookup", arguments: "{}" },
          namespace: "tools",
        },
      },
    ];
    const before = JSON.stringify(items);
    const projected = projectHistoryForProvider(items, "responses");
    expect(projected).toEqual([{ ...items[0], providerData: { namespace: "tools" } }]);
    expect(projectHistoryForProvider(projected, "responses")).toBe(projected);
    expect(JSON.stringify(items)).toBe(before);
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

  test("Chat normalizes structured system/developer text without rewriting history on replay", () => {
    for (const role of ["system", "developer"]) {
      const item = {
        type: "message",
        role,
        content: [
          { type: "input_text", text: "first instruction" },
          { type: "input_text", text: "second instruction" },
        ],
      };
      const original = JSON.stringify(item);
      for (let request = 0; request < 2; request++)
        expect(projectHistoryForProvider([item], "chat")).toEqual([
          {
            type: "message",
            role: "system",
            content: "first instruction\nsecond instruction",
          },
        ]);
      expect(JSON.stringify(item)).toBe(original);
    }
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
