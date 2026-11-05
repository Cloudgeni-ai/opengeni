import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { OPENGENI_SLACK_BOT_REQUIRED_SCOPES } from "@opengeni/contracts";
import { createConnection, createDb, revokeConnection, type Database } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { slackBotToolsAvailable } from "../src/integrations/slack-bot";

// The first-party MCP lists the slack_bot_* tools only where this says a bot
// is available: an active, verified Opengeni bot installed in the workspace or
// shared with it by its organization. Anything else leaves them unlisted, so a
// Slack request reaches the Slack connect offer instead.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(120_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("slack-bot-tools-availability");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Scope = { accountId: string; workspaceId: string };

async function organization(workspaces = 2): Promise<Scope[]> {
  const accountId = crypto.randomUUID();
  await shared.admin`insert into managed_accounts(id,name) values (${accountId},'Bot availability')`;
  const scopes: Scope[] = [];
  for (let index = 0; index < workspaces; index += 1) {
    const workspaceId = crypto.randomUUID();
    await shared.admin`insert into workspaces(id,account_id,name,settings) values (${workspaceId},${accountId},'Bot workspace','{}')`;
    await shared.admin`insert into workspace_inference_controls(account_id,workspace_id) values (${accountId},${workspaceId})`;
    scopes.push({ accountId, workspaceId });
  }
  return scopes;
}

async function installBot(scope: Scope, overrides: { verified?: boolean } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  return await createConnection(client.db, {
    ...scope,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    credentialEncrypted: "fixture",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    ...(overrides.verified === false
      ? {}
      : { verifiedInstallAt: new Date(), verifiedInstallVersion: 1 }),
    metadata: {
      credentialRole: "opengeni_slack_bot",
      credentialLabel: "OpenGeni Slack bot",
      slackTeamId: `T${suffix}`,
      slackTeamName: "Availability fixture",
      botId: `B${suffix}`,
      botUserId: `U${suffix}`,
      botDisplayName: "OpenGeni",
      verifiedAt: new Date().toISOString(),
    },
    createdBySubjectId: "user:owner",
  });
}

async function share(
  bot: { id: string },
  home: Scope,
  access: { enabled?: boolean; workspaceIds?: string[] | null; accountId?: string } = {},
) {
  await shared.admin`
    insert into opengeni_private.organization_slack_bot_access(
      connection_id, account_id, home_workspace_id, enabled, generation, updated_by_subject_id, workspace_ids)
    values (${bot.id}, ${access.accountId ?? home.accountId}, ${home.workspaceId},
      ${access.enabled ?? true}, 1, 'user:owner', ${access.workspaceIds ?? null}::uuid[])`;
}

describe("the workspace Slack bot tools are available only with a usable bot", () => {
  test("none without a bot, even with a person's own Slack connected", async () => {
    const [scope] = await organization(1);
    expect(await slackBotToolsAvailable(client.db, scope!)).toBe(false);
    await createConnection(client.db, {
      ...scope!,
      subjectId: "user:member",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: "personal",
      grantedScopes: ["chat:write"],
      metadata: {},
      createdBySubjectId: "user:member",
    });
    expect(await slackBotToolsAvailable(client.db, scope!)).toBe(false);
  });

  test("a verified bot installed in the workspace makes them available", async () => {
    const [scope] = await organization(1);
    await installBot(scope!);
    expect(await slackBotToolsAvailable(client.db, scope!)).toBe(true);
  });

  test("a revoked, unverified, or since-changed install does not", async () => {
    const [revokedIn, unverifiedIn, changedIn] = await organization(3);
    const revoked = await installBot(revokedIn!);
    expect(await slackBotToolsAvailable(client.db, revokedIn!)).toBe(true);
    await revokeConnection(client.db, revokedIn!.workspaceId, revoked.id, "user:owner");
    expect(await slackBotToolsAvailable(client.db, revokedIn!)).toBe(false);

    await installBot(unverifiedIn!, { verified: false });
    expect(await slackBotToolsAvailable(client.db, unverifiedIn!)).toBe(false);

    // Verified at version 1, then the connection moved on without reverifying.
    const changed = await installBot(changedIn!);
    await shared.admin`update connections set version = version + 1 where id = ${changed.id}`;
    expect(await slackBotToolsAvailable(client.db, changedIn!)).toBe(false);
  });

  test("a bot shared by the organization counts; an unshared one does not", async () => {
    const [home, target, other] = await organization(3);
    const bot = await installBot(home!);
    expect(await slackBotToolsAvailable(client.db, home!)).toBe(true);
    // Installed in a sibling workspace but not shared.
    expect(await slackBotToolsAvailable(client.db, target!)).toBe(false);
    await share(bot, home!, { workspaceIds: [target!.workspaceId] });
    expect(await slackBotToolsAvailable(client.db, target!)).toBe(true);
    // Shared with selected workspaces only.
    expect(await slackBotToolsAvailable(client.db, other!)).toBe(false);
    await shared.admin`
      update opengeni_private.organization_slack_bot_access set enabled = false
      where connection_id = ${bot.id}`;
    expect(await slackBotToolsAvailable(client.db, target!)).toBe(false);
  });

  test("a bot of another organization never counts, even shared", async () => {
    const [home] = await organization(1);
    const [elsewhere] = await organization(1);
    const bot = await installBot(home!);
    await share(bot, home!);
    expect(await slackBotToolsAvailable(client.db, elsewhere!)).toBe(false);
  });

  test("a failed read keeps the tools listed, as before the check existed", async () => {
    const broken = {} as Database;
    expect(
      await slackBotToolsAvailable(broken, {
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
      }),
    ).toBe(true);
  });
});
