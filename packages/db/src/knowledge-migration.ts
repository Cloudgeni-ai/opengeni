import { prepareLegacySkillFolder } from "./skill-metadata-migration";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import {
  KnowledgeEntryContent,
  KnowledgeSourceSyncAction,
  knowledgeSourceAgentConfig,
  StoredKnowledgeEntryContent,
  type KnowledgeEntryScope,
} from "@opengeni/contracts";
import {
  fromPostgresLosslessText,
  toPostgresLosslessJson,
  toPostgresLosslessText,
  LOSSLESS_CONTENT_CODEC_VERSION,
} from "./lossless-json";

/** Maintenance-only conversion. It is not a runtime fallback or a second writer. */
export const KNOWLEDGE_MIGRATION_MARKER = "-- opengeni:unified-knowledge-copy-v1";
export function knowledgeMigrationId(kind: string, id: string): string {
  const hash = createHash("sha256")
    .update(`opengeni:knowledge:0460:${kind}:${id}`)
    .digest("hex")
    .slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}
type Owner = {
  accountId: string;
  workspaceId: string;
  scope: KnowledgeEntryScope;
  subjectId: string | null;
};
type Imported = Owner & {
  id: string;
  body: KnowledgeEntryContent;
  createdAt: Date;
  status: string;
  sessionId?: string | null;
  memoryId?: string;
  documentId?: string;
  legacySnapshot?: Record<string, unknown>;
  legacyDocumentVersionId?: string;
  legacyClaimId?: string;
  legacyScopeWorkspaceId?: string | null;
  originalActor?: Record<string, unknown>;
  legacyScopeType?: string;
  roleKey?: string | null;
  scopeSessionId?: string | null;
  validFrom?: Date;
  validUntil?: Date | null;
};
type LegacyMemory = {
  id: string;
  account_id: string;
  workspace_id: string;
  text: string;
  text_codec_version: number | null;
  kind: string;
  status: string;
  scope_type: string;
  scope_subject_id: string | null;
  scope_role_key: string | null;
  scope_session_id: string | null;
  created_by_session_id: string | null;
  namespace: string;
  labels: string[];
  created_at: Date;
  valid_from: Date;
  valid_until: Date | null;
  snapshot: Record<string, unknown>;
  relationships: Array<{ entryId: string; relation: string }>;
  confirmed_claim_id: string | null;
};
type LegacyDocument = {
  id: string;
  account_id: string;
  workspace_id: string;
  file_id: string;
  base_id: string;
  base_name: string;
  title: string;
  authority_kind: KnowledgeEntryScope;
  authority_subject_id: string | null;
  source_uri: string | null;
  source_external_id: string | null;
  source_version: string | null;
  created_at: Date;
};

/** Resolve only identities that still exist; missing evidence stays in the audit snapshot. */
async function migrateMemoryEvidence(
  tx: postgres.TransactionSql,
  memory: LegacyMemory,
): Promise<KnowledgeEntryContent["evidence"]> {
  const evidence: KnowledgeEntryContent["evidence"] = [];
  const references = memory.snapshot.source_refs;
  if (!Array.isArray(references)) return evidence;
  for (const ref of references) {
    if (
      !ref ||
      typeof ref !== "object" ||
      typeof ref.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.id)
    )
      continue;
    let entryId: string | undefined;
    let passage: string | undefined;
    if (ref.kind === "memory") {
      const [found] =
        await tx`SELECT id FROM knowledge_memories WHERE account_id=${memory.account_id} AND id=${ref.id}`;
      if (found && found.id !== memory.id) entryId = String(found.id);
    } else if (ref.kind === "document" || ref.kind === "document_chunk") {
      const [doc] =
        ref.kind === "document_chunk"
          ? await tx`SELECT d.id,d.status FROM document_chunks c JOIN documents d ON d.id=c.document_id AND d.account_id=c.account_id
            WHERE c.account_id=${memory.account_id} AND c.id=${ref.id}`
          : await tx`SELECT id,status FROM documents WHERE account_id=${memory.account_id} AND id=${ref.id}`;
      if (doc) {
        const [version] =
          await tx`SELECT id FROM knowledge_document_versions WHERE account_id=${memory.account_id}
          AND document_id=${doc.id} ORDER BY created_at DESC,id DESC LIMIT 1`;
        // Only these identities are imported below. Failed/queued ordinary
        // documents have no canonical source yet; preserve their exact reference
        // in legacySnapshot instead of creating a dangling evidence edge.
        if (version || doc.status === "ready")
          entryId = knowledgeMigrationId(
            version ? "document-version" : "document",
            String(version?.id ?? doc.id),
          );
        if (ref.kind === "document_chunk") passage = `Legacy passage ${ref.id}`;
      }
    }
    if (
      entryId &&
      !evidence.some((item) => item.entryId === entryId && item.location.passage === passage)
    ) {
      evidence.push({
        entryId,
        revisionId: knowledgeMigrationId("revision", entryId),
        location: passage ? { passage } : {},
      });
    }
  }
  return evidence;
}

