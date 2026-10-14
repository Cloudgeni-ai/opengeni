// Migration 0778: published Sites. Nine workspace-owned FORCE RLS tables plus
// the platform's hostname holds; the only cross-tenant read is the hostname
// lane, which shows exactly the rows whose label the transaction names.
// Labels are globally unique, a released label is held for its workspace, and
// a platform takedown holds its label for good.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  checkSiteHostnameClaim,
  consumeSiteAuthCode,
  consumeSiteRuntimeRate,
  createDb,
  createPostgresSiteDataStore,
  createSiteAuthCode,
  createSiteViewerSession,
  createWorkspace,
  createWorkspaceArtifact,
  findSiteHostname,
  findSiteHostnameState,
  findSitePublicationGlobally,
  findSiteViewerSession,
  getOwnedSiteRuntimeConversation,
  liftSiteHostnameHold,
  listReservedSiteRuntimeConversations,
  listSiteModerationQueue,
  readSiteRuntimeUsage,
  recordSitePublicationScan,
  releaseSiteRuntimeConversationStart,
  reserveSiteRuntimeConversationStart,
  reserveSiteRuntimeConversationWork,
  restoreSitePublication,
  revokeSiteViewerSession,
  revokeSiteViewerSessions,
  settleSiteRuntimeConversationSpend,
  createSiteAbuseReport,
  withSiteHostnameEdgeState,
  type SiteRuntimeBudgetLimits,
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
  "site_hostname_holds",
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
  // Holds outlive their workspace: no workspace policy, only the label lane.
  expect(
    policies.filter((row) => row.tablename === "site_hostname_holds").map((row) => row.policyname),
  ).toEqual(["site_hostname_holds_label_lane"]);
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
  const original = await publish(a, siteA, first);
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
  // Generations come from one sequence for every hostname: always increasing.
  expect(renamed.publication.generation).toBeGreaterThan(original.publication.generation);
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

test("a taken-down Site keeps its hostname and the platform holds it for good", async () => {
  const a = await workspace();
  const b = await workspace();
  const siteId = await site(a);
  const otherSite = await site(a);
  const siteB = await site(b);
  const name = label("held");
  await publish(a, siteId, name);
  await suspendSitePublication(client.db, a, siteId, {
    by: "platform",
    reason: "phishing",
    subject: "platform:moderator",
  });
  // No relabel while taken down: the same Site would come back under a new name.
  const moved = await publish(a, siteId, label("escape")).catch((error: unknown) => error);
  expect((moved as SitePublishingError).code).toBe("forbidden");
  expect((await findSiteHostnameState(client.db, name)).hold).toMatchObject({
    label: name,
    siteId,
    workspaceId: a.workspaceId,
  });
  // No workspace may claim the held label, the Site's own workspace included.
  expect(await checkSiteHostnameClaim(client.db, b, name, siteB, 30)).toEqual({
    available: false,
    problem: "reserved",
  });
  expect(await checkSiteHostnameClaim(client.db, a, name, otherSite, 30)).toEqual({
    available: false,
    problem: "reserved",
  });
  // The hold has no foreign keys: deleting the Site (or its workspace) keeps it.
  const holdKeys = await shared.admin<Array<{ conname: string }>>`
    select conname from pg_constraint
    where conrelid = 'site_hostname_holds'::regclass and contype = 'f'`;
  expect(holdKeys.length).toBe(0);
  await shared.admin`delete from site_publications where site_id = ${siteId}`;
  await shared.admin`delete from site_hostnames where site_id = ${siteId}`;
  expect((await findSiteHostnameState(client.db, name)).hostname).toBeNull();
  const claimed = await publish(b, siteB, name).catch((error: unknown) => error);
  expect((claimed as SitePublishingError).code).toBe("reserved");
  // Only the operator lifts it.
  expect(await liftSiteHostnameHold(client.db, name)).toBe(true);
  expect(await liftSiteHostnameHold(client.db, name)).toBe(false);
  expect((await publish(b, siteB, name)).publication.label).toBe(name);
});

