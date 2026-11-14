import { describe, expect, test } from "bun:test";
import { tool, type Tool } from "@openai/agents";
import { TOOL_DISCOVERY_CARD_META_KEY } from "@opengeni/contracts";
import { ToolSearchIndex } from "../src/tool-discovery-ranking";
import {
  catalogConnectCardRequest,
  connectCardReceiptFromResult,
  LazyToolRuntime,
  type ConnectableIntegration,
  type ConnectableIntegrationLookup,
  type ConnectCardReceipt,
  type ConnectCardRequest,
  type ConnectedToolAccount,
  type DiscoveryCardEvent,
} from "../src/lazy-tool-transport";
import { prefixedMcpToolName } from "../src/mcp-model-tool-name";

// A search that clearly names one integration the person can connect shows its
// Connect card itself, through the card tool, so the card never depends on the
// model making a second call. Every such result says whether a card is in the
// chat.

const CATALOG = "opengeni__capability_catalog_search";
const CARD = "opengeni__capability_authorization_request";
const TASKS = "opengeni__tasks_create";
const SLACK_BOT = "opengeni__slack_bot_list_channels";
const LINEAR_ISSUES = "mcp__linear__list_issues";

const SLACK = { capabilityId: "mcp:slack", name: "Slack", providerDomain: "slack.com" };
const CLICKUP = { capabilityId: "mcp:clickup", name: "ClickUp", providerDomain: "clickup.com" };
const AIRTABLE = { capabilityId: "mcp:airtable", name: "Airtable", providerDomain: "airtable.com" };
const HUBSPOT = { capabilityId: "mcp:hubspot", name: "HubSpot", providerDomain: "hubspot.com" };
const LINEAR = { capabilityId: "mcp:linear", name: "Linear", providerDomain: "linear.app" };
const GMAIL = { capabilityId: "api:gmail", name: "Gmail" };
const CALENDAR = { capabilityId: "api:google-calendar", name: "Google Calendar" };

function candidate(name: string, description: string): Tool {
  return tool({
    name,
    description,
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    strict: false,
    execute: () => "ok",
  }) as Tool;
}

const pool = (options: { withSetup?: boolean; withLinear?: boolean } = {}) => [
  candidate(
    TASKS,
    "Create a task in a task list with a title, due date and assignee. Adds the task to the list.",
  ),
  candidate(
    SLACK_BOT,
    "List public and bot-visible private Slack channels through the workspace-shared Slack bot.",
  ),
  candidate(
    "opengeni__knowledge_search",
    "Find Knowledge by subject or entity name. Omit scope to search all authorized scopes.",
  ),
  ...(options.withLinear
    ? [candidate(LINEAR_ISSUES, "List Linear issues in the workspace's projects and cycles.")]
    : []),
  ...(options.withSetup === false
    ? []
    : [
        candidate(
          CATALOG,
          "Find integrations in the reviewed workspace catalog when the user asks to add one or needed access is missing.",
        ),
        candidate(
          CARD,
          "Show a Connect card in this chat for a suitable capability returned by capability_catalog_search with setup.nextAction.",
        ),
      ]),
];

type Transport = "generic_dispatch" | "openai_native" | "codex_native";
const TRANSPORTS: readonly Transport[] = ["generic_dispatch", "openai_native", "codex_native"];

const lookupOf =
  (matches: readonly ConnectableIntegration[]): ConnectableIntegrationLookup =>
  async () =>
    matches;

/** A card tool double: records requests and answers with the given receipt. */
function cardTool(
  answer: (integration: ConnectableIntegration) => ConnectCardReceipt | null | Error = () => ({
    eventId: "event-1",
    alreadyShown: false,
    message: "The recommendation was posted for human confirmation.",
  }),
) {
  const requested: ConnectableIntegration[] = [];
  const request: ConnectCardRequest = async (integration) => {
    requested.push(integration);
    const receipt = answer(integration);
    if (receipt instanceof Error) throw receipt;
    return receipt;
  };
  return { requested, request };
}

