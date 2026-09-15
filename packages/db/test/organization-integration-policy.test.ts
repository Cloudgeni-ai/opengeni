import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createDb, withRlsContext, type DbClient } from "../src/database";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { rawRows, setSubjectRlsContext } from "../src/database";
import { ensureManagedAccessForUser, persistProviderOAuthConnection } from "../src";
import { nestedPostgresSqlState } from "../src/persistence-errors";
import { assertOrganizationIntegrationAllowed } from "@opengeni/contracts";
import {
  getOrganizationIntegrationPolicy,
  updateOrganizationIntegrationPolicy,
  withOrganizationIntegrationAcquisition,
  withOrganizationIntegrationPolicyFence,
} from "../src/organization-integration-policy";

let shared: SharedTestDatabase | null;
let client: DbClient;
const scope = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
const other = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
const keyId = crypto.randomUUID();
const otherKeyId = crypto.randomUUID();
const authorize = async () => ({ accountId: scope.accountId, subjectId: `api_key:${keyId}` });
const authorizeOther = async () => ({
  accountId: other.accountId,
  subjectId: `api_key:${otherKeyId}`,
});
const request = (
  expectedRevision: number,
  mode: "restricted" | "unrestricted",
  allowedIntegrationKeys: string[] = [],
) => ({ expectedRevision, mode, allowedIntegrationKeys, operationId: crypto.randomUUID() });

