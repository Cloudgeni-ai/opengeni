// Migration 0778: published Sites. Nine workspace-owned FORCE RLS tables; the
// only cross-tenant read is the hostname lane, which shows exactly the row
// whose label the transaction names. Labels are globally unique and a
// released label is held for its workspace.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  admitSiteRuntimeConversationTurn,
  checkSiteHostnameClaim,
  consumeSiteAuthCode,
  consumeSiteRuntimeRate,
  countSiteRuntimeConversationStart,
  createDb,
  createPostgresSiteDataStore,
  createSession,
  createSiteAuthCode,
  createSiteViewerSession,
  createWorkspace,
  createWorkspaceArtifact,
  findSiteHostname,
  findSiteViewerSession,
  insertSiteRuntimeConversation,
  getOwnedSiteRuntimeConversation,
  readSiteRuntimeUsage,
  restoreSitePublication,
  revokeSiteViewerSession,
  settleSiteRuntimeConversationSpend,
  SiteDataError,
  SitePublishingError,
  suspendSitePublication,
  upsertSitePublication,
  withRlsContext,
  type DbClient,
  type SiteDataCaller,
  type SiteDataLimits,
} from "../src/index";
import { rawRows } from "../src/database";

const TABLES = [
  "site_abuse_reports",
  "site_auth_codes",
  "site_hostnames",
  "site_limit_profiles",
  "site_publications",
  "site_runtime_conversations",
  "site_runtime_rate_windows",
  "site_runtime_usage",
  "site_viewer_sessions",
];

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0778-published-sites");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function workspace() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Published sites') returning id`;
  const accountId = String(account!.id);
  const workspaceId = (await createWorkspace(client.db, { accountId, name: "Sites" })).id;
  return { accountId, workspaceId };
}

async function site(scope: { accountId: string; workspaceId: string }) {
  const created = await createWorkspaceArtifact(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    artifactId: crypto.randomUUID(),
    slug: `published-${crypto.randomUUID().slice(0, 8)}`,
    title: "Team dashboard",
    description: null,
    visibility: "workspace_shared",
    ownerSubjectId: null,
    contentKey: `sites/${crypto.randomUUID()}.html`,
    contentSha256: "a".repeat(64),
    sizeBytes: 16,
    sourceKey: null,
    sourceSha256: null,
    sourceSizeBytes: null,
    operationKey: crypto.randomUUID(),
    actorSubjectId: "user:owner",
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    sourceToolName: null,
    persistContent: async () => undefined,
    discardContent: async () => undefined,
  });
  return created.artifact.id;
}

const label = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

async function publish(
  scope: { accountId: string; workspaceId: string },
  siteId: string,
  name: string,
) {
  return await upsertSitePublication(client.db, scope, {
    siteId,
    defaultLabel: name,
    changes: { label: name },
    actor: "user:owner",
    holdDays: 30,
    defaults: { access: "members", noindex: true },
  });
}

test("published Sites tables are FORCE RLS with a workspace policy and runtime DML", async () => {
  const rows = await shared.admin<
    Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
  >`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c where c.relname = any(${TABLES}) and c.relkind = 'r' order by c.relname`;
  expect(rows.map((row) => row.relname)).toEqual(TABLES);
  for (const row of rows) {
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  }
  const policies = await shared.admin<Array<{ tablename: string; policyname: string }>>`
    select tablename, policyname from pg_policies where tablename = any(${TABLES})
    order by tablename, policyname`;
  expect(policies.filter((row) => row.policyname === "workspace_isolation")).toHaveLength(9);
  expect(
    policies.filter((row) => row.tablename === "site_hostnames").map((row) => row.policyname),
  ).toEqual([
    "site_hostnames_label_lookup",
    "site_hostnames_label_takeover",
    "workspace_isolation",
  ]);
  const [column] = await shared.admin<Array<{ column_default: string }>>`
    select column_default from information_schema.columns
    where table_name = 'site_data_collections' and column_name = 'guest_access'`;
  expect(column!.column_default).toContain("none");
});

