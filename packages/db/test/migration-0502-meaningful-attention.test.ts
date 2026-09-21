import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { appendSessionEvents, bootstrapWorkspace, createDb, createSession } from "../src/index";
import { migrate } from "../src/migrate";
import { meaningfulSessionSequenceSql } from "../src/session-meaningful-events";

let shared: OwnerMigratedTestDatabase;
let owner: ReturnType<typeof postgres>;
let client: ReturnType<typeof createDb>;
const applicationRole = `attention_app_${crypto.randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("meaningful-attention");
  if (!acquired) throw new Error("Real non-bypass owner PostgreSQL is required");
  shared = acquired;
  await migrate(shared.ownerUrl, "public", { applicationDatabaseRoles: [applicationRole] });
  owner = postgres(shared.ownerUrl, { max: 1 });
  client = createDb(shared.adminUrl);
}, 240_000);
afterAll(async () => {
  await client?.close();
  await owner?.end();
  await shared?.release();
}, 60_000);

test("non-bypass owner preserves ambiguous intent without advancing any cursor; frontier uses its partial index", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "attention migration",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "attention migration",
    subjectId: "user:attention-migration",
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "work",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await appendSessionEvents(client.db, workspaceId, session.id, [
    { type: "turn.completed", payload: { output: "answer" } },
    ...Array.from({ length: 512 }, () => ({
      type: "sandbox.box.terminated" as const,
      payload: {},
    })),
  ]);
  const [cursor] =
    await shared.admin`select last_sequence from session_event_cursors where session_id=${session.id}`;
  for (const [subject, sequence, revision] of [
    ["manual", 0, 1],
    ["automatic", 0, 0],
    ["read", cursor!.last_sequence, 1],
  ] as const) {
    await shared.admin`insert into session_pins(account_id, workspace_id, subject_id, session_id,
      acknowledged_sequence, attention_version) values(${accountId}, ${workspaceId}, ${subject}, ${session.id}, ${sequence}, ${revision})`;
  }
  const migration = await readFile(
    new URL("../drizzle/0502_session_meaningful_attention.sql", import.meta.url),
    "utf8",
  );
  // Reconstruct only this isolated fixture's pre-0502 shape, then execute the
  // exact shipped migration as its NOSUPERUSER NOBYPASSRLS owner.
  await owner.begin(async (tx) => {
    await tx`alter table session_pins drop column manually_unread`;
    await tx`drop index session_events_meaningful_attention_idx`;
    await tx`select set_config('opengeni.migration_application_roles', ${JSON.stringify([applicationRole])}, true)`;
    await tx.unsafe(migration);
  });
  const rows = await shared.admin`select subject_id, acknowledged_sequence, manually_unread
    from session_pins where session_id=${session.id} order by subject_id`;
  expect([...rows]).toEqual([
    { subject_id: "automatic", acknowledged_sequence: 0, manually_unread: false },
    { subject_id: "manual", acknowledged_sequence: 0, manually_unread: true },
    { subject_id: "read", acknowledged_sequence: cursor!.last_sequence, manually_unread: false },
  ]);
  const posture = await shared.admin`select relname, relforcerowsecurity from pg_class
    where relname in ('session_pins', 'session_event_cursors') order by relname`;
  expect(posture.every((row) => row.relforcerowsecurity)).toBe(true);
  const query = new PgDialect().sqlToQuery(
    sql`select ${meaningfulSessionSequenceSql(sql`${workspaceId}::uuid`, sql`${session.id}::uuid`)}`,
  );
  const plan = await shared.admin.begin(async (tx) => {
    await tx`set local enable_seqscan = off`;
    return await tx.unsafe(`explain ${query.sql}`, query.params as string[]);
  });
  expect(JSON.stringify(plan)).toContain("session_events_meaningful_attention_idx");
}, 180_000);
