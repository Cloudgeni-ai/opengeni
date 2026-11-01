// Slack agents are chosen deterministically, before any model runs. These cases
// pin the rules people rely on: how a name is read, when a thread switches
// agent, and that an installation with no agents decides exactly as before.
import { describe, expect, test } from "bun:test";
import {
  matchSlackAgentAddress,
  withinOneEdit,
  type SlackRoutingAgent,
} from "../src/integrations/slack-agent-address";
import {
  renderSlackAgentStartLine,
  slackAgentHintLine,
  slackAgentSessionInstructions,
  slackNoAccessToAgentText,
  slackUnknownAgentText,
} from "../src/integrations/slack-agents";
import {
  resolveSlackWorkspaceRoute,
  slackAgentAddressForEntry,
  slackRoutedRequestText,
  type SlackRouteInputs,
} from "../src/integrations/slack-routing";
import { slackAgentIntroText } from "../src/routes/slack-agents";
import { slackAgentNameKey } from "@opengeni/contracts";

const ACCOUNT = "account-1";
const HOME = { accountId: ACCOUNT, workspaceId: "workspace-home" };
const ACME = { accountId: ACCOUNT, workspaceId: "workspace-acme", label: "Acme", personal: false };
const LABS = { accountId: ACCOUNT, workspaceId: "workspace-labs", label: "Labs", personal: false };
const SECRET = {
  accountId: ACCOUNT,
  workspaceId: "workspace-secret",
  label: "Secret",
  personal: false,
};

function agent(id: string, name: string, workspace: { workspaceId: string; label: string }) {
  return {
    id,
    name,
    nameKey: slackAgentNameKey(name),
    targetAccountId: ACCOUNT,
    targetWorkspaceId: workspace.workspaceId,
    targetWorkspaceLabel: workspace.label,
  } satisfies SlackRoutingAgent;
}

const ANALYTICS = agent("agent-analytics", "Analytics", ACME);
const DATA_TEAM = agent("agent-data-team", "Data Team", LABS);
const DATA = agent("agent-data", "Data", LABS);
const VAULT = agent("agent-vault", "Vault", SECRET);
const AGENTS = [ANALYTICS, DATA_TEAM, DATA, VAULT];

function inputs(overrides: Partial<SlackRouteInputs> = {}): SlackRouteInputs {
  return {
    home: HOME,
    entry: {
      triggerKind: "app_mention",
      slackChannelId: "C-DESIGN",
      slackUserId: "U-SAM",
      text: "<@U0BOT> ship it",
    },
    threadTenancy: null,
    channelRoute: null,
    dmRoute: null,
    personalWorkspaceId: null,
    candidates: [ACME, LABS],
    botUserId: "U0BOT",
    routingEnabled: true,
    askEnabled: true,
    agents: AGENTS,
    ...overrides,
  };
}

function mention(text: string, overrides: Partial<SlackRouteInputs["entry"]> = {}) {
  return {
    triggerKind: "app_mention" as const,
    slackChannelId: "C-DESIGN",
    slackUserId: "U-SAM",
    text: `<@U0BOT> ${text}`,
    ...overrides,
  };
}

