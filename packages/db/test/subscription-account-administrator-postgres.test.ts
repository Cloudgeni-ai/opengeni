/**
 * Migration 1103: an account administrator the API authenticated without an
 * organization membership (a deployment's configured access key, an
 * account-scoped key or a signed delegation with account:admin) administers
 * the organization's subscription connections, as an organization owner or
 * admin does. The API passes its request-local account:admin proof; the
 * database checks it against the transaction's own account and subject and
 * records it for that transaction only. Workspace owners administer the
 * connections their workspace manages (0897). Everyone else stays refused.
 * Runs on real PostgreSQL as the application role.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  createDb,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  withSubscriptionAccountAdministrators,
  type DbClient,
  type SubscriptionAccountAdministratorStamp,
} from "../src";
import { rawRows, withRlsContext } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import {
  SubscriptionSettingsForbiddenError,
  updateOrganizationSubscriptionSettings,
} from "../src/subscription-settings";
import { renameSubscriptionCoreConnection } from "../src/subscription-core/administration";
import {
  connectSubscriptionCoreConnection,
  disconnectSubscriptionCoreConnection,
} from "../src/subscription-core/connections";
import {
  subscriptionCoreProvider,
  subscriptionCoreProviderIds,
} from "../src/subscription-core-providers";

setDefaultTimeout(180_000);

let shared: SharedTestDatabase;
let client: DbClient;
const key = Buffer.alloc(32, 54);
const codex = () => subscriptionCoreProvider("codex");

type Org = {
  accountId: string;
  ownerSubjectId: string;
  /** Shared workspaces; the organization's connection reaches all of them. */
  workspaceIds: [string, string, string];
  /** The deployment's configured key: owner of every workspace, no organization membership. */
  keySubjectId: string;
};

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("subscription-account-administrator-v1");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function organization(): Promise<Org> {
  const userId = `account-administrator-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Account administrator fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const keySubjectId = `configured:key-${crypto.randomUUID()}`;
  const workspaceIds: string[] = [];
  for (const name of ["Shared one", "Shared two", "Shared three"]) {
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${accountId}::uuid, ${name}) returning id::text as id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}::uuid, ${accountId}::uuid)`;
    for (const subjectId of [ownerSubjectId, keySubjectId])
      await shared.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (${accountId}::uuid, ${workspace!.id}::uuid, ${subjectId}, 'owner')`;
    workspaceIds.push(workspace!.id);
  }
  for (const provider of subscriptionCoreProviderIds())
    await shared.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${accountId}::uuid, ${provider}, true)
      on conflict (account_id, provider) do update set enabled = excluded.enabled`;
  return {
    accountId,
    ownerSubjectId,
    workspaceIds: workspaceIds as [string, string, string],
    keySubjectId,
  };
}

/** What the API's access resolver mints for an authenticated account administrator. */
function stampFor(accountId: string, subjectId: string): SubscriptionAccountAdministratorStamp {
  return Object.freeze({
    authorizationId: crypto.randomUUID(),
    accountId,
    actorSubjectId: subjectId,
    permission: "account:admin" as const,
  });
}

/** Run as a request that authenticated as these account administrators. */
function asAccountAdministrator<T>(
  stamps: readonly SubscriptionAccountAdministratorStamp[],
  fn: () => Promise<T>,
): Promise<T> {
  return withSubscriptionAccountAdministrators(
    async ({ accountId, subjectId }) =>
      stamps.find((each) => each.accountId === accountId && each.actorSubjectId === subjectId) ??
      null,
    fn,
  );
}

function credential(label: string, providerId = "codex") {
  return {
    credentialEncrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({ access_token: `a-${label}`, refresh_token: `r-${label}`, id_token: "i" }),
    ),
    providerAccountId: `upstream-${providerId}-${label}`,
    providerSubjectId: `person-${label}`,
    planType: "pro",
    expiresAt: new Date(Date.now() + 86_400_000),
    lastRefreshAt: new Date(),
    accountEmail: `${label}@example.test`,
    label,
    providerState: {},
  };
}

