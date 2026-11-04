// Migration 1233: a Personal workspace's owner, verified as acting as
// themselves, changes its model account settings the organization has not
// locked, as a shared workspace's administrators can. Every check of authority
// runs as the restricted application role on a database owned by a
// NOSUPERUSER NOBYPASSRLS role, so FORCE ROW LEVEL SECURITY engages; the
// superuser handle only reads ground truth.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  readWorkspaceSubscriptionSettings,
  setSubscriptionCoreCodexRotation,
  setSubscriptionCoreWorkspaceCodexSource,
  SubscriptionSettingsForbiddenError,
  SubscriptionSettingsLockedError,
  SubscriptionSettingsPersonalWorkspaceError,
  updateOrganizationSubscriptionSettings,
  updateWorkspaceSubscriptionSettings,
  type DbClient,
} from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

function appUrl(database: OwnerMigratedTestDatabase): string {
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  return url.toString();
}

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireOwnerMigratedTestDatabase("personal-owner-model-account-settings");
  if (!shared) throw new Error("Real PostgreSQL is required");
  await migrate(shared.ownerUrl);
  await provisionRoles(shared.adminUrl, { appPassword: shared.appPassword });
  client = createDb(appUrl(shared), { max: 6 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Person = { userId: string; subjectId: string };
type Member = Person & { accountId: string; personalId: string };

function person(label: string): Person {
  const userId = `owner-settings-${label}-${crypto.randomUUID()}`;
  return { userId, subjectId: `user:${userId}` };
}

async function provision(who: Person) {
  return await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId: who.userId,
    email: `${who.userId}@example.test`,
    name: "Owner settings",
  });
}

/** A new organization: its owner, with their Personal workspace. */
async function organization(): Promise<Member> {
  const owner = person("owner");
  const membership = (await provision(owner)).organizationMemberships[0]!;
  return {
    ...owner,
    accountId: membership.organizationId,
    personalId: membership.personalWorkspaceId!,
  };
}

