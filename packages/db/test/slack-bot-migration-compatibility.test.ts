import { expect, test } from "bun:test";
import { OPENGENI_SLACK_BOT_REQUIRED_SCOPES } from "@opengeni/contracts";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  createConnection,
  createDb,
  createOrganizationApiKey,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  nestedPostgresSqlState,
  revokeOrganizationApiKey,
} from "../src";
import { migrate } from "../src/migrate";
import {
  readOrganizationSlackBotAccess,
  setOrganizationSlackBotAccess,
  sharedOrganizationSlackBots,
} from "../src/organization-slack-bots";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "0864_scheduled_bot_capability.sql";
const PREVIOUS_REVISION = "50db761640045ae4142d54d379dba809e729b454";
const DATA_SCHEMA = "slack_compat";

test("0864 preserves old runtime readiness and grants selected-workspace capabilities before reprovisioning", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("slack-bot-rolling");
  if (!owned) throw new Error("Real PostgreSQL is required");
  const repository = new URL("../../..", import.meta.url).pathname;
  const oldDirectory = await mkdtemp(join(repository, ".slack-old-runtime-"));
  const staging = postgres(owned.ownerUrl, {
    max: 1,
    connection: { search_path: `${DATA_SCHEMA},opengeni_private,public` },
    onnotice: () => undefined,
  });
  let client: ReturnType<typeof createDb> | undefined;
  try {
    // Use the immutable previous binary, including its complete evaluator and
    // provisioner. Do not filter the catalog or replace its expected routines.
    for (const name of [
      "runtime-posture.ts",
      "role-relationships.ts",
      "provision-roles.ts",
      "boot-connect.ts",
    ]) {
      await writeFile(
        join(oldDirectory, name),
        execFileSync("git", ["show", `${PREVIOUS_REVISION}:packages/db/src/${name}`], {
          cwd: repository,
        }),
      );
    }
    const previous = await import(pathToFileURL(join(oldDirectory, "runtime-posture.ts")).href);
    const previousProvisioner = await import(
      pathToFileURL(join(oldDirectory, "provision-roles.ts")).href
    );
    await owned.admin.unsafe(`CREATE SCHEMA ${DATA_SCHEMA} AUTHORIZATION "${owned.ownerRole}"`);
    await owned.admin.unsafe(`ALTER EXTENSION vector SET SCHEMA ${DATA_SCHEMA}`);
    await staging`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    const heldBack = (await readdir(join(import.meta.dir, "../drizzle"))).filter(
      (name) => name.endsWith(".sql") && name >= MIGRATION,
    );
    for (const name of heldBack)
      await staging`insert into schema_migrations(name) values (${name})`;
    await migrate(owned.ownerUrl, DATA_SCHEMA, { applicationDatabaseRoles: ["opengeni_app"] });
    const roles = {
      appRole: "opengeni_app",
      appPassword: owned.appPassword,
      rlsStrategy: "force" as const,
      targetSchema: DATA_SCHEMA,
    };
    await previousProvisioner.provisionRoles(owned.adminUrl, roles);
    const appUrl = new URL(owned.ownerUrl);
    appUrl.username = roles.appRole;
    appUrl.password = roles.appPassword;
    client = createDb(appUrl.toString(), { searchPath: `${DATA_SCHEMA},opengeni_private,public` });
    const options = {
      expectedRole: roles.appRole,
      rlsStrategy: "force" as const,
      targetSchema: DATA_SCHEMA,
    };
    expect(
      previous.evaluateRuntimeDatabasePosture(
        await previous.inspectRuntimeDatabasePosture(client.db, options),
        options,
      ),
    ).toEqual([]);

    // The current provisioner must also converge the previous physical schema,
    // even though held-back migration receipts already include 0864. Its new
    // routine revocations are catalog-gated; current posture stays strict.
    await provisionRoles(owned.adminUrl, roles);
    const [historicalCapabilities] = await staging`
      select to_regprocedure('opengeni_private.set_slack_bot_workspace_access(uuid,uuid,uuid,text,boolean,uuid[])') as setter,
        to_regprocedure('opengeni_private.read_slack_bot_workspace_access(uuid,uuid,uuid)') as reader`;
    expect(historicalCapabilities).toEqual({ setter: null, reader: null });
    expect(
      previous.evaluateRuntimeDatabasePosture(
        await previous.inspectRuntimeDatabasePosture(client.db, options),
        options,
      ),
    ).toEqual([]);

    // Migration-only upgrade under the non-superuser, non-BYPASSRLS owner.
    // No reprovisioning follows the migration until the app has used the new setter.
    const source = await readFile(join(import.meta.dir, "../drizzle", MIGRATION), "utf8");
    await staging.begin((transaction) => transaction.unsafe(source));
    const oldPosture = await previous.inspectRuntimeDatabasePosture(client.db, options);
    expect(previous.evaluateRuntimeDatabasePosture(oldPosture, options)).toEqual([]);
    expect(oldPosture.identity).toMatchObject({
      currentUser: "opengeni_app",
      superuser: false,
      bypassRls: false,
    });
    for (const name of [
      "read_slack_bot_workspace_access(uuid, uuid, uuid)",
      "set_slack_bot_workspace_access(uuid, uuid, uuid, text, boolean, uuid[])",
    ]) {
      expect(
        oldPosture.privateRoutines.find((routine: { name: string }) => routine.name === name),
      ).toMatchObject({
        execute: true,
        publicExecute: false,
        securityDefiner: true,
        owner: owned.ownerRole,
        configuration: [`search_path=pg_catalog, ${DATA_SCHEMA}, pg_temp`],
      });
    }
    expect(
      oldPosture.privateTables.find(
        (table: { name: string }) => table.name === "organization_slack_bot_access",
      ),
    ).toMatchObject({
      rlsEnabled: true,
      rlsForced: true,
      rlsActive: true,
      select: false,
      insert: false,
      update: false,
      delete: false,
    });

    const accountId = crypto.randomUUID();
    const home = { accountId, workspaceId: crypto.randomUUID() };
    const target = { accountId, workspaceId: crypto.randomUUID() };
    const excluded = { accountId, workspaceId: crypto.randomUUID() };
    await owned.admin.unsafe(
      `insert into ${DATA_SCHEMA}.managed_accounts(id,name) values ($1,'Slack compatibility')`,
      [accountId],
    );
    for (const scope of [home, target, excluded]) {
      await owned.admin.unsafe(
        `insert into ${DATA_SCHEMA}.workspaces(id,account_id,name) values ($1,$2,'Slack workspace')`,
        [scope.workspaceId, accountId],
      );
    }
    const bot = await createConnection(client.db, {
      ...home,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: "fixture-only",
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
      verifiedInstallAt: new Date(),
      verifiedInstallVersion: 1,
      metadata: {
        credentialRole: "opengeni_slack_bot",
        credentialLabel: "OpenGeni Slack bot",
        slackTeamId: "T0COMPAT",
        slackTeamName: "Compatibility",
        botId: "B0COMPAT",
        botUserId: "U0COMPAT",
        botDisplayName: "OpenGeni",
        verifiedAt: new Date().toISOString(),
      },
    });
    const key = await createOrganizationApiKey(client.db, {
      accountId,
      name: "Slack administrator",
      prefix: "test",
      keyHash: crypto.randomUUID(),
      permissions: ["workspace:admin"],
    });
    const actor = { accountId, subjectId: `api_key:${key.id}` };
    const input = { ...home, connectionId: bot.id, enabled: true };
    const selected = await setOrganizationSlackBotAccess(
      client.db,
      {
        ...input,
        workspaceIds: [target.workspaceId, target.workspaceId],
      },
      async () => actor,
    );
    expect(selected).toMatchObject({ enabled: true, workspaceIds: [target.workspaceId] });
    expect(await readOrganizationSlackBotAccess(client.db, input)).toEqual(selected);
    expect(
      (await sharedOrganizationSlackBots(client.db, target)).map((row) => row.connectionId),
    ).toEqual([bot.id]);
    expect(await sharedOrganizationSlackBots(client.db, excluded)).toEqual([]);

    // The old API shape changes enabled only, preserving the narrowed audience.
    await setOrganizationSlackBotAccess(client.db, { ...input, enabled: false }, async () => actor);
    const reenabled = await setOrganizationSlackBotAccess(client.db, input, async () => actor);
    expect(reenabled.workspaceIds).toEqual([target.workspaceId]);
    expect(reenabled.generation).toBe(selected.generation + 2);
    expect(await sharedOrganizationSlackBots(client.db, excluded)).toEqual([]);
    await revokeOrganizationApiKey(client.db, accountId, key.id);
    const denied = await setOrganizationSlackBotAccess(
      client.db,
      {
        ...input,
        workspaceIds: null,
      },
      async () => actor,
    ).then(() => null, nestedPostgresSqlState);
    expect(denied).toBe("42501");
    expect(await readOrganizationSlackBotAccess(client.db, input)).toEqual(reenabled);

    // The capability guard must still reconcile unsafe ACL drift once the
    // routines exist, without removing the intended application grants.
    await staging`grant execute on function
      opengeni_private.set_slack_bot_workspace_access(uuid,uuid,uuid,text,boolean,uuid[]),
      opengeni_private.read_slack_bot_workspace_access(uuid,uuid,uuid) to public`;
    await provisionRoles(owned.adminUrl, roles);
    const [publicAccess] = await staging`
      select count(*)::int as grants from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where p.oid in (
        'opengeni_private.set_slack_bot_workspace_access(uuid,uuid,uuid,text,boolean,uuid[])'::regprocedure,
        'opengeni_private.read_slack_bot_workspace_access(uuid,uuid,uuid)'::regprocedure
      ) and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'`;
    expect(publicAccess).toEqual({ grants: 0 });
    // The current binary's posture is checked after the rest of the upgrade:
    // later migrations add routines it requires, so apply them and provision
    // again, as a deployment does before starting the current runtime.
    const later = heldBack.filter((name) => name > MIGRATION);
    if (later.length > 0)
      await staging`delete from schema_migrations where name in ${staging(later)}`;
    await migrate(owned.ownerUrl, DATA_SCHEMA, { applicationDatabaseRoles: ["opengeni_app"] });
    await provisionRoles(owned.adminUrl, roles);
    const currentPosture = await inspectRuntimeDatabasePosture(client.db, options);
    expect(evaluateRuntimeDatabasePosture(currentPosture, options)).toEqual([]);
    expect(
      previous.evaluateRuntimeDatabasePosture(
        await previous.inspectRuntimeDatabasePosture(client.db, options),
        options,
      ),
    ).toEqual([]);
  } finally {
    await client?.close();
    await staging.end();
    await owned.release();
    await rm(oldDirectory, { recursive: true, force: true });
  }
}, 180_000);
