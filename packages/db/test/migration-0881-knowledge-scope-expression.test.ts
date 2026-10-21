import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import type { SharedTestDatabase } from "@opengeni/testing";
import {
  listingDatabase,
  readListing,
  seedListingFixture,
} from "./fixtures/knowledge-collection-listing";
import { installScopeBaseline, readScopeBaseline } from "./fixtures/knowledge-scope-baseline";

let shared: SharedTestDatabase;
let app: postgres.Sql;
beforeAll(async () => {
  shared = await listingDatabase();
  app = postgres(shared.appUrl, { max: 1, prepare: false });
  await installScopeBaseline(shared.admin, shared.appUrl);
}, 180_000);
afterAll(async () => {
  await app?.end();
  await shared?.release();
}, 180_000);

test("the predicate expression is unchanged from its original SQL definition", async () => {
  const [row] = await shared.admin`SELECT
    (SELECT prosrc FROM pg_proc WHERE oid='knowledge_scope_visible(knowledge_entries)'::regprocedure) current,
    (SELECT prosrc FROM pg_proc WHERE oid='knowledge_scope_visible_before_scope(knowledge_entries)'::regprocedure) baseline`;
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ");
  expect(
    normalize(row!.current)
      .replace(/^BEGIN RETURN /u, "")
      .replace(/; END$/u, ""),
  ).toBe(normalize(row!.baseline).replace(/^SELECT /u, ""));
});

test("scope, temporal and legacy restrictions match across changing contexts on one transaction", async () => {
  const account = crypto.randomUUID(),
    workspace = crypto.randomUUID(),
    other = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const base = {
    account_id: account,
    origin_workspace_id: workspace,
    scope: "workspace",
    scope_workspace_id: workspace,
    scope_subject_id: "user:test",
    valid_from: "2020-01-01T00:00:00Z",
    valid_until: null,
  };
  const variants = [
    {},
    { account_id: other },
    { account_id: null },
    { scope: "organization" },
    { scope: "personal" },
    { scope: "personal", scope_subject_id: "user:other" },
    { scope: "personal", scope_subject_id: null },
    { scope: null },
    { scope_workspace_id: other },
    { legacy_scope_workspace_id: workspace },
    { legacy_scope_workspace_id: other },
    { valid_from: "2100-01-01T00:00:00Z" },
    { valid_from: null },
    { valid_until: "2010-01-01T00:00:00Z" },
    { legacy_memory_id: other, origin_workspace_id: other },
    { legacy_memory_id: other },
    ...["workspace", "user", "role", "session", "ephemeral", "legacy"].flatMap(
      (legacy_scope_type) => [
        {
          legacy_scope_type,
          legacy_scope_role_key: "editor",
          legacy_scope_session_id: sessionId,
          valid_until: "2100-01-01T00:00:00Z",
        },
        {
          legacy_scope_type,
          scope_subject_id: "user:other",
          legacy_scope_role_key: "other",
          legacy_scope_session_id: other,
        },
      ],
    ),
  ].map((patch) => ({ ...base, ...patch }));
  const contexts = [
    {},
    { account: other },
    { account: "" },
    { workspace: other },
    { workspace: "" },
    { subject: "user:other" },
    { subject: "" },
    { actor: "agent", defaultScope: "personal" },
    { actor: "agent", defaultScope: "workspace" },
    { actor: "", defaultScope: "" },
    { role: "other", session: other },
    {},
  ];
  await shared.admin.begin(async (tx) => {
    for (const patch of contexts) {
      const c = {
        account,
        workspace,
        subject: "user:test",
        actor: "human",
        defaultScope: "workspace",
        role: "editor",
        session: sessionId,
        ...patch,
      };
      await tx`SELECT set_config('opengeni.account_id',${c.account},true),set_config('opengeni.workspace_id',${c.workspace},true),
        set_config('opengeni.subject_id',${c.subject},true),set_config('opengeni.knowledge_actor_kind',${c.actor},true),
        set_config('opengeni.knowledge_default_scope',${c.defaultScope},true),set_config('opengeni.memory_role_key',${c.role},true),
        set_config('opengeni.memory_session_id',${c.session},true)`;
      const rows =
        await tx`SELECT knowledge_scope_visible(e) actual,knowledge_scope_visible_before_scope(e) expected
        FROM jsonb_array_elements(${tx.json(variants)}) v CROSS JOIN LATERAL jsonb_populate_record(NULL::knowledge_entries,v) e`;
      for (const row of rows) expect(row.actual).toBe(row.expected);
      expect(rows[0]!.actual).toBe(c.account === account && c.workspace === workspace);
      expect(rows[3]!.actual).toBe(c.account === account);
      expect(rows[4]!.actual).toBe(
        c.account === account &&
          c.subject === "user:test" &&
          (c.actor === "human" || c.defaultScope === "personal"),
      );
    }
    const [boundary] = await tx`SELECT knowledge_scope_visible(NULL::knowledge_entries) null_row,
      knowledge_scope_visible(jsonb_populate_record(NULL::knowledge_entries,${tx.json(base)} || jsonb_build_object('valid_until',transaction_timestamp()))) expired,
      knowledge_scope_visible(jsonb_populate_record(NULL::knowledge_entries,${tx.json(base)} || jsonb_build_object('valid_from',transaction_timestamp()))) starts_now`;
    expect(boundary).toEqual({ null_row: false, expired: false, starts_now: true });
  });
});

