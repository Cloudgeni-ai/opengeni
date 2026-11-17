import { describe, expect, test } from "bun:test";
import {
  buildCompactionReplacement,
  buildRemoteV2Replacement,
  buildTrimmedCompactionReplacement,
  type CompactionItem,
  type CompactionReplacement,
} from "../src/context-compaction";
import { expandInteractionFamilyDisclosures } from "../src/lazy-tool-transport";
import { projectHistoryForProvider, TOOL_DISCLOSURE_KEY } from "../src/provider-history-adapter";

// Tools a model loaded before a compaction checkpoint and still uses must stay
// loaded after it. Before this, every rebuild dropped the search results that
// disclosed them, and the model searched for the same tools again.

const ACTIVE = "turn-active";
const EARLIER = "turn-earlier";

function definition(name: string) {
  return {
    type: "function",
    name,
    description: `Does ${name}.`,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    strict: false,
  };
}

const user = (text: string): CompactionItem => ({ type: "message", role: "user", content: text });
const reply = (text: string): CompactionItem => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const call = (
  callId: string,
  name: string,
  extra: Record<string, unknown> = {},
): CompactionItem => ({
  type: "function_call",
  callId,
  name,
  arguments: "{}",
  status: "completed",
  ...extra,
});
const result = (callId: string, name: string): CompactionItem => ({
  type: "function_call_result",
  callId,
  name,
  status: "completed",
  output: { type: "text", text: "ok" },
});

/** A native (Codex / OpenAI Responses) client tool search that loaded `names`. */
function nativeSearch(id: string, names: string[]): CompactionItem[] {
  return [
    {
      type: "tool_search_call",
      call_id: id,
      execution: "client",
      status: "completed",
      arguments: { query: "", names },
    },
    {
      type: "tool_search_output",
      call_id: id,
      execution: "client",
      status: "completed",
      tools: names.map(definition),
    },
  ];
}

/** A generic-route tool_search call whose result loaded `names` (search marker v2). */
function genericSearch(id: string, names: string[]): CompactionItem[] {
  return [
    call(id, "tool_search", {
      arguments: JSON.stringify({ query: "", names }),
      providerData: {
        "opengeni.lazy_search.v1": {
          version: 2,
          output: JSON.stringify({ tools: names.map((name) => ({ name })), schemasLoaded: true }),
          tools: names.map(definition),
        },
      },
    }),
    result(id, "tool_search"),
  ];
}

type Built = { items: CompactionItem[]; turnIds: (string | null)[] };

/** Items with the turn each belongs to. */
function history(...turns: Array<[string, CompactionItem[]]>): Built {
  return {
    items: turns.flatMap(([, items]) => items),
    turnIds: turns.flatMap(([turnId, items]) => items.map(() => turnId)),
  };
}

const remoteCheckpoint = { type: "compaction", encrypted_content: "opaque" };

const rebuilders: Array<[string, (built: Built, activeTurnId: string) => CompactionReplacement]> = [
  [
    "remote v2",
    (built, activeTurnId) =>
      buildRemoteV2Replacement(built.items, remoteCheckpoint, undefined, undefined, {
        itemTurnIds: built.turnIds,
        activeTurnId,
      }),
  ],
  [
    "portable",
    (built, activeTurnId) =>
      buildCompactionReplacement(built.items, "summary", undefined, undefined, undefined, {
        itemTurnIds: built.turnIds,
        activeTurnId,
      }),
  ],
  [
    "trimmed",
    (built, activeTurnId) =>
      buildTrimmedCompactionReplacement(built.items, undefined, undefined, undefined, {
        itemTurnIds: built.turnIds,
        activeTurnId,
      }),
  ],
];

function disclosures(items: readonly CompactionItem[]): CompactionItem[] {
  return items.filter(
    (item) =>
      item.role === "developer" &&
      typeof item.providerData === "object" &&
      item.providerData !== null &&
      TOOL_DISCLOSURE_KEY in (item.providerData as Record<string, unknown>),
  );
}

function disclosedNames(items: readonly CompactionItem[]): string[] {
  return disclosures(items).flatMap((item) =>
    (
      (item.providerData as Record<string, { tools: Array<{ name: string }> }>)[
        TOOL_DISCLOSURE_KEY
      ]!.tools ?? []
    ).map((tool) => tool.name),
  );
}

/** The reported shape: a long turn that loaded tools, compacted mid-turn. */
function midTurnNative(): Built {
  return history([
    ACTIVE,
    [
      user("Reconcile the open invoices."),
      ...nativeSearch("search-1", ["invoices_list", "invoices_get"]),
      call("c1", "invoices_list"),
      result("c1", "invoices_list"),
      ...nativeSearch("search-2", ["ledger_post"]),
      reply("Listing done; posting next."),
    ],
  ]);
}