/** Invite `who` into the owner's organization; their Personal workspace there. */
async function join(
  owner: Member,
  role: "member" | "admin",
  who: Person = person(role),
): Promise<Member> {
  await provision(who);
  const invitation = await createOrganizationInvitation(client!.db, {
    organizationId: owner.accountId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: who.subjectId,
    targetEmail: `${who.userId}@example.test`,
    role,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const accepted = await acceptOrganizationInvitation(client!.db, {
    organizationId: owner.accountId,
    actorSubjectId: who.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  return {
    userId: who.userId,
    subjectId: who.subjectId,
    accountId: owner.accountId,
    personalId: accepted.membership.personalWorkspaceId!,
  };
}

/** A shared workspace with these administrators and plain members. */
async function sharedWorkspace(
  accountId: string,
  admins: readonly Person[],
  members: readonly Person[],
): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Team')
    returning id::text as id`;
  for (const [who, role] of [
    ...admins.map((admin) => [admin, "admin"] as const),
    ...members.map((member) => [member, "member"] as const),
  ])
    await shared!
      .admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}::uuid, ${row!.id}::uuid, ${who.subjectId}, ${role})`;
  return row!.id;
}

function inWorkspace(accountId: string, workspaceId: string, subjectId: string, verified = false) {
  return { accountId, workspaceId, subjectId, personalWorkspaceOwnerVerified: verified };
}

function own(member: Member, verified = true) {
  return inWorkspace(member.accountId, member.personalId, member.subjectId, verified);
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

type Row = {
  cross_provider_failover: boolean | null;
  personal_connections_allowed: boolean | null;
  fallback_order: Record<string, string[]> | null;
  rotation: Record<string, unknown> | null;
  providers: Record<string, unknown> | null;
};

async function settingsRow(workspaceId: string): Promise<Row | null> {
  const [row] = await shared!.admin<Row[]>`
    select cross_provider_failover, personal_connections_allowed, fallback_order, rotation,
      providers
    from subscription_settings where workspace_id = ${workspaceId}::uuid`;
  return row ?? null;
}

/**
 * Raw writes as the application role in a workspace context, optionally
 * declaring a verified owner: the SQLSTATE if refused, else the rows changed.
 */
async function asApp(
  context: { accountId: string; workspaceId: string | null; subjectId: string },
  declared: string | null,
  run: (tx: Database) => Promise<unknown[]>,
): Promise<string | number> {
  try {
    return await withRlsContext(
      client!.db,
      { accountId: context.accountId, workspaceId: context.workspaceId },
      async (tx) => {
        await setSubjectRlsContext(tx, context.subjectId);
        if (declared !== null)
          await rawRows(
            tx,
            sql`select set_config('opengeni.personal_workspace_owner_settings', ${declared}, true)`,
          );
        return (await run(tx)).length;
      },
    );
  } catch (error) {
    let current = error as { code?: string; cause?: unknown } | undefined;
    while (current && !current.code && current.cause) current = current.cause as typeof current;
    return current?.code ?? String(error);
  }
}

const insertRow = (accountId: string, workspaceId: string) => (tx: Database) =>
  rawRows(
    tx,
    sql`insert into subscription_settings (account_id, workspace_id, cross_provider_failover)
      values (${accountId}::uuid, ${workspaceId}::uuid, true) returning id`,
  );

const updateRow = (workspaceId: string) => (tx: Database) =>
  rawRows(
    tx,
    sql`update subscription_settings set cross_provider_failover = false
      where workspace_id = ${workspaceId}::uuid returning id`,
  );

describe.skipIf(!realDb)("a Personal workspace's owner changes its model account settings", () => {
  test("the owner, acting as themselves, overrides unlocked settings in their own Personal workspace", async () => {
    const owner = await organization();
    const colleague = await join(owner, "member");
    const read = await readWorkspaceSubscriptionSettings(client!.db, own(colleague));
    expect(read.canEdit).toBe(true);
    const changed = await updateWorkspaceSubscriptionSettings(client!.db, {
      ...own(colleague),
      patch: {
        crossProviderFailover: true,
        personalConnectionsAllowed: false,
        fallbackOrder: { "claude-opus": ["gpt-sol"] },
        rotation: { codex: { mode: "primary_first" } },
      },
    });
    expect(changed.settings.canEdit).toBe(true);
    expect(changed.settings.sources).toMatchObject({
      crossProviderFailover: "workspace",
      personalConnectionsAllowed: "workspace",
      fallbackOrder: "workspace",
      rotation: "workspace",
    });
    expect(changed.settings.values.crossProviderFailover).toBe(true);
    expect(changed.settings.values.personalConnectionsAllowed).toBe(false);
    // The provider switch and rotation on the Codex routes, as a workspace admin's.
    await setSubscriptionCoreWorkspaceCodexSource(client!.db, {
      ...own(colleague),
      mode: "disabled",
    });
    const rotation = await setSubscriptionCoreCodexRotation(client!.db, {
      ...own(colleague),
      rotationEnabled: true,
    });
    expect(rotation.rotation).not.toBeNull();
    expect(await settingsRow(colleague.personalId)).toMatchObject({
      cross_provider_failover: true,
      personal_connections_allowed: false,
      fallback_order: { "claude-opus": ["gpt-sol"] },
      rotation: { codex: { mode: "spread" } },
      providers: { codex: { enabled: false } },
    });
    // Resetting goes back to the organization's value.
    const reset = await updateWorkspaceSubscriptionSettings(client!.db, {
      ...own(colleague),
      patch: { crossProviderFailover: null },
    });
    expect(reset.settings.sources.crossProviderFailover).toBe("organization");
    await setSubscriptionCoreWorkspaceCodexSource(client!.db, {
      ...own(colleague),
      mode: "automatic",
    });
    expect((await settingsRow(colleague.personalId))?.providers?.codex).toBeUndefined();
  });

  test("without the verified owner the Personal workspace still follows the organization", async () => {
    const owner = await organization();
    const colleague = await join(owner, "member");
    // A delegated bearer naming the owner's subject is not the owner acting as themselves.
    const unverified = own(colleague, false);
    expect((await readWorkspaceSubscriptionSettings(client!.db, unverified)).canEdit).toBe(false);
    expect(
      await rejected(
        updateWorkspaceSubscriptionSettings(client!.db, {
          ...unverified,
          patch: { crossProviderFailover: true },
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsPersonalWorkspaceError);
    const source = (await rejected(
      setSubscriptionCoreWorkspaceCodexSource(client!.db, { ...unverified, mode: "disabled" }),
    )) as { reason?: string };
    expect(source.reason).toBe("personal_workspace");
    const rotation = await setSubscriptionCoreCodexRotation(client!.db, {
      ...unverified,
      rotationEnabled: false,
    });
    expect(rotation.rotation).toBeNull();
    // The database refuses the owner's row without the declaration.
    expect(
      await asApp(own(colleague), null, insertRow(colleague.accountId, colleague.personalId)),
    ).toBe("42501");
    expect(await settingsRow(colleague.personalId)).toBeNull();
  });

  test("a locked setting still wins in a Personal workspace", async () => {
    const owner = await organization();
    const colleague = await join(owner, "member");
    await updateWorkspaceSubscriptionSettings(client!.db, {
      ...own(colleague),
      patch: { crossProviderFailover: true, personalConnectionsAllowed: false },
    });
    // Locking replaces the Personal workspace's change too.
    await updateOrganizationSubscriptionSettings(client!.db, {
      organizationId: owner.accountId,
      actorSubjectId: owner.subjectId,
      patch: { crossProviderFailover: false, locked: ["crossProviderFailover"] },
    });
    expect((await settingsRow(colleague.personalId))?.cross_provider_failover).toBeNull();
    const read = await readWorkspaceSubscriptionSettings(client!.db, own(colleague));
    expect(read.sources.crossProviderFailover).toBe("locked");
    expect(read.values.crossProviderFailover).toBe(false);
    expect(
      await rejected(
        updateWorkspaceSubscriptionSettings(client!.db, {
          ...own(colleague),
          patch: { crossProviderFailover: true },
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsLockedError);
    // The database guard refuses it too, declared owner or not.
    expect(
      await asApp(own(colleague), colleague.subjectId, (tx) =>
        rawRows(
          tx,
          sql`update subscription_settings set cross_provider_failover = true
            where workspace_id = ${colleague.personalId}::uuid returning id`,
        ),
      ),
    ).toBe("42501");
    // An unlocked setting stays the owner's.
    expect(read.sources.personalConnectionsAllowed).toBe("workspace");
    const unlocked = await updateWorkspaceSubscriptionSettings(client!.db, {
      ...own(colleague),
      patch: { personalConnectionsAllowed: true },
    });
    expect(unlocked.settings.values.personalConnectionsAllowed).toBe(true);
    // A locked provider switch wins over the Codex source route.
    await updateOrganizationSubscriptionSettings(client!.db, {
      organizationId: owner.accountId,
      actorSubjectId: owner.subjectId,
      patch: { locked: ["crossProviderFailover", "providers"] },
    });
    expect(
      await rejected(
        setSubscriptionCoreWorkspaceCodexSource(client!.db, {
          ...own(colleague),
          mode: "disabled",
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsLockedError);
  });

  test("a colleague, the organization's owner and an admin are refused in someone else's Personal workspace", async () => {
    const owner = await organization();
    const colleague = await join(owner, "member");
    const admin = await join(owner, "admin");
    // The colleague gives their Personal workspace a row to tamper with.
    await updateWorkspaceSubscriptionSettings(client!.db, {
      ...own(colleague),
      patch: { crossProviderFailover: true },
    });
    for (const intruder of [owner, admin]) {
      const there = inWorkspace(owner.accountId, colleague.personalId, intruder.subjectId, true);
      expect((await readWorkspaceSubscriptionSettings(client!.db, there)).canEdit).toBe(false);
      expect(
        await rejected(
          updateWorkspaceSubscriptionSettings(client!.db, {
            ...there,
            patch: { crossProviderFailover: false },
          }),
        ),
      ).toBeInstanceOf(SubscriptionSettingsPersonalWorkspaceError);
      // Declaring themselves, the owner, or nobody admits nothing.
      for (const declared of [intruder.subjectId, colleague.subjectId, null])
        expect(await asApp(there, declared, updateRow(colleague.personalId))).toBe(0);
    }
    // A colleague in the organization owner's Personal workspace.
    const intruding = inWorkspace(owner.accountId, owner.personalId, colleague.subjectId, true);
    expect((await readWorkspaceSubscriptionSettings(client!.db, intruding)).canEdit).toBe(false);
    for (const declared of [colleague.subjectId, owner.subjectId])
      expect(await asApp(intruding, declared, insertRow(owner.accountId, owner.personalId))).toBe(
        "42501",
      );
    // The owner declared as someone else admits nothing either.
    expect(await asApp(own(colleague), owner.subjectId, updateRow(colleague.personalId))).toBe(0);
    expect((await settingsRow(colleague.personalId))?.cross_provider_failover).toBe(true);
    expect(await settingsRow(owner.personalId)).toBeNull();
  });

  test("nothing crosses organizations: a person in two organizations changes each Personal workspace on its own", async () => {
    const first = await organization();
    const second = await organization();
    const inSecond = await join(second, "member", first);
    expect(inSecond.personalId).not.toBe(first.personalId);
    await updateWorkspaceSubscriptionSettings(client!.db, {
      ...own(first),
      patch: { crossProviderFailover: true },
    });
    const there = await readWorkspaceSubscriptionSettings(client!.db, own(inSecond));
    expect(there.canEdit).toBe(true);
    expect(there.sources.crossProviderFailover).toBe("organization");
    expect(await settingsRow(inSecond.personalId)).toBeNull();
    await updateWorkspaceSubscriptionSettings(client!.db, {
      ...own(inSecond),
      patch: { personalConnectionsAllowed: false },
    });
    expect(await settingsRow(first.personalId)).toMatchObject({
      cross_provider_failover: true,
      personal_connections_allowed: null,
    });
    expect(await settingsRow(inSecond.personalId)).toMatchObject({
      cross_provider_failover: null,
      personal_connections_allowed: false,
    });
    // The first organization's context never reaches the second's Personal workspace.
    const crossed = inWorkspace(first.accountId, inSecond.personalId, first.subjectId, true);
    expect(
      await readWorkspaceSubscriptionSettings(client!.db, crossed).then(
        (state) => state.canEdit,
        () => false,
      ),
    ).toBe(false);
    expect(
      await asApp(crossed, first.subjectId, insertRow(first.accountId, inSecond.personalId)),
    ).toBe("42501");
    expect(await asApp(crossed, first.subjectId, updateRow(inSecond.personalId))).toBe(0);
    expect(await settingsRow(inSecond.personalId)).toMatchObject({
      cross_provider_failover: null,
      personal_connections_allowed: false,
    });
  });

  test("shared workspaces are unchanged", async () => {
    const owner = await organization();
    const workspaceAdmin = await join(owner, "member");
    const member = await join(owner, "member");
    const team = await sharedWorkspace(owner.accountId, [workspaceAdmin], [member]);
    // Its administrator and the organization's owner change it; a member can't,
    // even when the request verified them (it is not their Personal workspace).
    for (const who of [workspaceAdmin, owner]) {
      const here = inWorkspace(owner.accountId, team, who.subjectId);
      expect((await readWorkspaceSubscriptionSettings(client!.db, here)).canEdit).toBe(true);
      await updateWorkspaceSubscriptionSettings(client!.db, {
        ...here,
        patch: { crossProviderFailover: who === owner },
      });
    }
    const plain = inWorkspace(owner.accountId, team, member.subjectId, true);
    expect((await readWorkspaceSubscriptionSettings(client!.db, plain)).canEdit).toBe(false);
    expect(
      await rejected(
        updateWorkspaceSubscriptionSettings(client!.db, {
          ...plain,
          patch: { crossProviderFailover: false },
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsForbiddenError);
    expect(await asApp(plain, member.subjectId, updateRow(team))).toBe(0);
    expect((await settingsRow(team))?.cross_provider_failover).toBe(true);
  });
});
