import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { KnowledgeEntryListRequest, KnowledgeSearchToolRequest } from "../src/knowledge-entries";

describe("Knowledge discovery tool contract", () => {
  test("defaults to five results without changing the HTTP list contract", () => {
    expect(KnowledgeSearchToolRequest.parse({}).limit).toBe(5);
    expect(KnowledgeEntryListRequest.parse({}).limit).toBe(20);
    for (const limit of [1, 5, 20, 50]) {
      expect(KnowledgeSearchToolRequest.parse({ limit }).limit).toBe(limit);
    }
    for (const limit of [0, 51, 1.5]) {
      expect(KnowledgeSearchToolRequest.safeParse({ limit }).success).toBe(false);
    }
  });

  test("UUID and date validation remain identical without embedding long patterns", () => {
    for (const field of ["groupId", "fileId"] as const) {
      for (const value of [
        "123",
        "",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "00000000-0000-0000-0000-000000000000",
        4,
        null,
      ]) {
        expect(KnowledgeSearchToolRequest.safeParse({ [field]: value }).success).toBe(
          KnowledgeEntryListRequest.safeParse({ [field]: value }).success,
        );
      }
    }
    for (const value of [
      "2026-10-21T06:00:00Z",
      "2026-10-21T08:00:00+02:00",
      "2026-02-30T00:00:00Z",
      "yesterday",
      "2026-10-21",
      "",
      null,
    ]) {
      expect(KnowledgeSearchToolRequest.safeParse({ createdSince: value }).success).toBe(
        KnowledgeEntryListRequest.safeParse({ createdSince: value }).success,
      );
    }
    const schema = z.toJSONSchema(KnowledgeSearchToolRequest) as any;
    expect(schema.properties.groupId.format).toBe("uuid");
    expect(schema.properties.createdSince.format).toBe("date-time");
    expect(JSON.stringify(schema)).not.toContain('"pattern"');
  });

  test("keeps narrowing and pagination while excluding maintenance-only views", () => {
    const input = {
      query: "database decision",
      mode: "keyword",
      scope: "personal",
      kind: "decision",
      includeEvidence: true,
      rootOnly: true,
      cursor: "next-page",
      view: "needs_review",
      limit: 7,
    } as const;
    expect(KnowledgeSearchToolRequest.parse(input)).toEqual(input);
    for (const view of ["archived", "rejected"]) {
      expect(KnowledgeSearchToolRequest.safeParse({ view }).success).toBe(false);
    }
    expect(
      KnowledgeSearchToolRequest.safeParse({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })
        .success,
    ).toBe(false);
  });
});
