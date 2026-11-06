import { describe, expect, test } from "bun:test";
import type { App } from "@microsoft/teams.apps";
import type { ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import {
  TEAMS_SETUP_CONFIRMED_TEXT,
  TEAMS_TENANT_UNAVAILABLE_TEXT,
  confirmTeamsSetup,
  replyToUnconnectedTeamsTenant,
  sendTeamsOnboarding,
  teamsSelfServeSetupAvailable,
} from "../src/integrations/teams-bot";
import {
  TeamsOnboardingLimiter,
  createTeamsOnboardingBudgets,
  type TeamsOnboardingBudgets,
} from "../src/integrations/teams-onboarding-limit";
import {
  mintTeamsProof,
  normalizeTeamsMessage,
  teamsPersonalInstall,
  verifyTeamsProof,
} from "../src/integrations/teams-protocol";

const tenantId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000002";
const workspaceId = "10000000-0000-4000-8000-000000000003";
const generation = "10000000-0000-4000-8000-000000000004";
const message = normalizeTeamsMessage({
  type: "message",
  id: "message-1",
  timestamp: "2026-10-29T10:00:00Z",
  channelId: "msteams",
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  from: { id: "29:human", aadObjectId: actorId },
  recipient: { id: "28:bot" },
  conversation: { id: "19:personal", conversationType: "personal", tenantId },
  channelData: { tenant: { id: tenantId } },
  text: "Hello",
})!;

/** Fresh budgets whose connect budget is `connect`. */
function budgetsOf(connect = new TeamsOnboardingLimiter()): TeamsOnboardingBudgets {
  return { ...createTeamsOnboardingBudgets(), connect };
}

function transport(receipt: unknown = { id: "sent-1" }) {
  const calls: Array<{ serviceUrl: string; conversationId: string; activity: unknown }> = [];
  const app = {
    api: {
      fromServiceUrl: ({ serviceUrl }: { serviceUrl: string }) => ({
        conversations: {
          createActivity: async (conversationId: string, activity: unknown) => {
            calls.push({ serviceUrl, conversationId, activity });
            return receipt;
          },
        },
      }),
    },
  } as unknown as App;
  return { app, calls };
}

describe("Teams onboarding message delivery", () => {
  test.each(["setup", "link"] as const)(
    "%s sends a readable open-URL action with the exact proof fragment",
    async (purpose) => {
      const proof = {
        purpose,
        tenantId,
        actorId,
        workspaceId: purpose === "setup" ? null : workspaceId,
        generation: purpose === "setup" ? null : generation,
      };
      const token = mintTeamsProof("fixture-signing-secret", proof);
      const url = new URL(
        purpose === "setup" ? "/teams/connect" : `/workspaces/${workspaceId}/plugins`,
        "https://app.example.test",
      );
      url.hash = new URLSearchParams({
        [purpose === "setup" ? "teams_setup" : "teams_link"]: token,
      }).toString();
      const { app, calls } = transport();
      expect(await sendTeamsOnboarding(app, message, purpose, url.toString())).toBe("sent-1");
      const text =
        purpose === "setup"
          ? "Connect Teams to your Opengeni workspace."
          : "Link your Opengeni account to use this bot.";
      expect(calls).toEqual([
        {
          serviceUrl: message.serviceUrl,
          conversationId: message.conversationId,
          activity: {
            type: "message",
            text,
            textFormat: "plain",
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                content: {
                  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                  type: "AdaptiveCard",
                  version: "1.2",
                  actions: [
                    {
                      type: "Action.OpenUrl",
                      title: purpose === "setup" ? "Connect Teams" : "Link account",
                      url: url.toString(),
                    },
                  ],
                },
              },
            ],
          },
        },
      ]);
      // The only serialized occurrence is the action destination, never visible copy.
      expect(JSON.stringify(calls).split(token)).toHaveLength(2);
      expect(text).not.toContain(token);
      expect(
        verifyTeamsProof(
          "fixture-signing-secret",
          new URLSearchParams(url.hash.slice(1)).get(
            purpose === "setup" ? "teams_setup" : "teams_link",
          )!,
        ),
      ).toMatchObject(proof);
    },
  );

  test("refuses group/channel destinations before contacting the provider", async () => {
    const { app, calls } = transport();
    for (const groupChat of [false, true]) {
      await expect(
        sendTeamsOnboarding(
          app,
          { ...message, personal: false, groupChat },
          "link",
          "https://app.example.test/#teams_link=fixture",
        ),
      ).rejects.toThrow("teams_onboarding_requires_personal_chat");
    }
    expect(calls).toEqual([]);
  });

  test("keeps service-URL validation", async () => {
    const { app, calls } = transport();
    await expect(
      sendTeamsOnboarding(
        app,
        { ...message, serviceUrl: "https://untrusted.example.test/" },
        "setup",
        "https://app.example.test/#teams_setup=fixture",
      ),
    ).rejects.toThrow("teams_service_url_rejected");
    expect(calls).toEqual([]);
  });

  // Teams answers a card it accepted with an empty 202 and no message id
  // (seen on staging for the install welcome). That card was delivered, so it
  // must not fail the activity and make Teams redeliver it.
  test.each([{}, "", null])(
    "a card Teams accepts without a message id (%p) counts as delivered",
    async (receipt) => {
      const { app, calls } = transport(receipt);
      expect(
        await sendTeamsOnboarding(
          app,
          message,
          "connect",
          "https://app.example.test/#teams_setup=fixture",
        ),
      ).toBeNull();
      expect(calls).toHaveLength(1);
    },
  );
});

