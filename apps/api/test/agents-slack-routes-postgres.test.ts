// An agent's Slack availability through `/agents/:id/slack/:connectionId`
// (real PostgreSQL): workspace admins turn it on and off, only organization
// admins open it, Only me agents stay out of Slack, Slack name rules apply only
// when it is turned on, a clashing name never merges agents, and for now an
// agent is available in one Slack workspace.
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

const DELEGATION_SECRET = "agents-slack-routes-delegation-secret";
const encryptionKey = randomBytes(32).toString("base64");

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_agents_slack_routes");
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
  await client?.close().catch(() => undefined);
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

type Scope = { accountId: string; workspaceId: string };

async function bearer(scope: Scope, subjectId: string, permissions: Permission[]) {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    ...scope,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

async function call(auth: string, method: string, path: string, body?: unknown) {
  const response = await app().request(path, {
    method,
    headers: { "content-type": "application/json", authorization: auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function slackConnection(accountId: string, workspaceId: string, label: string) {
  const connection = await createConnection(client.db, {
    accountId,
    workspaceId,
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
  return connection.id;
}

/** A workspace with the Opengeni Slack app, and a member who is its admin. */
async function installation(label: string) {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`Agents Slack ${label}`}) returning id`;
  const accountId = account!.id;
  const workspace = async (name: string) => {
    const [row] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}, ${name}) returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id)
      values (${row!.id}, ${accountId})`;
    return row!.id;
  };
  const home = await workspace(`Home ${label}`);
  const personal = await workspace(`Personal ${label}`);
  const owner = `user:agents-slack-${label}`;
  await admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${accountId}, ${owner}, 'active', ${personal})`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${accountId}, ${home}, ${owner})`;
  const connectionId = await slackConnection(accountId, home, label);
  const scope = { accountId, workspaceId: home };
  return {
    accountId,
    home,
    owner,
    connectionId,
    scope,
    base: `/v1/workspaces/${home}/agents`,
    admin: await bearer(scope, owner, ["workspace:admin", "sessions:create", "sessions:read"]),
    orgAdmin: await bearer(scope, owner, [
      "workspace:admin",
      "account:admin",
      "sessions:create",
      "sessions:read",
    ]),
  };
}

describe("an agent's Slack availability (real PostgreSQL)", () => {
  test("turn on, open, turn off; the legacy Slack row follows", async () => {
    if (!available) return;
    const install = await installation(`on-${Date.now()}`);
    const created = await call(install.admin, "POST", install.base, {
      name: "Release desk",
      instructions: "Be brief.",
    });
    expect(created.status).toBe(201);
    const agent = created.json.agent;
    const slackPath = `${install.base}/${agent.id}/slack/${install.connectionId}`;

    // Offered, but not yet available.
    const before = await call(install.admin, "GET", `${install.base}/${agent.id}/slack`);
    expect(before.status).toBe(200);
    expect(before.json.installs).toEqual([
      expect.objectContaining({ connectionId: install.connectionId, availability: null }),
    ]);

    // A member without workspace admin cannot turn it on.
    const member = await bearer(install.scope, "user:agents-slack-member", [
      "sessions:create",
      "sessions:read",
    ]);
    expect((await call(member, "PUT", slackPath, {})).status).toBe(403);

    const on = await call(install.admin, "PUT", slackPath, {});
    expect(on.status).toBe(201);
    expect(on.json.availability).toMatchObject({
      connectionId: install.connectionId,
      handle: "release-desk",
      open: false,
    });
    const [legacy] = await shared!.admin<
      { workspace_id: string; target_workspace_id: string; instructions: string; open: boolean }[]
    >`select workspace_id, target_workspace_id, instructions, open from slack_agents where id = ${agent.id}`;
    expect(legacy).toEqual({
      workspace_id: install.home,
      target_workspace_id: install.home,
      instructions: "Be brief.",
      open: false,
    });

    // Only an organization admin opens it; nothing changes otherwise.
    const refused = await call(install.admin, "PUT", slackPath, {
      open: true,
      expectedVersion: on.json.availability.version,
    });
    expect(refused.status).toBe(403);
    const opened = await call(install.orgAdmin, "PUT", slackPath, {
      open: true,
      expectedVersion: on.json.availability.version,
    });
    expect(opened.status).toBe(200);
    expect(opened.json.availability.open).toBe(true);
    // A stale version is a conflict.
    const stale = await call(install.admin, "PUT", slackPath, {
      open: false,
      expectedVersion: on.json.availability.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details.code).toBe("agent_version_conflict");
    // Any workspace admin closes it again.
    const closed = await call(install.admin, "PUT", slackPath, {
      open: false,
      expectedVersion: opened.json.availability.version,
    });
    expect(closed.status).toBe(200);
    expect(closed.json.availability.open).toBe(false);

    // The old Slack agents list shows it too.
    const legacyList = await call(
      install.admin,
      "GET",
      `/v1/workspaces/${install.home}/integrations/slack/agents`,
    );
    expect(legacyList.json.agents.map((row: { id: string }) => row.id)).toContain(agent.id);

    // Off again: the agent stays, its legacy Slack row goes.
    const off = await call(install.admin, "DELETE", slackPath);
    expect(off.status).toBe(200);
    expect(off.json.availability).toBeNull();
    expect((await call(install.admin, "GET", `${install.base}/${agent.id}`)).status).toBe(200);
    expect(await shared!.admin`select 1 from slack_agents where id = ${agent.id}`).toHaveLength(0);
  }, 120_000);

  test("Only me agents, Slack name rules, clashing names and one installation", async () => {
    if (!available) return;
    const label = `rules-${Date.now()}`;
    const install = await installation(label);

    // Only me agents stay in the app.
    const mine = await call(install.admin, "POST", install.base, {
      name: "Private notes",
      visibility: "private",
    });
    expect(mine.status).toBe(201);
    const privateRefused = await call(
      install.admin,
      "PUT",
      `${install.base}/${mine.json.agent.id}/slack/${install.connectionId}`,
      {},
    );
    expect(privateRefused.status).toBe(409);
    expect(privateRefused.json.error.details.code).toBe(
      "agent_slack_requires_workspace_visibility",
    );

    // An app-only agent may have any name; Slack's rules apply when it is turned on.
    const unusual = await call(install.admin, "POST", install.base, { name: "!!!" });
    expect(unusual.status).toBe(201);
    const badName = await call(
      install.admin,
      "PUT",
      `${install.base}/${unusual.json.agent.id}/slack/${install.connectionId}`,
      {},
    );
    expect(badName.status).toBe(422);
    expect(badName.json.error.details.code).toBe("agent_slack_name_invalid");

    // The agent already in Slack keeps its name; the other one is refused, not merged.
    const first = await call(install.admin, "POST", install.base, { name: "Data team" });
    const second = await call(install.admin, "POST", install.base, { name: "Data Team" });
    expect(second.status).toBe(201);
    expect(
      (
        await call(
          install.admin,
          "PUT",
          `${install.base}/${first.json.agent.id}/slack/${install.connectionId}`,
          {},
        )
      ).status,
    ).toBe(201);
    const clash = await call(
      install.admin,
      "PUT",
      `${install.base}/${second.json.agent.id}/slack/${install.connectionId}`,
      {},
    );
    expect(clash.status).toBe(409);
    expect(clash.json.error.details.code).toBe("agent_slack_name_taken");
    expect(
      await shared!
        .admin`select id from agents where id in (${first.json.agent.id}, ${second.json.agent.id})`,
    ).toHaveLength(2);
    // Renamed, it can join; renaming it back onto the taken name is refused.
    const renamed = await call(install.admin, "PATCH", `${install.base}/${second.json.agent.id}`, {
      expectedVersion: second.json.agent.version,
      name: "Data helpers",
    });
    expect(renamed.status).toBe(200);
    const joined = await call(
      install.admin,
      "PUT",
      `${install.base}/${second.json.agent.id}/slack/${install.connectionId}`,
      {},
    );
    expect(joined.status).toBe(201);
    const back = await call(install.admin, "PATCH", `${install.base}/${second.json.agent.id}`, {
      expectedVersion: joined.json.agent.version,
      name: "DATA TEAM",
    });
    expect(back.status).toBe(409);
    expect(back.json.error.details.code).toBe("agent_slack_name_taken");
    // An agent in Slack stays shared: making it Only me waits until Slack is off.
    const hidden = await call(install.admin, "PATCH", `${install.base}/${second.json.agent.id}`, {
      expectedVersion: joined.json.agent.version,
      visibility: "private",
    });
    expect(hidden.status).toBe(409);
    expect(hidden.json.error.details.code).toBe("agent_slack_requires_workspace_visibility");
    expect(hidden.json.error.message).toContain("Turn Slack off first");
    const off = await call(
      install.admin,
      "DELETE",
      `${install.base}/${second.json.agent.id}/slack/${install.connectionId}`,
    );
    expect(off.status).toBe(200);
    const current = await call(install.admin, "GET", `${install.base}/${second.json.agent.id}`);
    const madePrivate = await call(
      install.admin,
      "PATCH",
      `${install.base}/${second.json.agent.id}`,
      { expectedVersion: current.json.agent.version, visibility: "private" },
    );
    expect(madePrivate.status).toBe(200);
    expect(madePrivate.json.agent.visibility).toBe("private");

    // For now, one Slack workspace per agent.
    const otherConnection = await slackConnection(install.accountId, install.home, `${label}-b`);
    const single = await call(
      install.admin,
      "PUT",
      `${install.base}/${first.json.agent.id}/slack/${otherConnection}`,
      {},
    );
    expect(single.status).toBe(409);
    expect(single.json.error.details).toMatchObject({
      code: "agent_slack_single_install",
      connectionId: install.connectionId,
    });
  }, 120_000);
});
