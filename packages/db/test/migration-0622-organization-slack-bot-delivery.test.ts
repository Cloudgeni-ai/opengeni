import { expect, test } from "bun:test";
import { OPENGENI_SLACK_BOT_REQUIRED_SCOPES } from "@opengeni/contracts";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { createDb } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createConnection, createSession, nestedPostgresSqlState } from "../src";
import {
  availableSlackBotConnectionMetadata,
  prepareBotMessage,
  readPreparedBotMessage,
} from "../src/organization-slack-bots";

const postgresTest = process.env.OPENGENI_REQUIRE_REAL_DB === "1" ? test : test.skip;

postgresTest(
  "organization bot capabilities work under a non-superuser owner without direct runtime table access",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("organization-slack-bot-delivery");
    if (!owned) throw new Error("PostgreSQL required");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const accountId = crypto.randomUUID();
      const home = { accountId, workspaceId: crypto.randomUUID() };
      const target = { accountId, workspaceId: crypto.randomUUID() };
      await owned.admin`insert into managed_accounts(id,name) values (${accountId},'Organization bot')`;
      for (const scope of [home, target]) {
        await owned.admin`insert into workspaces(id,account_id,name,settings) values (${scope.workspaceId},${accountId},'Bot workspace','{}')`;
        await owned.admin`insert into workspace_inference_controls(account_id,workspace_id) values (${accountId},${scope.workspaceId})`;
      }
      const bot = await createConnection(client.db, {
        ...home,
        subjectId: null,
        providerDomain: "slack.com",
        kind: "app_install",
        credentialEncrypted: "fixture-bot",
        grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
        verifiedInstallAt: new Date(),
        verifiedInstallVersion: 1,
        metadata: {
          credentialRole: "opengeni_slack_bot",
          credentialLabel: "OpenGeni Slack bot",
          slackTeamId: "T0OWNER01",
          slackTeamName: "Owner fixture",
          botId: "B0OWNER01",
          botUserId: "U0OWNER01",
          botDisplayName: "OpenGeni",
          verifiedAt: new Date().toISOString(),
        },
        createdBySubjectId: "user:owner",
      });
      // Seed only the configured setting; HTTP tests exercise administrator authentication.
      await owned.admin`insert into opengeni_private.organization_slack_bot_access(connection_id,account_id,home_workspace_id,enabled,generation,updated_by_subject_id)
      values (${bot.id},${accountId},${home.workspaceId},true,1,'user:owner')`;
      expect(
        (await availableSlackBotConnectionMetadata(client.db, target)).map((row) => row.id),
      ).toEqual([bot.id]);
      const session = await createSession(client.db, {
        ...target,
        initialMessage: "Post as the bot",
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: "user:owner" },
      });
      const intent = {
        ...target,
        sessionId: session.id,
        scheduledTaskId: null,
        connectionId: bot.id,
        connectionVersion: bot.version,
        homeWorkspaceId: home.workspaceId,
        sharingGeneration: 1,
        channelId: "C0OWNER01",
        threadTimestamp: null,
        text: "Exact message",
      };
      const prepared = await prepareBotMessage(client.db, intent);
      expect(
        await readPreparedBotMessage(client.db, {
          ...target,
          sessionId: session.id,
          id: prepared.id,
        }),
      ).toEqual({
        id: prepared.id,
        scheduledTaskId: null,
        connectionId: bot.id,
        connectionVersion: bot.version,
        homeWorkspaceId: home.workspaceId,
        sharingGeneration: 1,
        channelId: "C0OWNER01",
        threadTimestamp: null,
        text: "Exact message",
      });
      const refused = await prepareBotMessage(client.db, { ...intent, sharingGeneration: 2 }).then(
        () => null,
        (error) => nestedPostgresSqlState(error),
      );
      expect(refused).toBe("42501");
      expect(
        await readPreparedBotMessage(client.db, {
          ...target,
          sessionId: crypto.randomUUID(),
          id: prepared.id,
        }),
      ).toBeNull();
      const [privileges] =
        await owned.admin`select has_table_privilege('opengeni_app','opengeni_private.organization_slack_bot_access','SELECT') as read,
      has_table_privilege('opengeni_app','opengeni_private.organization_slack_bot_access','UPDATE') as update,
      has_function_privilege('opengeni_app','opengeni_private.list_organization_slack_bots(uuid,uuid)','EXECUTE') as execute`;
      expect(privileges).toMatchObject({ read: false, update: false, execute: true });
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