const botClientId = "d3f8842e-a4b7-483d-a9a9-551c547911aa";
function onboardingDeps(overrides: Parameters<typeof testSettings>[0] = {}): ApiRouteDeps {
  return {
    settings: testSettings({
      teamsBotClientId: botClientId,
      teamsBotClientSecret: "bot-secret",
      teamsBotTenantId: "20000000-0000-4000-8000-000000000001",
      integrationsStateSecret: "fixture-signing-secret",
      webBaseUrl: "https://app.example.test",
      teamsBotAllowedTenantIds: [tenantId],
      ...overrides,
    }),
  } as unknown as ApiRouteDeps;
}
function cardUrl(activity: unknown): URL {
  const content = (
    activity as {
      attachments: Array<{ content: { actions: Array<{ url: string; title: string }> } }>;
    }
  ).attachments[0]!.content;
  return new URL(content.actions[0]!.url);
}

describe("Teams replies for organizations that haven't connected Opengeni", () => {
  test("self-serve off keeps today's behavior: only an operator-approved installer gets a link", async () => {
    const { app, calls } = transport();
    const limiter = new TeamsOnboardingLimiter();
    expect(
      await replyToUnconnectedTeamsTenant(
        onboardingDeps(),
        app,
        message,
        "message",
        budgetsOf(limiter),
      ),
    ).toBe("setup_not_permitted");
    expect(
      await replyToUnconnectedTeamsTenant(
        onboardingDeps({ teamsBotAllowedTenantIds: [] }),
        app,
        message,
        "message",
        budgetsOf(limiter),
      ),
    ).toBe("tenant_disabled");
    expect(calls).toEqual([]);
    const approved = onboardingDeps({ teamsBotSetupAdminIds: [`${tenantId}:${actorId}`] });
    // An install event's sender needn't own the chat, so installs never carry
    // the operator setup link; the installer's own message gets it.
    expect(
      await replyToUnconnectedTeamsTenant(approved, app, message, "install", budgetsOf(limiter)),
    ).toBe("setup_not_permitted");
    expect(calls).toEqual([]);
    expect(
      await replyToUnconnectedTeamsTenant(approved, app, message, "message", budgetsOf(limiter)),
    ).toBe("setup_link_sent");
    expect(calls).toHaveLength(1);
    expect(cardUrl(calls[0]!.activity).pathname).toBe("/teams/connect");
  });

  test("self-serve sends a welcome with a Connect your organization link bound to tenant, person and chat", async () => {
    const { app, calls } = transport();
    const deps = onboardingDeps({ teamsBotSelfServeSetupEnabled: true });
    expect(await replyToUnconnectedTeamsTenant(deps, app, message, "message", budgetsOf())).toBe(
      "connect_link_sent",
    );
    expect(calls).toHaveLength(1);
    const activity = calls[0]!.activity as { text: string; attachments: unknown[] };
    expect(activity.text).toContain("Global Administrator or Teams Administrator");
    expect(activity.text).toContain("ask your admin");
    const url = cardUrl(activity);
    expect(`${url.origin}${url.pathname}`).toBe("https://app.example.test/teams/connect");
    const proof = verifyTeamsProof(
      "fixture-signing-secret",
      new URLSearchParams(url.hash.slice(1)).get("teams_setup")!,
    );
    expect(proof).toMatchObject({
      purpose: "setup",
      tenantId,
      actorId,
      workspaceId: null,
      generation: null,
      conversation: { id: message.conversationId, serviceUrl: message.serviceUrl },
    });
    // The proof never appears in visible text.
    expect(activity.text).not.toContain(url.hash.slice(1));
  });

  test("repeat replies are bounded per person and per tenant", async () => {
    const { app, calls } = transport();
    const deps = onboardingDeps({ teamsBotSelfServeSetupEnabled: true });
    const limiter = new TeamsOnboardingLimiter({
      actorCooldownMs: 60_000,
      actorDailyMax: 2,
      tenantDailyMax: 3,
      processHourlyMax: 100,
      maxTrackedKeys: 100,
    });
    expect(
      await replyToUnconnectedTeamsTenant(deps, app, message, "message", budgetsOf(limiter)),
    ).toBe("connect_link_sent");
    expect(
      await replyToUnconnectedTeamsTenant(deps, app, message, "message", budgetsOf(limiter)),
    ).toBe("onboarding_reply_limited");
    expect(calls).toHaveLength(1);
    const others = ["3", "4", "5"].map((n) => ({
      ...message,
      actorId: `10000000-0000-4000-8000-00000000010${n}`,
    }));
    expect(
      await replyToUnconnectedTeamsTenant(deps, app, others[0]!, "message", budgetsOf(limiter)),
    ).toBe("connect_link_sent");
    expect(
      await replyToUnconnectedTeamsTenant(deps, app, others[1]!, "message", budgetsOf(limiter)),
    ).toBe("connect_link_sent");
    expect(
      await replyToUnconnectedTeamsTenant(deps, app, others[2]!, "message", budgetsOf(limiter)),
    ).toBe("onboarding_reply_limited");
    expect(calls).toHaveLength(3);
  });

  test("install welcomes and not-available notices have their own budgets", async () => {
    const { app, calls } = transport();
    const deps = onboardingDeps({ teamsBotSelfServeSetupEnabled: true });
    const limits = {
      actorCooldownMs: 60_000,
      actorDailyMax: 1,
      tenantDailyMax: 2,
      processHourlyMax: 100,
      maxTrackedKeys: 100,
    };
    const budgets: TeamsOnboardingBudgets = {
      connect: new TeamsOnboardingLimiter({ ...limits, actorDailyMax: 6, tenantDailyMax: 100 }),
      installWelcome: new TeamsOnboardingLimiter(limits),
      unavailableNotice: new TeamsOnboardingLimiter({ ...limits, processHourlyMax: 1 }),
    };
    const people = ["1", "2", "3"].map((n) => ({
      ...message,
      actorId: `10000000-0000-4000-8000-00000000020${n}`,
    }));
    const reply = (m: typeof message, source: "message" | "install") =>
      replyToUnconnectedTeamsTenant(deps, app, m, source, budgets);
    expect(await reply(people[0]!, "install")).toBe("connect_link_sent");
    expect(await reply(people[1]!, "install")).toBe("connect_link_sent");
    // A tenant that pre-installs the app for everyone gets only a few welcomes.
    expect(await reply(people[2]!, "install")).toBe("onboarding_reply_limited");
    // Writing to the bot is answered from its own budget.
    expect(await reply(people[2]!, "message")).toBe("connect_link_sent");
    // Notices for tenants that aren't admitted only use their own budget.
    const outsiders = ["5", "6"].map((n) => ({
      ...message,
      tenantId: `30000000-0000-4000-8000-00000000000${n}`,
    }));
    expect(await reply(outsiders[0]!, "message")).toBe("tenant_unavailable_notice_sent");
    expect(await reply(outsiders[1]!, "message")).toBe("tenant_disabled");
    expect(await reply(people[0]!, "message")).toBe("connect_link_sent");
    expect(calls).toHaveLength(5);
  });

  test("group chats and channels never get onboarding replies", async () => {
    const { app, calls } = transport();
    const deps = onboardingDeps({ teamsBotSelfServeSetupEnabled: true });
    for (const groupChat of [false, true])
      expect(
        await replyToUnconnectedTeamsTenant(
          deps,
          app,
          { ...message, personal: false, groupChat } as typeof message,
          "message",
          budgetsOf(),
        ),
      ).toBe("setup_not_permitted");
    expect(calls).toEqual([]);
  });

  test("a tenant that isn't admitted gets a bounded notice and no setup link", async () => {
    const { app, calls } = transport();
    const deps = onboardingDeps({
      teamsBotSelfServeSetupEnabled: true,
      teamsBotAllowedTenantIds: [],
    });
    const budgets = createTeamsOnboardingBudgets();
    expect(await replyToUnconnectedTeamsTenant(deps, app, message, "message", budgets)).toBe(
      "tenant_unavailable_notice_sent",
    );
    expect(await replyToUnconnectedTeamsTenant(deps, app, message, "message", budgets)).toBe(
      "tenant_disabled",
    );
    // Another person gets one notice; installing the app never triggers one.
    const other = { ...message, actorId: "10000000-0000-4000-8000-000000000109" };
    expect(await replyToUnconnectedTeamsTenant(deps, app, other, "install", budgets)).toBe(
      "tenant_disabled",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.activity).toEqual({
      type: "message",
      text: TEAMS_TENANT_UNAVAILABLE_TEXT,
      textFormat: "markdown",
    });
  });

  test("self-serve needs an admitted work or school tenant", () => {
    const settings = onboardingDeps({ teamsBotSelfServeSetupEnabled: true }).settings;
    expect(teamsSelfServeSetupAvailable(settings, tenantId)).toBe(true);
    expect(teamsSelfServeSetupAvailable(settings, "20000000-0000-4000-8000-000000000077")).toBe(
      false,
    );
    expect(
      teamsSelfServeSetupAvailable(
        { ...settings, teamsBotEnabled: true },
        "9188040d-6c67-4c5b-b112-36a304b66dad",
      ),
    ).toBe(false);
    expect(
      teamsSelfServeSetupAvailable(
        { ...settings, teamsBotEnabled: true },
        "20000000-0000-4000-8000-000000000077",
      ),
    ).toBe(true);
    expect(teamsSelfServeSetupAvailable(onboardingDeps().settings, tenantId)).toBe(false);
  });

  test("setup confirmation goes to the chat named in the signed proof", async () => {
    const { app, calls } = transport();
    await confirmTeamsSetup(app, { id: "a:personal", serviceUrl: message.serviceUrl });
    expect(calls).toEqual([
      {
        serviceUrl: message.serviceUrl,
        conversationId: "a:personal",
        activity: { type: "message", text: TEAMS_SETUP_CONFIRMED_TEXT, textFormat: "markdown" },
      },
    ]);
    await expect(
      confirmTeamsSetup(app, { id: "a:personal", serviceUrl: "https://untrusted.example.test/" }),
    ).rejects.toThrow("teams_service_url_rejected");
  });
});