async function importEntry(tx: postgres.TransactionSql, input: Imported) {
  const body = StoredKnowledgeEntryContent.parse(input.body);
  const revisionId = knowledgeMigrationId("revision", input.id);
  const outcome = ["active", "approved", "ready"].includes(input.status)
    ? "published"
    : input.status === "proposed"
      ? "pending"
      : "rejected";
  const archived = !["active", "approved", "ready", "proposed"].includes(input.status);
  const migrationActor = { kind: "migration", subjectId: "service:knowledge-migration:0460" };
  const actor = input.originalActor ?? migrationActor;
  const batchId =
    outcome === "pending"
      ? knowledgeMigrationId(
          "review-batch",
          `${input.accountId}:${input.workspaceId}:${input.scope}:${input.subjectId ?? ""}:${input.sessionId ?? input.id}`,
        )
      : null;
  if (batchId)
    await tx`INSERT INTO knowledge_review_batches(id,account_id,origin_workspace_id,owner_key,session_id,created_at)
    VALUES(${batchId},${input.accountId},${input.workspaceId},${input.scope === "personal" ? `personal:${input.subjectId}` : `${input.scope}:${input.workspaceId}`},
      ${input.sessionId ?? null},${input.createdAt}) ON CONFLICT(id) DO NOTHING`;
  await tx`INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id,scope_subject_id,
    version,published_revision_id,latest_revision_id,archived,legacy_memory_id,legacy_document_id,
    legacy_scope_type,legacy_scope_role_key,legacy_scope_session_id,legacy_document_version_id,legacy_claim_id,legacy_scope_workspace_id,valid_from,valid_until,created_at,updated_at)
    VALUES(${input.id},${input.accountId},${input.workspaceId},${input.scope},${input.scope === "workspace" ? input.workspaceId : null},
      ${input.subjectId},1,${outcome === "published" ? revisionId : null},${revisionId},${archived},${input.memoryId ?? null},${input.documentId ?? null},
      ${input.legacyScopeType ?? null},${input.roleKey ?? null},${input.scopeSessionId ?? null},${input.legacyDocumentVersionId ?? null},${input.legacyClaimId ?? null},${input.legacyScopeWorkspaceId ?? null},${input.validFrom ?? input.createdAt},
      ${input.validUntil ?? null},${input.createdAt},${input.createdAt})`;
  await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,body_codec_version,preview,preview_codec_version,
    actor,created_by_session_id,review_batch_id,legacy_snapshot,created_at)
    VALUES(${revisionId},${input.accountId},${input.id},1,${tx.json(toPostgresLosslessJson(body) as postgres.JSONValue)},
      ${LOSSLESS_CONTENT_CODEC_VERSION},${toPostgresLosslessText(body.content.slice(0, 512))},${LOSSLESS_CONTENT_CODEC_VERSION},
      ${tx.json(actor as postgres.JSONValue)},${input.sessionId ?? null},${batchId},${input.legacySnapshot ? tx.json(input.legacySnapshot as postgres.JSONValue) : null},${input.createdAt})`;
  await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,created_at)
    VALUES(${input.accountId},${input.id},${revisionId},1,${outcome},${tx.json(migrationActor)},${input.createdAt})`;
  await tx`SELECT knowledge_index_revision(${input.accountId},${input.id},${revisionId},
    ${toPostgresLosslessText(`${body.title}\n${body.content}`)})`;
}

async function importGroup(
  tx: postgres.TransactionSql,
  owner: Owner,
  title: string,
  sourceKey: string,
) {
  const id = knowledgeMigrationId(
    "group",
    `${owner.accountId}:${owner.scope}:${owner.scope === "workspace" ? owner.workspaceId : (owner.subjectId ?? "")}:${sourceKey}`,
  );
  const [existing] = await tx`SELECT id FROM knowledge_entries WHERE id=${id}`;
  if (!existing)
    await importEntry(tx, {
      ...owner,
      id,
      status: "ready",
      createdAt: new Date(),
      body: { title, kind: "group", content: "", groupIds: [], evidence: [], relationships: [] },
    });
  return id;
}

/** Pending pre-Skill preference proposals stay in their native authority. A new
 * folder revision preserves the exact original body and links to the old revision;
 * conversion never activates a proposal or reuses its old human confirmation. */
