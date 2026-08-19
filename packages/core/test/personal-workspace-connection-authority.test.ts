import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { OrganizationMembershipRole } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  createSocialConnection,
  ensureManagedAccessForUser,
  getWorkspaceGrant,
  listSelfOrganizationMemberships,
  namedSubjectHasLiveWorkspaceAuthority,
  setRlsContext,
  setSubjectRlsContext,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  freezePersonalConnectionDelegations,
  personalConnectionDelegationSourceForGrant,
} from "../src/domain/personal-connection-delegations";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("personal-workspace-connection-authority");
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function provisionManagedHuman(): Promise<{
  subjectId: string;
  accountId: string;
  personalWorkspaceId: string;
  legacyWorkspaceId: string;
}> {
  if (!client) throw new Error("test database unavailable");
  const userId = `personal-ws-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const context = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Personal workspace owner",
  });
  const legacyWorkspaceId = context.defaultWorkspaceId!;
  const personalGrant = context.workspaceGrants.find(
    (grant) => grant.workspaceId !== legacyWorkspaceId,
  );
  if (!personalGrant) throw new Error("managed human was provisioned without a personal workspace");
  return {
    subjectId,
    accountId: personalGrant.accountId,
    personalWorkspaceId: personalGrant.workspaceId,
    legacyWorkspaceId,
  };
}

/**
 * Put a second real managed human inside the SAME organization through the 0263
 * invitation lifecycle, so denial can be tested against an active co-member
 * rather than a stranger from another tenant.
 */
async function joinOrganizationAs(
  owner: { subjectId: string; accountId: string },
  role: OrganizationMembershipRole,
): Promise<{
  subjectId: string;
  accountId: string;
  personalWorkspaceId: string;
  role: OrganizationMembershipRole;
  status: string;
}> {
  if (!client) throw new Error("test database unavailable");
  const joiner = await provisionManagedHuman();
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: owner.accountId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: joiner.subjectId,
    targetEmail: `${joiner.subjectId.slice("user:".length)}@example.test`,
    role,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const { membership } = await acceptOrganizationInvitation(client.db, {
    organizationId: owner.accountId,
    actorSubjectId: joiner.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  // Read the membership back through the same self seam the resolver uses.
  const memberships = await listSelfOrganizationMemberships(client.db, joiner.subjectId);
  const inOwnerOrganization = memberships.find(
    (candidate) => candidate.organizationId === owner.accountId,
  );
  if (!inOwnerOrganization?.personalWorkspaceId) {
    throw new Error("same-organization co-member has no personal workspace pointer");
  }
  return {
    subjectId: joiner.subjectId,
    accountId: membership.organizationId,
    personalWorkspaceId: inOwnerOrganization.personalWorkspaceId,
    role: membership.role,
    status: membership.status,
  };
}

describe("managed-human personal workspace connection authority", () => {
  test("the owning human's personal workspace has no workspace_memberships row", async () => {
    if (!client) return;
    const human = await provisionManagedHuman();

    // The pointer-derived grant is real runtime access ...
    expect(human.personalWorkspaceId).not.toBe(human.legacyWorkspaceId);
    // ... but the bare `workspace_memberships` join cannot see it.
    expect(
      await getWorkspaceGrant(client.db, human.subjectId, human.personalWorkspaceId),
    ).toBeNull();
    // The legacy Better Auth workspace does have one, so the harness is sane.
    expect(
      await getWorkspaceGrant(client.db, human.subjectId, human.legacyWorkspaceId),
    ).not.toBeNull();
  }, 180_000);

  // The probe sets `opengeni.subject_id` from its own argument, and SET LOCAL
  // survives savepoint release while `withRlsContext` restores only
  // account/workspace. Without an explicit restore, probing a subject silently
  // redefines who the rest of a caller's transaction runs as - at three call
  // sites that subject is a frozen `ownerSubjectId` read out of stored data.
  test("probing a named subject does not leak that subject into the caller's transaction", async () => {
    if (!client) return;
    const caller = await provisionManagedHuman();
    const other = await provisionManagedHuman();

    await client.db.transaction(async (tx) => {
      const handle = tx as unknown as Database;
      await setRlsContext(handle, { accountId: caller.accountId, workspaceId: null });
      await setSubjectRlsContext(handle, caller.subjectId);

      await namedSubjectHasLiveWorkspaceAuthority(handle, {
        accountId: other.accountId,
        workspaceId: other.personalWorkspaceId,
        subjectId: other.subjectId,
      });

      const [after] = (await tx.execute(
        sql`select current_setting('opengeni.subject_id', true) as subject_id,
                   current_setting('opengeni.account_id', true) as account_id`,
      )) as unknown as Array<{ subject_id: string | null; account_id: string | null }>;
      expect(after?.subject_id).toBe(caller.subjectId);
      expect(after?.account_id).toBe(caller.accountId);
    });
  }, 180_000);

  test("the probe still answers correctly when handed a transaction handle", async () => {
    if (!client) return;
    const caller = await provisionManagedHuman();
    await client.db.transaction(async (tx) => {
      const handle = tx as unknown as Database;
      await setRlsContext(handle, { accountId: caller.accountId, workspaceId: null });
      await setSubjectRlsContext(handle, caller.subjectId);
      expect(
        await namedSubjectHasLiveWorkspaceAuthority(handle, {
          accountId: caller.accountId,
          workspaceId: caller.personalWorkspaceId,
          subjectId: caller.subjectId,
        }),
      ).toBe(true);
    });
  }, 180_000);

  test("the owner-only live-authority seam resolves the personal workspace", async () => {
    if (!client) return;
    const human = await provisionManagedHuman();

    expect(
      await namedSubjectHasLiveWorkspaceAuthority(client.db, {
        accountId: human.accountId,
        workspaceId: human.personalWorkspaceId,
        subjectId: human.subjectId,
      }),
    ).toBe(true);
  }, 180_000);

  test("a personal social connection freezes a delegation inside the owner's personal workspace", async () => {
    if (!client) return;
    const human = await provisionManagedHuman();

    const connection = await createSocialConnection(client.db, {
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      subjectId: human.subjectId,
      provider: "x",
      accountHandle: "owner",
      status: "connected",
    });

    const delegations = await freezePersonalConnectionDelegations({
      db: client.db,
      workspaceId: human.personalWorkspaceId,
      settings: { mcpServers: [] },
      tools: [{ id: "opengeni" }],
      source: {
        kind: "subject",
        subjectId: human.subjectId,
        accountId: human.accountId,
      },
    });

    expect(delegations).toHaveLength(1);
    expect(delegations[0]?.connectionId).toBe(connection.id);
    expect(delegations[0]?.ownerSubjectId).toBe(human.subjectId);
    expect(delegations[0]?.serverId).toBe("social:x");
  }, 180_000);

  test("the same personal social connection still freezes in the legacy shared workspace", async () => {
    if (!client) return;
    const human = await provisionManagedHuman();

    await createSocialConnection(client.db, {
      accountId: human.accountId,
      workspaceId: human.legacyWorkspaceId,
      subjectId: human.subjectId,
      provider: "x",
      accountHandle: "owner",
      status: "connected",
    });

    const delegations = await freezePersonalConnectionDelegations({
      db: client.db,
      workspaceId: human.legacyWorkspaceId,
      settings: { mcpServers: [] },
      tools: [{ id: "opengeni" }],
      source: {
        kind: "subject",
        subjectId: human.subjectId,
        accountId: human.accountId,
      },
    });

    expect(delegations).toHaveLength(1);
  }, 180_000);

  test("another human's subject never freezes a delegation in someone else's personal workspace", async () => {
    if (!client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();

    await createSocialConnection(client.db, {
      accountId: owner.accountId,
      workspaceId: owner.personalWorkspaceId,
      subjectId: intruder.subjectId,
      provider: "x",
      accountHandle: "intruder",
      status: "connected",
    });

    expect(
      await freezePersonalConnectionDelegations({
        db: client.db,
        workspaceId: owner.personalWorkspaceId,
        settings: { mcpServers: [] },
        tools: [{ id: "opengeni" }],
        source: {
          kind: "subject",
          subjectId: intruder.subjectId,
          accountId: owner.accountId,
        },
      }),
    ).toEqual([]);
  }, 180_000);

  test("a different-organization managed human gets no authority over someone else's personal workspace", async () => {
    if (!client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();
    // Distinct organizations: this is the weak, cross-tenant case.
    expect(intruder.accountId).not.toBe(owner.accountId);

    expect(
      await namedSubjectHasLiveWorkspaceAuthority(client.db, {
        accountId: owner.accountId,
        workspaceId: owner.personalWorkspaceId,
        subjectId: intruder.subjectId,
      }),
    ).toBe(false);
  }, 180_000);

  // The load-bearing case CLAUDE.md is actually about: a co-member of the SAME
  // organization - including an organization admin and a second owner - must
  // never reach another member's personal workspace. A cross-organization
  // intruder proves nothing here, because it has no membership in the target
  // organization at all.
  for (const role of ["member", "admin", "owner"] satisfies OrganizationMembershipRole[]) {
    test(`a same-organization ${role} gets no authority over another member's personal workspace`, async () => {
      if (!client) return;
      const owner = await provisionManagedHuman();
      const coMember = await joinOrganizationAs(owner, role);

      // Same organization, active membership, real role - the only reason to
      // deny is that the pointer names the co-member's OWN personal workspace.
      expect(coMember.accountId).toBe(owner.accountId);
      expect(coMember.status).toBe("active");
      expect(coMember.role).toBe(role);
      expect(coMember.personalWorkspaceId).not.toBe(owner.personalWorkspaceId);

      expect(
        await namedSubjectHasLiveWorkspaceAuthority(client.db, {
          accountId: owner.accountId,
          workspaceId: owner.personalWorkspaceId,
          subjectId: coMember.subjectId,
        }),
      ).toBe(false);

      // ... and the co-member does hold authority over their own.
      expect(
        await namedSubjectHasLiveWorkspaceAuthority(client.db, {
          accountId: owner.accountId,
          workspaceId: coMember.personalWorkspaceId,
          subjectId: coMember.subjectId,
        }),
      ).toBe(true);
    }, 180_000);

    test(`a same-organization ${role} freezes no delegation in another member's personal workspace`, async () => {
      if (!client) return;
      const owner = await provisionManagedHuman();
      const coMember = await joinOrganizationAs(owner, role);

      await createSocialConnection(client.db, {
        accountId: owner.accountId,
        workspaceId: owner.personalWorkspaceId,
        subjectId: coMember.subjectId,
        provider: "x",
        accountHandle: "co-member",
        status: "connected",
      });

      expect(
        await freezePersonalConnectionDelegations({
          db: client.db,
          workspaceId: owner.personalWorkspaceId,
          settings: { mcpServers: [] },
          tools: [{ id: "opengeni" }],
          source: {
            kind: "subject",
            subjectId: coMember.subjectId,
            accountId: owner.accountId,
          },
        }),
      ).toEqual([]);
    }, 180_000);
  }

  // CLAUDE.md: "Bearer/delegated principals, API keys, and account or
  // organization administrators receive no personal-workspace access through
  // that exception." A delegated grant is built entirely from signed token
  // payload with no row validating its subject or workspace, so it must never
  // reach the owner-only pointer.
  test("a delegated bearer grant never becomes a personal-connection subject source", async () => {
    const delegatedHumanSession = personalConnectionDelegationSourceForGrant({
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: "user:victim",
      principalKind: "human_session",
      permissions: [],
      metadata: { delegated: true },
    });
    expect(delegatedHumanSession).toEqual({ kind: "none" });

    // The canonical managed-cookie grant is unaffected.
    const accountId = crypto.randomUUID();
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId,
        workspaceId: crypto.randomUUID(),
        subjectId: "user:owner",
        principalKind: "human_session",
        permissions: [],
      }),
    ).toEqual({ kind: "subject", subjectId: "user:owner", accountId });
  });

  test("a delegated bearer for a victim's personal workspace freezes nothing", async () => {
    if (!client) return;
    const victim = await provisionManagedHuman();

    await createSocialConnection(client.db, {
      accountId: victim.accountId,
      workspaceId: victim.personalWorkspaceId,
      subjectId: victim.subjectId,
      provider: "x",
      accountHandle: "victim",
      status: "connected",
    });

    // Exactly what `delegatedAccessContext` builds from a signed token.
    const forgedDelegatedGrant = {
      workspaceId: victim.personalWorkspaceId,
      accountId: victim.accountId,
      subjectId: victim.subjectId,
      permissions: [],
      principalKind: "human_session" as const,
      metadata: { delegated: true },
    };

    expect(
      await freezePersonalConnectionDelegations({
        db: client.db,
        workspaceId: victim.personalWorkspaceId,
        settings: { mcpServers: [] },
        tools: [{ id: "opengeni" }],
        source: personalConnectionDelegationSourceForGrant(forgedDelegatedGrant),
      }),
    ).toEqual([]);

    // The victim's own canonical managed-cookie session still works, so the
    // filter is denying the bearer specifically and not the workspace.
    expect(
      await freezePersonalConnectionDelegations({
        db: client.db,
        workspaceId: victim.personalWorkspaceId,
        settings: { mcpServers: [] },
        tools: [{ id: "opengeni" }],
        source: personalConnectionDelegationSourceForGrant({
          ...forgedDelegatedGrant,
          metadata: {},
        }),
      }),
    ).toHaveLength(1);
  }, 180_000);
});