describe("Teams proof lifetimes", () => {
  test("setup proofs last long enough to sign up first; link proofs stay short", () => {
    const base = { tenantId, actorId, workspaceId: null, generation: null };
    const setup = mintTeamsProof("secret", { ...base, purpose: "setup" }, 0);
    const link = mintTeamsProof("secret", { ...base, purpose: "link", workspaceId, generation }, 0);
    expect(verifyTeamsProof("secret", setup, 30 * 60_000).purpose).toBe("setup");
    expect(() => verifyTeamsProof("secret", setup, 60 * 60_000)).toThrow("teams_link_expired");
    expect(verifyTeamsProof("secret", link, 9 * 60_000).purpose).toBe("link");
    expect(() => verifyTeamsProof("secret", link, 10 * 60_000)).toThrow("teams_link_expired");
  });
});

describe("Teams personal install events", () => {
  const install = {
    type: "conversationUpdate",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    from: { id: "29:human", aadObjectId: actorId.toUpperCase() },
    recipient: { id: "28:bot" },
    conversation: { id: "a:personal", conversationType: "personal", tenantId },
    channelData: { tenant: { id: tenantId.toUpperCase() } },
    membersAdded: [{ id: "28:bot" }],
  };

  test("recognizes the bot being added to a person's 1:1 scope", () => {
    expect(teamsPersonalInstall(install)).toEqual({
      tenantId,
      actorId,
      conversationId: "a:personal",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      botId: "28:bot",
    });
  });

  test("names no installer when the sender is a bot, the bot itself or has no Microsoft identity", () => {
    for (const from of [
      { id: "28:bot", aadObjectId: actorId },
      { id: "28:other-bot", aadObjectId: actorId, role: "bot" },
      { id: "29:human" },
    ])
      expect(teamsPersonalInstall({ ...install, from })?.actorId).toBeNull();
  });

  test("ignores other members, group scopes, tenant mismatches and untrusted service URLs", () => {
    for (const value of [
      { ...install, membersAdded: [{ id: "29:someone" }] },
      { ...install, conversation: { ...install.conversation, conversationType: "groupChat" } },
      {
        ...install,
        conversation: { ...install.conversation, tenantId: "20000000-0000-4000-8000-000000000002" },
      },
      { ...install, serviceUrl: "https://untrusted.example.test/" },
      { ...install, type: "message" },
    ])
      expect(teamsPersonalInstall(value)).toBeNull();
  });
});

