import { describe, expect, test } from "bun:test";
import {
  canonicalMemoryRelationship,
  hashMemoryOperationPlan,
  hashMemoryRevertPlan,
  isMemoryScopeApplicable,
  normalizeMemoryLabels,
  normalizeMemoryNamespace,
  normalizeMemoryOperationPlan,
  normalizeMemoryRevertPlan,
  normalizeMemoryScope,
} from "../src/memory-domain";

const LOW_ID = "00000000-0000-4000-8000-000000000001";
const HIGH_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

describe("hierarchical memory domain primitives", () => {
  test("normalizes bounded hierarchical namespaces and canonical labels", () => {
    expect(normalizeMemoryNamespace(" Engineering / Incident_Response ")).toBe(
      "engineering/incident_response",
    );
    expect(normalizeMemoryNamespace(null)).toBe("general");
    expect(normalizeMemoryLabels([" Incident Response ", "alpha", "incident-response"])).toEqual([
      "alpha",
      "incident-response",
    ]);
    expect(() => normalizeMemoryNamespace("engineering//backend")).toThrow();
    expect(() => normalizeMemoryLabels(["invalid/label"])).toThrow();
  });

  test("normalizes typed scopes and fails closed for invalid selectors", () => {
    expect(normalizeMemoryScope({ type: "role", roleKey: " Incident Responder " })).toEqual({
      type: "role",
      roleKey: "incident-responder",
    });
    expect(
      normalizeMemoryScope({
        type: "ephemeral",
        sessionId: HIGH_ID.toUpperCase(),
        validUntil: "2026-08-01T00:00:00-04:00",
      }),
    ).toEqual({
      type: "ephemeral",
      sessionId: HIGH_ID,
      validUntil: "2026-08-01T04:00:00.000Z",
    });
    expect(() => normalizeMemoryScope({ type: "session", sessionId: "not-a-uuid" })).toThrow();
    expect(() => normalizeMemoryScope({ type: "user", subjectId: "   " })).toThrow();
  });

  test("applies subject, role, session, and ephemeral boundaries deterministically", () => {
    expect(isMemoryScopeApplicable({ type: "workspace" }, {})).toBe(true);
    expect(
      isMemoryScopeApplicable(
        { type: "user", subjectId: "subject-alice" },
        { subjectId: "subject-alice" },
      ),
    ).toBe(true);
    expect(
      isMemoryScopeApplicable({ type: "role", roleKey: "operator" }, { roleKey: "reviewer" }),
    ).toBe(false);
    expect(
      isMemoryScopeApplicable({ type: "session", sessionId: LOW_ID }, { sessionId: HIGH_ID }),
    ).toBe(false);
    const ephemeral = {
      type: "ephemeral" as const,
      sessionId: LOW_ID,
      validUntil: "2026-07-31T12:00:00.000Z",
    };
    expect(
      isMemoryScopeApplicable(ephemeral, {
        sessionId: LOW_ID,
        now: "2026-07-31T11:59:59.999Z",
      }),
    ).toBe(true);
    expect(
      isMemoryScopeApplicable(ephemeral, {
        sessionId: LOW_ID,
        now: "2026-07-31T12:00:00.000Z",
      }),
    ).toBe(false);
    expect(isMemoryScopeApplicable({ type: "legacy", legacyScope: "unknown" }, {})).toBe(false);
  });

  test("canonicalizes symmetric edges and swaps the matching CAS versions", () => {
    expect(
      canonicalMemoryRelationship({
        sourceMemoryId: HIGH_ID,
        targetMemoryId: LOW_ID,
        relationshipType: "related_to",
      }),
    ).toEqual({
      sourceMemoryId: LOW_ID,
      targetMemoryId: HIGH_ID,
      relationshipType: "related_to",
    });
    const plan = normalizeMemoryOperationPlan({
      operationId: "10000000-0000-4000-8000-000000000001",
      operationType: "relationship_add",
      targetMemoryId: HIGH_ID,
      expectedTargetVersion: 7,
      relatedMemoryId: LOW_ID,
      expectedRelatedVersion: 11,
      relationshipType: "related_to",
    });
    expect(plan).toMatchObject({
      targetMemoryId: LOW_ID,
      expectedTargetVersion: 11,
      relatedMemoryId: HIGH_ID,
      expectedRelatedVersion: 7,
    });
    expect(() =>
      canonicalMemoryRelationship({
        sourceMemoryId: LOW_ID,
        targetMemoryId: LOW_ID,
        relationshipType: "depends_on",
      }),
    ).toThrow();
  });

  test("normalizes operation and revert identities into stable hashes", () => {
    const first = normalizeMemoryOperationPlan({
      operationId: "20000000-0000-4000-8000-000000000001",
      operationType: "reclassify",
      targetMemoryId: LOW_ID,
      expectedTargetVersion: 1,
      scope: { type: "role", roleKey: " Incident Responder " },
      namespace: " Engineering / Backend ",
      labels: ["Runbook", "critical", "runbook"],
    });
    const second = normalizeMemoryOperationPlan({
      operationId: "20000000-0000-4000-8000-000000000001",
      operationType: "reclassify",
      targetMemoryId: LOW_ID,
      expectedTargetVersion: 1,
      scope: { type: "role", roleKey: "incident-responder" },
      namespace: "engineering/backend",
      labels: ["critical", "runbook"],
    });
    expect(first).toEqual(second);
    expect(hashMemoryOperationPlan(first)).toBe(hashMemoryOperationPlan(second));
    expect(hashMemoryOperationPlan(first)).toMatch(/^[a-f0-9]{64}$/);

    const revert = normalizeMemoryRevertPlan({
      operationId: "30000000-0000-4000-8000-000000000001",
      appliedOperationId: "20000000-0000-4000-8000-000000000001",
    });
    expect(hashMemoryRevertPlan(revert)).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      normalizeMemoryRevertPlan({ operationId: "invalid", appliedOperationId: LOW_ID }),
    ).toThrow();
  });
});
