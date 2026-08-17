#!/usr/bin/env bun
import { createDb, setRlsContext, type Database, withSessionRlsActorContext } from "@opengeni/db";
import { startTestServices } from "@opengeni/testing";
import { sql } from "drizzle-orm";

const SAMPLES = 200;
const services = await startTestServices({ temporal: false });
const client = createDb(services.databaseUrl, { max: 1 });
const context = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
};
const actor = {
  subjectId: `attempt:${crypto.randomUUID()}`,
  initiatingHumanSubjectId: `user:${crypto.randomUUID()}`,
};

try {
  for (let index = 0; index < 10; index += 1) {
    await measureLegacy(client.db);
    await measureConsolidated(client.db);
    await measureLegacyWithActor(client.db);
    await measureConsolidatedWithActor(client.db);
  }

  const legacy: number[] = [];
  const consolidated: number[] = [];
  const legacyActor: number[] = [];
  const consolidatedActor: number[] = [];
  // Alternate order so pool/server drift cannot consistently favor one shape.
  for (let index = 0; index < SAMPLES; index += 1) {
    if (index % 2 === 0) {
      legacy.push(await timed(() => measureLegacy(client.db)));
      consolidated.push(await timed(() => measureConsolidated(client.db)));
      legacyActor.push(await timed(() => measureLegacyWithActor(client.db)));
      consolidatedActor.push(await timed(() => measureConsolidatedWithActor(client.db)));
    } else {
      consolidated.push(await timed(() => measureConsolidated(client.db)));
      legacy.push(await timed(() => measureLegacy(client.db)));
      consolidatedActor.push(await timed(() => measureConsolidatedWithActor(client.db)));
      legacyActor.push(await timed(() => measureLegacyWithActor(client.db)));
    }
  }

  const contextCleanup = await assertContextCleanup(client.db);

  console.log(
    JSON.stringify(
      {
        samples: SAMPLES,
        ordinaryStatementsMeasured: { legacy: 5, consolidated: 2 },
        actorStatementsMeasured: { legacy: 8, consolidatedWithExtraProof: 4 },
        productionActorStatements: { legacy: 8, consolidated: 3 },
        legacyMs: distribution(legacy),
        consolidatedMs: distribution(consolidated),
        legacyActorMs: distribution(legacyActor),
        consolidatedActorMs: distribution(consolidatedActor),
        contextCleanup,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await services.down();
}
process.exit(0);

async function measureLegacy(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('opengeni.account_id', ${context.accountId}, true)`);
    await tx.execute(sql`select set_config('opengeni.workspace_id', ${context.workspaceId}, true)`);
    await tx.execute(sql`select set_config('opengeni.lossless_content_writer', '1', true)`);
    await tx.execute(sql`select
      set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
      set_config('opengeni.pending_tool_event_output_v1', '1', true)`);
    await assertContext(tx as unknown as Database);
  });
}

async function measureConsolidated(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await setRlsContext(tx as unknown as Database, context);
    await assertContext(tx as unknown as Database);
  });
}

async function measureLegacyWithActor(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('opengeni.account_id', ${context.accountId}, true)`);
    await tx.execute(sql`select set_config('opengeni.workspace_id', ${context.workspaceId}, true)`);
    await tx.execute(sql`select set_config('opengeni.lossless_content_writer', '1', true)`);
    await tx.execute(sql`select
      set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
      set_config('opengeni.pending_tool_event_output_v1', '1', true)`);
    await tx.execute(sql`select set_config('opengeni.subject_id', ${actor.subjectId}, true)`);
    await tx.execute(
      sql`select set_config(
        'opengeni.initiating_human_subject_id',
        ${actor.initiatingHumanSubjectId},
        true
      )`,
    );
    await assertActorContext(tx as unknown as Database, actor);
    await assertContext(tx as unknown as Database);
  });
}

async function measureConsolidatedWithActor(db: Database): Promise<void> {
  await withSessionRlsActorContext(actor, async () => {
    await db.transaction(async (tx) => {
      const scoped = tx as unknown as Database;
      await setRlsContext(scoped, context);
      await assertActorContext(scoped, actor);
      await assertContext(scoped);
    });
  });
}

async function assertContextCleanup(db: Database): Promise<{
  actorContextExact: boolean;
  actorContextClearedInNextTransaction: boolean;
  missingInitiatingHumanRemainsEmpty: boolean;
}> {
  const actorContextExact = await withSessionRlsActorContext(actor, async () => {
    return await db.transaction(async (tx) => {
      const scoped = tx as unknown as Database;
      await setRlsContext(scoped, context);
      return await actorContextMatches(scoped, actor);
    });
  });
  const actorContextClearedInNextTransaction = await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    await setRlsContext(scoped, context);
    return await actorContextMatches(scoped, {
      subjectId: "",
      initiatingHumanSubjectId: "",
    });
  });
  const missingInitiatingHumanRemainsEmpty = await withSessionRlsActorContext(
    { subjectId: actor.subjectId },
    async () => {
      return await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await setRlsContext(scoped, context);
        return await actorContextMatches(scoped, {
          subjectId: actor.subjectId,
          initiatingHumanSubjectId: "",
        });
      });
    },
  );
  if (
    !actorContextExact ||
    !actorContextClearedInNextTransaction ||
    !missingInitiatingHumanRemainsEmpty
  ) {
    throw new Error("consolidated RLS context failed actor isolation or cleanup");
  }
  return {
    actorContextExact,
    actorContextClearedInNextTransaction,
    missingInitiatingHumanRemainsEmpty,
  };
}

async function assertContext(db: Database): Promise<void> {
  const result = await db.execute<{
    account_id: string | null;
    workspace_id: string | null;
  }>(sql`select
    current_setting('opengeni.account_id', true) as account_id,
    current_setting('opengeni.workspace_id', true) as workspace_id`);
  const row = result[0];
  if (row?.account_id !== context.accountId || row.workspace_id !== context.workspaceId) {
    throw new Error("RLS context read-back mismatch");
  }
}

async function assertActorContext(
  db: Database,
  expected: { subjectId: string; initiatingHumanSubjectId: string },
): Promise<void> {
  if (!(await actorContextMatches(db, expected))) {
    throw new Error("session actor RLS context read-back mismatch");
  }
}

async function actorContextMatches(
  db: Database,
  expected: { subjectId: string; initiatingHumanSubjectId: string },
): Promise<boolean> {
  const result = await db.execute<{
    subject_id: string | null;
    initiating_human_subject_id: string | null;
  }>(sql`select
    current_setting('opengeni.subject_id', true) as subject_id,
    current_setting(
      'opengeni.initiating_human_subject_id',
      true
    ) as initiating_human_subject_id`);
  const row = result[0];
  return (
    (row?.subject_id ?? "") === expected.subjectId &&
    (row?.initiating_human_subject_id ?? "") === expected.initiatingHumanSubjectId
  );
}

async function timed(operation: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)]!;
  return {
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}