beforeAll(async () => {
  // Optional dedicated, already migrated native fixture; never points at a live database.
  const nativeAdmin = process.env.OPENGENI_INTEGRATION_POLICY_TEST_ADMIN_URL;
  const nativeApp = process.env.OPENGENI_INTEGRATION_POLICY_TEST_APP_URL;
  shared =
    nativeAdmin && nativeApp
      ? {
          admin: postgres(nativeAdmin),
          adminUrl: nativeAdmin,
          appUrl: nativeApp,
          release: async () => {
            await shared?.admin.end();
          },
        }
      : await acquireSharedTestDatabase("integration_policy");
  if (!shared) throw new Error("Real PostgreSQL required for integration policy tests");
  client = createDb(shared.appUrl);
  for (const target of [scope, other]) {
    await shared.admin`insert into managed_accounts (id, name) values (${target.accountId}, 'Example organization')`;
    await shared.admin`insert into workspaces (id, account_id, name) values (${target.workspaceId}, ${target.accountId}, 'Example workspace')`;
  }
  await shared.admin`insert into api_keys (id, account_id, name, credential_kind, prefix, key_hash, permissions)
    values (${keyId}, ${scope.accountId}, 'Example key', 'organization', 'example', ${crypto.randomUUID()}, '["workspace:admin"]'::jsonb)`;
  await shared.admin`insert into api_keys (id, account_id, name, credential_kind, prefix, key_hash, permissions)
    values (${otherKeyId}, ${other.accountId}, 'Example key', 'organization', 'example', ${crypto.randomUUID()}, '["workspace:admin"]'::jsonb)`;
}, 120000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("default, workspace isolation, exact replay, revision conflict, deny-all and unknown", async () => {
  expect(await getOrganizationIntegrationPolicy(client.db, scope, authorize)).toEqual({
    mode: "unrestricted",
    allowedIntegrationKeys: [],
    revision: 0,
  });
  await expect(
    withOrganizationIntegrationAcquisition(
      client.db,
      { ...scope, workspaceId: other.workspaceId },
      [null],
      async () => undefined,
    ),
  ).rejects.toThrow();
  const first = request(0, "restricted", ["sample", "custom-mcp"]);
  const result = await updateOrganizationIntegrationPolicy(client.db, scope, first, authorize);
  expect(result.revision).toBe(1);
  expect(await updateOrganizationIntegrationPolicy(client.db, scope, first, authorize)).toEqual(
    result,
  );
  await expect(
    updateOrganizationIntegrationPolicy(
      client.db,
      scope,
      { ...first, mode: "unrestricted" },
      authorize,
    ),
  ).rejects.toThrow();
  await expect(
    updateOrganizationIntegrationPolicy(client.db, scope, request(0, "unrestricted"), authorize),
  ).rejects.toThrow();
  expect((await getOrganizationIntegrationPolicy(client.db, other, authorizeOther)).revision).toBe(
    0,
  );
  await withOrganizationIntegrationAcquisition(
    client.db,
    scope,
    ["sample", "custom-mcp"],
    async () => undefined,
  );
  for (const key of [null, "unknown", "sample.example", "custom-openapi"]) {
    let effect = false;
    await expect(
      withOrganizationIntegrationAcquisition(client.db, scope, [key], async () => {
        effect = true;
      }),
    ).rejects.toThrow();
    expect(effect).toBe(false);
  }
  await updateOrganizationIntegrationPolicy(client.db, scope, request(1, "restricted"), authorize);
  await expect(
    withOrganizationIntegrationAcquisition(client.db, scope, ["sample"], async () => undefined),
  ).rejects.toThrow();
  expect(await updateOrganizationIntegrationPolicy(client.db, scope, first, authorize)).toEqual(
    result,
  );
});

test("admin proof required and live key authority rechecked; direct DML unavailable", async () => {
  await expect(
    updateOrganizationIntegrationPolicy(client.db, scope, request(2, "unrestricted"), async () => ({
      accountId: other.accountId,
      subjectId: `api_key:${keyId}`,
    })),
  ).rejects.toThrow();
  await expect(
    updateOrganizationIntegrationPolicy(client.db, scope, request(2, "unrestricted"), async () => {
      throw new Error("unverified caller");
    }),
  ).rejects.toThrow();
  await expect(
    updateOrganizationIntegrationPolicy(client.db, scope, request(2, "unrestricted"), async () => ({
      accountId: scope.accountId,
      subjectId: "user:ordinary",
    })),
  ).rejects.toThrow();
  await expect(
    withRlsContext(client.db, scope, (tx) =>
      tx.execute(sql`update organization_integration_policies set revision = 99`),
    ),
  ).rejects.toThrow();
});

test("acquisition fence serializes policy change until commit, then denies fresh acquisitions", async () => {
  await updateOrganizationIntegrationPolicy(
    client.db,
    scope,
    request(2, "unrestricted"),
    authorize,
  );
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const acquisition = withOrganizationIntegrationAcquisition(
    client.db,
    { accountId: scope.accountId.toUpperCase(), workspaceId: scope.workspaceId.toUpperCase() },
    [null],
    async (tx) => {
      await tx.execute(sql`select 1`);
      entered();
      await gate;
    },
  );
  await started;
  let settled = false;
  const change = updateOrganizationIntegrationPolicy(
    client.db,
    scope,
    request(3, "restricted"),
    authorize,
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await shared!
        .admin`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.datname=current_database() and l.locktype='advisory' and not l.granted`;
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
    await acquisition;
    await change;
  }
  await expect(
    withOrganizationIntegrationAcquisition(client.db, scope, [null], async () => undefined),
  ).rejects.toThrow();
});

test("same operation converges concurrently and replay still requires a live full organization key", async () => {
  const before = await getOrganizationIntegrationPolicy(client.db, scope, authorize);
  const operation = request(before.revision, "unrestricted");
  const [left, right] = await Promise.all([
    updateOrganizationIntegrationPolicy(client.db, scope, operation, authorize),
    updateOrganizationIntegrationPolicy(client.db, scope, operation, authorize),
  ]);
  expect(left).toEqual(right);
  expect(left.revision).toBe(before.revision + 1);
  for (const permissions of [["account:admin"], ["members:manage"], []]) {
    await shared!
      .admin`update api_keys set permissions = ${JSON.stringify(permissions)}::jsonb where id = ${keyId}`;
    await expect(
      updateOrganizationIntegrationPolicy(client.db, scope, operation, authorize),
    ).rejects.toThrow();
  }
  await shared!
    .admin`update api_keys set permissions = '["workspace:admin"]'::jsonb, revoked_at = now() where id = ${keyId}`;
  await expect(
    updateOrganizationIntegrationPolicy(client.db, scope, operation, authorize),
  ).rejects.toThrow();
  await shared!
    .admin`update api_keys set revoked_at = null, expires_at = now() - interval '1 second' where id = ${keyId}`;
  await expect(
    updateOrganizationIntegrationPolicy(client.db, scope, operation, authorize),
  ).rejects.toThrow();
  await shared!
    .admin`update api_keys set expires_at = null, credential_kind = 'workspace', workspace_id = ${scope.workspaceId} where id = ${keyId}`;
  await expect(
    updateOrganizationIntegrationPolicy(client.db, scope, operation, authorize),
  ).rejects.toThrow();
  await shared!
    .admin`update api_keys set credential_kind = 'organization', workspace_id = null where id = ${keyId}`;
  expect(await updateOrganizationIntegrationPolicy(client.db, scope, operation, authorize)).toEqual(
    left,
  );
});

test("human administrator live membership, direct SQL scope, and RLS isolation", async () => {
  const subjectId = "user:example-administrator";
  const membershipId = crypto.randomUUID();
  await shared!
    .admin`insert into organization_memberships (id, account_id, subject_id, role, status, personal_workspace_id)
    values (${membershipId}, ${other.accountId}, ${subjectId}, 'admin', 'active', ${other.workspaceId})`;
  const human = async () => ({ accountId: other.accountId, subjectId });
  const operation = request(0, "restricted", ["custom-graphql"]);
  expect(
    (await updateOrganizationIntegrationPolicy(client.db, other, operation, human)).revision,
  ).toBe(1);
  await shared!
    .admin`update organization_memberships set role = 'member' where id = ${membershipId}`;
  await expect(
    updateOrganizationIntegrationPolicy(client.db, other, operation, human),
  ).rejects.toThrow();
  await shared!
    .admin`update organization_memberships set role = 'admin', status = 'suspended' where id = ${membershipId}`;
  await expect(
    updateOrganizationIntegrationPolicy(client.db, other, operation, human),
  ).rejects.toThrow();
  await withRlsContext(client.db, scope, async (tx) => {
    const rows = await rawRows(
      tx,
      sql`select account_id from organization_integration_policies where account_id = ${other.accountId}::uuid`,
    );
    expect(rows).toHaveLength(0);
  });
  await expect(
    withRlsContext(client.db, scope, async (tx) => {
      await setSubjectRlsContext(tx, `api_key:${keyId}`);
      await tx.execute(
        sql`select opengeni_private.update_organization_integration_policy(${other.accountId}::uuid, ${`api_key:${keyId}`}, ${JSON.stringify(request(1, "unrestricted"))}::jsonb)`,
      );
    }),
  ).rejects.toThrow();
  const roles = await rawRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
    client.db,
    sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
  );
  expect(roles[0]).toEqual({ rolsuper: false, rolbypassrls: false });
});

