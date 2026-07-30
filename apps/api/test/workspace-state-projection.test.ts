import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS,
  WORKSPACE_STATE_MAX_BASES,
  WORKSPACE_STATE_MAX_TOPICS,
  WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
  type WorkspaceInstructionPolicyHead,
  type WorkspaceInstructionPolicyListResponse,
} from "@opengeni/contracts";
import type { WorkspaceStateMemoryRecord } from "@opengeni/db";
import type { DocumentInventory } from "@opengeni/documents";

import { projectWorkspaceState } from "../src/workspace-state-projection";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-07-30T12:00:00.000Z";

function id(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function base(
  sequence: number,
  name = `Base ${sequence}`,
  overrides: Partial<DocumentInventory["bases"][number]> = {},
): DocumentInventory["bases"][number] {
  return {
    id: id(100 + sequence),
    name,
    visibleDocumentCount: 0,
    statusCounts: { queued: 0, indexing: 0, ready: 0, failed: 0 },
    latestUpdatedAt: null,
    ...overrides,
  };
}

function memory(
  sequence: number,
  overrides: Partial<WorkspaceStateMemoryRecord> = {},
): WorkspaceStateMemoryRecord {
  return {
    id: id(3_000 + sequence),
    status: "active",
    kind: "semantic",
    updatedAt: NOW,
    ...overrides,
  };
}

function head(sequence: number): WorkspaceInstructionPolicyHead {
  return {
    workspaceId: WORKSPACE_ID,
    kind: "policy",
    scope: "role",
    roleKey: `role-${String(sequence).padStart(2, "0")}`,
    revisionId: id(4_000 + sequence),
    revision: sequence + 1,
    contentHash: sequence.toString(16).padStart(64, "0"),
    activationVersion: 1,
    activatedAt: NOW,
  };
}

function policies(
  activeHeads: WorkspaceInstructionPolicyHead[] = [],
): WorkspaceInstructionPolicyListResponse {
  return {
    revisions: [
      {
        id: id(4_999),
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        kind: "charter",
        scope: "global",
        roleKey: null,
        revision: 99,
        contentHash: "a".repeat(64),
        content: "SECRET POLICY CONTENT",
        provenance: { source: "knowledge_proposal", sourceId: "secret-provenance-id" },
        supersedesRevisionId: null,
        createdBySubjectId: "secret-actor",
        createdAt: NOW,
      },
    ],
    activeHeads,
    activationEvents: [],
    nextAfterRevision: null,
  };
}

describe("workspace state projection", () => {
  test("does not leak knowledge counts or raw policy/runtime content without knowledge access", () => {
    const projected = projectWorkspaceState({
      workspaceId: WORKSPACE_ID,
      generatedAt: NOW,
      workspaceAgentInstructions: "SECRET LEGACY RUNTIME INSTRUCTIONS",
      policies: policies(),
      knowledge: null,
    });

    expect(projected.knowledge).toEqual({
      availability: "unavailable",
      reason: "missing_permission",
      requiredPermission: "documents:search",
    });
    expect(projected.policy.latestRevision).toMatchObject({
      revision: 99,
      provenanceSource: "knowledge_proposal",
      state: "inactive",
    });
    expect(projected.policy.legacyRuntime).toEqual({
      source: "workspace_override",
      workspaceOverrideConfigured: true,
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("secret-provenance-id");
    expect(serialized).not.toContain("secret-actor");
    expect(projected.truth.policySnapshot.status).toBe("not_captured");
  });

  test("bounds, sanitizes, sorts, and labels partial aggregate coverage deterministically", () => {
    const bases = Array.from({ length: WORKSPACE_STATE_MAX_BASES + 1 }, (_, index) =>
      base(
        index,
        index === 0 ? `  Primary   ${"x".repeat(300)}  ` : `Base ${index}`,
        index === 0
          ? {
              visibleDocumentCount: 3,
              statusCounts: { queued: 1, indexing: 0, ready: 1, failed: 1 },
              latestUpdatedAt: NOW,
            }
          : {},
      ),
    );
    const documents: DocumentInventory = {
      baseCount: WORKSPACE_STATE_MAX_BASES + 1,
      bases,
      visibleDocumentCount: 4,
      statusCounts: { queued: 1, indexing: 0, ready: 2, failed: 1 },
      sourceKindCounts: {
        manual_upload: 0,
        meeting_transcript: 0,
        repository: 1,
        email: 0,
        chat: 0,
        document: 3,
        web: 0,
        other: 0,
      },
      latestUpdatedAt: NOW,
      topics: Array.from({ length: WORKSPACE_STATE_MAX_TOPICS }, (_, index) => ({
        name: index === 0 ? "  Operations   Runbooks  " : `Topic ${String(index).padStart(2, "0")}`,
        documentCount: index === 0 ? 2 : 1,
      })),
      topicsTruncated: true,
    };
    const memories = Array.from({ length: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT + 1 }, (_, index) =>
      memory(index, index === 0 ? { status: "proposed", kind: "decision" } : {}),
    );
    const activeHeads = Array.from(
      { length: WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS + 1 },
      (_, index) => head(index),
    );

    const projected = projectWorkspaceState({
      workspaceId: WORKSPACE_ID,
      generatedAt: NOW,
      workspaceAgentInstructions: null,
      policies: policies(activeHeads),
      knowledge: { documents, memories },
    });

    expect(projected.policy.activeHeads).toHaveLength(WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS);
    expect(projected.policy.activeHeadsTruncated).toBe(true);
    expect(projected.knowledge.availability).toBe("available");
    if (projected.knowledge.availability !== "available") throw new Error("expected inventory");
    expect(projected.knowledge).toMatchObject({
      coverage: "partial",
      baseCount: WORKSPACE_STATE_MAX_BASES + 1,
      basesTruncated: true,
      inspectedVisibleDocumentCount: 4,
      documentStatusCounts: { queued: 1, indexing: 0, ready: 2, failed: 1 },
      memorySample: {
        recordCount: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
        limitReached: true,
        statusCounts: { proposed: 1, active: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT - 1 },
        kindCounts: { decision: 1, semantic: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT - 1 },
        preferenceAuthority: {
          kindCountSource: "knowledge_memories_legacy_observations",
          activeAuthority: "structured_preference_registry",
        },
      },
    });
    expect(projected.knowledge.bases).toHaveLength(WORKSPACE_STATE_MAX_BASES);
    expect(projected.knowledge.bases[0]!.name.length).toBeLessThanOrEqual(160);
    expect(projected.knowledge.bases[0]!.name.startsWith("Primary x")).toBe(true);
    expect(projected.knowledge.topics).toHaveLength(WORKSPACE_STATE_MAX_TOPICS);
    expect(projected.knowledge.topicsTruncated).toBe(true);
    expect(projected.knowledge.topics[0]).toEqual({
      name: "Operations Runbooks",
      documentCount: 2,
    });
    expect(projected.knowledge.gaps.map((gap) => gap.code)).toEqual([
      "failed_documents",
      "processing_documents",
      "pending_memory_review",
      "partial_inventory",
    ]);
    expect(JSON.stringify(projected)).not.toContain("sourceRefs");
  });
});
