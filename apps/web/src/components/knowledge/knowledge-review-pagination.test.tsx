import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  AgentInstructionReviewItem,
  KnowledgeEntryListRequest,
  KnowledgeEntrySummary,
  KnowledgeReviewBatch,
  KnowledgeReviewBatchListRequest,
  SkillSummary,
} from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
function batch(index: number): KnowledgeReviewBatch {
  return {
    id: `batch-${index}`,
    sessionId: null,
    scheduledTaskId: null,
    scheduledTaskRunId: null,
    title: `Changes ${index}`,
    scope: "workspace",
    pendingCount: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}
function entry(index: number): KnowledgeEntrySummary {
  return {
    id: `entry-${index}`,
    version: 1,
    scope: "workspace",
    revision: {
      id: `revision-${index}`,
      title: `Fact ${index}`,
      kind: "fact",
      createdAt: "2026-09-20T00:00:00.000Z",
    },
  } as KnowledgeEntrySummary;
}
function skill(
  index: number,
  pending = false,
  scope: SkillSummary["scope"] = "workspace",
): SkillSummary {
  return {
    id: `skill-${index}`,
    stableKey: `skill-${index}`,
    title: `Skill ${index}`,
    description: null,
    scope,
    scopeVersion: 1,
    status: "active",
    activationMode: "workspace_managed",
    activeRevisionId: null,
    revisionId: pending ? `skill-revision-${index}` : null,
    pendingRevisionIds: pending ? [`skill-revision-${index}`] : [],
    contentHash: null,
    source: null,
  };
}
const instruction: AgentInstructionReviewItem = {
  revisionId: "instruction-page2",
  content: "Keep review updates concise.",
  target: { kind: "policy", scope: "global", roleKey: null },
  reviewBatchId: null,
  sessionId: null,
  reason: "Proposed instructions",
  createdAt: "2026-09-20T00:00:00.000Z",
};

const listKnowledgeReviewBatches = mock(
  async (_workspace: string, _request: KnowledgeReviewBatchListRequest) => ({
    batches: [] as KnowledgeReviewBatch[],
    nextCursor: null as string | null,
  }),
);
const listKnowledgeEntries = mock(
  async (_workspace: string, _request: KnowledgeEntryListRequest) => ({
    entries: [] as KnowledgeEntrySummary[],
    nextCursor: null as string | null,
  }),
);
const listAgentInstructionReviews = mock(async (_workspace: string, _cursor?: string) => ({
  entries: [] as AgentInstructionReviewItem[],
  nextCursor: null as string | null,
}));
const listWorkspaceSkills = mock(
  async (_workspace: string, _request: { cursor?: string; limit?: number }) => ({
    skills: [] as SkillSummary[],
    nextCursor: null as string | null,
  }),
);
const reviewKnowledgeEntries = mock(
  async (_workspace: string, _request: { entries: unknown[] }) => ({ receipts: [] }),
);
const context = {
  workspaces: [{ id: workspaceId, accountId, name: "Test workspace", kind: "shared" }],
  managedSelfContext: null,
  accessContext: {
    mode: "managed",
    subjectId: "user:admin",
    accountGrants: [],
    workspaceGrants: [{ workspaceId, permissions: ["workspace:admin"] }],
  },
  clientConfig: { fileUploads: { enabled: false } },
  client: {
    listKnowledgeReviewBatches,
    listKnowledgeEntries,
    listAgentInstructionReviews,
    listWorkspaceSkills,
    reviewKnowledgeEntries,
    getKnowledgeEntry: async () => await new Promise<never>(() => undefined),
    readWorkspaceSkill: async () => await new Promise<never>(() => undefined),
    listWorkspaceInstructionPolicies: async () => ({ activeHeads: [] }),
  },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
// Only the page's unrelated tabs and navigation are stubs; the queue, ReviewTab
// and the KnowledgePage tab-visibility decision are their production components.
mock.module("./knowledge-library", () => ({
  initialLibraryView: () => ({ query: "", scope: "all", filters: {}, layout: "list" }),
  LibraryTab: () => null,
}));
mock.module("./knowledge-instructions", () => ({
  useWorkspaceInstructions: () => ({}),
  InstructionsTab: () => null,
  InstructionsEditPage: () => null,
  InstructionsHistoryPage: () => null,
}));
mock.module("./knowledge-learning", () => ({
  useLearningDefaults: () => ({ modes: {}, loading: false }),
  learningSummary: () => "Review first",
  reviewLearningLine: () => "Review first",
  LearningPage: () => null,
}));
mock.module("./knowledge-navigation", () => ({ useKnowledgeNavigation: () => ({}) }));
mock.module("./knowledge-entry", () => ({
  AddKnowledgePage: () => null,
  EntryEditPage: () => null,
  EntryPage: () => null,
  NewCollectionDialog: () => null,
}));
mock.module("./knowledge-upload", () => ({ UploadFilesDialog: () => null }));
const { ReviewTab, useReviewQueue } = await import("./knowledge-review");
const { KnowledgePage } = await import("./knowledge-page");
let observed!: ReturnType<typeof useReviewQueue>;
function Harness({ refresh = 0 }: { refresh?: number }) {
  observed = useReviewQueue(workspaceId, refresh);
  return (
    <output>
      {observed.count}:{String(observed.partial)}:{String(observed.loading)}
    </output>
  );
}
function ReviewHarness() {
  observed = useReviewQueue(workspaceId, 0);
  return <ReviewTab {...reviewProps} queue={observed} />;
}
const reviewProps = {
  workspaceId,
  learningLine: "Review first",
  onOpenLearning: () => undefined,
  onOpenEntry: () => undefined,
  onChanged: () => undefined,
};
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  listKnowledgeReviewBatches.mockReset().mockResolvedValue({ batches: [], nextCursor: null });
  listKnowledgeEntries.mockReset().mockResolvedValue({ entries: [], nextCursor: null });
  listAgentInstructionReviews.mockReset().mockResolvedValue({ entries: [], nextCursor: null });
  listWorkspaceSkills.mockReset().mockResolvedValue({ skills: [], nextCursor: null });
  reviewKnowledgeEntries.mockClear();
  context.accessContext.workspaceGrants[0]!.permissions = ["workspace:admin"];
});
async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
  }
}
async function mounted(
  run: (container: HTMLDivElement, root: ReturnType<typeof createRoot>) => Promise<void>,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await run(container, root);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

test("review discovers a pending batch beyond the first 20 batches", async () => {
  listKnowledgeReviewBatches.mockImplementation(async (_workspace, request) =>
    request.cursor
      ? { batches: [batch(20)], nextCursor: null }
      : {
          batches: Array.from({ length: 20 }, (_, index) => batch(index)),
          nextCursor: "batches-page2",
        },
  );
  listKnowledgeEntries.mockImplementation(async (_workspace, request) => ({
    entries: request.reviewBatchId === "batch-20" ? [entry(20)] : [],
    nextCursor: null,
  }));
  await mounted(async (_container, root) => {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(listKnowledgeReviewBatches).toHaveBeenCalledWith(workspaceId, {
      limit: 20,
      cursor: "batches-page2",
    });
    expect(observed.items.map((item) => item.key)).toEqual(["knowledge:entry-20"]);
    expect(observed.partial).toBe(false);
  });
});

test("review discovers entries beyond the first 50 in a batch", async () => {
  listKnowledgeReviewBatches.mockResolvedValue({ batches: [batch(0)], nextCursor: null });
  listKnowledgeEntries.mockImplementation(async (_workspace, request) =>
    request.cursor
      ? { entries: [entry(50)], nextCursor: null }
      : {
          entries: Array.from({ length: 50 }, (_, index) => entry(index)),
          nextCursor: "entries-page2",
        },
  );
  await mounted(async (_container, root) => {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(listKnowledgeEntries).toHaveBeenCalledWith(workspaceId, {
      view: "needs_review",
      reviewBatchId: "batch-0",
      limit: 50,
      cursor: "entries-page2",
    });
    expect(observed.count).toBe(51);
    expect(observed.items.at(-1)?.key).toBe("knowledge:entry-50");
    expect(observed.partial).toBe(false);
  });
});

test("review scans instruction history even when its first page has no pending entries", async () => {
  listAgentInstructionReviews.mockImplementation(async (_workspace, cursor) =>
    cursor
      ? { entries: [instruction], nextCursor: null }
      : { entries: [], nextCursor: "instructions-page2" },
  );
  await mounted(async (_container, root) => {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(listAgentInstructionReviews).toHaveBeenCalledWith(workspaceId, "instructions-page2");
    expect(observed.items.map((item) => item.key)).toEqual(["instruction:instruction-page2"]);
    expect(observed.partial).toBe(false);
  });
});

test("review discovers a pending skill after 100 skills without proposals", async () => {
  listWorkspaceSkills.mockImplementation(async (_workspace, request) =>
    request.cursor
      ? { skills: [skill(100, true)], nextCursor: null }
      : {
          skills: Array.from({ length: 100 }, (_, index) => skill(index)),
          nextCursor: "skills-page2",
        },
  );
  await mounted(async (_container, root) => {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(listWorkspaceSkills).toHaveBeenCalledWith(workspaceId, {
      limit: 100,
      cursor: "skills-page2",
    });
    expect(observed.items.map((item) => item.key)).toEqual(["skill:skill-100"]);
    expect(observed.partial).toBe(false);
  });
});

test("an empty but partial queue cannot claim the reviewer is caught up", async () => {
  const reload = mock(() => undefined);
  await mounted(async (container, root) => {
    await act(async () =>
      root.render(
        <ReviewTab
          {...reviewProps}
          queue={{
            items: [],
            groups: [],
            count: 0,
            partial: true,
            loading: false,
            error: null,
            reload,
          }}
        />,
      ),
    );
    expect(container.textContent).not.toContain("You're all caught up");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Try again",
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

test("Knowledge keeps Review reachable while a cursor scan is incomplete or fails", async () => {
  let resolvePage!: (page: { skills: SkillSummary[]; nextCursor: string | null }) => void;
  const pendingPage = new Promise<{ skills: SkillSummary[]; nextCursor: string | null }>(
    (resolve) => {
      resolvePage = resolve;
    },
  );
  listWorkspaceSkills.mockImplementation(async (_workspace, request) => {
    if (request.cursor) return await pendingPage;
    return { skills: [], nextCursor: "skills-page2" };
  });
  await mounted(async (container, root) => {
    await act(async () => root.render(<KnowledgePage workspaceId={workspaceId} search={{}} />));
    await settle();
    expect(container.querySelector('[role="tab"][data-state]')?.textContent).toContain("Library");
    const reviewTab = () =>
      [...container.querySelectorAll('[role="tab"]')].find((tab) =>
        tab.textContent?.includes("Review"),
      );
    expect(reviewTab()).toBeDefined();
    await act(async () => resolvePage({ skills: [skill(100, true)], nextCursor: null }));
    await settle();
    expect(reviewTab()?.textContent).toContain("1");
  });
  listWorkspaceSkills.mockImplementation(async (_workspace, request) => {
    if (request.cursor) throw new Error("Couldn't check the remaining skills.");
    return { skills: [], nextCursor: "skills-page2" };
  });
  await mounted(async (container, root) => {
    await act(async () => root.render(<KnowledgePage workspaceId={workspaceId} search={{}} />));
    await settle();
    expect(
      [...container.querySelectorAll('[role="tab"]')].some((tab) =>
        tab.textContent?.includes("Review"),
      ),
    ).toBe(true);
  });
});

test("a failed later page keeps known proposals and retry rescans the inventory", async () => {
  let fail = true;
  listWorkspaceSkills.mockImplementation(async (_workspace, request) => {
    if (!request.cursor) return { skills: [skill(0, true)], nextCursor: "skills-page2" };
    if (fail) throw new Error("Couldn't check the remaining skills.");
    return { skills: [skill(1, true)], nextCursor: null };
  });
  await mounted(async (_container, root) => {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(observed.items.map((item) => item.key)).toEqual(["skill:skill-0"]);
    expect(observed.partial).toBe(true);
    expect(observed.error).toBe("Couldn't check the remaining skills.");
    fail = false;
    await act(async () => observed.reload());
    await settle();
    expect(observed.items.map((item) => item.key)).toEqual(["skill:skill-0", "skill:skill-1"]);
    expect(observed.partial).toBe(false);
    expect(observed.error).toBeNull();
  });
});

test("a stale cursor response cannot overwrite a refreshed queue or fetch more pages", async () => {
  let resolveStale!: (page: { skills: SkillSummary[]; nextCursor: string | null }) => void;
  const stale = new Promise<{ skills: SkillSummary[]; nextCursor: string | null }>((resolve) => {
    resolveStale = resolve;
  });
  listWorkspaceSkills.mockImplementation(async (_workspace, request) =>
    request.cursor ? await stale : { skills: [], nextCursor: "stale-page2" },
  );
  await mounted(async (_container, root) => {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(observed.loading).toBe(true);
    listWorkspaceSkills.mockImplementation(async () => ({
      skills: [skill(2, true)],
      nextCursor: null,
    }));
    await act(async () => root.render(<Harness refresh={1} />));
    await settle();
    expect(observed.items.map((item) => item.key)).toEqual(["skill:skill-2"]);
    const calls = listWorkspaceSkills.mock.calls.length;
    await act(async () => resolveStale({ skills: [skill(1, true)], nextCursor: "stale-page3" }));
    await settle();
    expect(listWorkspaceSkills).toHaveBeenCalledTimes(calls);
    expect(observed.items.map((item) => item.key)).toEqual(["skill:skill-2"]);
  });
});

test("scanning does not widen instruction or Skill review permissions", async () => {
  context.accessContext.workspaceGrants[0]!.permissions = [];
  listWorkspaceSkills.mockImplementation(async (_workspace, request) =>
    request.cursor
      ? {
          skills: [skill(1, true), skill(2, true, "organization"), skill(3, true, "user")],
          nextCursor: null,
        }
      : { skills: [], nextCursor: "skills-page2" },
  );
  await mounted(async (_container, root) => {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(listAgentInstructionReviews).not.toHaveBeenCalled();
    expect(observed.items.map((item) => item.key)).toEqual(["skill:skill-3"]);
    expect(observed.partial).toBe(false);
  });
});

test("a repeated cursor stops scanning without presenting a complete empty queue", async () => {
  listWorkspaceSkills.mockResolvedValue({ skills: [], nextCursor: "same-cursor" });
  await mounted(async (_container, root) => {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(listWorkspaceSkills).toHaveBeenCalledTimes(2);
    expect(observed.loading).toBe(false);
    expect(observed.partial).toBe(true);
    expect(observed.error).toContain("Couldn't finish checking changes");
  });
});

test("bulk review keeps proposals beyond the existing 100-entry API limit visible", async () => {
  listKnowledgeReviewBatches.mockResolvedValue({ batches: [batch(0)], nextCursor: null });
  listKnowledgeEntries.mockImplementation(async (_workspace, request) => {
    const start = request.cursor === "entries-page3" ? 100 : request.cursor ? 50 : 0;
    return {
      entries: Array.from({ length: start === 100 ? 1 : 50 }, (_, index) => entry(start + index)),
      nextCursor: start === 0 ? "entries-page2" : start === 50 ? "entries-page3" : null,
    };
  });
  await mounted(async (container, root) => {
    await act(async () => root.render(<ReviewHarness />));
    await settle();
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Approve 100",
    );
    expect(approve).toBeDefined();
    await act(async () => approve!.click());
    await settle();
    expect(reviewKnowledgeEntries.mock.calls[0]?.[1].entries).toHaveLength(100);
    expect(container.textContent).toContain("Fact 100");
    expect(container.textContent).not.toContain("You're all caught up");
    expect(container.textContent).not.toContain("Fact 99");
  });
}, 15_000);
