// An agent's Slack availability (real PostgreSQL): a shared agent is
// available in every Slack workspace linked to its workspace as soon as it
// exists, with nothing to turn on or off; only organization admins open it;
// making it Only me takes it out of Slack; the Slack name rules and clashes
// are refused when a shared agent is created, renamed or shared; older agents
// catch up when Slack reads its agents; and for now an agent is available in
// one Slack workspace.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  AGENT_FIRST_MESSAGE_LEAD,
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import { createConnection, createDb, type DbClient } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { loadSlackAgentsForConnection } from "../src/integrations/slack-agents";

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

/**
 * A workspace with the Opengeni Slack app, and a member who is its admin.
 * With `linkLater`, the Slack app is linked only when `link()` is called.
 */
async function installation(label: string, options: { linkLater?: boolean } = {}) {
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
  const link = () => slackConnection(accountId, home, label);
  const connectionId = options.linkLater ? "" : await link();
  const scope = { accountId, workspaceId: home };
  return {
    accountId,
    home,
    owner,
    connectionId,
    link,
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
  test("a new shared agent is in Slack at once; open use; nothing to turn off; Only me leaves Slack", async () => {
    if (!available) return;
    const install = await installation(`on-${Date.now()}`);
    const member = await bearer(install.scope, "user:agents-slack-member", [
      "sessions:create",
      "sessions:read",
    ]);
    const created = await call(install.admin, "POST", install.base, {
      name: "Release desk",
      instructions: "Be brief.",
    });
    expect(created.status).toBe(201);
    const agent = created.json.agent;
    expect(agent.slack).toEqual([
      expect.objectContaining({ connectionId: install.connectionId, handle: "release-desk" }),
    ]);
    const slackPath = `${install.base}/${agent.id}/slack/${install.connectionId}`;

    const listed = await call(install.admin, "GET", `${install.base}/${agent.id}/slack`);
    expect(listed.status).toBe(200);
    expect(listed.json.installs).toEqual([
      expect.objectContaining({
        connectionId: install.connectionId,
        availability: expect.objectContaining({ handle: "release-desk", open: false }),
        unavailable: null,
      }),
    ]);
    const [legacy] = await shared!.admin<
      { workspace_id: string; target_workspace_id: string; instructions: string; open: boolean }[]
    >`select workspace_id, target_workspace_id, instructions, open from slack_agents where id = ${agent.id}`;
    expect(legacy).toEqual({
      workspace_id: install.home,
      target_workspace_id: install.home,
      instructions: "Be brief.",
      open: false,
    });
    // The version the create returned is current: Slack moved it before the reply.
    const edited = await call(install.admin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: agent.version,
      description: "Answers release questions",
    });
    expect(edited.status).toBe(200);

    // Only an organization admin opens it; nothing changes otherwise.
    const availability = listed.json.installs[0].availability;
    expect((await call(member, "PUT", slackPath, { open: true })).status).toBe(403);
    const refused = await call(install.admin, "PUT", slackPath, {
      open: true,
      expectedVersion: availability.version,
    });
    expect(refused.status).toBe(403);
    const opened = await call(install.orgAdmin, "PUT", slackPath, {
      open: true,
      expectedVersion: availability.version,
    });
    expect(opened.status).toBe(200);
    expect(opened.json.availability.open).toBe(true);
    // A stale version is a conflict.
    const stale = await call(install.admin, "PUT", slackPath, {
      open: false,
      expectedVersion: availability.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details.code).toBe("agent_version_conflict");
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

    // There is no off switch.
    const off = await call(install.admin, "DELETE", slackPath);
    expect(off.status).toBe(409);
    expect(off.json.error.details.code).toBe("agent_slack_always_available");
    expect(await shared!.admin`select 1 from slack_agents where id = ${agent.id}`).toHaveLength(1);

    // Only me takes it out of Slack; shared again, it is back.
    const current = await call(install.admin, "GET", `${install.base}/${agent.id}`);
    const madePrivate = await call(install.admin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: current.json.agent.version,
      visibility: "private",
    });
    expect(madePrivate.status).toBe(200);
    expect(madePrivate.json.agent).toMatchObject({ visibility: "private", slack: [] });
    expect(await shared!.admin`select 1 from slack_agents where id = ${agent.id}`).toHaveLength(0);
    const privateRows = await call(install.admin, "GET", `${install.base}/${agent.id}/slack`);
    expect(privateRows.json.installs).toEqual([
      expect.objectContaining({
        availability: null,
        unavailable: "agent_slack_requires_workspace_visibility",
      }),
    ]);
    const putPrivate = await call(install.admin, "PUT", slackPath, {});
    expect(putPrivate.status).toBe(409);
    expect(putPrivate.json.error.details.code).toBe("agent_slack_requires_workspace_visibility");
    const reshared = await call(install.admin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: madePrivate.json.agent.version,
      visibility: "workspace",
    });
    expect(reshared.status).toBe(200);
    expect(reshared.json.agent.slack).toHaveLength(1);
  }, 120_000);

  test("Anyone in the organization: an organization admin chooses it, Slack follows it, older open use counts", async () => {
    if (!available) return;
    const install = await installation(`org-${Date.now()}`);
    const openRows = async (agentId: string) => ({
      installs: (
        await shared!.admin<{ open: boolean }[]>`
          select open from agent_slack_installs where agent_id = ${agentId}`
      ).map((row) => row.open),
      legacy: (
        await shared!.admin<{ open: boolean }[]>`
          select open from slack_agents where id = ${agentId}`
      ).map((row) => row.open),
      flag: (
        await shared!.admin<{ organization_access: boolean }[]>`
          select organization_access from agents where id = ${agentId}`
      )[0]?.organization_access,
    });

    // Only an organization admin opens an agent to the whole organization.
    const refused = await call(install.admin, "POST", install.base, {
      name: "Org desk",
      visibility: "organization",
    });
    expect(refused.status).toBe(403);
    const created = await call(install.orgAdmin, "POST", install.base, {
      name: "Org desk",
      visibility: "organization",
    });
    expect(created.status).toBe(201);
    const agent = created.json.agent;
    expect(agent.visibility).toBe("organization");
    expect(agent.slack).toEqual([expect.objectContaining({ open: true })]);
    // Older releases read Slack's open flag, so it is kept in step.
    expect(await openRows(agent.id)).toEqual({ installs: [true], legacy: [true], flag: true });

    // Narrowing it back needs no organization admin; widening again does.
    const narrowed = await call(install.admin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: agent.version,
      visibility: "workspace",
    });
    expect(narrowed.status).toBe(200);
    expect(narrowed.json.agent).toMatchObject({
      visibility: "workspace",
      slack: [expect.objectContaining({ open: false })],
    });
    expect(await openRows(agent.id)).toEqual({ installs: [false], legacy: [false], flag: false });
    const widen = await call(install.admin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: narrowed.json.agent.version,
      visibility: "organization",
    });
    expect(widen.status).toBe(403);
    const widened = await call(install.orgAdmin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: narrowed.json.agent.version,
      visibility: "organization",
    });
    expect(widened.status).toBe(200);
    expect(widened.json.agent.visibility).toBe("organization");

    // A stale client can't reopen it: the install's version still guards it.
    const slackRow = (await call(install.admin, "GET", `${install.base}/${agent.id}/slack`)).json
      .installs[0].availability;
    const agentSlack = `${install.base}/${agent.id}/slack/${install.connectionId}`;
    const stale = await call(install.orgAdmin, "PUT", agentSlack, {
      open: true,
      expectedVersion: slackRow.version - 1,
    });
    expect(stale.status).toBe(409);

    // The bot-templates API keeps it.
    const renamed = await call(
      install.orgAdmin,
      "PATCH",
      `/v1/workspaces/${install.home}/bot-templates/${agent.id}`,
      { name: "Org help desk" },
    );
    expect(renamed.status).toBe(200);
    const afterRename = await call(install.admin, "GET", `${install.base}/${agent.id}`);
    expect(afterRename.json.agent.visibility).toBe("organization");

    // The previous release closes it through its own switch, which only
    // writes the installation: that holds, and the next edit here agrees.
    await shared!.admin`update agent_slack_installs set open = false where agent_id = ${agent.id}`;
    const closedByOld = await call(install.admin, "GET", `${install.base}/${agent.id}`);
    expect(closedByOld.json.agent.visibility).toBe("workspace");
    expect(closedByOld.json.agent.slack).toEqual([expect.objectContaining({ open: false })]);
    const edited = await call(install.admin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: closedByOld.json.agent.version,
      description: "Edited after the old close",
    });
    expect(edited.status).toBe(200);
    expect(edited.json.agent.visibility).toBe("workspace");
    expect((await openRows(agent.id)).flag).toBe(false);
    const reopened = await call(install.orgAdmin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: edited.json.agent.version,
      visibility: "organization",
    });
    expect(reopened.status).toBe(200);

    // Only me clears it everywhere, and shared again it is closed.
    const madePrivate = await call(install.orgAdmin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: (await call(install.admin, "GET", `${install.base}/${agent.id}`)).json.agent
        .version,
      visibility: "private",
    });
    expect(madePrivate.status).toBe(200);
    expect((await openRows(agent.id)).flag).toBe(false);
    const sharedAgain = await call(install.orgAdmin, "PATCH", `${install.base}/${agent.id}`, {
      expectedVersion: madePrivate.json.agent.version,
      visibility: "workspace",
    });
    expect(sharedAgain.status).toBe(200);
    expect(sharedAgain.json.agent.visibility).toBe("workspace");
    expect(await openRows(agent.id)).toEqual({ installs: [false], legacy: [false], flag: false });

    // An agent an older release opened through Slack's switch is open to the
    // organization, and the older Slack field still changes it.
    const older = await call(install.admin, "POST", install.base, { name: "Older desk" });
    expect(older.status).toBe(201);
    await shared!.admin`
      update agent_slack_installs set open = true where agent_id = ${older.json.agent.id}`;
    const read = await call(install.admin, "GET", `${install.base}/${older.json.agent.id}`);
    expect(read.json.agent.visibility).toBe("organization");
    const slackPath = `${install.base}/${older.json.agent.id}/slack/${install.connectionId}`;
    const closed = await call(install.admin, "PUT", slackPath, { open: false });
    expect(closed.status).toBe(200);
    expect(closed.json.availability.open).toBe(false);
    expect(closed.json.agent.visibility).toBe("workspace");
    expect(await openRows(older.json.agent.id)).toEqual({
      installs: [false],
      legacy: [false],
      flag: false,
    });

    // Made before Slack was linked, it is open there once it is placed.
    const later = await installation(`org-later-${Date.now()}`, { linkLater: true });
    const early = await call(later.orgAdmin, "POST", later.base, {
      name: "Early desk",
      visibility: "organization",
    });
    expect(early.status).toBe(201);
    expect(early.json.agent).toMatchObject({ visibility: "organization", slack: [] });
    const connectionId = await later.link();
    const placed = await call(
      later.admin,
      "PUT",
      `${later.base}/${early.json.agent.id}/slack/${connectionId}`,
      {},
    );
    expect(placed.status).toBe(201);
    expect(placed.json.availability.open).toBe(true);
    expect(placed.json.agent.visibility).toBe("organization");
    expect(await openRows(early.json.agent.id)).toEqual({
      installs: [true],
      legacy: [true],
      flag: true,
    });
  }, 120_000);

  test("Slack name rules and clashes are refused when a shared agent is made, renamed or shared", async () => {
    if (!available) return;
    const label = `rules-${Date.now()}`;
    const install = await installation(label);

    // A name Slack can't use: refused for a shared agent, fine for an Only me one.
    const badName = await call(install.admin, "POST", install.base, { name: "!!!" });
    expect(badName.status).toBe(422);
    expect(badName.json.error.details.code).toBe("agent_slack_name_invalid");
    const mine = await call(install.admin, "POST", install.base, {
      name: "!!!",
      visibility: "private",
    });
    expect(mine.status).toBe(201);
    expect(mine.json.agent.slack).toEqual([]);

    // The agent already in Slack keeps its name; the other one is refused, never merged.
    const first = await call(install.admin, "POST", install.base, { name: "Data team" });
    expect(first.status).toBe(201);
    const second = await call(install.admin, "POST", install.base, { name: "Data Team" });
    expect(second.status).toBe(409);
    expect(second.json.error.details).toMatchObject({
      code: "agent_slack_name_taken",
      connectionId: install.connectionId,
      slackTeamName: `Slack ${label}`,
    });
    expect(second.json.error.message).toContain("Choose another name");

    // Another name works; renaming it onto the taken name is refused.
    const helpers = await call(install.admin, "POST", install.base, { name: "Data helpers" });
    expect(helpers.status).toBe(201);
    expect(helpers.json.agent.slack).toHaveLength(1);
    const back = await call(install.admin, "PATCH", `${install.base}/${helpers.json.agent.id}`, {
      expectedVersion: helpers.json.agent.version,
      name: "DATA TEAM",
    });
    expect(back.status).toBe(409);
    expect(back.json.error.details.code).toBe("agent_slack_name_taken");
    // Other changes to an agent keep working.
    const described = await call(
      install.admin,
      "PATCH",
      `${install.base}/${helpers.json.agent.id}`,
      { expectedVersion: helpers.json.agent.version, description: "Helps with data" },
    );
    expect(described.status).toBe(200);

    // An Only me agent may share a name, until it is shared.
    const privateTwin = await call(install.admin, "POST", install.base, {
      name: "Data team",
      visibility: "private",
    });
    expect(privateTwin.status).toBe(201);
    const shareTwin = await call(
      install.admin,
      "PATCH",
      `${install.base}/${privateTwin.json.agent.id}`,
      { expectedVersion: privateTwin.json.agent.version, visibility: "workspace" },
    );
    expect(shareTwin.status).toBe(409);
    expect(shareTwin.json.error.details.code).toBe("agent_slack_name_taken");

    // For now, one Slack workspace per agent: a second linked one says why,
    // and choosing it moves the agent there.
    const otherConnection = await slackConnection(install.accountId, install.home, `${label}-b`);
    const rows = await call(install.admin, "GET", `${install.base}/${first.json.agent.id}/slack`);
    expect(rows.json.installs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: install.connectionId,
          availability: expect.objectContaining({ handle: "data-team" }),
        }),
        expect.objectContaining({
          connectionId: otherConnection,
          availability: null,
          unavailable: "agent_slack_single_install",
        }),
      ]),
    );
    const moved = await call(
      install.admin,
      "PUT",
      `${install.base}/${first.json.agent.id}/slack/${otherConnection}`,
      {},
    );
    expect(moved.status).toBe(201);
    const after = await call(install.admin, "GET", `${install.base}/${first.json.agent.id}/slack`);
    expect(after.json.installs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: install.connectionId,
          availability: null,
          unavailable: "agent_slack_single_install",
        }),
        expect.objectContaining({
          connectionId: otherConnection,
          availability: expect.objectContaining({ handle: "data-team" }),
        }),
      ]),
    );
  }, 120_000);

  test("older agents not in Slack yet keep their names; placement order; personal workspaces never; the old API places too", async () => {
    if (!available) return;
    const label = `order-${Date.now()}`;
    const install = await installation(label);
    // As an older release made it: a shared agent with no Slack row yet.
    const older = crypto.randomUUID();
    await shared!.admin`insert into bot_templates (id, account_id, workspace_id, name, description,
        avatar, setup_instructions, visibility, source_session_id, created_by_subject_id)
      values (${older}, ${install.accountId}, ${install.home}, 'Growth desk', '', null,
        'Track growth.', 'workspace', null, ${install.owner})`;
    expect(
      await shared!.admin`select 1 from agent_slack_installs where agent_id = ${older}`,
    ).toHaveLength(0);
    // A new shared agent can't take its name; the older one is placed first.
    const clash = await call(install.admin, "POST", install.base, { name: "growth desk" });
    expect(clash.status).toBe(409);
    expect(clash.json.error.details.code).toBe("agent_slack_name_taken");
    expect(
      await shared!.admin`select 1 from agent_slack_installs where agent_id = ${older}`,
    ).toHaveLength(1);

    // With two linked Slack workspaces, a new agent goes to the first by name.
    const second = await slackConnection(install.accountId, install.home, `a-${label}`);
    const placed = await call(install.admin, "POST", install.base, { name: "Order desk" });
    expect(placed.status).toBe(201);
    expect(placed.json.agent.slack).toEqual([expect.objectContaining({ connectionId: second })]);

    // An agent in a personal workspace is never placed, even when shared.
    const [membership] = await shared!.admin<{ personal: string }[]>`
      select personal_workspace_id as personal from organization_memberships
      where account_id = ${install.accountId} and subject_id = ${install.owner}`;
    const personalAgent = crypto.randomUUID();
    await shared!.admin`insert into bot_templates (id, account_id, workspace_id, name, description,
        avatar, setup_instructions, visibility, source_session_id, created_by_subject_id)
      values (${personalAgent}, ${install.accountId}, ${membership!.personal}, 'Pocket desk', '',
        null, 'Mine.', 'workspace', null, ${install.owner})`;
    const deps = { db: client.db } as unknown as ApiRouteDeps;
    const loaded = await loadSlackAgentsForConnection(deps, install.scope, install.connectionId);
    expect(loaded.records.map((agent) => agent.id)).not.toContain(personalAgent);
    expect(
      await shared!.admin`select 1 from agent_slack_installs where agent_id = ${personalAgent}`,
    ).toHaveLength(0);

    // The older bot-template API makes a shared agent available at once too.
    const viaTemplate = await call(
      install.admin,
      "POST",
      `/v1/workspaces/${install.home}/bot-templates`,
      {
        name: "Template desk",
        description: "",
        avatar: null,
        setupInstructions: "Help.",
        visibility: "workspace",
        sourceSessionId: null,
      },
    );
    expect(viaTemplate.status).toBe(201);
    expect(
      await shared!
        .admin`select 1 from agent_slack_installs where agent_id = ${viaTemplate.json.template.id}`,
    ).toHaveLength(1);
  }, 120_000);

  test("agents an older release made catch up when Slack reads its agents; the older of two names wins", async () => {
    if (!available) return;
    const install = await installation(`template-${Date.now()}`);
    // As an older release writes them; PR1's trigger makes each an agent with
    // the template text as its First message, empty Instructions and no Slack.
    const firstMessage = `Set up the weekly report. ${"Step. ".repeat(2_450)}`.trim();
    expect(firstMessage.length).toBeGreaterThan(14_000);
    const template = async (name: string) => {
      const id = crypto.randomUUID();
      await shared!
        .admin`insert into bot_templates (id, account_id, workspace_id, name, description,
          avatar, setup_instructions, visibility, source_session_id, created_by_subject_id)
        values (${id}, ${install.accountId}, ${install.home}, ${name}, '', null,
          ${firstMessage}, 'workspace', null, ${install.owner})`;
      return id;
    };
    const weekly = await template("Weekly report");
    const older = await template("Helper desk");
    const newer = await template("helper-desk");
    const unusable = await template("hi");
    expect(
      await shared!.admin`select 1 from agent_slack_installs where agent_id = ${weekly}`,
    ).toHaveLength(0);

    const deps = { db: client.db } as unknown as ApiRouteDeps;
    const loaded = await loadSlackAgentsForConnection(deps, install.scope, install.connectionId);
    const ids = loaded.records.map((agent) => agent.id);
    expect(ids).toContain(weekly);
    expect(ids).toContain(older);
    expect(ids).not.toContain(newer);
    expect(ids).not.toContain(unusable);
    const [legacy] = await shared!.admin<
      { description: string; instructions: string; avatarKind: string }[]
    >`select description, instructions, jsonb_typeof(avatar) as "avatarKind"
      from slack_agents where id = ${weekly}`;
    // Agents have one text: the template's First message is its Instructions,
    // in Slack too.
    expect(legacy).toEqual({
      description: "",
      instructions: `${AGENT_FIRST_MESSAGE_LEAD}\n${firstMessage}`,
      avatarKind: "object",
    });
    expect(loaded.records.find((agent) => agent.id === weekly)?.instructions).toBe(
      `${AGENT_FIRST_MESSAGE_LEAD}\n${firstMessage}`,
    );
    const [stored] = await shared!.admin<{ setup: string }[]>`
      select setup_instructions as setup from bot_templates where id = ${weekly}`;
    expect(stored?.setup).toBe(firstMessage);

    // Its page says why the newer one isn't in Slack.
    const rows = await call(install.admin, "GET", `${install.base}/${newer}/slack`);
    expect(rows.json.installs).toEqual([
      expect.objectContaining({ availability: null, unavailable: "agent_slack_name_taken" }),
    ]);
    const invalid = await call(install.admin, "GET", `${install.base}/${unusable}/slack`);
    expect(invalid.json.installs).toEqual([
      expect.objectContaining({ availability: null, unavailable: "agent_slack_name_invalid" }),
    ]);
  }, 120_000);
});