test("the hostname lane shows only the named label, never other rows or tables", async () => {
  const a = await workspace();
  const b = await workspace();
  const siteA = await site(a);
  const siteB = await site(b);
  const nameA = label("alpha");
  const nameB = label("bravo");
  await publish(a, siteA, nameA);
  await publish(b, siteB, nameB);
  // Without any tenant context: only the named row.
  const found = await findSiteHostname(client.db, nameA);
  expect(found).toMatchObject({ label: nameA, workspaceId: a.workspaceId, siteId: siteA });
  expect(await findSiteHostname(client.db, label("missing"))).toBeNull();
  const visible = await client.db.transaction(async (raw) => {
    const tx = raw as unknown as typeof client.db;
    await tx.execute(sql`select set_config('opengeni.site_hostname_label', ${nameA}, true)`);
    return {
      hostnames: await rawRows<{ label: string }>(tx, sql`select label from site_hostnames`),
      publications: await rawRows<{ label: string }>(tx, sql`select label from site_publications`),
    };
  });
  expect(visible.hostnames.map((row) => row.label)).toEqual([nameA]);
  expect(visible.publications).toEqual([]);
  // Inside workspace B's context, A's publication stays invisible; the lane
  // cannot update a row it can see.
  const crossTenant = await withRlsContext(client.db, b, async (tx) => {
    await tx.execute(sql`select set_config('opengeni.site_hostname_label', ${nameA}, true)`);
    const updated = await rawRows<{ label: string }>(
      tx,
      sql`update site_hostnames set released_at = now() where label = ${nameA} returning label`,
    );
    const publications = await rawRows<{ label: string }>(
      tx,
      sql`select label from site_publications where label = ${nameA}`,
    );
    const deleted = await rawRows<{ label: string }>(
      tx,
      sql`delete from site_hostnames where label = ${nameA} returning label`,
    );
    return { updated, publications, deleted };
  });
  expect(crossTenant).toEqual({ updated: [], publications: [], deleted: [] });
});

test("labels are globally unique and a released label is held for its workspace", async () => {
  const a = await workspace();
  const b = await workspace();
  const siteA = await site(a);
  const siteA2 = await site(a);
  const siteB = await site(b);
  const first = label("shared");
  await publish(a, siteA, first);
  // Another workspace: taken.
  const taken = await publish(b, siteB, first).catch((error: unknown) => error);
  expect(taken).toBeInstanceOf(SitePublishingError);
  expect((taken as SitePublishingError).code).toBe("taken");
  // Another Site of the same workspace: taken while live.
  expect(
    ((await publish(a, siteA2, first).catch((error: unknown) => error)) as SitePublishingError)
      .code,
  ).toBe("taken");
  // A renames: the old label is held.
  const second = label("renamed");
  const renamed = await publish(a, siteA, second);
  expect(renamed.previousLabel).toBe(first);
  expect(renamed.publication.label).toBe(second);
  expect(renamed.publication.generation).toBe(2);
  expect(await checkSiteHostnameClaim(client.db, b, first, siteB, 30)).toEqual({
    available: false,
    problem: "held",
  });
  const held = await publish(b, siteB, first).catch((error: unknown) => error);
  expect((held as SitePublishingError).code).toBe("held");
  // The same workspace may take its held label for another Site.
  expect(await checkSiteHostnameClaim(client.db, a, first, siteA2, 30)).toEqual({
    available: true,
  });
  const reclaimed = await publish(a, siteA2, first);
  expect(reclaimed.publication.label).toBe(first);
  // Release again and age the hold past 30 days: another workspace takes it.
  await publish(a, siteA2, label("again"));
  await shared.admin`update site_hostnames set released_at = now() - interval '31 days' where label = ${first}`;
  const takeover = await publish(b, siteB, first);
  expect(takeover.publication.label).toBe(first);
  expect(await findSiteHostname(client.db, first)).toMatchObject({
    workspaceId: b.workspaceId,
    siteId: siteB,
    releasedAt: null,
  });
  // A configured hold longer than 30 days is honoured.
  const third = label("long");
  const siteB2 = await site(b);
  await publish(b, siteB2, third);
  await publish(b, siteB2, label("moved"));
  await shared.admin`update site_hostnames set released_at = now() - interval '40 days' where label = ${third}`;
  expect(await checkSiteHostnameClaim(client.db, a, third, siteA, 60)).toEqual({
    available: false,
    problem: "held",
  });
  expect(await checkSiteHostnameClaim(client.db, a, third, siteA, 30)).toEqual({
    available: true,
  });
});

