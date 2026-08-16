import { describe, expect, test } from "bun:test";
import {
  COMPANY_BRAIN_GUIDANCE_MAX_CONTENT_BYTES,
  COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES,
  CompanyBrainOkfPackage,
  CompanyProfileListResponse,
  WorkspaceInstructionPolicyListResponse,
  WorkspaceStateKnowledge,
} from "@opengeni/contracts";

import {
  boundCompanyBrainGuidanceEntries,
  createCompanyBrainOkfPackage,
  parseCompanyBrainOkf,
  serializeCompanyBrainOkf,
} from "../src/company-brain-okf";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const GENERATED_AT = "2026-08-15T10:00:00.000Z";
const HASH = "f".repeat(64);
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";

function unavailableKnowledge() {
  return WorkspaceStateKnowledge.parse({
    availability: "unavailable",
    reason: "missing_permission",
    requiredPermission: "documents:search",
  });
}

function availableEmptyKnowledge() {
  return WorkspaceStateKnowledge.parse({
    availability: "available",
    coverage: "complete",
    baseCount: 0,
    bases: [],
    basesTruncated: false,
    inspectedVisibleDocumentCount: 0,
    documentStatusCounts: { queued: 0, indexing: 0, ready: 0, failed: 0 },
    sourceKindCounts: {
      manual_upload: 0,
      meeting_transcript: 0,
      repository: 0,
      email: 0,
      chat: 0,
      document: 0,
      web: 0,
      other: 0,
    },
    authorityKindCounts: { organization: 0, workspace: 0, personal: 0 },
    topics: [],
    topicsTruncated: false,
    latestDocumentUpdatedAt: null,
    memorySample: {
      recordCount: 0,
      sampleLimit: 100,
      limitReached: false,
      statusCounts: {
        proposed: 0,
        approved: 0,
        rejected: 0,
        active: 0,
        superseded: 0,
        archived: 0,
      },
      kindCounts: {
        semantic: 0,
        episodic: 0,
        procedural: 0,
        decision: 0,
        preference: 0,
      },
      preferenceAuthority: {
        kindCountSource: "knowledge_memories_legacy_observations",
        activeAuthority: "structured_preference_registry",
      },
      latestUpdatedAt: null,
    },
    gaps: [
      { code: "no_document_bases", severity: "info", relatedCount: 0 },
      { code: "no_visible_documents", severity: "info", relatedCount: 0 },
      { code: "no_memory_records", severity: "info", relatedCount: 0 },
    ],
  });
}

function emptyProfile() {
  return CompanyProfileListResponse.parse({
    current: null,
    activeRevision: null,
    revisions: [],
    activationEvents: [],
    nextAfterRevision: null,
  });
}

function emptyPolicies() {
  return WorkspaceInstructionPolicyListResponse.parse({
    revisions: [],
    activeHeads: [],
    activationEvents: [],
    nextAfterRevision: null,
  });
}

function makePackage(knowledge = unavailableKnowledge()) {
  return createCompanyBrainOkfPackage({
    workspaceId: WORKSPACE_ID,
    generatedAt: GENERATED_AT,
    companyProfile: emptyProfile(),
    instructionPolicies: emptyPolicies(),
    activeInstructionPolicyRevisions: [],
    activatedInstructionPolicyRevisionIds: [],
    preferences: {
      rows: [
        {
          preferenceId: "00000000-0000-4000-8000-000000000010",
          stableKey: "deployment-guide",
          scope: "workspace",
          status: "active",
          supersededByPreferenceId: "00000000-0000-4000-8000-000000000099",
          revisionId: "00000000-0000-4000-8000-000000000011",
          revision: 1,
          title: "Deployment guide",
          description: "How to release safely",
          content: "---\n```yaml\nnot: structure\n```\n# still exact",
          contentHash: HASH,
          provenanceSource: "human",
          provenanceSourceId: null,
          trust: "workspace_managed",
          correctsRevisionId: "00000000-0000-4000-8000-000000000098",
          expiresAt: null,
          createdAt: new Date(GENERATED_AT),
          active: true,
        },
      ],
      preferenceCountTruncated: false,
      revisionCountTruncated: false,
      contentBytesTruncated: false,
    },
    knowledge,
  });
}

