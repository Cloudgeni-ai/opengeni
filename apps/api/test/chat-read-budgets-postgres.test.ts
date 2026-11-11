import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { requireAccessGrant, requireFreshAccessGrant } from "@opengeni/core";
import { chatReadStack } from "./fixtures/chat-read-stack";

let fixture: Awaited<ReturnType<typeof chatReadStack>>;
beforeAll(async () => {
  fixture = await chatReadStack();
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 60_000);

// SQL statements include BEGIN/COMMIT, SET and SAVEPOINT. No elapsed-time
// assertions: CI scheduling and database distance are not query regressions.
const budgets: Record<string, { statements: number; transactions: number }> = {
  "config/client": { statements: 62, transactions: 12 },
  session: { statements: 70, transactions: 14 },
  "composer-draft": { statements: 25, transactions: 5 },
  "model-catalog": { statements: 54, transactions: 10 },
  "realtime-model-catalog": { statements: 37, transactions: 8 },
  events: { statements: 28, transactions: 6 },
  recordings: { statements: 20, transactions: 4 },
  queue: { statements: 34, transactions: 6 },
  "human-input-requests": { statements: 28, transactions: 6 },
  goal: { statements: 33, transactions: 6 },
  lineage: { statements: 55, transactions: 11 },
  "events/stream": { statements: 48, transactions: 10 },
};

async function read(path: string) {
  const controller = new AbortController();
  const response = await fixture.app.request(path, {
    headers: fixture.headers,
    signal: controller.signal,
  });
  expect(response.status).toBe(path.endsWith("/goal") ? 404 : 200);
  if (path.endsWith("/stream")) {
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel();
  } else await response.text();
}

test("every chat-open read stays inside its restricted-role SQL budget", async () => {
  // Warm driver type discovery, not an authorization/result cache.
  for (const path of Object.values(fixture.paths)) await read(path);
  for (const [endpoint, path] of Object.entries(fixture.paths)) {
    fixture.statements.length = 0;
    await read(path);
    const statements = [...fixture.statements];
    const budget = budgets[endpoint]!;
    expect({ endpoint, statements: statements.length }).toEqual({
      endpoint,
      statements: budget.statements,
    });
    expect(statements.filter((q) => /^begin\b/i.test(q.trim())).length).toBe(budget.transactions);
    expect(statements.some((q) => q.includes("ensure_external_identity("))).toBe(false);
    expect(statements.some((q) => /pg_advisory_xact_lock\(/.test(q))).toBe(false);
    if (endpoint !== "events/stream") {
      expect(statements.filter((q) => q.includes('from "workspace_memberships"')).length).toBe(1);
    }
  }
}, 30_000);

test("workspace admission is reused only within one read, with each permission still checked", async () => {
  const app = new Hono();
  app.get("/read", async (c) => {
    const first = await requireAccessGrant(c, fixture.deps, fixture.workspace.id, "sessions:read");
    const [second, third] = await Promise.all([
      requireAccessGrant(c, fixture.deps, fixture.workspace.id, "workspace:read"),
      requireAccessGrant(c, fixture.deps, fixture.workspace.id, "sessions:read"),
    ]);
    expect(first).toBe(second);
    expect(second).toBe(third);
    await expect(
      requireAccessGrant(c, fixture.deps, fixture.workspace.id, "secrets:read"),
    ).rejects.toThrow();
    await expect(
      requireAccessGrant(c, fixture.deps, crypto.randomUUID(), "sessions:read"),
    ).rejects.toThrow();
    return c.json({ ok: true });
  });
  const counts: number[] = [];
  for (let i = 0; i < 2; i++) {
    fixture.statements.length = 0;
    expect((await app.request("/read", { headers: fixture.headers })).status).toBe(200);
    counts.push(
      fixture.statements.filter((q) => q.includes('from "workspace_memberships"')).length,
    );
  }
  expect(counts).toEqual([1, 1]);
});

test("writers and explicit refreshes still resolve current authority", async () => {
  const app = new Hono();
  app.post("/write", async (c) => {
    await requireAccessGrant(c, fixture.deps, fixture.workspace.id, "sessions:read");
    await requireAccessGrant(c, fixture.deps, fixture.workspace.id, "sessions:read");
    return c.json({ ok: true });
  });
  app.get("/fresh", async (c) => {
    await requireAccessGrant(c, fixture.deps, fixture.workspace.id, "sessions:read");
    await fixture.shared
      .admin`update external_identities set status = 'disabled' where id = ${fixture.identity.id}`;
    await expect(
      requireFreshAccessGrant(c, fixture.deps, fixture.workspace.id, "sessions:read"),
    ).rejects.toThrow();
    return c.json({ ok: true });
  });
  fixture.statements.length = 0;
  expect((await app.request("/write", { method: "POST", headers: fixture.headers })).status).toBe(
    200,
  );
  expect(fixture.statements.filter((q) => q.includes('from "workspace_memberships"')).length).toBe(
    2,
  );
  try {
    expect((await app.request("/fresh", { headers: fixture.headers })).status).toBe(200);
    expect(
      (await fixture.app.request(fixture.paths.events, { headers: fixture.headers })).status,
    ).toBe(403);
  } finally {
    await fixture.shared
      .admin`update external_identities set status = 'active' where id = ${fixture.identity.id}`;
  }
});

test("a denied first check cannot poison another permission in the same request", async () => {
  const app = new Hono();
  app.get("/read", async (c) => {
    const [denied, allowed] = await Promise.allSettled([
      requireAccessGrant(c, fixture.deps, fixture.workspace.id, "secrets:read"),
      requireAccessGrant(c, fixture.deps, fixture.workspace.id, "sessions:read"),
    ]);
    expect(denied.status).toBe("rejected");
    expect(allowed.status).toBe("fulfilled");
    return c.json({ ok: true });
  });
  expect((await app.request("/read", { headers: fixture.headers })).status).toBe(200);
});
