import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import {
  claimTeamsRoute,
  createDb,
  enqueueTeamsMessage,
  installTeamsBot,
  PERSONAL_WORKSPACE_EXTERNAL_SOURCE,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { authorizeTeamsConversationAdmission } from "../src/application/teams-private-session";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const value = await acquireSharedTestDatabase("teams-organization-agent-admission");
  if (!value) throw new Error("Real PostgreSQL required");
  shared = value;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

/**
 * A linked person in "Home" asking two agents of "Finance", which they
 * aren't a member of, that anyone in the organization may use: one queued
 * message on an organization-agent route and one on an ordinary route.
 */
async function fixture() {
  const accountId = crypto.randomUUID(),
    home = crypto.randomUUID(),
    finance = crypto.randomUUID(),
    personal = crypto.randomUUID(),
    tenantId = crypto.randomUUID(),
    actorId = crypto.randomUUID(),
    subjectId = `user:${crypto.randomUUID()}`,
    auditor = crypto.randomUUID(),
    other = crypto.randomUUID();
  await shared.admin`insert into managed_accounts(id,name) values(${accountId},'Teams org agents')`;
  await shared.admin`insert into workspaces(id,account_id,name) values
    (${home},${accountId},'Home'),(${finance},${accountId},'Finance')`;
  await shared.admin`insert into workspaces(id,account_id,name,external_source,external_id)
    values(${personal},${accountId},'Personal',${PERSONAL_WORKSPACE_EXTERNAL_SOURCE},${`${accountId}:${subjectId}`})`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${accountId},${subjectId},'member','active',${personal})`;
  await shared.admin`insert into agents(id,account_id,workspace_id,visibility,name,name_key,origin,organization_access)
    values(${auditor},${accountId},${finance},'workspace','Auditor','auditor','app',true),
          (${other},${accountId},${finance},'workspace','Other','other','app',true)`;
  const i = await installTeamsBot(client.db, {
    accountId,
    workspaceId: home,
    tenantId,
    actorId,
    subjectId,
    nonce: crypto.randomUUID(),
  });
  const queue = async (routeId: string, text: string) => {
    const eventId = `event:${crypto.randomUUID()}`;
    await enqueueTeamsMessage(client.db, i, {
      routeId,
      actorId,
      subjectId,
      personal: true,
      sessionWorkspaceId: finance,
      agentId: auditor,
      authorizeSessionWorkspace: async () => true,
      channelId: null,
      conversationId: `a:${actorId}`,
      threadId: null,
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      botId: "28:test",
      eventId,
      payload: { text },
    });
    return eventId;
  };
  const organizationRoute = `teams-agent:${"a".repeat(64)}`;
  const memberRoute = `route:${crypto.randomUUID()}`;
  const events = new Map([
    [organizationRoute, await queue(organizationRoute, "check the books")],
    [memberRoute, await queue(memberRoute, "check the books")],
  ]);
  const claims = new Map<string, { leaseToken: string; sessionId: string }>();
  for (let n = 0; n < 2; n += 1) {
    const r = await claimTeamsRoute(client.db, i);
    if (r) claims.set(r.route_id, { leaseToken: r.lease_token!, sessionId: r.session_id });
  }
  const agentGrant = (agentId: string): AccessGrant => ({
    accountId,
    workspaceId: finance,
    subjectId: `teams-agent:${agentId}`,
    subjectLabel: "Agent",
    permissions: ["sessions:create", "sessions:read"],
    permissionMode: "explicit",
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: `teams-agent:${agentId}`, label: "Agent" },
    serviceInitiatorContext: { teamsAgentId: agentId, opengeniSubjectId: subjectId },
  });
  const personGrant: AccessGrant = {
    accountId,
    workspaceId: finance,
    subjectId,
    subjectLabel: "Person",
    permissions: ["sessions:create", "sessions:read"],
    permissionMode: "explicit",
  } as AccessGrant;
  const admit = (grant: AccessGrant, routeId: string) =>
    authorizeTeamsConversationAdmission(
      {
        db: client.db,
        settings: testSettings({
          teamsWorkspaceRoutingEnabled: true,
          teamsBotAllowedTenantIds: [tenantId],
        }),
      },
      grant,
      {
        workspaceId: finance,
        sessionId: claims.get(routeId)!.sessionId,
        creating: true,
        personal: true,
        initialMessage: "check the books",
        proof: {
          routeId,
          eventId: events.get(routeId)!,
          leaseToken: claims.get(routeId)!.leaseToken,
          installationGeneration: i.generation,
        },
      },
    );
  return {
    accountId,
    subjectId,
    auditor,
    other,
    organizationRoute,
    memberRoute,
    agentGrant,
    personGrant,
    admit,
  };
}

test("an organization agent's route admits only that agent's grant, while it is open and the asker a member", async () => {
  const f = await fixture();
  // The agent's own grant on its route is admitted.
  await f.admit(f.agentGrant(f.auditor), f.organizationRoute);
  // Never the person's own grant, another agent's, or the agent's on an ordinary route.
  await expect(f.admit(f.personGrant, f.organizationRoute)).rejects.toThrow(
    "teams_actor_access_revoked",
  );
  await expect(f.admit(f.agentGrant(f.other), f.organizationRoute)).rejects.toThrow(
    "teams_actor_access_revoked",
  );
  await expect(f.admit(f.agentGrant(f.auditor), f.memberRoute)).rejects.toThrow(
    "teams_actor_access_revoked",
  );
  // Closed to the organization, or the asker no longer an active member: refused.
  await shared.admin`update agents set organization_access=false where id=${f.auditor}`;
  await expect(f.admit(f.agentGrant(f.auditor), f.organizationRoute)).rejects.toThrow(
    "teams_actor_access_revoked",
  );
  await shared.admin`update agents set organization_access=true where id=${f.auditor}`;
  await f.admit(f.agentGrant(f.auditor), f.organizationRoute);
  await shared.admin`update organization_memberships set status='suspended' where account_id=${f.accountId} and subject_id=${f.subjectId}`;
  await expect(f.admit(f.agentGrant(f.auditor), f.organizationRoute)).rejects.toThrow(
    "teams_actor_access_revoked",
  );
});
