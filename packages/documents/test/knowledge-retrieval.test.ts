import { describe, expect, test } from "bun:test";
import {
  KNOWLEDGE_SEARCH_MAX_RESPONSE_BYTES,
  KNOWLEDGE_SEARCH_MIN_KEYWORD_SCORE,
  KNOWLEDGE_SEARCH_MIN_VECTOR_SCORE,
  KnowledgeSearchResponse,
  type KnowledgeRecord,
} from "@opengeni/contracts";
import { selectKnowledgeSearchResults } from "../src";

const NOW = new Date("2026-08-15T12:00:00.000Z");

function record(
  index: number,
  input: {
    body?: string;
    title?: string;
    freshnessAt?: string;
    metadata?: Record<string, unknown>;
  } = {},
): KnowledgeRecord {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as const;
  return {
    id: `document_chunk:${id}`,
    kind: "document_chunk",
    title: input.title ?? `Knowledge ${index}`,
    content: {
      format: "markdown",
      body: input.body ?? `Relevant content ${index}`,
      summary: null,
      topics: ["retrieval"],
      metadata: input.metadata ?? { chunkIndex: index },
    },
    authority: { kind: "workspace" },
    provenance: {
      source: {
        kind: "document",
        uri: null,
        externalId: null,
        title: null,
        author: null,
        createdAt: null,
        updatedAt: null,
        version: null,
      },
      indexedAt: "2026-08-15T10:00:00.000Z",
      citation: null,
    },
    lifecycle: { state: "active", updatedAt: "2026-08-15T10:00:00.000Z" },
    quality: {
      trust: "sourced",
      freshnessAt: input.freshnessAt ?? "2026-08-15T10:00:00.000Z",
      conflict: "not_evaluated",
      correction: "current_source_version",
    },
    links: [],
    projection: { truncated: false, fields: [] },
  };
}

function candidate(
  knowledge: KnowledgeRecord,
  input: {
    semanticScore?: number;
    vectorScore?: number | null;
    keywordScore?: number | null;
  } = {},
) {
  return {
    record: knowledge,
    semanticScore: input.semanticScore ?? 0.5,
    matchType: "hybrid" as const,
    vectorScore: input.vectorScore === undefined ? 0.6 : input.vectorScore,
    keywordScore: input.keywordScore === undefined ? 0.2 : input.keywordScore,
  };
}

describe("permission-first Knowledge final selection", () => {
  test("applies explicit vector/keyword relevance floors before output", () => {
    const below = candidate(record(1), {
      vectorScore: KNOWLEDGE_SEARCH_MIN_VECTOR_SCORE - 0.000001,
      keywordScore: KNOWLEDGE_SEARCH_MIN_KEYWORD_SCORE - 0.000001,
    });
    const vector = candidate(record(2), {
      vectorScore: KNOWLEDGE_SEARCH_MIN_VECTOR_SCORE,
      keywordScore: null,
    });
    const keyword = candidate(record(3), {
      vectorScore: null,
      keywordScore: KNOWLEDGE_SEARCH_MIN_KEYWORD_SCORE,
    });
    const response = selectKnowledgeSearchResults({
      candidates: [below, vector, keyword],
      // One additional ranked row disappeared during the fresh authorization
      // recheck and therefore contributes only a content-free omission count.
      rankedCandidateCount: 4,
      requestedLimit: 10,
      now: NOW,
    });

    expect(response.results.map((result) => result.record.id).sort()).toEqual(
      [vector.record.id, keyword.record.id].sort(),
    );
    expect(response.selection.omitted.belowRelevanceFloor).toBe(1);
    expect(response.selection.candidates.omittedOnRecheck).toBe(1);
    expect(response.selection.relevanceFloor).toEqual({
      policy: "any_signal",
      vectorScore: KNOWLEDGE_SEARCH_MIN_VECTOR_SCORE,
      keywordScore: KNOWLEDGE_SEARCH_MIN_KEYWORD_SCORE,
    });
  });

  test("deduplicates exact textual content and keeps quality facts honest", () => {
    const stale = candidate(
      record(1, {
        title: "Same fact",
        body: "The same exact sourced fact.",
        freshnessAt: "2020-01-01T00:00:00.000Z",
        metadata: { chunkIndex: 1, sourceSpecific: "old" },
      }),
      { semanticScore: 0.6 },
    );
    const current = candidate(
      record(2, {
        title: "Same fact",
        body: "The same exact sourced fact.",
        freshnessAt: "2026-08-15T10:00:00.000Z",
        metadata: { chunkIndex: 9, sourceSpecific: "new" },
      }),
      { semanticScore: 0.6 },
    );
    const response = selectKnowledgeSearchResults({
      candidates: [stale, current],
      rankedCandidateCount: 2,
      requestedLimit: 10,
      now: NOW,
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.record.id).toBe(current.record.id);
    expect(response.results[0]?.retrieval).toMatchObject({
      freshness: "current",
      qualityAdjustment: 0.02,
      duplicateCount: 1,
    });
    expect(response.results[0]?.record.quality).toMatchObject({
      trust: "sourced",
      conflict: "not_evaluated",
    });
    expect(response.selection.omitted.asDuplicate).toBe(1);
  });

  test("bounds the complete serialized response and reports deterministic token facts", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate(
        record(index + 1, {
          title: `Large ${index}`,
          body: `${index}:${"å".repeat(7_000)}`,
        }),
        { semanticScore: 0.8 - index / 100 },
      ),
    );
    const first = selectKnowledgeSearchResults({
      candidates,
      rankedCandidateCount: candidates.length,
      requestedLimit: 12,
      now: NOW,
    });
    const second = selectKnowledgeSearchResults({
      candidates,
      rankedCandidateCount: candidates.length,
      requestedLimit: 12,
      now: NOW,
    });
    const bytes = Buffer.byteLength(JSON.stringify(first), "utf8");

    expect(first).toEqual(second);
    expect(bytes).toBeLessThanOrEqual(KNOWLEDGE_SEARCH_MAX_RESPONSE_BYTES);
    expect(first.selection.budget.responseBytes).toBe(bytes);
    expect(first.selection.budget.estimatedTokens).toBe(Math.ceil(bytes / 4));
    expect(first.selection.omitted.forResponseBudget).toBeGreaterThan(0);
    const parsed = KnowledgeSearchResponse.parse(first);
    expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBe(bytes);
  });

  test("applies the requested limit after relevance and dedupe", () => {
    const candidates = [candidate(record(1)), candidate(record(2)), candidate(record(3))];
    const response = selectKnowledgeSearchResults({
      candidates,
      rankedCandidateCount: 3,
      requestedLimit: 2,
      now: NOW,
    });

    expect(response.results).toHaveLength(2);
    expect(response.selection.omitted.forLimit).toBe(1);
    expect(response.selection.candidates).toEqual({
      ranked: 3,
      rechecked: 3,
      omittedOnRecheck: 0,
    });
  });
});
