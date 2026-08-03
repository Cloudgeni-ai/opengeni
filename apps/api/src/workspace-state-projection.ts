import { createHash } from "node:crypto";
import {
  KnowledgeMemoryKind,
  KnowledgeMemoryStatus,
  WORKSPACE_STATE_BASE_NAME_MAX_CHARS,
  WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS,
  WORKSPACE_STATE_MAX_BASES,
  WORKSPACE_STATE_MAX_GAPS,
  WORKSPACE_STATE_MAX_TOPICS,
  WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
  WORKSPACE_STATE_TOPIC_MAX_CHARS,
  WorkspaceStateResponse,
  type WorkspaceInstructionPolicyListResponse,
  type WorkspaceInstructionPolicySnapshot,
  type WorkspaceStateGovernanceDriftStatus,
  type WorkspaceStateGap,
  type WorkspaceStateMemoryKindCounts,
  type WorkspaceStateMemoryStatusCounts,
  type WorkspaceStateResponse as WorkspaceStateResponseType,
} from "@opengeni/contracts";
import type { WorkspaceStateMemoryRecord } from "@opengeni/db";
import type { DocumentInventory } from "@opengeni/documents";

type KnowledgeProjectionInput = {
  documents: DocumentInventory;
  memories: WorkspaceStateMemoryRecord[];
};

type PreferenceGovernanceIdentity = {
  id: string;
  revisionId: string;
  contentHash: string;
  activeVersion: number;
  scope: "organization" | "workspace" | "user";
};

type AttemptGovernanceProjectionInput =
  | { status: "unavailable" }
  | {
      status: "available";
      attemptId: string;
      executionGeneration: number;
      acceptedAt: string;
      policySnapshot: WorkspaceInstructionPolicySnapshot | null;
      preferenceSnapshot: {
        id: string;
        descriptorHash: string;
        descriptors: PreferenceGovernanceIdentity[];
        truncated: boolean;
        createdAt: string;
      } | null;
      currentPreferences: {
        descriptors: PreferenceGovernanceIdentity[];
        truncated: boolean;
      };
    };

export type WorkspaceStateProjectionInput = {
  workspaceId: string;
  generatedAt: string;
  workspaceAgentInstructions: string | null;
  policies: WorkspaceInstructionPolicyListResponse;
  knowledge: KnowledgeProjectionInput | null;
  attemptGovernance?: AttemptGovernanceProjectionInput | null;
};

function hashIdentities(values: readonly string[]): string {
  return createHash("sha256").update(values.join("\n"), "utf8").digest("hex");
}

function policyTargetKey(value: { kind: string; scope: string; roleKey: string | null }): string {
  return `${value.kind}:${value.scope}:${value.roleKey ?? ""}`;
}

function policyTargetKeysForRole(policyRole: string | null): Set<string> {
  const keys = new Set(["charter:global:", "policy:global:"]);
  if (policyRole !== null) keys.add(`policy:role:${policyRole}`);
  return keys;
}

function policyIdentity(value: {
  kind: string;
  scope: string;
  roleKey: string | null;
  revisionId: string;
  contentHash: string;
  activationVersion: number;
}): string {
  return `${policyTargetKey(value)}:${value.revisionId}:${value.contentHash}:${value.activationVersion}`;
}

function preferenceIdentity(value: PreferenceGovernanceIdentity): string {
  return `${value.scope}:${value.id}:${value.revisionId}:${value.contentHash}:${value.activeVersion}`;
}

function classifyIdentityDrift(
  snapshotIdentities: readonly string[],
  currentIdentities: readonly string[],
  snapshotKeys: readonly string[],
  currentKeys: readonly string[],
): "identical" | "changed" | "superseded" {
  if (snapshotIdentities.join("\n") === currentIdentities.join("\n")) return "identical";
  return snapshotKeys.join("\n") === currentKeys.join("\n") ? "superseded" : "changed";
}

function overallDriftStatus(
  policy: WorkspaceStateGovernanceDriftStatus,
  preferences: WorkspaceStateGovernanceDriftStatus,
): WorkspaceStateGovernanceDriftStatus {
  for (const status of ["unavailable", "truncated", "missing", "changed", "superseded"] as const) {
    if (policy === status || preferences === status) return status;
  }
  return "identical";
}

