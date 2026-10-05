import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "../src";

// Production burst (40 concurrent first messages in one organization): the
// turn claim held the organization-membership advisory lock EXCLUSIVELY for
// its whole transaction, so every claim in the organization queued behind
// every other one (claim_atomic p90 6.7 s, p99 23 s). The claim only reads
// membership-fenced authority, so it takes the lock shared: other claims (and
// other readers) proceed in parallel, while a membership mutator holding the
// lock exclusively still fences new claims.

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
let holder: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("claim-organization-membership-fence");
  if (!shared) {
    available = false;
    console.warn("[claim-organization-membership-fence] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  holder = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await holder?.close().catch(() => undefined);
  await shared?.release();
});

async function queuedSession() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `claim-fence-account-${suffix}`,
    accountName: "Claim fence",
    workspaceExternalSource: "test",
    workspaceExternalId: `claim-fence-workspace-${suffix}`,
    workspaceName: "Claim fence",
    subjectId: `claim-fence-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, sessionId: session.id };
}

function claim(target: { workspaceId: string; sessionId: string }) {
  return claimSessionWorkForAttempt(client.db, target.workspaceId, {
    sessionId: target.sessionId,
    workflowId: `session-${target.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
}

/** Hold the organization-membership key in another transaction until released. */
async function holdMembershipLock(accountId: string, mode: "shared" | "exclusive") {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const done = holder.db.transaction(async (tx) => {
    const key = `organization-membership:${accountId}`;
    await tx.execute(
      mode === "shared"
        ? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
        : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
    acquired();
    await released;
  });
  await ready;
  return { release, done };
}

const settledWithin = async <T>(promise: Promise<T>, ms: number) =>
  await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

describe("turn claim organization-membership fence", () => {
  test("a claim is not serialized behind another in-flight claim in the organization", async () => {
    if (!available) return;
    const target = await queuedSession();
    // An in-flight claim (or any other membership reader) holds the key shared.
    const reader = await holdMembershipLock(target.accountId, "shared");
    try {
      const claimed = claim(target);
      expect(await settledWithin(claimed, 5_000)).toBe(true);
      const result = await claimed;
      expect(result.action).toBe("claimed");
    } finally {
      reader.release();
      await reader.done;
    }
  }, 180_000);

  test("concurrent claims of sessions in one organization all succeed", async () => {
    if (!available) return;
    const first = await queuedSession();
    const results = await Promise.all([first, await queuedSession()].map((t) => claim(t)));
    expect(results.map((result) => result.action)).toEqual(["claimed", "claimed"]);
  }, 180_000);

  test("a membership mutator holding the key exclusively still fences new claims", async () => {
    if (!available) return;
    const target = await queuedSession();
    const mutator = await holdMembershipLock(target.accountId, "exclusive");
    let claimed: ReturnType<typeof claim> | undefined;
    try {
      claimed = claim(target);
      expect(await settledWithin(claimed, 750)).toBe(false);
    } finally {
      mutator.release();
      await mutator.done;
    }
    const result = await claimed!;
    expect(result.action).toBe("claimed");
  }, 180_000);
});
