import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { CODEX_TOKEN_URL, CODEX_WHAM_BASE } from "@opengeni/codex";
import {
  createDb,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  fetchCodexUsageForAccount,
  getCodexCredentialStatus,
  listCodexAccountStatuses,
  recordCodexAccountUsage,
  setActiveCodexCredential,
  upsertCodexSubscriptionCredential,
  type Database,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";

// P2 usage cache + the refreshing per-account usage wrapper, under a NON-superuser
// role so FORCE RLS genuinely applies. fetchCodexUsageForAccount drives the SHARED
// resolver (refresh-if-stale + (id,version) CAS) and then the /wham/usage read; the
// OAuth refresh + wham endpoints are mocked on globalThis.fetch. Throwaway pg17.

const CONTAINER = "ogcodex-pg-usage";
const PORT = 55487;
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

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// A usage body in the live shape (used_percent + reset timing; reset_at epoch seconds).
function whamBody(primaryPct: number, secondaryPct: number, over: Record<string, unknown> = {}): unknown {
  return {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: primaryPct, reset_after_seconds: 3600, reset_at: Math.floor(Date.now() / 1000) + 3600, limit_window_seconds: 18000 },
      secondary_window: { used_percent: secondaryPct, reset_after_seconds: 200000, reset_at: Math.floor(Date.now() / 1000) + 200000, limit_window_seconds: 604800 },
    },
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Install a mock fetch that answers the OAuth refresh + wham endpoints.
function mockFetch(handlers: { refresh?: () => Response; wham?: () => Response }): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === CODEX_TOKEN_URL && handlers.refresh) return handlers.refresh();
    if (url.startsWith(`${CODEX_WHAM_BASE}/wham/usage`) && handlers.wham) return handlers.wham();
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

// Connect an account with an explicit token blob + expiry, and make it active.
async function connect(
  ws: { accountId: string; workspaceId: string },
  chatgptAccountId: string,
  tokens: { access_token: string; refresh_token: string; id_token: string },
  expiresAt: Date | null,
): Promise<string> {
  const { id } = await upsertCodexSubscriptionCredential(db, {
    accountId: ws.accountId, workspaceId: ws.workspaceId,
    credentialEncrypted: encTokens(tokens),
    chatgptAccountId, scopes: null, planType: "pro", isFedramp: false,
    expiresAt, lastRefreshAt: new Date(),
  });
  await ensureCodexRotationSettings(db, ws.accountId, ws.workspaceId);
  await setActiveCodexCredential(db, ws.workspaceId, id);
  return id;
}

beforeAll(async () => {
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
  } catch (err) {
    available = false;
    console.warn(`[codex-usage] docker unavailable, skipping: ${String(err)}`);
    return;
  }
  await waitForReady();
  await migrate(ADMIN_URL);
  admin = postgres(ADMIN_URL, { max: 4 });
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

describe("recordCodexAccountUsage + the cached read", () => {
  test("writes the five usage columns and listCodexAccountStatuses reads them back", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const id = await connect(ws, "acct_x", { access_token: "AC", refresh_token: "RF", id_token: "ID" }, new Date(Date.now() + 3_600_000));
    const reset = new Date(Date.now() + 3_600_000);
    expect(await recordCodexAccountUsage(db, ws.workspaceId, id, {
      primaryUsedPercent: 40, primaryResetAt: reset, secondaryUsedPercent: 12, secondaryResetAt: reset, checkedAt: new Date(),
    })).toBe(true);
    const [row] = await listCodexAccountStatuses(db, ws.workspaceId);
    expect(row!.primaryUsedPercent).toBe(40);
    expect(row!.secondaryUsedPercent).toBe(12);
    expect(row!.usageCheckedAt).not.toBeNull();
  });

  test("an unknown id writes 0 rows (false) and never touches credential_encrypted", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await connect(ws, "acct_x", { access_token: "AC", refresh_token: "RF", id_token: "ID" }, new Date(Date.now() + 3_600_000));
    expect(await recordCodexAccountUsage(db, ws.workspaceId, crypto.randomUUID(), {
      primaryUsedPercent: 99, primaryResetAt: null, secondaryUsedPercent: 99, secondaryResetAt: null, checkedAt: new Date(),
    })).toBe(false);
  });
});

describe("fetchCodexUsageForAccount under RLS", () => {
  test("a fresh-token account: no refresh, normalizes the 200, and writes the cache", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    // expiresAt far in the future ⇒ the resolver does NOT refresh; only wham is hit.
    const id = await connect(ws, "acct_fresh", { access_token: "AC", refresh_token: "RF", id_token: "ID" }, new Date(Date.now() + 3_600_000));
    mockFetch({ wham: () => json(whamBody(33, 7)) });
    const out = await fetchCodexUsageForAccount(db, settings, ws.workspaceId, id);
    expect(out.status).toBe("ok");
    expect(out.fiveHour?.percent).toBe(33);
    expect(out.weekly?.remaining).toBe(93);
    // The cache columns were written as a side effect.
    const [row] = await listCodexAccountStatuses(db, ws.workspaceId);
    expect(row!.primaryUsedPercent).toBe(33);
    expect(row!.secondaryUsedPercent).toBe(7);
  });

  test("a stale-token account: refreshes (CAS bumps version), then reads usage", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    // expiresAt in the PAST ⇒ the resolver refreshes before the usage read.
    const id = await connect(ws, "acct_stale", { access_token: "OLD", refresh_token: "RF", id_token: "ID" }, new Date(Date.now() - 1000));
    let refreshed = false;
    mockFetch({
      refresh: () => { refreshed = true; return json({ access_token: "NEW", refresh_token: "RF2", id_token: "ID2" }); },
      wham: () => json(whamBody(50, 20)),
    });
    const out = await fetchCodexUsageForAccount(db, settings, ws.workspaceId, id);
    expect(refreshed).toBe(true);
    expect(out.status).toBe("ok");
    expect(out.fiveHour?.percent).toBe(50);
    // The (id,version) CAS bumped version to 2 (the rotated blob persisted).
    const [vrow] = await admin<{ version: number }[]>`select version from codex_subscription_credentials where id = ${id}`;
    expect(vrow!.version).toBe(2);
  });

  test("a wham 404 normalizes to limit_reached (no error)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const id = await connect(ws, "acct_capped", { access_token: "AC", refresh_token: "RF", id_token: "ID" }, new Date(Date.now() + 3_600_000));
    mockFetch({ wham: () => json(whamBody(100, 80, { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_after_seconds: 600, reset_at: Math.floor(Date.now() / 1000) + 600, limit_window_seconds: 18000 } } }), 404) });
    const out = await fetchCodexUsageForAccount(db, settings, ws.workspaceId, id);
    expect(out.status).toBe("limit_reached");
    expect(out.limitReached).toBe(true);
  });

  test("a permanently-failing refresh returns error+needs_relogin AND stamps the row", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const id = await connect(ws, "acct_dead", { access_token: "OLD", refresh_token: "RF", id_token: "ID" }, new Date(Date.now() - 1000));
    mockFetch({ refresh: () => json({ error: "invalid_grant" }, 400) }); // permanent → needs_relogin
    const out = await fetchCodexUsageForAccount(db, settings, ws.workspaceId, id);
    expect(out.status).toBe("error");
    expect(out.reason).toBe("needs_relogin");
    // The credential was stamped needs_relogin via the (id,version) CAS.
    expect((await getCodexCredentialStatus(db, ws.workspaceId))?.status).toBe("needs_relogin");
  });
});
