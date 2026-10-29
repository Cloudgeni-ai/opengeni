import { expect, test } from "bun:test";
import {
  resolveTeamsGroupAudience,
  sameTeamsAudience,
  teamsGroupMembershipChange,
} from "../src/integrations/teams-group";
import { normalizeTeamsMessage } from "../src/integrations/teams-protocol";
const tenant = "10000000-0000-4000-8000-000000000001";
const actor = "10000000-0000-4000-8000-000000000002";
const member = { id: "29:human", aadObjectId: actor, tenantId: tenant };
const resolve = async () => "user:one";
test("only complete same-tenant linked human rosters and exact own bot are accepted", async () => {
  expect(
    await resolveTeamsGroupAudience([member, { id: "28:own" }], tenant, "28:own", resolve),
  ).toEqual([{ actorId: actor, subjectId: "user:one" }]);
  for (const roster of [
    [],
    [member, member],
    [{ ...member, aadObjectId: undefined }],
    [{ ...member, tenantId: actor }],
    [{ ...member, role: "bot" }],
    [{ ...member, id: "28:other" }],
    [{ ...member, agenticUserId: actor }],
    [{ id: "28:other" }],
    Array.from({ length: 252 }, () => member),
  ])
    await expect(resolveTeamsGroupAudience(roster, tenant, "28:own", resolve)).rejects.toThrow();
  await expect(
    resolveTeamsGroupAudience([member], tenant, "28:own", async () => null),
  ).rejects.toThrow("teams_group_member_unlinked");
  expect(
    sameTeamsAudience(
      [{ actorId: actor, subjectId: "user:one" }],
      [{ actorId: actor, subjectId: "user:two" }],
    ),
  ).toBe(false);
});
test("group messages require mentions and use an unthreaded conversation distinct from DM routing", () => {
  const raw = {
    type: "message",
    id: "one",
    timestamp: "2026-10-28T10:00:00Z",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    from: { id: "29:human", aadObjectId: actor },
    recipient: { id: "28:own" },
    conversation: { id: "19:group", conversationType: "groupChat", tenantId: tenant },
    channelData: { tenant: { id: tenant } },
    replyToId: "reply",
    text: "<at>Opengeni</at> hello",
    entities: [{ type: "mention", mentioned: { id: "28:own" }, text: "<at>Opengeni</at>" }],
  };
  expect(normalizeTeamsMessage({ ...raw, entities: [] })).toBeNull();
  const m = normalizeTeamsMessage(raw)!;
  expect(m).toMatchObject({
    groupChat: true,
    personal: false,
    channelId: null,
    threadId: null,
    text: "hello",
  });
  expect(
    normalizeTeamsMessage({
      ...raw,
      conversation: { ...raw.conversation, conversationType: "personal" },
    })?.groupChat,
  ).toBe(false);
});

test("accepts a complete 250-person chat but never truncates an oversized roster", async () => {
  const roster = Array.from({ length: 250 }, (_, i) => ({
    id: `29:${i}`,
    aadObjectId: crypto.randomUUID(),
    tenantId: tenant,
  }));
  expect(
    await resolveTeamsGroupAudience(
      [...roster, { id: "28:own" }],
      tenant,
      "28:own",
      async (id) => `user:${id}`,
    ),
  ).toHaveLength(250);
  await expect(
    resolveTeamsGroupAudience(
      [...roster, { id: "29:extra", aadObjectId: crypto.randomUUID(), tenantId: tenant }],
      tenant,
      "28:own",
      resolve,
    ),
  ).rejects.toThrow();
});

test("membership revocations require the exact bot, tenant and group scope", () => {
  const event = {
    type: "conversationUpdate",
    channelId: "msteams",
    recipient: { id: "28:own" },
    conversation: { id: "19:group", conversationType: "groupChat", tenantId: tenant },
    channelData: { tenant: { id: tenant } },
    membersAdded: [{ id: "29:person" }],
  };
  expect(teamsGroupMembershipChange(event, "28:own")).toEqual({
    tenantId: tenant,
    conversationId: "19:group",
  });
  expect(
    teamsGroupMembershipChange({ ...event, membersAdded: [], membersRemoved: [{}] }, "28:own"),
  ).not.toBeNull();
  for (const value of [
    { ...event, recipient: { id: "28:other" } },
    { ...event, conversation: { ...event.conversation, conversationType: "personal" } },
    { ...event, conversation: { ...event.conversation, tenantId: actor } },
    { ...event, membersAdded: [] },
  ])
    expect(teamsGroupMembershipChange(value, "28:own")).toBeNull();
});