test("same-transaction policy upgrade is rejected and acquisition effects roll back", async () => {
  const before = await getOrganizationIntegrationPolicy(client.db, scope, authorize);
  expect(before.mode).toBe("unrestricted");
  const operation = request(before.revision, "restricted");
  const rejected = await withOrganizationIntegrationAcquisition(
    client.db,
    scope,
    [null],
    async (tx) => {
      await tx.execute(
        sql`update workspaces set name = 'Must roll back' where id = ${scope.workspaceId}::uuid`,
      );
      await updateOrganizationIntegrationPolicy(tx, scope, operation, authorize);
    },
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(nestedPostgresSqlState(rejected)).toBe("55000");
  expect(await getOrganizationIntegrationPolicy(client.db, scope, authorize)).toEqual(before);
  const [workspace] = await shared!
    .admin`select name from workspaces where id = ${scope.workspaceId}`;
  expect(workspace!.name).toBe("Example workspace");
  await expect(
    withOrganizationIntegrationAcquisition(client.db, scope, [], async () => undefined),
  ).rejects.toThrow();
});

test("a policy change winning the fence denies the waiting acquisition before effects", async () => {
  const before = await getOrganizationIntegrationPolicy(client.db, scope, authorize);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const writer = withRlsContext(
    client.db,
    scope,
    async (tx) => {
      await updateOrganizationIntegrationPolicy(
        tx,
        scope,
        request(before.revision, "restricted"),
        authorize,
      );
      entered();
      await gate;
    },
    undefined,
    "none",
  );
  await started;
  let effect = false;
  const acquisition = withOrganizationIntegrationAcquisition(
    client.db,
    scope,
    ["sample"],
    async () => {
      effect = true;
    },
  );
  // Attach the rejection handler before releasing the writer.
  const denied = acquisition.then(
    () => false,
    () => true,
  );
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await shared!
        .admin`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.datname=current_database() and l.locktype='advisory' and not l.granted`;
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect(effect).toBe(false);
  } finally {
    release();
    await writer;
    expect(await denied).toBe(true);
  }
  expect(effect).toBe(false);
});

