import { expect, test } from "bun:test";
import { OPENGENI_SLACK_BOT_REQUIRED_SCOPES } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import { createDb, rawRows, withRlsContext } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createConnection, createEventSource, nestedPostgresSqlState } from "../src";
import { sharedSlackEventSourceIds } from "../src/organization-slack-bots";

const postgresTest = process.env.OPENGENI_REQUIRE_REAL_DB === "1" ? test : test.skip;
const signature = "list_shared_slack_event_sources_v1(uuid, uuid, uuid, text)";

postgresTest(
  "1530 lists the Slack sources of the workspaces a bot is live-shared with, as the runtime",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("shared-slack-event-sources");
    if (!owned) throw new Error("PostgreSQL required");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const db = client.db;
      const accountId = crypto.randomUUID();
      const otherAccountId = crypto.randomUUID();
      const home = { accountId, workspaceId: crypto.randomUUID() };
      const target = { accountId, workspaceId: crypto.randomUUID() };
      const unsourced = { accountId, workspaceId: crypto.randomUUID() };
      const foreign = {
        accountId: otherAccountId,
        workspaceId: crypto.randomUUID(),
      };
      for (const id of [accountId, otherAccountId]) {
        await owned.admin`insert into managed_accounts(id,name) values (${id},'Shared Slack')`;
      }
      for (const scope of [home, target, unsourced, foreign]) {
        await owned.admin`insert into workspaces(id,account_id,name,settings)
          values (${scope.workspaceId},${scope.accountId},'Slack workspace','{}')`;
        await owned.admin`insert into workspace_inference_controls(account_id,workspace_id)
          values (${scope.accountId},${scope.workspaceId})`;
      }
      const bot = await createConnection(db, {
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
          credentialLabel: "Opengeni Slack bot",
          slackTeamId: "T0SHARED1",
          slackTeamName: "Shared fixture",
          botId: "B0SHARED1",
          botUserId: "U0SHARED1",
          botDisplayName: "Opengeni",
          verifiedAt: new Date().toISOString(),
        },
        createdBySubjectId: "user:owner",
      });
      const externalKey = "team:T0SHARED1";
      const sources: Record<string, string> = {};
      for (const scope of [home, target, foreign]) {
        const { source } = await createEventSource(db, {
          ...scope,
          createdBySubjectId: "user:owner",
          kind: "slack",
          name: "Slack",
          ownerSubjectId: null,
          visibility: "workspace",
          externalKey,
        });
        sources[scope.workspaceId] = source.id;
      }
      // Another team's source in the target workspace is not this bot's.
      await createEventSource(db, {
        ...target,
        createdBySubjectId: "user:owner",
        kind: "slack",
        name: "Other Slack",
        ownerSubjectId: null,
        visibility: "workspace",
        externalKey: "team:T0OTHER01",
      });
      const list = async () =>
        await sharedSlackEventSourceIds(db, {
          accountId,
          homeWorkspaceId: home.workspaceId,
          connectionId: bot.id,
          externalKey,
        });
      const shareTarget = [
        {
          workspaceId: target.workspaceId,
          sourceId: sources[target.workspaceId]!,
        },
      ];

      // Not shared: nothing.
      expect(await list()).toEqual([]);
      await owned.admin`insert into opengeni_private.organization_slack_bot_access(
          connection_id,account_id,home_workspace_id,enabled,generation,updated_by_subject_id)
        values (${bot.id},${accountId},${home.workspaceId},true,1,'user:owner')`;
      // Shared with every workspace: the other workspaces of this organization
      // that have a source, never the home one or another organization's.
      expect(await list()).toEqual(shareTarget);
      await owned.admin`update opengeni_private.organization_slack_bot_access
        set workspace_ids = ${[unsourced.workspaceId]}::uuid[] where connection_id = ${bot.id}`;
      expect(await list()).toEqual([]);
      await owned.admin`update opengeni_private.organization_slack_bot_access
        set workspace_ids = ${[target.workspaceId, foreign.workspaceId]}::uuid[]
        where connection_id = ${bot.id}`;
      expect(await list()).toEqual(shareTarget);
      // Revoked: nothing.
      await owned.admin`update opengeni_private.organization_slack_bot_access
        set enabled = false where connection_id = ${bot.id}`;
      expect(await list()).toEqual([]);
      await owned.admin`update opengeni_private.organization_slack_bot_access
        set enabled = true, workspace_ids = null where connection_id = ${bot.id}`;
      expect(await list()).toEqual(shareTarget);
      // A bot that needs reconnecting is not shared.
      const setBotStatus = async (status: string) =>
        await withRlsContext(db, home, async (tx) => {
          await tx.execute(sql`update connections set status = ${status} where id = ${bot.id}`);
        });
      await setBotStatus("error");
      expect(await list()).toEqual([]);
      await setBotStatus("active");
      expect(await list()).toEqual(shareTarget);

      // The caller's workspace setting is restored after the call.
      const restored = await withRlsContext(db, home, async (tx) => {
        await rawRows(
          tx,
          sql`select * from opengeni_private.list_shared_slack_event_sources_v1(
            ${accountId}::uuid, ${home.workspaceId}::uuid, ${bot.id}::uuid, ${externalKey}::text)`,
        );
        return await rawRows<{ workspace: string }>(
          tx,
          sql`select current_setting('opengeni.workspace_id', true) as workspace`,
        );
      });
      expect(restored[0]?.workspace).toBe(home.workspaceId);

      // Only from the home workspace's own scope.
      const mismatch = await withRlsContext(db, target, async (tx) =>
        rawRows(
          tx,
          sql`select * from opengeni_private.list_shared_slack_event_sources_v1(
            ${accountId}::uuid, ${home.workspaceId}::uuid, ${bot.id}::uuid, ${externalKey}::text)`,
        ),
      ).then(
        () => null,
        (error) => nestedPostgresSqlState(error),
      );
      expect(mismatch).toBe("42501");

      const [privileges] = await owned.admin`
        select has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as execute,
          p.prosecdef as definer,
          exists (
            select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
            where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
          ) as public_execute
        from pg_proc p where p.oid = ${`opengeni_private.${signature}`}::regprocedure`;
      expect(privileges).toEqual({
        execute: true,
        definer: false,
        public_execute: false,
      });
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
