import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS,
  WORKSPACE_STATE_KNOWLEDGE_SAMPLE_LIMIT,
  type KnowledgeEntrySummary,
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

function preferences(
  descriptors: Array<{
    id: string;
    revisionId: string;
    contentHash: string;
    activeVersion: number;
    scope: "organization" | "workspace" | "user";
  }> = [],
  truncated = false,
) {
  return { descriptors, truncated };
}

describe("workspace state projection", () => {
  test("does not leak knowledge counts or raw policy/runtime content without knowledge access", () => {
    const projected = projectWorkspaceState({
      workspaceId: WORKSPACE_ID,
      generatedAt: NOW,
      workspaceAgentInstructions: "SECRET LEGACY RUNTIME INSTRUCTIONS",
      policies: policies(),
      preferences: preferences(),
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
    expect(projected.truth.attemptGovernance.status).toBe("not_requested");
  });

  test("projects immutable attempt metadata and classifies exact, superseded, and truncated drift", () => {
    const policyHead: WorkspaceInstructionPolicyHead = {
      workspaceId: WORKSPACE_ID,
      kind: "policy",
      scope: "global",
      roleKey: null,
      revisionId: id(5_001),
      revision: 2,
      contentHash: "b".repeat(64),
      activationVersion: 2,
      activatedAt: NOW,
    };
    const projected = projectWorkspaceState({
      workspaceId: WORKSPACE_ID,
      generatedAt: NOW,
      workspaceAgentInstructions: null,
      policies: policies([policyHead]),
      preferences: preferences([
        {
          id: id(5_105),
          revisionId: id(5_106),
          contentHash: "e".repeat(64),
          activeVersion: 1,
          scope: "user",
        },
      ]),
      knowledge: null,
      attemptGovernance: {
        status: "available",
        attemptId: id(5_100),
        executionGeneration: 3,
        acceptedAt: "2026-07-29T12:00:00.000Z",
        policySnapshot: {
          id: id(5_101),
          workspaceId: WORKSPACE_ID,
          sessionId: id(5_102),
          turnId: id(5_103),
          attemptId: id(5_100),
          executionGeneration: 3,
          policyRole: null,
          roleSource: "none",
          entryHash: "c".repeat(64),
          entries: [
            {
              kind: "policy",
              scope: "global",
              roleKey: null,
              revisionId: id(5_000),
              revision: 1,
              contentHash: "a".repeat(64),
              activationVersion: 1,
              activatedAt: "2026-07-28T12:00:00.000Z",
              provenance: { source: "human", sourceIdHash: null },
            },
          ],
          createdAt: "2026-07-29T12:00:01.000Z",
        },
        preferenceSnapshot: {
          id: id(5_104),
          descriptorHash: "d".repeat(64),
          descriptors: [
            {
              id: id(5_105),
              revisionId: id(5_106),
              contentHash: "e".repeat(64),
              activeVersion: 1,
              scope: "user",
            },
          ],
          truncated: true,
          createdAt: "2026-07-29T12:00:01.000Z",
        },
        currentPreferences: {
          descriptors: [
            {
              id: id(5_105),
              revisionId: id(5_106),
              contentHash: "e".repeat(64),
              activeVersion: 1,
              scope: "user",
            },
          ],
          truncated: false,
        },
      },
    });

    expect(projected.truth.attemptGovernance).toMatchObject({
      status: "available",
      attemptId: id(5_100),
      policySnapshot: { status: "available", entryHash: "c".repeat(64) },
      preferenceSnapshot: {
        status: "available",
        descriptorHash: "d".repeat(64),
        descriptorCount: 1,
        truncated: true,
      },
      drift: {
        overall: "truncated",
        policy: { status: "superseded", snapshotTargetCount: 1, currentTargetCount: 1 },
        preferences: { status: "truncated", snapshotDescriptorCount: 1 },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("title");
    expect(JSON.stringify(projected)).not.toContain("description");
    expect(JSON.stringify(projected)).not.toContain("retrievalHandle");
  });

  test("classifies unavailable, missing, identical, and changed governance truth", () => {
    const currentHead: WorkspaceInstructionPolicyHead = {
      workspaceId: WORKSPACE_ID,
      kind: "policy",
      scope: "global",
      roleKey: null,
      revisionId: id(5_201),
      revision: 1,
      contentHash: "1".repeat(64),
      activationVersion: 1,
      activatedAt: NOW,
    };
    const policySnapshot = {
      id: id(5_202),
      workspaceId: WORKSPACE_ID,
      sessionId: id(5_203),
      turnId: id(5_204),
      attemptId: id(5_205),
      executionGeneration: 1,
      policyRole: null,
      roleSource: "none" as const,
      entryHash: "2".repeat(64),
      entries: [
        {
          kind: "policy" as const,
          scope: "global" as const,
          roleKey: null,
          revisionId: currentHead.revisionId,
          revision: currentHead.revision,
          contentHash: currentHead.contentHash,
          activationVersion: currentHead.activationVersion,
          activatedAt: currentHead.activatedAt,
          provenance: { source: "human" as const, sourceIdHash: null },
        },
      ],
      createdAt: NOW,
    };
    const preference = {
      id: id(5_206),
      revisionId: id(5_207),
      contentHash: "3".repeat(64),
      activeVersion: 1,
      scope: "user" as const,
    };
    const shared = {
      workspaceId: WORKSPACE_ID,
      generatedAt: NOW,
      workspaceAgentInstructions: null,
      preferences: preferences([preference]),
      knowledge: null,
    };

    expect(
      projectWorkspaceState({
        ...shared,
        policies: policies([currentHead]),
        attemptGovernance: { status: "unavailable" },
      }).truth.attemptGovernance,
    ).toEqual({
      status: "unavailable",
      reason: "attempt_not_found_or_not_authorized",
      driftStatus: "unavailable",
    });

    const missing = projectWorkspaceState({
      ...shared,
      policies: policies([currentHead]),
      attemptGovernance: {
        status: "available",
        attemptId: id(5_205),
        executionGeneration: 1,
        acceptedAt: NOW,
        policySnapshot: null,
        preferenceSnapshot: null,
        currentPreferences: { descriptors: [preference], truncated: false },
      },
    }).truth.attemptGovernance;
    expect(missing).toMatchObject({
      status: "available",
      policySnapshot: { status: "missing" },
      preferenceSnapshot: { status: "missing" },
      drift: {
        overall: "missing",
        policy: { status: "missing" },
        preferences: { status: "missing" },
      },
    });

    const identicalInput = {
      status: "available" as const,
      attemptId: id(5_205),
      executionGeneration: 1,
      acceptedAt: NOW,
      policySnapshot,
      preferenceSnapshot: {
        id: id(5_208),
        descriptorHash: "4".repeat(64),
        descriptors: [preference],
        truncated: false,
        createdAt: NOW,
      },
      currentPreferences: { descriptors: [preference], truncated: false },
    };
    expect(
      projectWorkspaceState({
        ...shared,
        policies: policies([currentHead]),
        attemptGovernance: identicalInput,
      }).truth.attemptGovernance,
    ).toMatchObject({ drift: { overall: "identical", policy: { status: "identical" } } });
    expect(
      projectWorkspaceState({
        ...shared,
        policies: policies(),
        attemptGovernance: identicalInput,
      }).truth.attemptGovernance,
    ).toMatchObject({ drift: { overall: "changed", policy: { status: "changed" } } });
    expect(
      projectWorkspaceState({
        ...shared,
        policies: policies([currentHead]),
        attemptGovernance: {
          ...identicalInput,
          policySnapshot: { ...policySnapshot, entries: [] },
        },
      }).truth.attemptGovernance,
    ).toMatchObject({
      drift: {
        overall: "changed",
        policy: { status: "changed", snapshotTargetCount: 0, currentTargetCount: 1 },
      },
    });
  });

  test("bounds canonical published metadata and excludes source text and provenance", () => {
    const entries = Array.from(
      { length: WORKSPACE_STATE_KNOWLEDGE_SAMPLE_LIMIT + 1 },
      (_, index) => ({
        id: id(3000 + index),
        scope: "workspace" as const,
        updatedAt: NOW,
        revision: {
          id: id(5000 + index),
          title: index === 0 ? "  Exact title  " : `Entry ${index}`,
          kind: "fact",
          preview: "PRIVATE CONTENT",
          provenance: { secret: "PRIVATE PROVENANCE" },
        },
      }),
    ) as Pick<KnowledgeEntrySummary, "id" | "scope" | "revision" | "updatedAt">[];
    const activeHeads = Array.from(
      { length: WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS + 1 },
      (_, index) => head(index),
    );

    const projected = projectWorkspaceState({
      workspaceId: WORKSPACE_ID,
      generatedAt: NOW,
      workspaceAgentInstructions: null,
      policies: policies(activeHeads),
      preferences: preferences(
        [
          {
            id: id(6_003),
            revisionId: id(6_103),
            contentHash: "3".repeat(64),
            activeVersion: 1,
            scope: "user",
          },
          {
            id: id(6_001),
            revisionId: id(6_101),
            contentHash: "1".repeat(64),
            activeVersion: 2,
            scope: "organization",
          },
          {
            id: id(6_002),
            revisionId: id(6_102),
            contentHash: "2".repeat(64),
            activeVersion: 1,
            scope: "workspace",
          },
        ],
        true,
      ),
      knowledge: { entries, nextCursor: "more" },
    });

    expect(projected.policy.activeHeads).toHaveLength(WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS);
    expect(projected.policy.activeHeadsTruncated).toBe(true);
    expect(projected.preferences).toMatchObject({
      authority: "preference_registry_preferences",
      activeDescriptorCount: 3,
      scopeCounts: { organization: 1, workspace: 1, user: 1 },
      truncated: true,
    });
    expect(projected.preferences.activeDescriptorHash).toMatch(/^[0-9a-f]{64}$/);
    expect(projected.knowledge.availability).toBe("available");
    if (projected.knowledge.availability !== "available") throw new Error("expected inventory");
    expect(projected.knowledge).toMatchObject({
      authority: "knowledge_entries",
      coverage: "partial",
      sampleLimit: 50,
    });
    expect(projected.knowledge.entries).toHaveLength(50);
    expect(projected.knowledge.entries[0]).toEqual({
      id: id(3000),
      revisionId: id(5000),
      title: "  Exact title  ",
      kind: "fact",
      scope: "workspace",
      updatedAt: NOW,
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE CONTENT");
    expect(JSON.stringify(projected)).not.toContain("PRIVATE PROVENANCE");
    expect(
      projectWorkspaceState({
        workspaceId: WORKSPACE_ID,
        generatedAt: NOW,
        workspaceAgentInstructions: null,
        policies: policies(),
        preferences: preferences(),
        knowledge: { entries: [], nextCursor: null },
      }).knowledge,
    ).toEqual({
      availability: "available",
      authority: "knowledge_entries",
      coverage: "complete",
      sampleLimit: 50,
      entries: [],
    });
  });
});
