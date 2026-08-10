import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0198_memory_slack_publication_delivery.sql",
  import.meta.url,
);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0198-memory-slack");
  if (!shared) return;
  await shared.admin`set lock_timeout = '5s'`;
  await shared.admin`set statement_timeout = '10s'`;
});

afterAll(async () => {
  await shared?.release();
});

describe("migration 0198 Memory Slack publication delivery", () => {
  test("is rolling and declares the protected delivery contract", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
    expect(source).toContain("FOR UPDATE SKIP LOCKED");
    expect(source).toContain("SECURITY DEFINER\n    SET search_path = pg_catalog");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.claim_memory_slack_publication(uuid, integer)",
    );
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.reject_memory_slack_immutable_mutation()",
    );
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.guard_memory_slack_publication_identity()",
    );
    expect(source).toContain("TO opengeni_app");
    expect(source).toContain("memory_slack_publication_configurations_immutable");
    expect(source).toContain("memory_slack_publication_receipts_immutable");
    expect(source).toContain("memory_slack_publications_identity_immutable");
    expect(source).toMatch(
      /memory_slack_publications_source_uq"\s+UNIQUE \("workspace_id", "source_idempotency_key"\)/,
    );
    expect(source).toContain("state\" = 'retry_wait'");
    expect(source).not.toMatch(/credential|access_token|refresh_token|raw_text/i);
    expect(source).not.toMatch(/ACCESS\s+EXCLUSIVE/i);
  });

  test("freezes causal identity and safely claims immutable receipt history", async () => {
    // The shared template applies the exact ordered migration history once per
    // test process, then clones a clean database. Replaying all migrations in
    // this one file caused shard-dependent CI stalls after migration 0198 had
    // already committed, without adding coverage beyond this runtime proof.
    if (!shared) return;
    const sql = shared.admin;
    const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0198-account') returning id`;
    const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0198-workspace') returning id`;
    const [configuration] = await sql<{ id: string }[]>`
        insert into memory_slack_publication_configurations (
          account_id, workspace_id, revision, enabled, connection_id,
          slack_team_id, slack_channel_id, slack_channel_name,
          auto_importances, review_importances, created_by_subject_id
        ) values (
          ${account!.id}, ${workspace!.id}, 1, true, ${crypto.randomUUID()},
          'T_TEST', 'C_TEST', 'decisions', array['major'], array['normal'], 'subject-1'
        ) returning id`;
    const publicationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await sql`
        insert into memory_slack_publications (
          id, account_id, workspace_id, configuration_id, configuration_revision,
          connection_id, slack_team_id, slack_channel_id, source_type, source_id,
          source_version, source_idempotency_key, projection, projection_sha256,
          importance, delivery_mode, state, operation_id, initiator_kind,
          initiator_subject_id, initiating_human_subject_id, session_id, turn_id,
          attempt_id
        ) values (
          ${publicationId}, ${account!.id}, ${workspace!.id}, ${configuration!.id}, 1,
          ${crypto.randomUUID()}, 'T_TEST', 'C_TEST', 'workspace_memory', 'memory-1',
          '1', 'memory-1:v1', ${sql.json({ summary: "Durable decision" })}::jsonb,
          ${"a".repeat(64)},
          'major', 'auto', 'queued', ${operationId}, 'service', 'goal-continuation',
          'user:causal-owner', ${sessionId}, ${turnId}, ${attemptId}
        )`;
    await sql`
        insert into memory_slack_publication_receipts (
          account_id, workspace_id, publication_id, sequence, kind, state,
          attempt_number, actor_kind, actor_subject_id, operation_id
        ) values (
          ${account!.id}, ${workspace!.id}, ${publicationId}, 1, 'enqueued', 'queued',
          0, 'service', 'goal-continuation', ${operationId}
        )`;

    const [frozenIdentity] = await sql<
      Array<{
        initiator_kind: string;
        initiator_subject_id: string;
        initiating_human_subject_id: string | null;
        session_id: string | null;
        turn_id: string | null;
        attempt_id: string | null;
      }>
    >`
        select initiator_kind, initiator_subject_id, initiating_human_subject_id,
               session_id, turn_id, attempt_id
        from memory_slack_publications where id = ${publicationId}`;
    expect(frozenIdentity).toEqual({
      initiator_kind: "service",
      initiator_subject_id: "goal-continuation",
      initiating_human_subject_id: "user:causal-owner",
      session_id: sessionId,
      turn_id: turnId,
      attempt_id: attemptId,
    });

    await sql`
        insert into memory_slack_publication_configurations (
          account_id, workspace_id, revision, enabled, connection_id,
          slack_team_id, slack_channel_id, auto_importances, review_importances,
          created_by_subject_id
        ) values (
          ${account!.id}, ${workspace!.id}, 2, true, ${crypto.randomUUID()},
          'T_TEST', 'C_OTHER', array['major'], array['normal'], 'subject-1'
        )`;
    await expect(sql`
        insert into memory_slack_publications (
          account_id, workspace_id, configuration_id, configuration_revision,
          connection_id, slack_team_id, slack_channel_id, source_type, source_id,
          source_version, source_idempotency_key, projection, projection_sha256,
          importance, delivery_mode, state, operation_id, initiator_kind,
          initiator_subject_id
        ) values (
          ${account!.id}, ${workspace!.id}, ${configuration!.id}, 2,
          ${crypto.randomUUID()}, 'T_TEST', 'C_OTHER', 'workspace_memory', 'memory-1',
          '1', 'memory-1:v1', ${sql.json({ summary: "Durable decision" })}::jsonb,
          ${"a".repeat(64)},
          'major', 'auto', 'queued', ${crypto.randomUUID()}, 'human', 'subject-1'
        )`).rejects.toThrow();

    const holderOne = crypto.randomUUID();
    const claimed = await sql<Array<{ id: string; state: string; attempt_count: number }>>`
        select id, state, attempt_count
        from opengeni_private.claim_memory_slack_publication(${holderOne}::uuid, 1000)`;
    expect([...claimed]).toEqual([{ id: publicationId, state: "delivering", attempt_count: 1 }]);
    const receiptKinds = await sql<Array<{ kind: string; sequence: number }>>`
        select kind, sequence from memory_slack_publication_receipts
        where publication_id = ${publicationId} order by sequence`;
    expect([...receiptKinds]).toEqual([
      { kind: "enqueued", sequence: 1 },
      { kind: "delivery_claimed", sequence: 2 },
    ]);
    const [enqueuedReceipt] = await sql<
      Array<{ actor_kind: string; actor_subject_id: string; operation_id: string }>
    >`
        select actor_kind, actor_subject_id, operation_id
        from memory_slack_publication_receipts
        where publication_id = ${publicationId} and kind = 'enqueued'`;
    expect(enqueuedReceipt).toEqual({
      actor_kind: "service",
      actor_subject_id: "goal-continuation",
      operation_id: operationId,
    });

    await sql`update memory_slack_publications set claim_expires_at = now() - interval '1 second'
        where id = ${publicationId}`;
    const holderTwo = crypto.randomUUID();
    const reclaimed = await sql<Array<{ attempt_count: number }>>`
        select attempt_count
        from opengeni_private.claim_memory_slack_publication(${holderTwo}::uuid, 1000)`;
    expect([...reclaimed]).toEqual([{ attempt_count: 2 }]);

    for (const mutation of [
      () =>
        sql`update memory_slack_publication_configurations set enabled = false where id = ${configuration!.id}`,
      () =>
        sql`update memory_slack_publication_receipts set actor_subject_id = 'other' where publication_id = ${publicationId}`,
      () =>
        sql`update memory_slack_publications set initiating_human_subject_id = 'user:other' where id = ${publicationId}`,
    ]) {
      await expect(mutation()).rejects.toThrow();
    }

    const tables = await sql<Array<{ relname: string; forced: boolean }>>`
        select C.relname, C.relforcerowsecurity as forced
        from pg_class C join pg_namespace N on N.oid = C.relnamespace
        where N.nspname = current_schema()
          and C.relname in (
            'memory_slack_publication_configurations',
            'memory_slack_publications',
            'memory_slack_publication_receipts'
          ) order by C.relname`;
    expect(tables.every((table) => table.forced)).toBe(true);
  }, 60_000);
});
