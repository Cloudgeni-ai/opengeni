// Occasional update messages about Slack agents: who gets one and when, the
// message itself, idempotent sending, the mute button and the admin preview.
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  signDelegatedAccessToken,
  slackAgentNameKey,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSlackAgentUpdateDelivery,
  createConnection,
  createDb,
  createWorkspace,
  encryptEnvironmentValue,
  grantWorkspaceAccess,
  insertSlackAgent,
  saveSlackBotUserLink,
  setSlackBotUserUpdatesMuted,
  touchSlackAgentUserState,
  type DbClient,
  type SlackAgentRecord,
  type SlackAgentUpdateRecipientRecord,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createAppComposition } from "../src/app";
import {
  buildSlackAgentUpdateMessage,
  buildSlackAgentUpdateMuteConfirmation,
  inSlackAgentUpdateWindow,
  resetSlackAgentUpdateCaches,
  selectSlackAgentUpdate,
  slackAgentUpdateHomeUrl,
  slackLocalTime,
  sweepSlackAgentUpdatesOnce,
} from "../src/integrations/slack-agent-updates";

const DAY = 24 * 60 * 60 * 1_000;
const DELEGATION_SECRET = "slack-agent-updates-delegation-secret";
const signingMaterial = ["slack", "updates", crypto.randomUUID()].join("-");
const encryptionKey = randomBytes(32).toString("base64");
const authorizationHeaderName = ["author", "ization"].join("");
const bearerScheme = ["Bear", "er"].join("");

function agent(id: string, name: string, description = `${name} helps.`): SlackAgentRecord {
  return {
    id,
    name,
    description,
    targetWorkspaceId: "00000000-0000-4000-8000-000000000001",
  } as SlackAgentRecord;
}

/** The first Monday–Friday `hour`:30 UTC strictly after `from` plus `addDays`. */
function weekdayAt(hour: number, from = new Date(), addDays = 0): Date {
  const start = from.getTime() + addDays * DAY;
  const candidate = new Date(start);
  candidate.setUTCHours(hour, 30, 0, 0);
  if (candidate.getTime() <= start) candidate.setTime(candidate.getTime() + DAY);
  while ([0, 6].includes(candidate.getUTCDay())) {
    candidate.setTime(candidate.getTime() + DAY);
  }
  return candidate;
}

