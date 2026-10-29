import { describe, expect, test } from "bun:test";
import { tool, type Tool } from "@openai/agents";
import { LazyToolRuntime } from "../src/lazy-tool-transport";
import type { ToolSelector } from "../src/tool-discovery-decision";
import {
  createEmbeddingToolRanker,
  fuseRankings,
  TOOL_MEANING_POLICY,
  type ToolTextEmbedder,
} from "../src/tool-discovery-meaning";

function candidate(name: string, description: string): Tool {
  return tool({
    name,
    description,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as never,
    strict: false,
    execute: () => "ok",
  }) as Tool;
}

// A toy embedding space: one axis per concept, whatever language names it.
const CONCEPTS = [
  ["stock", "lagerbestand", "inventory"],
  ["project", "projekt"],
  ["email", "e-mail", "mail"],
  ["invoice", "rechnung", "bill"],
];
function conceptEmbedder(calls: string[][] = []): ToolTextEmbedder {
  return {
    space: "concepts",
    async embed(texts) {
      calls.push(texts);
      return texts.map((text) => [
        ...CONCEPTS.map((words) => (words.some((w) => text.toLowerCase().includes(w)) ? 1 : 0)),
        0.01,
      ]);
    },
  };
}

const TOOLS = [
  candidate("mcp_app__projects_search", "Search projects by name or number."),
  candidate("mcp_app__stock_levels_list", "List the stock levels of products in a warehouse."),
  candidate("mcp_app__messages_send", "Send an email to a person."),
  candidate("mcp_app__invoices_list", "List invoices and bills for a customer."),
];
const signal = () => new AbortController().signal;

