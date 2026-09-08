import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceSubjectRls } from "../src/database";
import type { ConnectAttempt } from "@opengeni/contracts/connect";
import { executeConnectOperation } from "../../core/src/application/connect-operation";
import { createDb, createWorkspace, nestedPostgresSqlState, type DbClient } from "../src";
import { ensureExternalIdentity } from "../src/external-identities";
import {
  beginExternalIdentityLink,
  confirmExternalIdentityLink,
  getExternalIdentityLink,
  resolveExternalIdentityLink,
  revokeExternalIdentityLink,
} from "../src/external-identity-links";
import { verifyExternalAdmission } from "../../core/test/external-admission-fixture";
import { verifyExternalLifecycle } from "../../core/test/external-lifecycle-fixture";
import { verifyExternalPersonal } from "../../core/test/external-personal-fixture";
import {
  beginConnectAttempt,
  claimConnectOperation,
  finishConnectOperation,
  getConnectAttempt,
  listPendingConnectAttempts,
  type ConnectActorScope,
} from "../src/connect-attempts";

let shared: SharedTestDatabase;
let client: DbClient;
let scope: ConnectActorScope;
const digest = "a".repeat(64);

describe("external identity provisioning", () => {
  test("native identity link requires two principals, narrows permission and revokes without merging", async () => {
    const identity = await ensureExternalIdentity(client.db, {
      accountId: scope.accountId,
      externalId: `native-link-${crypto.randomUUID()}`,
    });
    const nativeSubjectId = `user:${crypto.randomUUID()}`;
    const personal = await createWorkspace(client.db, {
      accountId: scope.accountId,
      name: "Native link owner",
    });
    await shared.admin`insert into organization_memberships
      (account_id, subject_id, role, status, personal_workspace_id, authorization_revision)
      values (${scope.accountId}, ${nativeSubjectId}, 'member', 'active', ${personal.id}, 1)`;
    const pending = await beginExternalIdentityLink(client.db, identity, {
      permissions: ["sessions:read", "sessions:create"],
    });
    expect(pending.link.nativeSubjectId).toBeNull();
    expect(pending.link.status).toBe("pending");
    expect(pending.link.expiresAt).toBeNull();
    const query = {
      accountId: scope.accountId,
      linkId: pending.link.id,
      subjectId: identity.subjectId,
    };
    expect(await getExternalIdentityLink(client.db, query)).toEqual(pending.link);
    expect(JSON.stringify(await getExternalIdentityLink(client.db, query))).not.toContain(
      pending.challenge,
    );
    expect(
      await getExternalIdentityLink(client.db, { ...query, subjectId: nativeSubjectId }),
    ).toBeNull();
    const confirm = {
      accountId: scope.accountId,
      linkId: pending.link.id,
      nativeSubjectId,
      request: {
        challenge: pending.challenge,
        expectedRevision: 1,
        permissions: ["sessions:read"] as const,
      },
    };
    await expect(
      confirmExternalIdentityLink(client.db, {
        ...confirm,
        request: { ...confirm.request, permissions: ["workspace:admin"] },
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      confirmExternalIdentityLink(client.db, {
        ...confirm,
        request: { ...confirm.request, permissions: ["sessions:read"], challenge: "x".repeat(43) },
      }),
    ).rejects.toThrow("unavailable");
    const confirmed = await confirmExternalIdentityLink(client.db, {
      ...confirm,
      request: { ...confirm.request, permissions: ["sessions:read"] },
    });
    expect(confirmed).toMatchObject({
      status: "active",
      revision: 2,
      nativeSubjectId,
      permissions: ["sessions:read"],
    });
    expect(
      await confirmExternalIdentityLink(client.db, {
        ...confirm,
        request: { ...confirm.request, permissions: ["sessions:read"] },
      }),
    ).toEqual(confirmed);
    expect(
      (
        await resolveExternalIdentityLink(client.db, {
          identity,
          linkId: confirmed.id,
          expectedRevision: 2,
        })
      )?.personalWorkspaceId,
    ).toBe(personal.id);
    expect(
      await resolveExternalIdentityLink(client.db, {
        identity,
        linkId: confirmed.id,
        expectedRevision: 1,
      }),
    ).toBeNull();
    const stranger = await ensureExternalIdentity(client.db, {
      accountId: scope.accountId,
      externalId: `stranger-${crypto.randomUUID()}`,
    });
    expect(
      await resolveExternalIdentityLink(client.db, {
        identity: stranger,
        linkId: confirmed.id,
        expectedRevision: 2,
      }),
    ).toBeNull();
    const revoked = await revokeExternalIdentityLink(client.db, {
      ...query,
      subjectId: nativeSubjectId,
      expectedRevision: 2,
    });
    expect(revoked).toMatchObject({ status: "revoked", revision: 3 });
    expect(await revokeExternalIdentityLink(client.db, { ...query, expectedRevision: 2 })).toEqual(
      revoked,
    );
    expect(
      await resolveExternalIdentityLink(client.db, {
        identity,
        linkId: confirmed.id,
        expectedRevision: 2,
      }),
    ).toBeNull();
    await expect(
      confirmExternalIdentityLink(client.db, {
        ...confirm,
        request: { ...confirm.request, permissions: ["sessions:read"] },
      }),
    ).rejects.toThrow("unavailable");
    expect(
      (
        await ensureExternalIdentity(client.db, {
          accountId: scope.accountId,
          externalId: identity.externalId,
        })
      ).subjectId,
    ).toBe(identity.subjectId);
    const [native] =
      await shared.admin`select status from organization_memberships where account_id = ${scope.accountId} and subject_id = ${nativeSubjectId}`;
    expect(native?.status).toBe("active");
    const otherPending = await beginExternalIdentityLink(client.db, identity, {
      permissions: ["sessions:read"],
    });
    expect(otherPending.link.id).not.toBe(confirmed.id);
    await shared.admin`update organization_memberships set status = 'suspended', authorization_revision = authorization_revision + 1
      where account_id = ${scope.accountId} and subject_id = ${nativeSubjectId}`;
    await expect(
      confirmExternalIdentityLink(client.db, {
        ...confirm,
        linkId: otherPending.link.id,
        request: {
          challenge: otherPending.challenge,
          expectedRevision: 1,
          permissions: ["sessions:read"],
        },
      }),
    ).rejects.toThrow("unavailable");
  });
  test("verified external owners can use Personal and private sessions without native cookie authority", async () => {
    // Activation receipts, like native tenancy fixtures, are immutable and
    // intentionally retained until the test database is discarded.
    const [account] =
      await shared.admin`insert into managed_accounts (name) values ('External Personal activation fixture') returning id`;
    if (!account) throw new Error("Personal account seed failed");
    const workspace = await createWorkspace(client.db, {
      accountId: account.id,
      name: "External Personal",
    });
    await verifyExternalPersonal(client.db, shared.admin, {
      accountId: account.id,
      workspaceId: workspace.id,
    });
  });
  test("service lifecycle suspends, reactivates and offboards without restoring revoked grants", async () => {
    // Like the native lifecycle fixtures, this account retains immutable audit
    // history until the test database is discarded. Never disable production
    // history triggers to make ordinary fixture-account deletion succeed.
    const [account] =
      await shared.admin`insert into managed_accounts (name) values ('External lifecycle immutable-history fixture') returning id`;
    if (!account) throw new Error("Lifecycle account seed failed");
    const workspace = await createWorkspace(client.db, {
      accountId: account.id,
      name: "External lifecycle",
    });
    await verifyExternalLifecycle(client.db, shared.admin, {
      accountId: account.id,
      workspaceId: workspace.id,
    });
  });
  test("external HTTP admission requires explicit membership, respects the key ceiling and revocation", async () => {
    await verifyExternalAdmission(client.db, shared.admin, scope);
  });
  test("maximum-byte Unicode tuples persist and replay without normalization", async () => {
    const input = {
      accountId: scope.accountId,
      externalId: Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x1f300 + i)).join(""),
      source: "😀".repeat(50),
    };
    const value = await ensureExternalIdentity(client.db, input);
    expect(value.externalId).toBe(input.externalId);
    expect(value.source).toBe(input.source);
    expect((await ensureExternalIdentity(client.db, input)).id).toBe(value.id);
    await expect(
      ensureExternalIdentity(client.db, { ...input, externalId: input.externalId + "a" }),
    ).rejects.toThrow("UTF-8 bytes");
  });
  test("identical external tuples are independent across organizations", async () => {
    const [account] =
      await shared.admin`insert into managed_accounts (name) values ('External identity boundary') returning id`;
    if (!account) throw new Error("Fixture account missing");
    try {
      const first = await ensureExternalIdentity(client.db, {
        accountId: scope.accountId,
        externalId: "same",
        source: "same",
      });
      const second = await ensureExternalIdentity(client.db, {
        accountId: account.id,
        externalId: "same",
        source: "same",
      });
      expect(first.id).not.toBe(second.id);
      expect(first.personalWorkspaceId).not.toBe(second.personalWorkspaceId);
      expect(first.organizationMembershipId).not.toBe(second.organizationMembershipId);
      expect(
        (
          await ensureExternalIdentity(client.db, {
            accountId: scope.accountId,
            externalId: "same",
            source: "same",
          })
        ).id,
      ).toBe(first.id);
    } finally {
      await shared.admin`delete from managed_accounts where id = ${account.id}`;
    }
  });

  test("disabled mapping is not resurrected by lazy reuse", async () => {
    const input = { accountId: scope.accountId, externalId: "disabled" };
    const value = await ensureExternalIdentity(client.db, input);
    await shared.admin`update external_identities set status = 'disabled', authorization_revision = authorization_revision + 1 where id = ${value.id}`;
    expect(
      await ensureExternalIdentity(client.db, input).then(
        () => null,
        (error) => nestedPostgresSqlState(error),
      ),
    ).toBe("42501");
    const [row] =
      await shared.admin`select status, authorization_revision::int as revision from external_identities where id = ${value.id}`;
    expect(row).toMatchObject({ status: "disabled", revision: 2 });
  });

  test("concurrent opaque identity provisioning creates one member without shared access", async () => {
    const input = {
      accountId: scope.accountId,
      externalId: "user:native-looking/opaque",
      source: "host",
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensureExternalIdentity(client.db, input)),
    );
    expect(new Set(results.map((value) => value.id)).size).toBe(1);
    const value = results[0]!;
    expect(value.subjectId).toBe(`external_user:${value.id}`);
    const [count] =
      await shared.admin`select count(*)::int as count from workspace_memberships where account_id = ${scope.accountId} and subject_id = ${value.subjectId}`;
    expect(count?.count).toBe(0);
    const different = await ensureExternalIdentity(client.db, {
      ...input,
      externalId: "user:Native-looking/opaque",
    });
    expect(different.id).not.toBe(value.id);
    await expect(rawRows(client.db, sql`select * from external_identities`)).rejects.toThrow();
  });

  test("lazy reuse does not reactivate a suspended organization member", async () => {
    const input = { accountId: scope.accountId, externalId: "suspended" };
    const value = await ensureExternalIdentity(client.db, input);
    await shared.admin`update organization_memberships set status = 'suspended' where id = ${value.organizationMembershipId}`;
    const result = await ensureExternalIdentity(client.db, input).then(
      () => null,
      (error) => nestedPostgresSqlState(error),
    );
    expect(result).toBe("42501");
    const [row] =
      await shared.admin`select status from organization_memberships where id = ${value.organizationMembershipId}`;
    expect(row?.status).toBe("suspended");
  });
});

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_APP_URL;
  if ((adminUrl === undefined) !== (appUrl === undefined))
    throw new Error("Set both PostgreSQL fixture URLs");
  const admin = adminUrl ? postgres(adminUrl, { max: 12 }) : null;
  const acquired =
    admin && adminUrl && appUrl
      ? {
          admin,
          adminUrl,
          appUrl,
          release: async () => {
            await admin.end();
          },
        }
      : await acquireSharedTestDatabase("connect-attempts");
  if (!acquired) throw new Error("Connect attempt persistence tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 12 });
  const [account] = await shared.admin<Array<{ id: string }>>`
    insert into managed_accounts (name) values ('Connect tests') returning id`;
  if (!account) throw new Error("Account seed failed");
  const workspace = await createWorkspace(client.db, {
    accountId: account.id,
    name: "Connect tests",
  });
  scope = { accountId: account.id, workspaceId: workspace.id, subjectId: "test:connect-owner" };
}, 180_000);
afterAll(async () => {
  if (shared && scope)
    await shared.admin`delete from managed_accounts where id = ${scope.accountId}`;
  await client?.close();
  await shared?.release();
});

