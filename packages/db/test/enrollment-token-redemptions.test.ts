import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  EnrollTokenAlreadyRedeemedError,
  finalizeEnrollmentByToken,
  listEnrollments,
  listSandboxes,
  withRlsContext,
  type Database,
  type DbClient,
} from "../src/index";
import { sql } from "drizzle-orm";

// 0696: a Connected Machine enroll token with a `jti` connects exactly one
// machine. The same machine may repeat the exchange; another machine is refused
// without writing anything. Runs as opengeni_app so FORCE RLS applies.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

function machine(
  ws: { accountId: string; workspaceId: string },
  pubkey: string,
  token: { id: string; expiresAt: Date } | null,
) {
  return {
    ...ws,
    pubkey,
    hasDisplay: false,
    allowScreenControl: false,
    os: "linux" as const,
    arch: "x86_64",
    sandboxName: pubkey,
    ...(token ? { tokenId: token.id, tokenExpiresAt: token.expiresAt } : {}),
  };
}

function newToken() {
  return {
    id: crypto.randomUUID().replaceAll("-", ""),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("enrollment-token-redemptions");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[enrollment-token-redemptions] postgres unavailable, skipping");
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

describe("single-use enroll tokens", () => {
  test("a token connects one machine; the same machine may retry", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const token = newToken();
    const first = await finalizeEnrollmentByToken(db, machine(ws, "ed25519:first", token));
    const retry = await finalizeEnrollmentByToken(db, machine(ws, "ed25519:first", token));
    expect(retry.enrollment.id).toBe(first.enrollment.id);
    expect(retry.sandbox.id).toBe(first.sandbox.id);

    await expect(
      finalizeEnrollmentByToken(db, machine(ws, "ed25519:second", token)),
    ).rejects.toBeInstanceOf(EnrollTokenAlreadyRedeemedError);

    const grant = ws.workspaceId;
    expect((await listEnrollments(db, grant)).map((e) => e.pubkey)).toEqual(["ed25519:first"]);
    expect((await listSandboxes(db, grant)).filter((s) => s.kind === "selfhosted")).toHaveLength(1);
    const [row] = await admin<{ enrollment_id: string | null; pubkey: string }[]>`
      select enrollment_id, pubkey from enrollment_token_redemptions where token_id = ${token.id}`;
    expect(row).toEqual({ enrollment_id: first.enrollment.id, pubkey: "ed25519:first" });
  });

  test("a removed machine cannot reuse the token that connected it", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const token = newToken();
    const first = await finalizeEnrollmentByToken(db, machine(ws, "ed25519:gone", token));
    await admin`
      update enrollments set status = 'revoked', revoked_at = now()
      where id = ${first.enrollment.id}`;
    await expect(
      finalizeEnrollmentByToken(db, machine(ws, "ed25519:gone", token)),
    ).rejects.toBeInstanceOf(EnrollTokenAlreadyRedeemedError);
    const [row] = await admin<{ status: string }[]>`
      select status from enrollments where id = ${first.enrollment.id}`;
    expect(row?.status).toBe("revoked");
  });

  test("two machines racing for one token: exactly one connects", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const token = newToken();
    const results = await Promise.allSettled(
      ["ed25519:a", "ed25519:b", "ed25519:c"].map((pubkey) =>
        finalizeEnrollmentByToken(db, machine(ws, pubkey, token)),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const rejected of results.filter((r) => r.status === "rejected")) {
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
        EnrollTokenAlreadyRedeemedError,
      );
    }
    const grant = ws.workspaceId;
    expect(await listEnrollments(db, grant)).toHaveLength(1);
  });

  test("each token is independent, and legacy tokens without an id stay multi-use", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await finalizeEnrollmentByToken(db, machine(ws, "ed25519:one", newToken()));
    await finalizeEnrollmentByToken(db, machine(ws, "ed25519:two", newToken()));
    await finalizeEnrollmentByToken(db, machine(ws, "ed25519:legacy-1", null));
    await finalizeEnrollmentByToken(db, machine(ws, "ed25519:legacy-2", null));
    const grant = ws.workspaceId;
    expect(await listEnrollments(db, grant)).toHaveLength(4);
  });

  test("a redemption from another workspace is invisible and long-expired rows are pruned", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const stale = crypto.randomUUID().replaceAll("-", "");
    await admin`
      insert into enrollment_token_redemptions
        (token_id, account_id, workspace_id, pubkey, expires_at)
      values (${stale}, ${ws.accountId}, ${ws.workspaceId}, 'ed25519:old', now() - interval '2 days')`;
    await finalizeEnrollmentByToken(db, machine(ws, "ed25519:new", newToken()));
    const remaining = await admin<{ token_id: string }[]>`
      select token_id from enrollment_token_redemptions where workspace_id = ${ws.workspaceId}`;
    expect(remaining.map((r) => r.token_id)).not.toContain(stale);
    expect(remaining).toHaveLength(1);

    const other = await freshWorkspace();
    const visible = await withRlsContext(
      db,
      { accountId: other.accountId, workspaceId: other.workspaceId },
      async (scoped) =>
        await scoped.execute(sql`select token_id from enrollment_token_redemptions`),
    );
    expect([...(visible as unknown as unknown[])]).toHaveLength(0);
  });
});