function connect(
  org: Org,
  subjectId: string,
  workspaceId: string | null,
  label: string,
  providerId = "codex",
) {
  return withSessionRlsActorContext({ subjectId }, () =>
    connectSubscriptionCoreConnection(client.db, subscriptionCoreProvider(providerId), {
      accountId: org.accountId,
      workspaceId,
      subjectId,
      ...credential(label, providerId),
    }),
  );
}

/** The organization's own Codex account (managed by no workspace), revoked upstream. */
async function revokedOrganizationConnection(org: Org, label: string): Promise<string> {
  const connected = await connect(org, org.ownerSubjectId, null, label);
  if (connected.kind !== "connected") throw new Error(`fixture connect failed: ${connected.kind}`);
  await shared.admin`
    update subscription_connections set status = 'needs_relogin', last_error = 'revoked'
    where account_id = ${org.accountId}::uuid and id = ${connected.id}::uuid`;
  return connected.id;
}

async function connectionRow(org: Org, id: string) {
  const [row] = await shared.admin<
    {
      status: string;
      version: number;
      label: string | null;
      managed_by: string | null;
      disconnected: boolean;
    }[]
  >`
    select status, version, label, managed_by_workspace_id::text as managed_by,
      disconnected_at is not null as disconnected
    from subscription_connections where account_id = ${org.accountId}::uuid and id = ${id}::uuid`;
  return row!;
}