describe("reading an agent's name", () => {
  const options = { allowBare: true, allowPlus: true };

  test("ignores case, spaces and hyphens, and prefers the longest name", () => {
    for (const typed of ["Data Team how many?", "data-team how many?", "DATATEAM how many?"]) {
      const found = matchSlackAgentAddress(typed, AGENTS, options);
      expect(found).toMatchObject({ kind: "agent", agent: { id: DATA_TEAM.id } });
      expect(found?.kind === "agent" && found.remainder).toBe("how many?");
    }
    expect(matchSlackAgentAddress("Data how many?", AGENTS, options)).toMatchObject({
      kind: "agent",
      agent: { id: DATA.id },
    });
  });

  test("+name works, and tolerates one typo only when one agent is that close", () => {
    expect(matchSlackAgentAddress("+analytics revenue?", AGENTS, options)).toMatchObject({
      kind: "agent",
      agent: { id: ANALYTICS.id },
      via: "plus",
    });
    expect(matchSlackAgentAddress("+analytcs revenue?", AGENTS, options)).toMatchObject({
      kind: "agent",
      agent: { id: ANALYTICS.id },
    });
    // A bare typo is ordinary text.
    expect(matchSlackAgentAddress("analytcs revenue?", AGENTS, options)).toBeNull();
    expect(matchSlackAgentAddress("+nobody hi", AGENTS, options)).toEqual({
      kind: "unknown",
      requested: "nobody",
    });
  });

  test("a typo close to two agents is not guessed", () => {
    const pair = [agent("a", "Dana", ACME), agent("b", "Dina", LABS)];
    expect(matchSlackAgentAddress("+dena hi", pair, options)).toEqual({
      kind: "unknown",
      requested: "dena",
    });
  });

  test("a name must end at a word boundary", () => {
    expect(matchSlackAgentAddress("Analyticsy is down", AGENTS, options)).toBeNull();
    expect(matchSlackAgentAddress("Analytics, is it down?", AGENTS, options)).toMatchObject({
      kind: "agent",
      remainder: "is it down?",
    });
  });

  test("+1, +100 and a lone + are Slack idioms, not calls", () => {
    for (const typed of ["+1 good idea, do it", "+100", "+ also check X", "+"]) {
      expect(matchSlackAgentAddress(typed, AGENTS, options)).toBeNull();
    }
    // A name starting with a digit still matches when typed exactly.
    const ops = agent("agent-42", "42 Ops", ACME);
    expect(matchSlackAgentAddress("+42-ops restart it", [ops], options)).toMatchObject({
      kind: "agent",
      agent: { id: ops.id },
      remainder: "restart it",
    });
    expect(matchSlackAgentAddress("+42-op restart it", [ops], options)).toBeNull();
  });

  test("a typo match keeps the rest of the request", () => {
    expect(matchSlackAgentAddress("+analytic is down", AGENTS, options)).toMatchObject({
      kind: "agent",
      agent: { id: ANALYTICS.id },
      remainder: "is down",
    });
  });

  test("no agents never matches", () => {
    expect(matchSlackAgentAddress("+analytics hi", [], options)).toBeNull();
  });

  test("one edit", () => {
    expect(withinOneEdit("analytics", "analytcs")).toBe(true);
    expect(withinOneEdit("analytics", "analytixs")).toBe(true);
    expect(withinOneEdit("analytics", "anlytcs")).toBe(false);
  });
});

describe("where a name can be used", () => {
  test("after a mention, a bare name and +name both work", () => {
    expect(slackAgentAddressForEntry(mention("Analytics hi"), AGENTS, "U0BOT")).toMatchObject({
      agent: { id: ANALYTICS.id },
    });
    expect(slackAgentAddressForEntry(mention("+analytics hi"), AGENTS, "U0BOT")).toMatchObject({
      agent: { id: ANALYTICS.id },
    });
  });

  test("without a mention, only +name, and only in a DM", () => {
    const dm = { triggerKind: "dm" as const, slackChannelId: "D123", text: "+analytics hi" };
    expect(slackAgentAddressForEntry(dm, AGENTS, "U0BOT")).toMatchObject({
      agent: { id: ANALYTICS.id },
    });
    expect(slackAgentAddressForEntry({ ...dm, text: "Analytics hi" }, AGENTS, "U0BOT")).toBeNull();
    expect(
      slackAgentAddressForEntry(
        { triggerKind: "thread_reply", slackChannelId: "C-DESIGN", text: "+analytics hi" },
        AGENTS,
        "U0BOT",
      ),
    ).toBeNull();
  });

  test("a bare name counts only right after the mention", () => {
    const prose = {
      triggerKind: "app_mention" as const,
      slackChannelId: "C-DESIGN",
      text: "Analytics said <@U0BOT> please summarize",
    };
    expect(slackAgentAddressForEntry(prose, AGENTS, "U0BOT")).toBeNull();
    expect(
      slackAgentAddressForEntry({ ...prose, text: "+analytics <@U0BOT> hi" }, AGENTS, "U0BOT"),
    ).toMatchObject({ agent: { id: ANALYTICS.id } });
  });

  test("someone else's message never names an agent", () => {
    expect(
      slackAgentAddressForEntry(
        { triggerKind: "message_shortcut", slackChannelId: "C-DESIGN", text: "+analytics hi" },
        AGENTS,
        "U0BOT",
      ),
    ).toBeNull();
  });
});

