import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  blockSessionWorkBeforeAttemptClaim,
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  initializeSessionStartAtomically,
  peekSessionWork,
} from "@opengeni/db";
import { releaseMembershipBlocksInOrganization } from "../src/application/admission-release";

// Restoring a person's organization membership (reactivation, an accepted
// invitation) names no workspace and no chat: their saved messages start by
// themselves in every workspace of that organization, and nowhere else.

let shared: SharedTestDatabase | null;
let client: ReturnType<typeof createDb> | undefined;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-admission-release-organization");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("PostgreSQL required");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function blockedChat(accountExternalId: string, workspaceExternalId: string) {
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId,
    accountName: "Membership release",
    workspaceExternalSource: "test",
    workspaceExternalId,
    workspaceName: workspaceExternalId,
    subjectId: `subject-${workspaceExternalId}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client!.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "Saved work",
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
  });
  await initializeSessionStartAtomically(client!.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const peek = await peekSessionWork(client!.db, workspaceId, session.id, true);
  if (peek.kind !== "runnable" || !peek.admissionFence) throw new Error("fixture not runnable");
  const blocked = await blockSessionWorkBeforeAttemptClaim(client!.db, workspaceId, {
    accountId: grant.accountId,
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    attemptId: crypto.randomUUID(),
    fence: peek.admissionFence,
    wakeRevision: peek.admissionWakeRevision!,
    reason: "initiator_membership_required",
    sqlState: "OG001",
  });
  expect(blocked.action).toBe("blocked");
  return { accountId: grant.accountId, workspaceId, sessionId: session.id };
}

async function admissionBlock(chat: { workspaceId: string; sessionId: string }) {
  return (await getSession(client!.db, chat.workspaceId, chat.sessionId))?.admissionBlock ?? null;
}

test("restored membership starts saved messages in every workspace of the organization, once", async () => {
  if (!client) return;
  const organization = crypto.randomUUID();
  const first = await blockedChat(organization, `first-${organization}`);
  const second = await blockedChat(organization, `second-${organization}`);
  expect(second.accountId).toBe(first.accountId);
  const elsewhere = crypto.randomUUID();
  const other = await blockedChat(elsewhere, `other-${elsewhere}`);

  let dispatches = 0;
  const deps = {
    db: client.db,
    requestSessionWorkflowWakeDispatch: async () => {
      dispatches += 1;
    },
  };
  await releaseMembershipBlocksInOrganization(deps, { accountId: first.accountId });

  expect(await admissionBlock(first)).toBeNull();
  expect(await admissionBlock(second)).toBeNull();
  expect(await peekSessionWork(client.db, first.workspaceId, first.sessionId)).toMatchObject({
    kind: "runnable",
  });
  expect(await peekSessionWork(client.db, second.workspaceId, second.sessionId)).toMatchObject({
    kind: "runnable",
  });
  expect(dispatches).toBeGreaterThan(0);
  // Another organization's blocked chat is not touched.
  expect(await admissionBlock(other)).toMatchObject({ reason: "initiator_membership_required" });

  // Delivered twice, it releases nothing more.
  await releaseMembershipBlocksInOrganization(deps, { accountId: first.accountId });
  expect(await admissionBlock(first)).toBeNull();
  expect(await admissionBlock(other)).not.toBeNull();
});
