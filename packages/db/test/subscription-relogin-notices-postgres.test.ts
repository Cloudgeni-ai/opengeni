/**
 * Migration 1503: a subscription account that needs signing in again tells
 * the person who connected it, once per sign-in, in their inbox and on their
 * phone, with a link straight to that account's sign-in step. When that
 * person can no longer reconnect it, the organization's owners and admins
 * are told instead. Each account also remembers when it was last signed in:
 * connecting and reconnecting stamp it, a credential refresh does not.
 *
 * Runs under the documented migration posture: a NOSUPERUSER, NOBYPASSRLS
 * owner migrates the database, so FORCE row security on
 * subscription_connections and organization_memberships binds the owner-run
 * notice writer as it does in production; the application role runs the
 * runtime reads.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  createDb,
  ensureManagedAccessForUser,
  listInboxEntries,
  listInboxItems,
  updateInboxItemAttention,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanExactLoginBindingForAuthUser,
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "../src/canonical-human-identities";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { connectSubscriptionCoreConnection } from "../src/subscription-core/connections";
import { subscriptionCoreProvider } from "../src/subscription-core-providers";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: OwnerMigratedTestDatabase;
let client: DbClient;
const key = Buffer.alloc(32, 61);

beforeAll(async () => {
  if (!realDb) return;
  const acquired = await acquireOwnerMigratedTestDatabase("subscription-relogin-notices");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  await migrate(shared.ownerUrl);
  await provisionRoles(shared.adminUrl, { appPassword: shared.appPassword });
  const url = new URL(shared.ownerUrl);
  url.username = "opengeni_app";
  url.password = shared.appPassword;
  client = createDb(url.toString(), { max: 4 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Person = { userId: string; subjectId: string; authSessionId: string };

/** A signed-in person with a phone that takes needs-you pushes. */
async function person(label: string): Promise<Person> {
  const userId = crypto.randomUUID();
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${`Relogin ${label}`}, ${`relogin-${userId}@example.test`}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
    values (${crypto.randomUUID()}, ${userId}, ${userId}, 'credential', now(), now())`;
  await ensureCanonicalHumanIdentityForAuthUser(client.db, userId);
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = await getCanonicalHumanExactLoginBindingForAuthUser(client.db, {
    authUserId: userId,
    providerId: "credential",
  });
  const authSessionId = crypto.randomUUID();
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, user_agent,
      identity_id, identity_revision, auth_revision, login_binding_id, login_binding_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '7 days',
      'OpenGeni app (iOS)', ${projection.activeIdentity.id},
      ${projection.activeIdentity.identityRevision}, ${projection.activeIdentity.authRevision},
      ${binding.id}, ${binding.revision}
    )`;
  const subjectId = `user:${userId}`;
  await shared.admin`
    insert into opengeni_private.native_push_devices
      (auth_session_id, subject_id, platform, app_id, environment, token, rules)
    values (${authSessionId}, ${subjectId}, 'ios', 'ai.opengeni.app', 'development',
      ${crypto.randomUUID().replace(/-/g, "")}, array['needs_input'])`;
  return { userId, subjectId, authSessionId };
}

type Org = { accountId: string; owner: Person; sharedWorkspaceId: string };

