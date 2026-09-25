import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { MCPServer } from "@openai/agents";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  KnowledgeEntryListResponse,
  KnowledgeSavePreparationResponse,
  type AttemptToolIdentity,
  type AttemptToolResult,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { PrefixedMcpServer, prefixedMcpToolName, prepareAgentTools } from "../src";
import { projectKnowledgeToolResultForModel } from "../src/knowledge-model-projection";
import { unwrapSdkMcpResultProjection } from "../src/mcp-result-custom-data";
import {
  projectAttemptToolResultForCaller,
  wrapAttemptToolDefinitions,
} from "../src/tool-result-spill";

type Json = Record<string, any>;

const SEARCH: AttemptToolIdentity = { serverId: "opengeni", toolName: "knowledge_search" };
const DOCS_SEARCH: AttemptToolIdentity = { serverId: "docs", toolName: "knowledge_search" };
const PREPARE: AttemptToolIdentity = { serverId: "opengeni", toolName: "knowledge_prepare_save" };
const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// ---- deterministic, contract-valid fixtures --------------------------------
// Sizes follow the staging medians: a search entry is ~2.2 KB with ~800
// characters of title plus excerpt, and a prepare-save result is ~22 KB with a
// ~9 KB collection map (~4 KB descriptions) and ~11 KB of matches.

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function timestamp(seed: number): string {
  return new Date(Date.UTC(2026, 6, 1) + seed * 3_600_007).toISOString();
}

const WORDS = [
  "customer",
  "invoice",
  "deployment",
  "cluster",
  "region",
  "migration",
  "renewal",
  "contract",
  "incident",
  "latency",
  "database",
  "replica",
  "rollback",
  "approval",
  "workspace",
  "billing",
  "quota",
  "Acme",
  "Northwind",
  "requirement",
  "support",
  "escalation",
  "owner",
  "timeline",
  "the",
  "and",
  "for",
  "with",
  "after",
  "before",
];

function prose(seed: number, length: number): string {
  let state = seed * 7919 + 17;
  let text = "";
  let sentence = 0;
  while (text.length < length) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const word = WORDS[state % WORDS.length]!;
    text += sentence === 0 ? word[0]!.toUpperCase() + word.slice(1) : ` ${word}`;
    sentence += 1;
    if (sentence > 8 && state % 5 === 0) {
      text += state % 3 === 0 ? '.\n"Quoted note" follows. ' : ". ";
      sentence = 0;
    }
  }
  return text.slice(0, length);
}

type EntryInput = {
  label: string;
  title: string;
  contentLength: number;
  view: "published" | "needs_review";
  /** Index of the best-matching 1,200-character chunk, or null for no excerpt. */
  chunk: number | null;
  kind?: string;
  sourceKind?: string | null;
  indexStatus?: string;
  groups?: number;
  /** A newer pending revision exists above the published one. */
  newerPending?: boolean;
  /** A pending correction of an already-published entry. */
  correction?: boolean;
};

function entrySummary(input: EntryInput): Json {
  const content = prose(input.label.length * 31 + input.contentLength, input.contentLength);
  const id = uuid(`entry:${input.label}`);
  const publishedRevisionId = uuid(`published:${input.label}`);
  const pendingRevisionId = uuid(`pending:${input.label}`);
  const pending = input.view === "needs_review";
  const revisionId = pending ? pendingRevisionId : publishedRevisionId;
  const excerpts: Json[] = [];
  if (input.chunk !== null) {
    const start = input.chunk * 1_040;
    const end = Math.min(start + 1_200, content.length);
    excerpts.push({ field: "content", start, end, text: content.slice(start, end) });
  }
  return {
    score: 0.4 + (input.contentLength % 97) / 100,
    excerpts,
    id,
    scope: input.label.includes("personal") ? "personal" : "workspace",
    version: pending ? 4 : 3,
    publishedRevisionId: pending && !input.correction ? null : publishedRevisionId,
    latestRevisionId: pending || input.newerPending ? pendingRevisionId : publishedRevisionId,
    archived: false,
    createdAt: timestamp(input.contentLength),
    updatedAt: timestamp(input.contentLength + 40),
    ...(input.indexStatus ? { indexStatus: input.indexStatus } : {}),
    revision: {
      id: revisionId,
      entryId: id,
      number: pending ? 4 : 3,
      change: "upsert",
      previousRevisionId: uuid(`previous:${input.label}`),
      restoredFromRevisionId: null,
      createdAt: timestamp(input.contentLength + 20),
      createdBySessionId: uuid(`session:${input.label}`),
      reviewBatchId: pending ? uuid(`batch:${input.label}`) : null,
      outcome: pending ? "pending" : "published",
      title: input.title,
      kind: input.kind ?? "fact",
      preview: content.slice(0, 512),
      groupIds: Array.from({ length: input.groups ?? 1 }, (_, index) => uuid(`group:${index}`)),
      sourceKind: input.sourceKind ?? null,
    },
  };
}