function runtimeWith(
  transport: Transport,
  options: {
    matches: readonly ConnectableIntegration[];
    request?: ConnectCardRequest;
    withSetup?: boolean;
    withLinear?: boolean;
    accounts?: ReadonlyMap<string, ConnectedToolAccount>;
    lookup?: ConnectableIntegrationLookup;
  },
): LazyToolRuntime {
  const runtime = new LazyToolRuntime(
    transport,
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
    undefined,
    undefined,
    options.lookup ?? lookupOf(options.matches),
    options.accounts ? () => options.accounts! : undefined,
    undefined,
    undefined,
    true,
    options.request,
  );
  runtime.refresh(
    pool({
      ...(options.withSetup === undefined ? {} : { withSetup: options.withSetup }),
      ...(options.withLinear === undefined ? {} : { withLinear: options.withLinear }),
    }),
  );
  return runtime;
}

const outputOf = (result: { output: string }) =>
  JSON.parse(result.output) as { notConnected?: string; connectCard?: Record<string, unknown> };
const loaded = (result: { tools?: { name?: unknown }[] }) => result.tools?.map((t) => t.name) ?? [];
const strongly = (query: string) =>
  new ToolSearchIndex(pool()).strongMatches(query).map((t) => (t as Tool & { name: string }).name);

describe("a search that clearly names one connectable integration shows its card", () => {
  for (const transport of TRANSPORTS) {
    test(`${transport}: the card is shown from the search, and the result says so`, async () => {
      const { requested, request } = cardTool();
      const result = await runtimeWith(transport, { matches: [HUBSPOT], request }).prepareSearch({
        query: "find contacts in HubSpot",
      });
      expect(requested).toEqual([HUBSPOT]);
      const notice = `Not connected yet: HubSpot (capabilityId "mcp:hubspot"). Its Connect card is now shown in this chat. The recommendation was posted for human confirmation.`;
      expect(outputOf(result).notConnected).toBe(notice);
      expect(outputOf(result).connectCard).toEqual({
        shown: true,
        capabilityId: "mcp:hubspot",
        eventId: "event-1",
      });
      if (transport === "generic_dispatch") expect(result.notice).toBeUndefined();
      else expect(result.notice).toEndWith(`\n${notice}`);
      // The card tool stays loaded, for a reconnect or another integration.
      expect(loaded(result)).toContain(CARD);
    });

    test(`${transport}: a strong match on an unrelated installed tool does not stop the card`, async () => {
      for (const [query, integration, matched] of [
        ["Add a task for the launch checklist to our ClickUp list", CLICKUP, TASKS],
        ["read the posts in the Slack channel #launch", SLACK, SLACK_BOT],
      ] as const) {
        expect(strongly(query)).toContain(matched);
        const { requested, request } = cardTool();
        const result = await runtimeWith(transport, {
          matches: [integration],
          request,
        }).prepareSearch({ query });
        expect(requested).toEqual([integration]);
        expect(outputOf(result).connectCard).toMatchObject({
          shown: true,
          capabilityId: integration.capabilityId,
        });
      }
    });

    test(`${transport}: near-miss names: a near spelling, or a name written without its inner capital`, async () => {
      for (const [query, integration] of [
        ["show the vendors from Airtabel", AIRTABLE],
        ["find the contacts in hubsopt", HUBSPOT],
        ["find the contacts in hubspot", HUBSPOT],
      ] as const) {
        const { requested, request } = cardTool();
        const result = await runtimeWith(transport, {
          matches: [integration],
          request,
        }).prepareSearch({ query });
        expect(requested).toEqual([integration]);
        expect(outputOf(result).connectCard).toMatchObject({ shown: true });
      }
    });

    test(`${transport}: a card already in the chat is not shown again, and the result says it is there`, async () => {
      const already =
        "The recommendation is already in this chat for human confirmation. It was not posted again.";
      const { requested, request } = cardTool(() => ({
        eventId: "event-0",
        alreadyShown: true,
        message: already,
      }));
      const result = await runtimeWith(transport, {
        matches: [CLICKUP],
        request,
      }).prepareSearch({ query: "create a ClickUp task" });
      expect(requested).toEqual([CLICKUP]);
      expect(outputOf(result).notConnected).toBe(
        `Not connected yet: ClickUp (capabilityId "mcp:clickup"). ${already}`,
      );
      expect(outputOf(result).connectCard).toEqual({
        shown: true,
        capabilityId: "mcp:clickup",
        eventId: "event-0",
        alreadyShown: true,
      });
    });
  }

  test("an early decision that is never accepted shows no card", async () => {
    const { requested, request } = cardTool();
    const runtime = runtimeWith("generic_dispatch", { matches: [CLICKUP], request });
    const decided = runtime.decideSearch({ query: "create a ClickUp task" });
    await decided;
    expect(requested).toEqual([]);
    // Accepting that same decision shows the card once.
    await runtime.prepareSearch({ query: "create a ClickUp task" }, undefined, decided);
    expect(requested).toEqual([CLICKUP]);
  });
});

