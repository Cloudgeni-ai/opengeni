// The admin surface for Slack agents. Admins of the workspace an agent works in
// create, edit and delete it; anyone in the organization can list it; the
// Opengeni Slack app must be available in that workspace first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import { createConnection, createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { slackAgentIntroText } from "../src/routes/slack-agents";

const DELEGATION_SECRET = "slack-agents-admin-delegation-secret";
const encryptionKey = randomBytes(32).toString("base64");

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_slack_agents_admin");
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

async function headers(
  scope: { accountId: string; workspaceId: string },
  subjectId: string,
  permissions: Permission[],
) {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function installation(label: string) {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`Slack agents ${label}`}) returning id`;
  const make = async (name: string) => {
    const [workspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
    await shared!.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    return workspace!.id;
  };
  const home = await make(`Home ${label}`);
  const other = await make("Analytics");
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
      botDisplayName: "Opengeni",
      verifiedAt: new Date().toISOString(),
    },
  });
  return { accountId: account!.id, home, other, connectionId: connection.id };
}

const avatar = { kind: "emoji", emoji: "📊", hue: 210 } as const;

describe("Slack agents administration", () => {
  test("an admin creates, lists, edits and deletes an agent", async () => {
    if (!available) return;
    const install = await installation(`crud-${Date.now()}`);
    const scope = { accountId: install.accountId, workspaceId: install.home };
    const admin = await headers(scope, "user:slack-agents-admin", ["workspace:admin"]);
    const base = `/v1/workspaces/${install.home}/integrations/slack/agents`;

    const empty = await app().request(base, { headers: admin });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      agents: [],
      routingEnabled: true,
      memoryReviewFirst: false,
    });

    const created = await app().request(base, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        connectionId: install.connectionId,
        name: "Ops Desk",
        description: "Handles incidents.",
        avatar,
        instructions: "Be brief.",
      }),
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as {
      agent: {
        id: string;
        handle: string;
        version: number;
        viewerCanManage: boolean;
        open: boolean;
        knowledgeCollectionId: string | null;
      };
    };
    expect(agent).toMatchObject({ handle: "ops-desk", viewerCanManage: true, open: false });
    // Its Memory is a Knowledge collection named after it, created with it.
    expect(agent.knowledgeCollectionId).toBeString();
    const [memory] = await shared!.admin<
      { scope: string; scope_workspace_id: string; published: boolean }[]
    >`select scope, scope_workspace_id, published_revision_id is not null as published
      from knowledge_entries where id = ${agent.knowledgeCollectionId}`;
    expect(memory).toEqual({
      scope: "workspace",
      scope_workspace_id: install.home,
      published: true,
    });

    // Names are unique per installation, ignoring case, spaces and hyphens.
    const taken = await app().request(base, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        connectionId: install.connectionId,
        name: "ops-desk",
        description: "Duplicate.",
        avatar,
      }),
    });
    expect(taken.status).toBe(409);
    expect(JSON.stringify(await taken.json())).toContain("slack_agent_name_taken");

    // Reserved words already mean something in Slack.
    const reserved = await app().request(base, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        connectionId: install.connectionId,
        name: "Help",
        description: "Reserved.",
        avatar,
      }),
    });
    expect(reserved.status).toBe(400);

    const patched = await app().request(`${base}/${agent.id}`, {
      method: "PATCH",
      headers: admin,
      body: JSON.stringify({ expectedVersion: agent.version, description: "Runs incidents." }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { agent: { description: string } }).agent.description).toBe(
      "Runs incidents.",
    );

    const stale = await app().request(`${base}/${agent.id}`, {
      method: "PATCH",
      headers: admin,
      body: JSON.stringify({ expectedVersion: agent.version, description: "Stale." }),
    });
    expect(stale.status).toBe(409);

    // Members of the organization see the list but cannot manage it.
    const reader = await headers(scope, "user:slack-agents-reader", ["workspace:read"]);
    const listed = await app().request(base, { headers: reader });
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as {
      agents: Array<{ name: string; viewerCanManage: boolean; targetWorkspaceName: string }>;
    };
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0]).toMatchObject({ name: "Ops Desk", viewerCanManage: false });
    // Someone elsewhere in the organization sees the directory, not the
    // instructions or Memory of an agent whose workspace they cannot read.
    const outsider = await headers(
      { accountId: install.accountId, workspaceId: install.other },
      "user:slack-agents-outsider",
      ["workspace:read"],
    );
    const outside = await app().request(
      `/v1/workspaces/${install.other}/integrations/slack/agents`,
      { headers: outsider },
    );
    expect(outside.status).toBe(200);
    const [seen] = ((await outside.json()) as { agents: Array<Record<string, unknown>> }).agents;
    expect(seen).toMatchObject({
      name: "Ops Desk",
      description: "Runs incidents.",
      instructions: null,
      knowledgeCollectionId: null,
      createdBySubjectId: null,
      viewerCanManage: false,
    });
    const notAdmin = await app().request(base, {
      method: "POST",
      headers: reader,
      body: JSON.stringify({
        connectionId: install.connectionId,
        name: "Second",
        description: "Not allowed.",
        avatar,
      }),
    });
    expect(notAdmin.status).toBe(403);
    const denied = await app().request(`${base}/${agent.id}`, {
      method: "DELETE",
      headers: reader,
    });
    expect(denied.status).toBe(403);

    const deleted = await app().request(`${base}/${agent.id}`, {
      method: "DELETE",
      headers: admin,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    const after = await app().request(base, { headers: admin });
    expect(((await after.json()) as { agents: unknown[] }).agents).toEqual([]);
  }, 90_000);

  test("creating an agent in a workspace without the Slack app is refused", async () => {
    if (!available) return;
    const install = await installation(`unavailable-${Date.now()}`);
    const admin = await headers(
      { accountId: install.accountId, workspaceId: install.other },
      "user:slack-agents-other-admin",
      ["workspace:admin"],
    );
    const response = await app().request(
      `/v1/workspaces/${install.other}/integrations/slack/agents`,
      {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          connectionId: install.connectionId,
          name: "Analytics",
          description: "Answers revenue questions.",
          avatar,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain("slack_bot_unavailable");
  }, 90_000);

  test("the intro names the agent and how to call it", () => {
    expect(
      slackAgentIntroText({ name: "Data Team", description: "Answers revenue questions." }, "UBOT"),
    ).toBe("Hi, I'm *Data Team*. Answers revenue questions.\nAsk me with <@UBOT> +data-team");
  });

  test("only an organization admin opens an agent to anyone in Slack", async () => {
    if (!available) return;
    const install = await installation(`open-${Date.now()}`);
    const scope = { accountId: install.accountId, workspaceId: install.home };
    const workspaceAdmin = await headers(scope, "user:slack-agents-ws-admin", ["workspace:admin"]);
    const organizationAdmin = await headers(scope, "user:slack-agents-org-admin", [
      "workspace:admin",
      "account:admin",
    ]);
    const base = `/v1/workspaces/${install.home}/integrations/slack/agents`;
    const created = await app().request(base, {
      method: "POST",
      headers: workspaceAdmin,
      body: JSON.stringify({
        connectionId: install.connectionId,
        name: "Front Desk",
        description: "Answers anyone.",
        avatar,
      }),
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as {
      agent: { id: string; version: number; open: boolean };
    };
    // Off by default.
    expect(agent.open).toBe(false);
    const setOpen = (as: Record<string, string>, version: number, open: boolean) =>
      app().request(`${base}/${agent.id}`, {
        method: "PATCH",
        headers: as,
        body: JSON.stringify({ expectedVersion: version, open }),
      });

    // A workspace admin cannot turn it on, and nothing changes.
    const refused = await setOpen(workspaceAdmin, agent.version, true);
    expect(refused.status).toBe(403);
    const [unchanged] = await shared!.admin<{ open: boolean; version: number }[]>`
      select open, version from slack_agents where id = ${agent.id}`;
    expect(unchanged).toEqual({ open: false, version: agent.version });

    // An organization admin can.
    const opened = await setOpen(organizationAdmin, agent.version, true);
    expect(opened.status).toBe(200);
    const openAgent = ((await opened.json()) as { agent: { open: boolean; version: number } })
      .agent;
    expect(openAgent.open).toBe(true);

    // Any admin of its workspace can close it again.
    const closed = await setOpen(workspaceAdmin, openAgent.version, false);
    expect(closed.status).toBe(200);
    expect(((await closed.json()) as { agent: { open: boolean } }).agent.open).toBe(false);
  }, 90_000);
});