function searchFixture(): Json {
  // One in eight results has its best chunk past the preview: that preview
  // carries text the excerpt does not (staging measured 12%).
  const response = {
    entries: [
      entrySummary({
        label: "acme-renewal",
        title: "Acme renewal terms and notice period",
        contentLength: 760,
        view: "published",
        chunk: 0,
        groups: 2,
      }),
      entrySummary({
        label: "db-failover",
        title: "Primary database failover incident, March",
        contentLength: 910,
        view: "published",
        chunk: 0,
        kind: "incident",
      }),
      entrySummary({
        label: "eu-region",
        title: "EU data residency requirement",
        contentLength: 540,
        view: "published",
        chunk: 0,
        kind: "requirement",
        newerPending: true,
      }),
      entrySummary({
        label: "billing-owner",
        title: "Billing escalation owner",
        contentLength: 620,
        view: "published",
        chunk: 0,
      }),
      entrySummary({
        label: "runbook-source",
        title: "Northwind support runbook (retained source)",
        contentLength: 3_200,
        view: "published",
        chunk: 2,
        kind: "source",
        sourceKind: "file",
        indexStatus: "indexed",
        groups: 2,
      }),
      entrySummary({
        label: "quota-decision",
        title: "Decision: raise workspace quota for Acme",
        contentLength: 830,
        view: "published",
        chunk: 0,
        kind: "decision",
      }),
      entrySummary({
        label: "latency-note",
        title: "Latency budget for the API gateway",
        contentLength: 700,
        view: "published",
        chunk: 0,
        kind: "note",
      }),
      entrySummary({
        label: "rollback-plan",
        title: "Rollback plan for schema migrations",
        contentLength: 880,
        view: "published",
        chunk: 0,
      }),
    ],
    nextCursor: Buffer.from(`cursor:${"x".repeat(80)}`).toString("base64url"),
    searchMode: "hybrid",
  };
  KnowledgeEntryListResponse.parse(response);
  return response;
}

function collection(index: number, view: "published" | "needs_review" = "published"): Json {
  const description = prose(index + 1_000, 150 + ((index * 53) % 110));
  return {
    id: uuid(`group:${index}`),
    revisionId: uuid(`group-revision:${index}:${view}`),
    version: 1 + (index % 4),
    scope: index % 7 === 0 ? "organization" : "workspace",
    view,
    title: `${WORDS[index % WORDS.length]} ${WORDS[(index * 3) % WORDS.length]} collection`,
    description,
    descriptionTruncated: false,
    parentIds: index > 3 ? [uuid(`group:${index % 4}`)] : [],
  };
}

function prepareFixture(): Json {
  const collections = Array.from({ length: 19 }, (_, index) => collection(index));
  collections.push(collection(3, "needs_review"));
  const response = {
    collections: {
      entries: collections,
      complete: true,
      nextCursors: { published: null, needs_review: null },
    },
    matches: {
      published: {
        entries: [
          entrySummary({
            label: "prep-acme",
            title: "Acme renewal terms",
            contentLength: 700,
            view: "published",
            chunk: 0,
            groups: 2,
          }),
          entrySummary({
            label: "prep-owner",
            title: "Billing escalation owner",
            contentLength: 450,
            view: "published",
            chunk: 0,
          }),
          entrySummary({
            label: "prep-quota",
            title: "Acme quota decision",
            contentLength: 800,
            view: "published",
            chunk: 0,
            kind: "decision",
          }),
          entrySummary({
            label: "prep-region",
            title: "EU residency requirement",
            contentLength: 620,
            view: "published",
            chunk: 0,
            kind: "requirement",
          }),
        ],
        nextCursor: null,
        searchMode: "hybrid",
      },
      needs_review: {
        entries: [
          entrySummary({
            label: "prep-pending-acme",
            title: "Acme renewal notice change",
            contentLength: 300,
            view: "needs_review",
            chunk: 0,
            correction: true,
          }),
          entrySummary({
            label: "prep-pending-new",
            title: "Acme onboarding contact",
            contentLength: 730,
            view: "needs_review",
            chunk: 0,
          }),
        ],
        nextCursor: null,
        searchMode: "hybrid",
      },
    },
  };
  KnowledgeSavePreparationResponse.parse(response);
  return response;
}

