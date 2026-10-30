// Open Slack agents: who may ask one, how a name reaches it, and the grant an
// open chat runs with. The end-to-end behaviour is in the Slack integration
// tests ("Open Slack agents").
import { describe, expect, test } from "bun:test";
import { personalConnectionDelegationSourceForGrant } from "@opengeni/core";
import { slackAgentNameKey, slackAgentOpenDisclosure } from "@opengeni/contracts";
import type { SlackRoutingAgent } from "../src/integrations/slack-agent-address";
import {
  OPEN_SLACK_AGENT_GRANT_PERMISSIONS,
  openSlackAgentGrant,
  openSlackAgentIdFromSubject,
  openSlackAgentRefusal,
  openSlackAgentSessionOptions,
  openSlackAgentSubjectId,
  renderSlackOpenAgentStartLine,
  type OpenSlackAgentAskerFacts,
} from "../src/integrations/slack-open-agents";
import {
  resolveSlackWorkspaceRoute,
  type SlackRouteInputs,
} from "../src/integrations/slack-routing";

const TEAM = "T-HOME";

function facts(
  asker: Partial<OpenSlackAgentAskerFacts["asker"]> = {},
  conversation: Partial<OpenSlackAgentAskerFacts["conversation"]> = {},
): OpenSlackAgentAskerFacts {
  return {
    conversation: {
      isShared: false,
      isExternallyShared: false,
      isOrgShared: false,
      isPendingExternallyShared: false,
      isMpim: false,
      ...conversation,
    },
    asker: {
      teamId: TEAM,
      isGuest: false,
      isExternal: false,
      isBot: false,
      deleted: false,
      isStranger: false,
      ...asker,
    },
  };
}

describe("who may ask an open agent", () => {
  test("a full member of the installation's own Slack team, in its own conversation", () => {
    expect(openSlackAgentRefusal(facts(), TEAM)).toBeNull();
  });

  test("guests, external people, bots and unknowns are refused, failing closed", () => {
    for (const asker of [
      { isGuest: true },
      { isGuest: null },
      { isExternal: true },
      { isExternal: null },
      { teamId: "T-OTHER" },
      { teamId: null },
      { isBot: true },
      { deleted: true },
      { isStranger: true },
    ]) {
      expect(openSlackAgentRefusal(facts(asker), TEAM)).toBe("not_eligible");
    }
  });

  test("conversations other teams can see are refused", () => {
    for (const conversation of [
      { isShared: true },
      { isExternallyShared: true },
      { isOrgShared: true },
      { isPendingExternallyShared: true },
      { isMpim: true },
    ]) {
      expect(openSlackAgentRefusal(facts({}, conversation), TEAM)).toBe("shared_conversation");
    }
  });
});

describe("an open chat's grant", () => {
  const agent = {
    id: "0b6f8a8e-3f43-4d8e-8f4d-5d1a2c7d9e10",
    name: "Front Desk",
    targetAccountId: "account-1",
    targetWorkspaceId: "workspace-1",
  };
  const grant = openSlackAgentGrant(agent, {
    slackTeamId: TEAM,
    slackUserId: "U-ASKER",
    slackChannelId: "C-1",
    providerEventId: "Ev1",
  });

  test("is the agent's service principal, recording who asked", () => {
    expect(grant).toMatchObject({
      subjectId: `slack-agent:${agent.id}`,
      principalKind: "service",
      permissionMode: "explicit",
      serviceInitiator: { kind: "service", subjectId: `slack-agent:${agent.id}` },
      serviceInitiatorContext: { slackUserId: "U-ASKER", slackTeamId: TEAM },
    });
    expect(openSlackAgentIdFromSubject(grant.subjectId)).toBe(agent.id);
    expect(openSlackAgentIdFromSubject("user:someone")).toBeNull();
    expect(openSlackAgentSubjectId(agent.id)).toBe(grant.subjectId);
  });

  test("can never use a personal connection", () => {
    expect(personalConnectionDelegationSourceForGrant(grant)).toEqual({ kind: "none" });
  });

  test("runs with no sandbox, nobody to wait on, no other chats, Memory or vault", () => {
    expect(openSlackAgentSessionOptions({} as never)).toMatchObject({
      unattended: true,
      sandboxBackend: "none",
      agentAccess: "session",
      memoryScope: "off",
      rigId: null,
      vaultPolicy: { mode: "selected", vaultIds: [] },
    });
  });

  test("holds no secret, write, schedule or admin permission", () => {
    for (const permission of OPEN_SLACK_AGENT_GRANT_PERMISSIONS) {
      expect(permission).not.toMatch(/^(secrets|schedules|knowledge|members)/u);
      expect(permission).not.toMatch(/:(write|manage|admin|publish)$/u);
    }
  });
});

