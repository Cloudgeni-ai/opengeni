import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readSkillMetadata } from "@opengeni/contracts";
import type {
  SkillFile,
  SkillRecord,
  SkillWriteContext,
  SkillWriteReceipt,
  SkillActor,
  SkillReviewReference,
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
    if (request.operation === "confirm_response") {
      const [source] = await rawRows<{ receipt: SkillWriteReceipt }>(
        tx,
        sql`
        SELECT receipt FROM skill_write_receipts
        WHERE account_id=${context.accountId}::uuid AND workspace_id=${context.workspaceId}::uuid
          AND operation_id=${request.sourceOperationId as string}::uuid`,
      );
      if (!source?.receipt.skillReview) throw new Error("Skill confirmation source unavailable");
      request = { ...request, ...source.receipt.skillReview };
    }
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
    } else if (
      request.operation === "approve" ||
      request.operation === "reject" ||
      request.operation === "restore" ||
      request.operation === "confirm_response"
    ) {
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
      if (
        (request.operation === "approve" || request.operation === "confirm_response") &&
        revision
      ) {
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
      AND (r.expires_at IS NULL OR r.expires_at > transaction_timestamp())
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
        'status',CASE WHEN h.status='active' AND EXISTS (
          SELECT 1 FROM preference_registry_revisions active
          WHERE active.id=h.active_revision_id AND active.preference_id=h.id
            AND active.account_id=h.account_id AND active.expires_at <= transaction_timestamp()
        ) THEN 'expired' ELSE h.status END,
        'activeRevisionId',h.active_revision_id,'revisionId',r.id,
        'activationMode',coalesce(r.skill_activation_mode,'workspace_managed'),
        'pendingRevisionIds',coalesce((SELECT jsonb_agg(DISTINCT pending.receipt->>'revisionId')
          FROM skill_write_receipts pending WHERE pending.account_id=h.account_id
            AND pending.workspace_id=${context.workspaceId}::uuid AND pending.receipt->>'skillId'=h.id::text
            AND pending.receipt->>'outcome'='pending'
            AND coalesce(pending.receipt->>'pendingReason','approval')='approval'
            AND (pending.receipt->>'revisionId')::uuid=(SELECT newest.id FROM preference_registry_revisions newest
              WHERE newest.account_id=h.account_id AND newest.preference_id=h.id ORDER BY newest.revision DESC LIMIT 1)
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

export class SkillHumanResponseError extends Error {
  constructor(
    readonly code: "conflict" | "forbidden" | "invalid",
    cause: unknown,
  ) {
    super(
      code === "conflict"
        ? "This Skill changed. Review a new proposal before saving."
        : code === "forbidden"
          ? "This Skill approval is not available to this user."
          : "This Skill proposal cannot be saved.",
      { cause },
    );
    this.name = "SkillHumanResponseError";
  }
}

/** Called only inside canonical-human response admission, after the answer and
 * authorization stamp were written in the same transaction. The lifecycle
 * independently requires that stamp and the exact initiating human. */
export async function confirmSkillHumanResponse(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string; requestId: string },
): Promise<SkillWriteReceipt | null> {
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await rawRows<{
      questions: Array<{ id: string; skillReview?: { sourceOperationId: string } }>;
      response: { outcome: string; answers?: Array<{ questionId: string; values: string[] }> };
    }>(
      tx,
      sql`SELECT questions,response FROM session_human_input_requests
        WHERE id=${input.requestId}::uuid AND account_id=${input.accountId}::uuid
          AND workspace_id=${input.workspaceId}::uuid`,
    );
    const question = row?.questions.find((entry) => entry.skillReview);
    if (
      !question ||
      row?.response.outcome !== "answered" ||
      !row.response.answers?.some(
        (answer) =>
          answer.questionId === question.id &&
          answer.values.length === 1 &&
          ["save", "skip"].includes(answer.values[0]!),
      )
    )
      return null;
    const hash = createHash("sha256")
      .update("skill-human-response:" + input.requestId)
      .digest("hex");
    const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    try {
      return await applySkillLifecycle(
        tx,
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          actor: { kind: "human", subjectId: input.subjectId, principalKind: "human_session" },
        },
        {
          operation: "confirm_response",
          operationId,
          sourceOperationId: question.skillReview!.sourceOperationId,
          humanInputRequestId: input.requestId,
        },
      );
    } catch (error) {
      let cause: unknown = error;
      while (cause instanceof Error) {
        const code = (cause as Error & { code?: string }).code;
        if (code === "40001" || code === "23505")
          throw new SkillHumanResponseError("conflict", error);
        if (code === "42501") throw new SkillHumanResponseError("forbidden", error);
        if (code === "22023" || code === "23514")
          throw new SkillHumanResponseError("invalid", error);
        if (
          cause.message === "Skill confirmation source unavailable" ||
          cause.message === "Skill lifecycle requires a readable SKILL.md"
        )
          throw new SkillHumanResponseError("conflict", error);
        cause = cause.cause;
      }
      throw error;
    }
  });
}

/** Current projection is separate from the immutable original write receipt. */
export async function skillReviewResolution(
  db: Database,
  context: SkillReadContext,
  review: SkillReviewReference,
): Promise<"pending" | "activated" | "declined" | "superseded" | "unavailable"> {
  const run = async (tx: Database) => {
    const [record] = await listSkillRecords(tx, context, {
      skillId: review.skillId,
      revisionId: review.revisionId,
      metadataOnly: true,
      limit: 1,
    });
    if (!record) return "unavailable" as const;
    const [event] = await rawRows<{ type: string }>(
      tx,
      sql`
      SELECT type FROM preference_registry_events WHERE account_id=${context.accountId}::uuid
        AND preference_id=${review.skillId}::uuid AND new_revision_id=${review.revisionId}::uuid
        AND type IN ('activated','corrected','rejected') ORDER BY version DESC LIMIT 1`,
    );
    if (event) return event.type === "rejected" ? ("declined" as const) : ("activated" as const);
    const [newer] = await rawRows<{ id: string }>(
      tx,
      sql`
      SELECT newer.id FROM preference_registry_revisions newer
      JOIN preference_registry_revisions original ON original.id=${review.revisionId}::uuid
        AND original.account_id=${context.accountId}::uuid AND original.preference_id=${review.skillId}::uuid
      WHERE newer.account_id=original.account_id AND newer.preference_id=original.preference_id
        AND newer.revision>original.revision LIMIT 1`,
    );
    if (
      newer ||
      record.scopeVersion !== review.expectedScopeVersion ||
      record.activeRevisionId !== review.expectedRevisionId
    )
      return "superseded" as const;
    return "pending" as const;
  };
  return context.subjectId
    ? withWorkspaceSubjectRls(db, context.workspaceId, context.subjectId, run)
    : withWorkspaceRls(db, context.workspaceId, run);
}