test("suspension holds until restore and only the platform lifts its own", async () => {
  const a = await workspace();
  const siteId = await site(a);
  await publish(a, siteId, label("takedown"));
  const suspended = await suspendSitePublication(client.db, a, siteId, {
    by: "platform",
    reason: "phishing",
    subject: "platform:moderator",
  });
  expect(suspended.status).toBe("suspended");
  // An owner's takedown never replaces the platform's.
  const again = await suspendSitePublication(client.db, a, siteId, {
    by: "owner",
    reason: "mine",
    subject: "user:owner",
  });
  expect(again.suspendedBy).toBe("platform");
  const reactivate = await upsertSitePublication(client.db, a, {
    siteId,
    defaultLabel: "unused",
    changes: { status: "active" },
    actor: "user:owner",
    holdDays: 30,
    defaults: { access: "members", noindex: true },
  }).catch((error: unknown) => error);
  expect((reactivate as SitePublishingError).code).toBe("forbidden");
  const ownerRestore = await restoreSitePublication(client.db, a, siteId, {
    by: "owner",
    subject: "user:owner",
  }).catch((error: unknown) => error);
  expect((ownerRestore as SitePublishingError).code).toBe("forbidden");
  const restored = await restoreSitePublication(client.db, a, siteId, {
    by: "platform",
    subject: "platform:moderator",
  });
  expect(restored).toMatchObject({ status: "active", suspendedAt: null, suspendedBy: null });
  expect(restored.generation).toBeGreaterThan(suspended.generation);
});

test("sign-in codes are single use, short lived and bound to their Site and host", async () => {
  const a = await workspace();
  const siteId = await site(a);
  const other = await site(a);
  const hash = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
  const base = {
    siteId,
    hostname: "team.sites.test",
    codeChallenge: "A".repeat(43),
    redirectUri: "https://team.sites.test/_og/auth/callback",
    subjectId: "user:viewer",
    kind: "member" as const,
    email: null,
    displayName: null,
    ttlSeconds: 60,
  };
  const code = hash();
  await createSiteAuthCode(client.db, a, { ...base, codeHash: code });
  expect(
    await consumeSiteAuthCode(client.db, a, {
      siteId,
      codeHash: code,
      hostname: "evil.sites.test",
    }),
  ).toBeNull();
  // A code presented with the wrong host is spent.
  expect(
    await consumeSiteAuthCode(client.db, a, { siteId, codeHash: code, hostname: base.hostname }),
  ).toBeNull();
  const fresh = hash();
  await createSiteAuthCode(client.db, a, { ...base, codeHash: fresh });
  expect(
    await consumeSiteAuthCode(client.db, a, {
      siteId: other,
      codeHash: fresh,
      hostname: base.hostname,
    }),
  ).toBeNull();
  const good = hash();
  await createSiteAuthCode(client.db, a, { ...base, codeHash: good });
  expect(
    await consumeSiteAuthCode(client.db, a, { siteId, codeHash: good, hostname: base.hostname }),
  ).toMatchObject({ subjectId: "user:viewer", codeChallenge: base.codeChallenge });
  expect(
    await consumeSiteAuthCode(client.db, a, { siteId, codeHash: good, hostname: base.hostname }),
  ).toBeNull();
  const expired = hash();
  await createSiteAuthCode(client.db, a, { ...base, codeHash: expired, ttlSeconds: 0 });
  expect(
    await consumeSiteAuthCode(client.db, a, { siteId, codeHash: expired, hostname: base.hostname }),
  ).toBeNull();
  // Another workspace cannot see or spend the code.
  const b = await workspace();
  const foreign = hash();
  await createSiteAuthCode(client.db, a, { ...base, codeHash: foreign });
  expect(
    await consumeSiteAuthCode(client.db, b, { siteId, codeHash: foreign, hostname: base.hostname }),
  ).toBeNull();
  expect(
    await consumeSiteAuthCode(client.db, a, { siteId, codeHash: foreign, hostname: base.hostname }),
  ).not.toBeNull();
});

test("viewer sessions expire when idle or past their absolute lifetime and can be revoked", async () => {
  const a = await workspace();
  const siteId = await site(a);
  const identity = {
    subjectId: "user:viewer",
    kind: "member" as const,
    email: null,
    displayName: null,
  };
  const token = "b".repeat(64);
  await createSiteViewerSession(client.db, a, {
    ...identity,
    siteId,
    tokenHash: token,
    absoluteSeconds: 3600,
  });
  expect(
    await findSiteViewerSession(client.db, a, { siteId, tokenHash: token, idleSeconds: 600 }),
  ).toMatchObject({ subjectId: "user:viewer" });
  // Another Site of the same workspace: not valid.
  const other = await site(a);
  expect(
    await findSiteViewerSession(client.db, a, {
      siteId: other,
      tokenHash: token,
      idleSeconds: 600,
    }),
  ).toBeNull();
  await shared.admin`update site_viewer_sessions set last_used_at = now() - interval '20 minutes' where token_hash = ${token}`;
  expect(
    await findSiteViewerSession(client.db, a, { siteId, tokenHash: token, idleSeconds: 600 }),
  ).toBeNull();
  const absolute = "c".repeat(64);
  await createSiteViewerSession(client.db, a, {
    ...identity,
    siteId,
    tokenHash: absolute,
    absoluteSeconds: 0,
  });
  expect(
    await findSiteViewerSession(client.db, a, { siteId, tokenHash: absolute, idleSeconds: 600 }),
  ).toBeNull();
  const revoked = "d".repeat(64);
  await createSiteViewerSession(client.db, a, {
    ...identity,
    siteId,
    tokenHash: revoked,
    absoluteSeconds: 3600,
  });
  expect(await revokeSiteViewerSession(client.db, a, { siteId, tokenHash: revoked })).toBe(true);
  expect(
    await findSiteViewerSession(client.db, a, { siteId, tokenHash: revoked, idleSeconds: 600 }),
  ).toBeNull();
});

