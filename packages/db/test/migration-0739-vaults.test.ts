import { listLegacyVariableSets } from "./helpers/legacy-variable-sets";
// Migration 0739: vaults. Variable sets of every scope (with renamed names,
// collisions, revoked sets and a version-5 token) are staged on a database
// migrated without 0739, then 0739 is applied alone. Every active set must
// become a vault with the same ID and every variable an item with the same ID
// whose single stored version is byte-identical to the variable's ciphertext.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  readVaultFieldCiphertext,
  resolveSecretReferenceCandidates,
  listVaultsForSubject,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0739_vaults.sql";
const key = randomBytes(32);

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("vaults-migration");
  if (!database) throw new Error("Real PostgreSQL is required");
  const heldBack = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql") && file >= MIGRATION)
    .sort();
  const staging = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await staging`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of heldBack)
      await staging`insert into schema_migrations(name) values (${name})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await staging.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 2 });
});

afterAll(async () => {
  await client?.close();
  await database?.release();
});

type Seeded = {
  accountId: string;
  workspaceId: string;
  otherWorkspaceId: string;
  member: string;
  membershipId: string;
  sets: Record<string, { id: string; scope: string; name: string; status: string }>;
  plaintext: Map<string, string>;
  sessionId: string;
  leaseId: string;
};

// §B: persisted sandbox env carries set variable names next to constants.
const persistedEnvelope = {
  backendId: "docker",
  sessionState: {
    manifest: { root: "/workspace", environment: { API_KEY: "upper", HOME: "/home/agent" } },
    environment: { STRIPE_KEY: "sk_test_org", PATH: "/usr/bin" },
    providerState: {
      environment: { MULTILINE: "line one", GIT_TERMINAL_PROMPT: "0" },
      manifest: { environment: { DATABASE_URL: "postgres://fixture", LANG: "C.UTF-8" } },
    },
  },
  sessionsByAgent: {
    legacy: { sessionState: { environment: { GONE: "revoked value", TZ: "UTC" } } },
  },
};
const persistedResumeState = {
  backendId: "docker",
  sessionState: {
    providerState: { environment: { OPENAI_API_KEY: "sk-fixture-user", HOME: "/root" } },
    workspaceArchiveRef: { key: "kept" },
  },
};