function textResult(value: unknown): AttemptToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function textOf(result: AttemptToolResult): string {
  const [content] = result.content;
  if (content?.type !== "text") throw new Error("expected one text block");
  return content.text;
}

function compactOf(identity: AttemptToolIdentity, value: unknown): Json {
  return JSON.parse(textOf(projectKnowledgeToolResultForModel(identity, textResult(value))));
}

function context(kind: "model" | "codemode"): AttemptToolExecutionContext {
  return {
    operationId: OPERATION_ID,
    caller: { kind, subjectId: kind === "codemode" ? "codemode:test" : "worker:mcp-model" },
  };
}

/** Every text the model sees for one compact entry, in any field. */
function shownText(entry: Json): string[] {
  return [
    entry.revision.title,
    ...(entry.revision.preview === undefined ? [] : [entry.revision.preview]),
    ...entry.excerpts.map((excerpt: Json) => excerpt.text),
  ];
}

function expectEntryLossless(original: Json, compact: Json): void {
  expect(compact.id).toBe(original.id);
  expect(compact.scope).toBe(original.scope);
  expect(compact.version).toBe(original.version);
  expect(compact.revision.id).toBe(original.revision.id);
  expect(compact.revision.outcome).toBe(original.revision.outcome);
  expect(compact.revision.title).toBe(original.revision.title);
  expect(compact.revision.kind).toBe(original.revision.kind);
  expect(compact.revision.groupIds).toEqual(original.revision.groupIds);
  expect(compact.indexStatus).toBe(original.indexStatus);
  const shown = shownText(compact);
  for (const text of [
    original.revision.title,
    original.revision.preview,
    ...original.excerpts.map((excerpt: Json) => excerpt.text),
  ]) {
    expect(shown.some((value) => value.includes(text))).toBe(true);
  }
  for (const key of ["createdAt", "updatedAt", "score"]) expect(compact).not.toHaveProperty(key);
  for (const key of [
    "entryId",
    "number",
    "previousRevisionId",
    "restoredFromRevisionId",
    "createdAt",
    "createdBySessionId",
    "reviewBatchId",
  ]) {
    expect(compact.revision).not.toHaveProperty(key);
  }
}

// ---- tests -----------------------------------------------------------------