async function migratePendingLegacySkills(tx: postgres.TransactionSql): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const candidates: Array<{
      id: string;
      workspace_id: string;
      account_id: string;
      preference_id: string;
      revision_id: string;
      content: string;
      title: string;
      description: string;
      session_id: string;
      active_revision_id: string | null;
      scope_version: number;
    }> = await tx<
      Array<{
        id: string;
        workspace_id: string;
        account_id: string;
        preference_id: string;
        revision_id: string;
        content: string;
        title: string;
        description: string;
        session_id: string;
        active_revision_id: string | null;
        scope_version: number;
      }>
    >`
      SELECT receipt.id,receipt.workspace_id,receipt.account_id,receipt.preference_id,receipt.revision_id,
        revision.content,revision.title,revision.description,receipt.session_id,head.active_revision_id,head.scope_version
      FROM company_brain_preference_proposal_receipts receipt
      JOIN preference_registry_preferences head ON head.id=receipt.preference_id AND head.account_id=receipt.account_id
      JOIN preference_registry_revisions revision ON revision.id=receipt.revision_id AND revision.preference_id=head.id
      JOIN knowledge_change_proposals proposal ON proposal.id=receipt.knowledge_proposal_id AND proposal.account_id=receipt.account_id
      WHERE (${after}::uuid IS NULL OR receipt.id>${after}::uuid)
        AND revision.skill_files IS NULL AND head.status NOT IN ('rejected','superseded')
        AND proposal.status='proposed' AND proposal.target_kind='preference'
        AND head.scope='workspace' AND head.scope_workspace_id=receipt.workspace_id
        AND proposal.scope_workspace_id=receipt.workspace_id AND proposal.target_scope='workspace'
        AND coalesce((SELECT review.state FROM knowledge_claim_reviews review WHERE review.claim_id=proposal.claim_id
          AND review.account_id=receipt.account_id ORDER BY review.review_revision DESC LIMIT 1),'proposed') IN ('proposed','approved')
        AND NOT EXISTS(SELECT 1 FROM preference_registry_events event WHERE event.preference_id=head.id
          AND event.new_revision_id=revision.id AND event.type IN ('activated','corrected','rejected'))
        AND NOT EXISTS(SELECT 1 FROM preference_registry_revisions newer WHERE newer.preference_id=head.id
          AND newer.revision>revision.revision AND newer.created_by_subject_id<>'service:skill-migration:0433')
      ORDER BY receipt.id LIMIT 100`;
    if (!candidates.length) break;
    for (const candidate of candidates) {
      const folder = prepareLegacySkillFolder([{ path: "SKILL.md", content: candidate.content }], {
        id: candidate.preference_id,
        title: candidate.title,
        description: candidate.description,
      });
      const main = folder.files.find((file) => file.path === "SKILL.md")!.content;
      const revisionId = knowledgeMigrationId("pending-skill-revision", candidate.id);
      const operationId = knowledgeMigrationId("pending-skill-operation", candidate.id);
      await tx`INSERT INTO preference_registry_revisions(id,account_id,preference_id,title,description,content,content_hash,
        precedence_rank,conflict_strategy,conflicts_with,provenance_source,provenance_source_id,trust,expires_at,
        created_by_subject_id,corrects_revision_id,skill_files,skill_activation_mode)
        SELECT ${revisionId}::uuid,account_id,preference_id,${folder.name},${folder.description},${main},
          ${createHash("sha256").update(main, "utf8").digest("hex")},precedence_rank,conflict_strategy,conflicts_with,
          provenance_source,provenance_source_id,trust,expires_at,'service:knowledge-migration:0460',id,
          ${tx.json(folder.files)},'workspace_managed'
        FROM preference_registry_revisions WHERE id=${candidate.revision_id}::uuid`;
      await tx`INSERT INTO skill_write_receipts(account_id,workspace_id,operation_id,fingerprint,actor,receipt)
        VALUES(${candidate.account_id}::uuid,${candidate.workspace_id}::uuid,${operationId}::uuid,
          ${createHash("sha256").update(operationId).digest("hex")},
          ${tx.json({
            kind: "migration",
            subjectId: "service:knowledge-migration:0460",
            legacyProposalReceiptId: candidate.id,
            legacyRevisionId: candidate.revision_id,
            sessionId: candidate.session_id,
          })},
          ${tx.json({
            operationId,
            skillId: candidate.preference_id,
            revisionId,
            outcome: "pending",
            pendingReason: "approval",
            replayed: false,
          })})`;
    }
    after = candidates.at(-1)!.id;
  }
}

