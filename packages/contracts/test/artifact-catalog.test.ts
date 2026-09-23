import { expect, test } from "bun:test";
import { ArtifactCatalogItem, ArtifactCatalogListQuery, ArtifactCatalogListResponse } from "../src";

test("catalog query has bounded defaults and a closed filter vocabulary", () => {
  expect(ArtifactCatalogListQuery.parse({})).toEqual({
    sort: "updated",
    status: "active",
    limit: 50,
  });
  expect(ArtifactCatalogListQuery.parse({ limit: "100", q: "  budget  " }).q).toBe("budget");
  for (const query of [
    { limit: 0 },
    { limit: 101 },
    { limit: "" },
    { sort: "oldest" },
    { status: "deleted" },
    { kind: "attachment" },
    { q: "a".repeat(201) },
    { q: "invalid\0query" },
    { sourceSessionId: "private" },
    { cursor: "" },
    { unexpected: true },
  ]) {
    expect(ArtifactCatalogListQuery.safeParse(query).success).toBe(false);
  }
});

test("catalog metadata preserves native IDs and rejects storage/provenance extras", () => {
  const item = {
    id: "1".repeat(32),
    kind: "document",
    title: "Report",
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as const;
  expect(ArtifactCatalogItem.parse(item)).toEqual(item);
  for (const extra of [
    { sourceTurnId: "private" },
    { bucket: "private" },
    { objectKey: "secret" },
    { signedUrl: "https://storage.invalid" },
    { file: { url: "https://storage.invalid" } },
  ]) {
    expect(ArtifactCatalogItem.safeParse({ ...item, ...extra }).success).toBe(false);
  }
  expect(ArtifactCatalogListResponse.parse({ items: [item], nextCursor: null }).items).toHaveLength(
    1,
  );
});
