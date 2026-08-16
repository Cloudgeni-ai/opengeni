import { describe, expect, test } from "bun:test";
import type {
  PreferenceRegistrySnapshot,
  ResolvedCompanyProfileSnapshot,
  ResolvedWorkspaceInstructionPolicySnapshot,
} from "@opengeni/contracts";
import {
  buildCompanyBrainContributionReceipt,
  modelVisibleCompanyBrainSkillActivations,
  summarizeCompanyBrainContributions,
} from "../src/model-context-contributions";

const identity = (): string => crypto.randomUUID();

function policy(): ResolvedWorkspaceInstructionPolicySnapshot {
  return {
    id: identity(),
    workspaceId: identity(),
    sessionId: identity(),
    turnId: identity(),
    attemptId: identity(),
    executionGeneration: 1,
    policyRole: null,
    roleSource: "none",
    entryHash: "a".repeat(64),
    entries: [
      {
        kind: "policy",
        scope: "global",
        roleKey: null,
        revisionId: identity(),
        revision: 1,
        contentHash: "b".repeat(64),
        activationVersion: 1,
        activatedAt: "2026-08-13T00:00:00.000Z",
        provenance: { source: "human", sourceIdHash: null },
        content: "Mandatory rule",
      },
    ],
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function profile(): ResolvedCompanyProfileSnapshot {
  return {
    id: identity(),
    accountId: identity(),
    workspaceId: identity(),
    sessionId: identity(),
    turnId: identity(),
    attemptId: identity(),
    executionGeneration: 1,
    profile: {
      id: identity(),
      revision: 1,
      contentHash: "c".repeat(64),
      activationVersion: 1,
      activatedAt: "2026-08-13T00:00:00.000Z",
      provenance: { source: "human", sourceIdHash: null },
      profile: {
        identity: "Company identity",
        mission: null,
        products: [],
        customers: [],
        goals: [],
        constraints: [],
      },
    },
    snapshotHash: "d".repeat(64),
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function preferences(): PreferenceRegistrySnapshot {
  const preferenceId = identity();
  const revisionId = identity();
  return {
    id: identity(),
    workspaceId: identity(),
    sessionId: identity(),
    turnId: identity(),
    attemptId: identity(),
    executionGeneration: 1,
    initiatingHumanSubjectId: "user:1",
    descriptorHash: "e".repeat(64),
    descriptors: [
      {
        id: preferenceId,
        stableKey: "writing.concise",
        title: "Concise",
        description: "Keep replies concise",
        scope: "user",
        activeVersion: 1,
        revisionId,
        contentHash: "f".repeat(64),
        precedence: { tier: "user", rank: 0, conflictStrategy: "override", conflictsWith: [] },
        provenance: { source: "human", sourceIdHash: null, trust: "personal" },
        expiresAt: null,
        retrievalHandle: `preference://${preferenceId}/revisions/${revisionId}?sha256=${"f".repeat(64)}`,
      },
    ],
    truncated: false,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("Company Brain model contribution receipts", () => {
  test("omits skill descriptors when the none backend cannot expose runtime skills", () => {
    const activations = [
      {
        source: "session" as const,
        id: "session:review",
        reason: "attached to session",
        artifact: {
          name: "review",
          description: "Use for repository reviews.",
          files: [{ path: "SKILL.md", content: "# Review" }],
        },
      },
    ];

    expect(modelVisibleCompanyBrainSkillActivations("none", activations)).toEqual([]);
    expect(modelVisibleCompanyBrainSkillActivations("modal", activations)).toBe(activations);
  });

  test("contained children retain rules and guide catalogs but omit standing knowledge", () => {
    const receipt = buildCompanyBrainContributionReceipt({
      contextSelectionReceiptId: identity(),
      attemptId: identity(),
      turnId: identity(),
      nestedAgentDepth: 1,
      memoryPromptMode: "retrieval_only",
      instructionPolicy: policy(),
      workspaceAgentInstructions: "Legacy workspace instructions",
      preferences: preferences(),
      companyProfile: profile(),
      companyProfileIncluded: false,
      workspaceMemory: null,
      skillActivations: [
        {
          source: "session",
          id: "session:review",
          reason: "attached to session",
          artifact: {
            name: "review",
            description: "Use for repository reviews.",
            files: [{ path: "SKILL.md", content: "# Review" }],
          },
        },
      ],
    });

    expect(receipt.sessionRole).toBe("child");
    expect(receipt.contributions.map((item) => item.source)).toEqual([
      "workspace_instruction_policy",
      "preference_registry_descriptor",
      "runtime_skill_catalog",
    ]);
    expect(receipt.contributions.every((item) => item.utf8Bytes > 0)).toBe(true);
    expect(receipt.contributions.every((item) => item.estimatedTokens > 0)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("Mandatory rule");
    expect(JSON.stringify(receipt)).not.toContain("Keep replies concise");
    expect(summarizeCompanyBrainContributions(receipt)).toEqual([
      expect.objectContaining({ source: "workspace_instruction_policy", items: 1 }),
      expect.objectContaining({ source: "preference_registry_descriptor", items: 1 }),
      expect.objectContaining({ source: "runtime_skill_catalog", items: 1 }),
    ]);
  });

  test("accounts for legacy workspace instructions only when structured policy is absent", () => {
    const emptyPolicy = { ...policy(), entries: [] };
    const receipt = buildCompanyBrainContributionReceipt({
      contextSelectionReceiptId: identity(),
      attemptId: identity(),
      turnId: identity(),
      nestedAgentDepth: 0,
      memoryPromptMode: "retrieval_only",
      instructionPolicy: emptyPolicy,
      workspaceAgentInstructions: "Use the workspace release checklist.",
      preferences: null,
      companyProfile: { ...profile(), profile: null },
      companyProfileIncluded: true,
      workspaceMemory: null,
      skillActivations: [],
    });

    expect(receipt.contributions).toEqual([
      expect.objectContaining({
        category: "mandatory_rule",
        source: "legacy_workspace_instructions",
        inclusionReason: "legacy_instruction_fallback",
      }),
    ]);
    expect(JSON.stringify(receipt)).not.toContain("release checklist");
  });
});