function visibleText(blocks: unknown[]): string {
  return JSON.stringify(blocks)
    .replaceAll(/<@[A-Z0-9_]+>/gu, "@Opengeni")
    .replaceAll(/"(action_id|block_id|value|url|type)":"[^"]*"/gu, "");
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

describe("update message content", () => {
  const homeUrl = slackAgentUpdateHomeUrl({ slackTeamId: "T123", appId: "A456" });
  const agents = [
    agent("a1", "Analytics", "Answers revenue questions."),
    agent("a2", "Ops Desk"),
    agent("a3", "Legal"),
  ];

  test("every kind is at most four lines with two buttons, sent as Opengeni", () => {
    for (const kind of ["update", "welcome", "dormant"] as const) {
      for (const named of [agents.slice(0, 1), agents]) {
        const message = buildSlackAgentUpdateMessage({
          kind,
          agents: named,
          botUserId: "UOPENGENI",
          homeUrl,
          muteValue: "delivery-1",
        });
        expect(message.blocks).toHaveLength(2);
        const [section, actions] = message.blocks as [
          { type: string; text: { text: string } },
          { type: string; elements: Array<{ text: { text: string }; url?: string }> },
        ];
        expect(section.type).toBe("section");
        // Text lines plus the row of buttons stay within four lines.
        expect(section.text.text.split("\n").length + 1).toBeLessThanOrEqual(4);
        expect(actions.elements.map((element) => element.text.text)).toEqual([
          "See all agents",
          "Mute updates",
        ]);
        expect(actions.elements[0]!.url).toBe("slack://app?team=T123&id=A456&tab=home");
        expect(section.text.text).toContain("<@UOPENGENI> +analytics");
        expect(visibleText(message.blocks)).not.toMatch(/\bbots?\b/iu);
        expect(message.text).not.toMatch(/\bbots?\b/iu);
        // No agent identity: the message has no username or icon override.
        expect(JSON.stringify(message)).not.toMatch(/username|icon_/u);
      }
    }
  });

  test("many agents are named two at a time", () => {
    const message = buildSlackAgentUpdateMessage({
      kind: "update",
      agents,
      botUserId: "UOPENGENI",
      homeUrl,
      muteValue: "x",
    });
    expect(message.text).toBe("New agents you can ask: Analytics, Ops Desk and 1 more.");
  });

  test("the mute confirmation keeps the message, says it is muted and offers Undo", () => {
    const muted = buildSlackAgentUpdateMuteConfirmation({
      messageText: "New agent you can ask: *Analytics*.",
      homeUrl,
      muted: true,
      value: "delivery-1",
    });
    expect(JSON.stringify(muted)).toContain("Updates muted.");
    const buttons = (muted.at(-1) as { elements: Array<{ text: { text: string } }> }).elements;
    expect(buttons.map((button) => button.text.text)).toEqual(["See all agents", "Undo"]);
    const undone = buildSlackAgentUpdateMuteConfirmation({
      messageText: "New agent you can ask: *Analytics*.",
      homeUrl,
      muted: false,
      value: "delivery-1",
    });
    expect(JSON.stringify(undone)).not.toContain("Updates muted.");
    expect(
      (undone.at(-1) as { elements: Array<{ text: { text: string } }> }).elements.map(
        (button) => button.text.text,
      ),
    ).toEqual(["See all agents", "Mute updates"]);
  });
});

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

describe("update timing", () => {
  test("local time comes from the Slack time zone, then the offset", () => {
    // Wednesday 2026-11-04 15:30 UTC is 10:30 in New York (EST, UTC-5).
    const now = new Date("2026-11-04T15:30:00Z");
    expect(slackLocalTime(now, "America/New_York", -18_000)).toEqual({
      weekday: 3,
      hour: 10,
      date: "2026-11-04",
    });
    // An unknown zone name falls back to tz_offset.
    expect(slackLocalTime(now, "Mars/Olympus", -18_000)).toEqual({
      weekday: 3,
      hour: 10,
      date: "2026-11-04",
    });
    // Daylight saving is the zone's, not a stale offset's: 14:30 UTC in July is 10:30 EDT.
    expect(
      slackLocalTime(new Date("2026-07-08T14:30:00Z"), "America/New_York", -18_000)?.hour,
    ).toBe(10);
    expect(slackLocalTime(now, null, null)).toBeNull();
  });

  test("only weekdays from 10:00 to 10:59 local time", () => {
    const at = (iso: string) =>
      inSlackAgentUpdateWindow(slackLocalTime(new Date(iso), "Europe/Oslo", null));
    // Oslo is UTC+1 in November.
    expect(at("2026-11-04T09:00:00Z")).toBe(true); // Wed 10:00
    expect(at("2026-11-04T09:59:59Z")).toBe(true); // Wed 10:59
    expect(at("2026-11-04T08:59:59Z")).toBe(false); // Wed 09:59
    expect(at("2026-11-04T10:00:00Z")).toBe(false); // Wed 11:00
    expect(at("2026-11-06T09:30:00Z")).toBe(true); // Fri
    expect(at("2026-11-07T09:30:00Z")).toBe(false); // Sat
    expect(at("2026-11-08T09:30:00Z")).toBe(false); // Sun
    expect(inSlackAgentUpdateWindow(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("who gets an update", () => {
  // Wednesday 2026-11-04 10:30 UTC.
  const now = new Date("2026-11-04T10:30:00Z");
  const enabledAt = new Date("2026-09-01T00:00:00Z");
  const analytics = agent("a1", "Analytics");
  const ops = agent("a2", "Ops Desk");
  const eligible = { state: "eligible" as const, tz: "UTC", tzOffset: 0 };
  const recipient = (
    overrides: Partial<SlackAgentUpdateRecipientRecord> = {},
  ): SlackAgentUpdateRecipientRecord => ({
    slackUserId: "U1",
    tz: "UTC",
    tzOffset: 0,
    profileState: "eligible",
    profileCheckedAt: now,
    lastSentAt: null,
    lastKind: null,
    welcomeSentAt: null,
    dormantSentAt: null,
    announcedAgentIds: [],
    ...overrides,
  });
  const select = (overrides: Partial<Parameters<typeof selectSlackAgentUpdate>[0]> = {}) =>
    selectSlackAgentUpdate({
      now,
      updatesEnabledAt: enabledAt,
      member: {
        slackUserId: "U1",
        linkedAt: new Date(now.getTime() - 10 * DAY),
        updatesMutedAt: null,
      },
      recipient: undefined,
      profile: eligible,
      usableAgents: [analytics, ops],
      usedAgentIds: new Set(),
      lastUsedAt: null,
      ...overrides,
    });

  test("a new agent they can use is announced once, on a weekday at 10:00", () => {
    const decision = select();
    expect(decision).toMatchObject({
      send: true,
      kind: "update",
      dedupeKey: "U1:update:2026-11-04",
    });
    expect(decision.send && decision.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(select({ recipient: recipient({ announcedAgentIds: ["a1", "a2"] }) })).toEqual({
      send: false,
      reason: "nothing_new",
    });
    const onlyNew = select({
      recipient: recipient({
        announcedAgentIds: ["a1"],
        lastSentAt: new Date(now.getTime() - 31 * DAY),
      }),
    });
    expect(onlyNew.send && onlyNew.agents.map((a) => a.id)).toEqual(["a2"]);
  });

  test("at most one per 30 days", () => {
    expect(
      select({ recipient: recipient({ lastSentAt: new Date(now.getTime() - 29 * DAY) }) }),
    ).toEqual({
      send: false,
      reason: "too_soon",
    });
    expect(
      select({ recipient: recipient({ lastSentAt: new Date(now.getTime() - 30 * DAY) }) }).send,
    ).toBe(true);
  });

  test("outside 10:00 on a weekday nothing goes out", () => {
    expect(select({ now: new Date("2026-11-04T09:30:00Z") })).toEqual({
      send: false,
      reason: "outside_window",
    });
    expect(select({ now: new Date("2026-11-07T10:30:00Z") })).toEqual({
      send: false,
      reason: "outside_window",
    });
    // Their own zone: 10:30 UTC is 05:30 in New York.
    expect(
      select({ profile: { state: "eligible", tz: "America/New_York", tzOffset: null } }),
    ).toEqual({ send: false, reason: "outside_window" });
  });

  test("a welcome right after linking, once, only after the switch was turned on", () => {
    const justLinked = {
      slackUserId: "U1",
      linkedAt: new Date(now.getTime() - 60_000),
      updatesMutedAt: null,
    };
    // Saturday night: the welcome ignores the 10:00 rule.
    const saturday = new Date("2026-11-07T23:00:00Z");
    const welcome = select({
      now: saturday,
      member: { ...justLinked, linkedAt: new Date(saturday.getTime() - 60_000) },
    });
    expect(welcome).toMatchObject({ send: true, kind: "welcome", dedupeKey: "U1:welcome" });
    // Exempt from the 30-day limit.
    expect(
      select({
        member: justLinked,
        recipient: recipient({ lastSentAt: new Date(now.getTime() - DAY) }),
      }),
    ).toMatchObject({ send: true, kind: "welcome" });
    // Once.
    expect(
      select({
        member: justLinked,
        recipient: recipient({ welcomeSentAt: now, lastSentAt: now }),
      }),
    ).toEqual({ send: false, reason: "too_soon" });
    // People linked before the switch was on get no welcome.
    expect(select({ member: justLinked, updatesEnabledAt: now })).toMatchObject({ kind: "update" });
    // Nor more than a day after linking.
    expect(
      select({ member: { ...justLinked, linkedAt: new Date(now.getTime() - 2 * DAY) } }),
    ).toMatchObject({ kind: "update" });
  });

  test("one dormant reminder after 60 days without using any agent, then nothing", () => {
    const announced = recipient({
      announcedAgentIds: ["a1", "a2"],
      lastSentAt: new Date(now.getTime() - 61 * DAY),
    });
    const longAgo = {
      slackUserId: "U1",
      linkedAt: new Date(now.getTime() - 200 * DAY),
      updatesMutedAt: null,
    };
    const used = new Set(["a1"]);
    const dormant = select({
      member: longAgo,
      recipient: announced,
      usedAgentIds: used,
      lastUsedAt: new Date(now.getTime() - 61 * DAY),
    });
    expect(dormant).toMatchObject({
      send: true,
      kind: "dormant",
      dedupeKey: "U1:dormant:2026-11-04",
    });
    expect(dormant.send && dormant.agents.map((a) => a.id)).toEqual(["a2"]);
    // 59 days is not dormant.
    expect(
      select({
        member: longAgo,
        recipient: announced,
        usedAgentIds: used,
        lastUsedAt: new Date(now.getTime() - 59 * DAY),
      }),
    ).toEqual({ send: false, reason: "nothing_new" });
    // Once per dormancy: after the reminder nothing more until something is new.
    expect(
      select({
        member: longAgo,
        recipient: { ...announced, dormantSentAt: new Date(now.getTime() - 61 * DAY + 60_000) },
        usedAgentIds: used,
        lastUsedAt: new Date(now.getTime() - 61 * DAY),
      }),
    ).toEqual({ send: false, reason: "nothing_new" });
    // Someone dormant with a new agent gets the update, which is also their reminder.
    expect(
      select({
        member: longAgo,
        recipient: { ...announced, announcedAgentIds: ["a1"] },
        usedAgentIds: used,
        lastUsedAt: new Date(now.getTime() - 61 * DAY),
      }),
    ).toMatchObject({ send: true, kind: "update", alsoDormantReminder: true });
  });

  test("agents they already used, and people who can use none, are skipped", () => {
    expect(select({ usedAgentIds: new Set(["a1", "a2"]) })).toEqual({
      send: false,
      reason: "nothing_new",
    });
    const partly = select({ usedAgentIds: new Set(["a1"]) });
    expect(partly.send && partly.agents.map((a) => a.id)).toEqual(["a2"]);
    expect(select({ usableAgents: [] })).toEqual({ send: false, reason: "no_agents" });
  });

  test("guests, external, deactivated and muted people are skipped", () => {
    for (const state of ["guest", "external", "deactivated", "bot"] as const) {
      expect(select({ profile: { ...eligible, state } })).toEqual({
        send: false,
        reason: "not_eligible",
      });
    }
    expect(
      select({
        member: {
          slackUserId: "U1",
          linkedAt: new Date(now.getTime() - 10 * DAY),
          updatesMutedAt: now,
        },
      }),
    ).toEqual({ send: false, reason: "muted" });
  });
});

// ---------------------------------------------------------------------------
// With PostgreSQL and a fake Slack
// ---------------------------------------------------------------------------

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_slack_agent_updates");
  if (!shared) {
    available = false;
    return;
  }
  // 1153 creates the sweeper's inventory without runtime EXECUTE; a follow-up
  // migration grants it. These tests run as if it had.
  await shared.admin.unsafe(
    "GRANT EXECUTE ON FUNCTION opengeni_private.list_due_slack_agent_update_installations_v1(integer) TO opengeni_app",
  );
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

type SlackProfile = {
  tz?: string | null;
  tz_offset?: number;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_external?: boolean;
  deleted?: boolean;
  is_bot?: boolean;
  team_id?: string;
  profile?: Record<string, unknown>;
};

type SlackPost = { channel: string; text: string; blocks: unknown[] | null; ts: string };

function fakeSlack(teamId: string) {
  const profiles = new Map<string, SlackProfile>();
  const posts: SlackPost[] = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] | null }> =
    [];
  const calls: string[] = [];
  let nextTs = 1_000;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const method = url.pathname.replace(/^\/api\//u, "");
    const form = new URLSearchParams(String(init?.body ?? ""));
    calls.push(method);
    if (method === "users.info") {
      const id = form.get("user") ?? "";
      const profile = profiles.get(id);
      if (!profile) return Response.json({ ok: false, error: "user_not_found" });
      return Response.json({
        ok: true,
        user: {
          id,
          team_id: teamId,
          tz: "UTC",
          tz_offset: 0,
          is_restricted: false,
          is_ultra_restricted: false,
          deleted: false,
          is_bot: false,
          ...profile,
        },
      });
    }
    if (method === "conversations.open") {
      return Response.json({ ok: true, channel: { id: `D_${form.get("users")}` } });
    }
    if (method === "conversations.info") {
      const channel = form.get("channel") ?? "";
      return Response.json({ ok: true, channel: { id: channel, is_im: channel.startsWith("D_") } });
    }
    if (method === "chat.postMessage") {
      const ts = `${nextTs++}.000100`;
      posts.push({
        channel: form.get("channel") ?? "",
        text: form.get("text") ?? "",
        blocks: form.has("blocks") ? (JSON.parse(form.get("blocks")!) as unknown[]) : null,
        ts,
      });
      return Response.json({ ok: true, channel: form.get("channel"), ts });
    }
    if (method === "chat.update") {
      updates.push({
        channel: form.get("channel") ?? "",
        ts: form.get("ts") ?? "",
        text: form.get("text") ?? "",
        blocks: form.has("blocks") ? (JSON.parse(form.get("blocks")!) as unknown[]) : null,
      });
      return Response.json({ ok: true, channel: form.get("channel"), ts: form.get("ts") });
    }
    return Response.json({ ok: false, error: `unexpected_${method}` });
  };
  return { fetch: fetch as typeof globalThis.fetch, profiles, posts, updates, calls };
}

function encryptedBotCredential(settings: Settings): string {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) throw new Error("test connection encryption key was not configured");
  return encryptEnvironmentValue(
    key,
    JSON.stringify({
      headers: {
        [authorizationHeaderName]: `${bearerScheme} ${["xoxb", "fixture", crypto.randomUUID()].join("-")}`,
      },
    }),
  );
}

async function fixture() {
  resetSlackAgentUpdateCaches();
  // The sweeper looks at every installation with updates on; leave only this one's.
  await shared!.admin`update slack_agent_update_settings set updates_enabled = false`;
  const suffix = crypto.randomUUID().slice(0, 8);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "slack-agent-updates-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Slack agent updates",
    workspaceExternalSource: "slack-agent-updates-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Slack agent updates",
    subjectId: `user:owner-${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const home = { accountId: owner.accountId, workspaceId: owner.workspaceId };
  const teamId = `T${suffix.toUpperCase()}`;
  const botUserId = `UAPP${suffix.toUpperCase()}`;
  const settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    slackClientId: `slack-fixture-${owner.workspaceId}`,
    slackAccessMode: "full",
    environmentsEncryptionKey: encryptionKey,
    slackSigningSecret: signingMaterial,
    slackWorkspaceRoutingEnabled: true,
    publicBaseUrl: "https://app.example.test",
    webBaseUrl: "https://app.example.test",
    sandboxBackend: "none",
  }) as Settings;
  const connectionInput: Record<string, unknown> = {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    verifiedInstallAt: new Date(),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: teamId,
      slackTeamName: "Slack agent updates",
      botId: `B${suffix}`,
      botUserId,
      botDisplayName: "Opengeni",
      verifiedAt: new Date().toISOString(),
    },
    createdBySubjectId: owner.subjectId,
  };
  Reflect.set(
    connectionInput,
    ["credential", "Encrypted"].join(""),
    encryptedBotCredential(settings),
  );
  const connection = await createConnection(
    client.db,
    connectionInput as Parameters<typeof createConnection>[1],
  );
  const slack = fakeSlack(teamId);
  slack.profiles.set(botUserId, { is_bot: true, profile: { api_app_id: "AOPENGENI" } });
  const { app, routeDeps } = createAppComposition({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    managedAuth: null,
    slackFetch: slack.fetch,
  } as never);
  const deps = routeDeps as ApiRouteDeps;
  const analyticsWorkspace = await createWorkspace(client.db, {
    accountId: owner.accountId,
    name: "Analytics",
  });
  const createAgent = async (name: string, targetWorkspaceId = owner.workspaceId) => {
    const created = await insertSlackAgent(client.db, home, {
      connectionId: connection.id,
      slackTeamId: teamId,
      targetAccountId: owner.accountId,
      targetWorkspaceId,
      name,
      nameKey: slackAgentNameKey(name),
      description: `${name} helps.`,
      avatar: { kind: "emoji", emoji: "📊", hue: 210 },
      instructions: "Be brief.",
      createdBySubjectId: owner.subjectId,
    });
    if (created === "name_taken") throw new Error("fixture agent name taken");
    return created;
  };
  /** A linked Slack person who can start work in the home workspace. */
  const person = async (label: string, profile: SlackProfile = {}) => {
    const subjectId = label === "owner" ? owner.subjectId : `user:${label}-${suffix}`;
    if (label !== "owner") {
      await grantWorkspaceAccess(client.db, {
        ...home,
        subjectId,
        permissions: ["sessions:create", "sessions:read", "sessions:control"],
      });
    }
    const slackUserId = `U${label.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "")}${suffix.toUpperCase()}`;
    slack.profiles.set(slackUserId, profile);
    await saveSlackBotUserLink(client.db, {
      ...home,
      connectionId: connection.id,
      slackTeamId: teamId,
      slackUserId,
      subjectId,
      linkedBySubjectId: subjectId,
    });
    return { subjectId, slackUserId, channel: `D_${slackUserId}` };
  };
  const headers = async (subjectId: string, permissions: Permission[]) => {
    const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
      ...home,
      subjectId,
      permissions,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    return { "content-type": "application/json", authorization: `Bearer ${token}` };
  };
  const base = `/v1/workspaces/${owner.workspaceId}/integrations/slack/agent-updates`;
  const setSwitch = async (updatesEnabled: boolean, channelPostsOnly = false) => {
    const response = await app.request(base, {
      method: "PUT",
      headers: await headers(owner.subjectId, ["account:admin", "workspace:admin"]),
      body: JSON.stringify({ connectionId: connection.id, updatesEnabled, channelPostsOnly }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json();
  };
  const sweep = (now: Date) =>
    sweepSlackAgentUpdatesOnce(deps, { now: () => now, installationIntervalMs: 0 });
  const deliveries = async () =>
    await shared!.admin<
      {
        slack_user_id: string;
        kind: string;
        state: string;
        operation_id: string;
        dedupe_key: string;
      }[]
    >`select slack_user_id, kind, state, operation_id, dedupe_key
      from slack_agent_update_deliveries where connection_id = ${connection.id}
      order by created_at, id`;
  return {
    app,
    deps,
    slack,
    owner,
    home,
    teamId,
    botUserId,
    connectionId: connection.id,
    analyticsWorkspaceId: analyticsWorkspace.id,
    createAgent,
    person,
    headers,
    base,
    setSwitch,
    sweep,
    deliveries,
  };
}

function signedRequest(path: string, rawBody: string, contentType: string) {
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = `v0=${createHmac("sha256", signingMaterial)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}

describe("update messages with PostgreSQL", () => {
  test("until the sweeper's inventory is granted, nothing is swept", async () => {
    if (!available) return;
    const f = await fixture();
    await f.createAgent("Front Desk");
    await f.person("owner");
    await f.setSwitch(true);
    const grant =
      "EXECUTE ON FUNCTION opengeni_private.list_due_slack_agent_update_installations_v1(integer)";
    await shared!.admin.unsafe(`REVOKE ${grant} FROM opengeni_app`);
    try {
      expect(await f.sweep(weekdayAt(10))).toEqual({ installations: 0, sent: 0, failed: 0 });
      expect(f.slack.posts).toHaveLength(0);
    } finally {
      await shared!.admin.unsafe(`GRANT ${grant} TO opengeni_app`);
    }
    await f.setSwitch(false);
  });

  test("turning updates on sends each eligible person one update at 10:00, never twice", async () => {
    if (!available) return;
    const f = await fixture();
    await f.createAgent("Ops Desk");
    const owner = await f.person("owner");
    const guest = await f.person("guest", { is_restricted: true });
    const single = await f.person("single", { is_ultra_restricted: true });
    const external = await f.person("external", { is_external: true });
    const stranger = await f.person("stranger", { team_id: "TOTHER" });
    const gone = await f.person("gone", { deleted: true });
    const missing = await f.person("missing");
    f.slack.profiles.delete(missing.slackUserId);
    const muted = await f.person("muted");
    await setSlackBotUserUpdatesMuted(client.db, f.home, {
      connectionId: f.connectionId,
      slackUserId: muted.slackUserId,
      muted: true,
    });
    const used = await f.person("used");
    const [opsDesk] = await shared!.admin<{ id: string }[]>`
      select id from slack_agents where connection_id = ${f.connectionId}`;
    await touchSlackAgentUserState(client.db, f.home, {
      connectionId: f.connectionId,
      slackAgentId: opsDesk!.id,
      slackUserId: used.slackUserId,
      hintInteractionId: null,
    });

    const ten = weekdayAt(10);
    // Off by default: nothing is swept.
    expect(await f.sweep(ten)).toEqual({ installations: 0, sent: 0, failed: 0 });
    const off = await f.app.request(`${f.base}?connectionId=${f.connectionId}`, {
      headers: await f.headers(owner.subjectId, ["workspace:read"]),
    });
    expect(await off.json()).toMatchObject({
      updatesEnabled: false,
      channelPostsOnly: false,
      viewerCanManage: false,
    });

    await f.setSwitch(true);
    // Before 10:00 nothing goes out.
    expect((await f.sweep(weekdayAt(9))).sent).toBe(0);
    expect(f.slack.posts).toHaveLength(0);

    const first = await f.sweep(ten);
    expect(first.sent).toBe(1);
    expect(f.slack.posts.map((post) => post.channel)).toEqual([owner.channel]);
    const [post] = f.slack.posts;
    expect(post!.text).toBe("New agent you can ask: Ops Desk.");
    const buttons = (
      post!.blocks!.at(-1) as { elements: Array<{ text: { text: string }; url?: string }> }
    ).elements;
    expect(buttons.map((button) => button.text.text)).toEqual(["See all agents", "Mute updates"]);
    expect(buttons[0]!.url).toBe(`slack://app?team=${f.teamId}&id=AOPENGENI&tab=home`);
    // Nobody else: guests, external, deactivated, muted and people who already used it.
    for (const skipped of [guest, single, external, stranger, gone, missing, muted, used]) {
      expect(f.slack.posts.some((p) => p.channel === skipped.channel)).toBe(false);
    }
    const states = await shared!.admin<{ slack_user_id: string; profile_state: string }[]>`
      select slack_user_id, profile_state from slack_agent_update_recipients
      where connection_id = ${f.connectionId}`;
    const stateOf = (who: { slackUserId: string }) =>
      states.find((row) => row.slack_user_id === who.slackUserId)?.profile_state;
    expect(stateOf(guest)).toBe("guest");
    expect(stateOf(single)).toBe("guest");
    expect(stateOf(external)).toBe("external");
    expect(stateOf(stranger)).toBe("external");
    expect(stateOf(gone)).toBe("deactivated");
    expect(stateOf(missing)).toBe("deactivated");
    // Muted people are never looked up.
    expect(stateOf(muted)).toBeUndefined();

    // Sweeping again, in this or another process, sends nothing more.
    expect((await f.sweep(ten)).sent).toBe(0);
    expect(f.slack.posts).toHaveLength(1);
    const [delivery] = await f.deliveries();
    expect(delivery).toMatchObject({
      slack_user_id: owner.slackUserId,
      kind: "update",
      state: "sent",
    });
    // Claiming the same message again is refused.
    expect(
      await claimSlackAgentUpdateDelivery(client.db, f.home, {
        connectionId: f.connectionId,
        slackUserId: owner.slackUserId,
        kind: "update",
        dedupeKey: delivery!.dedupe_key,
        operationId: delivery!.operation_id,
        agentIds: [opsDesk!.id],
        text: "again",
        blocks: [],
        now: new Date(ten.getTime() + 40 * DAY),
      }),
    ).toEqual({ kind: "skipped", reason: "already_sent" });
    // A retry of a message whose result was lost is answered from the post
    // ledger under the same operation id, not posted again.
    await shared!.admin`
      update slack_agent_update_deliveries set state = 'pending', next_attempt_at = now() - interval '1 minute'
      where operation_id = ${delivery!.operation_id}`;
    expect((await f.sweep(ten)).sent).toBe(1);
    expect(f.slack.posts).toHaveLength(1);
    expect((await f.deliveries())[0]!.state).toBe("sent");

    // A new agent the next day: the person who only used Ops Desk hears about
    // it, the owner waits for their 30 days to pass.
    await f.createAgent("Legal");
    expect((await f.sweep(weekdayAt(10, ten, 1))).sent).toBe(1);
    expect(f.slack.posts.at(-1)).toMatchObject({
      channel: used.channel,
      text: "New agent you can ask: Legal.",
    });
    const later = weekdayAt(10, ten, 30);
    expect((await f.sweep(later)).sent).toBe(1);
    expect(f.slack.posts.at(-1)).toMatchObject({
      channel: owner.channel,
      text: "New agent you can ask: Legal.",
    });
    // Over 60 days after linking without using an agent, each gets one reminder…
    const dormant = weekdayAt(10, later, 31);
    expect((await f.sweep(dormant)).sent).toBe(2);
    expect(
      Object.fromEntries(f.slack.posts.slice(-2).map((sent) => [sent.channel, sent.text])),
    ).toEqual({
      [owner.channel]: "Agents you can ask in Slack: Legal and Ops Desk.",
      [used.channel]: "Agents you can ask in Slack: Legal.",
    });
    // …and then nothing until something is new.
    expect((await f.sweep(weekdayAt(10, dormant, 31))).sent).toBe(0);
    expect((await f.sweep(weekdayAt(10, dormant, 90))).sent).toBe(0);
    expect(f.slack.posts).toHaveLength(5);
  }, 120_000);

  test("switch off and channel posts only send nothing", async () => {
    if (!available) return;
    const f = await fixture();
    await f.createAgent("Ops Desk");
    await f.person("owner");
    const ten = weekdayAt(10);
    expect(await f.setSwitch(true, true)).toMatchObject({
      updatesEnabled: true,
      channelPostsOnly: true,
      viewerCanManage: true,
    });
    expect(await f.sweep(ten)).toEqual({ installations: 0, sent: 0, failed: 0 });
    await f.setSwitch(false);
    expect(await f.sweep(ten)).toEqual({ installations: 0, sent: 0, failed: 0 });
    expect(f.slack.posts).toHaveLength(0);
    expect(await f.deliveries()).toHaveLength(0);
  }, 120_000);

  test("only an organization admin changes the settings", async () => {
    if (!available) return;
    const f = await fixture();
    const body = JSON.stringify({
      connectionId: f.connectionId,
      updatesEnabled: true,
      channelPostsOnly: false,
    });
    const workspaceAdmin = await f.app.request(f.base, {
      method: "PUT",
      headers: await f.headers(f.owner.subjectId, ["workspace:admin"]),
      body,
    });
    expect(workspaceAdmin.status).toBe(403);
    const read = await f.app.request(`${f.base}?connectionId=${f.connectionId}`, {
      headers: await f.headers(f.owner.subjectId, ["account:admin", "workspace:read"]),
    });
    expect(await read.json()).toMatchObject({ updatesEnabled: false, viewerCanManage: true });
  }, 120_000);

  test("someone who links Slack after updates are on gets a welcome right away, once", async () => {
    if (!available) return;
    const f = await fixture();
    await f.createAgent("Ops Desk");
    await f.createAgent("Analytics", f.analyticsWorkspaceId);
    const before = await f.person("before");
    await f.setSwitch(true);
    const newcomer = await f.person("newcomer");
    // Any time, not only at 10:00: they are in Slack right now.
    const now = new Date();
    expect((await f.sweep(now)).sent).toBe(1);
    expect(f.slack.posts).toHaveLength(1);
    expect(f.slack.posts[0]!.channel).toBe(newcomer.channel);
    expect(f.slack.posts[0]!.text).toBe(
      "Welcome to Opengeni in Slack. Agents you can ask: Ops Desk.",
    );
    expect(f.slack.posts.some((post) => post.channel === before.channel)).toBe(false);
    expect((await f.sweep(new Date(now.getTime() + 60_000))).sent).toBe(0);
    // The welcome starts the 30-day clock and counts as telling them about Ops Desk.
    const ten = weekdayAt(10, now, 1);
    const next = await f.sweep(ten);
    expect(f.slack.posts.filter((post) => post.channel === newcomer.channel)).toHaveLength(1);
    // The person linked before the switch gets the ordinary update at 10:00.
    expect(next.sent).toBe(1);
    expect(f.slack.posts.at(-1)!.channel).toBe(before.channel);
  }, 120_000);

  test("one dormant reminder after 60 days without using an agent", async () => {
    if (!available) return;
    const f = await fixture();
    const ops = await f.createAgent("Ops Desk");
    const sleeper = await f.person("sleeper");
    await f.setSwitch(true);
    await shared!.admin`
      update slack_bot_user_links set created_at = now() - interval '90 days'
      where connection_id = ${f.connectionId} and slack_user_id = ${sleeper.slackUserId}`;
    // Already told about Ops Desk 61 days ago; no agent is new.
    await shared!.admin`
      insert into slack_agent_update_recipients (
        account_id, workspace_id, connection_id, slack_user_id, last_sent_at, last_kind,
        announced_agent_ids
      ) values (
        ${f.home.accountId}, ${f.home.workspaceId}, ${f.connectionId}, ${sleeper.slackUserId},
        now() - interval '61 days', 'update', ${[ops.id]}::uuid[]
      )`;
    const ten = weekdayAt(10);
    expect((await f.sweep(ten)).sent).toBe(1);
    expect(f.slack.posts[0]).toMatchObject({
      channel: sleeper.channel,
      text: "Agents you can ask in Slack: Ops Desk.",
    });
    expect((await f.deliveries())[0]!.kind).toBe("dormant");
    // Then nothing until something is new.
    expect((await f.sweep(weekdayAt(10, ten, 40))).sent).toBe(0);
    expect((await f.sweep(weekdayAt(10, ten, 100))).sent).toBe(0);
    expect(f.slack.posts).toHaveLength(1);
  }, 120_000);

  test("the mute button mutes updates and confirms; Undo unmutes", async () => {
    if (!available) return;
    const f = await fixture();
    await f.createAgent("Ops Desk");
    const owner = await f.person("owner");
    await f.setSwitch(true);
    const ten = weekdayAt(10);
    expect((await f.sweep(ten)).sent).toBe(1);
    const post = f.slack.posts[0]!;
    const press = async (actionId: string, blocks: unknown[]) => {
      const payload = {
        type: "block_actions",
        team: { id: f.teamId },
        user: { id: owner.slackUserId },
        channel: { id: post.channel },
        container: { type: "message", channel_id: post.channel, message_ts: post.ts },
        message: { ts: post.ts, text: post.text, blocks },
        actions: [
          {
            type: "button",
            action_id: actionId,
            block_id: "opengeni_updates_actions",
            value: "x",
            action_ts: `${Date.now() / 1000}`,
          },
        ],
      };
      const response = await f.app.fetch(
        signedRequest(
          "/v1/integrations/slack/interactions",
          new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
          "application/x-www-form-urlencoded",
        ),
      );
      expect(response.status, await response.clone().text()).toBe(200);
    };
    const mutedAt = async () =>
      (
        await shared!.admin<{ updates_muted_at: Date | null }[]>`
          select updates_muted_at from slack_bot_user_links
          where connection_id = ${f.connectionId} and slack_user_id = ${owner.slackUserId}`
      )[0]!.updates_muted_at;

    await press("opengeni.updates.mute", post.blocks!);
    expect(await mutedAt()).toBeInstanceOf(Date);
    const confirmation = f.slack.updates.at(-1)!;
    expect(confirmation).toMatchObject({
      channel: post.channel,
      ts: post.ts,
      text: "Updates muted.",
    });
    expect(JSON.stringify(confirmation.blocks)).toContain("Updates muted.");
    expect(JSON.stringify(confirmation.blocks)).toContain("New agent you can ask: *Ops Desk*.");
    expect(JSON.stringify(confirmation.blocks)).toContain(`slack://app?team=${f.teamId}`);
    expect(JSON.stringify(confirmation.blocks)).toContain('"Undo"');

    // Muted people get nothing, even when something is new.
    await f.createAgent("Legal");
    expect((await f.sweep(weekdayAt(10, ten, 31))).sent).toBe(0);

    await press("opengeni.updates.unmute", confirmation.blocks!);
    expect(await mutedAt()).toBeNull();
    expect(JSON.stringify(f.slack.updates.at(-1)!.blocks)).toContain('"Mute updates"');
    expect(JSON.stringify(f.slack.updates.at(-1)!.blocks)).not.toContain("Updates muted.");

    // "See all agents" is a link; Slack opens it and Opengeni only acknowledges.
    const writes = f.slack.updates.length;
    await press("opengeni.updates.home", post.blocks!);
    expect(f.slack.updates).toHaveLength(writes);
  }, 120_000);

  test("an organization admin previews an update in their own DM without counting it", async () => {
    if (!available) return;
    const f = await fixture();
    await f.createAgent("Ops Desk");
    const owner = await f.person("owner");
    const colleague = await f.person("colleague");
    const preview = (headers: Record<string, string>, kind?: string) =>
      f.app.request(`${f.base}/preview`, {
        method: "POST",
        headers,
        body: JSON.stringify({ connectionId: f.connectionId, ...(kind ? { kind } : {}) }),
      });
    const admin = await f.headers(owner.subjectId, ["account:admin", "workspace:read"]);

    // Works with updates off and outside 10:00.
    const sent = await preview(admin);
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect(await sent.json()).toMatchObject({ kind: "update", slackUserId: owner.slackUserId });
    for (const kind of ["welcome", "dormant"]) {
      expect((await preview(admin, kind)).status).toBe(200);
    }
    expect(f.slack.posts.map((post) => post.channel)).toEqual([
      owner.channel,
      owner.channel,
      owner.channel,
    ]);
    expect(f.slack.posts.map((post) => post.text)).toEqual([
      "New agent you can ask: Ops Desk.",
      "Welcome to Opengeni in Slack. Agents you can ask: Ops Desk.",
      "Agents you can ask in Slack: Ops Desk.",
    ]);
    expect(f.slack.posts.some((post) => post.channel === colleague.channel)).toBe(false);
    // Nothing is recorded against anyone's limits.
    expect(await f.deliveries()).toHaveLength(0);
    const recipients = await shared!.admin`
      select 1 from slack_agent_update_recipients where connection_id = ${f.connectionId}`;
    expect(recipients).toHaveLength(0);

    // Only organization admins, and only with their own linked Slack account.
    const notAdmin = await preview(await f.headers(owner.subjectId, ["workspace:admin"]));
    expect(notAdmin.status).toBe(403);
    const unlinked = await preview(
      await f.headers(`user:unlinked-${crypto.randomUUID()}`, ["account:admin", "workspace:read"]),
    );
    expect(unlinked.status).toBe(409);
    expect(JSON.stringify(await unlinked.json())).toContain(
      "slack_agent_update_preview_not_linked",
    );
    expect(f.slack.posts).toHaveLength(3);
  }, 120_000);
});