describe("Knowledge discovery model projection", () => {
  test("search keeps every actionable field and all shown text", () => {
    const original = searchFixture();
    const compact = compactOf(SEARCH, original);
    expect(compact.nextCursor).toBe(original.nextCursor);
    expect(compact.searchMode).toBe("hybrid");
    expect(compact.entries).toHaveLength(original.entries.length);
    original.entries.forEach((entry: Json, index: number) =>
      expectEntryLossless(entry, compact.entries[index]),
    );
  });

  test("preview is dropped only when an excerpt repeats it verbatim", () => {
    const original = searchFixture();
    const compact = compactOf(SEARCH, original);
    const source = compact.entries.find((entry: Json) => entry.revision.kind === "source");
    const sourceOriginal = original.entries.find((entry: Json) => entry.id === source.id);
    // Best chunk 2 starts at 2,080: the first 512 characters are unique text.
    expect(source.excerpts[0].start).toBe(2_080);
    expect(source.revision.preview).toBe(sourceOriginal.revision.preview);
    expect(source.revision.sourceKind).toBe("file");
    for (const entry of compact.entries.filter((candidate: Json) => candidate !== source)) {
      expect(entry.revision).not.toHaveProperty("preview");
      expect(entry.excerpts).toHaveLength(1);
    }
  });

  test("an entry without an excerpt keeps its preview", () => {
    const original = {
      entries: [
        entrySummary({
          label: "unindexed",
          title: "Unindexed note",
          contentLength: 640,
          view: "published",
          chunk: null,
        }),
      ],
      nextCursor: null,
      searchMode: "keyword",
      fallbackReason: "provider_unavailable",
    };
    const compact = compactOf(SEARCH, original);
    expect(compact.fallbackReason).toBe("provider_unavailable");
    expect(compact.entries[0].excerpts).toEqual([]);
    expect(compact.entries[0].revision.preview).toBe(original.entries[0]!.revision.preview);
  });

  test("a title excerpt repeated by the title is dropped", () => {
    const entry = entrySummary({
      label: "empty-group",
      title: "Acme collection",
      contentLength: 0,
      view: "published",
      chunk: null,
      kind: "group",
    });
    entry.excerpts = [{ field: "title", start: 0, end: 15, text: "Acme collection" }];
    const compact = compactOf(SEARCH, { entries: [entry], nextCursor: null });
    expect(compact.entries[0].excerpts).toEqual([]);
    expect(compact.entries[0].revision).not.toHaveProperty("preview");
    expect(compact.entries[0].revision.title).toBe("Acme collection");
  });

  test("state that differs from the defaults is kept", () => {
    const original = searchFixture();
    const compact = compactOf(SEARCH, original);
    const withPending = compact.entries.find((entry: Json) => entry.latestRevisionId);
    expect(withPending.latestRevisionId).not.toBe(withPending.revision.id);
    expect(withPending).not.toHaveProperty("publishedRevisionId");
    for (const entry of compact.entries.filter((candidate: Json) => candidate !== withPending)) {
      expect(entry).not.toHaveProperty("publishedRevisionId");
      expect(entry).not.toHaveProperty("latestRevisionId");
      expect(entry).not.toHaveProperty("archived");
      expect(entry.revision).not.toHaveProperty("change");
    }

    const unusual = entrySummary({
      label: "archived",
      title: "Archived entry",
      contentLength: 300,
      view: "published",
      chunk: 0,
    });
    unusual.archived = true;
    unusual.revision.change = "archive";
    unusual.revision.entryId = uuid("some other entry");
    const [kept] = compactOf(SEARCH, { entries: [unusual], nextCursor: null }).entries;
    expect(kept.archived).toBe(true);
    expect(kept.revision.change).toBe("archive");
    expect(kept.revision.entryId).toBe(unusual.revision.entryId);
  });

  test("pending matches keep their published pointer, including null", () => {
    const original = prepareFixture();
    const compact = compactOf(PREPARE, original);
    const [correction, proposal] = compact.matches.needs_review.entries;
    expect(correction.revision.outcome).toBe("pending");
    expect(correction.publishedRevisionId).toBe(
      original.matches.needs_review.entries[0].publishedRevisionId,
    );
    expect(proposal.publishedRevisionId).toBeNull();
    expect(correction).not.toHaveProperty("latestRevisionId");
  });

  test("prepare-save keeps the collection map and match identities", () => {
    const original = prepareFixture();
    const compact = compactOf(PREPARE, original);
    expect(compact.collections.complete).toBe(true);
    expect(compact.collections.nextCursors).toEqual(original.collections.nextCursors);
    expect(compact.collections.entries).toHaveLength(original.collections.entries.length);
    original.collections.entries.forEach((descriptor: Json, index: number) => {
      const kept = compact.collections.entries[index];
      const { revisionId: _revisionId, descriptionTruncated: _truncated, ...rest } = descriptor;
      expect(kept).toEqual(rest);
    });
    for (const view of ["published", "needs_review"] as const) {
      expect(compact.matches[view].nextCursor).toBe(original.matches[view].nextCursor);
      original.matches[view].entries.forEach((entry: Json, index: number) =>
        expectEntryLossless(entry, compact.matches[view].entries[index]),
      );
    }
  });

  test("a truncated collection description still reports truncation", () => {
    const original = prepareFixture();
    original.collections.entries[0].descriptionTruncated = true;
    original.collections.complete = false;
    original.collections.nextCursors.published = "next-page";
    const compact = compactOf(PREPARE, original);
    expect(compact.collections.entries[0].descriptionTruncated).toBe(true);
    expect(compact.collections.entries[1]).not.toHaveProperty("descriptionTruncated");
    expect(compact.collections.complete).toBe(false);
    expect(compact.collections.nextCursors.published).toBe("next-page");
  });

  test("the Docs server's knowledge_search uses the same projection", () => {
    const original = searchFixture();
    expect(compactOf(DOCS_SEARCH, original)).toEqual(compactOf(SEARCH, original));
  });

  test("anything outside the exact contract is returned unchanged", () => {
    const search = searchFixture();
    const unknownEntryField = structuredClone(search);
    unknownEntryField.entries[0].futureField = "kept by returning the exact result";
    const cases: [AttemptToolIdentity, AttemptToolResult][] = [
      [SEARCH, { ...textResult(search), isError: true }],
      [SEARCH, { ...textResult(search), structuredContent: { entries: [] } }],
      [SEARCH, { content: [{ type: "text", text: "not json" }] }],
      [SEARCH, { content: [...textResult(search).content, { type: "text", text: "second" }] }],
      [SEARCH, textResult(unknownEntryField)],
      [SEARCH, textResult(prepareFixture())],
      [PREPARE, textResult(search)],
      [{ serverId: "opengeni", toolName: "knowledge_browse" }, textResult(search)],
      [{ serverId: "opengeni", toolName: "knowledge_get" }, textResult(search)],
      [{ serverId: "docs", toolName: "knowledge_prepare_save" }, textResult(prepareFixture())],
      [{ serverId: "connector", toolName: "knowledge_search" }, textResult(search)],
    ];
    for (const [identity, result] of cases) {
      expect(projectKnowledgeToolResultForModel(identity, result)).toBe(result);
    }
  });

  test("projecting an already compact result is a no-op", () => {
    const once = projectKnowledgeToolResultForModel(SEARCH, textResult(searchFixture()));
    expect(projectKnowledgeToolResultForModel(SEARCH, once)).toBe(once);
    const prepared = projectKnowledgeToolResultForModel(PREPARE, textResult(prepareFixture()));
    expect(projectKnowledgeToolResultForModel(PREPARE, prepared)).toBe(prepared);
  });

  test("result metadata outside the text block is preserved", () => {
    const result: AttemptToolResult = {
      ...textResult(searchFixture()),
      _meta: { trace: "kept" },
    };
    const projected = projectKnowledgeToolResultForModel(SEARCH, result);
    expect(projected._meta).toEqual({ trace: "kept" });
    expect(textOf(projected).length).toBeLessThan(textOf(result).length);
  });
});

