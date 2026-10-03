import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  ApiKey,
  normalizeOrganizationAccessPolicy,
  type OrganizationAccessPolicy,
  type Permission,
} from "@opengeni/contracts";
import {
  createApiKey,
  createDb,
  createOrganizationApiKey,
  findActiveApiKeyByHash,
  findActiveWorkspaceApiKeyById,
  getOrganizationApiKey,
  listOrganizationApiKeys,
  OrganizationApiKeyWorkspaceScopeError,
  revokeOrganizationApiKey,
  updateOrganizationApiKey,
  withRlsContext,
  type DbClient,
} from "../src";
import {
  lockActiveExternalOrganizationKey,
  lockActiveExternalOrganizationKeyAuthority,
} from "../src/external-identities";
import { lockConnectionSetupKeyAuthority } from "../src/connection-setup-authority";
import { organizationApiKeyAllowsWorkspace } from "../src/organization-api-key-access";
import { rawRows } from "../src/database";
import { FORCE_RLS_TABLES, RUNTIME_TABLE_PRIVILEGES } from "../src/runtime-posture";
import { nestedPostgresSqlState } from "../src/persistence-errors";

const budget = 180_000;
const requireReal = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const available = requireReal || !!process.env.OPENGENI_TEST_PG_URL || !!Bun.which("docker");
const accountId = crypto.randomUUID();
const otherAccountId = crypto.randomUUID();
const firstWorkspaceId = crypto.randomUUID();
const secondWorkspaceId = crypto.randomUUID();
const personalWorkspaceId = crypto.randomUUID();
const foreignWorkspaceId = crypto.randomUUID();
let shared: SharedTestDatabase | null = null;
let client: DbClient;

function policy(
  workspaceIds?: string[],
  permissions: Permission[] = ["sessions:read"],
): OrganizationAccessPolicy {
  return {
    preset: "custom",
    permissions,
    workspaceScope: workspaceIds ? { kind: "selected", workspaceIds } : { kind: "all" },
  };
}

async function key(
  accessPolicy?: OrganizationAccessPolicy,
  permissions: Permission[] = ["workspace:admin"],
) {
  return createOrganizationApiKey(client.db, {
    accountId,
    name: "Policy fixture",
    prefix: "fixture",
    keyHash: crypto.randomUUID(),
    permissions,
    ...(accessPolicy ? { policy: accessPolicy } : {}),
  });
}

