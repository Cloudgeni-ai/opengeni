import { describe, expect, test } from "bun:test";
import {
  normalizeScopedKnowledgeKey,
  scopedKnowledgeInputHash,
  scopedKnowledgeScopeKey,
} from "../src/scoped-knowledge";

describe("scoped-knowledge pure domain helpers", () => {
  test("normalizes stable keys without making acl_tags authoritative", () => {
    expect(normalizeScopedKnowledgeKey("  Customer\t Success  ")).toBe("customer success");
    expect(normalizeScopedKnowledgeKey("ＣＯＮＴＲＡＣＴ．Owner")).toBe("contract.owner");
  });

  test("hashes canonical object input independent of key order", () => {
    const left = scopedKnowledgeInputHash({
      source: "source-1",
      metadata: { z: 3, a: 1 },
      values: ["a", "b"],
    });
    const right = scopedKnowledgeInputHash({
      values: ["a", "b"],
      metadata: { a: 1, z: 3 },
      source: "source-1",
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  test("canonicalizes organization, workspace, and personal scope identities", () => {
    expect(
      scopedKnowledgeScopeKey({ kind: "organization", workspaceId: null, subjectId: null }),
    ).toBe("organization:-:-");
    expect(
      scopedKnowledgeScopeKey({
        kind: "workspace",
        workspaceId: "00000000-0000-4000-8000-000000000001",
        subjectId: null,
      }),
    ).toBe("workspace:00000000-0000-4000-8000-000000000001:-");
    expect(
      scopedKnowledgeScopeKey({
        kind: "personal",
        workspaceId: null,
        subjectId: "user:alice",
      }),
    ).toBe("personal:-:user:alice");
  });
});