async function seed(admin: postgres.Sql): Promise<Seeded> {
  const userId = `vaults-migration-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Vault migration",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const workspaceId = access.workspaceGrants[0]!.workspaceId;
  const member = `user:${userId}`;
  const [membership] = await admin<{ id: string }[]>`
    select id::text as id from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${member}`;
  const [other] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Vault migration shared')
    returning id::text as id`;
  const plaintext = new Map<string, string>();
  const sets: Seeded["sets"] = {};
  const createdAt = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

  const addSet = async (
    label: string,
    input: {
      scope: "workspace" | "user" | "organization";
      name: string;
      workspace?: string;
      status?: "active" | "revoked";
      minute: number;
      variables: Array<{ name: string; value: string; version?: number }>;
    },
  ) => {
    const id = crypto.randomUUID();
    const setWorkspace = input.workspace ?? workspaceId;
    let authorityId: string | null = null;
    if (input.scope === "user") {
      authorityId = crypto.randomUUID();
      await admin`
        insert into organization_user_resource_authorities
          (id, account_id, organization_membership_id, resource_kind, resource_id, origin_workspace_id)
        values (${authorityId}::uuid, ${accountId}::uuid, ${membership!.id}::uuid, 'variable_set', ${id}::uuid,
          ${setWorkspace}::uuid)`;
    }
    const revoked = input.status === "revoked";
    await admin`
      insert into workspace_variable_sets
        (id, account_id, workspace_id, name, description, authority_scope, authority_id,
         owner_organization_membership_id, origin_workspace_id, generation, status, revoked_at,
         created_at, updated_at)
      values (${id}::uuid, ${accountId}::uuid, ${setWorkspace}::uuid, ${input.name}, ${`set ${label}`},
        ${input.scope}, ${authorityId}::uuid,
        ${input.scope === "user" ? membership!.id : null}::uuid,
        ${input.scope === "workspace" ? null : setWorkspace}::uuid, 3,
        ${revoked ? "revoked" : "active"}, ${revoked ? createdAt(input.minute) : null}::timestamptz,
        ${createdAt(input.minute)}::timestamptz, ${createdAt(input.minute)}::timestamptz)`;
    let offset = 0;
    for (const variable of input.variables) {
      offset += 1;
      const variableId = crypto.randomUUID();
      plaintext.set(variableId, variable.value);
      await admin`
        insert into workspace_variable_set_variables
          (id, account_id, workspace_id, variable_set_id, name, value_encrypted, version, created_at, updated_at)
        values (${variableId}::uuid, ${accountId}::uuid, ${setWorkspace}::uuid, ${id}::uuid, ${variable.name},
          ${encryptEnvironmentValue(key, variable.value)}, ${variable.version ?? 1},
          ${createdAt(input.minute + offset)}::timestamptz, ${createdAt(input.minute + offset)}::timestamptz)`;
    }
    sets[label] = {
      id,
      scope: input.scope,
      name: input.name,
      status: input.status ?? "active",
    };
  };

  await addSet("prod", {
    scope: "workspace",
    name: "Prod",
    minute: 0,
    variables: [
      { name: "CLOUDGENI_GITHUB_TOKEN", value: "ghp_fixture-version-five", version: 5 },
      { name: "API_KEY", value: "upper-case key", version: 2 },
      { name: "api_key", value: "lower-case key ✓ \u0000 \ud83d\ude00", version: 3 },
    ],
  });
  // "prod" collides with "Prod" under the case-insensitive vault name key.
  await addSet("prodLower", {
    scope: "workspace",
    name: "prod",
    minute: 10,
    variables: [{ name: "DATABASE_URL", value: "postgres://fixture" }],
  });
  await addSet("slash", {
    scope: "workspace",
    name: "a/b",
    minute: 20,
    variables: [{ name: "TOKEN", value: "slash" }],
  });
  await addSet("brace", {
    scope: "workspace",
    name: "x}y",
    workspace: other!.id,
    minute: 30,
    variables: [{ name: "TOKEN", value: "brace", version: 7 }],
  });
  await addSet("mine", {
    scope: "user",
    name: "Mine",
    minute: 40,
    variables: [{ name: "OPENAI_API_KEY", value: "sk-fixture-user", version: 4 }],
  });
  await addSet("org", {
    scope: "organization",
    name: "Org keys",
    minute: 50,
    variables: [
      { name: "STRIPE_KEY", value: "sk_test_org" },
      { name: "MULTILINE", value: "line one\nline two\n" },
    ],
  });
  await addSet("revoked", {
    scope: "workspace",
    name: "Old",
    status: "revoked",
    minute: 60,
    variables: [{ name: "GONE", value: "should not copy" }],
  });

  const sessionId = crypto.randomUUID();
  const sandboxGroupId = crypto.randomUUID();
  // Fixture rows only: replica mode skips the session admission triggers.
  const lease = await admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into sessions (id, account_id, workspace_id, initial_message, model, sandbox_backend,
        sandbox_group_id, tool_policy, root_session_id, nested_agent_depth,
        effective_max_nested_agent_depth, nested_agent_depth_policy_source, reasoning_effort,
        latency_mode)
      values (${sessionId}::uuid, ${accountId}::uuid, ${workspaceId}::uuid, 'scrub fixture',
        'scripted-model', 'docker', ${sandboxGroupId}::uuid,
        '{"mode":"workspace_default","inheritedFromSessionId":null}'::jsonb, ${sessionId}::uuid, 0, 1,
        'deployment', 'low', 'standard')`;
    await tx`
      insert into sandbox_session_envelopes (account_id, workspace_id, session_id, envelope, envelope_codec_version)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid,
        ${admin.json(persistedEnvelope)}, 1)`;
    const [row] = await tx<{ id: string }[]>`
      insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, backend, expires_at, resume_state)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${sandboxGroupId}::uuid, 'docker',
        now() + interval '1 hour', ${admin.json(persistedResumeState)})
      returning id::text as id`;
    return row!;
  });

  return {
    accountId,
    workspaceId,
    otherWorkspaceId: other!.id,
    member,
    membershipId: membership!.id,
    sets,
    plaintext,
    sessionId,
    leaseId: lease.id,
  };
}

test.skipIf(!realDb)(
  "0739 copies every active variable set into a vault byte for byte",
  async () => {
    const admin = database!.admin;
    const seeded = await seed(admin);

    const before = await admin<
      { id: string; set_id: string; name: string; version: number; value_encrypted: string }[]
    >`
    select variable.id::text, variable.variable_set_id::text as set_id, variable.name, variable.version,
      variable.value_encrypted
    from workspace_variable_set_variables variable
    join workspace_variable_sets variable_set on variable_set.id = variable.variable_set_id
    where variable.account_id = ${seeded.accountId}::uuid and variable_set.status = 'active'
    order by variable.id`;
    expect(before).toHaveLength(9);
    const beforeSets = await listLegacyVariableSets(client!.db, {
      accountId: seeded.accountId,
      workspaceId: seeded.workspaceId,
      subjectId: seeded.member,
    });

    // DM-1: apply 0739 alone.
    await admin`delete from schema_migrations where name = ${MIGRATION}`;
    await migrate(database!.ownerUrl);
    await provisionRoles(database!.adminUrl, { appPassword: database!.appPassword });

    // DM-2: same IDs, same versions, byte-identical ciphertext.
    const after = await admin<
      {
        item_id: string;
        vault_id: string;
        item_name: string;
        type: string;
        field_name: string;
        kind: string;
        current_version: number;
        version: number;
        value_encrypted: string;
        created_by_kind: string;
        primary_matches: boolean;
      }[]
    >`
    select item.id::text as item_id, item.vault_id::text as vault_id, item.name as item_name, item.type,
      field.name as field_name, field.kind, field.current_version, version.version, version.value_encrypted,
      version.created_by_kind, item.primary_field_id = field.id as primary_matches
    from vault_items item
    join vault_item_fields field on field.item_id = item.id
    join vault_field_versions version on version.field_id = field.id
    where item.account_id = ${seeded.accountId}::uuid
    order by item.id`;
    expect(after).toHaveLength(before.length);
    for (const [index, old] of before.entries()) {
      const copied = after[index]!;
      expect(copied.item_id).toBe(old.id);
      expect(copied.vault_id).toBe(old.set_id);
      expect(copied.version).toBe(old.version);
      expect(copied.current_version).toBe(old.version);
      expect(Buffer.from(copied.value_encrypted).equals(Buffer.from(old.value_encrypted))).toBe(
        true,
      );
      expect(copied).toMatchObject({
        type: "api_key",
        field_name: "value",
        kind: "concealed",
        created_by_kind: "migration",
        primary_matches: true,
      });
      expect(decryptEnvironmentValue(key, copied.value_encrypted)).toBe(
        seeded.plaintext.get(old.id)!,
      );
    }
    const token = after.find((row) => row.item_name === "CLOUDGENI_GITHUB_TOKEN")!;
    expect(token.version).toBe(5);
    expect(token.current_version).toBe(5);

    // Vaults keep set IDs, scopes and generations; revoked sets are not copied (DM-3).
    const vaults = await admin<
      { id: string; owner_kind: string; name: string; workspace_id: string; generation: number }[]
    >`
    select id::text, owner_kind, name, workspace_id::text, generation from vaults
    where account_id = ${seeded.accountId}::uuid order by created_at`;
    expect(vaults.map((vault) => vault.id)).toEqual(
      ["prod", "prodLower", "slash", "brace", "mine", "org"].map((label) => seeded.sets[label]!.id),
    );
    expect(vaults.map((vault) => [vault.owner_kind, vault.name])).toEqual([
      ["workspace", "Prod"],
      ["workspace", "prod (2)"],
      ["workspace", "a-b"],
      ["workspace", "x-y"],
      ["user", "Mine"],
      ["organization", "Org keys"],
    ]);
    expect(vaults.every((vault) => Number(vault.generation) === 3)).toBe(true);
    expect(vaults.some((vault) => vault.id === seeded.sets.revoked!.id)).toBe(false);

    // DM-4: the renamed vault and item keep their old names as aliases.
    const vaultAliases = await admin<{ vault_id: string; name_key: string }[]>`
    select vault_id::text, name_key from vault_name_aliases
    where account_id = ${seeded.accountId}::uuid order by name_key`;
    expect([...vaultAliases]).toEqual([
      { vault_id: seeded.sets.slash!.id, name_key: "a/b" },
      { vault_id: seeded.sets.prodLower!.id, name_key: "prod" },
      { vault_id: seeded.sets.brace!.id, name_key: "x}y" },
    ]);
    const renamedItem = after.find((row) => row.item_name === "api_key (2)")!;
    expect(renamedItem).toBeDefined();
    const itemAliases = await admin<{ item_id: string; name_key: string }[]>`
    select item_id::text, name_key from vault_item_name_aliases where account_id = ${seeded.accountId}::uuid`;
    expect([...itemAliases]).toEqual([{ item_id: renamedItem.item_id, name_key: "api_key" }]);

    // The user vault has its own authority; the set keeps its own.
    const authorities = await admin<
      { resource_kind: string; resource_id: string; status: string }[]
    >`
    select resource_kind, resource_id::text, status from organization_user_resource_authorities
    where account_id = ${seeded.accountId}::uuid and resource_id = ${seeded.sets.mine!.id}::uuid
    order by resource_kind`;
    expect([...authorities]).toEqual([
      { resource_kind: "variable_set", resource_id: seeded.sets.mine!.id, status: "active" },
      { resource_kind: "vault", resource_id: seeded.sets.mine!.id, status: "active" },
    ]);

    // DM-3: one summary audit row (database-wide counts).
    const [audit] = await admin<{ metadata: Record<string, unknown>; subject_id: string }[]>`
    select metadata, subject_id from audit_events where action = 'vault.migrated'`;
    expect(audit!.subject_id).toBe("system:migration:0739");
    expect(audit!.metadata).toMatchObject({
      migration: MIGRATION,
      vaults: 6,
      items: 9,
      versions: 9,
      skippedRevokedSets: 1,
      renamedVaults: 3,
      renamedItems: 1,
    });

    // §B: every value is gone (revoked sets too); set headers stay for the
    // scheduled-run admission fences.
    const [remaining] = await admin<{ count: number }[]>`
    select count(*)::int as count from workspace_variable_set_variables`;
    expect(remaining!.count).toBe(0);
    const [headers] = await admin<{ count: number }[]>`
    select count(*)::int as count from workspace_variable_sets where account_id = ${seeded.accountId}::uuid`;
    expect(headers!.count).toBe(Object.keys(seeded.sets).length);
    const [retired] = await admin<{ metadata: Record<string, unknown> }[]>`
    select metadata from audit_events where action = 'variable_set.values_retired'`;
    expect(retired!.metadata).toMatchObject({
      migration: MIGRATION,
      removedValues: 10,
      scrubbedEnvelopes: 1,
      scrubbedLeases: 1,
    });
    // §B: variable names leave persisted env; constants and other state stay,
    // and the lossless codec marker is kept.
    const [envelope] = await admin<{ envelope: unknown; codec: number | null }[]>`
    select envelope, envelope_codec_version as codec from sandbox_session_envelopes
    where session_id = ${seeded.sessionId}::uuid`;
    expect(envelope!.codec).toBe(1);
    expect(envelope!.envelope).toEqual({
      backendId: "docker",
      sessionState: {
        manifest: { root: "/workspace", environment: { HOME: "/home/agent" } },
        environment: { PATH: "/usr/bin" },
        providerState: {
          environment: { GIT_TERMINAL_PROMPT: "0" },
          manifest: { environment: { LANG: "C.UTF-8" } },
        },
      },
      sessionsByAgent: { legacy: { sessionState: { environment: { TZ: "UTC" } } } },
    });
    const [lease] = await admin<{ resume_state: unknown }[]>`
    select resume_state from sandbox_leases where id = ${seeded.leaseId}::uuid`;
    expect(lease!.resume_state).toEqual({
      backendId: "docker",
      sessionState: {
        providerState: { environment: { HOME: "/root" } },
        workspaceArchiveRef: { key: "kept" },
      },
    });
    const [triggers] = await admin<{ disabled: number }[]>`
    select count(*)::int as disabled from pg_trigger
    where tgrelid = 'sandbox_leases'::regclass and not tgisinternal and tgenabled = 'D'`;
    expect(triggers!.disabled).toBe(0);
    const [helper] = await admin<{ count: number }[]>`
    select count(*)::int as count from pg_proc where proname = 'vault_scrub_entry_environment'`;
    expect(helper!.count).toBe(0);

    // Variable set headers keep listing alongside vaults.
    const afterSets = await listLegacyVariableSets(client!.db, {
      accountId: seeded.accountId,
      workspaceId: seeded.workspaceId,
      subjectId: seeded.member,
    });
    expect(afterSets.map((set) => set.id).sort()).toEqual(beforeSets.map((set) => set.id).sort());

    // The application role sees migrated items through the vault routines and
    // reads the identical ciphertext (DM-2, through the new read path).
    const context = {
      kind: "subject" as const,
      accountId: seeded.accountId,
      workspaceId: seeded.workspaceId,
      subjectId: seeded.member,
    };
    const listed = await listVaultsForSubject(client!.db, context, {
      workspaceId: seeded.workspaceId,
    });
    expect(listed.map((vault) => vault.name)).toEqual([
      "Mine",
      "a-b",
      "Prod",
      "prod (2)",
      "Org keys",
    ]);
    const tokenField = await admin<{ id: string }[]>`
    select field.id::text from vault_item_fields field where field.item_id = ${token.item_id}::uuid`;
    const read = await readVaultFieldCiphertext(client!.db, context, {
      fieldId: tokenField[0]!.id,
      purpose: "internal",
    });
    expect(read.valueEncrypted).toBe(token.value_encrypted);
    expect(read.version).toBe(5);
    const candidates = await resolveSecretReferenceCandidates(
      client!.db,
      {
        kind: "principal",
        principal: {
          kind: "human",
          accountId: seeded.accountId,
          workspaceId: seeded.workspaceId,
          subjectId: seeded.member,
          verifiedHuman: true,
          viaApiKey: false,
        },
      },
      {
        refs: [
          {
            index: 0,
            form: "path",
            segments: ["CLOUDGENI_GITHUB_TOKEN"],
            otp: false,
            previous: false,
          },
          {
            index: 1,
            form: "path",
            segments: ["prod", "DATABASE_URL"],
            otp: false,
            previous: false,
          },
          { index: 2, form: "path", segments: ["api_key"], otp: false, previous: false },
        ],
      },
    );
    const byRef = (index: number) => candidates.candidates.filter((row) => row.refIndex === index);
    expect(byRef(0).map((row) => [row.itemId, row.version])).toEqual([[token.item_id, 5]]);
    // "prod" is the current name of "Prod" and an alias of "prod (2)"; only the
    // alias holds DATABASE_URL.
    expect(byRef(1).map((row) => [row.vaultId, row.matchedBy, row.interpretation])).toEqual([
      [seeded.sets.prodLower!.id, "alias", "vault_item"],
    ]);
    expect(
      byRef(2)
        .map((row) => row.matchedBy)
        .sort(),
    ).toEqual(["alias", "name"]);

    // Row security: forced on every new table, and the app role has no direct access.
    const posture = await admin<{ relname: string; forced: boolean; app_select: boolean }[]>`
    select relname, relforcerowsecurity as forced,
      has_table_privilege('opengeni_app', oid, 'SELECT') as app_select
    from pg_class where relname in ('vaults', 'vault_items', 'vault_item_fields', 'vault_field_versions',
      'vault_item_name_aliases', 'vault_name_aliases', 'vault_passkey_leases') order by relname`;
    expect(posture).toHaveLength(7);
    expect(posture.every((row) => row.forced && !row.app_select)).toBe(true);
  },
);
