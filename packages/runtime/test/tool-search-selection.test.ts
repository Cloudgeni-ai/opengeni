import { describe, expect, test } from "bun:test";
import { tool, type Tool } from "@openai/agents";
import { createHttpDecisionModel } from "@opengeni/decisions";
import { LazyToolRuntime } from "../src/lazy-tool-transport";
import {
  createToolSelector,
  TOOL_SELECTION_POLICY,
  toolSelectionRequest,
  type ToolDecisionInput,
  type ToolSelectionFailure,
  type ToolSelector,
} from "../src/tool-discovery-decision";

function candidate(name: string, description: string): Tool {
  return tool({
    name,
    description,
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    strict: false,
    execute: () => "ok",
  }) as Tool;
}

describe("the typed selector request", () => {
  test("asks whether the agent will need each candidate, prerequisites included", () => {
    const candidates = [{ name: "a", description: "a", inputFields: [] }];
    const { input, questions } = toolSelectionRequest({ query: "get task", candidates });
    expect(input.instructions).toContain("needs called first");
    expect(input.instructions).not.toContain("smallest");
    expect(questions["0"]).toMatchObject({ type: "predicate" });
  });
});

describe("slow and failed selections", () => {
  const candidates = [{ name: "tasks__get", description: "Get task", inputFields: [] }];
  const answer = { answers: { 0: { type: "noul", noul: 0.9 } }, usage: {} };
  const withPolicy = async (
    values: Partial<Record<"hedgeAfterMs", number>>,
    run: () => Promise<void>,
  ) => {
    const policy = TOOL_SELECTION_POLICY as Record<string, number>;
    const original = { ...policy };
    Object.assign(policy, values);
    try {
      await run();
    } finally {
      Object.assign(policy, original);
    }
  };
  test("an answer slow to come gets one identical request beside it; the first answer wins", async () => {
    await withPolicy({ hedgeAfterMs: 20 }, async () => {
      const bodies: string[] = [];
      const aborted: boolean[] = [];
      const select = createToolSelector(
        createHttpDecisionModel({
          provider: "openrouter",
          model: "test",
          apiKey: "test-only",
          fetch: (async (_url: unknown, init?: RequestInit) => {
            const call = bodies.length;
            bodies.push(String(init?.body));
            // The first request hangs until it is cancelled.
            if (call === 0)
              return await new Promise<Response>((_, reject) =>
                init?.signal?.addEventListener("abort", () => {
                  aborted.push(true);
                  reject(init.signal!.reason);
                }),
              );
            return Response.json(answer);
          }) as typeof fetch,
        }),
      );
      expect((await select({ query: "get task", candidates }))[0]!.probability).toBeCloseTo(0.9);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]!);
      // The slower request is cancelled once the other answered.
      expect(aborted).toEqual([true]);
    });
  });
  test("a failed selection reports why, with its time and whether the deadline ended it", async () => {
    const failures: ToolSelectionFailure[] = [];
    const hanging = createToolSelector(
      createHttpDecisionModel({
        provider: "openrouter",
        model: "test",
        apiKey: "test-only",
        fetch: (async (_url: unknown, init?: RequestInit) =>
          await new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
          )) as typeof fetch,
      }),
      { onError: (failure) => failures.push(failure) },
    );
    await expect(
      hanging({ query: "get task", candidates, signal: AbortSignal.timeout(30) }),
    ).rejects.toThrow();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ timedOut: true, attempts: 1 });
    expect(failures[0]!.elapsedMs).toBeGreaterThanOrEqual(25);

    const refused = createToolSelector(
      createHttpDecisionModel({
        provider: "openrouter",
        model: "test",
        apiKey: "test-only",
        fetch: (async () => new Response("no", { status: 403 })) as typeof fetch,
      }),
      { onError: (failure) => failures.push(failure) },
    );
    await expect(refused({ query: "get task", candidates })).rejects.toThrow("HTTP 403");
    expect(failures[1]).toMatchObject({ timedOut: false, attempts: 1 });
  });
});

describe("a search that asks for several things", () => {
  const tools = [
    candidate("records__deviations_create", "Create a deviation in a project."),
    candidate("records__files_create_upload", "Start a file upload and return an upload URL."),
    candidate("records__deviations_set_responsible", "Set the responsible person on a deviation."),
    candidate("records__deviations_list", "List deviations in a project."),
  ];
  test("loads every tool judged needed, whatever the limit", async () => {
    const seen: ToolDecisionInput[] = [];
    const needed: Record<string, number> = {
      records__deviations_create: 0.9,
      records__files_create_upload: 0.8,
      records__deviations_set_responsible: 0.92,
    };
    const runtime = new LazyToolRuntime(
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
      (async (input) => {
        seen.push(input);
        return input.candidates.map((c) => ({ name: c.name, probability: needed[c.name] ?? 0 }));
      }) satisfies ToolSelector,
    );
    runtime.refresh(tools);
    const result = await runtime.prepareSearch({
      query: "create a deviation with a photo attached; set the responsible person",
      limit: 1,
    });
    expect(seen[0]!.requests).toEqual([
      "create a deviation with a photo attached",
      "set the responsible person",
    ]);
    // Most probable first; `limit` bounds only the suggestions.
    expect(result.tools?.map((t) => t.name)).toEqual([
      "records__deviations_set_responsible",
      "records__deviations_create",
      "records__files_create_upload",
    ]);
  });
});
