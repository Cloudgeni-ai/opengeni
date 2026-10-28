/**
 * Which vault fields a session tree used before (the `vault.secret.used`
 * audit rows), so an attempt can mask those values when they reappear in
 * text, for example a value a previous turn wrote to a file
 * (docs/secrets.md, Masking). Metadata only: no value is read here.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

export type SessionTreeSecretUse = {
  itemId: string;
  fieldId: string | null;
  fieldName: string | null;
  /** The reference as the agent wrote it. */
  reference: string;
};

function usesFromMetadata(metadata: unknown): SessionTreeSecretUse[] {
  if (metadata === null || typeof metadata !== "object") return [];
  const items = (metadata as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const uses: SessionTreeSecretUse[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.itemId !== "string" || typeof record.reference !== "string") continue;
    uses.push({
      itemId: record.itemId,
      fieldId: typeof record.fieldId === "string" ? record.fieldId : null,
      fieldName: typeof record.fieldName === "string" ? record.fieldName : null,
      reference: record.reference,
    });
  }
  return uses;
}

/**
 * Distinct fields the session's root tree used, newest first, from uses
 * after `after` (exclusive) and never before the root session started.
 * Bounded by `limit` rows and a short statement timeout. `latestAt` is where
 * the next call can start: always 30 seconds before this query (whether or
 * not uses were found), so a tree without uses is not scanned again from its
 * start and a use committed late, with an earlier timestamp, is still read.
 * Uses in the overlap are read again; callers dedupe them.
 */
export async function listSessionTreeSecretUses(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    after?: Date | null;
    limit?: number;
    timeoutMs?: number;
  },
): Promise<{ uses: SessionTreeSecretUse[]; latestAt: Date | null }> {
  const limit = Math.max(1, Math.min(input.limit ?? 500, 2_000));
  const timeoutMs = Math.max(100, Math.min(input.timeoutMs ?? 3_000, 10_000));
  const table = schema.auditEvents;
  const root = sql`(select s.root_session_id from sessions s
    where s.id = ${input.sessionId}::uuid and s.workspace_id = ${input.workspaceId}::uuid)`;
  const { rows, scannedUntil } = await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`);
      const [clock] = await tx.execute<{ until: Date | string | null }>(
        sql`select now() - interval '30 seconds' as until`,
      );
      const until = clock?.until ?? null;
      const found = await tx
        .select({ occurredAt: table.occurredAt, metadata: table.metadata })
        .from(table)
        .where(
          and(
            eq(table.accountId, input.accountId),
            eq(table.workspaceId, input.workspaceId),
            eq(table.action, "vault.secret.used"),
            // `after` is a millisecond Date while rows keep microseconds:
            // start at the next millisecond so the newest use is not read again.
            ...(input.after ? [gte(table.occurredAt, new Date(input.after.getTime() + 1))] : []),
            sql`${table.occurredAt} >= (select r.created_at from sessions r where r.id = ${root})`,
            sql`(${table.metadata} ->> 'sessionId') in (select t.id::text from sessions t
              where t.workspace_id = ${input.workspaceId}::uuid and t.root_session_id = ${root})`,
          ),
        )
        .orderBy(desc(table.occurredAt))
        .limit(limit);
      return {
        rows: found,
        scannedUntil: until === null ? null : new Date(until),
      };
    },
  );
  const seen = new Set<string>();
  const uses: SessionTreeSecretUse[] = [];
  for (const row of rows) {
    for (const use of usesFromMetadata(row.metadata)) {
      const key = `${use.itemId}|${use.fieldId ?? use.fieldName ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uses.push(use);
    }
  }
  const latestAt = scannedUntil ?? input.after ?? null;
  return { uses, latestAt };
}
