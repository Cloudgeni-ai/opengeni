import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  createDb,
  createSession,
  setWorkspaceCodexSubscriptionMode,
  setWorkspaceCodexSubscriptionModeInTransaction,
  upsertOrganizationCodexSubscriptionCredential,
  disconnectOrganizationCodexAccount,
  upsertCodexSubscriptionCredential,
  withSessionCodexCapacityMutation,
  withSessionRlsActorContext,
  withRlsContext,
  nestedPostgresSqlState,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import {
  FORCE_RLS_TABLES,
  RUNTIME_READ_INSERT_TABLES,
  RUNTIME_READ_ONLY_TABLES,
  RUNTIME_FULL_DML_TABLES,
} from "../src/runtime-posture";

const migration = await readFile(
  new URL("../drizzle/0492_codex_accepted_source_authority.sql", import.meta.url),
  "utf8",
);
const db = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const api = await readFile(
  new URL("../../../apps/api/src/routes/codex.ts", import.meta.url),
  "utf8",
);

describe("accepted Codex source authority rollout contract", () => {
  test("legacy source is insert-only, scoped, and separate from turn history", () => {
    expect(migration).toStartWith("-- deployment-mode: maintenance");
    expect(migration.match(/SELECT pg_temp.assert_codex_source_runtime_drain\(\);/g)).toHaveLength(
      2,
    );
    expect(migration).toContain("pg_stat_activity");
    expect(migration).toContain("opengeni.migration_application_roles");
    expect(migration).toContain("ALTER TABLE codex_turn_source_bindings FORCE ROW LEVEL SECURITY");
    expect(FORCE_RLS_TABLES).toContain("codex_turn_source_bindings");
    expect(RUNTIME_READ_ONLY_TABLES).toContain("codex_turn_source_bindings");
    expect(RUNTIME_READ_INSERT_TABLES).not.toContain("codex_turn_source_bindings");
    expect(RUNTIME_FULL_DML_TABLES).not.toContain("codex_turn_source_bindings");
    expect(migration).not.toContain("UPDATE session_turns");
    expect(db).toMatch(
      /mutateCodexCapacityInTransaction[\s\S]*?lockWorkspaceCodexSubscriptionSource[\s\S]*?captureLegacyCodexTurnSources[\s\S]*?await mutate\(tx\)/u,
    );
    expect(migration).toContain("set_config('opengeni.subject_id', '', true)");
    expect(migration).toContain("ON CONFLICT (turn_id) DO NOTHING");
    expect(db).toContain("select capture_legacy_codex_turn_sources(");
  });

  test("exact-turn helper scopes source to tenant and actual credential ownership", () => {
    expect(migration).toContain(
      "p_account_id IS DISTINCT FROM opengeni_private.current_account_id()",
    );
    expect(migration).toContain(
      "p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()",
    );
    expect(migration).toContain("credential.workspace_id = p_workspace_id");
    expect(migration).toContain("credential.organization_id = p_account_id");
    expect(migration).toContain("NEW.credential_id, NEW.turn_id");
    expect(migration).toContain("codex_organization_scope_visible(p_account_id)");
    expect(migration).toContain("0492 organization lease count prerequisite drift");
    expect(migration).toContain("0492 session credential guard prerequisite drift");
  });

  test("ordinary materialization stays current-source; accepted model use proves exact live lease", () => {
    expect(db).toContain(
      "if (!authority) return (await effectiveCodexCredentialPoolCondition(tx, workspaceId)).condition",
    );
    expect(db).toContain("lease.holder_id = ${authority.holderId}");
    expect(db).toContain("lease.generation = ${authority.generation}");
    expect(db).toContain("lease.leased_until > clock_timestamp()");
    expect(db).toContain("session.active_turn_id = accepted.id");
    expect(api).toContain("mode: sourceBeforeConnect.mode");
  });
});

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let app: postgres.Sql | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("codex-source-authority");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  // Exercise the full chain as the production-shaped non-BYPASSRLS owner.
  await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 3 });
  app = postgres(appUrl.toString(), {
    max: 1,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await app?.end();
  await owned?.release();
}, 180_000);

