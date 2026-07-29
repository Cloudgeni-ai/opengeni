import {
  KnowledgeMemoryKind,
  KnowledgeMemoryStatus,
  KnowledgeSourceKind,
  WORKSPACE_STATE_BASE_NAME_MAX_CHARS,
  WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS,
  WORKSPACE_STATE_MAX_BASES,
  WORKSPACE_STATE_MAX_GAPS,
  WORKSPACE_STATE_MAX_TOPICS,
  WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
  WORKSPACE_STATE_TOPIC_MAX_CHARS,
  WorkspaceStateResponse,
  type Document,
  type DocumentBase,
  type KnowledgeMemory,
  type WorkspaceInstructionPolicyListResponse,
  type WorkspaceStateDocumentStatusCounts,
  type WorkspaceStateGap,
  type WorkspaceStateMemoryKindCounts,
  type WorkspaceStateMemoryStatusCounts,
  type WorkspaceStateResponse as WorkspaceStateResponseType,
  type WorkspaceStateSourceKindCounts,
} from "@opengeni/contracts";

type KnowledgeProjectionInput = {
  bases: DocumentBase[];
  documentsByBase: ReadonlyMap<string, Document[]>;
  memories: KnowledgeMemory[];
};

export type WorkspaceStateProjectionInput = {
  workspaceId: string;
  generatedAt: string;
  workspaceAgentInstructions: string | null;
  policies: WorkspaceInstructionPolicyListResponse;
  knowledge: KnowledgeProjectionInput | null;
};

function emptyDocumentStatusCounts(): WorkspaceStateDocumentStatusCounts {
  return { queued: 0, indexing: 0, ready: 0, failed: 0 };
}

function emptySourceKindCounts(): WorkspaceStateSourceKindCounts {
  return Object.fromEntries(
    KnowledgeSourceKind.options.map((kind) => [kind, 0]),
  ) as WorkspaceStateSourceKindCounts;
}

function emptyMemoryStatusCounts(): WorkspaceStateMemoryStatusCounts {
  return Object.fromEntries(
    KnowledgeMemoryStatus.options.map((status) => [status, 0]),
  ) as WorkspaceStateMemoryStatusCounts;
}

function emptyMemoryKindCounts(): WorkspaceStateMemoryKindCounts {
  return Object.fromEntries(
    KnowledgeMemoryKind.options.map((kind) => [kind, 0]),
  ) as WorkspaceStateMemoryKindCounts;
}

function boundedLabel(value: string, maxChars: number, fallback: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return (normalized || fallback).slice(0, maxChars);
}

function newestTimestamp(values: Array<string | null>): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest;
    return latest === null || value > latest ? value : latest;
  }, null);
}

function comparePolicyTargets(
  left: WorkspaceInstructionPolicyListResponse["activeHeads"][number],
  right: WorkspaceInstructionPolicyListResponse["activeHeads"][number],
): number {
  return `${left.kind}:${left.scope}:${left.roleKey ?? ""}`.localeCompare(
    `${right.kind}:${right.scope}:${right.roleKey ?? ""}`,
  );
}

function policyProjection(input: WorkspaceStateProjectionInput) {
  const sortedHeads = [...input.policies.activeHeads].sort(comparePolicyTargets);
  const activeHeads = sortedHeads.slice(0, WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS).map((head) => ({
    kind: head.kind,
    scope: head.scope,
    roleKey: head.roleKey,
    revisionId: head.revisionId,
    revision: head.revision,
    contentHash: head.contentHash,
    activationVersion: head.activationVersion,
    activatedAt: head.activatedAt,
  }));
  const newestRevision = input.policies.revisions[0] ?? null;
  return {
    authority: "workspace_instruction_policy_heads" as const,
    activeHeads,
    activeHeadsTruncated: sortedHeads.length > activeHeads.length,
    latestRevision: newestRevision
      ? {
          kind: newestRevision.kind,
          scope: newestRevision.scope,
          roleKey: newestRevision.roleKey,
          revisionId: newestRevision.id,
          revision: newestRevision.revision,
          contentHash: newestRevision.contentHash,
          provenanceSource: newestRevision.provenance.source,
          state: input.policies.activeHeads.some((head) => head.revisionId === newestRevision.id)
            ? ("active" as const)
            : ("inactive" as const),
          createdAt: newestRevision.createdAt,
        }
      : null,
    legacyRuntime: {
      source: input.workspaceAgentInstructions
        ? ("workspace_override" as const)
        : ("deployment_default" as const),
      workspaceOverrideConfigured: Boolean(input.workspaceAgentInstructions),
    },
    runtimeComposition: { status: "not_implemented" as const },
  };
}