describe("copy", () => {
  test("the switch's disclosure", () => {
    expect(slackAgentOpenDisclosure("Front Desk", "Support")).toBe(
      "Anyone in Slack can ask Front Desk. Its answers can use anything it can read in the Support workspace (Knowledge, files, chats, shared connections). What people tell it is visible to that workspace's members.",
    );
    expect(slackAgentOpenDisclosure("Front Desk", " ")).toContain("can read in its workspace (");
  });

  test("the first message has no link, and the notice only once", () => {
    expect(
      renderSlackOpenAgentStartLine({
        agentName: "Front Desk",
        workspaceName: "Support",
        handedOffByName: null,
        notice: true,
      }),
    ).toBe(
      "*Front Desk* is on it\n_What you tell Front Desk is visible to members of the *Support* workspace._",
    );
    expect(
      renderSlackOpenAgentStartLine({
        agentName: "Front Desk",
        workspaceName: "Support",
        handedOffByName: null,
        notice: false,
      }),
    ).toBe("*Front Desk* is on it");
  });
});

describe("routing to an open agent", () => {
  const ACCOUNT = "account-1";
  const SUPPORT = { accountId: ACCOUNT, workspaceId: "workspace-support", label: "Support" };
  const ACME = {
    accountId: ACCOUNT,
    workspaceId: "workspace-acme",
    label: "Acme",
    personal: false,
  };
  const LABS = {
    accountId: ACCOUNT,
    workspaceId: "workspace-labs",
    label: "Labs",
    personal: false,
  };
  const routingAgent = (
    id: string,
    name: string,
    workspace: { workspaceId: string; label: string },
    open?: boolean,
  ) =>
    ({
      id,
      name,
      nameKey: slackAgentNameKey(name),
      targetAccountId: ACCOUNT,
      targetWorkspaceId: workspace.workspaceId,
      targetWorkspaceLabel: workspace.label,
      ...(open ? { open: true } : {}),
    }) satisfies SlackRoutingAgent;
  const FRONT_DESK = routingAgent("agent-front-desk", "Front Desk", SUPPORT, true);
  const VAULT = routingAgent("agent-vault", "Vault", SUPPORT);
  const ANALYTICS = routingAgent("agent-analytics", "Analytics", ACME);
  const entry = (text: string) => ({
    triggerKind: "app_mention" as const,
    slackChannelId: "C-1",
    slackUserId: "U-1",
    text,
  });
  const inputs = (overrides: Partial<SlackRouteInputs> = {}): SlackRouteInputs => ({
    home: { accountId: ACCOUNT, workspaceId: "workspace-home" },
    entry: entry("<@U0BOT> +front-desk hello"),
    threadTenancy: null,
    channelRoute: null,
    dmRoute: null,
    personalWorkspaceId: null,
    candidates: [],
    botUserId: "U0BOT",
    routingEnabled: true,
    askEnabled: true,
    agents: [FRONT_DESK, VAULT, ANALYTICS],
    ...overrides,
  });

  test("someone with no workspaces can name an open agent, and only an open one", () => {
    expect(resolveSlackWorkspaceRoute(inputs())).toMatchObject({
      kind: "resolved",
      source: "agent_name",
      slackAgentId: FRONT_DESK.id,
      workspaceId: SUPPORT.workspaceId,
    });
    expect(
      resolveSlackWorkspaceRoute(inputs({ entry: entry("<@U0BOT> +vault hello") })),
    ).toMatchObject({ kind: "denied", reason: "no_access_to_agent" });
  });

  test("the picker still offers only what membership allows", () => {
    const result = resolveSlackWorkspaceRoute(
      inputs({ entry: entry("<@U0BOT> hello"), candidates: [ACME, LABS] }),
    );
    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") return;
    expect((result.agents ?? []).map((agent) => agent.id)).toEqual([ANALYTICS.id]);
  });
});
