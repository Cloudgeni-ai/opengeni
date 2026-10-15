// Migration 0786: external vault sources. Linked vaults of every existing
// kind are staged on a database migrated as its non-bypass owner without
// 0786; then 0786 is applied. Existing links keep their meaning, new sources
// link only through an active connection of the same provider whose ownership
// matches the vault, and linked vaults record provider operations, the
// provider's own freshness observation and a durable value-cache epoch.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import type { VaultProviderOperations } from "@opengeni/contracts";
import {
  createConnection,
  createDb,
  createVault,
  createWorkspace,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  getProviderVaultSyncTarget,
  getVault,
  getVaultItem,
  isVaultError,
  linkProviderVault,
  listVaultItems,
  readVaultFieldCiphertext,
  resolveSecretReferenceCandidates,
  setVaultSyncStatus,
  upsertProviderVaultItems,
  type DbClient,
  type ProviderVaultItemMirror,
  type VaultDbContext,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0786_external_vault_sources.sql";
const key = Buffer.alloc(32, 7);

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

const OPERATIONS: VaultProviderOperations = {
  createItemTypes: ["login", "api_key", "note"],
  updateItem: true,
  removeField: true,
  archiveItem: true,
  archiveKind: "archive",
  deleteItem: false,
  restoreItem: false,
  readFiles: false,
  writeFiles: false,
  createTotp: true,
  updateTotp: true,
  createVault: false,
  restoreFieldHistory: false,
};

type Tenant = Awaited<ReturnType<typeof tenant>>;

async function tenant(label: string) {
  const db = client!.db;
  const user = `vault-0786-${label}-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId: user,
    email: `${user}@example.test`,
    name: "Vault 0786",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const subjectId = `user:${user}`;
  const workspace = await createWorkspace(db, { accountId, name: `Vaults ${label}` });
  const context: VaultDbContext = {
    kind: "subject",
    accountId,
    workspaceId: workspace.id,
    subjectId,
  };
  return { db, accountId, subjectId, workspaceId: workspace.id, context };
}

/** Another active member of the tenant's organization (for foreign personal connections). */
async function member(t: Tenant): Promise<string> {
  const admin = database!.admin;
  const subjectId = `user:vault-0786-member-${crypto.randomUUID()}`;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${t.accountId}::uuid, 'Personal')
    returning id::text as id`;
  await admin`
    insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
    values (${t.accountId}::uuid, ${subjectId}, 'active', 'member', ${personal!.id}::uuid)`;
  await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${t.accountId}::uuid, ${t.workspaceId}::uuid, ${subjectId}, 'member',
      ${JSON.stringify(["secrets:use", "secrets:write"])}::text::jsonb)`;
  return subjectId;
}

async function onePasswordConnection(
  t: Pick<Tenant, "db" | "accountId" | "workspaceId" | "subjectId">,
  options: { personal?: boolean; ownership?: string; status?: "active" | "needs_reauth" } = {},
) {
  return await createConnection(t.db, {
    accountId: t.accountId,
    workspaceId: t.workspaceId,
    subjectId: options.personal ? t.subjectId : null,
    providerDomain: "1password.com",
    kind: "api_key",
    status: options.status ?? "active",
    credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify({ token: "redacted" })),
    grantedScopes: [],
    expiresAt: null,
    metadata: {
      credentialRole: "onepassword_service_account",
      planTier: "family",
      ...(options.ownership ? { ownership: options.ownership } : {}),
    },
    createdBySubjectId: t.subjectId,
  });
}

async function externalConnection(
  t: Pick<Tenant, "db" | "accountId" | "workspaceId" | "subjectId">,
  options: {
    provider?: string;
    domainProvider?: string;
    ownership?: "user" | "workspace" | "organization";
    subjectId?: string | null;
    status?: "active" | "needs_reauth" | "revoked" | "error";
    verificationStatus?: "ready" | "pending";
    version?: number;
    credentialRole?: string;
    kind?: "api_key" | "oauth2";
  } = {},
) {
  const provider = options.provider ?? "keeper";
  const ownership = options.ownership ?? "workspace";
  return await createConnection(t.db, {
    accountId: t.accountId,
    workspaceId: t.workspaceId,
    subjectId:
      options.subjectId !== undefined
        ? options.subjectId
        : ownership === "user"
          ? t.subjectId
          : null,
    providerDomain: `vault:${options.domainProvider ?? provider}`,
    kind: options.kind ?? "api_key",
    status: options.status ?? "active",
    credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify({ provider, token: "x" })),
    grantedScopes: [],
    expiresAt: null,
    metadata: {
      credentialRole: options.credentialRole ?? "external_vault_provider",
      vaultProvider: {
        version: options.version ?? 1,
        provider,
        ownership,
        accountId: null,
        accountName: "Example",
        label: null,
        verifiedAt: new Date().toISOString(),
        operations: OPERATIONS,
        ...(options.verificationStatus ? { verificationStatus: options.verificationStatus } : {}),
      },
    },
    createdBySubjectId: t.subjectId,
  });
}

async function expectVaultError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    if (!isVaultError(error)) throw error;
    expect(error.code as string).toBe(code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

function mirrorItem(ref: string, name: string): ProviderVaultItemMirror {
  return {
    providerItemRef: ref,
    providerVersion: "1",
    type: "login",
    name,
    primaryFieldRef: "password",
    fields: [
      { providerFieldRef: "username", name: "username", kind: "text" },
      { providerFieldRef: "password", name: "password", kind: "concealed" },
    ],
  };
}

type Legacy = {
  tenant: Tenant;
  onePasswordVaultId: string;
  personalVaultId: string;
  hostVaultId: string;
  hostedVaultId: string;
  organizationVaultId: string;
};
let legacy: Legacy | null = null;

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("external-vault-sources");
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

  // Before 0786: every kind of linked vault, through the old routines.
  const t = await tenant("legacy");
  const shared = await onePasswordConnection(t);
  const personal = await onePasswordConnection(t, { personal: true });
  const onePassword = await linkProviderVault(t.db, t.context, {
    ownerKind: "workspace",
    name: "Legacy 1Password",
    source: "onepassword",
    providerConnectionId: shared.id,
    providerVaultRef: "legacyvault01",
    mode: "read_write",
  });
  await upsertProviderVaultItems(t.db, t.context, {
    vaultId: onePassword.id,
    contentVersion: "4",
    items: [mirrorItem("item01", "Deploy key")],
  });
  const personalVault = await linkProviderVault(t.db, t.context, {
    ownerKind: "user",
    name: "Legacy personal",
    source: "onepassword",
    providerConnectionId: personal.id,
    providerVaultRef: "personalvault01",
    mode: "read_only",
  });
  const host = await linkProviderVault(t.db, t.context, {
    ownerKind: "workspace",
    name: "Legacy host",
    source: "host",
    providerVaultRef: "host-vault",
    mode: "read_only",
  });
  const hosted = await createVault(t.db, t.context, { name: "Hosted", ownerKind: "workspace" });
  // Historical data: an organization vault behind a workspace 1Password connection.
  const [organization] = await database.admin<{ id: string }[]>`
    insert into vaults (
      account_id, workspace_id, owner_kind, origin_workspace_id, name, source, mode,
      provider_connection_id, provider_vault_ref
    ) values (
      ${t.accountId}::uuid, ${t.workspaceId}::uuid, 'organization', ${t.workspaceId}::uuid,
      'Legacy organization', 'onepassword', 'read_only', ${shared.id}::uuid, 'orgvault01'
    ) returning id::text as id`;
  legacy = {
    tenant: t,
    onePasswordVaultId: onePassword.id,
    personalVaultId: personalVault.id,
    hostVaultId: host.id,
    hostedVaultId: hosted.id,
    organizationVaultId: organization!.id,
  };

  // Apply 0786 (and anything after it) as the owner.
  await database.admin`delete from schema_migrations where name >= ${MIGRATION}`;
  await migrate(database.ownerUrl);
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
}, 300_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await database?.release();
}, 180_000);

describe.skipIf(!realDb)("0786 external vault sources", () => {
  test("existing links keep their meaning and gain empty provider metadata", async () => {
    const { tenant: t, ...ids } = legacy!;
    const onePassword = await getVault(t.db, t.context, { vaultId: ids.onePasswordVaultId });
    expect(onePassword).toMatchObject({
      source: "onepassword",
      mode: "read_write",
      syncStatus: "ok",
      providerVaultRef: "legacyvault01",
      providerOperations: null,
      providerFreshness: null,
      providerCacheEpoch: "0",
      itemCount: 1,
    });
    expect(await getVault(t.db, t.context, { vaultId: ids.personalVaultId })).toMatchObject({
      ownerKind: "user",
      source: "onepassword",
      providerCacheEpoch: "0",
    });
    expect(await getVault(t.db, t.context, { vaultId: ids.hostVaultId })).toMatchObject({
      source: "host",
      providerConnectionId: null,
      providerCacheEpoch: "0",
    });
    expect(await getVault(t.db, t.context, { vaultId: ids.hostedVaultId })).toMatchObject({
      source: "opengeni",
      providerOperations: null,
      providerFreshness: null,
      providerCacheEpoch: "0",
    });
    // Historical rows are not revalidated against the stricter link rule.
    expect(await getVault(t.db, t.context, { vaultId: ids.organizationVaultId })).toMatchObject({
      ownerKind: "organization",
      source: "onepassword",
    });
    // The legacy mirror keeps syncing, and replacing it advances the epoch.
    await upsertProviderVaultItems(t.db, t.context, {
      vaultId: ids.onePasswordVaultId,
      contentVersion: "5",
      items: [mirrorItem("item01", "Deploy key"), mirrorItem("item02", "Database")],
    });
    expect(await getProviderVaultSyncTarget(t.db, t.context, ids.onePasswordVaultId)).toEqual({
      vaultId: ids.onePasswordVaultId,
      workspaceId: t.workspaceId,
      source: "onepassword",
      mode: "read_write",
      providerConnectionId: onePassword.providerConnectionId,
      providerVaultRef: "legacyvault01",
      providerContentVersion: "5",
      providerCacheEpoch: "1",
      rateLimitedUntil: null,
    });
  });

  test("the vault table accepts the new sources only in their provider shape", async () => {
    const admin = database!.admin;
    const constraints = await admin<{ name: string; definition: string }[]>`
      select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'vaults'::regclass
        and conname in ('vaults_source_check', 'vaults_provider_shape', 'vaults_provider_metadata_shape')
      order by conname`;
    expect(constraints.map((row) => row.name)).toEqual([
      "vaults_provider_metadata_shape",
      "vaults_provider_shape",
      "vaults_source_check",
    ]);
    for (const source of ["external", "protonpass", "keeper", "bitwarden"]) {
      expect(constraints.find((row) => row.name === "vaults_source_check")!.definition).toContain(
        `'${source}'`,
      );
    }
    const { hostVaultId, hostedVaultId } = legacy!;
    // A connected source needs a connection; hosted vaults carry no provider metadata.
    // postgres-js queries are lazy Promise subclasses: assimilate them first, or
    // Bun's rejection matcher waits without ever starting the SQL.
    await expect(
      Promise.resolve(admin`update vaults set source = 'keeper' where id = ${hostVaultId}::uuid`),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      Promise.resolve(admin`update vaults set source = 'lastpass' where id = ${hostVaultId}::uuid`),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      Promise.resolve(
        admin`update vaults set provider_operations = '{}'::jsonb where id = ${hostedVaultId}::uuid`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      Promise.resolve(
        admin`update vaults set provider_freshness = '[]'::jsonb where id = ${hostVaultId}::uuid`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      Promise.resolve(
        admin`update vaults set provider_cache_epoch = -1 where id = ${hostVaultId}::uuid`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("external sources link only through an active connection of the same provider", async () => {
    const t = await tenant("identity");
    const keeper = await externalConnection(t, { provider: "keeper" });
    const linked = await linkProviderVault(t.db, t.context, {
      ownerKind: "workspace",
      name: "Keeper shared",
      source: "keeper",
      providerConnectionId: keeper.id,
      providerVaultRef: "keeper-folder-1",
      mode: "read_write",
    });
    expect(linked).toMatchObject({
      source: "keeper",
      providerConnectionId: keeper.id,
      providerVaultRef: "keeper-folder-1",
      syncStatus: "syncing",
      providerOperations: null,
      providerCacheEpoch: "0",
    });
    // Each provider connection backs only its own source.
    for (const source of ["protonpass", "bitwarden", "external", "onepassword"] as const) {
      await expectVaultError(
        linkProviderVault(t.db, t.context, {
          ownerKind: "workspace",
          name: `Wrong ${source}`,
          source,
          providerConnectionId: keeper.id,
          providerVaultRef: `wrong-${source}`,
          mode: "read_only",
        }),
        "vault_not_found",
      );
    }
    // The domain and the recorded provider must agree, at a known metadata version.
    const mismatched = await externalConnection(t, {
      provider: "bitwarden",
      domainProvider: "keeper",
    });
    for (const source of ["keeper", "bitwarden"] as const) {
      await expectVaultError(
        linkProviderVault(t.db, t.context, {
          ownerKind: "workspace",
          name: `Mismatched ${source}`,
          source,
          providerConnectionId: mismatched.id,
          providerVaultRef: "mismatch",
          mode: "read_only",
        }),
        "vault_not_found",
      );
    }
    const future = await externalConnection(t, { provider: "protonpass", version: 2 });
    await expectVaultError(
      linkProviderVault(t.db, t.context, {
        ownerKind: "workspace",
        name: "Future metadata",
        source: "protonpass",
        providerConnectionId: future.id,
        providerVaultRef: "share-1",
        mode: "read_only",
      }),
      "vault_not_found",
    );
    // Another credential role or connection kind on the same domain is not a vault provider.
    for (const other of [
      await externalConnection(t, { provider: "protonpass", credentialRole: "api_integration" }),
      await externalConnection(t, { provider: "protonpass", kind: "oauth2" }),
    ]) {
      await expectVaultError(
        linkProviderVault(t.db, t.context, {
          ownerKind: "workspace",
          name: "Other role",
          source: "protonpass",
          providerConnectionId: other.id,
          providerVaultRef: "share-2",
          mode: "read_only",
        }),
        "vault_not_found",
      );
    }
    // A connected source always needs its connection.
    await expectVaultError(
      linkProviderVault(t.db, t.context, {
        ownerKind: "workspace",
        name: "No connection",
        source: "bitwarden",
        providerVaultRef: "collection-1",
        mode: "read_only",
      }),
      "vault_not_found",
    );
    // Unknown sources stay refused.
    await expectVaultError(
      linkProviderVault(t.db, t.context, {
        ownerKind: "workspace",
        name: "Unknown",
        source: "lastpass" as never,
        providerConnectionId: keeper.id,
        providerVaultRef: "x",
        mode: "read_only",
      }),
      "vault_permission_denied",
    );
    // One provider vault is linked once per account and connection.
    await expectVaultError(
      linkProviderVault(t.db, t.context, {
        ownerKind: "workspace",
        name: "Keeper again",
        source: "keeper",
        providerConnectionId: keeper.id,
        providerVaultRef: "keeper-folder-1",
        mode: "read_only",
      }),
      "vault_name_conflict",
    );
  });

  test("inactive, pending and revoked connections never link", async () => {
    const t = await tenant("status");
    const link = (connectionId: string, source: "bitwarden" | "onepassword" = "bitwarden") =>
      linkProviderVault(t.db, t.context, {
        ownerKind: "workspace",
        name: `Status ${crypto.randomUUID().slice(0, 8)}`,
        source,
        providerConnectionId: connectionId,
        providerVaultRef: `ref-${crypto.randomUUID()}`,
        mode: "read_only",
      });
    const reauth = await externalConnection(t, { provider: "bitwarden", status: "needs_reauth" });
    const failed = await externalConnection(t, { provider: "bitwarden", status: "error" });
    const pending = await externalConnection(t, {
      provider: "bitwarden",
      verificationStatus: "pending",
    });
    const revoked = await externalConnection(t, { provider: "bitwarden", status: "revoked" });
    const expired1Password = await onePasswordConnection(t, { status: "needs_reauth" });
    await expectVaultError(link(reauth.id), "provider_auth_expired");
    await expectVaultError(link(failed.id), "provider_auth_expired");
    await expectVaultError(link(pending.id), "provider_auth_expired");
    await expectVaultError(link(revoked.id), "vault_not_found");
    await expectVaultError(link(expired1Password.id, "onepassword"), "provider_auth_expired");
    const ready = await externalConnection(t, {
      provider: "bitwarden",
      verificationStatus: "ready",
    });
    expect((await link(ready.id)).source).toBe("bitwarden");
  });

  test("ownership must match: personal connections back only their owner's Only-me vaults", async () => {
    const t = await tenant("ownership");
    const organization = await externalConnection(t, { ownership: "organization" });
    const workspace = await externalConnection(t, { ownership: "workspace" });
    const personal = await externalConnection(t, { ownership: "user" });
    const link = (
      connectionId: string,
      ownerKind: "user" | "workspace" | "organization",
      context = t.context,
    ) =>
      linkProviderVault(t.db, context, {
        ownerKind,
        name: `Owned ${crypto.randomUUID().slice(0, 8)}`,
        source: "keeper",
        providerConnectionId: connectionId,
        providerVaultRef: `ref-${crypto.randomUUID()}`,
        mode: "read_only",
        allowOrganization: true,
      });
    // An organization connection never becomes a workspace or personal one, and back.
    await expectVaultError(link(organization.id, "workspace"), "vault_permission_denied");
    await expectVaultError(link(organization.id, "user"), "vault_permission_denied");
    await expectVaultError(link(workspace.id, "organization"), "vault_permission_denied");
    await expectVaultError(link(workspace.id, "user"), "vault_permission_denied");
    await expectVaultError(link(personal.id, "workspace"), "vault_permission_denied");
    await expectVaultError(link(personal.id, "organization"), "vault_permission_denied");
    expect((await link(organization.id, "organization")).ownerKind).toBe("organization");
    expect((await link(workspace.id, "workspace")).ownerKind).toBe("workspace");
    const mine = await link(personal.id, "user");
    expect(mine.ownerKind).toBe("user");
    // 0780: a new Only-me vault starts in the workspace it was linked from.
    expect(mine.availability).toEqual({
      allowedWorkspaceIds: [t.workspaceId],
      allowPersonalWorkspaces: true,
    });
    const everywhere = await linkProviderVault(t.db, t.context, {
      ownerKind: "user",
      name: "Keeper everywhere",
      source: "keeper",
      providerConnectionId: personal.id,
      providerVaultRef: "everywhere",
      mode: "read_only",
      availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
    });
    expect(everywhere.availability).toEqual({
      allowedWorkspaceIds: null,
      allowPersonalWorkspaces: true,
    });

    // Another member's personal connection backs none of the caller's vaults.
    const other = await member(t);
    const theirs = await externalConnection(
      { ...t, subjectId: other },
      { ownership: "user", subjectId: other },
    );
    await expectVaultError(link(theirs.id, "user"), "vault_permission_denied");
    const theirContext: VaultDbContext = { ...t.context, subjectId: other };
    expect((await link(theirs.id, "user", theirContext)).ownerKind).toBe("user");
    // The caller's own personal connection is not theirs either.
    await expectVaultError(link(personal.id, "user", theirContext), "vault_permission_denied");

    // Recorded ownership must agree with the row's subject.
    const inconsistentShared = await externalConnection(t, { ownership: "user", subjectId: null });
    await expectVaultError(link(inconsistentShared.id, "workspace"), "vault_permission_denied");
    await expectVaultError(link(inconsistentShared.id, "user"), "vault_permission_denied");
    const inconsistentPersonal = await externalConnection(t, {
      ownership: "workspace",
      subjectId: t.subjectId,
    });
    await expectVaultError(link(inconsistentPersonal.id, "workspace"), "vault_permission_denied");
    await expectVaultError(link(inconsistentPersonal.id, "user"), "vault_permission_denied");
  });

  test("1Password keeps its connection identity; its recorded ownership now has to match", async () => {
    const t = await tenant("onepassword");
    const link = (connectionId: string, ownerKind: "user" | "workspace" | "organization") =>
      linkProviderVault(t.db, t.context, {
        ownerKind,
        name: `1P ${crypto.randomUUID().slice(0, 8)}`,
        source: "onepassword",
        providerConnectionId: connectionId,
        providerVaultRef: `vault${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        mode: "read_only",
        allowOrganization: true,
      });
    // No recorded ownership: a workspace connection, as the API has always shown it.
    const unrecorded = await onePasswordConnection(t);
    expect((await link(unrecorded.id, "workspace")).source).toBe("onepassword");
    await expectVaultError(link(unrecorded.id, "organization"), "vault_permission_denied");
    const organization = await onePasswordConnection(t, { ownership: "organization" });
    expect((await link(organization.id, "organization")).ownerKind).toBe("organization");
    await expectVaultError(link(organization.id, "workspace"), "vault_permission_denied");
    const personal = await onePasswordConnection(t, { personal: true, ownership: "user" });
    expect((await link(personal.id, "user")).ownerKind).toBe("user");
    await expectVaultError(link(personal.id, "workspace"), "vault_permission_denied");
    // A shared connection that claims a personal owner is inconsistent.
    const claimsUser = await onePasswordConnection(t, { ownership: "user" });
    await expectVaultError(link(claimsUser.id, "user"), "vault_permission_denied");
    // Not a 1Password service account, or not a 1Password domain: not found.
    const keeper = await externalConnection(t, { provider: "keeper" });
    await expectVaultError(link(keeper.id, "workspace"), "vault_not_found");
    const [foreignRole] = await database!.admin<{ id: string }[]>`
      update connections set metadata = metadata || '{"credentialRole":"other"}'::jsonb
      where id = ${unrecorded.id}::uuid returning id::text as id`;
    await expectVaultError(link(foreignRole!.id, "workspace"), "vault_not_found");
  });

  test("connections in another workspace or tenant are never found", async () => {
    const t = await tenant("isolation");
    const otherWorkspace = await createWorkspace(t.db, { accountId: t.accountId, name: "Other" });
    const elsewhere = await externalConnection({ ...t, workspaceId: otherWorkspace.id });
    const foreignTenant = await tenant("foreign");
    const foreign = await externalConnection(foreignTenant);
    const foreign1Password = await onePasswordConnection(foreignTenant);
    for (const connection of [elsewhere, foreign]) {
      await expectVaultError(
        linkProviderVault(t.db, t.context, {
          ownerKind: "workspace",
          name: "Elsewhere",
          source: "keeper",
          providerConnectionId: connection.id,
          providerVaultRef: "elsewhere",
          mode: "read_only",
        }),
        "vault_not_found",
      );
    }
    await expectVaultError(
      linkProviderVault(t.db, t.context, {
        ownerKind: "workspace",
        name: "Foreign 1Password",
        source: "onepassword",
        providerConnectionId: foreign1Password.id,
        providerVaultRef: "foreignvault",
        mode: "read_only",
      }),
      "vault_not_found",
    );
    // Linked vaults of one tenant are not reachable from another.
    const keeper = await externalConnection(t);
    const linked = await linkProviderVault(t.db, t.context, {
      ownerKind: "workspace",
      name: "Tenant keeper",
      source: "keeper",
      providerConnectionId: keeper.id,
      providerVaultRef: "tenant-folder",
      mode: "read_only",
    });
    await expectVaultError(
      getProviderVaultSyncTarget(foreignTenant.db, foreignTenant.context, linked.id),
      "vault_not_found",
    );
    await expectVaultError(
      setVaultSyncStatus(foreignTenant.db, foreignTenant.context, {
        vaultId: linked.id,
        status: "ok",
        operations: OPERATIONS,
      }),
      "vault_not_found",
    );
  });

  test("sync status records operations and the provider's freshness observation", async () => {
    const t = await tenant("metadata");
    const keeper = await externalConnection(t);
    const linked = await linkProviderVault(t.db, t.context, {
      ownerKind: "workspace",
      name: "Keeper metadata",
      source: "keeper",
      providerConnectionId: keeper.id,
      providerVaultRef: "metadata-folder",
      mode: "read_write",
    });
    const observed = { source: "cache" as const, sourceSyncedAt: "2026-10-15T08:00:00.000Z" };
    await setVaultSyncStatus(t.db, t.context, {
      vaultId: linked.id,
      status: "ok",
      operations: OPERATIONS,
      freshness: observed,
    });
    const ok = await getVault(t.db, t.context, { vaultId: linked.id });
    expect(ok).toMatchObject({
      syncStatus: "ok",
      providerOperations: OPERATIONS,
      providerFreshness: observed,
    });
    expect(ok.lastSyncedAt).not.toBeNull();
    // A failure keeps what the provider last reported.
    await setVaultSyncStatus(t.db, t.context, {
      vaultId: linked.id,
      status: "error",
      errorCode: "provider_unavailable",
      errorMessage: "down",
    });
    expect(await getVault(t.db, t.context, { vaultId: linked.id })).toMatchObject({
      syncStatus: "error",
      syncErrorCode: "provider_unavailable",
      lastSyncedAt: ok.lastSyncedAt,
      providerOperations: OPERATIONS,
      providerFreshness: observed,
    });
    // Null clears.
    await setVaultSyncStatus(t.db, t.context, {
      vaultId: linked.id,
      status: "ok",
      operations: null,
      freshness: null,
    });
    expect(await getVault(t.db, t.context, { vaultId: linked.id })).toMatchObject({
      providerOperations: null,
      providerFreshness: null,
    });
    await expectVaultError(
      setVaultSyncStatus(t.db, t.context, {
        vaultId: linked.id,
        status: "ok",
        operations: [] as never,
      }),
      "vault_permission_denied",
    );
    await expectVaultError(
      setVaultSyncStatus(t.db, t.context, {
        vaultId: linked.id,
        status: "ok",
        freshness: { source: "live", sourceSyncedAt: "x".repeat(2000) },
      }),
      "vault_permission_denied",
    );
    const hosted = await createVault(t.db, t.context, { name: "Hosted", ownerKind: "workspace" });
    await expectVaultError(
      setVaultSyncStatus(t.db, t.context, {
        vaultId: hosted.id,
        status: "ok",
        operations: OPERATIONS,
      }),
      "vault_permission_denied",
    );
  });

  test("complete mirrors advance the cache epoch that reads and resolutions carry", async () => {
    const t = await tenant("epoch");
    const keeper = await externalConnection(t);
    const linked = await linkProviderVault(t.db, t.context, {
      ownerKind: "workspace",
      name: "Keeper epoch",
      source: "keeper",
      providerConnectionId: keeper.id,
      providerVaultRef: "epoch-folder",
      mode: "read_only",
    });
    const replace = async (count: number, version: string) =>
      await upsertProviderVaultItems(t.db, t.context, {
        vaultId: linked.id,
        contentVersion: version,
        items: Array.from({ length: count }, (_, index) =>
          mirrorItem(`item${index}`, index === 0 ? "Deploy key" : `Item ${index}`),
        ),
      });
    await replace(1, "1");
    expect((await getVault(t.db, t.context, { vaultId: linked.id })).providerCacheEpoch).toBe("1");
    await replace(2, "1");
    const target = await getProviderVaultSyncTarget(t.db, t.context, linked.id);
    expect(target.providerCacheEpoch).toBe("2");

    const { candidates } = await resolveSecretReferenceCandidates(t.db, t.context, {
      refs: [
        {
          index: 0,
          form: "path",
          segments: ["Keeper epoch", "Deploy key", "password"],
          otp: false,
          previous: false,
        },
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "keeper",
      providerVaultRef: "epoch-folder",
      providerCacheEpoch: "2",
      providerItemRef: "item0",
      providerFieldRef: "password",
    });
    const read = await readVaultFieldCiphertext(t.db, t.context, {
      fieldId: candidates[0]!.fieldId!,
      purpose: "internal",
    });
    expect(read).toMatchObject({
      source: "keeper",
      valueEncrypted: null,
      providerCacheEpoch: "2",
      providerItemRef: "item0",
    });
    const item = await getVaultItem(t.db, t.context, { itemId: candidates[0]!.itemId });
    expect(item.vaultSource).toBe("keeper");

    // More than the native 2,000 items is refused whole; the old mirror stays.
    await expectVaultError(replace(2001, "2"), "provider_inventory_incomplete");
    const kept = await listVaultItems(t.db, t.context, { vaultId: linked.id, limit: 200 });
    expect(kept.items.map((row) => row.name).sort()).toEqual(["Deploy key", "Item 1"]);
    expect(await getProviderVaultSyncTarget(t.db, t.context, linked.id)).toMatchObject({
      providerContentVersion: "1",
      providerCacheEpoch: "2",
    });
    // Exactly 2,000 is a complete inventory.
    await replace(2000, "3");
    expect(await getProviderVaultSyncTarget(t.db, t.context, linked.id)).toMatchObject({
      providerContentVersion: "3",
      providerCacheEpoch: "3",
    });
  });
});
