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
 * Mint a session owned by the human.
 *
 * Migration 0302 (#1631, now on `main`) repaired the owner-resolution half of
 * this defect: `guard_session_authority_write` accepts an active membership's
 * own `personal_workspace_id` pointer, so a session minted in the owner's
 * personal workspace is now attributed automatically. This fixture therefore
 * asserts that rather than hand-stamping the owner behind the lifecycle
 * capability, which is what it had to do before 0302 landed.
 *
 * That leaves the workspace-ACCESS predicate inside
 * `transition_session_visibility` / `fork_session_content` as the only
 * remaining half — which is exactly what this file pins.
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
  const [owned] = await shared.admin<Array<{ owner: string | null }>>`
    select owner_organization_membership_id as "owner" from sessions where id = ${session.id}`;
  expect(owned?.owner).toBe(human.organizationMembershipId);
  return session.id;
}

/**
 * The drizzle wrapper re-throws as `Failed query: ...` and keeps the real
 * PostgreSQL error on `cause`, so assert across the whole chain rather than the
 * outermost message.
 */
async function expectSqlFailure(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  const messages: string[] = [];
  for (let error = caught; error instanceof Error; error = error.cause) {
    messages.push(error.message);
  }
  expect(messages.join(" | ")).toMatch(pattern);
}

/**
 * KNOWN DEFECT, PINNED — NOT FIXED HERE.
 *
 * `transition_session_visibility` (0225) and `fork_session_content` (0289) both
 * require a `workspace_memberships` row for the actor in the target / source /
 * destination workspace. A managed human's personal workspace never has one
 * (migration 0219 raises on it), so the owner is refused inside the one
 * workspace they always belong to.
 *
 * Both are SECURITY DEFINER, so there is no application-layer fix — only a
 * migration, which is deliberately not in this PR because the ordinal would
 * collide with #1631's 0302 rewriting these same functions. Neither has a
 * production caller (`test/session-visibility-contract-surface.test.ts` enforces
 * that), so this is latent rather than live.
 *
 * These tests assert the CURRENT WRONG BEHAVIOUR with its exact message, so the
 * defect is recorded and CI stays green. Whoever ships the migration should
 * invert them — the fix is the disjunct 0258 already uses:
 *
 *   IF actor_membership.personal_workspace_id IS DISTINCT FROM <workspace> THEN
 *     <existing workspace_memberships requirement>
 *   END IF;
 *
 * `transition_session_visibility` additionally needs a non-null
 * `owner_organization_membership_id`, which is exactly what #1631 repairs at the
 * mint — so that seam needs BOTH halves.
 */
describe("session tenancy SQL seams inside a managed human's own personal workspace", () => {
  test("PINNED DEFECT: transition_session_visibility refuses the owner in their own personal workspace", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await ownedSession(human, human.personalWorkspaceId);

    await expectSqlFailure(
      async () =>
        await transitionSessionVisibility(client!.db, {
          workspaceId: human.personalWorkspaceId,
          sessionId,
          actorSubjectId: human.subjectId,
          targetVisibility: "user_private",
          expectedAuthorityEpoch: 1,
          operationKey: `visibility-${crypto.randomUUID()}`,
        }),
      /session visibility transition requires active membership/,
    );
  }, 180_000);

  test("PINNED DEFECT: fork_session_content refuses the owner's own personal workspace as source", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await ownedSession(human, human.personalWorkspaceId);

    await expectSqlFailure(
      async () =>
        await forkSessionContent(client!.db, {
          sourceWorkspaceId: human.personalWorkspaceId,
          sourceSessionId: sessionId,
          actorSubjectId: human.subjectId,
          destinationWorkspaceId: human.personalWorkspaceId,
          destinationVisibility: "user_private",
          operationKey: `fork-${crypto.randomUUID()}`,
        }),
      /session fork source workspace access is unavailable/,
    );
  }, 180_000);

  test("the same operations succeed in an ordinary workspace, so the seam is not simply broken", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await ownedSession(human, human.legacyWorkspaceId);

    const result = await transitionSessionVisibility(client.db, {
      workspaceId: human.legacyWorkspaceId,
      sessionId,
      actorSubjectId: human.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `visibility-${crypto.randomUUID()}`,
    });
    expect(result.visibility).toBe("user_private");
    expect(result.ownerOrganizationMembershipId).toBe(human.organizationMembershipId);
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
