import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type {
  SkillFile,
  SkillRecord,
  SkillWriteContext,
  SkillWriteReceipt,
} from "@opengeni/contracts";
import { rawRows, withWorkspaceRls, withWorkspaceSubjectRls, type Database } from "./database";

/** The existing portable artifact framing; never substitutes for a historical content hash. */
export function skillFilesContentHash(files: readonly SkillFile[]): string {
  const manifest = files
    .map(({ path, content }) => [path, Buffer.from(content, "utf8").toString("base64")] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}

/** HTTP authorization must precede this boundary. Agent claims are host-bound, not model input. */
export async function applySkillLifecycle(
  db: Database,
  context: SkillWriteContext,
  request: Record<string, unknown>,
): Promise<SkillWriteReceipt> {
  const run = async (tx: Database) => {
    if (context.actor.kind === "human") {
      await tx.execute(
        sql`SELECT set_config('opengeni.principal_kind', ${context.actor.principalKind}, true)`,
      );
    }
    const rows = await rawRows<{ receipt: SkillWriteReceipt }>(
      tx,
      sql`
      SELECT skill_apply_lifecycle(${context.accountId}::uuid, ${context.workspaceId}::uuid,
        ${JSON.stringify(context.actor)}::jsonb, ${JSON.stringify(request)}::jsonb) AS receipt
    `,
    );
    if (!rows[0]) throw new Error("Skill lifecycle returned no durable receipt");
    return rows[0].receipt;
  };
  return context.actor.kind === "human"
    ? withWorkspaceSubjectRls(db, context.workspaceId, context.actor.subjectId, run)
    : withWorkspaceRls(db, context.workspaceId, run);
}

export type SkillReadContext = {
  accountId: string;
  workspaceId: string;
  /** Trusted subject enables the existing user-tier visibility; agents share workspace reads. */
  subjectId?: string;
};

export async function listSkillRecords(
  db: Database,
  context: SkillReadContext,
  options: { skillId?: string; revisionId?: string; limit?: number } = {},
): Promise<SkillRecord[]> {
  const run = async (tx: Database) => {
    const rows = await rawRows<{ skill: SkillRecord }>(
      tx,
      sql`
      SELECT jsonb_build_object(
        'id',h.id,'stableKey',h.stable_key,'scope',h.scope,'scopeVersion',h.scope_version,
        'status',h.status,'activeRevisionId',h.active_revision_id,'revisionId',r.id,
        'activationMode',coalesce(r.skill_activation_mode,'workspace_managed'),
        'pendingRevisionIds',coalesce((SELECT jsonb_agg(DISTINCT pending.receipt->>'revisionId')
          FROM skill_write_receipts pending WHERE pending.account_id=h.account_id
            AND pending.workspace_id=${context.workspaceId}::uuid AND pending.receipt->>'skillId'=h.id::text
            AND pending.receipt->>'outcome'='pending'
            AND NOT EXISTS(SELECT 1 FROM preference_registry_events e WHERE e.preference_id=h.id
              AND e.new_revision_id=(pending.receipt->>'revisionId')::uuid
              AND e.type IN ('activated','corrected','rejected'))),'[]'::jsonb),
        'title',r.title,'description',r.description,'contentHash',r.content_hash,
        'files',coalesce(r.skill_files,CASE WHEN r.id IS NULL THEN '[]'::jsonb ELSE
          jsonb_build_array(jsonb_build_object('path','SKILL.md','content',r.content)) END),
        'source',CASE WHEN b.preference_id IS NULL THEN NULL ELSE jsonb_build_object(
          'pluginId',b.plugin_id,'facetKey',b.facet_key,'skillFacetId',b.skill_facet_id) END
      ) AS skill
      FROM preference_registry_preferences h
      LEFT JOIN LATERAL (
        SELECT candidate.* FROM preference_registry_revisions candidate
        WHERE candidate.preference_id=h.id AND candidate.account_id=h.account_id
          AND (${options.revisionId ?? null}::uuid IS NULL OR candidate.id=${options.revisionId ?? null}::uuid)
        ORDER BY (candidate.id=h.active_revision_id) DESC NULLS LAST,candidate.revision DESC LIMIT 1
      ) r ON true
      LEFT JOIN skill_source_bindings b ON b.preference_id=h.id AND b.account_id=h.account_id
        AND b.workspace_id=${context.workspaceId}::uuid
      WHERE h.account_id=${context.accountId}::uuid
        AND (h.scope='organization' OR (h.scope='workspace' AND h.scope_workspace_id=${context.workspaceId}::uuid)
          OR (h.scope='user' AND h.scope_subject_id=${context.subjectId ?? null}))
        AND (${options.skillId ?? null}::uuid IS NULL OR h.id=${options.skillId ?? null}::uuid)
        AND (${options.revisionId ?? null}::uuid IS NULL OR r.id IS NOT NULL)
      ORDER BY h.stable_key,h.id LIMIT ${Math.min(Math.max(options.limit ?? 128, 1), 1000)}
    `,
    );
    return rows.map((row) => row.skill);
  };
  return context.subjectId
    ? withWorkspaceSubjectRls(db, context.workspaceId, context.subjectId, run)
    : withWorkspaceRls(db, context.workspaceId, run);
}