test("conversations belong to their Site and viewer; spend is counted once", async () => {
  const a = await workspace();
  const siteId = await site(a);
  const session = await createSession(client.db, {
    ...a,
    initialMessage: "Hello",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: "user:owner" },
    createdByContext: {},
  });
  await insertSiteRuntimeConversation(client.db, a, {
    sessionId: session.id,
    siteId,
    viewerPrincipal: "guest:v1",
    versionId: null,
  });
  expect(
    await getOwnedSiteRuntimeConversation(client.db, a, {
      sessionId: session.id,
      siteId,
      viewerPrincipal: "guest:v2",
    }),
  ).toBeNull();
  expect(
    await getOwnedSiteRuntimeConversation(client.db, a, {
      sessionId: session.id,
      siteId: await site(a),
      viewerPrincipal: "guest:v1",
    }),
  ).toBeNull();
  expect(
    await getOwnedSiteRuntimeConversation(client.db, a, {
      sessionId: session.id,
      siteId,
      viewerPrincipal: "guest:v1",
    }),
  ).toMatchObject({ turns: 0, meteredMicros: 0 });
  expect(
    await admitSiteRuntimeConversationTurn(client.db, a, { sessionId: session.id, maxTurns: 2 }),
  ).toBe(true);
  expect(
    await admitSiteRuntimeConversationTurn(client.db, a, { sessionId: session.id, maxTurns: 2 }),
  ).toBe(true);
  expect(
    await admitSiteRuntimeConversationTurn(client.db, a, { sessionId: session.id, maxTurns: 2 }),
  ).toBe(false);
  await countSiteRuntimeConversationStart(client.db, a, { siteId, viewerPrincipal: "guest:v1" });
  expect(
    await settleSiteRuntimeConversationSpend(client.db, a, {
      sessionId: session.id,
      usedMicros: 700,
    }),
  ).toBe(700);
  expect(
    await settleSiteRuntimeConversationSpend(client.db, a, {
      sessionId: session.id,
      usedMicros: 700,
    }),
  ).toBe(0);
  expect(
    await settleSiteRuntimeConversationSpend(client.db, a, {
      sessionId: session.id,
      usedMicros: 500,
    }),
  ).toBe(0);
  expect(
    await settleSiteRuntimeConversationSpend(client.db, a, {
      sessionId: session.id,
      usedMicros: 1000,
    }),
  ).toBe(300);
  const usage = await readSiteRuntimeUsage(client.db, a, { siteId, viewerPrincipal: "guest:v1" });
  expect(usage).toEqual({
    visitorDay: { conversations: 1, agentMicros: 1000 },
    siteDay: { conversations: 1, agentMicros: 1000 },
    siteMonth: { conversations: 1, agentMicros: 1000 },
  });
  // A new day starts the visitor's counters over; the month keeps counting.
  const tomorrow = new Date(Date.now() + 86_400_000);
  await countSiteRuntimeConversationStart(client.db, a, {
    siteId,
    viewerPrincipal: "guest:v1",
    now: tomorrow,
  });
  const next = await readSiteRuntimeUsage(client.db, a, {
    siteId,
    viewerPrincipal: "guest:v1",
    now: tomorrow,
  });
  expect(next.visitorDay).toEqual({ conversations: 1, agentMicros: 0 });
});

test("rate windows count per principal and bucket and reset each minute", async () => {
  const a = await workspace();
  const siteId = await site(a);
  const now = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 1_000);
  const take = (principal: string, at = now) =>
    consumeSiteRuntimeRate(client.db, a, {
      siteId,
      principal,
      bucket: "requests",
      limit: 2,
      now: at,
    });
  expect((await take("guest:a")).allowed).toBe(true);
  expect((await take("guest:a")).allowed).toBe(true);
  const refused = await take("guest:a");
  expect(refused.allowed).toBe(false);
  expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  expect((await take("guest:b")).allowed).toBe(true);
  expect((await take("guest:a", new Date(now.getTime() + 60_000))).allowed).toBe(true);
});