describe("compaction keeps the tools loaded before it", () => {
  for (const [mode, rebuild] of rebuilders) {
    test(`${mode}: tools in use and tools just loaded stay loaded, with their frozen schemas`, () => {
      const built = midTurnNative();
      const { history: rebuilt, turnIds } = rebuild(built, ACTIVE);
      const carried = disclosures(rebuilt);
      expect(carried).toHaveLength(1);
      // invoices_list was called; ledger_post was loaded by the last step.
      // invoices_get was loaded and passed over, so it can be searched again.
      expect(disclosedNames(rebuilt)).toEqual(["invoices_list", "ledger_post"]);
      // The exact definitions the search disclosed, not a live re-read.
      expect(
        (carried[0]!.providerData as Record<string, { tools: unknown[] }>)[TOOL_DISCLOSURE_KEY]!
          .tools,
      ).toEqual(["invoices_list", "ledger_post"].map(definition));
      // Platform context: before the retained request, and belongs to no turn.
      const at = rebuilt.indexOf(carried[0]!);
      const request = rebuilt.findIndex((item) => item.content === "Reconcile the open invoices.");
      expect(at).toBeLessThan(request);
      expect(turnIds[at]).toBeNull();
    });

    test(`${mode}: a load is kept when called after loading, or when nothing was called since`, () => {
      const built = history(
        [
          EARLIER,
          [
            user("Check the calendar."),
            ...nativeSearch("search-1", ["calendar_list", "calendar_create"]),
            call("c1", "calendar_list"),
            result("c1", "calendar_list"),
            reply("Done."),
          ],
        ],
        [ACTIVE, [user("Now the invoices."), ...nativeSearch("search-2", ["invoices_list"])]],
      );
      expect(disclosedNames(rebuild(built, ACTIVE).history)).toEqual([
        "calendar_list",
        "invoices_list",
      ]);
    });

    test(`${mode}: generic-route searches carry their definitions for tool_invoke`, () => {
      const built = history([
        ACTIVE,
        [user("Reconcile."), ...genericSearch("g1", ["invoices_list"]), reply("Loaded.")],
      ]);
      const [carried] = disclosures(rebuild(built, ACTIVE).history);
      expect(String(carried!.content)).toContain("through tool_invoke");
      expect(String(carried!.content)).toContain('"name":"invoices_list"');
    });

    test(`${mode}: nothing is added when no tool was loaded`, () => {
      const built = history([ACTIVE, [user("Hello."), reply("Hi.")]]);
      expect(disclosures(rebuild(built, ACTIVE).history)).toEqual([]);
    });
  }

  test("a later compaction carries the set once, and keeps only what was used since", () => {
    const first = buildRemoteV2Replacement(midTurnNative().items, remoteCheckpoint);
    expect(disclosedNames(first.history)).toEqual(["invoices_list", "ledger_post"]);
    // Nothing called since the checkpoint: the carried set stays as it was.
    const idle = buildRemoteV2Replacement(
      [...first.history, reply("Still thinking.")],
      remoteCheckpoint,
    );
    expect(disclosures(idle.history)).toHaveLength(1);
    expect(disclosedNames(idle.history)).toEqual(["invoices_list", "ledger_post"]);
    // A carried tool called since stays; one passed over is dropped.
    const used = buildRemoteV2Replacement(
      [
        ...first.history,
        user("Post the last one."),
        call("c3", "ledger_post"),
        result("c3", "ledger_post"),
      ],
      remoteCheckpoint,
    );
    expect(disclosures(used.history)).toHaveLength(1);
    expect(disclosedNames(used.history)).toEqual(["ledger_post"]);
    // A carried tool can also be dropped by a portable rebuild after it.
    const portable = buildCompactionReplacement(
      [...first.history, call("c4", "exec_command"), result("c4", "exec_command")],
      "summary",
    );
    expect(disclosures(portable.history)).toEqual([]);
  });

  test("the first request after compaction declares the tools in each provider's form", () => {
    const rebuilt = buildRemoteV2Replacement(
      midTurnNative().items,
      remoteCheckpoint,
      undefined,
      undefined,
      {
        itemTurnIds: midTurnNative().turnIds,
        activeTurnId: ACTIVE,
      },
    ).history;
    const codex = projectHistoryForProvider(rebuilt, "responses", {
      declaresAdditionalTools: true,
    });
    const declared = codex.filter(
      (item) =>
        (item.providerData as Record<string, unknown> | undefined)?.type === "additional_tools",
    );
    expect(declared).toHaveLength(1);
    expect(
      (declared[0]!.providerData as { tools: Array<{ name: string }> }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["invoices_list", "ledger_post"]);
    // No compaction bookkeeping reaches any provider.
    const portable = buildCompactionReplacement(midTurnNative().items, "summary").history;
    for (const wire of [
      codex,
      projectHistoryForProvider(rebuilt, "responses"),
      projectHistoryForProvider(portable, "anthropic-messages"),
      projectHistoryForProvider(portable, "chat"),
    ]) {
      expect(JSON.stringify(wire)).not.toContain("opengeni.");
    }
  });

  test("a family disclosure after the checkpoint does not declare carried tools again", () => {
    const browser = definition("browser_act");
    const rebuilt = buildCompactionReplacement(
      [user("Open the page."), ...nativeSearch("search-1", ["browser_act"]), reply("Loaded.")],
      "summary",
    ).history;
    const after = [
      ...rebuilt,
      call("open-1", "browser_open", {
        providerData: {
          "opengeni.family_disclosure.v1": {
            version: 1,
            tools: [browser, definition("browser_observe")],
            viaToolInvoke: false,
          },
        },
      }),
      result("open-1", "browser_open"),
    ];
    const expanded = expandInteractionFamilyDisclosures(after);
    // The rebuilt prefix is untouched, and only the new tool is declared.
    expect(expanded.slice(0, rebuilt.length)).toEqual(rebuilt);
    expect(disclosedNames(expanded.slice(rebuilt.length))).toEqual(["browser_observe"]);
  });

  test("rebuilding is deterministic, so a retried compaction stores the same item", () => {
    const once = buildRemoteV2Replacement(
      midTurnNative().items,
      remoteCheckpoint,
      undefined,
      undefined,
      {
        itemTurnIds: midTurnNative().turnIds,
        activeTurnId: ACTIVE,
      },
    );
    const again = buildRemoteV2Replacement(
      midTurnNative().items,
      remoteCheckpoint,
      undefined,
      undefined,
      {
        itemTurnIds: midTurnNative().turnIds,
        activeTurnId: ACTIVE,
      },
    );
    expect(JSON.stringify(again.history)).toBe(JSON.stringify(once.history));
  });
});