describe("routing with Slack agents", () => {
  test("an unknown +name in a thread just continues the thread", () => {
    const resolution = resolveSlackWorkspaceRoute(
      inputs({
        entry: mention("+nobody what about this?"),
        threadTenancy: { accountId: ACCOUNT, workspaceId: LABS.workspaceId },
      }),
    );
    expect(resolution).toMatchObject({
      kind: "resolved",
      workspaceId: LABS.workspaceId,
      source: "thread",
    });
  });

  test("a channel's agent counts only while the channel still points at its workspace", () => {
    const route = (targetWorkspaceId: string) => ({
      accountId: ACCOUNT,
      workspaceId: HOME.workspaceId,
      connectionId: "connection-1",
      slackChannelId: "C-DESIGN",
      targetAccountId: ACCOUNT,
      targetWorkspaceId,
      slackAgentId: ANALYTICS.id,
    });
    expect(
      resolveSlackWorkspaceRoute(
        inputs({ channelRoute: route(ACME.workspaceId) as SlackRouteInputs["channelRoute"] }),
      ),
    ).toMatchObject({ source: "channel", slackAgentId: ANALYTICS.id });
    const moved = resolveSlackWorkspaceRoute(
      inputs({ channelRoute: route(LABS.workspaceId) as SlackRouteInputs["channelRoute"] }),
    );
    expect(moved).toMatchObject({ source: "channel", workspaceId: LABS.workspaceId });
    expect(moved).not.toHaveProperty("slackAgentId");
  });

  test("a named agent answers in its own workspace, and the name is stripped", () => {
    const entry = mention("+analytics revenue last week?");
    const resolution = resolveSlackWorkspaceRoute(inputs({ entry }));
    expect(resolution).toMatchObject({
      kind: "resolved",
      workspaceId: ACME.workspaceId,
      source: "agent_name",
      slackAgentId: ANALYTICS.id,
    });
    const address = slackAgentAddressForEntry(entry, AGENTS, "U0BOT");
    expect(slackRoutedRequestText(entry.text, resolution, "U0BOT", address)).toBe(
      "<@U0BOT> revenue last week?",
    );
  });

  test("a name with nothing after it keeps the message as typed", () => {
    const entry = mention("Analytics");
    const resolution = resolveSlackWorkspaceRoute(inputs({ entry }));
    const address = slackAgentAddressForEntry(entry, AGENTS, "U0BOT");
    expect(slackRoutedRequestText(entry.text, resolution, "U0BOT", address)).toBe(entry.text);
  });

  test("an unknown +name is refused with the agents the person can use", () => {
    const resolution = resolveSlackWorkspaceRoute(inputs({ entry: mention("+nobody hi") }));
    expect(resolution).toMatchObject({ kind: "denied", reason: "unknown_agent" });
    if (resolution.kind !== "denied") throw new Error("expected a refusal");
    expect(resolution.usableAgents?.map((usable) => usable.id)).toEqual([
      ANALYTICS.id,
      DATA_TEAM.id,
      DATA.id,
    ]);
  });

  test("an agent in a workspace the person cannot use is refused by name", () => {
    const resolution = resolveSlackWorkspaceRoute(inputs({ entry: mention("+vault hi") }));
    expect(resolution).toMatchObject({
      kind: "denied",
      reason: "no_access_to_agent",
      agent: { id: VAULT.id },
    });
  });

  test("the in X: prefix still wins over a name", () => {
    expect(
      resolveSlackWorkspaceRoute(inputs({ entry: mention("in Labs: Analytics numbers") })),
    ).toMatchObject({ kind: "resolved", workspaceId: LABS.workspaceId, source: "prefix" });
  });

  test("a channel set to an agent sends plain mentions to it", () => {
    const channelRoute = {
      id: "route-1",
      accountId: ACCOUNT,
      workspaceId: HOME.workspaceId,
      connectionId: "connection-1",
      slackTeamId: "T1",
      slackChannelId: "C-DESIGN",
      targetAccountId: ACCOUNT,
      targetWorkspaceId: ACME.workspaceId,
      decidedBySubjectId: "user:sam",
      decidedBySlackUserId: "admin",
      source: "admin" as const,
      slackAgentId: ANALYTICS.id,
      version: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    expect(resolveSlackWorkspaceRoute(inputs({ channelRoute }))).toMatchObject({
      kind: "resolved",
      workspaceId: ACME.workspaceId,
      source: "channel",
      slackAgentId: ANALYTICS.id,
    });
    // A name still overrides the channel setting.
    expect(
      resolveSlackWorkspaceRoute(inputs({ channelRoute, entry: mention("+data-team hi") })),
    ).toMatchObject({ slackAgentId: DATA_TEAM.id, source: "agent_name" });
  });

  test("a plain mention in a thread continues it; a different name switches it", () => {
    const threadTenancy = { accountId: ACCOUNT, workspaceId: ACME.workspaceId };
    expect(
      resolveSlackWorkspaceRoute(
        inputs({ threadTenancy, threadAgentId: ANALYTICS.id, entry: mention("and now?") }),
      ),
    ).toMatchObject({ kind: "resolved", source: "thread", workspaceId: ACME.workspaceId });
    expect(
      resolveSlackWorkspaceRoute(
        inputs({ threadTenancy, threadAgentId: ANALYTICS.id, entry: mention("+analytics more") }),
      ),
    ).toMatchObject({ kind: "resolved", source: "thread" });
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          threadTenancy,
          threadAgentId: ANALYTICS.id,
          entry: mention("+data-team take it"),
        }),
      ),
    ).toMatchObject({
      kind: "resolved",
      source: "agent_name",
      slackAgentId: DATA_TEAM.id,
      workspaceId: LABS.workspaceId,
      switchThread: true,
    });
  });

  test("a handed-off request goes to exactly that agent", () => {
    expect(resolveSlackWorkspaceRoute(inputs({ handoffAgentId: DATA_TEAM.id }))).toMatchObject({
      kind: "resolved",
      source: "handoff",
      slackAgentId: DATA_TEAM.id,
    });
  });

  test("the picker offers agents in a channel but not in a DM", () => {
    const channel = resolveSlackWorkspaceRoute(inputs());
    expect(channel).toMatchObject({ kind: "ask" });
    expect(channel.kind === "ask" && channel.agents?.map((usable) => usable.id)).toEqual([
      ANALYTICS.id,
      DATA_TEAM.id,
      DATA.id,
    ]);
    const dm = resolveSlackWorkspaceRoute(
      inputs({
        entry: { triggerKind: "dm", slackChannelId: "D1", slackUserId: "U-SAM", text: "hi" },
      }),
    );
    expect(dm).toEqual({ kind: "ask", candidates: [ACME, LABS] });
  });

  test("with no agents every decision is what it was before", () => {
    const cases: Partial<SlackRouteInputs>[] = [
      {},
      { entry: mention("+analytics hi") },
      { entry: mention("Analytics hi") },
      { candidates: [ACME] },
      { candidates: [] },
      { threadTenancy: { accountId: ACCOUNT, workspaceId: LABS.workspaceId } },
      {
        entry: { triggerKind: "dm", slackChannelId: "D1", slackUserId: "U-SAM", text: "+x" },
      },
      { routingEnabled: false },
    ];
    for (const overrides of cases) {
      const without = { ...inputs(overrides) };
      delete without.agents;
      expect(resolveSlackWorkspaceRoute(inputs({ ...overrides, agents: [] }))).toEqual(
        resolveSlackWorkspaceRoute(without),
      );
    }
  });

  test("with routing off, agents are ignored", () => {
    expect(
      resolveSlackWorkspaceRoute(inputs({ routingEnabled: false, entry: mention("+analytics x") })),
    ).toMatchObject({ kind: "resolved", source: "installation", workspaceId: HOME.workspaceId });
  });
});