describe("caller seam", () => {
  test("Codemode receives the exact result; the model receives the projection", async () => {
    const result = textResult(searchFixture());
    const exact = textOf(result);
    const codemode = await projectAttemptToolResultForCaller(
      result,
      context("codemode"),
      undefined,
      SEARCH,
    );
    expect(codemode).toBe(result);
    expect(textOf(codemode)).toBe(exact);
    const model = await projectAttemptToolResultForCaller(
      result,
      context("model"),
      undefined,
      SEARCH,
    );
    expect(textOf(model)).toBe(textOf(projectKnowledgeToolResultForModel(SEARCH, result)));
    expect(textOf(result)).toBe(exact);
  });

  test("wrapped definitions project by their own identity", async () => {
    const result = textResult(searchFixture());
    const definition = (identity: AttemptToolIdentity, source: "opengeni" | "interaction") => ({
      identity,
      modelName: `${identity.serverId}__${identity.toolName}`,
      inputSchema: { type: "object" },
      source,
      approval: "none" as const,
      execute: async () => result,
    });
    const [search, other] = wrapAttemptToolDefinitions([
      definition(SEARCH, "opengeni"),
      definition({ serverId: "interaction", toolName: "knowledge_search_like" }, "interaction"),
    ]);
    expect(textOf(await search!.execute({}, context("model")))).not.toBe(textOf(result));
    expect(await search!.execute({}, context("codemode"))).toBe(result);
    expect(await other!.execute({}, context("model"))).toBe(result);
  });

  test("prepared first-party MCP: model calls are compact, Codemode calls are byte-for-byte exact", async () => {
    const search = JSON.stringify(searchFixture());
    const prepare = JSON.stringify(prepareFixture());
    const outputs: Record<string, string> = {
      knowledge_search: search,
      knowledge_prepare_save: prepare,
      knowledge_browse: search,
    };
    const server = (name: string, tools: string[]): MCPServer => ({
      name,
      cacheToolsList: false,
      async connect() {},
      async close() {},
      async listTools() {
        return tools.map((tool) => ({
          name: tool,
          description: tool,
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
            additionalProperties: true,
          },
        }));
      },
      async callTool(tool: string) {
        return [{ type: "text", text: outputs[tool]! }];
      },
      async callToolResult(tool: string) {
        return { content: [{ type: "text", text: outputs[tool]! }] };
      },
      async invalidateToolsCache() {},
    });
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: "https://mcp.example.test/og",
            cacheToolsList: false,
          },
          {
            id: "docs",
            name: "Knowledge",
            url: "https://mcp.example.test/docs",
            cacheToolsList: false,
          },
        ],
      }),
      [
        { kind: "mcp", id: "opengeni" },
        { kind: "mcp", id: "docs" },
      ],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
        localMcpServers: [
          {
            id: "opengeni",
            server: server("og-inner", [
              "knowledge_search",
              "knowledge_prepare_save",
              "knowledge_browse",
            ]),
          },
          { id: "docs", server: server("docs-inner", ["knowledge_search"]) },
        ],
      },
    );
    try {
      const environment = prepared.attemptToolEnvironment!;
      const catalogDigest = prepared.attemptToolCatalog!.digest;
      const cases: [AttemptToolIdentity, string, boolean][] = [
        [SEARCH, search, true],
        [PREPARE, prepare, true],
        [DOCS_SEARCH, search, true],
        [{ serverId: "opengeni", toolName: "knowledge_browse" }, search, false],
      ];
      for (const [identity, exact, compacted] of cases) {
        const byServer = prepared.mcpServers.find(
          (candidate) =>
            candidate instanceof PrefixedMcpServer && candidate.registryId === identity.serverId,
        )!;
        const model = unwrapSdkMcpResultProjection(
          await byServer.callToolResult!(
            prefixedMcpToolName(identity.serverId, identity.toolName),
            {},
          ),
        ) as AttemptToolResult;
        const expectedModel = compacted
          ? textOf(projectKnowledgeToolResultForModel(identity, textResult(JSON.parse(exact))))
          : exact;
        expect(textOf(model)).toBe(expectedModel);
        if (compacted) expect(textOf(model).length).toBeLessThan(exact.length);

        const codemode = await environment.call({
          operationId: crypto.randomUUID(),
          catalogDigest,
          identity,
          arguments: {},
          caller: { kind: "codemode", subjectId: "codemode:test" },
        });
        expect(codemode.content).toEqual([{ type: "text", text: exact }]);
        expect(codemode.structuredContent).toBeUndefined();
      }
    } finally {
      await prepared.close();
    }
  });
});

