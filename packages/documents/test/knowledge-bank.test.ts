import { describe, expect, test } from "bun:test";
import { renderKnowledgeBankBlock, sanitizeCharterText } from "@opengeni/db";
import {
  HeuristicCharterSynthesizer,
  heuristicCharterSynthesis,
  parseCharterSynthesis,
  type CharterSynthesisInput,
} from "../src/knowledge-bank";

const emptyMap = {
  bases: [],
  totalDocuments: 0,
  totalReadyDocuments: 0,
  totalMemories: 0,
  memoriesByKind: {},
  topics: [],
};

const populatedInput: CharterSynthesisInput = {
  currentCharter: null,
  map: {
    bases: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Contracts",
        description: null,
        documentCount: 3,
        readyCount: 3,
        topics: ["vendors", "renewal"],
        lastDocumentAt: null,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Empty",
        description: null,
        documentCount: 0,
        readyCount: 0,
        topics: [],
        lastDocumentAt: null,
      },
    ],
    totalDocuments: 3,
    totalReadyDocuments: 3,
    totalMemories: 2,
    memoriesByKind: { decision: 2 },
    topics: [
      { topic: "vendors", count: 2 },
      { topic: "renewal", count: 1 },
    ],
  },
  recentDocuments: [],
  recentMemories: [],
};

describe("knowledge bank synthesis", () => {
  test("heuristic first charter derives purpose from top topics and notes only non-empty bases", () => {
    const outcome = heuristicCharterSynthesis(populatedInput);
    expect(outcome.purpose).toContain("vendors");
    expect(outcome.overview).toContain("3 indexed documents");
    expect(outcome.baseNotes).toHaveLength(1);
    expect(outcome.baseNotes[0]?.name).toBe("Contracts");
    expect(outcome.changelog).toContain("3 documents");
  });

  test("heuristic preserves a human purpose/goals and flags uncovered goals as gaps", () => {
    const outcome = heuristicCharterSynthesis({
      ...populatedInput,
      currentCharter: {
        version: 2,
        purpose: "Run vendor management for Acme.",
        goals: ["Track vendor renewals", "Prepare compliance certification"],
        overview: null,
        gaps: [],
      },
    });
    expect(outcome.purpose).toBe("Run vendor management for Acme.");
    expect(outcome.goals).toEqual(["Track vendor renewals", "Prepare compliance certification"]);
    // "renewals" stems past the exact topic "renewal", so only the compliance
    // goal is guaranteed uncovered by the topic set.
    expect(outcome.gaps.some((gap) => gap.includes("compliance"))).toBe(true);
  });

  test("heuristic empty workspace produces a bootstrap purpose and no overview", async () => {
    const synthesizer = new HeuristicCharterSynthesizer();
    const outcome = await synthesizer.synthesize({
      currentCharter: null,
      map: emptyMap,
      recentDocuments: [],
      recentMemories: [],
    });
    expect(outcome.purpose).toContain("Drop documents");
    expect(outcome.overview).toBeNull();
    expect(synthesizer.model).toBe("heuristic");
  });

  test("parseCharterSynthesis clamps fields and falls back per-field on garbage", () => {
    const outcome = parseCharterSynthesis(
      JSON.stringify({
        purpose: "  Organize vendor knowledge.  ",
        goals: ["a".repeat(400), 42, "  Track renewals  "],
        overview: "",
        baseNotes: "nope",
        gaps: ["missing SOC2 docs"],
        changelog: "Initial synthesis.",
      }),
      populatedInput,
    );
    expect(outcome.purpose).toBe("Organize vendor knowledge.");
    expect(outcome.goals).toEqual(["a".repeat(300), "Track renewals"]);
    // empty overview → heuristic fallback overview
    expect(outcome.overview).toContain("3 indexed documents");
    // non-array baseNotes → heuristic fallback notes
    expect(outcome.baseNotes[0]?.name).toBe("Contracts");
    expect(outcome.gaps).toEqual(["missing SOC2 docs"]);
  });

  test("parseCharterSynthesis rejects non-object payloads", () => {
    expect(() => parseCharterSynthesis("[]", populatedInput)).toThrow("non-object");
    expect(() => parseCharterSynthesis("null", populatedInput)).toThrow("non-object");
  });
});

describe("knowledge bank block rendering", () => {
  test("renders purpose, goals, and gaps under the header", () => {
    const block = renderKnowledgeBankBlock({
      purpose: "Run vendor management.",
      goals: ["Track renewals"],
      gaps: ["No SOC2 evidence indexed"],
    });
    expect(block).toContain("## Workspace knowledge bank");
    expect(block).toContain("Purpose: Run vendor management.");
    expect(block).toContain("- Track renewals");
    expect(block).toContain("Known knowledge gaps:");
  });

  test("stays within the token budget for oversized charters", () => {
    const block = renderKnowledgeBankBlock({
      purpose: "p".repeat(5000),
      goals: Array.from({ length: 50 }, (_, index) => `goal ${index} ${"x".repeat(200)}`),
      gaps: [],
    });
    expect(block).not.toBeNull();
    // ~4 chars/token estimate: budget 600 tokens plus header slack.
    expect((block ?? "").length).toBeLessThan(600 * 4 + 400);
  });

  test("sanitizeCharterText redacts secrets and clamps length", () => {
    const sanitized = sanitizeCharterText(
      `Use api_key="sk-1234567890abcdef1234" for the vendor portal. ${"y".repeat(3000)}`,
      100,
    );
    expect(sanitized).not.toContain("sk-1234567890abcdef1234");
    expect(sanitized.length).toBeLessThanOrEqual(100);
  });
});
