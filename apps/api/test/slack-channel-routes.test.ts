// The admin surface for per-channel Slack workspace routing. The interesting
// part is not the CRUD but the two refusals: an admin may only point a channel
// at a workspace they could start work in themselves, and the batch must not
// apply half of itself before discovering that.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import { createConnection, createDb, grantWorkspaceAccess, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "slack-channel-routes-delegation-secret";
const encryptionKey = randomBytes(32).toString("base64");

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_slack_channel_routes");
  if (!shared) {
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: encryptionKey,
    slackWorkspaceRoutingEnabled: true,
  }) as Settings;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

function app() {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
}

async function bearer(
  scope: { accountId: string; workspaceId: string },
  subjectId: string,
  permissions: Permission[],
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

async function installation(label: string) {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`Slack routes ${label}`}) returning id`;
  const make = async (name: string) => {
    const [workspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
    await shared!.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    return workspace!.id;
  };
  const home = await make(`Home ${label}`);
  const routed = await make("Platform");
  const connection = await createConnection(client.db, {
    accountId: account!.id,
    workspaceId: home,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    credentialEncrypted: `fixture-${label}`,
    grantedScopes: ["chat:write"],
    verifiedInstallAt: new Date(),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: `T_${label}`,
      slackTeamName: `Slack ${label}`,
      botId: `B_${label}`,
      botUserId: `UB_${label}`,
      botDisplayName: "OpenGeni",
      verifiedAt: new Date().toISOString(),
    },
  });
  return { accountId: account!.id, home, routed, connectionId: connection.id };
}

describe("Slack channel routing administration", () => {
  test("lists, sets and clears a route, and refuses one the admin cannot reach", async () => {
    if (!available) return;
    const install = await installation(`admin-${Date.now()}`);
    const scope = { accountId: install.accountId, workspaceId: install.home };
    const adminSubject = "user:slack-routes-admin";
    // The admin must be able to start work in the target, or the route is
    // refused. Membership in the home workspace alone is not enough.
    await grantWorkspaceAccess(client.db, {
      accountId: install.accountId,
      workspaceId: install.routed,
      subjectId: adminSubject,
      permissions: ["sessions:create", "sessions:read"],
    });
    const admin = {
      "content-type": "application/json",
      authorization: await bearer(scope, adminSubject, ["workspace:admin", "sessions:create"]),
    };
    const base = `/v1/workspaces/${install.home}/integrations/slack/channel-routes`;

    const empty = await app().request(`${base}?connectionId=${install.connectionId}`, {
      headers: admin,
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ routes: [], routingEnabled: true });

    expect(
      (
        await app().request(base, {
          method: "PUT",
          headers: admin,
          body: JSON.stringify({
            connectionId: install.connectionId,
            routes: [{ slackChannelId: "C_ADMIN", targetWorkspaceId: install.routed }],
          }),
        })
      ).status,
    ).toBe(200);
    const listed = (await (
      await app().request(`${base}?connectionId=${install.connectionId}`, { headers: admin })
    ).json()) as { routes: Array<{ slackChannelId: string; source: string }> };
    expect(listed.routes).toEqual([
      expect.objectContaining({ slackChannelId: "C_ADMIN", source: "admin" }),
    ]);

    // A workspace the admin cannot start work in is refused, and the refusal
    // names the channel rather than leaving them to guess which one.
    const [unreachable] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${install.accountId}, 'Unreachable') returning id`;
    const refused = await app().request(base, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({
        connectionId: install.connectionId,
        routes: [
          { slackChannelId: "C_OK", targetWorkspaceId: install.routed },
          { slackChannelId: "C_FORBIDDEN", targetWorkspaceId: unreachable!.id },
        ],
      }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("C_FORBIDDEN");
    // Refused BEFORE writing: the legal half of the same batch did not land.
    const afterRefusal = (await (
      await app().request(`${base}?connectionId=${install.connectionId}`, { headers: admin })
    ).json()) as { routes: Array<{ slackChannelId: string }> };
    expect(afterRefusal.routes.map((route) => route.slackChannelId)).toEqual(["C_ADMIN"]);

    // A channel may not be pointed at the admin's own personal workspace, even
    // though they can obviously start work in it. Routing a shared channel
    // there would put every message in it somewhere nobody else in the channel
    // can see, so this is a 422 rather than the 403 above: the objection is to
    // the destination, not to their access.
    const [personal] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${install.accountId}, 'Personal') returning id`;
    await shared!.admin`
      insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
      values (${install.accountId}, ${adminSubject}, 'member', 'active', ${personal!.id})
      on conflict (account_id, subject_id) do update
        set status = 'active', personal_workspace_id = excluded.personal_workspace_id`;
    const personalRefusal = await app().request(base, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({
        connectionId: install.connectionId,
        routes: [{ slackChannelId: "C_PERSONAL", targetWorkspaceId: personal!.id }],
      }),
    });
    expect(personalRefusal.status).toBe(422);
    expect(await personalRefusal.text()).toContain("personal workspace");
    const afterPersonal = (await (
      await app().request(`${base}?connectionId=${install.connectionId}`, { headers: admin })
    ).json()) as { routes: Array<{ slackChannelId: string }> };
    expect(afterPersonal.routes.map((route) => route.slackChannelId)).toEqual(["C_ADMIN"]);

    // A null target clears the route, putting the channel back to asking.
    expect(
      (
        await app().request(base, {
          method: "PUT",
          headers: admin,
          body: JSON.stringify({
            connectionId: install.connectionId,
            routes: [{ slackChannelId: "C_ADMIN", targetWorkspaceId: null }],
          }),
        })
      ).status,
    ).toBe(200);
    const cleared = (await (
      await app().request(`${base}?connectionId=${install.connectionId}`, { headers: admin })
    ).json()) as { routes: unknown[] };
    expect(cleared.routes).toEqual([]);
  }, 180_000);

  test("refuses a reader, and a connection that is not this installation's", async () => {
    if (!available) return;
    const install = await installation(`gates-${Date.now()}`);
    const scope = { accountId: install.accountId, workspaceId: install.home };
    const base = `/v1/workspaces/${install.home}/integrations/slack/channel-routes`;
    const reader = {
      "content-type": "application/json",
      authorization: await bearer(scope, "user:slack-routes-reader", ["sessions:read"]),
    };
    expect(
      (await app().request(`${base}?connectionId=${install.connectionId}`, { headers: reader }))
        .status,
    ).toBe(403);
    expect(
      (
        await app().request(base, {
          method: "PUT",
          headers: reader,
          body: JSON.stringify({ connectionId: install.connectionId, routes: [] }),
        })
      ).status,
    ).toBe(403);

    const other = await installation(`other-${Date.now()}`);
    const admin = {
      "content-type": "application/json",
      authorization: await bearer(scope, "user:slack-routes-admin2", ["workspace:admin"]),
    };
    // Another installation's connection is not this workspace's to route.
    expect(
      (
        await app().request(base, {
          method: "PUT",
          headers: admin,
          body: JSON.stringify({
            connectionId: other.connectionId,
            routes: [{ slackChannelId: "C_X", targetWorkspaceId: install.routed }],
          }),
        })
      ).status,
    ).toBe(404);
  }, 180_000);
});