async function fixture() {
  const admin = owned!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('0492 source security') returning id`;
  const accountId = account!.id;
  const adminSubject = `user:${crypto.randomUUID()}`;
  const ownerSubject = `user:${crypto.randomUUID()}`;
  const workspaceIds: string[] = [];
  for (const name of ["shared", "owner Personal", "admin Personal"]) {
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}, ${name}) returning id`;
    workspaceIds.push(workspace!.id);
    await admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${workspace!.id})`;
  }
  const [sharedId, personalId, adminPersonalId] = workspaceIds as [string, string, string];
  const [owner] = await admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}, ${ownerSubject}, 'member', 'active', ${personalId}) returning id`;
  await admin`insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}, ${adminSubject}, 'admin', 'active', ${adminPersonalId})`;
  for (const subject of [adminSubject, ownerSubject]) {
    await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}, ${sharedId}, ${subject}, 'admin')`;
  }
  return { accountId, sharedId, personalId, adminSubject, ownerSubject, ownerId: owner!.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function seedTurn(
  f: Fixture,
  workspaceId: string,
  options: {
    status?: string;
    model?: string;
    metadata?: postgres.JSONValue;
  } = {},
) {
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  await createSession(client!.db, {
    requestedSessionId: sessionId,
    accountId: f.accountId,
    workspaceId,
    initialMessage: "private content must never leave capture",
    model: "codex/gpt-5",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    tools: [],
    metadata: {},
  });
  // Historical private turns are fixture data, not a visibility lifecycle test.
  await owned!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set status = 'running', visibility = 'user_private',
      owner_subject_id = ${f.ownerSubject}, owner_organization_membership_id = ${f.ownerId},
      active_turn_id = ${turnId} where id = ${sessionId}`;
    await tx`insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend, metadata
    ) values (
      ${turnId}, ${f.accountId}, ${workspaceId}, ${sessionId}, ${crypto.randomUUID()},
      ${`0492-${sessionId}`}, ${options.status ?? "queued"}, 0, 'private turn prompt',
      ${options.model ?? "codex/gpt-5"}, 'medium', 'none', ${tx.json(options.metadata ?? {})}
    )`;
  });
  return { sessionId, turnId };
}

async function context(f: Fixture, workspaceId: string | null) {
  await app!`select set_config('opengeni.account_id', ${f.accountId}, false),
    set_config('opengeni.workspace_id', ${workspaceId ?? ""}, false),
    set_config('opengeni.subject_id', ${f.adminSubject}, false)`;
}

async function expectState(action: () => Promise<unknown>, state: string) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

async function receipts(f: Fixture) {
  const rows = await owned!.admin<{ turn_id: string; source: string }[]>`
    select turn_id, source from codex_turn_source_bindings
    where account_id = ${f.accountId} order by turn_id`;
  return [...rows];
}

async function connectOrganization(f: Fixture) {
  return await withSessionRlsActorContext({ subjectId: f.adminSubject }, () =>
    upsertOrganizationCodexSubscriptionCredential(client!.db, {
      organizationId: f.accountId,
      actorSubjectId: f.adminSubject,
      credentialEncrypted: "fixture",
      chatgptAccountId: crypto.randomUUID(),
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: null,
      lastRefreshAt: null,
    }),
  );
}