test("Site Data guest rules: none hides, read reads, append adds, own changes only own", async () => {
  const a = await workspace();
  const siteId = await site(a);
  const store = createPostgresSiteDataStore(client.db);
  const limits: SiteDataLimits = {
    recordBytesPerSite: 1_000_000,
    maxRecordBytes: 10_000,
    maxCollectionsPerSite: 10,
    fileBytesPerSite: 1_000_000,
    maxFileBytes: 100_000,
    workspaceBytes: 10_000_000,
    maxRecordsPerCollection: 1_000,
    viewerWritesPerMinute: 1_000,
    siteWritesPerMinute: 1_000,
    viewerReadsPerMinute: 1_000,
    managerWritesPerMinute: 1_000,
    siteValidationMsPerMinute: 5_000,
    workspaceValidationMsPerMinute: 20_000,
  };
  const manager: SiteDataCaller = {
    ...a,
    siteId,
    role: "manager",
    principal: "user:owner",
    actor: "user:owner",
    framed: false,
  };
  const guest = (id: string): SiteDataCaller => ({
    ...a,
    siteId,
    role: "viewer",
    principal: `guest:${id}`,
    actor: `guest:${id}`,
    framed: true,
    guest: true,
  });
  const define = (name: string, guestAccess?: "none" | "read" | "append" | "own") =>
    store.defineCollection(
      manager,
      { name, accessMode: "shared", ...(guestAccess ? { guestAccess } : {}) },
      limits,
    );
  const created = await define("closed");
  expect(created.collection.guestAccess).toBe("none");
  await define("readable", "read");
  await define("appendable", "append");
  await define("owned", "own");
  for (const name of ["closed", "readable", "appendable", "owned"])
    await store.write(
      manager,
      [{ op: "insert", collection: name, data: { by: "owner" } }] as never,
      { limits },
    );
  const code = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "ok";
    } catch (error) {
      return error instanceof SiteDataError ? error.code : String(error);
    }
  };
  const create = (who: SiteDataCaller, collection: string) =>
    store.write(who, [{ op: "insert", collection, data: { by: who.principal } }] as never, {
      limits,
    });
  // none: invisible.
  expect(await code(() => store.query(guest("g1"), { collection: "closed" }))).toBe("forbidden");
  expect(await code(() => create(guest("g1"), "closed"))).toBe("forbidden");
  // read: reads everything a viewer reads, never writes.
  expect((await store.query(guest("g1"), { collection: "readable" })).records).toHaveLength(1);
  expect(await code(() => create(guest("g1"), "readable"))).toBe("forbidden");
  // append: adds, reads only their own.
  await create(guest("g1"), "appendable");
  expect((await store.query(guest("g1"), { collection: "appendable" })).records).toHaveLength(1);
  expect((await store.query(guest("g2"), { collection: "appendable" })).records).toHaveLength(0);
  // own: changes only their own.
  const mine = await create(guest("g1"), "owned");
  const ownerRecord = (await store.query(manager, { collection: "owned" })).records.find(
    (record) => record.data.by === "owner",
  )!;
  const id = (mine as { results: Array<{ record?: { id: string } }> }).results[0]!.record!.id;
  expect(
    await code(() =>
      store.write(
        guest("g1"),
        [{ op: "patch", collection: "owned", id, data: { more: 1 } }] as never,
        { limits },
      ),
    ),
  ).toBe("ok");
  expect(
    await code(() =>
      store.write(
        guest("g2"),
        [{ op: "patch", collection: "owned", id, data: { more: 2 } }] as never,
        { limits },
      ),
    ),
  ).not.toBe("ok");
  expect(
    await code(() =>
      store.write(
        guest("g1"),
        [{ op: "delete", collection: "owned", id: ownerRecord.id }] as never,
        { limits },
      ),
    ),
  ).not.toBe("ok");
  // Files are never reachable by guests.
  expect(await code(() => store.listFiles(guest("g1"), {}))).toBe("forbidden");
  // Redefining without a guest rule keeps it.
  const kept = await store.defineCollection(
    manager,
    { name: "owned", accessMode: "shared" },
    limits,
  );
  expect(kept.collection.guestAccess).toBe("own");
  // postgres.js queries run on then(); wrap so the rejection is observed.
  await expect(
    (async () => {
      await shared.admin`update site_data_collections set guest_access = 'everyone' where name = 'owned'`;
    })(),
  ).rejects.toThrow();
});
