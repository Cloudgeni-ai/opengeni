import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  createSocialConnection,
  ensureManagedAccessForUser,
  getWorkspaceGrant,
  subjectHasLiveWorkspaceAuthority,
  type DbClient,
} from "@opengeni/db";
import { freezePersonalConnectionDelegations } from "../src/domain/personal-connection-delegations";

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

  test("the owner-only live-authority seam resolves the personal workspace", async () => {
    if (!client) return;
    const human = await provisionManagedHuman();

    expect(
      await subjectHasLiveWorkspaceAuthority(client.db, {
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

  test("a different managed human gets no authority over someone else's personal workspace", async () => {
    if (!client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();

    expect(
      await subjectHasLiveWorkspaceAuthority(client.db, {
        accountId: owner.accountId,
        workspaceId: owner.personalWorkspaceId,
        subjectId: intruder.subjectId,
      }),
    ).toBe(false);
  }, 180_000);
});
