import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "../src";

// The turn claim takes no organization-membership fence at all. An exclusive
// claim fence serialized every claim in an organization (production burst of
// 40 first messages: claim_atomic p99 23 s); the shared fence that replaced it
// still made every claim wait behind any membership mutator. The fence only
// existed because the claim used to write host-MCP turn authorities whose
// guard triggers take the key exclusively; those writers are retired. A
// membership removal racing a claim is enforced at execution time instead.

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
  test("a claim proceeds while a membership mutator holds the key exclusively", async () => {
    if (!available) return;
    const target = await queuedSession();
    const mutator = await holdMembershipLock(target.accountId, "exclusive");
    try {
      const claimed = claim(target);
      // Any membership lock request from the claim (shared or exclusive, or
      // from a trigger it fires) would block here until the mutator releases.
      expect(await settledWithin(claimed, 5_000)).toBe(true);
      expect((await claimed).action).toBe("claimed");
    } finally {
      mutator.release();
      await mutator.done;
    }
  }, 180_000);

  test("concurrent claims in one organization proceed under an exclusive holder", async () => {
    if (!available) return;
    const first = await queuedSession();
    const second = await queuedSession();
    const mutators = await Promise.all([
      holdMembershipLock(first.accountId, "exclusive"),
      holdMembershipLock(second.accountId, "exclusive"),
    ]);
    try {
      const claims = Promise.all([claim(first), claim(second)]);
      expect(await settledWithin(claims, 5_000)).toBe(true);
      expect((await claims).map((result) => result.action)).toEqual(["claimed", "claimed"]);
    } finally {
      for (const mutator of mutators) mutator.release();
      await Promise.all(mutators.map((mutator) => mutator.done));
    }
  }, 180_000);

  test("only the retired host-MCP authority tables carry triggers that take the key", async () => {
    // The claim can stay fence-free only while no trigger it can fire takes
    // the membership key. Pin the complete trigger set so a new one is a
    // deliberate review of the claim's lock order, not a silent inversion.
    if (!available) return;
    const admin = postgres(shared!.adminUrl, { max: 1, onnotice: () => undefined });
    try {
      const rows = await admin<{ trigger: string }[]>`
        select t.tgrelid::regclass::text || '.' || t.tgname as trigger
        from pg_trigger t
        join pg_proc p on p.oid = t.tgfoid
        where not t.tgisinternal and p.prosrc like '%organization-membership:%'
        order by 1`;
      expect(rows.map((row) => row.trigger)).toEqual([
        "host_mcp_task_authorities.host_mcp_task_authority_guard",
        "host_mcp_turn_authorities.host_mcp_child_turn_authority_guard",
        "host_mcp_turn_authorities.host_mcp_inherited_turn_authority_guard",
        "host_mcp_turn_authorities.host_mcp_scheduled_turn_authority_guard",
        "host_mcp_turn_authorities.host_mcp_turn_authority_guard",
      ]);
    } finally {
      await admin.end();
    }
  }, 180_000);
});