test("local subject name is not DB admin authority without the canonical live membership", async () => {
  const local = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  await shared!
    .admin`insert into managed_accounts (id, name, external_source, external_id) values (${local.accountId}, 'Local example', 'opengeni:local', 'default')`;
  await shared!
    .admin`insert into workspaces (id, account_id, name) values (${local.workspaceId}, ${local.accountId}, 'Local example')`;
  const verifiedLocal = async () => ({ accountId: local.accountId, subjectId: "dev" });
  const operation = request(0, "restricted");
  await expect(
    updateOrganizationIntegrationPolicy(client.db, local, operation, verifiedLocal),
  ).rejects.toThrow();
  await shared!
    .admin`insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id) values (${local.accountId}, 'dev', 'owner', 'active', ${local.workspaceId})`;
  expect(
    (await updateOrganizationIntegrationPolicy(client.db, local, operation, verifiedLocal))
      .revision,
  ).toBe(1);
});

test("repeatable-read transactions cannot acquire using a stale policy snapshot", async () => {
  let effect = false;
  await expect(
    withRlsContext(
      client.db,
      scope,
      (tx) =>
        withOrganizationIntegrationAcquisition(tx, scope, ["sample"], async () => {
          effect = true;
        }),
      { isolationLevel: "repeatable read" },
      "none",
    ),
  ).rejects.toThrow("read committed");
  expect(effect).toBe(false);
});

test("organization administration does not require any workspace", async () => {
  const accountId = crypto.randomUUID();
  const adminKeyId = crypto.randomUUID();
  await shared!
    .admin`insert into managed_accounts (id, name) values (${accountId}, 'Empty example organization')`;
  await shared!
    .admin`insert into api_keys (id, account_id, name, credential_kind, prefix, key_hash, permissions)
    values (${adminKeyId}, ${accountId}, 'Example key', 'organization', 'example', ${crypto.randomUUID()}, '["workspace:admin"]'::jsonb)`;
  const proof = async () => ({ accountId, subjectId: `api_key:${adminKeyId}` });
  expect((await getOrganizationIntegrationPolicy(client.db, { accountId }, proof)).revision).toBe(
    0,
  );
  expect(
    (
      await updateOrganizationIntegrationPolicy(
        client.db,
        { accountId },
        request(0, "restricted"),
        proof,
      )
    ).revision,
  ).toBe(1);
  await expect(
    getOrganizationIntegrationPolicy(client.db, { accountId }, async () => {
      throw new Error("Unverified administrator");
    }),
  ).rejects.toThrow();
});

