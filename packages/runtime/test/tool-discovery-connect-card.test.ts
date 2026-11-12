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
} from "../src/lazy-tool-transport";

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
    lookupOf(options.matches),
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
  }

  test("near-miss names: a near spelling, or a name written without its inner capital", async () => {
    for (const [query, integration] of [
      ["show the vendors from Airtabel", AIRTABLE],
      ["find the contacts in hubsopt", HUBSPOT],
      ["find the contacts in hubspot", HUBSPOT],
    ] as const) {
      const { requested, request } = cardTool();
      const result = await runtimeWith("generic_dispatch", {
        matches: [integration],
        request,
      }).prepareSearch({ query });
      expect(requested).toEqual([integration]);
      expect(outputOf(result).connectCard).toMatchObject({ shown: true });
    }
  });

  test("a card already in the chat is not shown again, and the result says it is there", async () => {
    const { requested, request } = cardTool(() => ({ eventId: "event-0", alreadyShown: true }));
    const result = await runtimeWith("generic_dispatch", {
      matches: [CLICKUP],
      request,
    }).prepareSearch({ query: "create a ClickUp task" });
    expect(requested).toEqual([CLICKUP]);
    expect(outputOf(result).notConnected).toBe(
      'Not connected yet: ClickUp (capabilityId "mcp:clickup"). Its Connect card is already in this chat; nothing is connected yet.',
    );
    expect(outputOf(result).connectCard).toEqual({
      shown: true,
      capabilityId: "mcp:clickup",
      eventId: "event-0",
      alreadyShown: true,
    });
  });

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

  test("when the card tool shows nothing or fails, the search names the integration as before", async () => {
    for (const answer of [
      // ready, unavailable or input required: no card in the chat
      () => null,
      // not in this attempt's catalog, refused by policy, or failed
      () => new Error("tool not found"),
    ]) {
      const { requested, request } = cardTool(answer);
      const result = await runtimeWith("openai_native", {
        matches: [CLICKUP],
        request,
      }).prepareSearch({ query: "create a ClickUp task" });
      expect(requested).toEqual([CLICKUP]);
      expect(outputOf(result).notConnected).toBe(NOT_SHOWN(CLICKUP));
      expect(outputOf(result).connectCard).toEqual({ shown: false });
      expect(result.notice).toBe(NOT_SHOWN(CLICKUP));
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
    ).toEqual({ eventId: "e", alreadyShown: true });
    expect(connectCardReceiptFromResult(text({ status: "ready", cardShown: false }))).toBeNull();
    expect(connectCardReceiptFromResult(text({ status: "unavailable" }))).toBeNull();
    expect(connectCardReceiptFromResult(text({ cardShown: true, eventId: null }))).toBeNull();
    expect(
      connectCardReceiptFromResult({ ...text({ cardShown: true, eventId: "e" }), isError: true }),
    ).toBeNull();
    expect(connectCardReceiptFromResult([{ type: "text", text: "not json" }])).toBeNull();
  });
});
