import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  createDb,
  disconnectAllCodexAccounts,
  disconnectCodexAccount,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  getCodexCredentialStatus,
  getCodexRotationSettings,
  listCodexAccountStatuses,
  loadCodexCredentialForRun,
  recordCodexTokenRefresh,
  renameCodexAccount,
  setActiveCodexCredential,
  setCodexCredentialStatus,
  upsertCodexSubscriptionCredential,
  workspaceCodexSubscriptionActive,
  type Database,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";

// Integration proof for the codex_subscription_credentials accessors: round-trip
// decryption, secret-free status reads, refresh rotation, disconnect, multi-account
// active selection, and RLS isolation — under a NON-superuser role so FORCE RLS is
// genuinely enforced (a superuser bypasses RLS). Throwaway pg17.

const CONTAINER = "ogcodex-pg-creds";
const PORT = 55482;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const ADMIN_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const APP_URL = `postgres://codex_app:${APP_PASSWORD}@127.0.0.1:${PORT}/postgres`;
const IMAGE = "pgvector/pgvector:pg17";

const rawKey = randomBytes(32);
const settings = { environmentsEncryptionKey: rawKey.toString("base64") } as unknown as Settings;
const key = environmentsEncryptionKeyBytes(settings)!;

function encTokens(t: { access_token: string; refresh_token: string; id_token: string }): string {
  return encryptEnvironmentValue(key, JSON.stringify(t));
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function removeContainer(): void {
  try {
    docker(["rm", "-f", CONTAINER]);
  } catch {
    /* gone */
  }
}
async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        return;
      } finally {
        await probe.end();
      }
    } catch (err) {
      if (Date.now() > deadline)
        throw new Error(`postgres not ready: ${String(err)}`, { cause: err });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let available = true;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  // Seeded as superuser (bypasses RLS) so the accessors below exercise RLS under codex_app.
  const [a] = await admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

// Connect an account AND make it the workspace active (what the connect route does
// for the first account). Returns the credential id.
async function connectAccount(
  ws: { accountId: string; workspaceId: string },
  chatgptAccountId: string,
  tokens = { access_token: "AC", refresh_token: "RF", id_token: "ID" },
  opts: { activate?: boolean; planType?: string } = {},
): Promise<string> {
  const { id, isNew } = await upsertCodexSubscriptionCredential(db, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    credentialEncrypted: encTokens(tokens),
    chatgptAccountId,
    scopes: null,
    planType: opts.planType ?? "pro",
    isFedramp: false,
    expiresAt: null,
    lastRefreshAt: null,
  });
  await ensureCodexRotationSettings(db, ws.accountId, ws.workspaceId);
  if (opts.activate ?? isNew) {
    await setActiveCodexCredential(db, ws.workspaceId, id);
  }
  return id;
}