describe("searches that keep today's behaviour and show no card", () => {
  const NOT_SHOWN = (integration: ConnectableIntegration) =>
    `Not connected yet: ${integration.name} (capabilityId ${JSON.stringify(integration.capabilityId)}). If the task needs it, call capability_authorization_request with that capabilityId and a short rationale to show the person its Connect card. No card is shown until you do.`;

  test("an integration the strong match belongs to (installed) is never offered", async () => {
    const { requested, request } = cardTool();
    const accounts = new Map<string, ConnectedToolAccount>([
      [
        LINEAR_ISSUES,
        { source: "linear", label: "Linear", connector: "Linear", providerDomain: "linear.app" },
      ],
    ]);
    const result = await runtimeWith("generic_dispatch", {
      matches: [LINEAR],
      request,
      withLinear: true,
      accounts,
    }).prepareSearch({ query: "list my Linear issues" });
    expect(requested).toEqual([]);
    expect(outputOf(result).notConnected).toBeUndefined();
    expect(outputOf(result).connectCard).toBeUndefined();
  });

  test("an ordinary word that is an integration's name names it without a card", async () => {
    for (const [query, integration] of [
      ["run a linear regression on these numbers", LINEAR],
      ["summarise the slack in the schedule", SLACK],
      // Not distinctive either: a one-word name in lower case, or a name split
      // into ordinary words.
      ["list vendors in my airtable base", AIRTABLE],
      ["find contacts in hub spot", HUBSPOT],
    ] as const) {
      const { requested, request } = cardTool();
      const result = await runtimeWith("generic_dispatch", {
        matches: [integration],
        request,
      }).prepareSearch({ query });
      expect(requested).toEqual([]);
      // Still named, as before, with no card and a result that says so.
      expect(outputOf(result).notConnected).toBe(NOT_SHOWN(integration));
      expect(outputOf(result).connectCard).toEqual({ shown: false });
    }
  });

  test("a search naming several integrations shows no card and says none is shown", async () => {
    const { requested, request } = cardTool();
    const result = await runtimeWith("generic_dispatch", {
      matches: [GMAIL, CALENDAR],
      request,
    }).prepareSearch({ query: "compare my Gmail with my Google Calendar invites" });
    expect(requested).toEqual([]);
    expect(outputOf(result).notConnected).toBe(
      'Not connected yet: Gmail (capabilityId "api:gmail"), Google Calendar (capabilityId "api:google-calendar"). If the task needs one, call capability_authorization_request with its capabilityId and a short rationale to show the person its Connect card. No card is shown until you do.',
    );
    expect(outputOf(result).connectCard).toEqual({ shown: false });
  });

  test("when the card tool shows no card, the search names the integration as before", async () => {
    // ready, unavailable or input required: no card in the chat
    const { requested, request } = cardTool(() => null);
    const result = await runtimeWith("openai_native", {
      matches: [CLICKUP],
      request,
    }).prepareSearch({ query: "create a ClickUp task" });
    expect(requested).toEqual([CLICKUP]);
    expect(outputOf(result).notConnected).toBe(NOT_SHOWN(CLICKUP));
    expect(outputOf(result).connectCard).toEqual({ shown: false });
    expect(result.notice).toBe(NOT_SHOWN(CLICKUP));
  });

  test("when the card call fails or times out, the search says nothing about a card", async () => {
    // Not in this attempt's catalog, refused by policy (approval required),
    // or timed out after the card may have been posted.
    for (const message of ["tool not found", "approval required", "The operation timed out."]) {
      const { requested, request } = cardTool(() => new Error(message));
      const result = await runtimeWith("generic_dispatch", {
        matches: [CLICKUP],
        request,
      }).prepareSearch({ query: "create a ClickUp task" });
      expect(requested).toEqual([CLICKUP]);
      expect(outputOf(result).notConnected).toBe(
        'Not connected yet: ClickUp (capabilityId "mcp:clickup"). If the task needs it, call capability_authorization_request with that capabilityId and a short rationale to show the person its Connect card.',
      );
      expect(outputOf(result)).not.toHaveProperty("connectCard");
    }
  });

  test("without both setup tools in the chat, or without a card tool, nothing is shown", async () => {
    const { requested, request } = cardTool();
    const withoutSetup = await runtimeWith("generic_dispatch", {
      matches: [CLICKUP],
      request,
      withSetup: false,
    }).prepareSearch({ query: "create a ClickUp task" });
    expect(requested).toEqual([]);
    expect(outputOf(withoutSetup).notConnected).toBeUndefined();
    const withoutCardTool = await runtimeWith("generic_dispatch", {
      matches: [CLICKUP],
    }).prepareSearch({ query: "create a ClickUp task" });
    expect(outputOf(withoutCardTool).notConnected).toBe(NOT_SHOWN(CLICKUP));
    expect(outputOf(withoutCardTool).connectCard).toEqual({ shown: false });
  });

  test("a cancelled search shows no card and stays cancelled", async () => {
    const controller = new AbortController();
    const { request } = cardTool(() => {
      controller.abort(new Error("cancelled"));
      return new Error("aborted");
    });
    await expect(
      runtimeWith("generic_dispatch", { matches: [CLICKUP], request }).prepareSearch(
        { query: "create a ClickUp task" },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
  });
});

describe("the card request goes through the card tool", () => {
  test("it calls the card tool with a rationale and the discovery marker", async () => {
    const calls: { name: string; args: unknown; meta: unknown; signal?: AbortSignal }[] = [];
    const request = catalogConnectCardRequest({
      callTool: async () => {
        throw new Error("callToolResult is preferred");
      },
      callToolResult: async (name, args, meta, options) => {
        calls.push({ name, args, meta, ...(options?.signal ? { signal: options.signal } : {}) });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                capabilityId: CLICKUP.capabilityId,
                status: "authorization_requested",
                eventId: "event-9",
                cardShown: true,
                message: "The recommendation was posted for human confirmation.",
              }),
            },
          ],
        };
      },
    });
    expect(await request(CLICKUP)).toEqual({
      eventId: "event-9",
      alreadyShown: false,
      message: "The recommendation was posted for human confirmation.",
    });
    expect(calls[0]!.name).toBe(CARD);
    expect(calls[0]!.args).toEqual({
      capabilityId: CLICKUP.capabilityId,
      rationale: "Connect ClickUp so the agent can use it for this task.",
    });
    expect(calls[0]!.meta).toEqual({ [TOOL_DISCOVERY_CARD_META_KEY]: true });
    expect(calls[0]!.signal).toBeDefined();
  });

  test("only an explicit cardShown with its event counts as a card in the chat", () => {
    const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
    expect(
      connectCardReceiptFromResult(
        text({ eventId: "e", cardShown: true, alreadyShown: true, message: "already" }),
      ),
    ).toEqual({ eventId: "e", alreadyShown: true, message: "already" });
    expect(connectCardReceiptFromResult(text({ status: "ready", cardShown: false }))).toBeNull();
    expect(connectCardReceiptFromResult(text({ status: "unavailable" }))).toBeNull();
    expect(connectCardReceiptFromResult(text({ cardShown: true, eventId: null }))).toBeNull();
    expect(
      connectCardReceiptFromResult({ ...text({ cardShown: true, eventId: "e" }), isError: true }),
    ).toBeNull();
    expect(connectCardReceiptFromResult([{ type: "text", text: "not json" }])).toBeNull();
  });
});