describe("0492 real owner/FORCE-RLS source receipt security", () => {
  test("runtime has only read authority; capture is fixed, content-free and non-BYPASSRLS", async () => {
    if (!owned || !app) return;
    const [posture] = await app`
      select r.rolsuper, r.rolbypassrls, p.prosecdef, p.prorettype::regtype::text as result,
        has_table_privilege(current_user, 'codex_turn_source_bindings', 'SELECT') as readable,
        has_table_privilege(current_user, 'codex_turn_source_bindings', 'INSERT') as insertable,
        has_table_privilege(current_user, 'codex_turn_source_bindings', 'UPDATE') as updatable,
        has_table_privilege(current_user, 'codex_turn_source_bindings', 'DELETE') as deletable
      from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.oid = 'capture_legacy_codex_turn_sources(uuid,uuid)'::regprocedure`;
    expect(posture).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      prosecdef: true,
      result: "void",
      readable: true,
      insertable: false,
      updatable: false,
      deletable: false,
    });
  });

  test("admin mode change captures another owner's private turn without exposing history", async () => {
    if (!owned || !client || !app) return;
    const f = await fixture();
    await connectOrganization(f);
    const turn = await seedTurn(f, f.sharedId);
    const before = (
      await owned.admin`select to_jsonb(t) as data from session_turns t where id = ${turn.turnId}`
    )[0]?.data;
    const sessionBefore = (
      await owned.admin`select to_jsonb(s) as data from sessions s where id = ${turn.sessionId}`
    )[0]?.data;
    await context(f, f.sharedId);
    expect(await app`select id from sessions where id = ${turn.sessionId}`).toHaveLength(0);
    expect(await app`select id from session_turns where id = ${turn.turnId}`).toHaveLength(0);
    await withSessionRlsActorContext({ subjectId: f.adminSubject }, () =>
      setWorkspaceCodexSubscriptionMode(client!.db, {
        accountId: f.accountId,
        workspaceId: f.sharedId,
        subjectId: f.adminSubject,
        mode: "disabled",
      }),
    );
    expect(await receipts(f)).toEqual([{ turn_id: turn.turnId, source: "organization" }]);
    expect(
      (
        await owned.admin`select to_jsonb(t) as data from session_turns t where id = ${turn.turnId}`
      )[0]?.data,
    ).toEqual(before);
    expect(
      (
        await owned.admin`select to_jsonb(s) as data from sessions s where id = ${turn.sessionId}`
      )[0]?.data,
    ).toEqual(sessionBefore);
    expect(await app`select id from sessions where id = ${turn.sessionId}`).toHaveLength(0);
    expect(await app`select id from session_turns where id = ${turn.turnId}`).toHaveLength(0);
  });

  test("organization connect and disconnect capture private Personal and shared turns before source drift", async () => {
    if (!owned || !client || !app) return;
    const f = await fixture();
    const beforeConnect = await seedTurn(f, f.personalId, { status: "recovering" });
    const credential = await connectOrganization(f);
    const personalTurn = await seedTurn(f, f.personalId, { status: "waiting_capacity" });
    const sharedTurn = await seedTurn(f, f.sharedId, { status: "requires_action" });
    await withSessionRlsActorContext({ subjectId: f.adminSubject }, () =>
      disconnectOrganizationCodexAccount(client!.db, {
        organizationId: f.accountId,
        actorSubjectId: f.adminSubject,
        credentialId: credential.id,
      }),
    );
    expect(await receipts(f)).toEqual(
      [
        { turn_id: beforeConnect.turnId, source: "workspace" },
        { turn_id: personalTurn.turnId, source: "organization" },
        { turn_id: sharedTurn.turnId, source: "organization" },
      ].sort((a, b) => a.turn_id.localeCompare(b.turn_id)),
    );
    await context(f, f.personalId);
    expect(await app`select id from sessions where workspace_id = ${f.personalId}`).toHaveLength(0);
    expect(
      await app`select id from session_turns where workspace_id = ${f.personalId}`,
    ).toHaveLength(0);
    expect(
      await owned.admin`select 1 from workspace_memberships where workspace_id = ${f.personalId}`,
    ).toHaveLength(0);
  });

  test("capture accepts only exact live legacy Codex turns and preserves first receipt across repeated changes", async () => {
    if (!owned || !app) return;
    const f = await fixture();
    const live = [];
    for (const status of [
      "queued",
      "running",
      "requires_action",
      "recovering",
      "waiting_capacity",
    ]) {
      live.push(await seedTurn(f, f.sharedId, { status }));
    }
    await seedTurn(f, f.sharedId, { status: "completed" });
    await seedTurn(f, f.sharedId, { status: "failed" });
    await seedTurn(f, f.sharedId, { status: "cancelled" });
    await seedTurn(f, f.sharedId, { model: "openai/gpt-5" });
    await seedTurn(f, f.sharedId, {
      metadata: { codexCredentialPolicySnapshotV1: { source: "disabled" } },
    });
    await seedTurn(f, f.personalId);
    await context(f, f.sharedId);
    await app`select capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId})`;
    await app`insert into workspace_codex_subscription_preferences (account_id, workspace_id, mode)
      values (${f.accountId}, ${f.sharedId}, 'disabled')`;
    await app`select capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId})`;
    expect(await receipts(f)).toEqual(
      live
        .map((t) => ({ turn_id: t.turnId, source: "workspace" }))
        .sort((a, b) => a.turn_id.localeCompare(b.turn_id)),
    );
    const later = await seedTurn(f, f.sharedId);
    await app`select capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId})`;
    expect((await receipts(f)).find((r) => r.turn_id === later.turnId)?.source).toBe("disabled");
    const [actor] = await app`select current_setting('opengeni.subject_id') as subject`;
    expect(actor?.subject).toBe(f.adminSubject);
    expect(await app`select id from session_turns`).toHaveLength(0);
  });

  test("forged binding, source, turn, cross-tenant and arbitrary-subject entry points are denied", async () => {
    if (!owned || !app) return;
    const f = await fixture();
    const foreign = await fixture();
    const turn = await seedTurn(f, f.sharedId);
    const foreignTurn = await seedTurn(foreign, foreign.sharedId);
    await context(f, f.sharedId);
    for (const source of ["workspace", "organization", "disabled"]) {
      for (const turnId of [turn.turnId, foreignTurn.turnId, crypto.randomUUID()]) {
        await expectState(
          () => app!`insert into codex_turn_source_bindings
          (turn_id, account_id, workspace_id, source)
          values (${turnId}, ${f.accountId}, ${f.sharedId}, ${source}) on conflict do nothing`,
          "42501",
        );
      }
    }
    for (const [accountId, workspaceId] of [
      [foreign.accountId, foreign.sharedId],
      [f.accountId, foreign.sharedId],
      [foreign.accountId, f.sharedId],
      [f.accountId, f.personalId],
      [null, f.sharedId],
      [f.accountId, null],
    ]) {
      await expectState(
        () => app!`select capture_legacy_codex_turn_sources(${accountId!}, ${workspaceId!})`,
        "42501",
      );
    }
    await expectState(
      () =>
        app!`select capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId}, ${f.ownerSubject})`,
      "42883",
    );
    await expectState(
      () =>
        app!`select capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId}, 'organization', ${turn.turnId})`,
      "42883",
    );
    expect(await receipts(f)).toHaveLength(0);
    expect(await receipts(foreign)).toHaveLength(0);
    await app`select capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId})`;
    await expectState(
      () =>
        app!`update codex_turn_source_bindings set source = 'organization' where turn_id = ${turn.turnId}`,
      "42501",
    );
    await expectState(
      () => app!`delete from codex_turn_source_bindings where turn_id = ${turn.turnId}`,
      "42501",
    );
    const [actor] = await app`select current_setting('opengeni.subject_id') as subject`;
    expect(actor?.subject).toBe(f.adminSubject);
    expect(await app`select id from sessions where id = ${turn.sessionId}`).toHaveLength(0);
  });

  test("connect captures pre-mutation source and ignores a caller-authored override", async () => {
    if (!owned || !client) return;
    const f = await fixture();
    await connectOrganization(f);
    const turn = await seedTurn(f, f.sharedId);
    await withSessionRlsActorContext({ subjectId: f.adminSubject }, () =>
      withSessionCodexCapacityMutation(
        client!.db,
        { workspaceId: f.sharedId, reason: "0492-connect" },
        async (tx) => {
          await upsertCodexSubscriptionCredential(tx, {
            accountId: f.accountId,
            workspaceId: f.sharedId,
            credentialEncrypted: "fixture",
            chatgptAccountId: crypto.randomUUID(),
            scopes: null,
            planType: "pro",
            isFedramp: false,
            expiresAt: null,
            lastRefreshAt: null,
          });
          await setWorkspaceCodexSubscriptionModeInTransaction(tx, {
            accountId: f.accountId,
            workspaceId: f.sharedId,
            subjectId: f.adminSubject,
            mode: "automatic",
            effectiveSourceBeforeMutation: "disabled",
          });
          return { result: null, changed: true };
        },
      ),
    );
    expect(await receipts(f)).toEqual([{ turn_id: turn.turnId, source: "organization" }]);
    const later = await seedTurn(f, f.sharedId);
    await withSessionRlsActorContext({ subjectId: f.adminSubject }, () =>
      withRlsContext(client!.db, { accountId: f.accountId, workspaceId: f.sharedId }, (tx) =>
        setWorkspaceCodexSubscriptionModeInTransaction(tx, {
          accountId: f.accountId,
          workspaceId: f.sharedId,
          subjectId: f.adminSubject,
          mode: "disabled",
          effectiveSourceBeforeMutation: "organization",
        }),
      ),
    );
    expect((await receipts(f)).find((r) => r.turn_id === later.turnId)?.source).toBe("workspace");
  });

  test("owner-only insert policy rejects forged receipts even after an accidental runtime INSERT grant", async () => {
    if (!owned || !app) return;
    const f = await fixture();
    const turn = await seedTurn(f, f.sharedId);
    await context(f, f.sharedId);
    await owned.admin`grant insert on codex_turn_source_bindings to opengeni_app`;
    try {
      await expectState(
        () => app!`insert into codex_turn_source_bindings
        (turn_id, account_id, workspace_id, source)
        values (${turn.turnId}, ${f.accountId}, ${f.sharedId}, 'organization')`,
        "42501",
      );
      await app`select capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId})`;
      expect(await receipts(f)).toEqual([{ turn_id: turn.turnId, source: "workspace" }]);
    } finally {
      await owned.admin`revoke insert on codex_turn_source_bindings from opengeni_app`;
    }
  });

  test("capture serializes on the source lock and rolls back with its source mutation", async () => {
    if (!owned || !client) return;
    const f = await fixture();
    const turn = await seedTurn(f, f.sharedId);
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = owned.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`codex-subscription-source:${f.sharedId}`}, 0))`;
      locked();
      await gate;
    });
    await ready;
    try {
      await expectState(
        () =>
          withSessionRlsActorContext({ subjectId: f.adminSubject }, () =>
            withRlsContext(
              client!.db,
              { accountId: f.accountId, workspaceId: f.sharedId },
              async (tx) => {
                await tx.execute(sql`set local lock_timeout = '100ms'`);
                await tx.execute(
                  sql`select capture_legacy_codex_turn_sources(${f.accountId}::uuid, ${f.sharedId}::uuid)`,
                );
              },
            ),
          ),
        "55P03",
      );
      expect(await receipts(f)).toHaveLength(0);
    } finally {
      release();
      await blocker;
    }
    await expect(
      withSessionRlsActorContext({ subjectId: f.adminSubject }, () =>
        withRlsContext(
          client!.db,
          { accountId: f.accountId, workspaceId: f.sharedId },
          async (tx) => {
            await setWorkspaceCodexSubscriptionModeInTransaction(tx, {
              accountId: f.accountId,
              workspaceId: f.sharedId,
              subjectId: f.adminSubject,
              mode: "disabled",
            });
            throw new Error("abort source mutation");
          },
        ),
      ),
    ).rejects.toThrow("abort source mutation");
    expect(await receipts(f)).toHaveLength(0);
    await context(f, f.sharedId);
    const [source] =
      await app!`select resolve_workspace_codex_subscription_source(${f.accountId}, ${f.sharedId}) as source`;
    expect(source?.source).toBe("workspace");
    await app!`select capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId})`;
    expect(await receipts(f)).toEqual([{ turn_id: turn.turnId, source: "workspace" }]);
  });

  test("an insert failure restores actor visibility within the same transaction", async () => {
    if (!owned || !app) return;
    const f = await fixture();
    const turn = await seedTurn(f, f.sharedId);
    await context(f, f.sharedId);
    await owned.admin
      .unsafe(`alter table codex_turn_source_bindings add constraint test_capture_failure
      check (turn_id <> '${turn.turnId}'::uuid) not valid`);
    try {
      await app.begin(async (tx) => {
        await expectState(
          () =>
            tx.savepoint(async (savepoint) => {
              await savepoint`select capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId})`;
            }),
          "23514",
        );
        const [actor] = await tx`select current_setting('opengeni.subject_id') as subject`;
        expect(actor?.subject).toBe(f.adminSubject);
        expect(await tx`select id from session_turns where id = ${turn.turnId}`).toHaveLength(0);
      });
      expect(await receipts(f)).toHaveLength(0);
    } finally {
      await owned.admin`alter table codex_turn_source_bindings drop constraint test_capture_failure`;
    }
  });

  test("runtime temp tables cannot shadow accepted source, legacy fallback, or source capture", async () => {
    if (!owned || !app) return;
    const f = await fixture();
    const bound = await seedTurn(f, f.sharedId, {
      metadata: { codexCredentialPolicySnapshotV1: { source: "disabled" } },
    });
    const legacy = await seedTurn(f, f.sharedId);
    const [credential] = await owned.admin<{ id: string }[]>`
      insert into codex_subscription_credentials (account_id, workspace_id, authority_scope, credential_encrypted)
      values (${f.accountId}, ${f.sharedId}, 'workspace', 'fixture') returning id`;
    await owned.admin`insert into workspace_codex_subscription_preferences (account_id, workspace_id, mode)
      values (${f.accountId}, ${f.sharedId}, 'disabled')`;
    await context(f, f.sharedId);
    await app`select set_config('opengeni.subject_id', ${f.ownerSubject}, false)`;
    // Give the definer access too: denial must come from real authority, not
    // permission errors on the attacker's temp relations.
    await app.begin(async (tx) => {
      await tx`create temporary table sessions (id uuid, account_id uuid, workspace_id uuid) on commit drop`;
      await tx`create temporary table session_turns (id uuid, account_id uuid, workspace_id uuid,
        session_id uuid, status text, model text, metadata jsonb) on commit drop`;
      await tx`create temporary table codex_turn_source_bindings (turn_id uuid, account_id uuid,
        workspace_id uuid, source text) on commit drop`;
      await tx`create temporary table codex_subscription_credentials (id uuid, account_id uuid,
        workspace_id uuid, organization_id uuid, authority_scope text) on commit drop`;
      await tx`create temporary table workspace_codex_subscription_preferences
        (account_id uuid, workspace_id uuid, mode text) on commit drop`;
      await tx`create temporary table workspaces (id uuid, account_id uuid) on commit drop`;
      await tx.unsafe(`grant select on pg_temp.sessions, pg_temp.session_turns,
        pg_temp.codex_turn_source_bindings, pg_temp.codex_subscription_credentials,
        pg_temp.workspace_codex_subscription_preferences, pg_temp.workspaces to "${owned!.ownerRole}"`);
      await tx`insert into pg_temp.workspaces values (${f.sharedId}, ${f.accountId})`;
      await tx`insert into pg_temp.workspace_codex_subscription_preferences values (${f.accountId}, ${f.sharedId}, 'workspace')`;
      await tx`insert into pg_temp.codex_subscription_credentials
        values (${credential!.id}, ${f.accountId}, ${f.sharedId}, null, 'workspace')`;
      for (const turn of [bound, legacy]) {
        await tx`insert into pg_temp.sessions values (${turn.sessionId}, ${f.accountId}, ${f.sharedId})`;
        await tx`insert into pg_temp.session_turns values (${turn.turnId}, ${f.accountId}, ${f.sharedId},
          ${turn.sessionId}, 'queued', 'codex/gpt-5', '{"codexCredentialPolicySnapshotV1":{"source":"workspace"}}')`;
        const [authority] = await tx`select opengeni_private.codex_credential_serves_turn(
          ${f.accountId}, ${f.sharedId}, ${credential!.id}, ${turn.turnId}) as allowed`;
        expect(authority?.allowed).toBe(false);
      }
      await tx`select public.capture_legacy_codex_turn_sources(${f.accountId}, ${f.sharedId})`;
      const [receipt] =
        await tx`select source from public.codex_turn_source_bindings where turn_id = ${legacy.turnId}`;
      expect(receipt?.source).toBe("disabled");
    });
  });

  test("lease retargeting revalidates exact turn source, model, tenant and live status", async () => {
    if (!owned || !app || !client) return;
    const f = await fixture();
    const organizationCredential = await connectOrganization(f);
    const accepted = await seedTurn(f, f.sharedId);
    await withSessionRlsActorContext({ subjectId: f.adminSubject }, () =>
      setWorkspaceCodexSubscriptionMode(client!.db, {
        accountId: f.accountId,
        workspaceId: f.sharedId,
        subjectId: f.adminSubject,
        mode: "workspace",
      }),
    );
    const differentSource = await seedTurn(f, f.sharedId);
    const terminal = await seedTurn(f, f.sharedId, {
      status: "completed",
      metadata: { codexCredentialPolicySnapshotV1: { source: "organization" } },
    });
    const nonCodex = await seedTurn(f, f.sharedId, {
      model: "openai/gpt-5",
      metadata: { codexCredentialPolicySnapshotV1: { source: "organization" } },
    });
    const other = await fixture();
    const otherTurn = await seedTurn(other, other.sharedId);
    await context(f, f.sharedId);
    await app`select set_config('opengeni.subject_id', ${f.ownerSubject}, false)`;
    await app`insert into codex_credential_leases (account_id, workspace_id, credential_id, turn_id,
      holder_id, leased_until) values (${f.accountId}, ${f.sharedId}, ${organizationCredential.id},
      ${accepted.turnId}, '0492-holder', now() + interval '5 minutes')`;
    for (const target of [differentSource, terminal, nonCodex, otherTurn]) {
      await expectState(
        () => app!`update codex_credential_leases set turn_id = ${target.turnId}
        where turn_id = ${accepted.turnId}`,
        "23514",
      );
    }
    const [lease] =
      await app`select turn_id from codex_credential_leases where holder_id = '0492-holder'`;
    expect(lease?.turn_id).toBe(accepted.turnId);
    // Ordinary same-turn renewal remains possible after current routing changes.
    await app`update codex_credential_leases set leased_until = now() + interval '10 minutes'
      where turn_id = ${accepted.turnId}`;
  });
});