test("unrelated acquisitions share the policy fence and do not hold the membership fence", async () => {
  const siblingId = crypto.randomUUID();
  await shared!
    .admin`insert into workspaces (id, account_id, name) values (${siblingId}, ${scope.accountId}, 'Sibling workspace')`;
  // Earlier tests may leave this organization restricted; use its exact current revision.
  const [head] = await shared!
    .admin`select revision from organization_integration_policies where account_id = ${scope.accountId}`;
  await updateOrganizationIntegrationPolicy(
    client.db,
    scope,
    request(Number(head?.revision ?? 0), "unrestricted"),
    authorize,
  );
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = withOrganizationIntegrationAcquisition(client.db, scope, [null], async () => {
    entered();
    await gate;
  });
  await started;
  let overlap = false;
  const second = withOrganizationIntegrationAcquisition(
    client.db,
    { ...scope, workspaceId: siblingId },
    [null],
    async () => {
      overlap = true;
    },
  );
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (overlap) break;
      await Bun.sleep(10);
    }
    expect(overlap).toBe(true);
    const rows = await shared!.admin.begin(
      async (tx) =>
        tx`select pg_try_advisory_xact_lock(hashtextextended(${`organization-membership:${scope.accountId}`}, 0)) as available`,
    );
    expect(rows[0]?.available).toBe(true);
  } finally {
    release();
    await first;
    await second;
  }
});

test("queued policy writer does not invert the existing personal OAuth membership prefix", async () => {
  const userId = `example-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Example owner",
  });
  const grant = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
  )!;
  const target = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const proof = async () => ({ accountId: target.accountId, subjectId });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const acquisition = withOrganizationIntegrationAcquisition(
    client.db,
    target,
    ["example-oauth"],
    async (tx) => {
      entered();
      await gate;
      return persistProviderOAuthConnection(tx, {
        ...target,
        subjectId,
        visibleToSubjectId: subjectId,
        providerDomain: "oauth.example.test",
        kind: "oauth2",
        credentialEncrypted: "fixture-ciphertext-never-resolved",
        credentialRole: "example_oauth",
        providerFamily: "example",
        providerPrincipalId: "example-1",
        metadata: {
          credentialRole: "example_oauth",
          providerFamily: "example",
          providerPrincipalId: "example-1",
        },
        createdBySubjectId: subjectId,
        requireLiveUserAuthority: true,
        requiredLiveUserPermission: "connections:write",
        allowCanonicalPersonalWorkspaceOwner: true,
      });
    },
  );
  await started;
  const writer = updateOrganizationIntegrationPolicy(
    client.db,
    target,
    request(0, "restricted"),
    proof,
  );
  let waiting = false;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await shared!
        .admin`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.datname=current_database() and l.locktype='advisory' and not l.granted`;
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    // The waiting writer holds neither the membership prefix nor live admin rows.
    expect((await getOrganizationIntegrationPolicy(client.db, target, proof)).revision).toBe(0);
  } finally {
    release();
  }
  const [connection, policy] = await Promise.all([acquisition, writer]);
  expect(connection?.authorityId).toEqual(expect.any(String));
  expect(policy.revision).toBe(1);
});

test("ordinary admin GET takes no policy or organization advisory lock", async () => {
  await withRlsContext(
    client.db,
    { accountId: scope.accountId, workspaceId: null },
    async (tx) => {
      await getOrganizationIntegrationPolicy(tx, { accountId: scope.accountId }, authorize);
      const rows = await rawRows(
        tx,
        sql`select 1 from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'`,
      );
      expect(rows).toHaveLength(0);
    },
    undefined,
    "none",
  );
});

