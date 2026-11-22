import { expect, test } from "bun:test";
import { OPENGENI_SLACK_BOT_REQUIRED_SCOPES } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import { createDb, rawRows, withRlsContext, type Database } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createConnection, createEventSource, nestedPostgresSqlState } from "../src";
import {
  sharedSlackEventSources,
  type SharedSlackEventSource,
} from "../src/organization-slack-bots";

const postgresTest = process.env.OPENGENI_REQUIRE_REAL_DB === "1" ? test : test.skip;
const signature = "list_shared_slack_event_sources_v1(uuid, uuid, uuid, text)";
const signatureV2 = "list_shared_slack_event_sources_v2(uuid, uuid, uuid, text)";

postgresTest(
  "1538 and 1552 list the Slack sources of the workspaces a bot is live-shared with, as the runtime",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("shared-slack-event-sources");
    if (!owned) throw new Error("PostgreSQL required");
    let client: ReturnType<typeof createDb> | undefined;
    let grantedClient: ReturnType<typeof createDb> | undefined;
    let ownerClient: ReturnType<typeof createDb> | undefined;
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
      const shareTarget: SharedSlackEventSource[] = [
        {
          workspaceId: target.workspaceId,
          sourceId: sources[target.workspaceId]!,
          status: "active",
          statusReason: null,
        },
      ];

      // The same scenario through whichever routine the runtime may call.
      const exercise = async (runtimeDb: Database, routine: string) => {
        const list = async () =>
          await sharedSlackEventSources(runtimeDb, {
            accountId,
            homeWorkspaceId: home.workspaceId,
            connectionId: bot.id,
            externalKey,
          });
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
        // A saved selection naming the home workspace or another organization's
        // never reaches them, and nothing outside it is visited.
        await owned.admin`update opengeni_private.organization_slack_bot_access
        set workspace_ids = ${[home.workspaceId, foreign.workspaceId]}::uuid[]
        where connection_id = ${bot.id}`;
        expect(await list()).toEqual([]);
        await owned.admin`update opengeni_private.organization_slack_bot_access
        set workspace_ids = ${[target.workspaceId]}::uuid[] where connection_id = ${bot.id}`;
        // Each source comes with its status, so recording reads nothing else.
        await withRlsContext(runtimeDb, target, async (tx) => {
          await tx.execute(sql`update event_sources
          set status = 'disabled', status_reason = 'Turned off'
          where id = ${sources[target.workspaceId]!}::uuid`);
        });
        expect(await list()).toEqual([
          {
            ...shareTarget[0]!,
            status: "disabled",
            statusReason: "Turned off",
          },
        ]);
        await withRlsContext(runtimeDb, target, async (tx) => {
          await tx.execute(sql`update event_sources set status = 'active', status_reason = null
          where id = ${sources[target.workspaceId]!}::uuid`);
        });
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
          await withRlsContext(runtimeDb, home, async (tx) => {
            await tx.execute(sql`update connections set status = ${status} where id = ${bot.id}`);
          });
        await setBotStatus("error");
        expect(await list()).toEqual([]);
        await setBotStatus("active");
        expect(await list()).toEqual(shareTarget);

        // The caller's workspace setting is restored after the call.
        const restored = await withRlsContext(runtimeDb, home, async (tx) => {
          await rawRows(
            tx,
            sql`select * from opengeni_private.${sql.raw(routine)}(
            ${accountId}::uuid, ${home.workspaceId}::uuid, ${bot.id}::uuid, ${externalKey}::text)`,
          );
          return await rawRows<{ workspace: string }>(
            tx,
            sql`select current_setting('opengeni.workspace_id', true) as workspace`,
          );
        });
        expect(restored[0]?.workspace).toBe(home.workspaceId);

        // Only from the home workspace's own scope.
        const mismatch = await withRlsContext(runtimeDb, target, async (tx) =>
          rawRows(
            tx,
            sql`select * from opengeni_private.${sql.raw(routine)}(
            ${accountId}::uuid, ${home.workspaceId}::uuid, ${bot.id}::uuid, ${externalKey}::text)`,
          ),
        ).then(
          () => null,
          (error) => nestedPostgresSqlState(error),
        );
        expect(mismatch).toBe("42501");
        await owned.admin`delete from opengeni_private.organization_slack_bot_access
        where connection_id = ${bot.id}`;
      };

      // Until a later migration grants 1552's definer, the runtime keeps v1.
      const [deferred] = await owned.admin`
        select has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as execute,
          p.prosecdef as definer,
          exists (
            select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
            where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
          ) as public_execute,
          p.proconfig as config
        from pg_proc p where p.oid = ${`opengeni_private.${signatureV2}`}::regprocedure`;
      expect({
        execute: deferred!.execute,
        definer: deferred!.definer,
        public_execute: deferred!.public_execute,
      }).toEqual({ execute: false, definer: true, public_execute: false });
      expect(String(deferred!.config)).toContain("search_path=pg_catalog");
      await exercise(db, "list_shared_slack_event_sources_v1");

      // Granted (as the follow-up migration will): one indexed lookup with
      // the same results and the same checks.
      await owned.admin.unsafe(
        `grant execute on function opengeni_private.${signatureV2} to opengeni_app`,
      );
      grantedClient = createDb(appUrl.toString());
      await exercise(grantedClient.db, "list_shared_slack_event_sources_v2");

      // The lookup is one probe of 1551's partial index, not a scan per workspace.
      await owned.admin`analyze event_sources`;
      const plan = await owned.admin.begin(async (tx) => {
        await tx`set local enable_seqscan = off`;
        return await tx.unsafe(
          `explain (format json) select s.workspace_id from event_sources s
            where s.account_id = $1::uuid and s.kind = 'slack'
              and s.external_key = $2 and s.workspace_id <> $3::uuid`,
          [accountId, externalKey, home.workspaceId],
        );
      });
      expect(JSON.stringify(plan)).toContain("event_sources_slack_team_idx");

      // The runtime gains no read: it can't open the owner inventory window or
      // see another workspace's source, and the window closes after each call.
      const runtimeWindow = await withRlsContext(grantedClient.db, home, async (tx) =>
        tx.execute(sql`insert into opengeni_private.organization_tenancy_inventory_capabilities
          (backend_pid, transaction_id) values (pg_backend_pid(), pg_current_xact_id())`),
      ).then(
        () => null,
        (error) => nestedPostgresSqlState(error),
      );
      expect(runtimeWindow).toBe("42501");
      await owned.admin`insert into opengeni_private.organization_slack_bot_access(
          connection_id,account_id,home_workspace_id,enabled,generation,updated_by_subject_id)
        values (${bot.id},${accountId},${home.workspaceId},true,1,'user:owner')`;
      const afterCall = await withRlsContext(grantedClient.db, home, async (tx) => {
        const listed = await rawRows<{ workspace_id: string }>(
          tx,
          sql`select workspace_id from opengeni_private.list_shared_slack_event_sources_v2(
            ${accountId}::uuid, ${home.workspaceId}::uuid, ${bot.id}::uuid, ${externalKey}::text)`,
        );
        const visible = await rawRows<{ id: string }>(
          tx,
          sql`select id from event_sources where kind = 'slack'`,
        );
        const [open] = await rawRows<{ open: boolean }>(
          tx,
          sql`select opengeni_private.organization_tenancy_inventory_capability_active() as open`,
        );
        return { listed, visible, open: open?.open };
      });
      expect(afterCall.listed).toEqual([{ workspace_id: target.workspaceId }]);
      expect(afterCall.visible).toEqual([{ id: sources[home.workspaceId]! }]);
      expect(afterCall.open).toBe(false);

      // The definer's own statement uses 1551's index: this transaction's scan
      // counters show index scans and no sequential scan of event_sources.
      const scans = await withRlsContext(grantedClient.db, home, async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const listed = await rawRows<{ workspace_id: string }>(
          tx,
          sql`select workspace_id from opengeni_private.list_shared_slack_event_sources_v2(
            ${accountId}::uuid, ${home.workspaceId}::uuid, ${bot.id}::uuid, ${externalKey}::text)`,
        );
        const [counts] = await rawRows<{ index_scans: string; table_scans: string }>(
          tx,
          sql`select pg_stat_get_xact_numscans('event_sources_slack_team_idx'::regclass) as index_scans,
            pg_stat_get_xact_numscans('event_sources'::regclass) as table_scans`,
        );
        return {
          listed,
          indexScans: Number(counts?.index_scans),
          tableScans: Number(counts?.table_scans),
        };
      });
      expect(scans.listed).toEqual([{ workspace_id: target.workspaceId }]);
      expect(scans.indexScans).toBeGreaterThan(0);
      expect(scans.tableScans).toBe(0);

      // Even for the tables' owner, the window covers only the current
      // organization's Slack rows, and a window it already holds stays open.
      ownerClient = createDb(owned.ownerUrl);
      const asOwner = await withRlsContext(ownerClient.db, home, async (tx) => {
        await tx.execute(sql`insert into opengeni_private.organization_tenancy_inventory_capabilities
          (backend_pid, transaction_id) values (pg_backend_pid(), pg_current_xact_id())`);
        const visible = await rawRows<{ account_id: string }>(
          tx,
          sql`select distinct account_id from event_sources where kind = 'slack'`,
        );
        await rawRows(
          tx,
          sql`select * from opengeni_private.list_shared_slack_event_sources_v2(
            ${accountId}::uuid, ${home.workspaceId}::uuid, ${bot.id}::uuid, ${externalKey}::text)`,
        );
        const [open] = await rawRows<{ open: boolean }>(
          tx,
          sql`select opengeni_private.organization_tenancy_inventory_capability_active() as open`,
        );
        return { visible, open: open?.open };
      });
      expect(asOwner.visible).toEqual([{ account_id: accountId }]);
      expect(asOwner.open).toBe(true);

      // EXECUTE revoked after the runtime saw it granted: back to v1, same rows.
      const lookup = {
        accountId,
        homeWorkspaceId: home.workspaceId,
        connectionId: bot.id,
        externalKey,
      };
      expect(await sharedSlackEventSources(grantedClient.db, lookup)).toEqual(shareTarget);
      await owned.admin.unsafe(
        `revoke execute on function opengeni_private.${signatureV2} from opengeni_app`,
      );
      expect(await sharedSlackEventSources(grantedClient.db, lookup)).toEqual(shareTarget);

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
      await grantedClient?.close();
      await ownerClient?.close();
      await owned.release();
    }
  },
  180_000,
);