/** All source and destination FORCE-RLS windows are explicit in the SQL file. */
export async function migrateRetainedKnowledge(tx: postgres.TransactionSql): Promise<void> {
  await migratePendingLegacySkills(tx);
  await migrateSourceSchedules(tx);
  let after: string | null = null;
  for (;;) {
    const memories: LegacyMemory[] = await tx<
      LegacyMemory[]
    >`SELECT m.id,m.account_id,m.workspace_id,m.text,m.text_codec_version,m.kind,m.status,m.scope_type,m.scope_subject_id,
      m.scope_role_key,m.scope_session_id,m.created_by_session_id,
      (SELECT r.claim_id FROM remember_knowledge_memory_materializations map
        JOIN remember_knowledge_confirmation_receipts r ON r.id=map.confirmation_receipt_id
        WHERE map.account_id=m.account_id AND map.memory_id=m.id) AS confirmed_claim_id,m.namespace_key AS namespace,m.labels,m.created_at,m.valid_from,m.valid_until,
      (to_jsonb(m)-'embedding'-'text') || jsonb_build_object('relationships',coalesce((SELECT jsonb_agg(to_jsonb(edge) ORDER BY edge.id)
        FROM knowledge_memory_relationships edge WHERE edge.account_id=m.account_id
          AND (edge.source_memory_id=m.id OR edge.target_memory_id=m.id)),'[]'::jsonb),
        'lifecycleEvents',coalesce((SELECT jsonb_agg(to_jsonb(event) ORDER BY event.created_at,event.id)
          FROM knowledge_memory_lifecycle_events event WHERE event.account_id=m.account_id AND event.target_memory_id=m.id),'[]'::jsonb)) AS snapshot,
      coalesce((SELECT jsonb_agg(jsonb_build_object('entryId',edge.target_memory_id,'relation',
        CASE edge.relationship_type WHEN 'derived_from' THEN 'depends_on' WHEN 'corrects' THEN 'supersedes' ELSE edge.relationship_type END)
        ORDER BY edge.id) FROM knowledge_memory_relationships edge
        WHERE edge.account_id=m.account_id AND edge.source_memory_id=m.id AND edge.removed_at IS NULL),'[]'::jsonb) AS relationships
      FROM knowledge_memories m WHERE (${after}::uuid IS NULL OR m.id>${after}::uuid) ORDER BY m.id LIMIT 200`;
    if (!memories.length) break;
    for (const memory of memories) {
      const content = fromPostgresLosslessText(memory.text, memory.text_codec_version);
      const owner: Owner = {
        accountId: memory.account_id,
        workspaceId: memory.workspace_id,
        scope: memory.scope_type === "user" ? "personal" : "workspace",
        subjectId: memory.scope_subject_id,
      };
      // Scope-specific legacy records retain their old selectors; do not put
      // their labels or names in a more broadly visible group during migration.
      const groupIds: string[] = [];
      if (memory.scope_type === "workspace") {
        if (memory.namespace && memory.namespace !== "general")
          groupIds.push(
            await importGroup(tx, owner, memory.namespace, `namespace:${memory.namespace}`),
          );
        for (const label of memory.labels)
          groupIds.push(await importGroup(tx, owner, label, `label:${label}`));
      }
      await importEntry(tx, {
        ...owner,
        id: memory.id,
        memoryId: memory.id,
        ...(memory.confirmed_claim_id ? { legacyClaimId: memory.confirmed_claim_id } : {}),
        legacySnapshot: memory.snapshot,
        originalActor: {
          kind: memory.snapshot.created_by_kind,
          subjectId: memory.snapshot.created_by_subject_id,
          context: memory.snapshot.created_by_context,
        },
        status: memory.status,
        legacyScopeType: memory.scope_type,
        roleKey: memory.scope_role_key,
        scopeSessionId: memory.scope_session_id,
        sessionId: memory.created_by_session_id,
        createdAt: memory.created_at,
        validFrom: memory.valid_from,
        validUntil: memory.valid_until,
        body: {
          title: content.split(/\r?\n/u, 1)[0]?.slice(0, 160) || "Imported knowledge",
          content,
          kind:
            memory.kind === "episodic"
              ? "incident"
              : memory.kind === "semantic"
                ? "fact"
                : memory.kind === "decision"
                  ? "decision"
                  : "note",
          source: { kind: "manual", externalId: `memory:${memory.id}` },
          groupIds: [...new Set(groupIds)],
          evidence: await migrateMemoryEvidence(tx, memory),
          relationships: memory.relationships.map((relationship) => ({
            entryId: relationship.entryId,
            relation:
              relationship.relation as KnowledgeEntryContent["relationships"][number]["relation"],
          })),
        },
      });
    }
    after = memories.at(-1)!.id;
  }
  after = null;
  for (;;) {
    const documents: LegacyDocument[] = await tx<
      LegacyDocument[]
    >`SELECT d.id,d.account_id,d.workspace_id,d.file_id,d.base_id,b.name AS base_name,d.title,d.authority_kind,
      d.authority_subject_id,d.source_uri,d.source_external_id,d.source_version,d.created_at
      FROM documents d JOIN document_bases b ON b.id=d.base_id AND b.account_id=d.account_id
      WHERE d.status='ready' AND NOT EXISTS(SELECT 1 FROM knowledge_document_versions v WHERE v.account_id=d.account_id AND v.document_id=d.id)
        AND (${after}::uuid IS NULL OR d.id>${after}::uuid) ORDER BY d.id LIMIT 50`;
    if (!documents.length) break;
    for (const document of documents) {
      const chunks = await tx<Array<{ text: string }>>`SELECT text FROM document_chunks
        WHERE account_id=${document.account_id} AND document_id=${document.id} ORDER BY chunk_index`;
      const owner: Owner = {
        accountId: document.account_id,
        workspaceId: document.workspace_id,
        scope: document.authority_kind,
        subjectId: document.authority_subject_id,
      };
      const groupIds =
        document.authority_kind === "workspace" && document.base_name
          ? [await importGroup(tx, owner, document.base_name, `document-base:${document.base_id}`)]
          : [];
      await importEntry(tx, {
        ...owner,
        id: knowledgeMigrationId("document", document.id),
        documentId: document.id,
        status: "ready",
        createdAt: document.created_at,
        body: {
          title: document.title,
          kind: "source",
          // Historical chunks may overlap. Preserve every retained passage;
          // never claim to have reconstructed missing original full text.
          content: chunks.map((chunk) => chunk.text).join("\n\n"),
          groupIds,
          evidence: [],
          relationships: [],
          source: {
            kind: "file",
            fileId: document.file_id,
            documentId: document.id,
            retention: "passages",
            ...(document.source_uri ? { uri: document.source_uri } : {}),
            ...(document.source_external_id ? { externalId: document.source_external_id } : {}),
            ...(document.source_version ? { version: document.source_version } : {}),
          },
        },
      });
    }
    after = documents.at(-1)!.id;
  }
  await importScopedKnowledge(tx);
  // Every endpoint exists before relationship constraints are checked.
  await tx`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation,target_revision_id)
    SELECT r.account_id,r.entry_id,r.id,(g.ordinality-1)::integer,g.value::uuid,'group',NULL::uuid
    FROM knowledge_entry_revisions r CROSS JOIN LATERAL jsonb_array_elements_text(r.body->'groupIds') WITH ORDINALITY g(value,ordinality)
    UNION ALL
    SELECT r.account_id,r.entry_id,r.id,jsonb_array_length(r.body->'groupIds')+(l.ordinality-1)::integer,
      (l.value->>'entryId')::uuid,l.value->>'relation',NULL::uuid
    FROM knowledge_entry_revisions r CROSS JOIN LATERAL jsonb_array_elements(r.body->'relationships') WITH ORDINALITY l(value,ordinality)
    UNION ALL
    SELECT r.account_id,r.entry_id,r.id,jsonb_array_length(r.body->'groupIds')+jsonb_array_length(r.body->'relationships')+(e.ordinality-1)::integer,
      (e.value->>'entryId')::uuid,'evidence',(e.value->>'revisionId')::uuid
    FROM knowledge_entry_revisions r CROSS JOIN LATERAL jsonb_array_elements(r.body->'evidence') WITH ORDINALITY e(value,ordinality)`;
}