function attemptGovernanceProjection(input: WorkspaceStateProjectionInput) {
  const governance = input.attemptGovernance ?? null;
  if (governance === null) return { status: "not_requested" as const };
  if (governance.status === "unavailable") {
    return {
      status: "unavailable" as const,
      reason: "attempt_not_found_or_not_authorized" as const,
      driftStatus: "unavailable" as const,
    };
  }

  const policySnapshot = governance.policySnapshot;
  let policyStatus: WorkspaceStateGovernanceDriftStatus = "missing";
  let policySnapshotHash: string | null = null;
  let policyCurrentHash: string | null = null;
  let policySnapshotTargetCount = 0;
  let policyCurrentTargetCount = 0;
  if (policySnapshot) {
    const snapshotEntries = [...policySnapshot.entries].sort((left, right) =>
      policyTargetKey(left).localeCompare(policyTargetKey(right)),
    );
    const snapshotKeys = snapshotEntries.map(policyTargetKey);
    const relevantTargetKeys = policyTargetKeysForRole(policySnapshot.policyRole);
    const currentEntries = input.policies.activeHeads
      .filter((head) => relevantTargetKeys.has(policyTargetKey(head)))
      .sort((left, right) => policyTargetKey(left).localeCompare(policyTargetKey(right)));
    const snapshotIdentities = snapshotEntries.map(policyIdentity);
    const currentIdentities = currentEntries.map(policyIdentity);
    const currentKeys = currentEntries.map(policyTargetKey);
    policyStatus = classifyIdentityDrift(
      snapshotIdentities,
      currentIdentities,
      snapshotKeys,
      currentKeys,
    );
    policySnapshotHash = hashIdentities(snapshotIdentities);
    policyCurrentHash = hashIdentities(currentIdentities);
    policySnapshotTargetCount = snapshotEntries.length;
    policyCurrentTargetCount = currentEntries.length;
  }

  const preferenceSnapshot = governance.preferenceSnapshot;
  const currentPreferences = [...governance.currentPreferences.descriptors].sort((left, right) =>
    preferenceIdentity(left).localeCompare(preferenceIdentity(right)),
  );
  let preferenceStatus: WorkspaceStateGovernanceDriftStatus = "missing";
  let preferenceSnapshotHash: string | null = null;
  const currentPreferenceIdentities = currentPreferences.map(preferenceIdentity);
  const currentPreferenceHash = hashIdentities(currentPreferenceIdentities);
  let snapshotPreferenceCount = 0;
  let snapshotPreferenceTruncated = false;
  if (preferenceSnapshot) {
    const snapshotPreferences = [...preferenceSnapshot.descriptors].sort((left, right) =>
      preferenceIdentity(left).localeCompare(preferenceIdentity(right)),
    );
    const snapshotPreferenceIdentities = snapshotPreferences.map(preferenceIdentity);
    const snapshotPreferenceKeys = snapshotPreferences.map((descriptor) => descriptor.id).sort();
    const currentPreferenceKeys = currentPreferences.map((descriptor) => descriptor.id).sort();
    preferenceSnapshotHash = hashIdentities(snapshotPreferenceIdentities);
    snapshotPreferenceCount = snapshotPreferences.length;
    snapshotPreferenceTruncated = preferenceSnapshot.truncated;
    preferenceStatus =
      preferenceSnapshot.truncated || governance.currentPreferences.truncated
        ? "truncated"
        : classifyIdentityDrift(
            snapshotPreferenceIdentities,
            currentPreferenceIdentities,
            snapshotPreferenceKeys,
            currentPreferenceKeys,
          );
  }

  return {
    status: "available" as const,
    attemptId: governance.attemptId,
    executionGeneration: governance.executionGeneration,
    acceptedAt: governance.acceptedAt,
    policySnapshot: policySnapshot
      ? {
          status: "available" as const,
          id: policySnapshot.id,
          createdAt: policySnapshot.createdAt,
          entryHash: policySnapshot.entryHash,
          policyRole: policySnapshot.policyRole,
          roleSource: policySnapshot.roleSource,
          entries: policySnapshot.entries,
        }
      : { status: "missing" as const },
    preferenceSnapshot: preferenceSnapshot
      ? {
          status: "available" as const,
          id: preferenceSnapshot.id,
          createdAt: preferenceSnapshot.createdAt,
          descriptorHash: preferenceSnapshot.descriptorHash,
          descriptorCount: preferenceSnapshot.descriptors.length,
          truncated: preferenceSnapshot.truncated,
        }
      : { status: "missing" as const },
    drift: {
      overall: overallDriftStatus(policyStatus, preferenceStatus),
      policy: {
        status: policyStatus,
        snapshotHash: policySnapshotHash,
        currentHash: policyCurrentHash,
        snapshotTargetCount: policySnapshotTargetCount,
        currentTargetCount: policyCurrentTargetCount,
      },
      preferences: {
        status: preferenceStatus,
        snapshotHash: preferenceSnapshotHash,
        currentHash: currentPreferenceHash,
        snapshotDescriptorCount: snapshotPreferenceCount,
        currentDescriptorCount: currentPreferences.length,
        snapshotTruncated: snapshotPreferenceTruncated,
        currentTruncated: governance.currentPreferences.truncated,
      },
    },
  };
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
  const inventory = knowledge.documents;
  const selectedBases = inventory.bases.slice(0, WORKSPACE_STATE_MAX_BASES);
  const aggregateStatuses = { ...inventory.statusCounts };
  const aggregateSources = { ...inventory.sourceKindCounts };
  const topicCounts = new Map<string, number>();
  const projectedBases = selectedBases.map((base) => {
    return {
      id: base.id,
      name: boundedLabel(base.name, WORKSPACE_STATE_BASE_NAME_MAX_CHARS, "Untitled base"),
      visibleDocumentCount: base.visibleDocumentCount,
      statusCounts: base.statusCounts,
      latestUpdatedAt: base.latestUpdatedAt,
    };
  });

  for (const topic of inventory.topics) {
    const name = boundedLabel(topic.name, WORKSPACE_STATE_TOPIC_MAX_CHARS, "Unlabeled topic");
    topicCounts.set(name, (topicCounts.get(name) ?? 0) + topic.documentCount);
  }

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

  const inspectedVisibleDocumentCount = inventory.visibleDocumentCount;
  const basesTruncated = inventory.baseCount > projectedBases.length;
  const memoryLimitReached = memories.length === WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT;
  const inventoryPartial = basesTruncated || inventory.topicsTruncated || memoryLimitReached;
  const gaps: WorkspaceStateGap[] = [];
  const addGap = (gap: WorkspaceStateGap): void => {
    if (gaps.length < WORKSPACE_STATE_MAX_GAPS) gaps.push(gap);
  };
  if (inventory.baseCount === 0) {
    addGap({ code: "no_document_bases", severity: "info", relatedCount: 0 });
  } else if (inspectedVisibleDocumentCount === 0) {
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
  if (inventoryPartial) {
    addGap({ code: "partial_inventory", severity: "info", relatedCount: null });
  }

  return {
    availability: "available" as const,
    coverage: inventoryPartial ? ("partial" as const) : ("complete" as const),
    baseCount: inventory.baseCount,
    bases: projectedBases,
    basesTruncated,
    inspectedVisibleDocumentCount,
    documentStatusCounts: aggregateStatuses,
    sourceKindCounts: aggregateSources,
    topics,
    topicsTruncated: inventory.topicsTruncated || sortedTopics.length > topics.length,
    latestDocumentUpdatedAt: inventory.latestUpdatedAt,
    memorySample: {
      recordCount: memories.length,
      sampleLimit: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
      limitReached: memoryLimitReached,
      statusCounts: memoryStatuses,
      kindCounts: memoryKinds,
      preferenceAuthority: {
        kindCountSource: "knowledge_memories_legacy_observations" as const,
        activeAuthority: "structured_preference_registry" as const,
      },
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
      attemptGovernance: attemptGovernanceProjection(input),
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
