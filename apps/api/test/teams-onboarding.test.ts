import { describe, expect, test } from "bun:test";
import type { App } from "@microsoft/teams.apps";
import type { ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import {
  TEAMS_SETUP_CONFIRMED_TEXT,
  confirmTeamsSetup,
  replyToUnconnectedTeamsTenant,
  sendTeamsOnboarding,
  teamsSelfServeSetupAvailable,
  teamsTenantUnavailableText,
} from "../src/integrations/teams-bot";
import {
  DurableTeamsOnboardingBudget,
  TEAMS_ONBOARDING_REMINDER_LIMITS,
  TeamsOnboardingLimiter,
  createTeamsOnboardingBudgets,
  type TeamsOnboardingBudgets,
} from "../src/integrations/teams-onboarding-limit";
import {
  TEAMS_CONNECT_REMINDER_TEXT,
  TEAMS_SHARED_CONNECT_TEXT,
  TEAMS_WORK_ACCOUNT_TEXT,
} from "../src/integrations/teams-experience";
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

/** A reminder budget that never allows a reminder. */
function noReminders(): TeamsOnboardingLimiter {
  return new TeamsOnboardingLimiter({ ...TEAMS_ONBOARDING_REMINDER_LIMITS, actorDailyMax: 0 });
}
/** Fresh budgets whose connect budget is `connect` and reminder budget is `reminder`. */
function budgetsOf(
  connect = new TeamsOnboardingLimiter(),
  reminder = new TeamsOnboardingLimiter(TEAMS_ONBOARDING_REMINDER_LIMITS),
): TeamsOnboardingBudgets {
  return { ...createTeamsOnboardingBudgets(), connect, reminder };
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
          ? "Connect Teams to Opengeni."
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

  test("repeat cards are bounded per person and per tenant, then reminders answer", async () => {
    const { app, calls } = transport();
    const deps = onboardingDeps({ teamsBotSelfServeSetupEnabled: true });
    const limiter = new TeamsOnboardingLimiter({
      actorCooldownMs: 60_000,
      actorDailyMax: 2,
      tenantDailyMax: 3,
      overallHourlyMax: 100,
      maxTrackedKeys: 100,
    });
    const reminders = new TeamsOnboardingLimiter({
      actorCooldownMs: 60_000,
      actorDailyMax: 5,
      tenantDailyMax: 2,
      overallHourlyMax: 100,
      maxTrackedKeys: 100,
    });
    const reply = (m: typeof message) =>
      replyToUnconnectedTeamsTenant(deps, app, m, "message", budgetsOf(limiter, reminders));
    expect(await reply(message)).toBe("connect_link_sent");
    // Within the card's cooldown a short reminder answers instead of silence.
    expect(await reply(message)).toBe("connect_reminder_sent");
    // The reminder has its own cooldown.
    expect(await reply(message)).toBe("onboarding_reply_limited");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.activity).toEqual({
      type: "message",
      text: TEAMS_CONNECT_REMINDER_TEXT,
      textFormat: "markdown",
    });
    const others = ["3", "4", "5", "6"].map((n) => ({
      ...message,
      actorId: `10000000-0000-4000-8000-00000000010${n}`,
    }));
    expect(await reply(others[0]!)).toBe("connect_link_sent");
    expect(await reply(others[1]!)).toBe("connect_link_sent");
    // The tenant's cards are used up; its reminders are bounded too.
    expect(await reply(others[2]!)).toBe("connect_reminder_sent");
    expect(await reply(others[3]!)).toBe("onboarding_reply_limited");
    expect(calls).toHaveLength(5);
    for (const call of calls.filter((c) => !(c.activity as { attachments?: unknown }).attachments))
      expect(JSON.stringify(call.activity)).not.toContain("teams_setup");
  });

  test("a person whose replies Teams keeps throttling can't use up other tenants' replies", async () => {
    const calls: string[] = [];
    const app = {
      api: {
        fromServiceUrl: () => ({
          conversations: {
            createActivity: async (conversationId: string) => {
              if (conversationId === "19:flooded")
                throw Object.assign(new Error("throttled"), { response: { status: 429 } });
              calls.push(conversationId);
              return { id: "sent" };
            },
          },
        }),
      },
    } as unknown as App;
    const other = "30000000-0000-4000-8000-000000000007";
    const deps = onboardingDeps({
      teamsBotSelfServeSetupEnabled: true,
      teamsBotAllowedTenantIds: [tenantId, other],
    });
    const budgets = budgetsOf(
      new TeamsOnboardingLimiter({
        actorCooldownMs: 60_000,
        actorDailyMax: 2,
        tenantDailyMax: 100,
        overallHourlyMax: 10,
        maxTrackedKeys: 100,
      }),
      new TeamsOnboardingLimiter({
        actorCooldownMs: 0,
        actorDailyMax: 3,
        tenantDailyMax: 100,
        overallHourlyMax: 10,
        maxTrackedKeys: 100,
      }),
    );
    const flooder = { ...message, conversationId: "19:flooded" };
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1)
      outcomes.push(
        await replyToUnconnectedTeamsTenant(deps, app, flooder, "message", budgets).catch(
          () => "throttled",
        ),
      );
    // Throttled replies keep their count, so the person's own caps bound them:
    // one card (then its cooldown) and three reminders.
    expect(outcomes.filter((outcome) => outcome === "throttled")).toHaveLength(4);
    expect(outcomes.at(-1)).toBe("onboarding_reply_limited");
    const elsewhere = {
      ...message,
      tenantId: other,
      actorId: "30000000-0000-4000-8000-000000000008",
      conversationId: "19:elsewhere",
    };
    expect(await replyToUnconnectedTeamsTenant(deps, app, elsewhere, "message", budgets)).toBe(
      "connect_link_sent",
    );
    expect(calls).toEqual(["19:elsewhere"]);
  });

  test("a reinstall within a day gets a short welcome once its card is used up", async () => {
    const { app, calls } = transport();
    const deps = onboardingDeps({ teamsBotSelfServeSetupEnabled: true });
    const budgets = budgetsOf();
    expect(await replyToUnconnectedTeamsTenant(deps, app, message, "install", budgets)).toBe(
      "connect_link_sent",
    );
    expect(await replyToUnconnectedTeamsTenant(deps, app, message, "install", budgets)).toBe(
      "connect_reminder_sent",
    );
    expect((calls[1]!.activity as { text: string }).text).toBe(
      `Welcome to Opengeni. ${TEAMS_CONNECT_REMINDER_TEXT}`,
    );
  });

  test("a personal Microsoft account gets a bounded work or school account notice", async () => {
    const { app, calls } = transport();
    const consumer = "9188040d-6c67-4c5b-b112-36a304b66dad";
    const deps = onboardingDeps({
      teamsBotSelfServeSetupEnabled: true,
      teamsBotAllowedTenantIds: [consumer],
    });
    const m = { ...message, tenantId: consumer };
    const once = new TeamsOnboardingLimiter({
      actorCooldownMs: 60_000,
      actorDailyMax: 1,
      tenantDailyMax: 100,
      overallHourlyMax: 100,
      maxTrackedKeys: 100,
    });
    const budgets = { ...budgetsOf(once, once), installWelcome: once };
    expect(await replyToUnconnectedTeamsTenant(deps, app, m, "install", budgets)).toBe(
      "work_account_notice_sent",
    );
    expect(await replyToUnconnectedTeamsTenant(deps, app, m, "message", budgetsOf())).toBe(
      "work_account_notice_sent",
    );
    expect(calls.map((call) => call.activity)).toEqual([
      { type: "message", text: TEAMS_WORK_ACCOUNT_TEXT, textFormat: "markdown" },
      { type: "message", text: TEAMS_WORK_ACCOUNT_TEXT, textFormat: "markdown" },
    ]);
    expect(await replyToUnconnectedTeamsTenant(deps, app, m, "message", budgets)).toBe(
      "onboarding_reply_limited",
    );
    // Without self-serve, nothing changes for that tenant.
    expect(
      await replyToUnconnectedTeamsTenant(
        onboardingDeps({ teamsBotAllowedTenantIds: [consumer] }),
        app,
        m,
        "message",
        budgetsOf(),
      ),
    ).toBe("setup_not_permitted");
    expect(calls).toHaveLength(2);
  });

  test("install welcomes and not-available notices have their own budgets", async () => {
    const { app, calls } = transport();
    const deps = onboardingDeps({ teamsBotSelfServeSetupEnabled: true });
    const limits = {
      actorCooldownMs: 60_000,
      actorDailyMax: 1,
      tenantDailyMax: 2,
      overallHourlyMax: 100,
      maxTrackedKeys: 100,
    };
    const budgets: TeamsOnboardingBudgets = {
      connect: new TeamsOnboardingLimiter({ ...limits, actorDailyMax: 6, tenantDailyMax: 100 }),
      installWelcome: new TeamsOnboardingLimiter(limits),
      unavailableNotice: new TeamsOnboardingLimiter({ ...limits, overallHourlyMax: 1 }),
      reminder: noReminders(),
      sharedNotice: noReminders(),
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

  test("group chats and channels get a bounded reminder to message the bot, never a card", async () => {
    const { app, calls } = transport();
    const deps = onboardingDeps({ teamsBotSelfServeSetupEnabled: true });
    const budgets = budgetsOf();
    const shared = (groupChat: boolean) =>
      ({ ...message, personal: false, groupChat, threadId: "thread-1" }) as typeof message;
    expect(await replyToUnconnectedTeamsTenant(deps, app, shared(true), "message", budgets)).toBe(
      "shared_connect_reminder_sent",
    );
    // Everyone in the conversation sees them, so each person gets at most one a minute.
    expect(await replyToUnconnectedTeamsTenant(deps, app, shared(false), "message", budgets)).toBe(
      "setup_not_permitted",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.activity).toEqual({
      type: "message",
      text: TEAMS_SHARED_CONNECT_TEXT,
      textFormat: "markdown",
      replyToId: "thread-1",
    });
    // Without self-serve there is nothing to point to.
    expect(
      await replyToUnconnectedTeamsTenant(
        onboardingDeps(),
        app,
        shared(true),
        "message",
        budgetsOf(),
      ),
    ).toBe("setup_not_permitted");
    expect(calls).toHaveLength(1);
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
      text: teamsTenantUnavailableText(deps.settings),
      textFormat: "markdown",
    });
  });

  test("the not-available notice names the operator's support address", () => {
    expect(teamsTenantUnavailableText({ supportEmail: "support@example.test" })).toBe(
      "Opengeni isn't available for your organization yet. Your Microsoft 365 or Teams admin can request access at support@example.test.",
    );
    expect(teamsTenantUnavailableText({})).toContain("contact the Opengeni team");
    expect(teamsTenantUnavailableText({ teamsAppName: "Opengeni Assistant" })).toBe(
      "Opengeni Assistant isn't available for your organization yet. Your Microsoft 365 or Teams admin can contact the Opengeni team to request access.",
    );
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
  test("a database failure falls back to counting in memory", async () => {
    const errors: unknown[] = [];
    const failing = {
      transaction: async () => {
        throw new Error("database unavailable");
      },
      execute: async () => {
        throw new Error("database unavailable");
      },
    } as unknown as ConstructorParameters<typeof DurableTeamsOnboardingBudget>[0];
    const budget = new DurableTeamsOnboardingBudget(
      failing,
      "connect",
      {
        actorCooldownMs: 60_000,
        actorDailyMax: 1,
        tenantDailyMax: 10,
        overallHourlyMax: 10,
        maxTrackedKeys: 10,
      },
      (error) => errors.push(error),
    );
    const first = await budget.reserve("T", "A");
    expect(first).not.toBeNull();
    expect(await budget.reserve("T", "A")).toBeNull();
    // Given back to memory, where it was counted.
    await first!.release();
    expect(await budget.reserve("T", "A")).not.toBeNull();
    expect(errors).toHaveLength(3);
  });

  test("cooldown, daily caps and the process cap", () => {
    const limiter = new TeamsOnboardingLimiter({
      actorCooldownMs: 1_000,
      actorDailyMax: 3,
      tenantDailyMax: 100,
      overallHourlyMax: 5,
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
      overallHourlyMax: 2,
      maxTrackedKeys: 100,
    });
    expect(fresh.tryReserve("T1", "A", 0)).toBe(true);
    expect(fresh.tryReserve("T2", "A", 0)).toBe(true);
    expect(fresh.tryReserve("T3", "A", 0)).toBe(false);
    expect(fresh.tryReserve("T3", "A", 60 * 60_000)).toBe(true);
  });

  test("a released reservation can be used again at once", () => {
    const limiter = new TeamsOnboardingLimiter({
      actorCooldownMs: 10_000,
      actorDailyMax: 1,
      tenantDailyMax: 1,
      overallHourlyMax: 10,
      maxTrackedKeys: 100,
    });
    expect(limiter.tryReserve("T", "A", 0)).toBe(true);
    expect(limiter.tryReserve("T", "A", 1)).toBe(false);
    limiter.release("T", "A", 2);
    expect(limiter.tryReserve("t", "a", 3)).toBe(true);
    expect(limiter.tryReserve("T", "A", 4)).toBe(false);
    // Releasing what was never reserved changes nothing.
    limiter.release("T", "B", 5);
    limiter.release("T", "B", 5);
    expect(limiter.tryReserve("T", "B", 6)).toBe(false);
  });

  test("a refused reply gives back only its own person's and tenant's count, once", async () => {
    const limiter = new TeamsOnboardingLimiter({
      actorCooldownMs: 0,
      actorDailyMax: 10,
      tenantDailyMax: 10,
      overallHourlyMax: 3,
      maxTrackedKeys: 100,
    });
    // Teams keeps throttling one person's reply: each attempt is given back
    // to the person and tenant, but the hourly count bounds the attempts.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reservation = await limiter.reserve("T", "A");
      expect(reservation).not.toBeNull();
      await reservation!.release();
      // Releasing twice gives back nothing more.
      await reservation!.release();
    }
    expect(await limiter.reserve("T", "A")).toBeNull();
    expect(await limiter.reserve("T2", "B")).toBeNull();
    // A released reservation never gives back another person's count.
    const other = new TeamsOnboardingLimiter({
      actorCooldownMs: 0,
      actorDailyMax: 1,
      tenantDailyMax: 2,
      overallHourlyMax: 100,
      maxTrackedKeys: 100,
    });
    const first = await other.reserve("T", "A");
    expect(await other.reserve("T", "B")).not.toBeNull();
    await first!.release();
    await first!.release();
    expect(await other.reserve("T", "B")).toBeNull();
    expect(await other.reserve("T", "A")).not.toBeNull();
    expect(await other.reserve("T", "C")).toBeNull();
  });

  test("tracked keys stay bounded", () => {
    const limiter = new TeamsOnboardingLimiter({
      actorCooldownMs: 1_000,
      actorDailyMax: 3,
      tenantDailyMax: 100,
      overallHourlyMax: 1_000,
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
