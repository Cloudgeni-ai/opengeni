import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  getSessionCodexState,
  setSessionCodexPin,
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
  return { accountId: a!.id, workspaceId: w!.id };
}

async function seedSession(ws: { accountId: string; workspaceId: string }): Promise<string> {
  const id = crypto.randomUUID();
  await admin`
    insert into sessions (id, account_id, workspace_id, initial_message, model, sandbox_backend, sandbox_group_id)
    values (${id}, ${ws.accountId}, ${ws.workspaceId}, 'go', 'gpt', 'modal', ${id})`;
  return id;
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
});

describe("codex_pin_source (AM-2)", () => {
  test("a fresh (never-pinned) session reads pin=null, source=null", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const state = await getSessionCodexState(db, ws.workspaceId, sessionId);
    expect(state).toEqual({ pinnedCredentialId: null, lastCredentialId: null, pinSource: null });
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