function attempt(): ConnectAttempt {
  return {
    id: crypto.randomUUID(),
    workspaceId: scope.workspaceId,
    providerId: "provider",
    ownership: "workspace",
    revision: 1,
    state: "requires_user_action",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "integration",
    nextAction: { type: "authorize", url: "https://provider.example.com/authorize" },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}
async function begin(value = attempt()) {
  return beginConnectAttempt(client.db, scope, {
    idempotencyKey: value.id,
    requestDigest: digest,
    returnUrl: "https://host.example.com/callback?opaque=%2f#original",
    attempt: value,
  });
}

describe("durable Connect attempts", () => {
  test("a claimed operation cannot retarget its named installation or rewrite origin fields", async () => {
    const value = await begin({
      ...attempt(),
      installationTarget: {
        instanceKey: "finance",
        displayName: "Finance",
        expectedInstanceVersion: 4,
      },
    });
    const input = {
      attemptId: value.id,
      operationId: crypto.randomUUID(),
      expectedRevision: value.revision,
      inputDigest: digest,
    };
    await claimConnectOperation(client.db, scope, input);
    await expect(
      finishConnectOperation(client.db, scope, {
        ...input,
        commit: async (_tx, current) => ({
          ...current,
          revision: current.revision + 1,
          installationTarget: { instanceKey: "another", displayName: "Another" },
        }),
      }),
    ).rejects.toThrow("changed");
    let denial: unknown;
    try {
      await withWorkspaceSubjectRls(client.db, scope.workspaceId, scope.subjectId, (tx) =>
        tx.execute(sql`
      update connect_attempts set return_url = 'https://changed.example' where id = ${value.id}::uuid`),
      );
    } catch (error) {
      denial = error;
    }
    expect(nestedPostgresSqlState(denial)).toBe("42501");
    const stored = await getConnectAttempt(client.db, scope, value.id);
    expect(stored.attempt.installationTarget).toEqual(value.installationTarget);
    expect(stored.operationInFlight).toBe(true);
  });
  test("coordinator reauthorizes replay without repeating the provider effect", async () => {
    const value = await begin();
    let allowed = true;
    let effects = 0;
    const order: string[] = [];
    const operation = {
      db: client.db,
      scope,
      attemptId: value.id,
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
      inputDigest: digest,
      authorize: async () => {
        order.push("authorize");
        if (!allowed) throw new Error("Test authority revoked");
      },
      execute: async () => {
        order.push("provider");
        effects++;
        // A separate connection sees the committed claim before effects start.
        expect((await getConnectAttempt(client.db, scope, value.id)).operationInFlight).toBe(true);
        return {
          commit: async (_tx: unknown, current: ConnectAttempt) => {
            order.push("commit");
            return { ...current, revision: current.revision + 1 };
          },
        };
      },
    };
    const result = await executeConnectOperation(operation);
    expect(order).toEqual(["authorize", "provider", "authorize", "commit"]);
    expect(await executeConnectOperation(operation)).toEqual(result);
    expect(effects).toBe(1);
    allowed = false;
    await expect(executeConnectOperation(operation)).rejects.toThrow("Test authority revoked");
    expect(effects).toBe(1);
  });

  test("post-provider authority rejection preserves claim and never commits credentials", async () => {
    const value = await begin();
    let allowed = true;
    let commits = 0;
    await expect(
      executeConnectOperation({
        db: client.db,
        scope,
        attemptId: value.id,
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
        inputDigest: digest,
        authorize: async () => {
          if (!allowed) throw new Error("Test authority revoked");
        },
        execute: async () => {
          allowed = false;
          return {
            commit: async (_tx, current) => {
              commits++;
              return { ...current, revision: 2 };
            },
          };
        },
      }),
    ).rejects.toThrow("Test authority revoked");
    expect(commits).toBe(0);
    const stored = await getConnectAttempt(client.db, scope, value.id);
    expect(stored.operationInFlight).toBe(true);
    expect(stored.attempt.revision).toBe(1);
  });

  test("provider failure retains the claim and a repeated call cannot repeat its effect", async () => {
    const value = await begin();
    let effects = 0;
    const operation = {
      db: client.db,
      scope,
      attemptId: value.id,
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
      inputDigest: digest,
      authorize: async () => {},
      execute: async () => {
        effects++;
        throw new Error("Test provider outcome unknown");
      },
    };
    await expect(executeConnectOperation(operation)).rejects.toThrow(
      "Test provider outcome unknown",
    );
    await expect(executeConnectOperation(operation)).rejects.toThrow("in flight or uncertain");
    expect(effects).toBe(1);
  });

  test("FORCE RLS denies another actor even without application actor predicates", async () => {
    const value = await begin();
    const rows = await withWorkspaceSubjectRls(
      client.db,
      scope.workspaceId,
      "test:connect-stranger",
      async (tx) => {
        return rawRows<{ id: string }>(
          tx,
          sql`select id from connect_attempts where id = ${value.id}::uuid`,
        );
      },
    );
    expect(rows).toEqual([]);
    const [role] = await rawRows<{ superuser: boolean; bypass: boolean }>(
      client.db,
      sql`select rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ superuser: false, bypass: false });
  });

  test("an expired attempt cannot start another operation and expires durably on read", async () => {
    const value = attempt();
    value.expiresAt = new Date(Date.now() - 1000).toISOString();
    await begin(value);
    await expect(
      claimConnectOperation(client.db, scope, {
        attemptId: value.id,
        operationId: crypto.randomUUID(),
        inputDigest: digest,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("changed");
    const first = await getConnectAttempt(client.db, scope, value.id);
    const second = await getConnectAttempt(client.db, scope, value.id);
    expect(first.attempt.state).toBe("expired");
    expect(second.attempt.revision).toBe(first.attempt.revision);
  });
  test("concurrent creation replays one ID and preserves exact return URL", async () => {
    const value = attempt();
    const values = await Promise.all(Array.from({ length: 8 }, () => begin(value)));
    expect(new Set(values.map((item) => item.id)).size).toBe(1);
    const stored = await getConnectAttempt(client.db, scope, value.id);
    expect(stored.returnUrl).toBe("https://host.example.com/callback?opaque=%2f#original");
    await expect(
      beginConnectAttempt(client.db, scope, {
        idempotencyKey: value.id,
        requestDigest: "b".repeat(64),
        returnUrl: stored.returnUrl,
        attempt: value,
      }),
    ).rejects.toThrow("different input");
  });

  test("another actor or account cannot read or discover an attempt", async () => {
    const value = await begin();
    const other = { ...scope, subjectId: "test:connect-stranger" };
    await expect(getConnectAttempt(client.db, other, value.id)).rejects.toThrow("not found");
    expect(await listPendingConnectAttempts(client.db, other)).toEqual([]);
    await expect(
      getConnectAttempt(client.db, { ...scope, accountId: crypto.randomUUID() }, value.id),
    ).rejects.toThrow("not found");
  });

  test("one committed claim prevents duplicate physical work and completion replays its receipt", async () => {
    const value = await begin();
    const input = {
      attemptId: value.id,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      inputDigest: digest,
    };
    const claims = await Promise.allSettled([
      claimConnectOperation(client.db, scope, input),
      claimConnectOperation(client.db, scope, input),
    ]);
    expect(claims.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((item) => item.status === "rejected")).toHaveLength(1);
    let commits = 0;
    const finish = () =>
      finishConnectOperation(client.db, scope, {
        ...input,
        commit: async (_tx, current) => {
          commits++;
          return {
            ...current,
            revision: 2,
            credentialsCommitted: true,
            state: "connected_but_incomplete",
            nextAction: { type: "none" },
          };
        },
      });
    const first = await finish();
    expect(await finish()).toEqual(first);
    expect(commits).toBe(1);
    expect((await claimConnectOperation(client.db, scope, input)).status).toBe("replayed");
  });

  test("invalid immutable-field change rolls back and leaves the original claim", async () => {
    const value = await begin();
    const input = {
      attemptId: value.id,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      inputDigest: digest,
    };
    await claimConnectOperation(client.db, scope, input);
    await expect(
      finishConnectOperation(client.db, scope, {
        ...input,
        commit: async (_tx, current) => ({
          ...current,
          revision: 2,
          providerId: "another-provider",
        }),
      }),
    ).rejects.toThrow("changed");
    const stored = await getConnectAttempt(client.db, scope, value.id);
    expect(stored.attempt.providerId).toBe("provider");
    expect(stored.attempt.revision).toBe(1);
    expect(stored.operationInFlight).toBe(true);
  });
});
