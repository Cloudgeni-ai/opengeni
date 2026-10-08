import type { AttemptToolCatalog, ModelContextSnapshot } from "@opengeni/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import * as schema from "./schema";
import {
  encodeAttemptToolCatalogContent,
  encodeModelContextSnapshotContent,
  writeSessionContentBlobs,
} from "./session-content-blobs";

/**
 * Rewrite rows stored before session content blobs existed into the
 * deduplicated form. Lossless by construction: the database replaces a row only
 * after proving, under a row lock, that the referenced blobs rebuild exactly
 * the original inline value. Safe to run repeatedly and concurrently with live
 * writers; a row that changed or no longer qualifies is skipped.
 */
export type SessionContentKind = "tool_catalog" | "model_context_snapshot";
export const SESSION_CONTENT_KINDS: readonly SessionContentKind[] = [
  "tool_catalog",
  "model_context_snapshot",
];

export type SessionContentCompactionCandidate = {
  kind: SessionContentKind;
  attemptId: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
};

export async function listSessionContentCompactionCandidates(
  db: Database,
  input: { kind: SessionContentKind; afterAttemptId: string | null; limit: number },
): Promise<SessionContentCompactionCandidate[]> {
  const rows = await rawRows<{
    attempt_id: string;
    account_id: string;
    workspace_id: string;
    session_id: string;
  }>(
    db,
    sql`select attempt_id, account_id, workspace_id, session_id
      from opengeni_private.session_content_compaction_candidates(
        ${input.kind}, ${input.afterAttemptId}::uuid, ${input.limit}
      )`,
  );
  return rows.map((row) => ({
    kind: input.kind,
    attemptId: row.attempt_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
  }));
}

/** Returns true when the row was rewritten, false when it was skipped. */
export async function compactSessionContentRow(
  db: Database,
  candidate: SessionContentCompactionCandidate,
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: candidate.accountId, workspaceId: candidate.workspaceId },
    async (scoped) => {
      const scope = {
        accountId: candidate.accountId,
        workspaceId: candidate.workspaceId,
        sessionId: candidate.sessionId,
      };
      let stored: unknown;
      let refs: unknown;
      if (candidate.kind === "tool_catalog") {
        const [row] = await scoped
          .select({ catalog: schema.sessionAttemptToolCatalogs.catalog })
          .from(schema.sessionAttemptToolCatalogs)
          .where(
            and(
              eq(schema.sessionAttemptToolCatalogs.workspaceId, candidate.workspaceId),
              eq(schema.sessionAttemptToolCatalogs.attemptId, candidate.attemptId),
              isNull(schema.sessionAttemptToolCatalogs.contentRefs),
            ),
          )
          .limit(1);
        if (!row) return false;
        const encoded = encodeAttemptToolCatalogContent(row.catalog as AttemptToolCatalog);
        await writeSessionContentBlobs(scoped, scope, encoded.blobs);
        stored = encoded.stored;
        refs = encoded.refs;
      } else {
        const [row] = await scoped
          .select({ snapshot: schema.sessionAttemptModelContextSnapshots.snapshot })
          .from(schema.sessionAttemptModelContextSnapshots)
          .where(
            and(
              eq(schema.sessionAttemptModelContextSnapshots.workspaceId, candidate.workspaceId),
              eq(schema.sessionAttemptModelContextSnapshots.attemptId, candidate.attemptId),
              isNull(schema.sessionAttemptModelContextSnapshots.contentRefs),
            ),
          )
          .limit(1);
        if (!row) return false;
        const encoded = encodeModelContextSnapshotContent(row.snapshot as ModelContextSnapshot);
        await writeSessionContentBlobs(scoped, scope, encoded.blobs);
        stored = encoded.stored;
        refs = encoded.refs;
      }
      const [result] = await rawRows<{ compacted: boolean }>(
        scoped,
        sql`select opengeni_private.compact_session_content_row(
          ${candidate.kind},
          ${candidate.workspaceId}::uuid,
          ${candidate.attemptId}::uuid,
          ${JSON.stringify(stored)}::jsonb,
          ${JSON.stringify(refs)}::jsonb
        ) as compacted`,
      );
      return result?.compacted === true;
    },
  );
}

export type SessionContentCompactionResult = {
  scanned: number;
  compacted: number;
  skipped: number;
  failed: number;
};

/**
 * Compact up to `maxRows` legacy rows per kind, oldest attempt id first. One
 * failing row never aborts the pass; it stays legacy and is retried next pass.
 */
export async function compactLegacySessionContent(
  db: Database,
  options: {
    batchSize?: number;
    maxRows?: number;
    kinds?: readonly SessionContentKind[];
    onRowError?: (candidate: SessionContentCompactionCandidate, error: unknown) => void;
  } = {},
): Promise<SessionContentCompactionResult> {
  const batchSize = options.batchSize ?? 100;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const result: SessionContentCompactionResult = {
    scanned: 0,
    compacted: 0,
    skipped: 0,
    failed: 0,
  };
  for (const kind of options.kinds ?? SESSION_CONTENT_KINDS) {
    let after: string | null = null;
    let processed = 0;
    while (processed < maxRows) {
      const candidates = await listSessionContentCompactionCandidates(db, {
        kind,
        afterAttemptId: after,
        limit: Math.min(batchSize, maxRows - processed),
      });
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        result.scanned += 1;
        processed += 1;
        try {
          if (await compactSessionContentRow(db, candidate)) result.compacted += 1;
          else result.skipped += 1;
        } catch (error) {
          result.failed += 1;
          options.onRowError?.(candidate, error);
        }
      }
      after = candidates.at(-1)!.attemptId;
    }
  }
  return result;
}

if (import.meta.main) {
  const { createDb } = await import("./index");
  const url = process.env.OPENGENI_DATABASE_URL;
  if (!url) throw new Error("Set OPENGENI_DATABASE_URL to the application database URL");
  const batchArgument = process.argv.find((value) => value.startsWith("--batch-size="));
  const client = createDb(url);
  try {
    const outcome = await compactLegacySessionContent(client.db, {
      batchSize: batchArgument ? Number(batchArgument.split("=")[1]) : 100,
      onRowError: (candidate, error) =>
        console.error(
          `[session-content] ${candidate.kind} ${candidate.attemptId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    });
    console.log(`[session-content] ${JSON.stringify(outcome)}`);
  } finally {
    await client.close();
  }
}
