import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  nestedPostgresSqlState,
  removeWorkspaceMember,
  updateOrganizationMember,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import {
  readSubscriptionCoreConnectionAccess,
  updateSubscriptionCoreConnectionAccess,
  type SubscriptionCoreAccessTarget,
} from "../src/subscription-core/access";
import { listSubscriptionCoreServingConnections } from "../src/subscription-core/catalog";
import {
  connectSubscriptionCoreConnection,
  disconnectSubscriptionCoreConnection,
} from "../src/subscription-core/connections";
import {
  subscriptionCoreConnectionKind,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "../src/subscription-core/provider";
import { SUBSCRIPTION_CORE_CLAUDE } from "../src/subscription-core-claude-adapter";
import { SUBSCRIPTION_CORE_CODEX } from "../src/subscription-core-codex-adapter";
import { SUBSCRIPTION_CORE_XAI } from "../src/subscription-core-xai-adapter";

// A shared subscription a person connects in a shared workspace also reaches
// that person's own Personal workspace, and nobody else's (migration 1064).
// The workspace keeps managing it, the person or its managers can take that
// Personal workspace off it, and the reach ends with the person's access to
// the workspace. Every provider on the shared core behaves the same.

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 61);

const db = () => client!.db;
const admin = () => shared!.admin;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-connector-personal-reach-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Person = {
  subjectId: string;
  membershipId: string;
  personalWorkspaceId: string;
  authorizationRevision: number;
};
type Org = {
  accountId: string;
  owner: Omit<Person, "authorizationRevision">;
  sharedWorkspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `personal-reach-owner-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(db(), {
    userId,
    email: `${userId}@example.test`,
    name: "Personal reach owner",
  });
  const membership = provisioned.organizationMemberships[0]!;
  const sharedWorkspaceId = provisioned.accessContext.workspaceGrants.find(
    (grant) =>
      grant.accountId === membership.organizationId &&
      grant.workspaceId !== membership.personalWorkspaceId,
  )?.workspaceId;
  if (!sharedWorkspaceId) throw new Error("fixture has no shared workspace");
  return {
    accountId: membership.organizationId,
    owner: {
      subjectId: `user:${userId}`,
      membershipId: membership.id,
      personalWorkspaceId: membership.personalWorkspaceId!,
    },
    sharedWorkspaceId,
  };
}

/** An invited organization member (role `member`), in the shared workspace with `workspaceRole`. */
async function member(
  org: Org,
  name: string,
  workspaceRole: "admin" | "member" | null,
): Promise<Person> {
  const userId = `personal-reach-${name.toLowerCase()}-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  await ensureManagedAccessForUserWithOrganizationMemberships(db(), {
    userId,
    email: `${userId}@example.test`,
    name,
  });
  const invitation = await createOrganizationInvitation(db(), {
    organizationId: org.accountId,
    actorSubjectId: org.owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: subjectId,
    targetEmail: `${userId}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const { membership } = await acceptOrganizationInvitation(db(), {
    organizationId: org.accountId,
    actorSubjectId: subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  if (workspaceRole) await join(org, subjectId, workspaceRole, name);
  return {
    subjectId,
    membershipId: membership.id,
    personalWorkspaceId: membership.personalWorkspaceId!,
    authorizationRevision: membership.authorizationRevision,
  };
}

async function join(org: Org, subjectId: string, role: "admin" | "member", label: string) {
  await admin()`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, subject_label)
    values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${subjectId}, ${role}, ${label})
    on conflict (subject_id, workspace_id) do update set role = excluded.role,
      subject_label = excluded.subject_label`;
}

function connect(
  provider: SubscriptionCoreProvider,
  org: Org,
  input: {
    workspaceId: string | null;
    subjectId: string;
    connectedBySubjectId?: string | null;
  },
  label: string = `account-${crypto.randomUUID()}`,
) {
  const connectedBySubjectId =
    input.connectedBySubjectId === undefined ? input.subjectId : input.connectedBySubjectId;
  return withSessionRlsActorContext({ subjectId: input.subjectId }, () =>
    connectSubscriptionCoreConnection(db(), provider, {
      accountId: org.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      credentialEncrypted: encryptEnvironmentValue(key, `credential-${label}`),
      providerAccountId: `upstream-${label}`,
      providerSubjectId: `person-${label}`,
      planType: null,
      expiresAt: null,
      lastRefreshAt: new Date(),
      accountEmail: null,
      label,
      providerState: {},
      connectedBySubjectId,
    }),
  );
}

async function connected(
  provider: SubscriptionCoreProvider,
  org: Org,
  input: Parameters<typeof connect>[2],
  label?: string,
) {
  const result = await connect(provider, org, input, label);
  if (result.kind !== "connected") throw new Error(`not connected: ${JSON.stringify(result)}`);
  return result;
}

async function assignments(
  connectionId: string,
): Promise<{ workspace_id: string; subject: string | null; via: string | null }[]> {
  const rows = await admin()<
    { workspace_id: string; subject: string | null; via: string | null }[]
  >`select workspace_id::text as workspace_id, personal_reach_subject_id as subject,
      personal_reach_via_workspace_id::text as via
    from subscription_connection_workspaces where connection_id = ${connectionId}::uuid
    order by personal_reach_subject_id nulls first, workspace_id`;
  return [...rows];
}

async function serves(
  provider: SubscriptionCoreProvider,
  org: Org,
  workspaceId: string,
  subjectId: string,
): Promise<string[]> {
  return (
    await listSubscriptionCoreServingConnections(db(), provider, {
      accountId: org.accountId,
      workspaceId,
      subjectId,
    })
  ).map((entry) => entry.connectionId);
}

/** The database's own serving check (RLS and turn placement use it). */
async function visible(org: Org, workspaceId: string, connectionId: string): Promise<boolean> {
  return await withRlsContext(db(), { accountId: org.accountId, workspaceId }, async (tx) => {
    const [row] = await rawRows<{ visible: boolean }>(
      tx,
      sql`select opengeni_private.subscription_connection_visible(${org.accountId}::uuid,
        ${workspaceId}::uuid, ${connectionId}::uuid, 'shared', 'workspaces', null, null, null)
        as visible`,
    );
    return row!.visible;
  });
}

function workspaceTarget(org: Org, subjectId: string, connectionId: string) {
  return {
    accountId: org.accountId,
    workspaceId: org.sharedWorkspaceId,
    subjectId,
    connectionId,
  } satisfies SubscriptionCoreAccessTarget;
}

function organizationTarget(org: Org, connectionId: string) {
  return {
    accountId: org.accountId,
    workspaceId: null,
    subjectId: org.owner.subjectId,
    connectionId,
  } satisfies SubscriptionCoreAccessTarget;
}

async function managedBy(connectionId: string) {
  const [row] = await admin()<
    { managed_by: string | null; scope_kind: string; allow_personal: boolean }[]
  >`select managed_by_workspace_id::text as managed_by, scope_kind,
      allow_personal_workspaces as allow_personal
    from subscription_connections where id = ${connectionId}::uuid`;
  return row!;
}

for (const provider of [SUBSCRIPTION_CORE_CODEX, SUBSCRIPTION_CORE_CLAUDE, SUBSCRIPTION_CORE_XAI]) {
  describe.skipIf(!realDb)(
    `${provider.adapter.displayName}: a workspace account also reaches its connecting person's Personal workspace`,
    () => {
      test("a member who administers a shared workspace connects there: it serves their own Personal workspace, nobody else's", async () => {
        const org = await organization();
        const alice = await member(org, "Alice", "admin");
        const bob = await member(org, "Bob", "member");
        const result = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: alice.subjectId,
        });
        expect(result).toMatchObject({ isNew: true, ownership: "shared" });
        expect(result.wake.workspaceIds).toEqual([
          org.sharedWorkspaceId,
          alice.personalWorkspaceId,
        ]);
        // Still the workspace's own account; the all-Personal switch stays off.
        expect(await managedBy(result.id)).toEqual({
          managed_by: org.sharedWorkspaceId,
          scope_kind: "workspaces",
          allow_personal: false,
        });
        expect(await assignments(result.id)).toEqual([
          { workspace_id: org.sharedWorkspaceId, subject: null, via: null },
          {
            workspace_id: alice.personalWorkspaceId,
            subject: alice.subjectId,
            via: org.sharedWorkspaceId,
          },
        ]);
        expect(await serves(provider, org, org.sharedWorkspaceId, alice.subjectId)).toContain(
          result.id,
        );
        expect(await serves(provider, org, alice.personalWorkspaceId, alice.subjectId)).toContain(
          result.id,
        );
        expect(await serves(provider, org, bob.personalWorkspaceId, bob.subjectId)).not.toContain(
          result.id,
        );
        expect(
          await serves(provider, org, org.owner.personalWorkspaceId, org.owner.subjectId),
        ).not.toContain(result.id);
        expect(await visible(org, alice.personalWorkspaceId, result.id)).toBe(true);
        expect(await visible(org, bob.personalWorkspaceId, result.id)).toBe(false);

        // The access list names it for its person and for the organization;
        // another member of the workspace learns nothing about it.
        const own = await readSubscriptionCoreConnectionAccess(
          db(),
          provider,
          workspaceTarget(org, alice.subjectId, result.id),
        );
        expect(own).toMatchObject({
          policy: { connectorPersonalWorkspace: true },
          connectorPersonalWorkspace: { yours: true, name: null },
        });
        const organizationView = await readSubscriptionCoreConnectionAccess(
          db(),
          provider,
          organizationTarget(org, result.id),
        );
        expect(organizationView).toMatchObject({
          policy: {
            allowedWorkspaces: [org.sharedWorkspaceId],
            allowPersonalWorkspaces: false,
            connectorPersonalWorkspace: true,
          },
          localWorkspaceIds: [org.sharedWorkspaceId],
          managedByWorkspaceId: org.sharedWorkspaceId,
          connectorPersonalWorkspace: { yours: false, name: "Alice" },
        });
        expect(JSON.stringify(organizationView)).not.toContain(alice.personalWorkspaceId);
        const bystander = await readSubscriptionCoreConnectionAccess(
          db(),
          provider,
          workspaceTarget(org, bob.subjectId, result.id),
        );
        expect(bystander?.connectorPersonalWorkspace).toBeUndefined();
        expect(bystander?.policy.connectorPersonalWorkspace).toBeUndefined();

        // Saving the organization's form unchanged keeps it the workspace's own.
        const kept = await updateSubscriptionCoreConnectionAccess(
          db(),
          provider,
          organizationTarget(org, result.id),
          organizationView!.policy,
        );
        expect(kept?.connectorPersonalWorkspace).toEqual({
          yours: false,
          name: "Alice",
        });
        expect((await managedBy(result.id)).managed_by).toBe(org.sharedWorkspaceId);

        // Its person takes it off the access list in the workspace.
        const removed = await updateSubscriptionCoreConnectionAccess(
          db(),
          provider,
          workspaceTarget(org, alice.subjectId, result.id),
          {
            ...own!.policy,
            version: kept!.policy.version,
            connectorPersonalWorkspace: false,
          },
        );
        expect(removed?.connectorPersonalWorkspace).toBeUndefined();
        expect(removed?.policy.connectorPersonalWorkspace).toBeUndefined();
        expect(await assignments(result.id)).toEqual([
          { workspace_id: org.sharedWorkspaceId, subject: null, via: null },
        ]);
        expect(
          await serves(provider, org, alice.personalWorkspaceId, alice.subjectId),
        ).not.toContain(result.id);
        expect(await serves(provider, org, org.sharedWorkspaceId, alice.subjectId)).toContain(
          result.id,
        );
        // A reconnect never adds it back.
        const label = `account-${crypto.randomUUID()}`;
        const again = await connected(
          provider,
          org,
          {
            workspaceId: org.sharedWorkspaceId,
            subjectId: alice.subjectId,
          },
          label,
        );
        const reconnected = await connected(
          provider,
          org,
          { workspaceId: org.sharedWorkspaceId, subjectId: alice.subjectId },
          label,
        );
        expect(reconnected).toMatchObject({ id: again.id, isNew: false });
        expect(reconnected.wake.workspaceIds).toEqual([org.sharedWorkspaceId]);
      });

      test("another workspace administrator removes it, and still disconnects the workspace's account", async () => {
        const org = await organization();
        const alice = await member(org, "Alice", "admin");
        const carol = await member(org, "Carol", "admin");
        const result = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: alice.subjectId,
        });
        const seen = await readSubscriptionCoreConnectionAccess(
          db(),
          provider,
          workspaceTarget(org, carol.subjectId, result.id),
        );
        expect(seen?.connectorPersonalWorkspace).toEqual({
          yours: false,
          name: "Alice",
        });
        // A workspace administrator who is not an organization administrator
        // disconnects it while it also reaches a Personal workspace.
        const disconnected = await withSessionRlsActorContext({ subjectId: carol.subjectId }, () =>
          disconnectSubscriptionCoreConnection(db(), provider, {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
            subjectId: carol.subjectId,
            connectionId: result.id,
          }),
        );
        expect(disconnected.outcome).toBe("removed");
        expect(
          await serves(provider, org, alice.personalWorkspaceId, alice.subjectId),
        ).not.toContain(result.id);

        const second = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: alice.subjectId,
        });
        const before = await readSubscriptionCoreConnectionAccess(
          db(),
          provider,
          workspaceTarget(org, carol.subjectId, second.id),
        );
        await updateSubscriptionCoreConnectionAccess(
          db(),
          provider,
          workspaceTarget(org, carol.subjectId, second.id),
          { ...before!.policy, connectorPersonalWorkspace: false },
        );
        expect(await assignments(second.id)).toEqual([
          { workspace_id: org.sharedWorkspaceId, subject: null, via: null },
        ]);
      });

      test("the organization can widen it: chosen workspaces keep the Personal workspace, every Personal workspace absorbs it", async () => {
        const org = await organization();
        const alice = await member(org, "Alice", "admin");
        const other = await admin()<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${org.accountId}::uuid, 'Second shared')
        returning id::text as id`;
        const result = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: alice.subjectId,
        });
        const view = await readSubscriptionCoreConnectionAccess(
          db(),
          provider,
          organizationTarget(org, result.id),
        );
        const widened = await updateSubscriptionCoreConnectionAccess(
          db(),
          provider,
          organizationTarget(org, result.id),
          {
            ...view!.policy,
            allowedWorkspaces: [org.sharedWorkspaceId, other[0]!.id],
          },
        );
        // More reach makes it the organization's; the person's reach stays.
        expect(widened?.managedByWorkspaceId).toBeNull();
        expect(widened?.connectorPersonalWorkspace).toEqual({
          yours: false,
          name: "Alice",
        });
        expect(await serves(provider, org, alice.personalWorkspaceId, alice.subjectId)).toContain(
          result.id,
        );
        const everyPersonal = await updateSubscriptionCoreConnectionAccess(
          db(),
          provider,
          organizationTarget(org, result.id),
          { ...widened!.policy, allowPersonalWorkspaces: true },
        );
        expect(everyPersonal?.connectorPersonalWorkspace).toBeUndefined();
        expect(
          (await assignments(result.id)).find(
            (row) => row.workspace_id === alice.personalWorkspaceId,
          ),
        ).toEqual({
          workspace_id: alice.personalWorkspaceId,
          subject: null,
          via: null,
        });
      });

      test("losing the workspace, suspension and leaving the organization each end the reach", async () => {
        const org = await organization();
        const alice = await member(org, "Alice", "admin");
        const first = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: alice.subjectId,
        });
        expect(await assignments(first.id)).toHaveLength(2);
        await removeWorkspaceMember(db(), {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
          actorSubjectId: org.owner.subjectId,
          targetSubjectId: alice.subjectId,
        });
        expect(await assignments(first.id)).toEqual([
          { workspace_id: org.sharedWorkspaceId, subject: null, via: null },
        ]);
        expect(
          await serves(provider, org, alice.personalWorkspaceId, alice.subjectId),
        ).not.toContain(first.id);

        await join(org, alice.subjectId, "admin", "Alice");
        const second = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: alice.subjectId,
        });
        expect(await assignments(second.id)).toHaveLength(2);
        await updateOrganizationMember(db(), {
          organizationId: org.accountId,
          actorSubjectId: org.owner.subjectId,
          operationId: crypto.randomUUID(),
          membershipId: alice.membershipId,
          transition: {
            kind: "suspend",
            expectedAuthorizationRevision: alice.authorizationRevision,
            operationId: crypto.randomUUID(),
          },
        });
        expect(await assignments(second.id)).toEqual([
          { workspace_id: org.sharedWorkspaceId, subject: null, via: null },
        ]);

        const dave = await member(org, "Dave", "admin");
        const third = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: dave.subjectId,
        });
        expect(await assignments(third.id)).toHaveLength(2);
        await updateOrganizationMember(db(), {
          organizationId: org.accountId,
          actorSubjectId: org.owner.subjectId,
          operationId: crypto.randomUUID(),
          membershipId: dave.membershipId,
          transition: {
            kind: "offboard",
            expectedAuthorizationRevision: dave.authorizationRevision,
            operationId: crypto.randomUUID(),
          },
        });
        expect(await assignments(third.id)).toEqual([
          { workspace_id: org.sharedWorkspaceId, subject: null, via: null },
        ]);
      });

      test("serving requires the person to still belong to the workspace, even if a row outlives it", async () => {
        const org = await organization();
        const erin = await member(org, "Erin", "admin");
        const result = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: erin.subjectId,
        });
        // Remove the membership without its cleanup trigger.
        await admin().begin(async (tx) => {
          await tx`set local session_replication_role = replica`;
          await tx`delete from workspace_memberships
          where workspace_id = ${org.sharedWorkspaceId}::uuid and subject_id = ${erin.subjectId}`;
        });
        expect(await assignments(result.id)).toHaveLength(2);
        expect(await serves(provider, org, erin.personalWorkspaceId, erin.subjectId)).not.toContain(
          result.id,
        );
        expect(await visible(org, erin.personalWorkspaceId, result.id)).toBe(false);
        const view = await readSubscriptionCoreConnectionAccess(
          db(),
          provider,
          organizationTarget(org, result.id),
        );
        expect(view?.connectorPersonalWorkspace).toBeUndefined();
      });

      test("organization connects, API keys, other people's workspaces and existing accounts get no Personal workspace", async () => {
        const org = await organization();
        const alice = await member(org, "Alice", "admin");
        const bob = await member(org, "Bob", "member");
        // The organization's own connect is unchanged: the whole organization.
        const organizationAccount = await connected(provider, org, {
          workspaceId: null,
          subjectId: org.owner.subjectId,
        });
        expect(await managedBy(organizationAccount.id)).toEqual({
          managed_by: null,
          scope_kind: "organization",
          allow_personal: true,
        });
        expect(await assignments(organizationAccount.id)).toEqual([]);
        // No verified connecting person (an API key or service principal acting).
        const unattributed = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: alice.subjectId,
          connectedBySubjectId: null,
        });
        expect(await assignments(unattributed.id)).toEqual([
          { workspace_id: org.sharedWorkspaceId, subject: null, via: null },
        ]);
        // A workspace account stored before this change keeps its access.
        const [existing] = await admin()<{ id: string }[]>`
        insert into subscription_connections (
          account_id, provider, kind, credential_encrypted, ownership, scope_kind,
          allow_personal_workspaces, provider_account_id, provider_subject_id, label,
          managed_by_workspace_id, connected_by_subject_id
        ) values (
          ${org.accountId}::uuid, ${subscriptionCoreProviderId(provider)},
          ${subscriptionCoreConnectionKind(provider)}, ${encryptEnvironmentValue(key, "existing")},
          'shared', 'workspaces', false, ${`existing-${crypto.randomUUID()}`},
          ${`existing-${crypto.randomUUID()}`}, 'Existing', ${org.sharedWorkspaceId}::uuid,
          ${alice.subjectId}
        ) returning id::text as id`;
        await admin()`insert into subscription_connection_workspaces
        (account_id, connection_id, workspace_id)
        values (${org.accountId}::uuid, ${existing!.id}::uuid, ${org.sharedWorkspaceId}::uuid)`;
        expect(
          await serves(provider, org, alice.personalWorkspaceId, alice.subjectId),
        ).not.toContain(existing!.id);

        // The database admits only the connecting person's own Personal workspace.
        const result = await connected(provider, org, {
          workspaceId: org.sharedWorkspaceId,
          subjectId: alice.subjectId,
        });
        const insertReach = (connectionId: string, subjectId: string, workspaceId: string) =>
          withRlsContext(
            db(),
            { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
            async (tx) => {
              await setSubjectRlsContext(tx, subjectId);
              await tx.execute(sql`insert into subscription_connection_workspaces
              (account_id, connection_id, workspace_id, personal_reach_subject_id,
                personal_reach_via_workspace_id)
              values (${org.accountId}::uuid, ${connectionId}::uuid, ${workspaceId}::uuid,
                ${subjectId}, ${org.sharedWorkspaceId}::uuid)`);
            },
          ).then(
            () => "inserted",
            (error: unknown) => nestedPostgresSqlState(error),
          );
        // Not the connecting person of that account, and not their own workspace.
        expect(await insertReach(unattributed.id, alice.subjectId, alice.personalWorkspaceId)).toBe(
          "23514",
        );
        expect(await insertReach(result.id, alice.subjectId, bob.personalWorkspaceId)).toBe(
          "23514",
        );
        // Someone who doesn't belong to the workspace can't add one either.
        expect(await insertReach(unattributed.id, bob.subjectId, bob.personalWorkspaceId)).toMatch(
          /^(23514|42501)$/,
        );
        expect(await assignments(result.id)).toHaveLength(2);
      });
    },
  );
}