describe("meaning ranking", () => {
  test("a cold ranker answers nothing, computes tool vectors once, then ranks by meaning", async () => {
    const calls: string[][] = [];
    const ranker = createEmbeddingToolRanker(conceptEmbedder(calls));
    expect(
      await ranker({
        queries: ["zeige lagerbestand"],
        tools: TOOLS,
        signal: signal(),
      }),
    ).toBe(undefined);
    expect(await ranker.warm(TOOLS)).toBe(true);
    const toolTexts = calls.flat().length;
    expect(toolTexts).toBe(TOOLS.length);
    const [ranking] = (await ranker({
      queries: ["zeige lagerbestand"],
      tools: TOOLS,
      signal: signal(),
    }))!;
    expect(ranking![0]).toBe("mcp_app__stock_levels_list");
    // Only the query is embedded again; one request answers several queries.
    await ranker({
      queries: ["sende rechnung", "finde projekt"],
      tools: TOOLS,
      signal: signal(),
    });
    expect(calls.slice(-2)).toEqual([["zeige lagerbestand"], ["sende rechnung", "finde projekt"]]);
    expect(calls.flat().length).toBe(toolTexts + 3);
  });

  test("a changed description is embedded again; an unchanged one is not", async () => {
    const calls: string[][] = [];
    const ranker = createEmbeddingToolRanker(conceptEmbedder(calls));
    await ranker.warm(TOOLS);
    const changed = [...TOOLS.slice(1), candidate("mcp_app__projects_search", "Find projects.")];
    await ranker.warm(changed);
    expect(calls.at(-1)).toEqual(["projects_search\nFind projects."]);
  });

  test("a failing model pauses meaning ranking instead of slowing every search", async () => {
    let clock = 0;
    let failing = true;
    let requests = 0;
    const errors: unknown[] = [];
    const inner = conceptEmbedder();
    const ranker = createEmbeddingToolRanker(
      {
        space: "concepts",
        async embed(texts) {
          requests++;
          if (failing) throw new Error("unavailable");
          return await inner.embed(texts);
        },
      },
      { now: () => clock, onError: (error) => errors.push(error) },
    );
    expect(await ranker.warm(TOOLS)).toBe(false);
    expect(errors).toHaveLength(1);
    failing = false;
    expect(await ranker.warm(TOOLS)).toBe(false);
    expect(await ranker({ queries: ["mail"], tools: TOOLS, signal: signal() })).toBe(undefined);
    expect(requests).toBe(1);
    clock += TOOL_MEANING_POLICY.retryAfterMs;
    expect(await ranker.warm(TOOLS)).toBe(true);
    expect(await ranker({ queries: ["mail"], tools: TOOLS, signal: signal() })).toBeDefined();
  });

  test("vectors of the wrong count or shape are refused", async () => {
    const ranker = createEmbeddingToolRanker({
      space: "broken",
      embed: async (texts) => texts.slice(1).map(() => [1, 0]),
    });
    expect(await ranker.warm(TOOLS)).toBe(false);
    const zero = createEmbeddingToolRanker({
      space: "zero",
      embed: async (texts) => texts.map(() => [0, 0]),
    });
    expect(await zero.warm(TOOLS)).toBe(false);
  });

  test("an aborted search gives up on meaning without pausing it", async () => {
    const inner = conceptEmbedder();
    let hang = false;
    const ranker = createEmbeddingToolRanker({
      space: "concepts",
      embed: (texts) => (hang ? new Promise(() => {}) : inner.embed(texts)),
    });
    await ranker.warm(TOOLS);
    hang = true;
    const controller = new AbortController();
    const pending = ranker({
      queries: ["mail"],
      tools: TOOLS,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBe(undefined);
    hang = false;
    expect(await ranker({ queries: ["mail"], tools: TOOLS, signal: signal() })).toBeDefined();
  });

  test("rank fusion rewards agreement and keeps first-seen order on ties", () => {
    expect(
      fuseRankings([
        ["a", "b", "c"],
        ["b", "a", "d"],
      ])
        .slice(0, 2)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(
      fuseRankings([
        ["a", "b"],
        ["c", "b"],
      ])[0],
    ).toBe("b");
    expect(fuseRankings([["a"], ["c"]])).toEqual(["a", "c"]);
  });
});

function runtime(meaning?: ReturnType<typeof createEmbeddingToolRanker>, selector?: ToolSelector) {
  const lazy = new LazyToolRuntime(
    "generic_dispatch",
    new Set(),
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    selector,
    undefined,
    undefined,
    undefined,
    meaning,
  );
  lazy.refresh(TOOLS);
  return lazy;
}
const searchResult = async (lazy: LazyToolRuntime, query: string) => {
  const output = JSON.parse((await lazy.prepareSearch({ query })).output) as {
    tools: { name: string }[];
    suggestions?: { name: string }[];
  };
  return {
    loaded: output.tools.map((t) => t.name),
    shown: (output.suggestions ?? []).map((t) => t.name),
  };
};

describe("tool search with meaning ranking", () => {
  test("without a selector, a request in other words loads the tool that does it", async () => {
    const meaning = createEmbeddingToolRanker(conceptEmbedder());
    await meaning.warm(TOOLS);
    const plain = await searchResult(runtime(), "zeige lagerbestand");
    expect(plain.loaded).not.toContain("mcp_app__stock_levels_list");
    const ranked = await searchResult(runtime(meaning), "zeige lagerbestand");
    expect(ranked.loaded).toEqual(["mcp_app__stock_levels_list"]);
    // The other candidates are named, not dropped.
    expect(ranked.shown.length).toBeGreaterThan(0);
    expect(ranked.shown).not.toContain("mcp_app__stock_levels_list");
  });

  test("each request in a search gets its own best tool", async () => {
    const meaning = createEmbeddingToolRanker(conceptEmbedder());
    await meaning.warm(TOOLS);
    const result = await searchResult(runtime(meaning), "finde projekt; sende e-mail");
    expect(result.loaded).toEqual(["mcp_app__projects_search", "mcp_app__messages_send"]);
  });

  test("a selector judges candidates that only meaning found", async () => {
    const meaning = createEmbeddingToolRanker(conceptEmbedder());
    await meaning.warm(TOOLS);
    const seen: string[][] = [];
    const selector: ToolSelector = async (input) => {
      seen.push(input.candidates.map((c) => c.name));
      return input.candidates.map((c) => ({
        name: c.name,
        probability: c.name === "mcp_app__stock_levels_list" ? 0.9 : 0.01,
      }));
    };
    const result = await searchResult(runtime(meaning, selector), "zeige lagerbestand");
    expect(seen[0]).toContain("mcp_app__stock_levels_list");
    expect(result.loaded).toEqual(["mcp_app__stock_levels_list"]);
  });

  test("a ranker that cannot answer leaves keyword search unchanged", async () => {
    const cold = createEmbeddingToolRanker({
      space: "cold",
      embed: () => new Promise(() => {}),
    });
    for (const query of ["search projects", "send an email", "list invoices; search projects"])
      expect(await searchResult(runtime(cold), query)).toEqual(
        await searchResult(runtime(), query),
      );
  });
});
