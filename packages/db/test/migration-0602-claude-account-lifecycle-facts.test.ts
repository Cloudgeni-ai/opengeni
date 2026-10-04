import { expect, setDefaultTimeout, test } from "bun:test";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createClaudeSubscriptionAccount, createDb } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import postgres from "postgres";

// The genuine complete migration replay runs as a non-bypass owner.
setDefaultTimeout(180_000);
const migrationName = "0602_claude_account_lifecycle_facts.sql";

test("Claude account connection facts follow real insert, privacy and export boundaries without backfill", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("claude-lifecycle-dispatch");
  if (!owned) throw new Error("Claude lifecycle migration tests require real PostgreSQL");
  const owner = postgres(owned.ownerUrl, { max: 1 });
  let app: ReturnType<typeof createDb> | undefined;
  try {
    // Withhold only this repair; all actual account and export prerequisites
    // are installed. Removing the temporary receipt invokes the real replay.
    await owner`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values (${migrationName})`;
    await migrate(owned.ownerUrl);
    await provisionRoles(owned.adminUrl, {
      appPassword: owned.appPassword,
      rlsStrategy: "force",
    });
    const appUrl = new URL(owned.ownerUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owned.appPassword;
    app = createDb(appUrl.toString(), { rlsStrategy: "force" });
    const subjectId = `user:claude-fact-${crypto.randomUUID()}`;
    const suffix = crypto.randomUUID();
    const grant = (
      await bootstrapWorkspace(app.db, {
        accountExternalSource: "test",
        accountExternalId: suffix,
        accountName: "Claude lifecycle fixture",
        workspaceExternalSource: "test",
        workspaceExternalId: suffix,
        workspaceName: "Claude lifecycle fixture",
        subjectId,
      })
    ).workspaceGrants[0]!;
    const [personal] = await owned.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${grant.accountId}, 'Fixture personal workspace') returning id`;
    await owned.admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (${grant.accountId}, ${subjectId}, 'owner', 'active', ${personal!.id})`;
    await owned.admin`update host_export_config set lifecycle_facts_enabled = true where id = 1`;

    const secrets: string[] = [];
    const connect = async () => {
      const providerAccountId = crypto.randomUUID();
      const token = `sk-ant-oat01-lifecycle-${crypto.randomUUID()}`;
      const label = `private-account-label-${crypto.randomUUID()}`;
      secrets.push(providerAccountId, token, label);
      return await createClaudeSubscriptionAccount(app!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
        scope: "workspace",
        encryptionKey: Buffer.alloc(32, 7),
        providerAccountId,
        label,
        secret: {
          version: 1,
          token,
          identity: { accountUuid: providerAccountId, deviceId: "a".repeat(64) },
        },
      });
    };
    const facts = () => owned.admin<
      Array<{
        account_id: string;
        workspace_id: string;
        payload: { factType: string; attribute: string; subjectKind: string };
      }>
    >`
      select account_id::text, workspace_id::text, payload from host_export_outbox
      where export_kind = 'lifecycle_fact' and account_id = ${grant.accountId}
        and payload->>'factType' = 'model.connected'
        and payload->>'attribute' = 'claude_subscription'`;
    await connect();
    expect(await facts()).toHaveLength(0);

    await owner`delete from schema_migrations where name = ${migrationName}`;
    await migrate(owned.ownerUrl);
    // Historical accounts are not retroactively exported by this repair.
    expect(await facts()).toHaveLength(0);
    await connect();
    const captured = await facts();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      account_id: grant.accountId,
      workspace_id: grant.workspaceId,
      payload: { factType: "model.connected", attribute: "claude_subscription" },
    });
    expect(Object.keys(captured[0]!.payload).sort()).toEqual([
      "attribute",
      "factType",
      "subjectKind",
    ]);
    for (const secret of secrets) expect(JSON.stringify(captured)).not.toContain(secret);

    await owned.admin`update host_export_config set lifecycle_facts_enabled = false where id = 1`;
    await connect();
    expect(await facts()).toEqual(captured);
  } finally {
    await app?.close();
    await owner.end({ timeout: 1 });
    await owned.release();
  }
});