describe("a request that opens with an integration's name as its label", () => {
  for (const transport of TRANSPORTS) {
    test(`${transport}: "Airtable list records…" names Airtable clearly and shows its card`, async () => {
      for (const query of [
        "Airtable list records/tables in connected base, find vendors, read-only query records",
        "Airtable: find the vendors table",
        "Show the vendors. Airtable search records",
      ]) {
        const { requested, request } = cardTool();
        const result = await runtimeWith(transport, {
          matches: [AIRTABLE],
          request,
        }).prepareSearch({ query, limit: 5 });
        expect(requested).toEqual([AIRTABLE]);
        expect(outputOf(result).connectCard).toMatchObject({
          shown: true,
          capabilityId: AIRTABLE.capabilityId,
        });
      }
    });
  }

  test("a sentence-opening capital before an ordinary word is still no evidence", async () => {
    for (const query of [
      "Linear regression model on these numbers",
      "Linear fit of the data",
      "Linear: regression model on these numbers",
    ]) {
      const { requested, request } = cardTool();
      const result = await runtimeWith("generic_dispatch", {
        matches: [LINEAR],
        request,
      }).prepareSearch({ query });
      expect(requested).toEqual([]);
      expect(outputOf(result).connectCard).toEqual({ shown: false });
    }
  });

  test("a colon label before an operation word names it", async () => {
    const { requested, request } = cardTool();
    await runtimeWith("generic_dispatch", { matches: [LINEAR], request }).prepareSearch({
      query: "Linear: create an issue for the outage",
    });
    expect(requested).toEqual([LINEAR]);
  });
});