test("only an admin restores an admin takedown; a platform restore lifts the hold", async () => {
  const a = await workspace();
  const siteId = await site(a);
  const name = label("admin");
  await publish(a, siteId, name);
  await suspendSitePublication(client.db, a, siteId, {
    by: "admin",
    reason: "policy",
    subject: "user:admin",
  });
  // An owner's later takedown does not replace the admin's.
  expect(
    (
      await suspendSitePublication(client.db, a, siteId, {
        by: "owner",
        reason: "mine",
        subject: "user:owner",
      })
    ).suspendedBy,
  ).toBe("admin");
  const ownerRestore = await restoreSitePublication(client.db, a, siteId, {
    by: "owner",
    subject: "user:owner",
  }).catch((error: unknown) => error);
  expect((ownerRestore as SitePublishingError).code).toBe("forbidden");
  expect(
    (await restoreSitePublication(client.db, a, siteId, { by: "admin", subject: "user:admin" }))
      .status,
  ).toBe("active");
  // Admin and owner takedowns hold nothing; a platform takedown holds until its restore.
  expect((await findSiteHostnameState(client.db, name)).hold).toBeNull();
  await suspendSitePublication(client.db, a, siteId, {
    by: "platform",
    reason: "malware",
    subject: "platform:moderator",
  });
  expect((await findSiteHostnameState(client.db, name)).hold).not.toBeNull();
  await restoreSitePublication(client.db, a, siteId, {
    by: "platform",
    subject: "platform:moderator",
  });
  expect((await findSiteHostnameState(client.db, name)).hold).toBeNull();
});

test("edge state is the live Site or a tombstone, with generations rising across hostnames", async () => {
  const a = await workspace();
  const siteId = await site(a);
  const first = label("edge");
  const published = await publish(a, siteId, first);
  const live = await withSiteHostnameEdgeState(client.db, first, async (state) => state);
  expect(live.live?.publication.siteId).toBe(siteId);
  expect(live.tombstoneGeneration).toBeNull();
  const moved = await publish(a, siteId, label("moved"));
  expect(moved.publication.generation).toBeGreaterThan(published.publication.generation);
  // The released label gets a tombstone newer than anything written for the Site so far.
  const old = await withSiteHostnameEdgeState(client.db, first, async (state) => state);
  expect(old.live).toBeNull();
  expect(old.hostname?.releasedAt).not.toBeNull();
  expect(old.tombstoneGeneration!).toBeGreaterThan(moved.publication.generation);
});

test("the moderation queue reads across workspaces only with the admin credential", async () => {
  const a = await workspace();
  const siteId = await site(a);
  const name = label("queue");
  await publish(a, siteId, name);
  await createSiteAbuseReport(client.db, a, {
    siteId,
    hostname: `${name}.sites.test`,
    category: "phishing",
    message: "fake login page",
    contactEmail: null,
    reporterPrincipal: "guest:reporter",
  });
  await recordSitePublicationScan(client.db, a, siteId, {
    versionId: crypto.randomUUID(),
    status: "flagged",
    findings: [{ url: "https://bad.example.test/" }],
  });
  // The application role cannot read across workspaces.
  await expect(listSiteModerationQueue(client.db, { limit: 10 })).rejects.toThrow();
  await expect(findSitePublicationGlobally(client.db, siteId)).rejects.toThrow();
  const admin = createDb(shared.adminUrl, { max: 1 });
  try {
    const items = (await listSiteModerationQueue(admin.db, { limit: 500 })).filter(
      (item) => item.siteId === siteId,
    );
    expect(items.map((item) => item.kind).sort()).toEqual(["flagged_scan", "report"]);
    expect(items.find((item) => item.kind === "report")).toMatchObject({
      label: name,
      detail: "phishing",
      message: "fake login page",
    });
    expect(await findSitePublicationGlobally(admin.db, siteId)).toEqual({
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      label: name,
    });
  } finally {
    await admin.close();
  }
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
  // A takedown or narrower access revokes every session of the Site at once.
  const live = "e".repeat(64);
  await createSiteViewerSession(client.db, a, {
    ...identity,
    siteId,
    tokenHash: live,
    absoluteSeconds: 3600,
  });
  expect(await revokeSiteViewerSessions(client.db, a, siteId)).toBeGreaterThan(0);
  expect(
    await findSiteViewerSession(client.db, a, { siteId, tokenHash: live, idleSeconds: 600 }),
  ).toBeNull();
});

