import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  forkSessionContent,
  transitionSessionVisibility,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

type ManagedHuman = {
  subjectId: string;
  accountId: string;
  legacyWorkspaceId: string;
  personalWorkspaceId: string;
  organizationMembershipId: string;
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("personal-workspace-session-tenancy");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[personal-workspace-session-tenancy] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function provisionManagedHuman(): Promise<ManagedHuman> {
  if (!client || !shared) throw new Error("test database unavailable");
  const userId = `pw-tenancy-${crypto.randomUUID()}`;
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
  if (!personalGrant) throw new Error("managed human provisioned without a personal workspace");
  const [membership] = await shared.admin<Array<{ id: string }>>`
    select id from organization_memberships
    where account_id = ${personalGrant.accountId} and subject_id = ${subjectId}`;
  return {
    subjectId,
    accountId: personalGrant.accountId,
    legacyWorkspaceId,
    personalWorkspaceId: personalGrant.workspaceId,
    organizationMembershipId: membership!.id,
  };
}

/**
 * Mint a session owned by the human. The owner-resolution half of this defect
 * lives in `guard_session_authority_write` and is repaired separately, so the
 * owner column is stamped directly here: this file is about the workspace-access
 * predicate inside `transition_session_visibility` / `fork_session_content`.
 */
async function ownedSession(human: ManagedHuman, workspaceId: string): Promise<string> {
  if (!client || !shared) throw new Error("test database unavailable");
  const session = await createSession(client.db, {
    accountId: human.accountId,
    workspaceId,
    initialMessage: "personal workspace session",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: human.subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await shared.admin.begin(async (tx) => {
    // `guard_session_authority_write` fences every owner mutation behind the
    // per-transaction lifecycle capability. Mint one for this fixture stamp so
    // the assertions below can be about the workspace-access predicate alone.
    const capabilityId = crypto.randomUUID();
    await tx`select set_config('opengeni.session_visibility_write_capability', ${capabilityId}, true)`;
    await tx`insert into session_visibility_write_capabilities (backend_pid, transaction_id, capability_id)
             values (pg_backend_pid(), pg_current_xact_id(), ${capabilityId})`;
    await tx`update sessions
                set owner_organization_membership_id = ${human.organizationMembershipId},
                    owner_subject_id = ${human.subjectId}
              where id = ${session.id}`;
  });
  return session.id;
}

describe("session tenancy SQL seams inside a managed human's own personal workspace", () => {
  test("transition_session_visibility accepts the owner in their own personal workspace", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await ownedSession(human, human.personalWorkspaceId);

    const result = await transitionSessionVisibility(client.db, {
      workspaceId: human.personalWorkspaceId,
      sessionId,
      actorSubjectId: human.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `visibility-${crypto.randomUUID()}`,
    });
    expect(result.visibility).toBe("user_private");
    expect(result.ownerOrganizationMembershipId).toBe(human.organizationMembershipId);
  }, 180_000);

  test("fork_session_content accepts the owner's personal workspace as source and destination", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await ownedSession(human, human.personalWorkspaceId);

    const forked = await forkSessionContent(client.db, {
      sourceWorkspaceId: human.personalWorkspaceId,
      sourceSessionId: sessionId,
      actorSubjectId: human.subjectId,
      destinationWorkspaceId: human.personalWorkspaceId,
      destinationVisibility: "user_private",
      operationKey: `fork-${crypto.randomUUID()}`,
    });
    expect(forked.workspaceId).toBe(human.personalWorkspaceId);
    expect(forked.sessionId).not.toBe(sessionId);
  }, 180_000);

  test("another human never transitions a session in someone else's personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();
    const sessionId = await ownedSession(owner, owner.personalWorkspaceId);

    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: owner.personalWorkspaceId,
        sessionId,
        actorSubjectId: intruder.subjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `visibility-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
  }, 180_000);

  test("another human never forks out of someone else's personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();
    const sessionId = await ownedSession(owner, owner.personalWorkspaceId);

    await expect(
      forkSessionContent(client.db, {
        sourceWorkspaceId: owner.personalWorkspaceId,
        sourceSessionId: sessionId,
        actorSubjectId: intruder.subjectId,
        destinationWorkspaceId: intruder.personalWorkspaceId,
        destinationVisibility: "user_private",
        operationKey: `fork-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
  }, 180_000);

  test("nobody forks INTO another human's personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();
    const sessionId = await ownedSession(intruder, intruder.personalWorkspaceId);

    await expect(
      forkSessionContent(client.db, {
        sourceWorkspaceId: intruder.personalWorkspaceId,
        sourceSessionId: sessionId,
        actorSubjectId: intruder.subjectId,
        destinationWorkspaceId: owner.personalWorkspaceId,
        destinationVisibility: "user_private",
        operationKey: `fork-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
  }, 180_000);

  test("an ordinary workspace with no membership row still denies the human", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const stranger = await provisionManagedHuman();
    // The stranger's LEGACY workspace is an ordinary workspace, not anyone's
    // personal-workspace pointer, so the pointer disjunct must not reach it.
    const sessionId = await ownedSession(stranger, stranger.legacyWorkspaceId);

    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: stranger.legacyWorkspaceId,
        sessionId,
        actorSubjectId: owner.subjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `visibility-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
  }, 180_000);
});