async function organization(): Promise<Org> {
  const owner = await person("owner");
  const access = await ensureManagedAccessForUser(client.db, {
    userId: owner.userId,
    email: `relogin-${owner.userId}@example.test`,
    name: "Relogin owner",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Team')
    returning id::text as id`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid)`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${owner.subjectId}, 'owner')`;
  return { accountId, owner, sharedWorkspaceId: workspace!.id };
}

/** Another active member of the organization, with their own Personal workspace. */
async function member(org: Org, role: "admin" | "member"): Promise<Person> {
  const joined = await person(role);
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${org.accountId}::uuid, 'Personal')
    returning id::text as id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${org.accountId}::uuid, ${joined.subjectId}, ${role}, 'active', ${personal!.id}::uuid)`;
  return joined;
}

async function personalWorkspace(org: Org, subjectId: string): Promise<string> {
  const [row] = await shared.admin<{ id: string }[]>`
    select personal_workspace_id::text as id from organization_memberships
    where account_id = ${org.accountId}::uuid and subject_id = ${subjectId}`;
  return row!.id;
}

function connectClaude(org: Org, workspaceId: string | null, email: string) {
  return withSessionRlsActorContext({ subjectId: org.owner.subjectId }, async () => {
    const connected = await connectSubscriptionCoreConnection(
      client.db,
      subscriptionCoreProvider("claude"),
      {
        accountId: org.accountId,
        workspaceId,
        subjectId: org.owner.subjectId,
        connectedBySubjectId: org.owner.subjectId,
        credentialEncrypted: encryptEnvironmentValue(
          key,
          JSON.stringify({ access_token: `a-${crypto.randomUUID()}`, refresh_token: "r" }),
        ),
        providerAccountId: `upstream-claude-${email}`,
        providerSubjectId: `upstream-claude-${email}`,
        planType: "max",
        expiresAt: new Date(Date.now() + 3_600_000),
        lastRefreshAt: new Date(),
        accountEmail: email,
        label: null,
        providerState: {},
      },
    );
    if (connected.kind !== "connected") throw new Error(`connect failed: ${connected.kind}`);
    return connected.id;
  });
}

async function connection(id: string) {
  const [row] = await shared.admin<
    { status: string; version: number; signed_in_at: Date | null; created_at: Date }[]
  >`select status, version, signed_in_at, created_at from subscription_connections
    where id = ${id}::uuid`;
  return row!;
}

/** What a model request that stays unauthorized after a refresh records. */
async function refusedUpstream(id: string) {
  await shared.admin`
    update subscription_connections
    set status = 'needs_relogin', last_error = 'Sign-in expired', version = version + 1
    where id = ${id}::uuid`;
}

async function notices(org: Org, subjectId: string) {
  return (await listInboxEntries(client.db, { accountId: org.accountId, subjectId })).filter(
    (row) => row.sessionId === null,
  );
}

async function noticeRows(id: string) {
  return await shared.admin<{ recipient: string; status: string; source_key: string }[]>`
    select recipient_subject_id as recipient, status, source_key
    from opengeni_private.inbox_items
    where session_id is null and source_key like ${`subscription-relogin:${id}:%`}
    order by created_at`;
}

async function pushes(authSessionId: string) {
  return await shared.admin<{ rule: string; payload: Record<string, unknown> }[]>`
    select rule, payload from opengeni_private.native_push_deliveries
    where auth_session_id = ${authSessionId} order by created_at`;
}

describe.skipIf(!realDb)("an account that needs signing in again", () => {
  test("runs with the owner and the application role bound by row security", async () => {
    const roles = await shared.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles
      where rolname in (${shared.ownerRole}, 'opengeni_app')`;
    expect([...roles]).toEqual([
      { rolsuper: false, rolbypassrls: false },
      { rolsuper: false, rolbypassrls: false },
    ]);
  });

  test("tells the person who connected it once per sign-in, linking to its sign-in", async () => {
    const org = await organization();
    const email = `claude-${crypto.randomUUID()}@example.test`;
    const id = await connectClaude(org, null, email);
    const connected = await connection(id);
    expect(connected.signed_in_at).not.toBeNull();

    // A credential refresh is not a sign-in.
    await shared.admin`
      update subscription_connections
      set credential_encrypted = credential_encrypted || 'x',
        refresh_generation = refresh_generation + 1
      where id = ${id}::uuid`;
    expect((await connection(id)).signed_in_at).toEqual(connected.signed_in_at);
    expect(await notices(org, org.owner.subjectId)).toEqual([]);

    await refusedUpstream(id);
    const personal = await personalWorkspace(org, org.owner.subjectId);
    const path = `/workspaces/${personal}/organization?section=models&view=connect-org:claude_subscription&account=org:claude:${id}`;
    const [notice, ...others] = await notices(org, org.owner.subjectId);
    expect(others).toEqual([]);
    expect(notice).toMatchObject({
      sessionId: null,
      workspaceId: personal,
      kind: "notification",
      title: "Sign in to Claude again",
      subtitle: email,
      link: { url: path, label: "Sign in again" },
      status: "open",
      unread: true,
    });
    expect(notice!.body).toContain(`Claude stopped accepting the sign-in for ${email}`);
    // Chat-only readers (an agent's notification tools) never meet it.
    expect(
      (
        await listInboxItems(client.db, {
          accountId: org.accountId,
          subjectId: org.owner.subjectId,
        })
      ).length,
    ).toBe(0);
    const [push, ...morePushes] = await pushes(org.owner.authSessionId);
    expect(morePushes).toEqual([]);
    expect(push).toMatchObject({
      rule: "needs_input",
      payload: {
        rule: "needs_input",
        eventType: "subscription.connection.needs_relogin",
        workspaceId: personal,
        subjectId: org.owner.subjectId,
        title: "Sign in to Claude again",
        subtitle: email,
        link: path,
      },
    });
    expect(push!.payload.sessionId).toBeUndefined();

    // Leaving needs_relogin without a new sign-in (a recovered status) closes
    // the notice, and refusing the same sign-in again tells nobody again.
    await shared.admin`
      update subscription_connections set status = 'active', version = version + 1
      where id = ${id}::uuid`;
    expect(await notices(org, org.owner.subjectId)).toEqual([]);
    await refusedUpstream(id);
    expect(await notices(org, org.owner.subjectId)).toEqual([]);
    expect((await noticeRows(id)).map((row) => row.status)).toEqual(["resolved"]);
    expect(await pushes(org.owner.authSessionId)).toHaveLength(1);

    // Signing in again stamps the sign-in and closes nothing new; when the
    // new sign-in is refused later, the person is told again.
    expect(await connectClaude(org, null, email)).toBe(id);
    const reconnected = await connection(id);
    expect(reconnected.status).toBe("active");
    expect(reconnected.signed_in_at!.getTime()).toBeGreaterThan(connected.signed_in_at!.getTime());
    await refusedUpstream(id);
    expect(await notices(org, org.owner.subjectId)).toHaveLength(1);
    expect((await noticeRows(id)).map((row) => row.status)).toEqual(["resolved", "open"]);
    expect(await pushes(org.owner.authSessionId)).toHaveLength(2);
  });

  test("while the runtime may not sync yet, signing in again leaves the notice for the person to dismiss", async () => {
    const org = await organization();
    const email = `again-${crypto.randomUUID()}@example.test`;
    const id = await connectClaude(org, null, email);
    await refusedUpstream(id);
    const [notice] = await notices(org, org.owner.subjectId);
    expect(notice?.body).not.toContain("can't reconnect it");
    // The reconnect is the application role's own write.
    expect(await connectClaude(org, null, email)).toBe(id);
    expect((await connection(id)).status).toBe("active");
    expect(await notices(org, org.owner.subjectId)).toHaveLength(1);
    expect(
      await updateInboxItemAttention(client.db, {
        itemId: notice!.id,
        accountId: org.accountId,
        subjectId: org.owner.subjectId,
        dismissed: true,
      }),
    ).toBe(true);
    expect(await notices(org, org.owner.subjectId)).toEqual([]);
  });

  test("once the runtime may sync, signing in again closes the open notice", async () => {
    const sync = "opengeni_private.sync_subscription_relogin_notice_v1(uuid)";
    await shared.admin.unsafe(`grant execute on function ${sync} to opengeni_app`);
    try {
      const org = await organization();
      const email = `granted-${crypto.randomUUID()}@example.test`;
      const id = await connectClaude(org, null, email);
      await refusedUpstream(id);
      expect(await notices(org, org.owner.subjectId)).toHaveLength(1);
      expect(await connectClaude(org, null, email)).toBe(id);
      expect((await connection(id)).status).toBe("active");
      expect(await notices(org, org.owner.subjectId)).toEqual([]);
      expect((await noticeRows(id)).map((row) => row.status)).toEqual(["resolved"]);
    } finally {
      await shared.admin.unsafe(`revoke execute on function ${sync} from opengeni_app`);
    }
  });

  test("a status write by a role that may not sync tells nobody and still succeeds", async () => {
    // The runtime role's EXECUTE on the sync is withheld for one release.
    const [grant] = await shared.admin<{ allowed: boolean }[]>`
      select has_function_privilege('opengeni_app',
        'opengeni_private.sync_subscription_relogin_notice_v1(uuid)', 'EXECUTE') as allowed`;
    expect(grant!.allowed).toBe(false);

    const org = await organization();
    const id = await connectClaude(org, null, `withheld-${crypto.randomUUID()}@example.test`);
    const writer = `relogin_writer_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    // The application role's privileges, without its row security context.
    await shared.admin.unsafe(`create role ${writer} nologin bypassrls in role opengeni_app`);
    try {
      const writeAs = async (status: string) =>
        await shared.admin.begin(async (tx) => {
          await tx.unsafe(`set local role ${writer}`);
          await tx`
            update subscription_connections
            set status = ${status}, version = version + 1 where id = ${id}::uuid`;
        });

      await writeAs("needs_relogin");
      expect((await connection(id)).status).toBe("needs_relogin");
      expect(await noticeRows(id)).toHaveLength(0);

      // Once a later release grants EXECUTE, the same write tells them.
      await writeAs("active");
      await shared.admin.unsafe(
        `grant execute on function opengeni_private.sync_subscription_relogin_notice_v1(uuid) to ${writer}`,
      );
      await writeAs("needs_relogin");
      expect(await notices(org, org.owner.subjectId)).toHaveLength(1);
    } finally {
      await shared.admin.unsafe(`drop owned by ${writer}`);
      await shared.admin.unsafe(`drop role ${writer}`);
    }
  });

  test("a workspace's own account links to that workspace's sign-in step", async () => {
    const org = await organization();
    const id = await connectClaude(
      org,
      org.sharedWorkspaceId,
      `team-${crypto.randomUUID()}@example.test`,
    );
    await refusedUpstream(id);
    const personal = await personalWorkspace(org, org.owner.subjectId);
    const [notice] = await notices(org, org.owner.subjectId);
    expect(notice?.link.url).toBe(
      `/workspaces/${personal}/organization?section=models&workspace=${org.sharedWorkspaceId}&view=connect:claude_subscription&account=claude:${id}`,
    );
  });

  test("tells the owners and admins when the person who connected it can't reconnect it", async () => {
    const org = await organization();
    const admin = await member(org, "admin");
    const bystander = await member(org, "member");
    const id = await connectClaude(org, null, `shared-${crypto.randomUUID()}@example.test`);
    // The person who connected it no longer administers the organization.
    await shared.admin`
      update organization_memberships set role = 'member'
      where account_id = ${org.accountId}::uuid and subject_id = ${org.owner.subjectId}`;
    await refusedUpstream(id);
    expect(await notices(org, org.owner.subjectId)).toEqual([]);
    expect(await notices(org, bystander.subjectId)).toEqual([]);
    const [notice] = await notices(org, admin.subjectId);
    const adminPersonal = await personalWorkspace(org, admin.subjectId);
    expect(notice).toMatchObject({
      workspaceId: adminPersonal,
      link: {
        url: `/workspaces/${adminPersonal}/organization?section=models&view=connect-org:claude_subscription&account=org:claude:${id}`,
      },
    });
    expect(notice!.body).toContain("the person who connected it can't reconnect it");
    expect(await pushes(admin.authSessionId)).toHaveLength(1);
  });
});