test("conversation starts reserve their cap against every budget in one transaction", async () => {
  const a = await workspace();
  const siteId = await site(a);
  const limits: SiteRuntimeBudgetLimits = {
    conversationsPerVisitorPerDay: 3,
    conversationsPerSitePerDay: 10,
    turnsPerConversation: 2,
    agentMicrosPerConversation: 4_000,
    agentMicrosPerVisitorPerDay: 100_000,
    agentMicrosPerSitePerMonth: 10_000,
  };
  const start = async (viewer: string, budgets = limits) => {
    const sessionId = crypto.randomUUID();
    const result = await reserveSiteRuntimeConversationStart(client.db, a, {
      sessionId,
      siteId,
      viewerPrincipal: viewer,
      versionId: null,
      limits: budgets,
    });
    return { ...result, sessionId };
  };
  const first = await start("guest:v1");
  expect(first).toMatchObject({ ok: true, limitMicros: 4_000, reservedMicros: 4_000 });
  // Owned by its Site and viewer only.
  expect(
    await getOwnedSiteRuntimeConversation(client.db, a, {
      sessionId: first.sessionId,
      siteId,
      viewerPrincipal: "guest:v2",
    }),
  ).toBeNull();
  expect(
    await getOwnedSiteRuntimeConversation(client.db, a, {
      sessionId: first.sessionId,
      siteId: await site(a),
      viewerPrincipal: "guest:v1",
    }),
  ).toBeNull();
  expect(
    await getOwnedSiteRuntimeConversation(client.db, a, {
      sessionId: first.sessionId,
      siteId,
      viewerPrincipal: "guest:v1",
    }),
  ).toMatchObject({ turns: 1, meteredMicros: 0, limitMicros: 4_000, reservedMicros: 4_000 });
  // Rotating visitors does not escape the Site's month: the third start gets
  // only what is left, and the fourth is refused.
  expect(await start("guest:v2")).toMatchObject({ ok: true, limitMicros: 4_000 });
  const third = await start("guest:v3");
  expect(third).toMatchObject({ ok: true, limitMicros: 2_000, reservedMicros: 2_000 });
  expect(await start("guest:v4")).toMatchObject({
    ok: false,
    budget: "agent_micros_per_site_per_month",
  });
  expect(
    (await readSiteRuntimeUsage(client.db, a, { siteId, viewerPrincipal: "guest:v1" })).siteMonth,
  ).toEqual({ conversations: 3, agentMicros: 0, reservedMicros: 10_000 });
  // A start whose session was never created is undone entirely.
  await releaseSiteRuntimeConversationStart(client.db, a, { sessionId: third.sessionId });
  expect(
    (await readSiteRuntimeUsage(client.db, a, { siteId, viewerPrincipal: "guest:v3" })).siteMonth,
  ).toEqual({ conversations: 2, agentMicros: 0, reservedMicros: 8_000 });
  // Spend is counted once and never goes down; an idle session releases the rest.
  const settle = (usedMicros: number, idle = false) =>
    settleSiteRuntimeConversationSpend(client.db, a, {
      sessionId: first.sessionId,
      usedMicros,
      idle,
    });
  expect(await settle(700)).toBe(700);
  expect(await settle(700)).toBe(0);
  expect(await settle(500)).toBe(0);
  expect(await settle(700, true)).toBe(0);
  expect(
    (await readSiteRuntimeUsage(client.db, a, { siteId, viewerPrincipal: "guest:v1" })).visitorDay,
  ).toEqual({ conversations: 1, agentMicros: 700, reservedMicros: 0 });
  // A new message tops the reservation back up to cap minus spend, under the turn cap.
  expect(
    await reserveSiteRuntimeConversationWork(client.db, a, {
      sessionId: first.sessionId,
      limits,
      newTurn: true,
    }),
  ).toMatchObject({ ok: true, reservedMicros: 3_300 });
  expect(
    await reserveSiteRuntimeConversationWork(client.db, a, {
      sessionId: first.sessionId,
      limits,
      newTurn: true,
    }),
  ).toEqual({ ok: false, budget: "turns_per_conversation" });
  expect(
    (await listReservedSiteRuntimeConversations(client.db, a, { siteId, limit: 10 })).length,
  ).toBe(2);
  // Daily starts, per visitor and per Site.
  expect(await start("guest:v1", { ...limits, conversationsPerVisitorPerDay: 1 })).toEqual(
    expect.objectContaining({ ok: false, budget: "conversations_per_visitor_per_day" }),
  );
  expect(await start("guest:v9", { ...limits, conversationsPerSitePerDay: 2 })).toEqual(
    expect.objectContaining({ ok: false, budget: "conversations_per_site_per_day" }),
  );
  // A new day starts the visitor's counters over.
  const tomorrow = new Date(Date.now() + 86_400_000);
  expect(
    (
      await readSiteRuntimeUsage(client.db, a, {
        siteId,
        viewerPrincipal: "guest:v1",
        now: tomorrow,
      })
    ).visitorDay,
  ).toEqual({ conversations: 0, agentMicros: 0, reservedMicros: 0 });
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
