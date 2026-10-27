import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import type { OrganizationAccessPolicy, Permission } from "@opengeni/contracts";
import {
  createDb,
  createOrganizationApiKey,
  createOrganizationServiceAccount,
  deleteOrganizationServiceAccount,
  findActiveApiKeyByHash,
  getOrganizationServiceAccount,
  listOrganizationApiKeys,
  listOrganizationServiceAccounts,
  OrganizationServiceAccountNotFoundError,
  OrganizationServiceAccountRoleError,
  updateOrganizationApiKey,
  updateOrganizationServiceAccount,
  type DbClient,
} from "../src";
import { FORCE_RLS_TABLES, RUNTIME_TABLE_PRIVILEGES } from "../src/runtime-posture";

const budget = 180_000;
const requireReal = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const available = requireReal || !!process.env.OPENGENI_TEST_PG_URL || !!Bun.which("docker");
const accountId = crypto.randomUUID();
const otherAccountId = crypto.randomUUID();
let shared: SharedTestDatabase | null = null;
let client: DbClient;

function policy(permissions: Permission[]): OrganizationAccessPolicy {
  return { preset: "custom", permissions, workspaceScope: { kind: "all" } };
}

async function key(input: {
  name?: string;
  permissions?: Permission[];
  policy?: OrganizationAccessPolicy;
  serviceAccountId?: string;
  rotationSourceApiKeyId?: string;
}) {
  const keyHash = crypto.randomUUID();
  const created = await createOrganizationApiKey(client.db, {
    accountId,
    name: input.name ?? "Deploy bot",
    prefix: "fixture",
    keyHash,
    permissions: input.permissions ?? ["workspace:admin"],
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.serviceAccountId ? { serviceAccountId: input.serviceAccountId } : {}),
    ...(input.rotationSourceApiKeyId
      ? { rotationSourceApiKeyId: input.rotationSourceApiKeyId }
      : {}),
  });
  return { ...created, keyHash };
}

test("the table is forced row security with runtime DML", () => {
  expect(FORCE_RLS_TABLES).toContain("organization_service_accounts");
  expect(RUNTIME_TABLE_PRIVILEGES.organization_service_accounts).toEqual([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]);
});

