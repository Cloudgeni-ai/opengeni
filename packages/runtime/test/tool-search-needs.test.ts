import { describe, expect, test } from "bun:test";
import { tool, type Tool } from "@openai/agents";
import { createHttpDecisionModel } from "@opengeni/decisions";
import {
  familiesTooLargeNotice,
  LazyToolRuntime,
  searchNeeds,
  toolFamiliesNotice,
} from "../src/lazy-tool-transport";
import { familyPrefix, TOOL_FAMILY_POLICY, toolFamilies } from "../src/tool-discovery-catalog";
import {
  createToolSelector,
  selectFromJudgments,
  TOOL_SELECTION_POLICY,
  toolSelectionRequest,
  type ToolDecisionInput,
  type ToolJudgment,
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

/** A judgment for a query split into requests: `requests[k]` for request k. */
const judged = (name: string, requests: number[], prerequisite = 0): ToolJudgment => ({
  name,
  probability: requests.reduce((sum, p) => sum + p, 0) + prerequisite,
  requests,
  prerequisite,
});

describe("a search's separate requests", () => {
  test("semicolons, lines, sentences and the parts of a sentence that asks for several things", () => {
    expect(searchNeeds("create a deviation; upload a photo\nset the responsible person")).toEqual([
      "create a deviation",
      "upload a photo",
      "set the responsible person",
    ]);
    expect(
      searchNeeds(
        "Open a pull request for my branch, ask Kari to review it and tell me when CI is green",
      ),
    ).toEqual([
      "Open a pull request for my branch",
      "ask Kari to review it",
      "tell me when CI is green",
    ]);
    expect(searchNeeds("Find the open invoices. Then email the customer.")).toEqual([
      "Find the open invoices.",
      "Then email the customer.",
    ]);
    // Norwegian and other languages split at the same kind of word.
    expect(searchNeeds("finn prosjektet og lag en sjekkliste")).toEqual([
      "finn prosjektet",
      "lag en sjekkliste",
    ]);
  });
  test("a part too short to be a request of its own stays with its neighbour", () => {
    expect(searchNeeds("list files, photos and invoices")).toEqual([
      "list files, photos and invoices",
    ]);
    expect(searchNeeds("search and replace text in a document")).toEqual([
      "search and replace text in a document",
    ]);
    expect(searchNeeds("checklists list templates create project")).toEqual([
      "checklists list templates create project",
    ]);
  });
  test("at most maxRequests requests; later ones join the last", () => {
    const many = Array.from({ length: 12 }, (_, i) => `create record ${i}`).join("; ");
    const needs = searchNeeds(many);
    expect(needs).toHaveLength(TOOL_SELECTION_POLICY.maxRequests);
    expect(needs.at(-1)).toContain("create record 11");
  });
});

describe("per-request selection", () => {
  test("each request's best loads whatever the result limit; other tools only fill up to it", () => {
    const judgments = [
      judged("deviations_create", [0.95, 0.01, 0.01]),
      judged("files_create_upload", [0.02, 0.9, 0.01]),
      judged("deviations_set_responsible", [0.01, 0.02, 0.85]),
      judged("deviations_update", [0.3, 0.01, 0.4]),
      judged("photos_list", [0.05, 0.1, 0.01]),
    ];
    const selection = selectFromJudgments(judgments, 1);
    expect(selection.load).toEqual([
      "deviations_create",
      "files_create_upload",
      "deviations_set_responsible",
    ]);
    expect(selection.unserved).toEqual([]);
  });
  test("another tool for a request that has its best loads only when it is very likely", () => {
    const judgments = [
      judged("send_message", [0.05, 0.7]),
      judged("send_email", [0.05, 0.62]),
      judged("invoices_list_unpaid", [0.9, 0.01]),
      judged("create_draft", [0.01, 0.85]),
    ];
    // create_draft is request 2's best; send_message (0.75) is not above 0.8.
    expect(selectFromJudgments(judgments).load).toEqual(["invoices_list_unpaid", "create_draft"]);
  });
  test("a prerequisite loads only when a loaded tool's description names it", () => {
    const judgments = [
      judged("checklists_import_template", [0.9]),
      judged("form_templates_list", [0.1], 0.7),
      judged("projects_list", [0.05], 0.6),
    ];
    const named = (name: string) =>
      name === "checklists_import_template" ? ["form_templates_list"] : [];
    expect(selectFromJudgments(judgments, 8, { named }).load).toEqual([
      "checklists_import_template",
      "form_templates_list",
    ]);
    // Without description evidence, any judged prerequisite can load, still bounded.
    expect(selectFromJudgments(judgments, 8).load).toEqual([
      "checklists_import_template",
      "form_templates_list",
      "projects_list",
    ]);
    const many = [
      judged("a", [0.9]),
      ...["p1", "p2", "p3", "p4", "p5"].map((name) => judged(name, [0], 0.9)),
    ];
    expect(selectFromJudgments(many).load).toHaveLength(1 + TOOL_SELECTION_POLICY.maxPrerequisites);
  });
  test("a request no loaded tool serves shows its best candidates by name", () => {
    const judgments = [
      judged("projects_update", [0.9, 0.01]),
      judged("payroll_exports_export", [0.01, 0.4]),
      judged("payroll_exports_create", [0.01, 0.35]),
      judged("payroll_exports_send", [0.01, 0.2]),
      judged("payroll_exports_delete", [0.01, 0.1]),
    ];
    const selection = selectFromJudgments(judgments);
    expect(selection.load).toEqual(["projects_update"]);
    expect(selection.unserved).toEqual([
      "payroll_exports_export",
      "payroll_exports_create",
      "payroll_exports_send",
    ]);
    expect(selection.clear).toBe(false);
  });
  test("a query without separate requests keeps the one-request behaviour", () => {
    const plain = [
      { name: "a", probability: 0.92 },
      { name: "b", probability: 0.05 },
    ];
    expect(selectFromJudgments(plain)).toEqual({
      load: ["a"],
      rest: ["b"],
      unserved: [],
      clear: true,
    });
  });
});

describe("the typed selector request", () => {
  const candidates = ["a", "b"].map((name) => ({ name, description: name, inputFields: [] }));
  test("one choice per candidate: not needed, each request, or a prerequisite", () => {
    const one = toolSelectionRequest({ query: "get task", candidates });
    expect(Object.keys(one.questions["0"]!.criteria)).toEqual(["none", "request", "prerequisite"]);
    expect(one.input).not.toHaveProperty("requests");
    const several = toolSelectionRequest({
      query: "get task; close task",
      requests: ["get task", "close task"],
      candidates,
    });
    expect(Object.keys(several.questions["1"]!.criteria)).toEqual([
      "none",
      "request_1",
      "request_2",
      "prerequisite",
    ]);
    expect(several.input.requests).toEqual(["get task", "close task"]);
  });
  test("answers become per-request and prerequisite probabilities", async () => {
    const select = createToolSelector(
      createHttpDecisionModel({
        provider: "openrouter",
        model: "test",
        apiKey: "test-only",
        fetch: (async () =>
          Response.json({
            answers: {
              0: {
                type: "choice",
                choice: "request_2",
                probabilities: { none: 0.1, request_1: 0.1, request_2: 0.7, prerequisite: 0.1 },
              },
              1: { type: "choice", choice: "none" },
            },
            usage: {},
          })) as typeof fetch,
      }),
    );
    const [a, b] = await select({ query: "x; y", requests: ["x", "y"], candidates });
    expect(a!.requests![0]).toBeCloseTo(0.1);
    expect(a!.requests![1]).toBeCloseTo(0.7);
    expect(a!.prerequisite).toBeCloseTo(0.1);
    expect(a!.probability).toBeCloseTo(0.9);
    // A choice without a distribution counts as certain.
    expect(b).toMatchObject({ probability: 0, requests: [0, 0], prerequisite: 0 });
  });
});

describe("slow and failed selections", () => {
  const candidates = [{ name: "tasks__get", description: "Get task", inputFields: [] }];
  const answer = {
    answers: {
      0: {
        type: "choice",
        choice: "request",
        probabilities: { none: 0.1, request: 0.9, prerequisite: 0 },
      },
    },
    usage: {},
  };
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

describe("a multi-request search on the runtime", () => {
  const tools = [
    candidate("records__deviations_create", "Create a deviation in a project."),
    candidate(
      "records__deviations_link_file",
      "Attach an uploaded file to a deviation. Upload it first with records.files_create_upload.",
    ),
    candidate("records__files_create_upload", "Start a file upload and return an upload URL."),
    candidate("records__deviations_set_responsible", "Set the responsible person on a deviation."),
    candidate("records__deviations_list", "List deviations in a project."),
  ];
  const runtimeWith = (selector: ToolSelector) => {
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
      selector,
    );
    runtime.refresh(tools);
    return runtime;
  };
  test("loads a tool for every request and the prerequisite its description names, at limit 1", async () => {
    const seen: ToolDecisionInput[] = [];
    const roles: Record<string, [number[], number]> = {
      records__deviations_create: [[0.9, 0.02], 0],
      records__deviations_link_file: [[0.1, 0.05], 0.1],
      records__files_create_upload: [[0.02, 0.05], 0.7],
      records__deviations_set_responsible: [[0.01, 0.92], 0],
    };
    const runtime = runtimeWith(async (input) => {
      seen.push(input);
      return input.candidates.map((c) => {
        const [requests, prerequisite] = roles[c.name] ?? [[0, 0], 0];
        return judged(c.name, requests, prerequisite);
      });
    });
    const result = await runtime.prepareSearch({
      query: "create a deviation with a photo attached and set the responsible person",
      limit: 1,
    });
    expect(seen[0]!.requests).toEqual([
      "create a deviation with a photo attached",
      "set the responsible person",
    ]);
    // files_create_upload is a prerequisite, but no loaded tool names it.
    expect(result.tools?.map((t) => t.name)).toEqual([
      "records__deviations_create",
      "records__deviations_set_responsible",
    ]);
    // Once the tool that names it loads, the prerequisite does too.
    roles.records__deviations_create = [[0.2, 0.02], 0];
    roles.records__deviations_link_file = [[0.9, 0.02], 0];
    const second = await runtime.prepareSearch({
      query: "attach a photo to the deviation and set the responsible person",
      limit: 1,
    });
    expect(second.tools?.map((t) => t.name)).toEqual([
      "records__deviations_link_file",
      "records__deviations_set_responsible",
      "records__files_create_upload",
    ]);
  });
});

describe("tool families", () => {
  test("a dotted name's part before its last dot, else the longest shared underscore prefix", () => {
    const families = toolFamilies([
      { name: "m1", server: "s", published: "checklists.create" },
      { name: "m2", server: "s", published: "checklists.list" },
      { name: "m3", server: "s", published: "checklists.archive" },
      { name: "m4", server: "s", published: "handbooks.list" },
      { name: "a__job_safety_analyses_list", server: "a" },
      { name: "a__job_safety_analyses_get", server: "a" },
      { name: "a__job_safety_analyses_create", server: "a" },
      { name: "a__job_titles_list", server: "a" },
      // Operation words alone are no family.
      { name: "b__list_issues", server: "b" },
      { name: "b__list_teams", server: "b" },
      { name: "b__list_users", server: "b" },
      // Families never span servers.
      { name: "c__job_safety_analyses_delete", server: "c" },
    ]);
    expect(families.get("m1")).toBe("checklists.*");
    expect(families.has("m4")).toBe(false);
    expect(families.get("a__job_safety_analyses_get")).toBe("job_safety_analyses_*");
    expect(families.has("a__job_titles_list")).toBe(false);
    expect(families.has("b__list_issues")).toBe(false);
    expect(families.has("c__job_safety_analyses_delete")).toBe(false);
    expect(familyPrefix("checklists.*")).toBe("checklists_");
    expect(familyPrefix("job_safety_analyses_*")).toBe("job_safety_analyses_");
    expect(familyPrefix("checklists_create")).toBeUndefined();
  });

  const family = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      candidate(`mcp_0123456789abcdef__${prefix}_op${i}`, `Operation ${i} on ${prefix}.`),
    );
  const runtimeWith = (tools: Tool[], selector?: ToolSelector) => {
    const mapping = new Map(
      tools.map((t) => [(t as Tool & { name: string }).name, "account-0123456789abcdef0123456789"]),
    );
    const runtime = new LazyToolRuntime(
      "generic_dispatch",
      new Set(mapping.values()),
      undefined,
      new Set(mapping.values()),
      new Set(),
      () => mapping,
      false,
      false,
      undefined,
      undefined,
      undefined,
      selector,
    );
    runtime.refresh(tools);
    return runtime;
  };
  test('names: ["<family>.*"] loads a family, up to the bound, and says when one is too large', async () => {
    const runtime = runtimeWith([...family("checklists", 6), ...family("deviations", 30)]);
    const loaded = await runtime.prepareSearch({ query: "", names: ["checklists.*"] });
    expect(loaded.tools).toHaveLength(6);
    expect(JSON.parse(loaded.output)).toMatchObject({ schemasLoaded: true, unavailable: [] });
    const tooLarge = await runtime.prepareSearch({ query: "", names: ["deviations_*"] });
    expect(tooLarge.tools).toEqual([]);
    expect(JSON.parse(tooLarge.output).familiesNotLoaded).toBe(
      familiesTooLargeNotice([{ family: "deviations_*", tools: 30 }]),
    );
    expect(familiesTooLargeNotice([{ family: "deviations_*", tools: 30 }])).toContain(
      `${TOOL_FAMILY_POLICY.maxLoad}`,
    );
  });
  test("a ranked result names the families of what it found, explaining the pattern once", async () => {
    const runtime = runtimeWith([...family("checklists", 6), ...family("deviations", 3)]);
    const first = JSON.parse(
      (await runtime.prepareSearch({ query: "checklists operation" })).output,
    );
    expect(first.families).toBe(toolFamiliesNotice([{ family: "checklists_*", tools: 6 }], true));
    expect(first.families).toContain('names:["<family>"]');
    const second = JSON.parse(
      (await runtime.prepareSearch({ query: "checklists operation 2" })).output,
    );
    expect(second.families).toBe(toolFamiliesNotice([{ family: "checklists_*", tools: 6 }], false));
  });
  test("tool_list splits a large connection into its families; the connection key still filters it", async () => {
    const runtime = runtimeWith([
      ...family("checklists", 25),
      ...family("deviations", 20),
      candidate("mcp_0123456789abcdef__whoami", "Who am I."),
    ]);
    const list = runtime.controlTools.find((t) => t.type === "function" && t.name === "tool_list");
    if (!list || list.type !== "function") throw new Error("missing list");
    const invoke = async (args: unknown) =>
      JSON.parse(String(await list.invoke({} as never, JSON.stringify(args))));
    const groups = await invoke({ view: "groups" });
    expect(groups.groups.map((g: { group: string; count: number }) => [g.group, g.count])).toEqual([
      ["connection/0123456789ab/checklists", 25],
      ["connection/0123456789ab/deviations", 20],
      ["connection/0123456789ab/other", 1],
    ]);
    expect((await invoke({ group: "connection/0123456789ab/deviations", limit: 40 })).total).toBe(
      20,
    );
    expect((await invoke({ group: "connection/0123456789ab", limit: 40 })).total).toBe(46);
  });
});