test("nested administration restores the caller subject after success and rollback", async () => {
  await withRlsContext(
    client.db,
    { accountId: scope.accountId, workspaceId: null },
    async (tx) => {
      const originalSubject = "user:example-original";
      await setSubjectRlsContext(tx, originalSubject);
      const currentSubject = async () =>
        (
          await rawRows<{ subject: string }>(
            tx,
            sql`select current_setting('opengeni.subject_id', true) as subject`,
          )
        )[0]?.subject;
      const current = await getOrganizationIntegrationPolicy(tx, scope, authorize);
      expect(await currentSubject()).toBe(originalSubject);
      const changed = await updateOrganizationIntegrationPolicy(
        tx,
        scope,
        request(current.revision, "unrestricted"),
        authorize,
      );
      expect(await currentSubject()).toBe(originalSubject);
      await expect(
        updateOrganizationIntegrationPolicy(
          tx,
          scope,
          request(changed.revision - 1, "restricted"),
          authorize,
        ),
      ).rejects.toThrow();
      expect(await currentSubject()).toBe(originalSubject);
      await expect(
        getOrganizationIntegrationPolicy(tx, scope, async () => ({
          accountId: scope.accountId,
          subjectId: "user:unknown",
        })),
      ).rejects.toThrow();
      expect(await currentSubject()).toBe(originalSubject);
    },
    undefined,
    "none",
  );
});

test("acquisition classifications are snapshotted before asynchronous workspace resolution", async () => {
  const current = await getOrganizationIntegrationPolicy(client.db, scope, authorize);
  await updateOrganizationIntegrationPolicy(
    client.db,
    scope,
    request(current.revision, "restricted", ["sample"]),
    authorize,
  );
  const keys = ["unknown"];
  let effect = false;
  const acquisition = withOrganizationIntegrationAcquisition(client.db, scope, keys, async () => {
    effect = true;
  });
  keys[0] = "sample";
  await expect(acquisition).rejects.toThrow();
  expect(effect).toBe(false);
});

test("policy fence allows completed exact receipt reads but new progress still requires assertion", async () => {
  const current = await getOrganizationIntegrationPolicy(client.db, scope, authorize);
  const completedOperation = request(current.revision, "restricted");
  const recorded = await updateOrganizationIntegrationPolicy(
    client.db,
    scope,
    completedOperation,
    authorize,
  );
  const replay = await withOrganizationIntegrationPolicyFence(
    client.db,
    scope,
    async (tx, policy) => {
      expect(policy.mode).toBe("restricted");
      const [receipt] = await rawRows<{ result: unknown }>(
        tx,
        sql`select result from organization_integration_policy_operations where account_id = ${scope.accountId}::uuid and operation_id = ${completedOperation.operationId}::uuid`,
      );
      return receipt!.result;
    },
  );
  expect(replay).toEqual(recorded);
  let newEffect = false;
  await expect(
    withOrganizationIntegrationPolicyFence(client.db, scope, async (tx, policy) => {
      const [receipt] = await rawRows(
        tx,
        sql`select result from organization_integration_policy_operations where account_id = ${scope.accountId}::uuid and operation_id = ${crypto.randomUUID()}::uuid`,
      );
      if (receipt) return receipt;
      assertOrganizationIntegrationAllowed(policy, "unknown");
      newEffect = true;
      return null;
    }),
  ).rejects.toThrow();
  expect(newEffect).toBe(false);
});

test("policy fence provides a deeply frozen policy snapshot", async () => {
  const current = await getOrganizationIntegrationPolicy(client.db, scope, authorize);
  await updateOrganizationIntegrationPolicy(
    client.db,
    scope,
    request(current.revision, "restricted"),
    authorize,
  );
  await withOrganizationIntegrationPolicyFence(client.db, scope, async (_tx, policy) => {
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowedIntegrationKeys)).toBe(true);
    expect(() => {
      policy.mode = "unrestricted";
    }).toThrow();
    expect(() => {
      policy.allowedIntegrationKeys.push("unknown");
    }).toThrow();
    expect(() => assertOrganizationIntegrationAllowed(policy, "unknown")).toThrow();
  });
});