test("flat and collection reads retain exact results, search ranking, history and pagination", async () => {
  for (const flat of [false, true]) {
    const fixture = await seedListingFixture(shared.admin, 60, { flat });
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await app.unsafe(`SET plan_cache_mode=${mode}`);
      for (const request of [
        { limit: 20 },
        { limit: 20, rootOnly: true },
        { limit: 20, groupId: fixture.groupId },
        { limit: 20, query: "Member", mode: "keyword" },
        { limit: 20, query: "absent", mode: "hybrid" },
        { operation: "get", entryId: fixture.sourceId },
        { operation: "history", entryId: fixture.groupId },
        { limit: 20, createdSince: "2100-01-01T00:00:00Z" },
      ]) {
        expect(JSON.stringify(await readListing(app, fixture, request))).toBe(
          JSON.stringify(await readScopeBaseline(app, fixture, request)),
        );
      }
      const first = await readListing(app, fixture, { limit: 20 });
      const cursor = { limit: 20, afterId: first[19]!.id, afterScore: first[19]!.score };
      expect(await readListing(app, fixture, cursor)).toEqual(
        await readScopeBaseline(app, fixture, cursor),
      );
    }
    const reader = { ...fixture, actor: { ...fixture.actor, review: false } };
    expect(await readListing(app, reader, { limit: 50 })).toEqual(
      await readScopeBaseline(app, reader, { limit: 50 }),
    );
    await shared.admin`UPDATE files SET status='pending' WHERE id=${fixture.sourceFileId}`;
    expect(await readListing(app, reader, { limit: 50 })).toEqual(
      await readScopeBaseline(app, reader, { limit: 50 }),
    );
  }
}, 180_000);

test("the internal scope function keeps invoker, stable and hardened lookup metadata", async () => {
  const [row] = await shared.admin`SELECT p.prosecdef,p.provolatile,p.proconfig,l.lanname,
    p.proowner=(SELECT proowner FROM pg_proc WHERE oid='knowledge_scope_visible_before_scope(knowledge_entries)'::regprocedure) same_owner,
    p.proacl=(SELECT proacl FROM pg_proc WHERE oid='knowledge_scope_visible_before_scope(knowledge_entries)'::regprocedure) same_acl,
    format('search_path=%I, pg_catalog, pg_temp',n.nspname) expected,
    has_function_privilege(${decodeURIComponent(new URL(shared.appUrl).username)},p.oid,'EXECUTE') allowed
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid='knowledge_scope_visible(knowledge_entries)'::regprocedure`;
  expect(row).toMatchObject({
    prosecdef: false,
    provolatile: "s",
    lanname: "plpgsql",
    same_owner: true,
    same_acl: true,
    allowed: false,
  });
  expect(row!.proconfig).toEqual([row!.expected]);
  await expect(
    Promise.resolve(app`SELECT knowledge_scope_visible(NULL::knowledge_entries)`),
  ).rejects.toMatchObject({ code: "42501" });
});

test("the replacement hardens the actual embedded installation schema", async () => {
  const migration = await readFile(
    new URL("../drizzle/0881_knowledge_scope_expression.sql", import.meta.url),
    "utf8",
  );
  const schema = `scope_expression_${crypto.randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("rollback embedded fixture");
  try {
    await shared.admin.begin(async (tx) => {
      await tx`CREATE SCHEMA ${tx(schema)}`;
      await tx`CREATE TABLE ${tx(schema)}.knowledge_entries (LIKE knowledge_entries)`;
      await tx`SET LOCAL search_path=${tx(schema)},public`;
      await tx.unsafe(migration);
      const [row] =
        await tx`SELECT p.proconfig,format('search_path=%I, pg_catalog, pg_temp',${schema}::text) expected
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${schema} AND p.proname='knowledge_scope_visible'`;
      expect(row!.proconfig).toEqual([row!.expected]);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}, 180_000);