describe("measured reduction", () => {
  const utf8 = (value: string): number => Buffer.byteLength(value, "utf8");

  test("realistic fixtures shrink without losing content", () => {
    const rows = (
      [
        ["knowledge_search", SEARCH, searchFixture()],
        ["knowledge_prepare_save", PREPARE, prepareFixture()],
      ] as const
    ).map(([name, identity, value]) => {
      const exact = textResult(value);
      const compact = projectKnowledgeToolResultForModel(identity, exact);
      const textBytes = [utf8(textOf(exact)), utf8(textOf(compact))] as const;
      // The model reads the serialized MCP result, including JSON escaping.
      const modelBytes = [utf8(JSON.stringify(exact)), utf8(JSON.stringify(compact))] as const;
      return {
        name,
        textBytes,
        modelBytes,
        textReduction: 1 - textBytes[1] / textBytes[0],
        modelReduction: 1 - modelBytes[1] / modelBytes[0],
      };
    });
    const [search, prepare] = rows;
    // Fixture calibration against the staging medians.
    expect(search!.textBytes[0] / searchFixture().entries.length).toBeGreaterThan(1_900);
    expect(search!.textBytes[0] / searchFixture().entries.length).toBeLessThan(2_500);
    expect(prepare!.textBytes[0]).toBeGreaterThan(19_000);
    expect(prepare!.textBytes[0]).toBeLessThan(25_000);
    // Canonical measurement; see docs/knowledge.md.
    expect(search!.textReduction).toBeGreaterThan(0.4);
    expect(prepare!.textReduction).toBeGreaterThan(0.25);
    for (const row of rows) {
      expect(row.modelReduction).toBeGreaterThan(row.textReduction - 0.02);
    }
  });
});
