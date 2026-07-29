import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS,
  WORKSPACE_STATE_MAX_BASES,
  WORKSPACE_STATE_MAX_TOPICS,
  WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
  type Document,
  type DocumentBase,
  type KnowledgeMemory,
  type WorkspaceInstructionPolicyHead,
  type WorkspaceInstructionPolicyListResponse,
} from "@opengeni/contracts";

import { projectWorkspaceState } from "../src/workspace-state-projection";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-07-30T12:00:00.000Z";

function id(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function base(sequence: number, name = `Base ${sequence}`): DocumentBase {
  return {
    id: id(100 + sequence),
    workspaceId: WORKSPACE_ID,
    name,
    description: `private description ${sequence}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function document(sequence: number, baseId: string, overrides: Partial<Document> = {}): Document {
  return {
    id: id(1_000 + sequence),
    workspaceId: WORKSPACE_ID,
    baseId,
    fileId: id(2_000 + sequence),
    status: "ready",
    title: `secret title ${sequence}`,
    parser: "secret parser",
    chunkCount: 2,
    error: "secret error body",
    sourceKind: "document",
    sourceUri: "https://secret.example/document",
    sourceExternalId: "secret external id",
    sourceTitle: "secret source title",
    sourceAuthor: "secret author",
    sourceCreatedAt: NOW,
    sourceUpdatedAt: NOW,
    sourceVersion: "secret version",
    aclTags: ["secret-acl"],
    visibility: "workspace",
    createdBy: "secret subject",
    agentAccess: true,
    summary: "secret summary",
    topics: ["Operations"],
    curationStatus: "none",
    curation: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function memory(sequence: number, overrides: Partial<KnowledgeMemory> = {}): KnowledgeMemory {
  return {
    id: id(3_000 + sequence),
    workspaceId: WORKSPACE_ID,
    status: "active",
    kind: "semantic",
    scope: "workspace",
    text: `secret memory text ${sequence}`,
    sourceRefs: [{ kind: "external", id: "secret", uri: "https://secret.example" }],
    confidence: 0.9,
    metadata: { fixture: "private metadata" },
    createdBySessionId: null,
    reviewedBy: null,
    reviewedAt: null,
    pinned: false,
    usageCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    supersededById: null,
    validFrom: NOW,
    validUntil: null,
    createdAt: NOW,
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
      base(index, index === 0 ? `  Primary   ${"x".repeat(300)}  ` : `Base ${index}`),
    );
    const firstDocuments = [
      document(1, bases[0]!.id, {
        topics: Array.from({ length: WORKSPACE_STATE_MAX_TOPICS + 2 }, (_, index) =>
          index === 0 ? "  Operations   Runbooks  " : `Topic ${String(index).padStart(2, "0")}`,
        ),
      }),
      document(2, bases[0]!.id, {
        status: "failed",
        sourceKind: "repository",
        topics: ["Operations Runbooks"],
      }),
      document(3, bases[0]!.id, { status: "queued", topics: [] }),
    ];
    const documentsByBase = new Map<string, Document[]>([[bases[0]!.id, firstDocuments]]);
    documentsByBase.set(bases.at(-1)!.id, [
      document(99, bases.at(-1)!.id, { topics: ["Must not be inspected"] }),
    ]);
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
      knowledge: { bases, documentsByBase, memories },
    });

    expect(projected.policy.activeHeads).toHaveLength(WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS);
    expect(projected.policy.activeHeadsTruncated).toBe(true);
    expect(projected.knowledge.availability).toBe("available");
    if (projected.knowledge.availability !== "available") throw new Error("expected inventory");
    expect(projected.knowledge).toMatchObject({
      coverage: "partial",
      baseCount: WORKSPACE_STATE_MAX_BASES + 1,
      basesTruncated: true,
      inspectedVisibleDocumentCount: 3,
      documentStatusCounts: { queued: 1, indexing: 0, ready: 1, failed: 1 },
      memorySample: {
        recordCount: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
        limitReached: true,
        statusCounts: { proposed: 1, active: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT - 1 },
        kindCounts: { decision: 1, semantic: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT - 1 },
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
    const serialized = JSON.stringify(projected);
    for (const secret of [
      "secret title",
      "secret parser",
      "secret error",
      "secret.example",
      "secret-acl",
      "secret summary",
      "secret memory text",
      "Must not be inspected",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