describe.skipIf(!available)("organization service accounts real PostgreSQL", () => {
  beforeAll(async () => {
    shared = await acquireSharedTestDatabase("organization_service_accounts");
    if (!shared) throw new Error("Real PostgreSQL required for service account tests");
    client = createDb(shared.appUrl, { max: 8 });
    for (const id of [accountId, otherAccountId]) {
      await shared.admin`insert into managed_accounts (id, name) values (${id}, 'Service account fixture')`;
    }
  }, budget);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, budget);

  test(
    "a key without a holder gets its own service account, admin only when it needs to be",
    async () => {
      const full = await key({ name: "Full automation" });
      expect(full.serviceAccount).toMatchObject({ name: "Full automation", role: "admin" });
      const reader = await key({
        name: "Reader",
        policy: policy(["workspace:read", "sessions:read"]),
      });
      expect(reader.serviceAccount).toMatchObject({ name: "Reader", role: "member" });
      const listed = await listOrganizationServiceAccounts(client.db, accountId);
      expect(listed.find((each) => each.id === full.serviceAccount!.id)).toMatchObject({
        role: "admin",
        activeKeyCount: 1,
      });
      const keys = await listOrganizationApiKeys(client.db, accountId);
      expect(keys.find((each) => each.id === reader.id)?.serviceAccount).toEqual(
        reader.serviceAccount,
      );
      // Another organization sees nothing.
      expect(await listOrganizationServiceAccounts(client.db, otherAccountId)).toEqual([]);
      expect(
        await getOrganizationServiceAccount(client.db, otherAccountId, full.serviceAccount!.id),
      ).toBeNull();
    },
    budget,
  );

  test(
    "a member service account's keys can't hold administrator permissions",
    async () => {
      const bot = await createOrganizationServiceAccount(client.db, {
        accountId,
        name: "CI bot",
        role: "member",
        createdBySubjectId: "user:fixture",
      });
      await expect(
        key({ serviceAccountId: bot.id, policy: policy(["account:admin", "workspace:read"]) }),
      ).rejects.toBeInstanceOf(OrganizationServiceAccountRoleError);
      // A legacy workspace:admin key implies key management, so it is refused too.
      await expect(key({ serviceAccountId: bot.id })).rejects.toBeInstanceOf(
        OrganizationServiceAccountRoleError,
      );
      const ok = await key({
        serviceAccountId: bot.id,
        policy: policy(["workspace:read", "sessions:create"]),
      });
      expect(ok.serviceAccount).toMatchObject({ id: bot.id, role: "member" });
      await expect(
        updateOrganizationApiKey(client.db, accountId, ok.id, {
          policy: policy(["members:manage"]),
        }),
      ).rejects.toBeInstanceOf(OrganizationServiceAccountRoleError);
      // Rotation keeps the new key with the same service account.
      const rotated = await key({
        policy: policy(["workspace:read"]),
        rotationSourceApiKeyId: ok.id,
      });
      expect(rotated.serviceAccount?.id).toBe(bot.id);
      expect(
        (await getOrganizationServiceAccount(client.db, accountId, bot.id))?.activeKeyCount,
      ).toBe(2);
      await expect(
        key({ serviceAccountId: crypto.randomUUID(), policy: policy(["workspace:read"]) }),
      ).rejects.toBeInstanceOf(OrganizationServiceAccountNotFoundError);
    },
    budget,
  );

  test(
    "making a service account a member narrows its keys without widening them",
    async () => {
      const legacy = await key({ name: "Legacy full", permissions: ["workspace:admin"] });
      const holder = legacy.serviceAccount!.id;
      const updated = await updateOrganizationServiceAccount(client.db, accountId, holder, {
        role: "member",
        name: "Legacy bot",
      });
      expect(updated).toMatchObject({ role: "member", name: "Legacy bot" });
      const [stored] = await shared!
        .admin`select permissions, permission_mode from api_keys where id = ${legacy.id}`;
      const permissions = stored!.permissions as Permission[];
      expect(stored!.permission_mode).toBe("explicit");
      expect(permissions).toContain("workspace:admin");
      expect(permissions).toContain("sessions:create");
      for (const never of [
        "account:admin",
        "api_keys:manage",
        "members:manage",
        "billing:manage",
        "usage_allowances:manage",
        // Never held literally, so never gained by the conversion.
        "account:read",
        "billing:read",
        "workspace:create",
        "secrets:read",
      ] as Permission[])
        expect(permissions).not.toContain(never);
    },
    budget,
  );

  test(
    "deleting a service account revokes every key it holds at once",
    async () => {
      const bot = await createOrganizationServiceAccount(client.db, {
        accountId,
        name: "Short-lived",
        role: "member",
        createdBySubjectId: "user:fixture",
      });
      const one = await key({ serviceAccountId: bot.id, policy: policy(["workspace:read"]) });
      const two = await key({ serviceAccountId: bot.id, policy: policy(["sessions:read"]) });
      expect(await findActiveApiKeyByHash(client.db, one.keyHash)).not.toBeNull();
      await deleteOrganizationServiceAccount(client.db, accountId, bot.id);
      expect(await findActiveApiKeyByHash(client.db, one.keyHash)).toBeNull();
      expect(await findActiveApiKeyByHash(client.db, two.keyHash)).toBeNull();
      expect(await getOrganizationServiceAccount(client.db, accountId, bot.id)).toBeNull();
      expect(
        (await listOrganizationServiceAccounts(client.db, accountId)).some(
          (each) => each.id === bot.id,
        ),
      ).toBe(false);
      await expect(
        deleteOrganizationServiceAccount(client.db, accountId, bot.id),
      ).rejects.toBeInstanceOf(OrganizationServiceAccountNotFoundError);
    },
    budget,
  );
});