describe("Company Brain OKF package", () => {
  test("round-trips arbitrary guidance bytes without allowing Markdown/YAML structure escape", () => {
    const value = makePackage();
    const serialized = serializeCompanyBrainOkf(value);
    expect(parseCompanyBrainOkf(serialized)).toEqual(value);
    expect(serializeCompanyBrainOkf(structuredClone(value))).toBe(serialized);
    expect(value.guidance.entries[0]?.content).toContain("```yaml");
    expect(value.guidance.entries[0]?.relationships).toEqual([]);
    expect(CompanyBrainOkfPackage.safeParse(value).success).toBe(true);
  });

  test("distinguishes missing Knowledge authority from an authorized empty inventory", () => {
    const unavailable = makePackage();
    expect(unavailable.permissions).toEqual({ guidance: "available", knowledge: "unavailable" });
    expect(unavailable.knowledge.availability).toBe("unavailable");
    expect(unavailable.omissions).toContain("inaccessible_knowledge");

    const empty = makePackage(availableEmptyKnowledge());
    expect(empty.permissions).toEqual({ guidance: "available", knowledge: "available" });
    expect(empty.knowledge.availability).toBe("available");
    expect(empty.omissions).not.toContain("inaccessible_knowledge");
  });

  test("emits exact truncation facts without silently dropping the condition", () => {
    const value = createCompanyBrainOkfPackage({
      workspaceId: WORKSPACE_ID,
      generatedAt: GENERATED_AT,
      companyProfile: emptyProfile(),
      instructionPolicies: emptyPolicies(),
      activeInstructionPolicyRevisions: [],
      activatedInstructionPolicyRevisionIds: [],
      preferences: {
        rows: [],
        preferenceCountTruncated: true,
        revisionCountTruncated: true,
        contentBytesTruncated: true,
      },
      knowledge: unavailableKnowledge(),
    });
    expect(value.guidance).toMatchObject({
      truncated: true,
      truncationReasons: ["preference_count", "preference_history", "aggregate_content_bytes"],
    });
  });

  test("distinguishes active, never-activated proposal, inactive draft, and historical rules", () => {
    const revisions = [
      ["00000000-0000-4000-8000-000000000021", 1, "human", "historical rule"],
      ["00000000-0000-4000-8000-000000000022", 2, "human", "inactive draft"],
      ["00000000-0000-4000-8000-000000000023", 3, "knowledge_proposal", "proposal rule"],
      ["00000000-0000-4000-8000-000000000024", 4, "human", "active rule"],
    ].map(([id, revision, source, content]) => ({
      id: id as string,
      operationId: `00000000-0000-4000-8000-${String(Number(revision) + 30).padStart(12, "0")}`,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      kind: "policy" as const,
      scope: "global" as const,
      roleKey: null,
      content: content as string,
      contentHash: HASH,
      revision: revision as number,
      provenance: {
        source: source as "human" | "knowledge_proposal",
        sourceId: source === "human" ? null : "proposal-source",
      },
      supersedesRevisionId: null,
      createdBySubjectId: "authorized-human",
      createdAt: GENERATED_AT,
    }));
    const policies = WorkspaceInstructionPolicyListResponse.parse({
      revisions,
      activeHeads: [
        {
          workspaceId: WORKSPACE_ID,
          kind: "policy",
          scope: "global",
          roleKey: null,
          revisionId: revisions[3]!.id,
          revision: 4,
          contentHash: HASH,
          activationVersion: 2,
          activatedAt: GENERATED_AT,
        },
      ],
      activationEvents: [],
      nextAfterRevision: null,
    });
    const value = createCompanyBrainOkfPackage({
      workspaceId: WORKSPACE_ID,
      generatedAt: GENERATED_AT,
      companyProfile: emptyProfile(),
      instructionPolicies: policies,
      activeInstructionPolicyRevisions: [revisions[3]!],
      activatedInstructionPolicyRevisionIds: [revisions[0]!.id, revisions[3]!.id],
      preferences: {
        rows: [],
        preferenceCountTruncated: false,
        revisionCountTruncated: false,
        contentBytesTruncated: false,
      },
      knowledge: unavailableKnowledge(),
    });
    expect(
      Object.fromEntries(value.guidance.entries.map((entry) => [entry.content, entry.lifecycle])),
    ).toEqual({
      "active rule": "active",
      "historical rule": "historical",
      "inactive draft": "inactive",
      "proposal rule": "proposal",
    });
  });

  test("bounds aggregate UTF-8 content and drops relationships to omitted targets", () => {
    const entry = makePackage(availableEmptyKnowledge()).guidance.entries[0]!;
    const oversizedEntries = Array.from(
      { length: Math.min(COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES, 32) },
      (_, index) => ({
        ...entry,
        id: `preference:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        revisionId: `00000000-0000-4000-8000-${String(index + 1_000).padStart(12, "0")}`,
        path: `ways-of-working/guides/workspace/guide-${index}`,
        content: "é".repeat(131_072),
        relationships:
          index === 0
            ? [
                {
                  type: "corrects" as const,
                  targetId: `00000000-0000-4000-8000-${String(1_031).padStart(12, "0")}`,
                },
              ]
            : [],
      }),
    );
    const bounded = boundCompanyBrainGuidanceEntries(oversizedEntries);
    const retainedBytes = bounded.entries.reduce(
      (sum, candidate) => sum + new TextEncoder().encode(candidate.content).byteLength,
      0,
    );
    expect(retainedBytes).toBeLessThanOrEqual(COMPANY_BRAIN_GUIDANCE_MAX_CONTENT_BYTES);
    expect(bounded.contentBytesTruncated).toBe(true);
    expect(bounded.entries[0]?.relationships).toEqual([]);

    const itemBounded = boundCompanyBrainGuidanceEntries(
      Array.from({ length: COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES + 1 }, (_, index) => ({
        ...entry,
        id: `guide-${index}`,
        revisionId: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
        path: `ways-of-working/guides/workspace/item-${index}`,
        content: `guide ${index}`,
        relationships: [],
      })),
    );
    expect(itemBounded.entries).toHaveLength(COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES);
    expect(itemBounded.itemCountTruncated).toBe(true);
  });
});