async function addWorkspaceMember(org: Org, workspaceId: string, role: string): Promise<string> {
  const subjectId = `user:${role}-${crypto.randomUUID()}`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${org.accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, ${role})`;
  return subjectId;
}

describe("the migrations", () => {
  test("1149 grants runtime EXECUTE (never PUBLIC), and 1104 validated the constraints", async () => {
    const [acl] = await shared.admin<{ publicExecute: boolean; appExecute: boolean }[]>`
      select
        exists (
          select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        has_function_privilege('opengeni_app', oid, 'EXECUTE') as "appExecute"
      from pg_proc
      where oid = 'opengeni_private.grant_subscription_account_administrator(jsonb)'::regprocedure`;
    expect(acl).toEqual({ publicExecute: false, appExecute: true });
    const constraints = await shared.admin<{ name: string; validated: boolean }[]>`
      select conname as name, convalidated as validated from pg_constraint
      where conrelid = 'opengeni_private.subscription_runtime_capabilities'::regclass
        and contype = 'c' order by conname`;
    expect([...constraints]).toEqual([
      { name: "subscription_runtime_capabilities_kind_chk", validated: true },
      { name: "subscription_runtime_capabilities_provider_chk", validated: true },
    ]);
  });
});

describe("the configured key as an account administrator", () => {
  test("reconnects the organization's revoked account from a workspace it reaches", async () => {
    const org = await organization();
    const id = await revokedOrganizationConnection(org, "reconnect");
    const before = await connectionRow(org, id);
    expect(before).toMatchObject({ status: "needs_relogin", managed_by: null });

    // Without the request's proof the key is only a workspace owner, and the
    // organization's account is managed elsewhere (the reported refusal).
    expect(await connect(org, org.keySubjectId, org.workspaceIds[1], "reconnect")).toEqual({
      kind: "refused",
      reason: "managed_elsewhere",
    });

    const stamp = stampFor(org.accountId, org.keySubjectId);
    const reconnected = await asAccountAdministrator([stamp], () =>
      connect(org, org.keySubjectId, org.workspaceIds[1], "reconnect"),
    );
    expect(reconnected).toMatchObject({ kind: "connected", id, isNew: false });
    expect(await connectionRow(org, id)).toMatchObject({
      status: "active",
      version: before.version + 1,
      managed_by: null,
    });
  });

  test("connects, edits and removes organization accounts of every provider", async () => {
    const org = await organization();
    const stamp = stampFor(org.accountId, org.keySubjectId);
    for (const providerId of subscriptionCoreProviderIds()) {
      const provider = subscriptionCoreProvider(providerId);
      const label = `${providerId}-key`;
      expect(await connect(org, org.keySubjectId, null, label, providerId)).toEqual({
        kind: "refused",
        reason: "forbidden",
      });
      const connected = await asAccountAdministrator([stamp], () =>
        connect(org, org.keySubjectId, null, label, providerId),
      );
      if (connected.kind !== "connected") throw new Error(`${providerId}: ${connected.kind}`);
      expect(connected.isNew).toBe(true);

      const scope = {
        accountId: org.accountId,
        workspaceId: null,
        subjectId: org.keySubjectId,
        connectionId: connected.id,
      };
      expect(
        await renameSubscriptionCoreConnection(client.db, provider, { ...scope, label: "nope" }),
      ).toBeNull();
      expect(
        await asAccountAdministrator([stamp], () =>
          renameSubscriptionCoreConnection(client.db, provider, { ...scope, label: "Renamed" }),
        ),
      ).toBe(connected.id);
      expect((await connectionRow(org, connected.id)).label).toBe("Renamed");

      const removed = await asAccountAdministrator([stamp], () =>
        disconnectSubscriptionCoreConnection(client.db, provider, scope),
      );
      expect(removed.outcome).toBe("removed");
      expect((await connectionRow(org, connected.id)).disconnected).toBe(true);
    }
  });

  test("edits the organization's subscription settings", async () => {
    const org = await organization();
    const input = {
      organizationId: org.accountId,
      actorSubjectId: org.keySubjectId,
      patch: { crossProviderFailover: true },
    };
    await expect(updateOrganizationSubscriptionSettings(client.db, input)).rejects.toBeInstanceOf(
      SubscriptionSettingsForbiddenError,
    );
    const updated = await asAccountAdministrator([stampFor(org.accountId, org.keySubjectId)], () =>
      updateOrganizationSubscriptionSettings(client.db, input),
    );
    expect(updated.settings.values.crossProviderFailover).toBe(true);
  });

  test("a proof for another subject or account grants nothing", async () => {
    const org = await organization();
    const other = await organization();
    const id = await revokedOrganizationConnection(org, "mismatch");
    for (const stamp of [
      stampFor(org.accountId, `${org.keySubjectId}-other`),
      stampFor(other.accountId, org.keySubjectId),
    ]) {
      expect(
        await withSubscriptionAccountAdministrators(
          async () => stamp,
          () => connect(org, org.keySubjectId, org.workspaceIds[0], "mismatch"),
        ),
      ).toEqual({ kind: "refused", reason: "managed_elsewhere" });
    }
    expect((await connectionRow(org, id)).status).toBe("needs_relogin");
  });
});

describe("the database boundary", () => {
  async function inTransaction<T>(
    accountId: string,
    subjectId: string,
    fn: (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>,
  ): Promise<T> {
    return await withRlsContext(client.db, { accountId, workspaceId: null }, async (tx) => {
      await tx.execute(sql`select set_config('opengeni.subject_id', ${subjectId}, true)`);
      return await fn(tx);
    });
  }
  const admin = sql`select opengeni_private.subscription_organization_admin(
    nullif(current_setting('opengeni.account_id', true), '')::uuid) as admin`;
  const grant = (stamp: unknown) =>
    sql`select opengeni_private.grant_subscription_account_administrator(${JSON.stringify(stamp)}::jsonb) as granted`;

  test("the proof must name account:admin for exactly this account and subject", async () => {
    const org = await organization();
    const other = await organization();
    const forged = [
      { ...stampFor(org.accountId, org.keySubjectId), permission: "account:read" },
      { ...stampFor(org.accountId, org.keySubjectId), authorizationId: "not-a-uuid" },
      stampFor(other.accountId, org.keySubjectId),
      stampFor(org.accountId, org.ownerSubjectId),
      null,
      "account:admin",
    ];
    for (const stamp of forged) {
      const error = await inTransaction(org.accountId, org.keySubjectId, (tx) =>
        rawRows(tx, grant(stamp)),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect((error as { cause?: { code?: string } } | null)?.cause?.code).toBe("42501");
    }
  });

  test("authority holds only inside the granting transaction", async () => {
    const org = await organization();
    const stamp = stampFor(org.accountId, org.keySubjectId);
    expect(
      await inTransaction(org.accountId, org.keySubjectId, async (tx) => {
        const before = (await rawRows<{ admin: boolean }>(tx, admin))[0]!.admin;
        const granted = (await rawRows<{ granted: boolean }>(tx, grant(stamp)))[0]!.granted;
        const after = (await rawRows<{ admin: boolean }>(tx, admin))[0]!.admin;
        // The subject setting is part of the authority, not only the row.
        await tx.execute(sql`select set_config('opengeni.subject_id', 'configured:else', true)`);
        const otherSubject = (await rawRows<{ admin: boolean }>(tx, admin))[0]!.admin;
        return { before, granted, after, otherSubject };
      }),
    ).toEqual({ before: false, granted: true, after: true, otherSubject: false });
    expect(
      await inTransaction(org.accountId, org.keySubjectId, async (tx) => {
        const [row] = await rawRows<{ admin: boolean; xid: string | null }>(
          tx,
          sql`select opengeni_private.subscription_organization_admin(${org.accountId}::uuid) as admin,
            pg_current_xact_id_if_assigned()::text as xid`,
        );
        return row;
      }),
    ).toEqual({ admin: false, xid: null });
  });

  test("a session setting or a direct write cannot mint authority", async () => {
    const org = await organization();
    await expect(
      inTransaction(org.accountId, org.keySubjectId, (tx) =>
        tx.execute(sql`insert into opengeni_private.subscription_runtime_capabilities
          (backend_pid, transaction_id, capability_kind, account_id, session_owner_subject_id)
          values (pg_backend_pid(), pg_current_xact_id(), 'account_administrator',
            ${org.accountId}::uuid, ${org.keySubjectId})`),
      ),
    ).rejects.toThrow();
    for (const setting of ["opengeni.account_admin", "opengeni.permissions", "opengeni.role"]) {
      expect(
        await inTransaction(org.accountId, org.keySubjectId, async (tx) => {
          await tx.execute(sql`select set_config(${setting}, 'account:admin', true)`);
          return (await rawRows<{ admin: boolean }>(tx, admin))[0]!.admin;
        }),
      ).toBe(false);
    }
  });

  test("an organization membership administrator needs no recorded proof", async () => {
    const org = await organization();
    expect(
      await inTransaction(org.accountId, org.ownerSubjectId, async (tx) => {
        const granted = (
          await rawRows<{ granted: boolean }>(
            tx,
            grant(stampFor(org.accountId, org.ownerSubjectId)),
          )
        )[0]!.granted;
        const isAdmin = (await rawRows<{ admin: boolean }>(tx, admin))[0]!.admin;
        const [rows] = await rawRows<{ count: number }>(
          tx,
          sql`select pg_current_xact_id_if_assigned() is not null as count`,
        );
        return { granted, admin: isAdmin, wrote: Boolean(rows?.count) };
      }),
    ).toEqual({ granted: false, admin: true, wrote: false });
  });
});

describe("other principals", () => {
  test("an organization admin membership reconnects without a proof", async () => {
    const org = await organization();
    const id = await revokedOrganizationConnection(org, "org-admin");
    const adminSubjectId = `user:org-admin-${crypto.randomUUID()}`;
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${org.accountId}::uuid, 'Admin personal') returning id::text as id`;
    await shared.admin`
      insert into organization_memberships (account_id, subject_id, personal_workspace_id, role, status)
      values (${org.accountId}::uuid, ${adminSubjectId}, ${personal!.id}::uuid, 'admin', 'active')`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${org.accountId}::uuid, ${org.workspaceIds[2]}::uuid, ${adminSubjectId}, 'member')`;
    expect(await connect(org, adminSubjectId, org.workspaceIds[2], "org-admin")).toMatchObject({
      kind: "connected",
      id,
    });
    expect((await connectionRow(org, id)).status).toBe("active");
  });

  test("a workspace owner administers the account its workspace manages", async () => {
    const org = await organization();
    const ownerSubjectId = await addWorkspaceMember(org, org.workspaceIds[0], "owner");
    const connected = await connect(org, ownerSubjectId, org.workspaceIds[0], "ws-owner");
    if (connected.kind !== "connected") throw new Error(connected.kind);
    expect((await connectionRow(org, connected.id)).managed_by).toBe(org.workspaceIds[0]);
    await shared.admin`
      update subscription_connections set status = 'needs_relogin'
      where account_id = ${org.accountId}::uuid and id = ${connected.id}::uuid`;
    expect(await connect(org, ownerSubjectId, org.workspaceIds[0], "ws-owner")).toMatchObject({
      kind: "connected",
      id: connected.id,
      isNew: false,
    });
    const scope = {
      accountId: org.accountId,
      workspaceId: org.workspaceIds[0],
      subjectId: ownerSubjectId,
      connectionId: connected.id,
    };
    expect(
      await renameSubscriptionCoreConnection(client.db, codex(), { ...scope, label: "Own" }),
    ).toBe(connected.id);
    // The organization's own accounts stay with organization administrators.
    const organizationId = await revokedOrganizationConnection(org, "not-theirs");
    expect(await connect(org, ownerSubjectId, org.workspaceIds[0], "not-theirs")).toEqual({
      kind: "refused",
      reason: "managed_elsewhere",
    });
    expect((await connectionRow(org, organizationId)).status).toBe("needs_relogin");
  });

  test("the configured key removes its workspace's own account as a workspace owner", async () => {
    const org = await organization();
    const connected = await connect(org, org.keySubjectId, org.workspaceIds[0], "key-own");
    if (connected.kind !== "connected") throw new Error(connected.kind);
    const removed = await disconnectSubscriptionCoreConnection(client.db, codex(), {
      accountId: org.accountId,
      workspaceId: org.workspaceIds[0],
      subjectId: org.keySubjectId,
      connectionId: connected.id,
    });
    expect(removed.outcome).toBe("removed");
  });

  test("a plain member and an unrelated workspace stay refused", async () => {
    const org = await organization();
    const other = await organization();
    const id = await revokedOrganizationConnection(org, "member");
    const memberSubjectId = await addWorkspaceMember(org, org.workspaceIds[0], "member");
    expect(await connect(org, memberSubjectId, org.workspaceIds[0], "member")).toEqual({
      kind: "refused",
      reason: "managed_elsewhere",
    });
    expect(
      await renameSubscriptionCoreConnection(client.db, codex(), {
        accountId: org.accountId,
        workspaceId: org.workspaceIds[0],
        subjectId: memberSubjectId,
        connectionId: id,
        label: "member",
      }),
    ).toBeNull();
    // Another organization's administrator proof reaches nothing here, and
    // this organization's key administers nothing in the other one.
    const outsider = stampFor(other.accountId, other.keySubjectId);
    expect(
      await asAccountAdministrator([outsider], () =>
        connect(org, other.keySubjectId, org.workspaceIds[0], "member"),
      ),
    ).toMatchObject({ kind: "refused" });
    const otherId = await revokedOrganizationConnection(other, "foreign");
    expect(
      await asAccountAdministrator([stampFor(org.accountId, org.keySubjectId)], () =>
        renameSubscriptionCoreConnection(client.db, codex(), {
          accountId: other.accountId,
          workspaceId: null,
          subjectId: org.keySubjectId,
          connectionId: otherId,
          label: "hijacked",
        }),
      ),
    ).toBeNull();
    expect((await connectionRow(org, id)).status).toBe("needs_relogin");
    expect((await connectionRow(other, otherId)).label).toBe("foreign");
  });
});
