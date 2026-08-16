import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CompanyBrainKnowledgeRecord } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
let knowledgePermission: "available" | "unavailable" = "available";
let guidanceTruncated = false;
const record: CompanyBrainKnowledgeRecord = {
  id: "document:00000000-0000-4000-8000-000000000010",
  kind: "document",
  title: "Architecture handbook",
  content: {
    format: "markdown",
    body: "Canonical architecture body",
    summary: "How the platform is built.",
    topics: ["architecture"],
    metadata: {},
  },
  authority: { kind: "workspace" },
  provenance: {
    source: {
      kind: "document",
      uri: null,
      externalId: null,
      title: "Architecture handbook",
      author: null,
      createdAt: null,
      updatedAt: null,
      version: null,
    },
    indexedAt: "2026-08-15T12:00:00.000Z",
  },
  lifecycle: { state: "active", updatedAt: "2026-08-15T12:00:00.000Z" },
  quality: {
    trust: "sourced",
    freshnessAt: "2026-08-15T12:00:00.000Z",
    conflict: "not_evaluated",
    correction: "current_source_version",
  },
  links: [],
  projection: { truncated: false, fields: [] },
};

function companyBrainPayload(targetWorkspaceId = workspaceId) {
  return {
    kind: "opengeni.company_brain.okf" as const,
    schemaVersion: 1 as const,
    workspaceId: targetWorkspaceId,
    generatedAt: "2026-08-15T12:00:00.000Z",
    permissions: { guidance: "available" as const, knowledge: knowledgePermission },
    guidance: {
      entries: [
        {
          id: "guide:review",
          revisionId: "00000000-0000-4000-8000-000000000020",
          path: "ways/review.md",
          scope: "workspace" as const,
          classification: "guide" as const,
          title: "Review guide",
          description: "How reviews work",
          content: "Read the complete diff.",
          contentHash: "a".repeat(64),
          revision: 2,
          active: true,
          lifecycle: "active" as const,
          provenance: { source: "human", sourceId: null, trust: "explicit" },
          relationships: [],
          createdAt: "2026-08-15T12:00:00.000Z",
        },
      ],
      truncated: guidanceTruncated,
      truncationReasons: guidanceTruncated ? (["aggregate_item_count"] as const) : [],
    },
    knowledge: {
      availability: "available" as const,
      documents: {
        total: 1,
        statusCounts: { queued: 0, indexing: 0, ready: 1, failed: 0, deleted: 0 },
        sourceKindCounts: { document: 1 },
        authorityKindCounts: { organization: 0, workspace: 1, personal: 0 },
        latestUpdatedAt: "2026-08-15T12:00:00.000Z",
        topics: [{ name: "architecture", documentCount: 1 }],
        topicsTruncated: false,
      },
      memories: {
        total: 0,
        statusCounts: {},
        kindCounts: {},
        latestCreatedAt: null,
        sample: [],
        sampleTruncated: false,
      },
      gaps: [],
    },
    omissions: ["session_messages_and_task_notes" as const],
  };
}
const getCompanyBrain = mock(async (targetWorkspaceId = workspaceId) =>
  companyBrainPayload(targetWorkspaceId),
);
const browseCompanyBrainKnowledge = mock(async () => ({
  records: [record],
  nextCursor: null,
  hasMore: false,
  selection: {},
}));
const listCompanyBrainContextReceipts = mock(async () => ({
  receipts: [
    {
      id: "00000000-0000-4000-8000-000000000030",
      sessionId: "00000000-0000-4000-8000-000000000031",
      rootSessionId: "00000000-0000-4000-8000-000000000031",
      turnId: "00000000-0000-4000-8000-000000000032",
      acceptedAt: "2026-08-15T12:00:00.000Z",
      createdAt: "2026-08-15T12:00:01.000Z",
      sessionRole: "root" as const,
      memoryEnabled: true,
      memoryPromptMode: "retrieval_only" as const,
      companyProfileIncluded: true,
      instructionPolicyEntryHash: "a".repeat(64),
      preferenceDescriptorHash: "b".repeat(64),
      companyProfileSnapshotHash: "c".repeat(64),
      turnContextSnapshotId: "00000000-0000-4000-8000-000000000033",
      turnContextSnapshotHash: "d".repeat(64),
      turnContextSnapshotSource: "accepted_turn" as const,
      selectionHash: "e".repeat(64),
      selectedMemoryCount: 3,
      renderedMemoryCount: 2,
      budgetOmittedMemoryCount: 1,
    },
  ],
  nextCursor: null,
  hasMore: false,
}));
const listCompanyBrainKnowledgeProposals = mock(async () => ({
  proposals: [
    {
      id: "00000000-0000-4000-8000-000000000040",
      authority: { kind: "workspace" as const },
      targetKind: "instruction_policy" as const,
      targetScope: "global",
      targetKey: null,
      content: "Proposed reviewed process",
      contentHash: "f".repeat(64),
      source: {
        claimId: "00000000-0000-4000-8000-000000000041",
        evidenceId: "00000000-0000-4000-8000-000000000042",
      },
      status: "proposed" as const,
      createdAt: "2026-08-15T12:00:00.000Z",
      projection: { truncated: false, originalContentUtf8Bytes: 25 },
    },
  ],
  truncatedForCount: false,
  truncatedForResponseBytes: false,
  responseBytes: 500,
}));
const searchCompanyBrainKnowledge = mock(async () => ({
  results: [{ record }],
  selection: { omitted: { belowRelevanceFloor: 0 }, budget: { estimatedTokens: 30 } },
}));
const getCompanyBrainKnowledge = mock(async () => ({ record }));
let recordResponseOverride: Promise<{ record: CompanyBrainKnowledgeRecord }> | null = null;
const browseResponseOverrides: unknown[] = [];
const receiptResponseOverrides: unknown[] = [];
const requestJson = mock(async function requestJson<T>(
  method: string,
  path: string,
  _body?: unknown,
): Promise<T> {
  if (path.endsWith("/knowledge/search")) return (await searchCompanyBrainKnowledge()) as T;
  if (path.includes("/knowledge/record")) {
    return (recordResponseOverride ?? (await getCompanyBrainKnowledge())) as T;
  }
  if (path.endsWith("/knowledge/browse")) {
    return (browseResponseOverrides.shift() ?? (await browseCompanyBrainKnowledge())) as T;
  }
  if (path.includes("/context-receipts")) {
    return (receiptResponseOverrides.shift() ?? (await listCompanyBrainContextReceipts())) as T;
  }
  if (path.includes("/knowledge-proposals"))
    return (await listCompanyBrainKnowledgeProposals()) as T;
  throw new Error(`Unexpected ${method} ${path}`);
});
const context = {
  client: {
    getCompanyBrain,
    requestJson,
    browseCompanyBrainKnowledge,
    listCompanyBrainContextReceipts,
    listCompanyBrainKnowledgeProposals,
    searchCompanyBrainKnowledge,
    getCompanyBrainKnowledge,
  },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

const { CompanyBrainInspector } = await import("./company-brain-inspector");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("Company Brain inspector", () => {
  test("shows authorized guidance, Knowledge, context facts, and inactive proposals responsively", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<CompanyBrainInspector workspaceId={workspaceId} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Guidance & history");
    expect(container.textContent).toContain("Review guide");
    expect(container.textContent).toContain("Architecture handbook");
    expect(container.textContent).toContain("Why agents used context");
    expect(container.textContent).toContain("2 rendered of 3");
    expect(container.textContent).toContain("Knowledge-backed proposals");
    expect(container.querySelector(".xl\\:grid-cols-2")).not.toBeNull();
    expect(container.querySelector("#company-brain-knowledge-query")).not.toBeNull();

    const inspect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Inspect",
    );
    await act(async () => {
      inspect?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Canonical architecture body");

    await act(async () => root.unmount());
    container.remove();
  });

  test("keeps guidance and receipts useful when Knowledge is not authorized", async () => {
    knowledgePermission = "unavailable";
    const browseCalls = browseCompanyBrainKnowledge.mock.calls.length;
    const proposalCalls = listCompanyBrainKnowledgeProposals.mock.calls.length;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<CompanyBrainInspector workspaceId={workspaceId} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Review guide");
    expect(container.textContent).toContain("Why agents used context");
    expect(container.textContent).toContain(
      "Knowledge is unavailable with your current workspace access.",
    );
    expect(container.querySelector("#company-brain-knowledge-query")).toBeNull();
    expect(browseCompanyBrainKnowledge.mock.calls.length).toBe(browseCalls);
    expect(listCompanyBrainKnowledgeProposals.mock.calls.length).toBe(proposalCalls);

    await act(async () => root.unmount());
    container.remove();
    knowledgePermission = "available";
  });

  test("clears and fences workspace bodies while authority changes mid-request", async () => {
    const nextWorkspaceId = "00000000-0000-4000-8000-000000000002";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<CompanyBrainInspector key={workspaceId} workspaceId={workspaceId} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Review guide");
    const guidanceInput = [...container.querySelectorAll("label")]
      .find((item) => item.textContent?.includes("Filter guidance"))
      ?.querySelector("input");
    const knowledgeInput = container.querySelector<HTMLInputElement>(
      "#company-brain-knowledge-query",
    );
    await act(async () => {
      for (const [input, value] of [
        [guidanceInput, "old guidance filter"],
        [knowledgeInput, "old knowledge query"],
      ] as const) {
        if (!input) continue;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    let resolveRecord!: (value: { record: CompanyBrainKnowledgeRecord }) => void;
    recordResponseOverride = new Promise((resolve) => {
      resolveRecord = resolve;
    });
    const inspect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Inspect",
    );
    await act(async () => {
      inspect?.click();
      await Promise.resolve();
    });

    let resolveBrain!: (value: ReturnType<typeof companyBrainPayload>) => void;
    const nextBrain = new Promise<ReturnType<typeof companyBrainPayload>>((resolve) => {
      resolveBrain = resolve;
    });
    getCompanyBrain.mockImplementationOnce(async () => await nextBrain);
    knowledgePermission = "unavailable";
    await act(async () => {
      root.render(<CompanyBrainInspector key={nextWorkspaceId} workspaceId={nextWorkspaceId} />);
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Review guide");
    expect(container.textContent).not.toContain("Canonical architecture body");

    resolveRecord({
      record: {
        ...record,
        content: { ...record.content, body: "STALE CROSS-WORKSPACE BODY" },
      },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("STALE CROSS-WORKSPACE BODY");

    resolveBrain(companyBrainPayload(nextWorkspaceId));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain(
      "Knowledge is unavailable with your current workspace access.",
    );
    expect(container.textContent).not.toContain("Canonical architecture body");
    expect(
      [...container.querySelectorAll("label")]
        .find((item) => item.textContent?.includes("Filter guidance"))
        ?.querySelector("input")?.value,
    ).toBe("");
    expect(container.querySelector("#company-brain-knowledge-query")).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    recordResponseOverride = null;
    knowledgePermission = "available";
  });

  test("loads receipt and structural Knowledge pages without skipping bounded history facts", async () => {
    guidanceTruncated = true;
    const secondRecord: CompanyBrainKnowledgeRecord = {
      ...record,
      id: "document:00000000-0000-4000-8000-000000000099",
      title: "Second authorized handbook",
    };
    const defaultReceiptPage = await listCompanyBrainContextReceipts();
    const firstReceipt = defaultReceiptPage.receipts[0]!;
    const secondReceipt = {
      ...firstReceipt,
      id: "00000000-0000-4000-8000-000000000098",
      sessionId: "00000000-0000-4000-8000-000000000097",
      rootSessionId: "00000000-0000-4000-8000-000000000096",
      turnId: "00000000-0000-4000-8000-000000000095",
      sessionRole: "child" as const,
    };
    browseResponseOverrides.push(
      { records: [record], nextCursor: "knowledge-page-2", hasMore: true, selection: {} },
      { records: [secondRecord], nextCursor: null, hasMore: false, selection: {} },
    );
    receiptResponseOverrides.push(
      { receipts: [firstReceipt], nextCursor: "receipt-page-2", hasMore: true },
      { receipts: [secondReceipt], nextCursor: null, hasMore: false },
    );

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<CompanyBrainInspector workspaceId={workspaceId} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("This bounded history reached: Aggregate item count.");
    expect(container.textContent).toContain("Architecture handbook");
    expect(container.textContent).toContain("Root turn");

    const loadKnowledge = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Load more knowledge",
    );
    const loadReceipts = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Load more context receipts",
    );
    await act(async () => {
      loadKnowledge?.click();
      loadReceipts?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Architecture handbook");
    expect(container.textContent).toContain("Second authorized handbook");
    expect(container.textContent).toContain("Root turn");
    expect(container.textContent).toContain("Child turn");
    expect(container.textContent).not.toContain("Load more knowledge");
    expect(container.textContent).not.toContain("Load more context receipts");

    await act(async () => root.unmount());
    container.remove();
    guidanceTruncated = false;
  });
});
