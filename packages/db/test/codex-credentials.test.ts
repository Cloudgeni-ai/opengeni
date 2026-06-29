import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  createDb,
  deleteCodexSubscriptionCredential,
  encryptEnvironmentValue,
  getCodexCredentialStatus,
  loadCodexCredentialForRun,
  recordCodexTokenRefresh,
  setCodexCredentialStatus,
  upsertCodexSubscriptionCredential,
  type Database,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";

// Integration proof for the codex_subscription_credentials accessors: round-trip
// decryption, secret-free status reads, refresh rotation, disconnect, and RLS
// isolation — under a NON-superuser role so FORCE RLS is genuinely enforced
// (a superuser bypasses RLS). Throwaway pg17.

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
  try { docker(["rm", "-f", CONTAINER]); } catch { /* gone */ }
}
async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2 });
      try { await probe`SELECT 1`; return; } finally { await probe.end(); }
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`postgres not ready: ${String(err)}`);
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
  const [a] = await admin<{ id: string }[]>`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

beforeAll(async () => {
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
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
  try { await client?.close(); } catch { /* noop */ }
  try { await admin?.end(); } catch { /* noop */ }
  removeContainer();
});

describe("codex_subscription_credentials accessors", () => {
  test("upsert -> load round-trips the decrypted tokens + metadata", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const expiresAt = new Date(Date.now() + 3_600_000);
    await upsertCodexSubscriptionCredential(db, {
      accountId: ws.accountId, workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "AC", refresh_token: "RF", id_token: "ID" }),
      chatgptAccountId: "acct_x", scopes: null, planType: "pro", isFedramp: false,
      expiresAt, lastRefreshAt: new Date(),
    });
    const loaded = await loadCodexCredentialForRun(db, settings, ws.workspaceId);
    expect(loaded?.tokens).toEqual({ accessToken: "AC", refreshToken: "RF", idToken: "ID" });
    expect(loaded?.chatgptAccountId).toBe("acct_x");
    expect(loaded?.planType).toBe("pro");
  });

  test("getCodexCredentialStatus returns metadata and NEVER the encrypted secret", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await upsertCodexSubscriptionCredential(db, {
      accountId: ws.accountId, workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "AC", refresh_token: "RF", id_token: "ID" }),
      chatgptAccountId: "acct_x", scopes: "openid", planType: "plus", isFedramp: false,
      expiresAt: null, lastRefreshAt: null,
    });
    const status = await getCodexCredentialStatus(db, ws.workspaceId);
    expect(status?.connected).toBe(true);
    expect(status?.planType).toBe("plus");
    expect(status && "credentialEncrypted" in status).toBe(false);
  });

  test("recordCodexTokenRefresh rotates the blob and bumps version", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await upsertCodexSubscriptionCredential(db, {
      accountId: ws.accountId, workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "AC", refresh_token: "RF", id_token: "ID" }),
      chatgptAccountId: "acct_x", scopes: null, planType: "pro", isFedramp: false,
      expiresAt: null, lastRefreshAt: null,
    });
    await recordCodexTokenRefresh(db, {
      workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "AC2", refresh_token: "RF2", id_token: "ID2" }),
      expiresAt: new Date(Date.now() + 3_600_000), lastRefreshAt: new Date(),
    });
    const loaded = await loadCodexCredentialForRun(db, settings, ws.workspaceId);
    expect(loaded?.tokens.accessToken).toBe("AC2");
    const [row] = await admin<{ version: number }[]>`select version from codex_subscription_credentials where workspace_id = ${ws.workspaceId}`;
    expect(row!.version).toBe(2);
  });

  test("setCodexCredentialStatus transitions to needs_relogin", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await upsertCodexSubscriptionCredential(db, {
      accountId: ws.accountId, workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "AC", refresh_token: "RF", id_token: "ID" }),
      chatgptAccountId: "acct_x", scopes: null, planType: "pro", isFedramp: false,
      expiresAt: null, lastRefreshAt: null,
    });
    await setCodexCredentialStatus(db, ws.workspaceId, "needs_relogin", "expired");
    const status = await getCodexCredentialStatus(db, ws.workspaceId);
    expect(status?.status).toBe("needs_relogin");
    expect(status?.connected).toBe(false);
    expect(status?.lastError).toBe("expired");
  });

  test("deleteCodexSubscriptionCredential disconnects (and is idempotent)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await upsertCodexSubscriptionCredential(db, {
      accountId: ws.accountId, workspaceId: ws.workspaceId,
      credentialEncrypted: encTokens({ access_token: "AC", refresh_token: "RF", id_token: "ID" }),
      chatgptAccountId: "acct_x", scopes: null, planType: "pro", isFedramp: false,
      expiresAt: null, lastRefreshAt: null,
    });
    expect(await deleteCodexSubscriptionCredential(db, ws.workspaceId)).toBe(true);
    expect(await getCodexCredentialStatus(db, ws.workspaceId)).toBeNull();
    expect(await deleteCodexSubscriptionCredential(db, ws.workspaceId)).toBe(false); // already gone
  });

  test("RLS: workspace B cannot read workspace A's credential", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    await upsertCodexSubscriptionCredential(db, {
      accountId: a.accountId, workspaceId: a.workspaceId,
      credentialEncrypted: encTokens({ access_token: "AC", refresh_token: "RF", id_token: "ID" }),
      chatgptAccountId: "acct_a", scopes: null, planType: "pro", isFedramp: false,
      expiresAt: null, lastRefreshAt: null,
    });
    expect(await loadCodexCredentialForRun(db, settings, b.workspaceId)).toBeNull();
    expect(await getCodexCredentialStatus(db, b.workspaceId)).toBeNull();
  });
});