beforeAll(async () => {
  try {
    removeContainer();
    docker([
      "run",
      "--rm",
      "-d",
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-p",
      `${PORT}:5432`,
      "--name",
      CONTAINER,
      IMAGE,
    ]);
  } catch (err) {
    available = false;
    console.warn(`[codex-credentials] docker unavailable, skipping: ${String(err)}`);
    return;
  }
  await waitForReady();
  await migrate(ADMIN_URL);
  admin = postgres(ADMIN_URL, { max: 4 });
  // A non-superuser login role so FORCE RLS on the table actually applies to it.
  await admin.unsafe(
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='codex_app') THEN CREATE ROLE codex_app LOGIN PASSWORD '${APP_PASSWORD}'; END IF; END $$;`,
  );
  await admin.unsafe(
    `GRANT USAGE ON SCHEMA public, opengeni_private TO codex_app;` +
      ` GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO codex_app;` +
      ` GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO codex_app;`,
  );
  client = createDb(APP_URL);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  try {
    await admin?.end();
  } catch {
    /* noop */
  }
  removeContainer();
});

describe("codex_subscription_credentials accessors", () => {
  test("upsert -> load round-trips the decrypted tokens + metadata", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const id = await connectAccount(ws, "acct_x");
    const loaded = await loadCodexCredentialForRun(db, settings, ws.workspaceId, id);
    expect(loaded?.tokens).toEqual({ accessToken: "AC", refreshToken: "RF", idToken: "ID" });
    expect(loaded?.chatgptAccountId).toBe("acct_x");
    expect(loaded?.planType).toBe("pro");
  });

  test("getCodexCredentialStatus returns active metadata + id and NEVER the encrypted secret", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const id = await connectAccount(ws, "acct_x", undefined, { planType: "plus" });
    const status = await getCodexCredentialStatus(db, ws.workspaceId);
    expect(status?.connected).toBe(true);
    expect(status?.planType).toBe("plus");
    expect(status?.credentialId).toBe(id);
    expect(status && "credentialEncrypted" in status).toBe(false);
  });

  test("recordCodexTokenRefresh rotates the blob and bumps version", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const id = await connectAccount(ws, "acct_x");
    const before = await loadCodexCredentialForRun(db, settings, ws.workspaceId, id);
    const ok = await recordCodexTokenRefresh(db, {
      id: before!.id,
      version: before!.version,
      workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({
        access_token: "AC2",
        refresh_token: "RF2",
        id_token: "ID2",
      }),
      expiresAt: new Date(Date.now() + 3_600_000),
      lastRefreshAt: new Date(),
    });
    expect(ok).toBe(true);
    const loaded = await loadCodexCredentialForRun(db, settings, ws.workspaceId, id);
    expect(loaded?.tokens.accessToken).toBe("AC2");
    const [row] = await admin<
      { version: number }[]
    >`select version from codex_subscription_credentials where id = ${id}`;
    expect(row!.version).toBe(2);
  });

  test("P1-c: recordCodexTokenRefresh is compare-and-set — a stale (id,version) writes 0 rows", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const id = await connectAccount(ws, "acct_x");
    const loaded = await loadCodexCredentialForRun(db, settings, ws.workspaceId, id);
    const ok = await recordCodexTokenRefresh(db, {
      id: loaded!.id,
      version: loaded!.version + 99,
      workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "STALE", refresh_token: "x", id_token: "x" }),
      expiresAt: null,
      lastRefreshAt: new Date(),
    });
    expect(ok).toBe(false);
    const after = await loadCodexCredentialForRun(db, settings, ws.workspaceId, id);
    expect(after?.tokens.accessToken).toBe("AC"); // untouched
  });

  test("P1-c: setCodexCredentialStatus honors the required (id,version) guard", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const id = await connectAccount(ws, "acct_x");
    const loaded = await loadCodexCredentialForRun(db, settings, ws.workspaceId, id);
    // Stale guard → no stamp.
    expect(
      await setCodexCredentialStatus(db, ws.workspaceId, "needs_relogin", "x", {
        id: loaded!.id,
        version: loaded!.version + 1,
      }),
    ).toBe(false);
    expect((await getCodexCredentialStatus(db, ws.workspaceId))?.status).toBe("active");
    // Matching guard → stamps.
    expect(
      await setCodexCredentialStatus(db, ws.workspaceId, "needs_relogin", "expired", {
        id: loaded!.id,
        version: loaded!.version,
      }),
    ).toBe(true);
    expect((await getCodexCredentialStatus(db, ws.workspaceId))?.status).toBe("needs_relogin");
  });

  test("P2-a: upsert ON CONFLICT (ws, account) re-asserts account_id and updates in place", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const first = await connectAccount(ws, "acct_x");
    // Re-connect SAME ChatGPT account → updates in place (same id), not a new row.
    const { id: again, isNew } = await upsertCodexSubscriptionCredential(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "AC", refresh_token: "RF", id_token: "ID" }),
      chatgptAccountId: "acct_x",
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: null,
      lastRefreshAt: null,
    });
    expect(again).toBe(first);
    expect(isNew).toBe(false);
    const [row] = await admin<{ account_id: string; n: string }[]>`
      select account_id, (select count(*) from codex_subscription_credentials where workspace_id = ${ws.workspaceId})::text as n
      from codex_subscription_credentials where id = ${first}`;
    expect(row!.account_id).toBe(ws.accountId);
    expect(row!.n).toBe("1");
  });

  test("multi-account: a second ChatGPT account inserts a NEW row; both coexist; active stays the first", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const a = await connectAccount(ws, "acct_a");
    // Second account does NOT auto-activate in P1 (route rule); connectAccount only
    // activates when isNew AND we opt in — here we pass activate:false explicitly.
    const b = await upsertCodexSubscriptionCredential(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "BC", refresh_token: "BR", id_token: "BI" }),
      chatgptAccountId: "acct_b",
      scopes: null,
      planType: "team",
      isFedramp: false,
      expiresAt: null,
      lastRefreshAt: null,
    });
    expect(b.isNew).toBe(true);
    const list = await listCodexAccountStatuses(db, ws.workspaceId);
    expect(list.map((x) => x.chatgptAccountId).sort()).toEqual(["acct_a", "acct_b"]);
    expect(list.find((x) => x.id === a)?.isActive).toBe(true);
    expect(list.find((x) => x.id === b.id)?.isActive).toBe(false);
    // The active pointer still resolves to the first account.
    expect((await getCodexRotationSettings(db, ws.workspaceId))?.activeCredentialId).toBe(a);
  });

  test("setActiveCodexCredential flips the active pointer; unknown id → false", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const a = await connectAccount(ws, "acct_a");
    const b = (
      await upsertCodexSubscriptionCredential(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        credentialEncrypted: encTokens({ access_token: "BC", refresh_token: "BR", id_token: "BI" }),
        chatgptAccountId: "acct_b",
        scopes: null,
        planType: "team",
        isFedramp: false,
        expiresAt: null,
        lastRefreshAt: null,
      })
    ).id;
    expect(await setActiveCodexCredential(db, ws.workspaceId, b)).toBe(true);
    expect((await getCodexCredentialStatus(db, ws.workspaceId))?.credentialId).toBe(b);
    expect(await setActiveCodexCredential(db, ws.workspaceId, crypto.randomUUID())).toBe(false);
    // Pointer unchanged by the failed flip.
    expect((await getCodexRotationSettings(db, ws.workspaceId))?.activeCredentialId).toBe(b);
    expect(a).not.toBe(b);
  });

  test("renameCodexAccount updates the label", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const id = await connectAccount(ws, "acct_x");
    expect(await renameCodexAccount(db, ws.workspaceId, id, "Work account")).toBe(true);
    const list = await listCodexAccountStatuses(db, ws.workspaceId);
    expect(list.find((x) => x.id === id)?.label).toBe("Work account");
  });

  test("disconnectCodexAccount removes one and re-picks active when the active one is removed", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const a = await connectAccount(ws, "acct_a");
    const b = (
      await upsertCodexSubscriptionCredential(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        credentialEncrypted: encTokens({ access_token: "BC", refresh_token: "BR", id_token: "BI" }),
        chatgptAccountId: "acct_b",
        scopes: null,
        planType: "team",
        isFedramp: false,
        expiresAt: null,
        lastRefreshAt: null,
      })
    ).id;
    // a is active; disconnect a → b becomes active (the only remaining account).
    const res = await disconnectCodexAccount(db, ws.workspaceId, a);
    expect(res.removed).toBe(true);
    expect(res.newActiveCredentialId).toBe(b);
    expect((await getCodexRotationSettings(db, ws.workspaceId))?.activeCredentialId).toBe(b);
    // Disconnect the last one → no active remains.
    const res2 = await disconnectCodexAccount(db, ws.workspaceId, b);
    expect(res2.removed).toBe(true);
    expect(res2.newActiveCredentialId).toBeNull();
    expect(await getCodexCredentialStatus(db, ws.workspaceId)).toBeNull();
    // Disconnecting an already-gone id → removed:false.
    expect((await disconnectCodexAccount(db, ws.workspaceId, a)).removed).toBe(false);
  });

  test("disconnectAllCodexAccounts removes every account", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await connectAccount(ws, "acct_a");
    await upsertCodexSubscriptionCredential(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "BC", refresh_token: "BR", id_token: "BI" }),
      chatgptAccountId: "acct_b",
      scopes: null,
      planType: "team",
      isFedramp: false,
      expiresAt: null,
      lastRefreshAt: null,
    });
    expect(await disconnectAllCodexAccounts(db, ws.workspaceId)).toBe(2);
    expect(await getCodexCredentialStatus(db, ws.workspaceId)).toBeNull();
    expect(await disconnectAllCodexAccounts(db, ws.workspaceId)).toBe(0);
  });

  test("workspaceCodexSubscriptionActive reflects the ACTIVE account's status", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const enabled = { codexSubscriptionEnabled: true } as Parameters<
      typeof workspaceCodexSubscriptionActive
    >[1];
    expect(await workspaceCodexSubscriptionActive(db, enabled, ws.workspaceId)).toBe(false);
    expect(
      await workspaceCodexSubscriptionActive(
        db,
        { codexSubscriptionEnabled: false } as typeof enabled,
        ws.workspaceId,
      ),
    ).toBe(false);
    const id = await connectAccount(ws, "acct_x");
    expect(await workspaceCodexSubscriptionActive(db, enabled, ws.workspaceId)).toBe(true);
    const loaded = await loadCodexCredentialForRun(db, settings, ws.workspaceId, id);
    await setCodexCredentialStatus(db, ws.workspaceId, "needs_relogin", "x", {
      id: loaded!.id,
      version: loaded!.version,
    });
    expect(await workspaceCodexSubscriptionActive(db, enabled, ws.workspaceId)).toBe(false);
  });

  test("RLS: workspace B cannot read workspace A's credential, accounts, or settings", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const idA = await connectAccount(a, "acct_a");
    expect(await loadCodexCredentialForRun(db, settings, b.workspaceId, idA)).toBeNull();
    expect(await getCodexCredentialStatus(db, b.workspaceId)).toBeNull();
    expect(await listCodexAccountStatuses(db, b.workspaceId)).toEqual([]);
    expect(await getCodexRotationSettings(db, b.workspaceId)).toBeNull();
    // A still sees its own.
    expect((await listCodexAccountStatuses(db, a.workspaceId)).length).toBe(1);
  });
});