describe("Teams onboarding limiter", () => {
  test("cooldown, daily caps and the process cap", () => {
    const limiter = new TeamsOnboardingLimiter({
      actorCooldownMs: 1_000,
      actorDailyMax: 3,
      tenantDailyMax: 100,
      processHourlyMax: 5,
      maxTrackedKeys: 100,
    });
    expect(limiter.tryReserve("T", "A", 0)).toBe(true);
    expect(limiter.tryReserve("t", "a", 500)).toBe(false);
    expect(limiter.tryReserve("T", "A", 1_000)).toBe(true);
    expect(limiter.tryReserve("T", "A", 2_000)).toBe(true);
    expect(limiter.tryReserve("T", "A", 3_000)).toBe(false);
    // A new day resets the person's cap.
    expect(limiter.tryReserve("T", "A", 24 * 60 * 60_000)).toBe(true);
    // The process cap bounds many tenants together within an hour.
    const fresh = new TeamsOnboardingLimiter({
      actorCooldownMs: 1_000,
      actorDailyMax: 3,
      tenantDailyMax: 100,
      processHourlyMax: 2,
      maxTrackedKeys: 100,
    });
    expect(fresh.tryReserve("T1", "A", 0)).toBe(true);
    expect(fresh.tryReserve("T2", "A", 0)).toBe(true);
    expect(fresh.tryReserve("T3", "A", 0)).toBe(false);
    expect(fresh.tryReserve("T3", "A", 60 * 60_000)).toBe(true);
  });

  test("tracked keys stay bounded", () => {
    const limiter = new TeamsOnboardingLimiter({
      actorCooldownMs: 1_000,
      actorDailyMax: 3,
      tenantDailyMax: 100,
      processHourlyMax: 1_000,
      maxTrackedKeys: 10,
    });
    for (let n = 0; n < 50; n += 1) expect(limiter.tryReserve(`T${n}`, "A", 0)).toBe(true);
    const sizes = limiter as unknown as {
      actors: Map<string, unknown>;
      tenants: Map<string, unknown>;
    };
    expect(sizes.actors.size).toBe(10);
    expect(sizes.tenants.size).toBe(10);
  });
});