/** Import the previously separate entity/claim graph into ordinary entries. */
async function importScopedKnowledge(tx: postgres.TransactionSql) {
  type ScopedRow = {
    id: string;
    account_id: string;
    scope_kind: KnowledgeEntryScope;
    scope_workspace_id: string | null;
    scope_subject_id: string | null;
    created_at: Date;
    actor_kind: string;
    actor_subject_id: string;
    initiating_human_subject_id: string | null;
  };
  function owner(row: ScopedRow): Owner {
    return {
      accountId: row.account_id,
      // Some organization/user records never had a creating workspace. This
      // deterministic import origin is provenance only and grants no access.
      workspaceId: row.scope_workspace_id ?? knowledgeMigrationId("import-origin", row.account_id),
      scope: row.scope_kind,
      subjectId: row.scope_subject_id,
    };
  }
  function actor(row: ScopedRow) {
    return {
      kind: row.actor_kind,
      subjectId: row.actor_subject_id,
      initiatingHumanSubjectId: row.initiating_human_subject_id,
    };
  }
  let after: string | null = null;
  for (;;) {
    const entities: Array<
      ScopedRow & { display_name: string; aliases: string[]; snapshot: Record<string, unknown> }
    > = await tx<
      Array<
        ScopedRow & { display_name: string; aliases: string[]; snapshot: Record<string, unknown> }
      >
    >`
      SELECT e.*,to_jsonb(e) AS snapshot,coalesce((SELECT jsonb_agg(a.alias ORDER BY a.id)
        FROM knowledge_entity_aliases a WHERE a.account_id=e.account_id AND a.entity_id=e.id),'[]'::jsonb) AS aliases
      FROM knowledge_entities e WHERE (${after}::uuid IS NULL OR e.id>${after}::uuid)
        AND (NOT EXISTS(SELECT 1 FROM knowledge_facts f JOIN knowledge_claims c ON c.fact_id=f.id
          WHERE f.account_id=e.account_id AND (f.subject_entity_id=e.id OR f.object_entity_id=e.id))
          OR EXISTS(SELECT 1 FROM knowledge_facts f JOIN knowledge_claims c ON c.fact_id=f.id
            WHERE f.account_id=e.account_id AND (f.subject_entity_id=e.id OR f.object_entity_id=e.id)
              AND NOT EXISTS(SELECT 1 FROM knowledge_change_proposals p WHERE p.claim_id=c.id AND p.account_id=c.account_id)))
        ORDER BY e.id LIMIT 200`;
    if (!entities.length) break;
    for (const entity of entities)
      await importEntry(tx, {
        ...owner(entity),
        id: knowledgeMigrationId("entity", entity.id),
        status: "approved",
        createdAt: entity.created_at,
        legacyScopeWorkspaceId: entity.scope_workspace_id,
        originalActor: actor(entity),
        legacySnapshot: { entity: entity.snapshot, aliases: entity.aliases },
        body: {
          title: entity.display_name,
          kind: "group",
          content: entity.aliases.join("\n"),
          groupIds: [],
          evidence: [],
          relationships: [],
        },
      });
    after = entities.at(-1)!.id;
  }
  after = null;
  for (;;) {
    const versions: Array<
      ScopedRow & {
        document_id: string | null;
        file_id: string | null;
        external_version_id: string;
        title: string;
        snapshot: Record<string, unknown>;
        source_uri: string | null;
      }
    > = await tx<
      Array<
        ScopedRow & {
          document_id: string | null;
          file_id: string | null;
          external_version_id: string;
          title: string;
          snapshot: Record<string, unknown>;
          source_uri: string | null;
        }
      >
    >`
      SELECT v.*,coalesce(d.title,o.external_object_id) AS title,s.source_uri,
        jsonb_build_object('version',to_jsonb(v),'source',to_jsonb(s),'object',to_jsonb(o),'provider',to_jsonb(p)) AS snapshot
      FROM knowledge_document_versions v JOIN knowledge_source_objects o ON o.account_id=v.account_id AND o.id=v.object_id
      JOIN knowledge_sources s ON s.account_id=v.account_id AND s.id=v.source_id
      JOIN knowledge_providers p ON p.account_id=s.account_id AND p.id=s.provider_id
      LEFT JOIN documents d ON d.account_id=v.account_id AND d.id=v.document_id
      WHERE (${after}::uuid IS NULL OR v.id>${after}::uuid) ORDER BY v.id LIMIT 100`;
    if (!versions.length) break;
    for (const version of versions) {
      const chunks = version.document_id
        ? await tx<Array<{ text: string }>>`SELECT text FROM document_chunks
        WHERE account_id=${version.account_id} AND document_id=${version.document_id} ORDER BY chunk_index`
        : [];
      await importEntry(tx, {
        ...owner(version),
        id: knowledgeMigrationId("document-version", version.id),
        legacyDocumentVersionId: version.id,
        legacyScopeWorkspaceId: version.scope_workspace_id,
        status: "ready",
        createdAt: version.created_at,
        originalActor: actor(version),
        legacySnapshot: version.snapshot,
        body: {
          title: version.title,
          kind: "source",
          content: chunks.map((c) => c.text).join("\n\n"),
          groupIds: [],
          evidence: [],
          relationships: [],
          source: {
            kind: version.file_id ? "file" : "connector",
            externalId: `knowledge-document-version:${version.id}`,
            version: version.external_version_id,
            retention: chunks.length ? "passages" : "reference",
            ...(version.file_id ? { fileId: version.file_id } : {}),
            ...(version.document_id ? { documentId: version.document_id } : {}),
            ...(version.source_uri ? { uri: version.source_uri } : {}),
          },
        },
      });
    }
    after = versions.at(-1)!.id;
  }
  after = null;
  for (;;) {
    const claims: Array<
      ScopedRow & {
        subject_entity_id: string;
        object_entity_id: string | null;
        subject_name: string;
        object_name: string | null;
        predicate_key: string;
        object_value: unknown;
        state: string;
        extraction_method: string;
        effective_at: Date;
        expires_at: Date | null;
        snapshot: Record<string, unknown>;
      }
    > = await tx<
      Array<
        ScopedRow & {
          subject_entity_id: string;
          object_entity_id: string | null;
          subject_name: string;
          object_name: string | null;
          predicate_key: string;
          object_value: unknown;
          state: string;
          extraction_method: string;
          effective_at: Date;
          expires_at: Date | null;
          snapshot: Record<string, unknown>;
        }
      >
    >`
      SELECT c.*,f.subject_entity_id,f.object_entity_id,f.predicate_key,f.object_value,
        subject.display_name AS subject_name,object.display_name AS object_name,
        coalesce((SELECT state FROM knowledge_claim_reviews r WHERE r.account_id=c.account_id AND r.claim_id=c.id
          ORDER BY r.review_revision DESC LIMIT 1),'proposed') AS state,
        jsonb_build_object('claim',to_jsonb(c),'fact',to_jsonb(f),
          'evidence',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM knowledge_claim_evidence e
            WHERE e.account_id=c.account_id AND e.claim_id=c.id),'[]'::jsonb),
          'reviews',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.review_revision) FROM knowledge_claim_reviews r
            WHERE r.account_id=c.account_id AND r.claim_id=c.id),'[]'::jsonb)) AS snapshot
      FROM knowledge_claims c JOIN knowledge_facts f ON f.account_id=c.account_id AND f.id=c.fact_id
      JOIN knowledge_entities subject ON subject.account_id=f.account_id AND subject.id=f.subject_entity_id
      LEFT JOIN knowledge_entities object ON object.account_id=f.account_id AND object.id=f.object_entity_id
      WHERE (${after}::uuid IS NULL OR c.id>${after}::uuid)
        AND NOT EXISTS(SELECT 1 FROM knowledge_entries imported WHERE imported.legacy_claim_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM knowledge_change_proposals p WHERE p.account_id=c.account_id AND p.claim_id=c.id
          )
      ORDER BY c.id LIMIT 100`;
    if (!claims.length) break;
    for (const claim of claims) {
      const retained = await tx<Array<{ document_version_id: string; locator: string | null }>>`
        SELECT document_version_id,locator FROM knowledge_claim_evidence WHERE account_id=${claim.account_id}
          AND claim_id=${claim.id} AND document_version_id IS NOT NULL ORDER BY id`;
      const relations = await tx<
        Array<{
          to_claim_id: string;
          imported_entry_id: string | null;
          relation_type: "supersedes" | "conflicts_with";
        }>
      >`
        SELECT r.to_claim_id,r.relation_type,(SELECT e.id FROM knowledge_entries e WHERE e.legacy_claim_id=r.to_claim_id) AS imported_entry_id FROM knowledge_claim_relations r
        WHERE r.account_id=${claim.account_id} AND r.from_claim_id=${claim.id}
          AND NOT EXISTS(SELECT 1 FROM knowledge_change_proposals p WHERE p.account_id=r.account_id AND p.claim_id=r.to_claim_id ) ORDER BY r.id`;
      const objectText =
        claim.object_name ??
        (typeof claim.object_value === "string"
          ? claim.object_value
          : JSON.stringify(claim.object_value));
      await importEntry(tx, {
        ...owner(claim),
        id: knowledgeMigrationId("claim", claim.id),
        legacyClaimId: claim.id,
        legacyScopeWorkspaceId: claim.scope_workspace_id,
        status: claim.state,
        createdAt: claim.created_at,
        validFrom: claim.effective_at,
        validUntil: claim.expires_at,
        originalActor: actor(claim),
        legacySnapshot: claim.snapshot,
        body: {
          title: `${claim.subject_name}: ${claim.predicate_key}`,
          kind: "fact",
          content:
            claim.extraction_method === "task-note-promotion-v1" &&
            typeof claim.object_value === "string"
              ? claim.object_value
              : `${claim.subject_name} · ${claim.predicate_key}: ${objectText}`,
          source: { kind: "manual", externalId: `knowledge-claim:${claim.id}` },
          groupIds: [knowledgeMigrationId("entity", claim.subject_entity_id)],
          evidence: retained.map((e) => {
            const id = knowledgeMigrationId("document-version", e.document_version_id);
            return {
              entryId: id,
              revisionId: knowledgeMigrationId("revision", id),
              location: e.locator ? { passage: e.locator } : {},
            };
          }),
          relationships: [
            ...relations.map((r) => ({
              entryId: r.imported_entry_id ?? knowledgeMigrationId("claim", r.to_claim_id),
              relation: r.relation_type,
            })),
            ...(claim.object_entity_id
              ? [
                  {
                    entryId: knowledgeMigrationId("entity", claim.object_entity_id),
                    relation: "related_to" as const,
                  },
                ]
              : []),
          ],
        },
      });
    }
    after = claims.at(-1)!.id;
  }
}

