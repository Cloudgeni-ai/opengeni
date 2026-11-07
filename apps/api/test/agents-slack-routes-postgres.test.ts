// An agent's Slack availability through `/agents/:id/slack/:connectionId`
// (real PostgreSQL): workspace admins turn it on and off, only organization
// admins open it, Only me agents stay out of Slack, Slack name rules apply only
// when it is turned on, a clashing name never merges agents, an agent can be
// in several Slack workspaces, and the legacy Slack agents routes then act on
// the installation the caller names.
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
  test("turn on, open, turn off; the installation row follows", async () => {
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
    const [saved] = await shared!.admin<
      { workspace_id: string; install_workspace_id: string; open: boolean }[]
    >`select workspace_id, install_workspace_id, open from agent_slack_installs
      where agent_id = ${agent.id}`;
    expect(saved).toEqual({
      workspace_id: install.home,
      install_workspace_id: install.home,
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

    // Off again: the agent stays, its installation row goes.
    const off = await call(install.admin, "DELETE", slackPath);
    expect(off.status).toBe(200);
    expect(off.json.availability).toBeNull();
    expect((await call(install.admin, "GET", `${install.base}/${agent.id}`)).status).toBe(200);
    expect(
      await shared!.admin`select 1 from agent_slack_installs where agent_id = ${agent.id}`,
    ).toHaveLength(0);
  }, 120_000);

  test("Only me agents, Slack name rules, clashing names and several installations", async () => {
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

    // An agent can be in several Slack workspaces at once.
    const otherConnection = await slackConnection(install.accountId, install.home, `${label}-b`);
    const second_install = await call(
      install.admin,
      "PUT",
      `${install.base}/${first.json.agent.id}/slack/${otherConnection}`,
      {},
    );
    expect(second_install.status).toBe(201);
    const installs = await shared!
      .admin`select connection_id from agent_slack_installs where agent_id = ${first.json.agent.id}
        order by connection_id`;
    expect(installs.map((row: { connection_id: string }) => row.connection_id).sort()).toEqual(
      [install.connectionId, otherConnection].sort(),
    );
  }, 120_000);

  test("legacy Slack agents routes name the installation of an agent in two", async () => {
    if (!available) return;
    const label = `legacy-${randomBytes(4).toString("hex")}`;
    const install = await installation(label);
    const auth = await bearer(install.scope, install.owner, [
      "workspace:read",
      "workspace:admin",
      "account:admin",
      "sessions:create",
      "sessions:read",
    ]);
    const created = await call(auth, "POST", install.base, {
      name: "Two Homes",
      description: "In two Slack workspaces.",
      visibility: "workspace",
    });
    expect(created.status).toBe(201);
    const agentId = created.json.agent.id as string;
    const other = await slackConnection(install.accountId, install.home, `${label}-b`);
    for (const connectionId of [install.connectionId, other]) {
      const on = await call(auth, "PUT", `${install.base}/${agentId}/slack/${connectionId}`, {});
      expect(on.status).toBe(201);
    }
    const legacy = `/v1/workspaces/${install.home}/integrations/slack/agents`;
    const listed = await call(auth, "GET", legacy);
    expect(listed.status).toBe(200);
    const records = (
      listed.json.agents as { id: string; connectionId: string; version: number }[]
    ).filter((agent) => agent.id === agentId);
    expect(records.map((agent) => agent.connectionId).sort()).toEqual(
      [install.connectionId, other].sort(),
    );
    const version = records[0]!.version;
    const item = `${legacy}/${agentId}`;
    const openRows = async () =>
      (
        await shared!.admin<{ connection_id: string; open: boolean }[]>`
          select connection_id, open from agent_slack_installs where agent_id = ${agentId}`
      ).reduce<Record<string, boolean>>(
        (all, row) => ({ ...all, [row.connection_id]: row.open }),
        {},
      );

    // Open, delete, channels and intro belong to one installation.
    for (const [method, path, body] of [
      ["PATCH", item, { expectedVersion: version, open: true }],
      ["DELETE", item, undefined],
      ["GET", `${item}/channels`, undefined],
      ["POST", `${item}/intro`, { channelIds: ["C1"] }],
    ] as const) {
      const refused = await call(auth, method, path, body);
      expect(refused.status).toBe(409);
      expect(refused.json.error.details.code).toBe("slack_agent_installation_required");
      expect([...refused.json.error.details.connectionIds].sort()).toEqual(
        [install.connectionId, other].sort(),
      );
    }

    // Agent-level edits need no installation.
    const renamed = await call(auth, "PATCH", item, {
      expectedVersion: version,
      description: "Still in two Slack workspaces.",
    });
    expect(renamed.status).toBe(200);

    // Opening it in the second installation leaves the first as it was.
    const opened = await call(auth, "PATCH", `${item}?connectionId=${other}`, {
      expectedVersion: renamed.json.agent.version,
      open: true,
    });
    expect(opened.status).toBe(200);
    expect(opened.json.agent.connectionId).toBe(other);
    expect(opened.json.agent.open).toBe(true);
    expect(await openRows()).toEqual({ [install.connectionId]: false, [other]: true });

    // Deleting it from one installation keeps the agent in the other; the
    // last installation deletes the agent, as a Slack agent delete always did.
    const left = await call(auth, "DELETE", `${item}?connectionId=${other}`);
    expect(left).toEqual({ status: 200, json: { deleted: true } });
    expect(await openRows()).toEqual({ [install.connectionId]: false });
    expect((await call(auth, "GET", `${install.base}/${agentId}`)).status).toBe(200);
    const gone = await call(auth, "DELETE", item);
    expect(gone).toEqual({ status: 200, json: { deleted: true } });
    expect((await call(auth, "GET", `${install.base}/${agentId}`)).status).toBe(404);

    // Deleting its last two installations at once still deletes the agent.
    const twice = await call(auth, "POST", install.base, {
      name: "Two Deletes",
      description: "Deleted from both at once.",
    });
    expect(twice.status).toBe(201);
    const twiceId = twice.json.agent.id as string;
    for (const connectionId of [install.connectionId, other]) {
      const on = await call(auth, "PUT", `${install.base}/${twiceId}/slack/${connectionId}`, {});
      expect(on.status).toBe(201);
    }
    const both = await Promise.all(
      [install.connectionId, other].map((connectionId) =>
        call(auth, "DELETE", `${legacy}/${twiceId}?connectionId=${connectionId}`),
      ),
    );
    expect(both.map((result) => result.status)).toEqual([200, 200]);
    expect((await call(auth, "GET", `${install.base}/${twiceId}`)).status).toBe(404);
    expect((await call(auth, "DELETE", `${legacy}/${twiceId}?connectionId=bad`)).status).toBe(400);
  }, 120_000);

  test("a backfilled bot template (long First message, no Instructions, description or avatar) turns on in Slack", async () => {
    if (!available) return;
    const install = await installation(`template-${Date.now()}`);
    // As 1243's backfill writes a bot template: an agent whose First message
    // is the template text and whose Instructions are empty.
    const firstMessage = `Set up the weekly report. ${"Step. ".repeat(2_450)}`.trim();
    expect(firstMessage.length).toBeGreaterThan(14_000);
    const id = crypto.randomUUID();
    await shared!.admin.begin(async (sql) => {
      await sql`insert into agents (id, account_id, workspace_id, visibility, name, name_key,
          description, avatar, memory_enabled, current_revision, origin, created_by_subject_id)
        values (${id}, ${install.accountId}, ${install.home}, 'workspace', 'Weekly report',
          'weekly report', '', null, false, 1, 'bot_template', ${install.owner})`;
      await sql`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
          description, instructions, first_message, created_by_subject_id)
        values (${id}, ${install.accountId}, ${install.home}, 1, 'Weekly report', '', '',
          ${firstMessage}, ${install.owner})`;
    });
    const before = await call(install.admin, "GET", `${install.base}/${id}`);
    expect(before.status).toBe(200);
    expect(before.json.agent).toMatchObject({
      instructions: "",
      firstMessage,
      description: "",
      avatar: null,
    });

    const on = await call(
      install.admin,
      "PUT",
      `${install.base}/${id}/slack/${install.connectionId}`,
      {},
    );
    expect(on.status).toBe(201);
    const installs = await shared!.admin<{ connectionId: string }[]>`
      select connection_id as "connectionId" from agent_slack_installs where agent_id = ${id}`;
    expect(installs).toEqual([{ connectionId: install.connectionId }]);
    const after = await call(install.admin, "GET", `${install.base}/${id}`);
    expect(after.status).toBe(200);
    expect(after.json.agent).toMatchObject({ instructions: "", firstMessage, description: "" });
  }, 120_000);
});
