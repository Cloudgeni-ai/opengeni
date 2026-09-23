import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  previewSessionRecencyRepair,
  applySessionRecencyRepair,
} from "../../../scripts/session-recency-repair";
import {
  appendSessionEvents,
  withWorkspaceSessionActivityRls,
  createDb,
  createSession,
  getSessionCodexState,
  recordSessionActiveCodexCredential,
  setSessionCodexPin,
  setWorkspaceCodexSubscriptionMode,
  type Database,
  type DbClient,
} from "../src/index";

// AM-2 — the per-session codex pin SOURCE discriminator (sessions.codex_pin_source).
// Driven through the REAL packages/db accessors against a throwaway postgres under the
// NON-superuser opengeni_app role (so FORCE RLS actually applies). Seeding is done as
// the superuser (bypasses RLS). Proves: a manual pin stamps 'manual', a policy pin
// stamps 'policy', clearing the pin clears the source, a manual pin overrides a policy
// pin, pre-existing (never-pinned) rows read NULL, and the CHECK constraint holds.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function seedSession(ws: { accountId: string; workspaceId: string }): Promise<string> {
  const session = await createSession(db, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    initialMessage: "go",
    resources: [],
    metadata: {},
    model: "gpt",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "modal",
  });
  return session.id;
}

// A codex account for the pin to validate against (setSessionCodexPin checks ownership).
async function seedCodexAccount(ws: { accountId: string; workspaceId: string }): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into codex_subscription_credentials
      (account_id, workspace_id, credential_encrypted, chatgpt_account_id)
    values (${ws.accountId}, ${ws.workspaceId}, 'v1:enc', ${crypto.randomUUID()})
    returning id`;
  return row!.id;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("codex-pin-source");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[codex-pin-source] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

describe("codex_pin_source (AM-2)", () => {
  test("a fresh (never-pinned) session reads pin=null, source=null", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const state = await getSessionCodexState(db, ws.workspaceId, sessionId);
    expect(state).toEqual({ pinnedCredentialId: null, lastCredentialId: null, pinSource: null });
  });

  test("recording the unchanged active credential is a true activity no-op", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const accountId = await seedCodexAccount(ws);
    await recordSessionActiveCodexCredential(db, ws.workspaceId, sessionId, accountId);
    const [before] = await admin<
      Array<{ activityRevision: string; updatedAt: Date; workspaceRevision: string }>
    >`
      select
        session.activity_revision::text as "activityRevision",
        session.updated_at as "updatedAt",
        revision.revision::text as "workspaceRevision"
      from sessions as session
      join workspace_session_activity_revisions as revision
        on revision.workspace_id = session.workspace_id
      where session.workspace_id = ${ws.workspaceId} and session.id = ${sessionId}
    `;
    await recordSessionActiveCodexCredential(db, ws.workspaceId, sessionId, accountId);
    const [after] = await admin<
      Array<{ activityRevision: string; updatedAt: Date; workspaceRevision: string }>
    >`
      select
        session.activity_revision::text as "activityRevision",
        session.updated_at as "updatedAt",
        revision.revision::text as "workspaceRevision"
      from sessions as session
      join workspace_session_activity_revisions as revision
        on revision.workspace_id = session.workspace_id
      where session.workspace_id = ${ws.workspaceId} and session.id = ${sessionId}
    `;
    expect(await getSessionCodexState(db, ws.workspaceId, sessionId)).toMatchObject({
      lastCredentialId: accountId,
    });
    expect(after).toEqual(before);
  });

  test("default source is 'manual' — the user's in-session switcher", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const accountId = await seedCodexAccount(ws);
    expect(await setSessionCodexPin(db, ws.workspaceId, sessionId, accountId)).toBe(true);
    const state = await getSessionCodexState(db, ws.workspaceId, sessionId);
    expect(state?.pinnedCredentialId).toBe(accountId);
    expect(state?.pinSource).toBe("manual");
  });

  test("an explicit 'policy' pin stamps 'policy' (the sharded home assignment)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const accountId = await seedCodexAccount(ws);
    expect(await setSessionCodexPin(db, ws.workspaceId, sessionId, accountId, "policy")).toBe(true);
    const state = await getSessionCodexState(db, ws.workspaceId, sessionId);
    expect(state?.pinnedCredentialId).toBe(accountId);
    expect(state?.pinSource).toBe("policy");
  });

  test("clearing the pin (null) clears the source too", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const accountId = await seedCodexAccount(ws);
    await setSessionCodexPin(db, ws.workspaceId, sessionId, accountId, "policy");
    expect(await setSessionCodexPin(db, ws.workspaceId, sessionId, null)).toBe(true);
    const state = await getSessionCodexState(db, ws.workspaceId, sessionId);
    expect(state).toEqual({
      pinnedCredentialId: null,
      lastCredentialId: null,
      pinSource: null,
    });
  });

  test("a manual pin OVERRIDES a policy pin (the user's switcher wins)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const accountId = await seedCodexAccount(ws);
    await setSessionCodexPin(db, ws.workspaceId, sessionId, accountId, "policy");
    // The manual API route pins with the default source.
    await setSessionCodexPin(db, ws.workspaceId, sessionId, accountId);
    const state = await getSessionCodexState(db, ws.workspaceId, sessionId);
    expect(state?.pinSource).toBe("manual");
  });

  test("a stale policy CAS cannot overwrite a concurrent manual pin", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const firstPolicyHome = await seedCodexAccount(ws);
    const nextPolicyHome = await seedCodexAccount(ws);
    await setSessionCodexPin(db, ws.workspaceId, sessionId, firstPolicyHome, "policy");
    const observed = await getSessionCodexState(db, ws.workspaceId, sessionId);
    if (!observed) throw new Error("expected session codex state");

    await setSessionCodexPin(db, ws.workspaceId, sessionId, nextPolicyHome, "manual");
    expect(
      await setSessionCodexPin(db, ws.workspaceId, sessionId, firstPolicyHome, "policy", {
        expected: observed,
      }),
    ).toBe(false);
    expect(await getSessionCodexState(db, ws.workspaceId, sessionId)).toMatchObject({
      pinnedCredentialId: nextPolicyHome,
      pinSource: "manual",
    });
  });

  test("migration 0051 backfill stamps a pre-existing (unlabeled) pin 'manual', leaving policy/unpinned rows untouched", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const account = await seedCodexAccount(ws);
    // Simulate the PRE-migration state: a pinned session with a NULL source (the only
    // pin writer before this PR was the manual API), a policy-pinned session, and an
    // unpinned session — then replay the EXACT backfill statement from 0051.
    const legacyPinned = await seedSession(ws);
    const policyPinned = await seedSession(ws);
    const unpinned = await seedSession(ws);
    await admin`update sessions set codex_pinned_credential_id = ${account}, codex_pin_source = null where id = ${legacyPinned}`;
    await admin`update sessions set codex_pinned_credential_id = ${account}, codex_pin_source = 'policy' where id = ${policyPinned}`;
    await admin`update sessions
      set codex_pin_source = 'manual'
      where codex_pinned_credential_id is not null and codex_pin_source is null`;
    // The legacy unlabeled pin is now manual (sacred); policy + unpinned are untouched.
    expect((await getSessionCodexState(db, ws.workspaceId, legacyPinned))?.pinSource).toBe(
      "manual",
    );
    expect((await getSessionCodexState(db, ws.workspaceId, policyPinned))?.pinSource).toBe(
      "policy",
    );
    expect((await getSessionCodexState(db, ws.workspaceId, unpinned))?.pinSource).toBeNull();
  });

  test("the CHECK constraint exists and rejects an unknown source value", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    // The migration installed the named CHECK constraint.
    const [constraint] = await admin<{ conname: string }[]>`
      select conname from pg_constraint where conname = 'sessions_codex_pin_source_check'`;
    expect(constraint?.conname).toBe("sessions_codex_pin_source_check");
    // And it rejects an out-of-domain value (explicit try/catch — a postgres.js query is
    // a lazy thenable; awaiting it is the robust way to observe the rejection).
    let threw = false;
    try {
      await admin`update sessions set codex_pin_source = 'bogus' where id = ${sessionId}`;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// Recency is conversation activity, not provider account bookkeeping.
async function recencySnapshot(workspaceId: string) {
  return await admin`
    select s.id, s.updated_at::text as updated_at, s.activity_revision::text as revision,
      r.revision::text as workspace_revision
    from sessions s join workspace_session_activity_revisions r using (workspace_id)
    where s.workspace_id = ${workspaceId}
    order by s.updated_at desc, s.id desc
  `;
}

describe("Codex bookkeeping preserves conversation recency", () => {
  test("source preference changes clear affinities without reordering sessions", async () => {
    if (!available) throw new Error("Real PostgreSQL is required for the recency regression");
    const ws = await freshWorkspace();
    const other = await freshWorkspace();
    const credential = await seedCodexAccount(ws);
    const otherCredential = await seedCodexAccount(other);
    const first = await seedSession(ws);
    const second = await seedSession(ws);
    await seedSession(ws);
    const outsider = await seedSession(other);
    await setSessionCodexPin(db, other.workspaceId, outsider, otherCredential);
    const otherBefore = await recencySnapshot(other.workspaceId);
    for (const mode of ["workspace", "automatic"] as const) {
      await setSessionCodexPin(db, ws.workspaceId, first, credential);
      await setSessionCodexPin(db, ws.workspaceId, second, credential, "policy");
      await recordSessionActiveCodexCredential(db, ws.workspaceId, first, credential);
      const before = await recencySnapshot(ws.workspaceId);
      await setWorkspaceCodexSubscriptionMode(db, { ...ws, subjectId: null, mode });
      expect(await recencySnapshot(ws.workspaceId)).toEqual(before);
      for (const id of [first, second]) {
        expect(await getSessionCodexState(db, ws.workspaceId, id)).toEqual({
          pinnedCredentialId: null,
          lastCredentialId: null,
          pinSource: null,
        });
      }
      expect(await recencySnapshot(other.workspaceId)).toEqual(otherBefore);
      expect(
        (await getSessionCodexState(db, other.workspaceId, outsider))?.pinnedCredentialId,
      ).toBe(otherCredential);
    }
  });

  test("policy reassignment and active-account recording do not count as work", async () => {
    if (!available) throw new Error("Real PostgreSQL is required for the recency regression");
    const ws = await freshWorkspace();
    const first = await seedCodexAccount(ws);
    const second = await seedCodexAccount(ws);
    const id = await seedSession(ws);
    const before = await recencySnapshot(ws.workspaceId);
    await setSessionCodexPin(db, ws.workspaceId, id, first, "policy");
    await recordSessionActiveCodexCredential(db, ws.workspaceId, id, first);
    await setSessionCodexPin(db, ws.workspaceId, id, second, "policy");
    await recordSessionActiveCodexCredential(db, ws.workspaceId, id, second);
    await setSessionCodexPin(db, ws.workspaceId, id, null, "policy");
    expect(await recencySnapshot(ws.workspaceId)).toEqual(before);
    expect((await getSessionCodexState(db, ws.workspaceId, id))?.lastCredentialId).toBe(second);
  });

  test("an explicit manual account switch still counts as a session change", async () => {
    if (!available) throw new Error("Real PostgreSQL is required for the recency regression");
    const ws = await freshWorkspace();
    const credential = await seedCodexAccount(ws);
    const id = await seedSession(ws);
    const before = await recencySnapshot(ws.workspaceId);
    await setSessionCodexPin(db, ws.workspaceId, id, credential);
    const after = await recencySnapshot(ws.workspaceId);
    expect(BigInt(after[0]!.revision)).toBeGreaterThan(BigInt(before[0]!.revision));
    expect(after[0]!.updated_at).not.toBe(before[0]!.updated_at);
  });
});

describe("reviewed historical recency repair", () => {
  test("preview and apply time out behind an exclusive tenancy fence", async () => {
    if (!available) throw new Error("Real PostgreSQL is required");
    const ws = await freshWorkspace();
    const id = await seedSession(ws);
    await withWorkspaceSessionActivityRls(db, ws.workspaceId, async (tx) => {
      await tx.execute(
        sql`update sessions set status = 'idle', updated_at = updated_at + interval '1 day' where id = ${id}::uuid`,
      );
    });
    const plan = await previewSessionRecencyRepair(
      db,
      ws.workspaceId,
      [id],
      "Confirmed test incident",
    );
    const before = await recencySnapshot(ws.workspaceId);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"session-tenancy:" + ws.workspaceId}, 0))`;
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const results = await Promise.allSettled([
        previewSessionRecencyRepair(db, ws.workspaceId, [id], "Confirmed test incident"),
        applySessionRecencyRepair(db, plan),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected")
          expect(result.reason.code ?? result.reason.cause?.code).toBe("55P03");
      }
    } finally {
      release.resolve();
      await holder;
    }
    expect(await recencySnapshot(ws.workspaceId)).toEqual(before);
  }, 20_000);

  test("dry-run preserves state, apply retains microseconds and advances only revision, repeat is idempotent", async () => {
    if (!available) throw new Error("Real PostgreSQL is required");
    const ws = await freshWorkspace();
    const id = await seedSession(ws);
    await withWorkspaceSessionActivityRls(db, ws.workspaceId, async (tx) => {
      await tx.execute(sql`update sessions set status = 'idle', updated_at = updated_at + interval '1 day'
        where id = ${id}::uuid`);
    });
    const before = await recencySnapshot(ws.workspaceId);
    const plan = await previewSessionRecencyRepair(
      db,
      ws.workspaceId,
      [id],
      "Test reproduces confirmed provider-only write",
    );
    expect(await recencySnapshot(ws.workspaceId)).toEqual(before);
    expect(plan.candidates[0]!.proposedUpdatedAt).toMatch(/\.\d{6}Z$/);
    expect(await applySessionRecencyRepair(db, plan)).toEqual([
      { sessionId: id, outcome: "applied" },
    ]);
    const after = await recencySnapshot(ws.workspaceId);
    expect(BigInt(after[0]!.revision)).toBeGreaterThan(BigInt(before[0]!.revision));
    const [exact] =
      await admin`select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from sessions where id = ${id}`;
    expect(exact!.at).toBe(plan.candidates[0]!.proposedUpdatedAt);
    expect(await applySessionRecencyRepair(db, plan)).toEqual([
      { sessionId: id, outcome: "already_applied" },
    ]);
    expect(await recencySnapshot(ws.workspaceId)).toEqual(after);
  });

  test("a new semantic event invalidates a reviewed repair and still advances recency", async () => {
    if (!available) throw new Error("Real PostgreSQL is required");
    const ws = await freshWorkspace();
    const id = await seedSession(ws);
    await withWorkspaceSessionActivityRls(db, ws.workspaceId, async (tx) => {
      await tx.execute(sql`update sessions set status = 'idle', updated_at = updated_at + interval '1 day'
        where id = ${id}::uuid`);
    });
    const plan = await previewSessionRecencyRepair(
      db,
      ws.workspaceId,
      [id],
      "Confirmed test incident",
    );
    const revision = BigInt((await recencySnapshot(ws.workspaceId))[0]!.revision);
    await appendSessionEvents(db, ws.workspaceId, id, [
      { type: "user.message", payload: { text: "new work" } },
    ]);
    const fresh = await recencySnapshot(ws.workspaceId);
    expect(BigInt(fresh[0]!.revision)).toBeGreaterThan(revision);
    expect(await applySessionRecencyRepair(db, plan)).toEqual([
      { sessionId: id, outcome: "stale" },
    ]);
    expect(await recencySnapshot(ws.workspaceId)).toEqual(fresh);
  });

  test("raw deltas preserve recency but invalidate the reviewed sequence", async () => {
    if (!available) throw new Error("Real PostgreSQL is required");
    const ws = await freshWorkspace();
    const id = await seedSession(ws);
    await withWorkspaceSessionActivityRls(db, ws.workspaceId, async (tx) => {
      await tx.execute(sql`update sessions set status = 'idle', updated_at = updated_at + interval '1 day'
        where id = ${id}::uuid`);
    });
    const plan = await previewSessionRecencyRepair(
      db,
      ws.workspaceId,
      [id],
      "Confirmed test incident",
    );
    const before = await recencySnapshot(ws.workspaceId);
    await appendSessionEvents(db, ws.workspaceId, id, [
      { type: "agent.message.delta", payload: { text: "raw" } },
    ]);
    expect(await recencySnapshot(ws.workspaceId)).toEqual(before);
    expect(await applySessionRecencyRepair(db, plan)).toEqual([
      { sessionId: id, outcome: "stale" },
    ]);
  });
});