describe("what people read", () => {
  test("refusals name the agent and its workspace, never a bot", () => {
    expect(slackNoAccessToAgentText(VAULT, "https://example.test/link")).toBe(
      "Vault works in the Secret workspace, which you don't have access to. Request access: https://example.test/link. No chat was started.",
    );
    expect(slackUnknownAgentText("nobody", [ANALYTICS, DATA_TEAM])).toBe(
      "No agent called nobody. Available: +analytics, +data-team. No chat was started.",
    );
    expect(slackUnknownAgentText("", [])).toBe("No agent. No chat was started.");
  });

  test("the first message says who is on it, who passed it on, and the hint once", () => {
    expect(
      renderSlackAgentStartLine({
        sessionUrl: "https://app.test/s/1",
        agentName: "Data Team",
        handedOffByName: "Analytics",
        hint: slackAgentHintLine({ name: "Data Team" }, "U0BOT"),
      }),
    ).toBe(
      "<https://app.test/s/1|Data Team is on it> · Passed on by *Analytics*\n_Data Team · next time: <@U0BOT> +data-team_",
    );
  });

  test("the intro is posted as the agent", () => {
    expect(
      slackAgentIntroText(
        { name: "Analytics", description: "Answers revenue questions." },
        "U0BOT",
      ),
    ).toBe("Hi, I'm *Analytics*. Answers revenue questions.\nAsk me with <@U0BOT> +analytics");
  });

  test("every chat learns its identity, Memory and the other agents", () => {
    const record = (id: string, name: string, description: string, workspaceId: string) => ({
      id,
      accountId: ACCOUNT,
      workspaceId: HOME.workspaceId,
      connectionId: "connection-1",
      slackTeamId: "T1",
      targetAccountId: ACCOUNT,
      targetWorkspaceId: workspaceId,
      name,
      nameKey: slackAgentNameKey(name),
      description,
      avatar: { kind: "emoji" as const, emoji: "📊" },
      instructions: "",
      knowledgeCollectionId: id === "a" ? "11111111-1111-4111-8111-111111111111" : null,
      open: false,
      createdBySubjectId: "user:admin",
      version: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const analytics = record("a", "Analytics", "Answers revenue questions.", ACME.workspaceId);
    const ops = record("b", "Ops", "Handles incidents.", LABS.workspaceId);
    const loaded = {
      records: [analytics, ops],
      routing: [],
      labels: new Map([
        [ACME.workspaceId, "Acme"],
        [LABS.workspaceId, "Labs"],
      ]),
    };
    const text = slackAgentSessionInstructions({ loaded, agent: analytics, handedOffBy: ops });
    expect(text).toContain("You are Analytics");
    expect(text).toContain("groupId 11111111-1111-4111-8111-111111111111");
    expect(text).toContain("slack_agent_chats");
    expect(text).toContain("- Ops (+ops): Handles incidents. Works in Labs.");
    expect(text).toContain("Do not hand it back to Ops.");
    expect(text).not.toContain("- Analytics");
    const plain = slackAgentSessionInstructions({ loaded, agent: null, handedOffBy: null });
    expect(plain).toContain("- Analytics (+analytics)");
    expect(plain).not.toContain("You are");
  });
});