function availableKnowledgeProjection(knowledge: KnowledgeProjectionInput) {
  const selectedBases = knowledge.bases.slice(0, WORKSPACE_STATE_MAX_BASES);
  const aggregateStatuses = emptyDocumentStatusCounts();
  const aggregateSources = emptySourceKindCounts();
  const topicCounts = new Map<string, number>();
  const projectedBases = selectedBases.map((base) => {
    const documents = knowledge.documentsByBase.get(base.id) ?? [];
    const statusCounts = emptyDocumentStatusCounts();
    for (const document of documents) {
      statusCounts[document.status] += 1;
      aggregateStatuses[document.status] += 1;
      aggregateSources[document.sourceKind] += 1;
      const topicsInDocument = new Set(
        document.topics.map((topic) =>
          boundedLabel(topic, WORKSPACE_STATE_TOPIC_MAX_CHARS, "Unlabeled topic"),
        ),
      );
      for (const topic of topicsInDocument) {
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
      }
    }
    return {
      id: base.id,
      name: boundedLabel(base.name, WORKSPACE_STATE_BASE_NAME_MAX_CHARS, "Untitled base"),
      visibleDocumentCount: documents.length,
      statusCounts,
      latestUpdatedAt: newestTimestamp(documents.map((document) => document.updatedAt)),
    };
  });

  const sortedTopics = [...topicCounts.entries()]
    .sort(
      ([leftName, leftCount], [rightName, rightCount]) =>
        rightCount - leftCount || leftName.localeCompare(rightName),
    )
    .map(([name, documentCount]) => ({ name, documentCount }));
  const topics = sortedTopics.slice(0, WORKSPACE_STATE_MAX_TOPICS);
  const memories = knowledge.memories.slice(0, WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT);
  const memoryStatuses = emptyMemoryStatusCounts();
  const memoryKinds = emptyMemoryKindCounts();
  for (const memory of memories) {
    memoryStatuses[memory.status] += 1;
    memoryKinds[memory.kind] += 1;
  }

  const inspectedVisibleDocumentCount = projectedBases.reduce(
    (total, base) => total + base.visibleDocumentCount,
    0,
  );
  const basesTruncated = knowledge.bases.length > projectedBases.length;
  const memoryLimitReached = memories.length === WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT;
  const gaps: WorkspaceStateGap[] = [];
  const addGap = (gap: WorkspaceStateGap): void => {
    if (gaps.length < WORKSPACE_STATE_MAX_GAPS) gaps.push(gap);
  };
  if (knowledge.bases.length === 0) {
    addGap({ code: "no_document_bases", severity: "info", relatedCount: 0 });
  } else if (!basesTruncated && inspectedVisibleDocumentCount === 0) {
    addGap({ code: "no_visible_documents", severity: "info", relatedCount: 0 });
  }
  if (aggregateStatuses.failed > 0) {
    addGap({
      code: "failed_documents",
      severity: "warning",
      relatedCount: aggregateStatuses.failed,
    });
  }
  const processingCount = aggregateStatuses.queued + aggregateStatuses.indexing;
  if (processingCount > 0) {
    addGap({
      code: "processing_documents",
      severity: "info",
      relatedCount: processingCount,
    });
  }
  if (aggregateStatuses.ready > 0 && sortedTopics.length === 0) {
    addGap({
      code: "missing_topic_coverage",
      severity: "info",
      relatedCount: aggregateStatuses.ready,
    });
  }
  if (memories.length === 0) {
    addGap({ code: "no_memory_records", severity: "info", relatedCount: 0 });
  }
  if (memoryStatuses.proposed > 0) {
    addGap({
      code: "pending_memory_review",
      severity: "info",
      relatedCount: memoryStatuses.proposed,
    });
  }
  if (basesTruncated || memoryLimitReached) {
    addGap({ code: "partial_inventory", severity: "info", relatedCount: null });
  }

  return {
    availability: "available" as const,
    coverage: basesTruncated || memoryLimitReached ? ("partial" as const) : ("complete" as const),
    baseCount: knowledge.bases.length,
    bases: projectedBases,
    basesTruncated,
    inspectedVisibleDocumentCount,
    documentStatusCounts: aggregateStatuses,
    sourceKindCounts: aggregateSources,
    topics,
    topicsTruncated: sortedTopics.length > topics.length,
    latestDocumentUpdatedAt: newestTimestamp(projectedBases.map((base) => base.latestUpdatedAt)),
    memorySample: {
      recordCount: memories.length,
      sampleLimit: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
      limitReached: memoryLimitReached,
      statusCounts: memoryStatuses,
      kindCounts: memoryKinds,
      latestUpdatedAt: newestTimestamp(memories.map((memory) => memory.updatedAt)),
    },
    gaps,
  };
}

export function projectWorkspaceState(
  input: WorkspaceStateProjectionInput,
): WorkspaceStateResponseType {
  return WorkspaceStateResponse.parse({
    workspaceId: input.workspaceId,
    generatedAt: input.generatedAt,
    truth: {
      current: { source: "read_time_projection", capturedAt: input.generatedAt },
      policySnapshot: {
        status: "not_captured",
        reason: "workspace_instruction_policy_snapshot_not_implemented",
      },
    },
    policy: policyProjection(input),
    knowledge: input.knowledge
      ? availableKnowledgeProjection(input.knowledge)
      : {
          availability: "unavailable",
          reason: "missing_permission",
          requiredPermission: "documents:search",
        },
  });
}
