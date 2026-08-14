import { describe, expect, test } from "bun:test";
import {
  KNOWLEDGE_BODY_MAX_BYTES,
  KNOWLEDGE_METADATA_MAX_BYTES,
  KNOWLEDGE_SOURCE_URI_MAX_BYTES,
  KNOWLEDGE_SUMMARY_MAX_BYTES,
  KNOWLEDGE_TITLE_MAX_BYTES,
  KNOWLEDGE_TOPICS_MAX_ITEMS,
  KnowledgeRecord,
} from "@opengeni/contracts";
import { projectKnowledgeRecord } from "../src";

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

function source() {
  return {
    kind: "repository" as const,
    uri: "https://example.test/source",
    externalId: "source-1",
    title: "Source title",
    author: "Author",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    version: "v1",
  };
}

describe("Knowledge agent projection", () => {
  test("deterministically bounds flexible content and reports every affected field", () => {
    const input = {
      title: "😀".repeat(KNOWLEDGE_TITLE_MAX_BYTES),
      body: "😀".repeat(KNOWLEDGE_BODY_MAX_BYTES),
      summary: "😀".repeat(KNOWLEDGE_SUMMARY_MAX_BYTES),
      topics: Array.from(
        { length: KNOWLEDGE_TOPICS_MAX_ITEMS + 5 },
        (_, index) => `${index}:${"😀".repeat(100)}`,
      ),
      metadata: {
        z: "z".repeat(KNOWLEDGE_METADATA_MAX_BYTES),
        a: { nested: { deeper: { terminal: { omitted: true } } } },
        many: Array.from({ length: 100 }, (_, index) => index),
      },
      source: {
        ...source(),
        uri: `https://example.test/${"x".repeat(KNOWLEDGE_SOURCE_URI_MAX_BYTES)}`,
      },
    };
    const first = projectKnowledgeRecord(input);
    const second = projectKnowledgeRecord({
      ...input,
      metadata: { many: input.metadata.many, a: input.metadata.a, z: input.metadata.z },
    });

    expect(first).toEqual(second);
    expect(bytes(first.title)).toBeLessThanOrEqual(KNOWLEDGE_TITLE_MAX_BYTES);
    expect(bytes(first.content.body!)).toBeLessThanOrEqual(KNOWLEDGE_BODY_MAX_BYTES);
    expect(bytes(first.content.summary!)).toBeLessThanOrEqual(KNOWLEDGE_SUMMARY_MAX_BYTES);
    expect(first.content.topics).toHaveLength(KNOWLEDGE_TOPICS_MAX_ITEMS);
    expect(bytes(JSON.stringify(first.content.metadata))).toBeLessThanOrEqual(
      KNOWLEDGE_METADATA_MAX_BYTES,
    );
    expect(first.source.uri).toBeNull();
    expect(first.projection).toEqual({
      truncated: true,
      fields: [
        "content.body",
        "content.metadata",
        "content.summary",
        "content.topics",
        "provenance.source.uri",
        "title",
      ],
    });
  });

  test("produces a contract-valid envelope with explicit no-loss facts at exact bounds", () => {
    const projected = projectKnowledgeRecord({
      title: "😀".repeat(KNOWLEDGE_TITLE_MAX_BYTES / 4),
      body: "body",
      summary: null,
      topics: ["engineering"],
      metadata: { parser: "test", chunkIndex: 1 },
      source: source(),
    });
    expect(projected.projection).toEqual({ truncated: false, fields: [] });
    expect(
      KnowledgeRecord.safeParse({
        id: "document_chunk:00000000-0000-4000-8000-000000000001",
        kind: "document_chunk",
        title: projected.title,
        content: projected.content,
        authority: { kind: "workspace" },
        provenance: { source: projected.source, indexedAt: "2026-08-13T00:00:00.000Z" },
        lifecycle: { state: "active", updatedAt: "2026-08-13T00:00:00.000Z" },
        quality: {
          trust: "sourced",
          freshnessAt: "2026-08-13T00:00:00.000Z",
          conflict: "not_evaluated",
          correction: "current_source_version",
        },
        links: [],
        projection: projected.projection,
      }).success,
    ).toBe(true);
  });

  test("bounds source strings independently and removes an oversized URI from links", () => {
    const projected = projectKnowledgeRecord({
      title: "Title",
      body: null,
      summary: null,
      topics: [],
      metadata: {},
      source: {
        ...source(),
        uri: `https://example.test/${"😀".repeat(KNOWLEDGE_SOURCE_URI_MAX_BYTES / 4)}`,
        externalId: "😀".repeat(1_000),
        title: "😀".repeat(1_000),
        author: "😀".repeat(1_000),
        version: "😀".repeat(1_000),
      },
    });
    expect(projected.source.uri).toBeNull();
    for (const key of ["externalId", "title", "author", "version"] as const) {
      expect(bytes(projected.source[key]!)).toBeLessThanOrEqual(2_048);
    }
    expect(projected.projection.fields).toEqual([
      "provenance.source.author",
      "provenance.source.externalId",
      "provenance.source.title",
      "provenance.source.uri",
      "provenance.source.version",
    ]);

    const record = KnowledgeRecord.parse({
      id: "document:00000000-0000-4000-8000-000000000001",
      kind: "document",
      title: projected.title,
      content: projected.content,
      authority: { kind: "workspace" },
      provenance: { source: projected.source, indexedAt: "2026-08-13T00:00:00.000Z" },
      lifecycle: { state: "active", updatedAt: "2026-08-13T00:00:00.000Z" },
      quality: {
        trust: "sourced",
        freshnessAt: "2026-08-13T00:00:00.000Z",
        conflict: "not_evaluated",
        correction: "current_source_version",
      },
      links: projected.source.uri
        ? [{ relation: "source", target: { kind: "external", uri: projected.source.uri } }]
        : [],
      projection: projected.projection,
    });
    expect(record.links).toEqual([]);
  });

  test("metadata depth, item, and aggregate byte guards all produce explicit loss", () => {
    for (const metadata of [
      { a: { b: { c: { d: { e: "too deep" } } } } },
      { items: Array.from({ length: 100 }, (_, index) => index) },
      { huge: "😀".repeat(KNOWLEDGE_METADATA_MAX_BYTES) },
    ]) {
      const projected = projectKnowledgeRecord({
        title: "Title",
        body: null,
        summary: null,
        topics: [],
        metadata,
        source: source(),
      });
      expect(projected.projection.fields).toEqual(["content.metadata"]);
      expect(bytes(JSON.stringify(projected.content.metadata))).toBeLessThanOrEqual(
        KNOWLEDGE_METADATA_MAX_BYTES,
      );
    }
  });
});