describe("discovery records why no card was newly shown", () => {
  const recording = (
    transport: Transport,
    options: Parameters<typeof runtimeWith>[1],
  ): { runtime: LazyToolRuntime; events: DiscoveryCardEvent[] } => {
    const events: DiscoveryCardEvent[] = [];
    const runtime = runtimeWith(transport, options);
    runtime.setDiscoveryCardSink((event) => {
      events.push(event);
    });
    return { runtime, events };
  };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("a shown card records nothing", async () => {
    const { request } = cardTool();
    const { runtime, events } = recording("generic_dispatch", { matches: [CLICKUP], request });
    await runtime.prepareSearch({ query: "create a ClickUp task" });
    await settled();
    expect(events).toEqual([]);
  });

  test("skipped: a name read as an ordinary word, or several names", async () => {
    const { request } = cardTool();
    const plain = recording("generic_dispatch", { matches: [AIRTABLE], request });
    await plain.runtime.prepareSearch({ query: "list vendors in my airtable base" });
    const several = recording("generic_dispatch", { matches: [GMAIL, CALENDAR], request });
    await several.runtime.prepareSearch({
      query: "compare my Gmail with my Google Calendar invites",
    });
    await settled();
    expect(plain.events).toEqual([
      {
        source: "tool_search",
        outcome: "skipped",
        reason: "not_distinctive",
        query: "list vendors in my airtable base",
        integrations: [{ capabilityId: AIRTABLE.capabilityId, name: "Airtable" }],
      },
    ]);
    expect(several.events).toMatchObject([
      { outcome: "skipped", reason: "several_named", integrations: [{ name: "Gmail" }, {}] },
    ]);
  });

  test("skipped: a plain mention beside a strong installed match", async () => {
    // A capitalised word elsewhere lets the lookup run; the lower-case
    // one-word name is still read as an ordinary word.
    const query = "Add a task for the Launch checklist to our airtable list";
    expect(strongly(query)).toContain(TASKS);
    const { requested, request } = cardTool();
    const { runtime, events } = recording("generic_dispatch", { matches: [AIRTABLE], request });
    await runtime.prepareSearch({ query });
    await settled();
    expect(requested).toEqual([]);
    expect(events).toMatchObject([
      { outcome: "skipped", reason: "not_distinctive", integrations: [{ name: "Airtable" }] },
    ]);
  });

  test("skipped: a catalog lookup that failed or did not finish", async () => {
    const { request } = cardTool();
    const failed = recording("generic_dispatch", {
      matches: [],
      request,
      lookup: async () => {
        throw new Error("catalog unavailable");
      },
    });
    await failed.runtime.prepareSearch({ query: "create a ClickUp task" });
    const slow = recording("generic_dispatch", {
      matches: [],
      request,
      lookup: async () => {
        const error = new Error("The operation timed out.");
        error.name = "TimeoutError";
        throw error;
      },
    });
    await slow.runtime.prepareSearch({ query: "create a ClickUp task" });
    await settled();
    expect(failed.events).toMatchObject([
      { outcome: "skipped", reason: "lookup_failed", integrations: [] },
    ]);
    expect(slow.events).toMatchObject([
      { outcome: "skipped", reason: "lookup_timed_out", integrations: [] },
    ]);
  });

  test("a catalog lookup failure is recorded once per run, until the next run's recorder", async () => {
    const { request } = cardTool();
    const failed = recording("generic_dispatch", {
      matches: [],
      request,
      lookup: async () => {
        throw new Error("catalog unavailable");
      },
    });
    await failed.runtime.prepareSearch({ query: "create a ClickUp task" });
    await failed.runtime.prepareSearch({ query: "find contacts in HubSpot" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed.events).toHaveLength(1);
    const next: DiscoveryCardEvent[] = [];
    const sink = (event: DiscoveryCardEvent) => {
      next.push(event);
    };
    failed.runtime.setDiscoveryCardSink(sink);
    await failed.runtime.prepareSearch({ query: "create a ClickUp task" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(next).toHaveLength(1);
    // Releasing another run's recorder keeps this one; releasing this one stops it.
    failed.runtime.releaseDiscoveryCardSink(() => undefined);
    failed.runtime.releaseDiscoveryCardSink(sink);
    failed.runtime.setDiscoveryCardSink(undefined);
    expect(next).toHaveLength(1);
  });

  test("skipped without a card tool; not shown, already shown and failed card calls", async () => {
    const noTool = recording("generic_dispatch", { matches: [CLICKUP] });
    await noTool.runtime.prepareSearch({ query: "create a ClickUp task" });
    const notShown = recording("generic_dispatch", {
      matches: [CLICKUP],
      request: cardTool(() => null).request,
    });
    await notShown.runtime.prepareSearch({ query: "create a ClickUp task" });
    const already = recording("generic_dispatch", {
      matches: [CLICKUP],
      request: cardTool(() => ({ eventId: "e0", alreadyShown: true, message: "already" })).request,
    });
    await already.runtime.prepareSearch({ query: "create a ClickUp task" });
    const timeout = new Error("The operation timed out.");
    timeout.name = "TimeoutError";
    const timedOut = recording("generic_dispatch", {
      matches: [CLICKUP],
      request: cardTool(() => timeout).request,
    });
    await timedOut.runtime.prepareSearch({ query: "create a ClickUp task" });
    const failed = recording("generic_dispatch", {
      matches: [CLICKUP],
      request: cardTool(() => new Error("approval required")).request,
    });
    await failed.runtime.prepareSearch({ query: "create a ClickUp task" });
    await settled();
    const clickup = [{ capabilityId: CLICKUP.capabilityId, name: "ClickUp" }];
    expect(noTool.events).toMatchObject([
      { outcome: "skipped", reason: "no_card_tool", integrations: clickup },
    ]);
    expect(notShown.events).toEqual([
      {
        source: "tool_search",
        outcome: "not_shown",
        query: "create a ClickUp task",
        integrations: clickup,
      },
    ]);
    expect(already.events).toMatchObject([{ outcome: "already_shown", integrations: clickup }]);
    expect(timedOut.events).toMatchObject([{ outcome: "failed", reason: "timeout" }]);
    expect(failed.events).toMatchObject([{ outcome: "failed", reason: "error" }]);
  });

  test("a failing recorder never fails the search", async () => {
    const runtime = runtimeWith("generic_dispatch", { matches: [AIRTABLE] });
    runtime.setDiscoveryCardSink(() => {
      throw new Error("sink down");
    });
    const result = await runtime.prepareSearch({ query: "list vendors in my airtable base" });
    await settled();
    expect(outputOf(result).connectCard).toEqual({ shown: false });
  });
});

describe("tool_list browsing that names an integration not installed", () => {
  const listing = async (
    runtime: LazyToolRuntime,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const list = runtime.controlTools.find((t) => t.type === "function" && t.name === "tool_list");
    if (!list || list.type !== "function") throw new Error("missing list");
    return JSON.parse(String(await list.invoke({} as never, JSON.stringify(args))));
  };

  test("an empty filtered listing shows the card of the one integration it names", async () => {
    for (const args of [
      { view: "tools", group: "connection/0799034d9553", namePrefix: "clickup" },
      { namePrefix: "clickup_" },
      { view: "groups", namePrefix: "ClickUp" },
    ]) {
      const { requested, request } = cardTool();
      const events: DiscoveryCardEvent[] = [];
      const runtime = runtimeWith("generic_dispatch", { matches: [CLICKUP], request });
      runtime.setDiscoveryCardSink((event) => {
        events.push(event);
      });
      const output = await listing(runtime, args);
      expect(requested).toEqual([CLICKUP]);
      expect(output.total).toBe(0);
      expect(output.notConnected).toBe(
        'Not connected yet: ClickUp (capabilityId "mcp:clickup"). Its Connect card is now shown in this chat. The recommendation was posted for human confirmation.',
      );
      expect(output.connectCard).toEqual({
        shown: true,
        capabilityId: "mcp:clickup",
        eventId: "event-1",
      });
      expect(events).toEqual([]);
    }
  });

  test("a listing the card tool shows no card for says none is shown, and records it", async () => {
    const events: DiscoveryCardEvent[] = [];
    const runtime = runtimeWith("generic_dispatch", {
      matches: [CLICKUP],
      request: cardTool(() => null).request,
    });
    runtime.setDiscoveryCardSink((event) => {
      events.push(event);
    });
    const output = await listing(runtime, { namePrefix: "clickup" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output.connectCard).toEqual({ shown: false });
    expect(output.notConnected).toEndWith("No card is shown until you do.");
    expect(events).toMatchObject([{ source: "tool_list", outcome: "not_shown", query: "clickup" }]);
  });

  test("a listing filter naming several integrations names them without a card", async () => {
    const { requested, request } = cardTool();
    const runtime = runtimeWith("generic_dispatch", { matches: [GMAIL, CALENDAR], request });
    const output = await listing(runtime, { namePrefix: "gmail google calendar" });
    expect(requested).toEqual([]);
    expect(output.notConnected).toStartWith(
      'Not connected yet: Gmail (capabilityId "api:gmail"), Google Calendar',
    );
    expect(output.connectCard).toEqual({ shown: false });
  });

  test("generic browsing, a listing with tools, or a later page looks nothing up", async () => {
    let lookups = 0;
    const { requested, request } = cardTool();
    const runtime = runtimeWith("generic_dispatch", {
      matches: [],
      request,
      lookup: async () => {
        lookups += 1;
        return [CLICKUP];
      },
    });
    for (const args of [
      { view: "groups" },
      {},
      { namePrefix: "mcp_" },
      { group: "connection/0799034d9553" },
      { namePrefix: "mcp_0799034d9553__" },
      { namePrefix: "opengeni__" },
      { namePrefix: "clickup", cursor: "x" },
    ]) {
      const output = await listing(runtime, args);
      expect(output).not.toHaveProperty("notConnected");
      expect(output).not.toHaveProperty("connectCard");
    }
    expect(lookups).toBe(0);
    expect(requested).toEqual([]);
  });

  test("an installed integration's prefix is never offered", async () => {
    const { requested, request } = cardTool();
    const accounts = new Map<string, ConnectedToolAccount>([
      [
        LINEAR_ISSUES,
        { source: "linear", label: "Linear", connector: "Linear", providerDomain: "linear.app" },
      ],
    ]);
    const runtime = runtimeWith("generic_dispatch", {
      matches: [LINEAR],
      request,
      withLinear: true,
      accounts,
    });
    const output = await listing(runtime, { namePrefix: "linear_create" });
    expect(requested).toEqual([]);
    expect(output).not.toHaveProperty("connectCard");
  });
});

describe("one connection's tools are browsable from one tool's digest", () => {
  test("a namePrefix of one aliased tool's digest lists every tool of its connection", async () => {
    const registry = "slack-workspace";
    const listChannels = prefixedMcpToolName(registry, "slack_list_channels");
    const sendMessage = prefixedMcpToolName(registry, "slack_send_message");
    const other = prefixedMcpToolName("other-server", "other_tool");
    expect(listChannels.slice(0, 28)).not.toBe(sendMessage.slice(0, 28));
    const mapping = new Map([
      [listChannels, registry],
      [sendMessage, registry],
      [other, "other-server"],
    ]);
    const runtime = new LazyToolRuntime(
      "generic_dispatch",
      new Set(mapping.values()),
      undefined,
      new Set(mapping.values()),
      new Set(),
      () => mapping,
    );
    runtime.refresh([
      candidate(listChannels, "List Slack channels"),
      candidate(sendMessage, "Send a Slack message"),
      candidate(other, "Other tool"),
    ]);
    const list = runtime.controlTools.find((t) => t.type === "function" && t.name === "tool_list");
    if (!list || list.type !== "function") throw new Error("missing list");
    const invoke = async (args: unknown) =>
      JSON.parse(String(await list.invoke({} as never, JSON.stringify(args))));
    for (const namePrefix of [listChannels.slice(0, 28), listChannels.slice(0, 30)]) {
      const output = await invoke({ namePrefix });
      expect(new Set(output.tools.map((t: { name: string }) => t.name))).toEqual(
        new Set([listChannels, sendMessage]),
      );
      expect(output.message).toBe(
        "namePrefix is one tool's own digest, so this lists every tool of that tool's connection.",
      );
    }
    // Within a group, only that group's tools of the connection.
    const grouped = await invoke({ namePrefix: listChannels.slice(0, 28), group: "absent" });
    expect(grouped.tools).toEqual([]);
    const inGroup = await invoke({
      namePrefix: listChannels.slice(0, 28),
      group: (await invoke({ view: "groups" })).groups.find(
        (entry: { group: string; count: number }) => entry.count === 2,
      ).group,
    });
    expect(inGroup.tools).toHaveLength(2);
    // The full name still lists that one tool.
    const exact = await invoke({ namePrefix: listChannels });
    expect(exact.tools.map((t: { name: string }) => t.name)).toEqual([listChannels]);
    expect(exact).not.toHaveProperty("message");
  });
});
