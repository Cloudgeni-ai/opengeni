import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../src/migrate";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  claimSessionWorkForAttempt,
  applySessionTurnSettlement,
} from "../src/index";
let shared: OwnerMigratedTestDatabase;
let owner: ReturnType<typeof postgres>;
let client: ReturnType<typeof createDb>;
const appRole = `context_app_${crypto.randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("receiver-context-owner");
  if (!acquired) throw new Error("Owner PostgreSQL required");
  shared = acquired;
  await migrate(shared.ownerUrl, "public", { applicationDatabaseRoles: [appRole] });
  owner = postgres(shared.ownerUrl, { max: 1 });
  client = createDb(shared.adminUrl);
}, 240_000);
afterAll(async () => {
  await client?.close();
  await owner?.end();
  await shared?.release();
}, 60_000);

test("owner backfill sees started requests under FORCE RLS and excludes claim-only requests", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Context migration",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Context migration",
    subjectId: `subject-${crypto.randomUUID()}`,
  });
  const scope = access.workspaceGrants[0]!;
  const sessions = [];
  for (const started of [true, false]) {
    const s = await createSession(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId!,
      initialMessage: "Work",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId!,
      sessionId: s.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId!, {
      sessionId: s.id,
      workflowId: `session-${s.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("claim failed");
    if (started)
      await applySessionTurnSettlement(client.db, scope.workspaceId!, {
        sessionId: s.id,
        turnId: claimed.turn.id,
        triggerEventId: claimed.turn.triggerEventId,
        attemptId,
        turnStatus: "running",
        sessionStatus: "running",
        activeTurnId: claimed.turn.id,
        events: [{ type: "turn.started", payload: { turnId: claimed.turn.id } }],
      });
    sessions.push({ id: s.id, expected: started ? claimed.turn.id : null });
  }
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await tx`update sessions set execution_context_turn_id=null where workspace_id=${scope.workspaceId!}`;
  });
  const migration = await readFile(
    new URL("../drizzle/0608_receiver_execution_context.sql", import.meta.url),
    "utf8",
  );
  const backfill = migration.slice(
    migration.indexOf("ALTER TABLE sessions NO FORCE"),
    migration.indexOf("CREATE FUNCTION opengeni_private.fence_session_execution_context"),
  );
  // The exact migration backfill runs as the real non-bypass table owner.
  // Drop only the later-installed pointer guard to reconstruct its pre-install position.
  await owner.begin(async (tx) => {
    await tx`drop trigger sessions_zz_execution_context on sessions`;
    await tx.unsafe(backfill);
    await tx`create trigger sessions_zz_execution_context before insert or update on sessions
      for each row execute function opengeni_private.fence_session_execution_context()`;
  });
  for (const s of sessions) {
    const [row] =
      await shared.admin`select execution_context_turn_id from sessions where id=${s.id}`;
    expect(row!.execution_context_turn_id).toBe(s.expected);
  }
  const [role] = await owner`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
  const tables = await shared.admin`select relforcerowsecurity from pg_class where oid in
    ('sessions'::regclass,'session_turns'::regclass,'session_turn_attempts'::regclass,'session_events'::regclass)`;
  expect(tables.every((row) => row.relforcerowsecurity)).toBe(true);
}, 180_000);
