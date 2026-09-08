import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readSkillMetadata } from "@opengeni/contracts";
import type {
  SkillFile,
  SkillRecord,
  SkillWriteContext,
  SkillWriteReceipt,
  SkillActor,
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
    if (context.actor.kind !== "agent") {
      await tx.execute(
        sql`SELECT set_config('opengeni.principal_kind', ${context.actor.principalKind}, true)`,
      );
    } else await assertSkillReadAttempt(tx, { ...context, actor: context.actor });
    let content: string | undefined;
    if (request.operation === "save") {
      content = (request.files as SkillFile[] | undefined)?.find(
        (file) => file.path === "SKILL.md",
      )?.content;
    } else if (request.operation === "install") {
      const [main] = await rawRows<{ content: string }>(
        tx,
        sql`SELECT content FROM capability_skill_files
        WHERE skill_facet_id=${request.skillFacetId as string}::uuid AND path='SKILL.md'`,
      );
      content = main?.content;
    } else if (request.operation === "approve" || request.operation === "restore") {
      const [revision] = await rawRows<{
        content: string;
        title: string;
        description: string;
        skill_files: SkillFile[] | null;
      }>(
        tx,
        sql`
        SELECT content,title,description,skill_files FROM preference_registry_revisions
        WHERE account_id=${context.accountId}::uuid AND preference_id=${request.skillId as string}::uuid
          AND id=${request.revisionId as string}::uuid`,
      );
      content = revision?.content;
      if (request.operation === "approve" && revision) {
        const metadata = readSkillMetadata(revision.content);
        if (
          !revision.skill_files ||
          revision.title !== metadata.name ||
          revision.description !== metadata.description
        )
          throw new Error(
            "Historical Skill approval requires a canonical files-bearing revision; use restore or save",
          );
      }
    }
    if (content === undefined) throw new Error("Skill lifecycle requires a readable SKILL.md");
    const metadata = readSkillMetadata(content);
    const canonicalRequest = {
      ...request,
      title: metadata.name,
      description: metadata.description,
    };
    const rows = await rawRows<{ receipt: SkillWriteReceipt }>(
      tx,
      sql`
      SELECT skill_apply_lifecycle(${context.accountId}::uuid, ${context.workspaceId}::uuid,
        ${JSON.stringify(context.actor)}::jsonb, ${JSON.stringify(canonicalRequest)}::jsonb) AS receipt
    `,
    );
    if (!rows[0]) throw new Error("Skill lifecycle returned no durable receipt");
    return rows[0].receipt;
  };
  return context.actor.kind !== "agent"
    ? withWorkspaceSubjectRls(db, context.workspaceId, context.actor.subjectId, run)
    : withWorkspaceRls(db, context.workspaceId, run);
}

export type SkillReadContext = {
  accountId: string;
  workspaceId: string;
  /** Trusted subject enables the existing user-tier visibility; agents share workspace reads. */
  subjectId?: string;
};

/** Recheck the host-bound attempt before any agent-facing Skill read/search. */
export async function assertSkillReadAttempt(
  db: Database,
  context: SkillReadContext & { actor: Extract<SkillActor, { kind: "agent" }> },
): Promise<void> {
  await withWorkspaceRls(db, context.workspaceId, async (tx) => {
    const rows = await rawRows<{ id: string }>(
      tx,
      sql`
      SELECT a.id FROM sessions s
      JOIN session_turns t ON t.id=s.active_turn_id AND t.session_id=s.id
      JOIN session_turn_attempts a ON a.id=t.active_attempt_id AND a.turn_id=t.id
      WHERE s.account_id=${context.accountId}::uuid AND s.workspace_id=${context.workspaceId}::uuid
        AND s.id=${context.actor.sessionId}::uuid
        AND t.account_id=s.account_id AND t.workspace_id=s.workspace_id
        AND t.id=${context.actor.turnId}::uuid
        AND t.status IN ('running','requires_action','recovering','waiting_capacity')
        AND a.id=${context.actor.attemptId}::uuid AND a.account_id=s.account_id
        AND a.workspace_id=s.workspace_id AND a.session_id=s.id
        AND a.execution_generation=${context.actor.executionGeneration}::integer
        AND t.execution_generation=a.execution_generation AND a.state IN ('claimed','running')
        AND NOT EXISTS (SELECT 1 FROM session_attempt_interruptions i
          WHERE i.workspace_id=s.workspace_id AND i.attempt_id=a.id
            AND i.state IN ('pending','delivered','acknowledged'))
    `,
    );
    if (!rows.length) throw new Error("Skill access requires the exact live attempt");
  });
}

export type SkillDescriptor = {
  id: string;
  stableKey: string;
  title: string;
  description: string;
  revisionId: string;
  scopeVersion: number;
  installationVersion: number | null;
  activationMode: "workspace_managed" | "session_selected";
};

/** Active metadata only: building an index must not transfer every Skill folder. */
export async function listSkillDescriptors(
  db: Database,
  context: SkillReadContext,
): Promise<SkillDescriptor[]> {
  const run = (tx: Database) =>
    rawRows<SkillDescriptor>(
      tx,
      sql`
    SELECT h.id, h.stable_key AS "stableKey", r.title, r.description,
      r.id AS "revisionId", h.scope_version AS "scopeVersion", pi.version AS "installationVersion",
      coalesce(r.skill_activation_mode,'workspace_managed') AS "activationMode"
    FROM preference_registry_preferences h
    JOIN preference_registry_revisions r ON r.id=h.active_revision_id AND r.preference_id=h.id
      AND r.account_id=h.account_id
    LEFT JOIN skill_source_bindings b ON b.preference_id=h.id AND b.account_id=h.account_id
      AND b.workspace_id=${context.workspaceId}::uuid
    LEFT JOIN capability_plugin_installations pi ON pi.plugin_id=b.plugin_id
      AND pi.account_id=h.account_id AND pi.workspace_id=b.workspace_id AND pi.status='active'
    WHERE h.account_id=${context.accountId}::uuid AND h.status='active'
      AND (h.scope='organization' OR (h.scope='workspace' AND h.scope_workspace_id=${context.workspaceId}::uuid)
        OR (h.scope='user' AND h.scope_subject_id=${context.subjectId ?? null}))
    ORDER BY h.stable_key,h.id
  `,
    );
  return context.subjectId
    ? withWorkspaceSubjectRls(db, context.workspaceId, context.subjectId, run)
    : withWorkspaceRls(db, context.workspaceId, run);
}

export async function listSkillRecords(
  db: Database,
  context: SkillReadContext,
  options: {
    skillId?: string;
    revisionId?: string;
    limit?: number;
    metadataOnly?: boolean;
    after?: { stableKey: string; id: string };
  } = {},
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
        'files',CASE WHEN ${options.metadataOnly === true} THEN '[]'::jsonb ELSE coalesce(r.skill_files,CASE WHEN r.id IS NULL THEN '[]'::jsonb ELSE
          jsonb_build_array(jsonb_build_object('path','SKILL.md','content',r.content)) END) END,
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
        AND (${options.after?.id ?? null}::uuid IS NULL OR
          (h.stable_key,h.id) > (${options.after?.stableKey ?? ""},${options.after?.id ?? null}::uuid))
      ORDER BY h.stable_key,h.id LIMIT ${Math.min(Math.max(options.limit ?? 128, 1), 1000)}
    `,
    );
    return rows.map((row) => row.skill);
  };
  return context.subjectId
    ? withWorkspaceSubjectRls(db, context.workspaceId, context.subjectId, run)
    : withWorkspaceRls(db, context.workspaceId, run);
}