test(
  "0599 is maintenance-only, preserves legacy permission bytes, and provisions the exact FORCE-RLS join",
  async () => {
    const migration = await Bun.file(
      new URL("../drizzle/0599_organization_api_key_access_policy.sql", import.meta.url),
    ).text();
    expect(migration.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(migration).toContain("opengeni.migration_application_roles");
    expect(migration).toContain("ERRCODE = '55000'");
    expect(migration).toContain("permission_mode text NOT NULL DEFAULT 'legacy'");
    expect(migration).toContain("workspace_scope text NOT NULL DEFAULT 'all'");
    expect(migration).not.toMatch(/UPDATE\s+api_keys\s+SET\s+permissions/i);
    expect(migration).toContain("REFERENCES api_keys(id, account_id) ON DELETE CASCADE");
    expect(migration).toContain("REFERENCES workspaces(id, account_id) ON DELETE CASCADE");
    expect(migration).not.toContain("revoke_empty_organization_api_key_workspace_scope");
    expect(FORCE_RLS_TABLES).toContain("organization_api_key_workspaces");
    expect(RUNTIME_TABLE_PRIVILEGES.organization_api_key_workspaces).toEqual([
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
    ]);
  },
  budget,
);

describe.skipIf(!available)("organization API key policy real PostgreSQL", () => {
  beforeAll(async () => {
    shared = await acquireSharedTestDatabase("organization_api_key_access_policy");
    if (!shared) throw new Error("Real PostgreSQL required for organization API key policy tests");
    client = createDb(shared.appUrl, { max: 8 });
    for (const id of [accountId, otherAccountId]) {
      await shared.admin`insert into managed_accounts (id, name) values (${id}, 'Policy fixture organization')`;
    }
    for (const id of [firstWorkspaceId, secondWorkspaceId, personalWorkspaceId]) {
      await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'Policy fixture workspace')`;
    }
    await shared.admin`insert into workspaces (id, account_id, name) values (${foreignWorkspaceId}, ${otherAccountId}, 'Foreign workspace')`;
    await shared.admin`insert into organization_memberships (account_id, subject_id, personal_workspace_id)
      values (${accountId}, ${`user:policy-${crypto.randomUUID()}`}, ${personalWorkspaceId})`;
  }, budget);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, budget);

  test(
    "legacy creation and metadata patches preserve exact stored permissions and mode",
    async () => {
      const permissions: Permission[] = ["workspace:admin", "environments:use", "workspace:admin"];
      const legacy = await key(undefined, permissions);
      expect(legacy.permissions).toEqual(permissions);
      expect(legacy.permissionMode).toBe("legacy");
      expect(legacy.workspaceScope).toEqual({ kind: "all" });
      const patched = await updateOrganizationApiKey(client.db, accountId, legacy.id, {
        name: "Renamed",
        description: null,
      });
      expect(patched?.permissions).toEqual(permissions);
      expect(patched?.permissionMode).toBe("legacy");
      expect(patched?.workspaceScope).toEqual({ kind: "all" });
      const [stored] = await shared!
        .admin`select permissions, permission_mode, workspace_scope from api_keys where id = ${legacy.id}`;
      expect(stored!.permissions).toEqual(permissions);
      expect(stored!.permission_mode).toBe("legacy");
      expect(await getOrganizationApiKey(client.db, otherAccountId, legacy.id)).toBeNull();
      expect(
        await updateOrganizationApiKey(client.db, otherAccountId, legacy.id, {
          name: "Cross-account",
        }),
      ).toBeNull();
      expect(
        (
          await findActiveWorkspaceApiKeyById(client.db, {
            accountId,
            workspaceId: secondWorkspaceId,
            apiKeyId: legacy.id,
          })
        )?.id,
      ).toBe(legacy.id);
      expect(
        await findActiveWorkspaceApiKeyById(client.db, {
          accountId,
          workspaceId: personalWorkspaceId,
          apiKeyId: legacy.id,
        }),
      ).toBeNull();
    },
    budget,
  );

  test(
    "policy permissions override legacy input, canonicalize aliases, and enrich every key projection",
    async () => {
      const hash = crypto.randomUUID();
      const requested = policy(
        [secondWorkspaceId, firstWorkspaceId],
        ["workspace:admin", "environments:use", "workspace:admin"],
      );
      const created = await createOrganizationApiKey(client.db, {
        accountId,
        name: "Explicit",
        prefix: "fixture",
        keyHash: hash,
        permissions: ["account:admin"],
        policy: requested,
      });
      const normalized = normalizeOrganizationAccessPolicy(requested);
      expect(created.permissions).toEqual(normalized.permissions);
      expect(created.permissionMode).toBe("explicit");
      expect(created.policy).toEqual(normalized);
      expect(created.workspaceScope).toEqual(normalized.workspaceScope);
      expect(ApiKey.parse(created)).toEqual(created);
      for (const projected of [
        await getOrganizationApiKey(client.db, accountId, created.id),
        (await listOrganizationApiKeys(client.db, accountId)).find(
          (item) => item.id === created.id,
        ),
        await findActiveApiKeyByHash(client.db, hash),
        await findActiveWorkspaceApiKeyById(client.db, {
          accountId,
          workspaceId: firstWorkspaceId,
          apiKeyId: created.id,
        }),
      ]) {
        expect(projected?.workspaceScope).toEqual(normalized.workspaceScope);
        expect(projected?.policy).toEqual(normalized);
        expect(projected?.permissionMode).toBe("explicit");
      }
      const revoked = await revokeOrganizationApiKey(client.db, accountId, created.id);
      expect(revoked?.workspaceScope).toEqual(normalized.workspaceScope);
      expect(await findActiveApiKeyByHash(client.db, hash)).toBeNull();
      expect(
        await lockActiveExternalOrganizationKey(client.db, accountId, created.id, firstWorkspaceId),
      ).toBeNull();
    },
    budget,
  );

  test(
    "selected validation rejects personal, foreign and missing IDs and rolls back the complete patch",
    async () => {
      const created = await key(policy([firstWorkspaceId]));
      for (const invalid of [personalWorkspaceId, foreignWorkspaceId, crypto.randomUUID()]) {
        await expect(key(policy([invalid]))).rejects.toBeInstanceOf(
          OrganizationApiKeyWorkspaceScopeError,
        );
        await expect(
          updateOrganizationApiKey(client.db, accountId, created.id, {
            name: "Must roll back",
            policy: policy([secondWorkspaceId, invalid], ["account:admin"]),
          }),
        ).rejects.toBeInstanceOf(OrganizationApiKeyWorkspaceScopeError);
        expect(await getOrganizationApiKey(client.db, accountId, created.id)).toEqual(created);
      }
      await expect(key(policy([]))).rejects.toThrow();
      await expect(key(policy([firstWorkspaceId, firstWorkspaceId]))).rejects.toThrow();
      await expect(
        key(policy(Array.from({ length: 501 }, () => crypto.randomUUID()))),
      ).rejects.toThrow();
    },
    budget,
  );

  test(
    "live fences enforce selected scope and mode, metadata preserves scope, all remains shared-only",
    async () => {
      const created = await key(policy([firstWorkspaceId], ["workspace:admin"]));
      const authority = await lockActiveExternalOrganizationKeyAuthority(
        client.db,
        accountId,
        created.id,
        firstWorkspaceId,
      );
      expect(authority).toEqual({ permissionMode: "explicit", permissions: ["workspace:admin"] });
      expect(
        await lockActiveExternalOrganizationKey(
          client.db,
          accountId,
          created.id,
          secondWorkspaceId,
        ),
      ).toBeNull();
      expect(
        await lockActiveExternalOrganizationKey(
          client.db,
          accountId,
          created.id,
          personalWorkspaceId,
        ),
      ).toBeNull();
      expect(
        await lockActiveExternalOrganizationKey(
          client.db,
          otherAccountId,
          created.id,
          foreignWorkspaceId,
        ),
      ).toBeNull();
      expect(
        await lockConnectionSetupKeyAuthority(client.db, {
          accountId,
          workspaceId: secondWorkspaceId,
          subjectId: `api_key:${created.id}`,
        }),
      ).toBeNull();
      expect(
        await lockConnectionSetupKeyAuthority(client.db, {
          accountId,
          workspaceId: firstWorkspaceId,
          subjectId: `api_key:${created.id}`,
        }),
      ).toEqual(authority);
      const renamed = await updateOrganizationApiKey(client.db, accountId, created.id, {
        name: "Metadata only",
      });
      expect(renamed?.workspaceScope).toEqual(created.workspaceScope);
      expect(renamed?.permissions).toEqual(created.permissions);
      expect(
        await findActiveWorkspaceApiKeyById(client.db, {
          accountId,
          workspaceId: secondWorkspaceId,
          apiKeyId: created.id,
        }),
      ).toBeNull();
      const widened = await updateOrganizationApiKey(client.db, accountId, created.id, {
        policy: policy(undefined, []),
      });
      expect(widened?.permissionMode).toBe("explicit");
      expect(widened?.permissions).toEqual([]);
      expect(
        (
          await findActiveWorkspaceApiKeyById(client.db, {
            accountId,
            workspaceId: secondWorkspaceId,
            apiKeyId: created.id,
          })
        )?.id,
      ).toBe(created.id);
      expect(
        await findActiveWorkspaceApiKeyById(client.db, {
          accountId,
          workspaceId: personalWorkspaceId,
          apiKeyId: created.id,
        }),
      ).toBeNull();
      const workspaceKey = await createApiKey(client.db, {
        accountId,
        workspaceId: firstWorkspaceId,
        name: "Workspace",
        prefix: "fixture",
        keyHash: crypto.randomUUID(),
        permissions: ["workspace:admin"],
      });
      expect(workspaceKey.policy).toBeUndefined();
      expect(await getOrganizationApiKey(client.db, accountId, workspaceKey.id)).toBeNull();
    },
    budget,
  );

  test(
    "FORCE RLS requires account plus exact hash and cannot reveal or mutate sibling scopes",
    async () => {
      const first = await key(policy([firstWorkspaceId]));
      await key(policy([secondWorkspaceId]));
      const [hash] = await shared!.admin`select key_hash from api_keys where id = ${first.id}`;
      const [posture] = await shared!
        .admin`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'organization_api_key_workspaces'::regclass`;
      expect(posture).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      await client.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('opengeni.api_key_hash', ${hash!.key_hash}, true)`);
        expect(await rawRows(tx, sql`select * from organization_api_key_workspaces`)).toEqual([]);
        await tx.execute(sql`select set_config('opengeni.account_id', ${otherAccountId}, true)`);
        expect(await rawRows(tx, sql`select * from organization_api_key_workspaces`)).toEqual([]);
        await tx.execute(sql`select set_config('opengeni.account_id', ${accountId}, true)`);
        const rows = await rawRows<{ api_key_id: string }>(
          tx,
          sql`select * from organization_api_key_workspaces`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.api_key_id).toBe(first.id);
        expect(
          await rawRows(tx, sql`delete from organization_api_key_workspaces returning api_key_id`),
        ).toEqual([]);
      });
      await withRlsContext(client.db, { accountId: otherAccountId }, async (tx) => {
        expect(await rawRows(tx, sql`select * from organization_api_key_workspaces`)).toEqual([]);
      });
    },
    budget,
  );

  test(
    "composite FKs reject cross-tenant tuples; deleting a selected workspace never widens a key",
    async () => {
      const created = await key(policy([firstWorkspaceId]));
      for (const [workspaceId, tupleAccount] of [
        [foreignWorkspaceId, accountId],
        [foreignWorkspaceId, otherAccountId],
      ]) {
        try {
          await shared!
            .admin`insert into organization_api_key_workspaces (api_key_id, workspace_id, account_id)
          values (${created.id}, ${workspaceId!}, ${tupleAccount!})`;
          throw new Error("Cross-tenant scope was accepted");
        } catch (error) {
          expect(nestedPostgresSqlState(error)).toBe("23503");
        }
      }
      const disposableWorkspaceId = crypto.randomUUID();
      await shared!
        .admin`insert into workspaces (id, account_id, name) values (${disposableWorkspaceId}, ${accountId}, 'Disposable')`;
      const disposable = await key(policy([disposableWorkspaceId]));
      const [hash] = await shared!.admin`select key_hash from api_keys where id = ${disposable.id}`;
      await shared!.admin`delete from workspaces where id = ${disposableWorkspaceId}`;
      const projected = await getOrganizationApiKey(client.db, accountId, disposable.id);
      if (!projected) throw new Error("Organization key must remain readable");
      expect(projected.revokedAt).toBeNull();
      expect(projected.workspaceScope).toEqual({ kind: "selected", workspaceIds: [] });
      expect(projected.permissionMode).toBe("explicit");
      expect(projected.permissions).toEqual(disposable.permissions);
      expect(ApiKey.parse(projected)).toEqual(projected);
      const listed = (await listOrganizationApiKeys(client.db, accountId)).find(
        (item) => item.id === disposable.id,
      );
      expect(ApiKey.parse(listed)).toEqual(projected);
      expect((await findActiveApiKeyByHash(client.db, hash!.key_hash))?.id).toBe(disposable.id);
      expect(
        await lockActiveExternalOrganizationKey(
          client.db,
          accountId,
          disposable.id,
          firstWorkspaceId,
        ),
      ).toBeNull();
      expect(
        await findActiveWorkspaceApiKeyById(client.db, {
          accountId,
          workspaceId: firstWorkspaceId,
          apiKeyId: disposable.id,
        }),
      ).toBeNull();
      await shared!.admin`delete from api_keys where id = ${created.id}`;
      expect(
        await shared!
          .admin`select * from organization_api_key_workspaces where api_key_id = ${created.id}`,
      ).toHaveLength(0);
    },
    budget,
  );

  test(
    "scope replacements, partial removals and rolled-back deletes keep exactly the remaining links",
    async () => {
      const created = await key(policy([firstWorkspaceId]));
      const replaced = await updateOrganizationApiKey(client.db, accountId, created.id, {
        policy: policy([secondWorkspaceId]),
      });
      expect((await getOrganizationApiKey(client.db, accountId, created.id))?.revokedAt).toBeNull();
      expect(replaced?.workspaceScope).toEqual({
        kind: "selected",
        workspaceIds: [secondWorkspaceId],
      });
      await updateOrganizationApiKey(client.db, accountId, created.id, {
        policy: policy([firstWorkspaceId, secondWorkspaceId]),
      });
      await withRlsContext(client.db, { accountId }, async (tx) => {
        await tx.execute(sql`delete from organization_api_key_workspaces
          where api_key_id = ${created.id}::uuid and workspace_id = ${firstWorkspaceId}::uuid`);
      });
      const remaining = await getOrganizationApiKey(client.db, accountId, created.id);
      expect(remaining?.revokedAt).toBeNull();
      expect(remaining?.workspaceScope).toEqual({
        kind: "selected",
        workspaceIds: [secondWorkspaceId],
      });
      await expect(
        withRlsContext(client.db, { accountId }, async (tx) => {
          await tx.execute(
            sql`delete from organization_api_key_workspaces where api_key_id = ${created.id}::uuid`,
          );
          throw new Error("Rollback scope deletion");
        }),
      ).rejects.toThrow("Rollback scope deletion");
      expect(await getOrganizationApiKey(client.db, accountId, created.id)).toEqual(remaining);
    },
    budget,
  );

  test(
    "a selected key whose workspaces are all deleted stays active and reaches no workspace",
    async () => {
      const created = await key(policy([firstWorkspaceId]));
      await withRlsContext(client.db, { accountId }, async (scoped) => {
        await scoped.execute(
          sql`delete from organization_api_key_workspaces where api_key_id = ${created.id}::uuid`,
        );
      });
      const after = await getOrganizationApiKey(client.db, accountId, created.id);
      expect(after?.revokedAt).toBeNull();
      expect(ApiKey.parse(after).workspaceScope).toEqual({ kind: "selected", workspaceIds: [] });
      for (const workspaceId of [firstWorkspaceId, secondWorkspaceId])
        expect(
          await client.db.transaction((tx) =>
            organizationApiKeyAllowsWorkspace(
              tx,
              { id: created.id, accountId, workspaceScope: "selected" },
              workspaceId,
            ),
          ),
        ).toBe(false);
    },
    budget,
  );

  test(
    "scope narrowing waits for a protected shared key lock; queued live checks see only committed policy",
    async () => {
      const created = await key(policy([firstWorkspaceId, secondWorkspaceId]));
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const protectedWrite = client.db.transaction(async (tx) => {
        expect(
          await lockActiveExternalOrganizationKey(tx, accountId, created.id, secondWorkspaceId),
        ).toEqual(["sessions:read"]);
        entered();
        await gate;
      });
      await started;
      let settled = false;
      const narrowing = updateOrganizationApiKey(client.db, accountId, created.id, {
        policy: policy([firstWorkspaceId], ["sessions:control"]),
      }).then((result) => {
        settled = true;
        return result;
      });
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const rows = await shared!
            .admin`select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
          where a.datname = current_database() and not l.granted`;
          if (rows.length) {
            waiting = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        expect(settled).toBe(false);
      } finally {
        release();
        await protectedWrite;
        await narrowing;
      }
      expect(
        await lockActiveExternalOrganizationKey(
          client.db,
          accountId,
          created.id,
          secondWorkspaceId,
        ),
      ).toBeNull();
      expect(
        await lockActiveExternalOrganizationKey(client.db, accountId, created.id, firstWorkspaceId),
      ).toEqual(["sessions:control"]);

      let unlock!: () => void;
      let locked!: () => void;
      const lockedGate = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const lockedStart = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const transaction = client.db.transaction(async (tx) => {
        await updateOrganizationApiKey(tx, accountId, created.id, {
          policy: policy([secondWorkspaceId]),
        });
        locked();
        await lockedGate;
      });
      await lockedStart;
      const queuedCheck = lockActiveExternalOrganizationKey(
        client.db,
        accountId,
        created.id,
        firstWorkspaceId,
      );
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const rows = await shared!
            .admin`select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
          where a.datname = current_database() and not l.granted`;
          if (rows.length) {
            waiting = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
      } finally {
        unlock();
        await transaction;
      }
      expect(await queuedCheck).toBeNull();
    },
    budget,
  );
});
