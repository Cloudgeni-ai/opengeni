import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { hostedSearchFixture } from "./fixtures/hosted-search";
import { anthropicMessages } from "../src/anthropic-messages";
import {
  chatRouteHoistsSystemMessages,
  projectHistoryForProvider,
  ProviderHistoryIncompatibleError,
  responsesRouteDeclaresAdditionalTools,
  toolDisclosureItem,
} from "../src/provider-history-adapter";

type Item = Record<string, unknown>;
const C = (id: string): Item => ({
  type: "function_call",
  callId: id,
  name: "run",
  arguments: "{}",
});
const R = (id: string): Item => ({ type: "function_call_result", callId: id, output: id });
const OBSERVE = {
  type: "function",
  name: "interaction__browser_observe",
  description: "Observe a tab.",
  parameters: { type: "object", properties: { targetId: { type: "string" } } },
  strict: false,
};

describe("tool disclosure projection", () => {
  const disclosure = toolDisclosureItem([OBSERVE], { viaToolInvoke: true });
  const history = [
    { type: "message", role: "user", content: "open the page" },
    C("a"),
    C("b"),
    R("a"),
    R("b"),
    disclosure,
  ];

  test("Responses declares the tools with one additional_tools item where the route accepts it", () => {
    const projected = projectHistoryForProvider(history, "responses", {
      declaresAdditionalTools: true,
    });
    expect(projected.slice(0, 5)).toEqual(history.slice(0, 5));
    expect(projected[5]).toEqual({
      type: "unknown",
      providerData: { type: "additional_tools", role: "developer", tools: [OBSERVE] },
    });
  });

  test("other Responses routes get a developer message with the definitions as text", () => {
    const projected = projectHistoryForProvider(history, "responses");
    expect(projected.slice(0, 5)).toEqual(history.slice(0, 5));
    // Only the wire message: the disclosure marker never reaches the provider.
    expect(projected[5]).toEqual({
      type: "unknown",
      providerData: { type: "message", role: "developer", content: disclosure.content },
    });
    expect(projectHistoryForProvider(history, "responses")).toEqual(projected);
  });

  test("only verified Responses routes receive additional_tools", () => {
    expect(responsesRouteDeclaresAdditionalTools("codex-subscription")).toBe(true);
    for (const kind of [
      "openai",
      "azure-openai",
      "azure-mai",
      "direct-openai-workspace",
      "direct-azure-workspace",
      "xai-subscription",
      "supergrok-subscription",
      "api-key",
      "vercel-gateway-managed",
      "openrouter-workspace",
    ]) {
      expect(responsesRouteDeclaresAdditionalTools(kind)).toBe(false);
    }
  });

  test("with tool_invoke the text carries the definitions; otherwise it asks for a tool_search load", () => {
    expect(String(disclosure.content)).toStartWith(
      "These tools are now available. Call one by its name, or through tool_invoke with its name and a nested arguments object. Definitions:\n",
    );
    const native = toolDisclosureItem([OBSERVE], { viaToolInvoke: false });
    expect(String(native.content)).toBe(
      'These tools are now available: interaction__browser_observe. Load them with tool_search using names ["interaction__browser_observe"], then call them by name.',
    );
    // The definitions still ride along for routes that declare them natively.
    expect(
      projectHistoryForProvider([native], "responses", { declaresAdditionalTools: true })[0],
    ).toEqual({
      type: "unknown",
      providerData: { type: "additional_tools", role: "developer", tools: [OBSERVE] },
    });
  });

  test("Claude gets a system message with the definitions after the step's results", () => {
    const projected = projectHistoryForProvider(history, "anthropic-messages");
    expect(projected[5]).toEqual({
      type: "message",
      role: "system",
      content: disclosure.content,
    });
    const messages = anthropicMessages(projected as ModelRequest["input"]);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "system",
    ]);
    const system = JSON.stringify(messages.at(-1)!.content);
    expect(system).toContain("tool_invoke");
    expect(system).toContain("interaction__browser_observe");
  });

  test("Chat gets a system message, or a machine-origin user message where systems are hoisted", () => {
    const chat = projectHistoryForProvider(history, "chat");
    expect(chat[5]).toEqual({ type: "message", role: "system", content: disclosure.content });
    const gemini = projectHistoryForProvider(history, "chat", { hoistsSystemMessages: true });
    expect(gemini[5]!.role).toBe("user");
    expect(String(gemini[5]!.content)).toStartWith(
      "Opengeni tool update (machine-origin input; no new human message).\n",
    );
    expect(String(gemini[5]!.content)).toEndWith(String(disclosure.content));
    // The item depends only on itself, so replays reproduce the same prefix.
    expect(projectHistoryForProvider(history, "chat")).toEqual(chat);
  });

  test("the definitions are the frozen JSON, and only Gemini routes count as hoisting", () => {
    const content = String(disclosure.content);
    expect(JSON.parse(content.slice(content.indexOf("\n") + 1))).toEqual({ tools: [OBSERVE] });
    for (const model of ["google/gemini-2.5-flash-lite", "gemini-3-pro", "vertex/gemini-2.5"]) {
      expect(chatRouteHoistsSystemMessages(model)).toBe(true);
    }
    for (const model of ["openai/gpt-4.1-nano", "anthropic/claude-haiku-4.5", "fixture"]) {
      expect(chatRouteHoistsSystemMessages(model)).toBe(false);
    }
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
      // A session in the runtime form gets runtime input, never the model's
      // own speech it could learn to imitate; one still in the assistant form
      // keeps the projection its earlier requests sent.
      for (const [options, role] of [
        [{ searchRecordForm: "runtime" }, "user"],
        [{ searchRecordForm: "assistant" }, "assistant"],
        [{}, "assistant"],
      ] as const) {
        const projected = projectHistoryForProvider(items, api, options);
        expect(projected).toHaveLength(items.length);
        expect(projected[1]).toMatchObject({ type: "message", role });
        expect(JSON.stringify(projected[1]!.content)).toContain("exactly seven colors");
        expect(projected[2]).toBe(items[2]);
        expect(projected[3]).toBe(items[3]);
        expect(projectHistoryForProvider(projected, api, options)).toBe(projected);
        expect(items).toEqual(before);
      }
    }
  });
  test("a search record never separates a tool call from its result on any provider API", () => {
    const call = (callId: string) => ({
      type: "function_call",
      callId,
      name: "lookup",
      arguments: "{}",
    });
    const result = (callId: string) => ({ type: "function_call_result", callId, output: "ok" });
    const items = [
      { type: "message", role: "user", content: "Find docs" },
      call("a"),
      call("b"),
      hostedSearchFixture(),
      result("a"),
      hostedSearchFixture(),
      result("b"),
      call("c"),
      result("c"),
    ];
    const before = structuredClone(items);
    const runtime = { searchRecordForm: "runtime" } as const;
    for (const api of ["responses", "chat", "anthropic-messages"] as const) {
      const projected = projectHistoryForProvider(items, api, runtime);
      const shape = projected.map((item) =>
        item.type === "message" && item.role === "user" && item !== items[0]
          ? "record"
          : String(item.type),
      );
      expect(shape).toEqual([
        "message",
        "function_call",
        "function_call",
        "function_call_result",
        "function_call_result",
        "record",
        "record",
        "function_call",
        "function_call_result",
      ]);
      // Stable: projecting the projection changes nothing.
      expect(projectHistoryForProvider(projected, api, runtime)).toBe(projected);
      expect(items).toEqual(before);
    }
    // Claude receives each result right after its call.
    const claude = anthropicMessages(
      projectHistoryForProvider(items, "anthropic-messages", runtime) as ModelRequest["input"],
    );
    expect(claude.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(claude[2]!.content.map((block: any) => block.type)).toEqual([
      "tool_result",
      "tool_result",
      "text",
      "text",
    ]);
    // A record outside any open call stays exactly where it was.
    const settled = [call("a"), result("a"), hostedSearchFixture(), call("b"), result("b")];
    expect(
      projectHistoryForProvider(settled, "chat", runtime).map((item) =>
        item.type === "message" ? "record" : item.type,
      ),
    ).toEqual([
      "function_call",
      "function_call_result",
      "record",
      "function_call",
      "function_call_result",
    ]);
  });

  test("every request's projection is a prefix of the next one's, in both forms, on every API", () => {
    const call = (callId: string) => ({
      type: "function_call",
      callId,
      name: "lookup",
      arguments: "{}",
    });
    const result = (callId: string) => ({ type: "function_call_result", callId, output: "ok" });
    const user = (content: string) => ({ type: "message", role: "user", content });
    const assistant = (content: string) => ({ type: "message", role: "assistant", content });
    // Each step is what one later request adds; a request goes out once its
    // calls have results, unless stored history lost one. Claude can write
    // text and search after its own tool call, before the results.
    const steps: Item[][] = [
      [user("u1"), call("lost")],
      [user("u2"), hostedSearchFixture(), assistant("a1")],
      [
        user("u3"),
        call("a"),
        hostedSearchFixture(),
        assistant("after the call"),
        call("b"),
        result("a"),
        result("b"),
      ],
      [hostedSearchFixture(), assistant("a2")],
      [call("c"), hostedSearchFixture()],
      [user("u4")],
    ];
    for (const api of ["responses", "chat", "anthropic-messages"] as const) {
      for (const searchRecordForm of ["assistant", "runtime"] as const) {
        let history: Item[] = [];
        let previous: string[] = [];
        for (const step of steps) {
          history = [...history, ...step];
          const sent = projectHistoryForProvider(history, api, { searchRecordForm }).map((item) =>
            JSON.stringify(item),
          );
          expect(sent.slice(0, previous.length)).toEqual(previous);
          previous = sent;
        }
        // The open calls' results still follow their calls directly.
        const final = projectHistoryForProvider(history, api, { searchRecordForm });
        const at = (item: Item) => final.indexOf(item);
        expect(
          at(history.find((item) => item.callId === "b" && item.type === "function_call")!),
        ).toBe(
          at(history.find((item) => item.callId === "a" && item.type === "function_call_result")!) -
            1,
        );
      }
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

/**
 * What Chat Completions would reject: the SDK's Chat converter puts
 * consecutive function calls into one assistant `tool_calls` message and ends
 * that message at any other item. Each tool message must answer a call of the
 * assistant message directly before its run of tool messages (else `orphan`),
 * and every call must be answered in that run (else `unanswered`).
 */
function chatToolProblems(items: Item[]): string[] {
  const problems: string[] = [];
  let group: Set<string> | null = null;
  let unanswered = new Set<string>();
  let previous: unknown;
  const endRun = () => {
    for (const id of unanswered) problems.push(`unanswered ${id}`);
    unanswered = new Set();
  };
  for (const item of items) {
    const id = String(item.callId ?? (item.providerData as Item | undefined)?.callId);
    if (item.type === "function_call") {
      if (previous !== "function_call" || !group) {
        endRun();
        group = new Set();
      }
      group.add(id);
      unanswered.add(id);
    } else if (item.type === "function_call_result") {
      if (!group?.has(id) || !unanswered.delete(id)) problems.push(`orphan ${id}`);
    } else {
      endRun();
      group = null;
    }
    previous = item.type;
  }
  endRun();
  return problems;
}

describe("historical facts never separate a tool call from its result", () => {
  const user = (content: string): Item => ({ type: "message", role: "user", content });
  const searchCall = (id: string): Item => ({
    type: "tool_search_call",
    execution: "client",
    providerData: { callId: id },
    arguments: { query: "synthetic" },
  });
  const searchOutput = (id: string): Item => ({
    type: "tool_search_output",
    execution: "client",
    providerData: { callId: id },
    tools: [{ type: "function", name: "synthetic_tool" }],
  });
  const isFact = (item: Item) =>
    item.type === "message" &&
    item.role === "assistant" &&
    typeof item.content === "string" &&
    item.content.startsWith("[Opengeni historical");
  const shape = (items: Item[]) => items.map((item) => (isFact(item) ? "fact" : String(item.type)));
  // One Responses step: three function calls and a client-executed tool
  // search in one parallel batch, the search's output first.
  const parallelStep = (): Item[] => [
    user("do the thing"),
    C("a"),
    C("b"),
    C("c"),
    searchCall("d"),
    searchOutput("d"),
    R("a"),
    R("b"),
    R("c"),
    { type: "message", role: "assistant", content: "done" },
  ];

  test("Chat moves the tool-search facts after the batch's results", () => {
    const items = parallelStep();
    const before = structuredClone(items);
    const projected = projectHistoryForProvider(items, "chat");
    expect(chatToolProblems(projected)).toEqual([]);
    expect(projected.slice(0, 4)).toEqual(items.slice(0, 4));
    expect(projected.slice(4, 7)).toEqual([R("a"), R("b"), R("c")]);
    expect(projected.slice(7, 9).every(isFact)).toBe(true);
    expect(String(projected[7]!.content)).toContain("tool_search_call");
    expect(String(projected[8]!.content)).toContain("tool_search_output");
    expect(projected[9]).toBe(items[9]);
    expect(items).toEqual(before);
    // Stable: projecting the projection changes nothing.
    expect(projectHistoryForProvider(projected, "chat")).toBe(projected);
  });

  test("Chat keeps every kind of fact out of an open batch, in order", () => {
    const namespaced: Item = {
      type: "function_call",
      namespace: "mail",
      name: "search",
      callId: "n",
      arguments: "{}",
    };
    const items: Item[] = [
      user("go"),
      C("a"),
      { type: "shell_call", callId: "s", action: { commands: ["true"] } },
      C("b"),
      namespaced,
      { type: "hosted_tool_call", name: "code_interpreter_call", id: "h" },
      { type: "computer_call", callId: "x", action: { type: "screenshot" } },
      R("a"),
      { type: "shell_call_output", callId: "s", output: [] },
      R("n"),
      { type: "computer_call_result", callId: "x", output: { type: "computer_screenshot" } },
      R("b"),
      C("e"),
      { type: "apply_patch_call", callId: "p", operation: { type: "delete_file", path: "x" } },
      R("e"),
      { type: "apply_patch_call_output", callId: "p", status: "completed" },
    ];
    const projected = projectHistoryForProvider(items, "chat");
    expect(chatToolProblems(projected)).toEqual([]);
    expect(shape(projected)).toEqual([
      "message",
      "function_call",
      "function_call",
      "function_call_result",
      "function_call_result",
      "fact",
      "fact",
      "fact",
      "fact",
      "fact",
      "fact",
      "fact",
      "function_call",
      "function_call_result",
      "fact",
      "fact",
    ]);
    const factTypes = projected
      .filter(isFact)
      .map((item) => /historical (\S+) fact/.exec(String(item.content))?.[1]);
    expect(factTypes).toEqual([
      "shell_call",
      "function_call",
      "hosted_tool_call",
      "computer_call",
      "shell_call_output",
      "function_call_result",
      "computer_call_result",
      "apply_patch_call",
      "apply_patch_call_output",
    ]);
  });

  test("Chat projection of each request is a prefix of the next one's", () => {
    const steps: Item[][] = [
      parallelStep(),
      [user("again"), C("e"), searchCall("f"), searchOutput("f"), R("e")],
      [user("more"), C("g"), C("h"), R("g"), searchOutput("i"), R("h")],
    ];
    let history: Item[] = [];
    let previous: string[] = [];
    for (const step of steps) {
      history = [...history, ...step];
      const projected = projectHistoryForProvider(history, "chat");
      const sent = projected.map((item) => JSON.stringify(item));
      expect(sent.slice(0, previous.length)).toEqual(previous);
      expect(chatToolProblems(projected)).toEqual([]);
      previous = sent;
    }
  });

  test("a stored call that never got a result holds nothing back past the next person message", () => {
    // History repair normally drops such a call before projection.
    const items = [user("lost"), C("lost"), searchCall("g"), user("next"), C("h"), R("h")];
    const projected = projectHistoryForProvider(items, "chat");
    expect(shape(projected)).toEqual([
      "message",
      "function_call",
      "fact",
      "message",
      "function_call",
      "function_call_result",
    ]);
    expect(chatToolProblems(projected)).toEqual(["unanswered lost"]);
  });

  test("Chat moves runtime notices inside a step after its results; a person's message ends it", () => {
    const notice: Item = { type: "message", role: "developer", content: "runtime notice" };
    const items = [user("go"), C("a"), C("b"), R("a"), notice, searchOutput("d"), R("b")];
    const projected = projectHistoryForProvider(items, "chat");
    expect(chatToolProblems(projected)).toEqual([]);
    expect(projected.slice(0, 5)).toEqual([user("go"), C("a"), C("b"), R("a"), R("b")]);
    expect(projected[5]).toMatchObject({ role: "system", content: "runtime notice" });
    expect(isFact(projected[6]!)).toBe(true);

    // A tool disclosure that Chat receives as a machine-origin user message.
    const disclosure = toolDisclosureItem([OBSERVE], { viaToolInvoke: true });
    const hoisted = projectHistoryForProvider(
      [user("go"), C("a"), C("b"), R("a"), disclosure, searchOutput("d"), R("b")],
      "chat",
      { hoistsSystemMessages: true },
    );
    expect(chatToolProblems(hoisted)).toEqual([]);
    expect(hoisted.map((item) => item.role ?? item.type)).toEqual([
      "user",
      "function_call",
      "function_call",
      "function_call_result",
      "function_call_result",
      "user",
      "assistant",
    ]);

    // A person's message is never moved; the calls it interrupts stay open.
    const steered = [user("go"), C("a"), C("b"), R("a"), user("stop"), R("b")];
    expect(projectHistoryForProvider(steered, "chat")).toBe(steered);
  });

  test("Claude keeps facts inside the reply and moves them only out of a step's results", () => {
    // The tool-search output before the results stays in the assistant reply.
    const items = parallelStep();
    const projected = projectHistoryForProvider(items, "anthropic-messages");
    expect(projected.map((item) => item.type)).toEqual(items.map((item) => item.type));
    expect(
      anthropicMessages(projected as ModelRequest["input"]).map((message) => message.role),
    ).toEqual(["user", "assistant", "user", "assistant"]);

    // An output and a system notice that came between the step's results move
    // back before them, so the next reply still starts with its own thinking.
    const thinking: Item = {
      type: "reasoning",
      content: [],
      providerData: {
        anthropic: { block: { type: "thinking", thinking: "next", signature: "sig" } },
      },
    };
    const notice: Item = { type: "message", role: "system", content: "runtime notice" };
    const between = [
      user("go"),
      C("a"),
      C("b"),
      searchCall("d"),
      R("a"),
      notice,
      searchOutput("d"),
      R("b"),
      thinking,
      C("e"),
      R("e"),
    ];
    const moved = projectHistoryForProvider(between, "anthropic-messages");
    expect(moved.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call",
      "tool_search_call",
      "message",
      "tool_search_output",
      "function_call_result",
      "function_call_result",
      "reasoning",
      "function_call",
      "function_call_result",
    ]);
    const claude = anthropicMessages(moved as ModelRequest["input"]);
    expect(claude.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "system",
      "assistant",
      "user",
    ]);
    expect(claude[2]!.content.map((block: any) => block.type)).toEqual([
      "tool_result",
      "tool_result",
    ]);
    expect(claude[4]!.content[0]).toMatchObject({ type: "thinking" });
  });
});
