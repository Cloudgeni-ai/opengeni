import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createApiKey, createDb, findActiveApiKeyByHash, type DbClient } from "../src";

let shared: SharedTestDatabase;
let client: DbClient;
const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("api-key-read-churn");
  if (!acquired) throw new Error("PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  await shared.admin`insert into managed_accounts(id,name) values(${accountId},'Key reads')`;
  await shared.admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Key reads')`;
  // A test-only audit proves concurrent conditional updates, without depending
  // on asynchronous pg_stat_user_tables flushes or inspecting xmin.
  await shared.admin.unsafe(`
    create table api_key_touch_test (key_id uuid not null);
    create function record_api_key_touch_test() returns trigger language plpgsql
      security definer set search_path=pg_catalog,public as $$ begin
      if new.name='touch-fails' then raise exception 'synthetic telemetry failure'; end if;
      insert into api_key_touch_test values(new.id); return new; end $$;
    create trigger api_key_touch_test after update of last_used_at on api_keys
      for each row execute function record_api_key_touch_test();
  `);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function key() {
  const keyHash = crypto.randomUUID();
  const created = await createApiKey(client.db, {
    accountId,
    workspaceId,
    name: "Polling",
    prefix: "fixture",
    keyHash,
    permissions: ["sessions:read"],
  });
  return { ...created, keyHash };
}

async function touches(id: string) {
  const [row] =
    await shared.admin`select count(*)::integer as n from api_key_touch_test where key_id=${id}`;
  return row!.n;
}

test("repeated authentication reads live data without repeated last-use writes", async () => {
  const created = await key();
  const first = await findActiveApiKeyByHash(client.db, created.keyHash);
  expect(first?.lastUsedAt).not.toBeNull();
  for (let i = 0; i < 20; i++) {
    const next = await findActiveApiKeyByHash(client.db, created.keyHash);
    expect(next?.id).toBe(created.id);
    expect(next?.lastUsedAt).toBe(first?.lastUsedAt);
  }
  expect(await touches(created.id)).toBe(1);
  expect(first?.updatedAt).toBe(created.updatedAt);
  await shared.admin`update api_keys set permissions='["sessions:read","sessions:control"]'::jsonb where id=${created.id}`;
  expect((await findActiveApiKeyByHash(client.db, created.keyHash))?.permissions).toContain(
    "sessions:control",
  );
  expect(await touches(created.id)).toBe(1);
});

test("concurrent replicas coalesce a stale timestamp with a conditional update", async () => {
  const created = await key();
  const replicas = Array.from({ length: 4 }, () => createDb(shared.appUrl, { max: 2 }));
  try {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        findActiveApiKeyByHash(replicas[i % replicas.length]!.db, created.keyHash),
      ),
    );
    expect(results.every((result) => result?.id === created.id)).toBe(true);
    expect(await touches(created.id)).toBe(1);
    await shared.admin`update api_keys set last_used_at=now()-interval '2 minutes' where id=${created.id}`;
    const before = await touches(created.id);
    await Promise.all(
      replicas.map((replica) => findActiveApiKeyByHash(replica.db, created.keyHash)),
    );
    expect(await touches(created.id)).toBe(before + 1);
  } finally {
    await Promise.all(replicas.map((replica) => replica.close()));
  }
});

test("recent last-use telemetry never caches revoked or expired authorization", async () => {
  const revoked = await key();
  const expired = await key();
  expect(await findActiveApiKeyByHash(client.db, revoked.keyHash)).not.toBeNull();
  expect(await findActiveApiKeyByHash(client.db, expired.keyHash)).not.toBeNull();
  await shared.admin`update api_keys set revoked_at=now() where id=${revoked.id}`;
  await shared.admin`update api_keys set expires_at=now()-interval '1 second' where id=${expired.id}`;
  expect(await findActiveApiKeyByHash(client.db, revoked.keyHash)).toBeNull();
  expect(await findActiveApiKeyByHash(client.db, expired.keyHash)).toBeNull();
  expect(await findActiveApiKeyByHash(client.db, crypto.randomUUID())).toBeNull();
  expect(await touches(revoked.id)).toBe(1);
  expect(await touches(expired.id)).toBe(1);
});

test("a pending revocation skips telemetry and rejects authentication after commit", async () => {
  const created = await key();
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const edit = shared.admin.begin(async (tx) => {
    await tx`update api_keys set revoked_at=now() where id=${created.id}`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      findActiveApiKeyByHash(client.db, created.keyHash),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Authentication waited on telemetry row lock")),
          2000,
        );
      }),
    ]);
    expect(result?.id).toBe(created.id);
    expect(await touches(created.id)).toBe(0);
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await edit;
  }
  expect(await findActiveApiKeyByHash(client.db, created.keyHash)).toBeNull();
  expect(await touches(created.id)).toBe(0);
});

test("failed telemetry does not fail a live authentication", async () => {
  const created = await key();
  await shared.admin`update api_keys set name='touch-fails' where id=${created.id}`;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await findActiveApiKeyByHash(client.db, created.keyHash))?.id).toBe(created.id);
    expect(await touches(created.id)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});
