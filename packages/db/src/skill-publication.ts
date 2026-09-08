import { SkillPublicationReceipt } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";

/** Acquire before source/component/operation locks in installers and finalizers. */
export async function lockSkillPublication(db: Database, workspaceId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-publication:${workspaceId}`},0))`,
  );
}

export async function prepareSkillPublication(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<void> {
  await lockSkillPublication(db, workspaceId);
  await db.execute(
    sql`SELECT set_config('opengeni.skill_publication_operation_id',${operationId},true)`,
  );
}

export async function readSkillPublications(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<SkillPublicationReceipt[]> {
  const rows = await rawRows<{ receipt: unknown }>(
    db,
    sql`
    SELECT receipt FROM skill_write_receipts WHERE workspace_id=${workspaceId}::uuid
      AND receipt->>'publicationOperationId'=${operationId} ORDER BY receipt->>'skillId',operation_id`,
  );
  return rows.map((row) => SkillPublicationReceipt.parse(row.receipt));
}