/** Preserve source selection and schedule ids, but create a new ordinary task
 * revision. Old occurrence/history rows remain exact and never become agents. */
async function migrateSourceSchedules(tx: postgres.TransactionSql) {
  await tx`ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY`;
  await tx`ALTER TABLE scheduled_tasks DISABLE TRIGGER scheduled_task_tombstone_immutable`;
  const tasks =
    await tx`SELECT id,account_id,workspace_id,action,authority_revision FROM scheduled_tasks
    WHERE action->>'kind'='knowledge_source_sync' AND deleted_at IS NULL ORDER BY id`;
  for (const task of tasks) {
    const source = KnowledgeSourceSyncAction.parse(task.action);
    await tx`SELECT set_config('opengeni.account_id',${task.account_id},true),
      set_config('opengeni.workspace_id',${task.workspace_id},true),
      set_config('opengeni.subject_id',${source.initiatingSubjectId},true),
      set_config('opengeni.initiating_human_subject_id',${source.initiatingSubjectId},true)`;
    await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended('session-tenancy:'||${task.workspace_id}::text,0))`;
    await tx`SELECT id FROM workspaces WHERE id=${task.workspace_id} FOR UPDATE`;
    const [authority] = await tx`SELECT id FROM organization_memberships m
      WHERE m.account_id=${task.account_id} AND m.subject_id=${source.initiatingSubjectId}
        AND m.status='active' AND m.revoked_at IS NULL
        AND (m.personal_workspace_id=${task.workspace_id} OR EXISTS(SELECT 1 FROM workspace_memberships w
          WHERE w.account_id=m.account_id AND w.workspace_id=${task.workspace_id} AND w.subject_id=m.subject_id))`;
    // Old deterministic occurrences cannot resume as agent work. Preserve their
    // audit rows and checkpoints, close their wakes, and let the next ordinary
    // scheduled run continue from the retained provider cursor.
    await tx`UPDATE scheduled_task_runs SET status='failed',completed_at=clock_timestamp(),
      error='knowledge_source_agent_cutover',updated_at=clock_timestamp()
      WHERE task_id=${task.id} AND action_kind='knowledge_source_sync' AND status IN ('queued','dispatched')`;
    await tx`UPDATE knowledge_source_sync_wakes SET completed_at=clock_timestamp()
      WHERE scheduled_task_id=${task.id} AND completed_at IS NULL`;
    await tx`UPDATE knowledge_source_sync_states SET lease_id=NULL,lease_until=NULL,
      buffered_wake=false,buffered_scheduled_task_run_id=NULL,pending_wake_count=0,updated_at=clock_timestamp()
      WHERE scheduled_task_id=${task.id}`;
    // A former owner's schedule is still useful configuration, but migration
    // cannot invent authority for it. Re-enabling requires a current owner edit.
    if (!authority)
      await tx`UPDATE scheduled_tasks SET status='paused',
      metadata=jsonb_set(metadata,'{knowledgeSourceSync}',coalesce(metadata->'knowledgeSourceSync','{}'::jsonb)
        || '{"sourceEnabled":false,"authorityRefreshRequired":true}'::jsonb) WHERE id=${task.id}`;
    const [updated] = await tx`UPDATE scheduled_tasks SET action='{"kind":"agent_turn"}',
      agent_config=${JSON.stringify(knowledgeSourceAgentConfig(source))}::jsonb, authority_revision=authority_revision+1,
      updated_at=clock_timestamp() WHERE id=${task.id} RETURNING authority_revision`;
    if (!updated) throw new Error("Source schedule disappeared during maintenance");
    await tx`SELECT freeze_scheduled_task_personal_resources(${task.account_id}::uuid,
      ${task.workspace_id}::uuid,${task.id}::uuid,${updated.authority_revision}::bigint)`;
    if (authority)
      await tx`SELECT record_scheduled_task_revision_authority(${task.account_id}::uuid,
      ${task.workspace_id}::uuid,${task.id}::uuid,${updated.authority_revision}::bigint)`;
  }
  await tx`ALTER TABLE scheduled_tasks ENABLE TRIGGER scheduled_task_tombstone_immutable`;
  await tx`ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY`;
  await tx`SELECT set_config('opengeni.account_id','',true),set_config('opengeni.workspace_id','',true),
    set_config('opengeni.subject_id','',true),set_config('opengeni.initiating_human_subject_id','',true)`;
}
