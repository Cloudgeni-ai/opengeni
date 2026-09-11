import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentLearningSettingsRecord,
  KnowledgeReviewBatch,
  KnowledgeReviewBatchListRequest,
  KnowledgeReviewBatchListResponse,
} from "@opengeni/sdk";

const batch: KnowledgeReviewBatch = {
  id: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  scheduledTaskId: crypto.randomUUID(),
  scheduledTaskRunId: crypto.randomUUID(),
  title: "Customer feedback",
  scope: "workspace",
  pendingCount: 4,
  createdAt: "2026-09-10T09:00:00.000Z",
};
const list = mock(
  async (
    _workspaceId: string,
    _options: KnowledgeReviewBatchListRequest,
  ): Promise<KnowledgeReviewBatchListResponse> => ({ batches: [batch], nextCursor: null }),
);
const learningRecord = (
  scope: string,
  mode: "automatic" | "off" = "automatic",
): AgentLearningSettingsRecord => ({
  ownerKey: scope,
  contextKey: "defaults",
  version: 0,
  settings: { knowledge: mode, instructions: "review_first", skills: "review_first" },
});
const readLearning = mock(async (_workspace: string, scope: string) =>
  learningRecord(scope, scope === "personal" ? "off" : "automatic"),
);
const saveLearning = mock(
  async (_workspace: string, _request: unknown): Promise<AgentLearningSettingsRecord> =>
    learningRecord("workspace"),
);
const context = {
  client: {
    listKnowledgeReviewBatches: list,
    getAgentLearningSettings: readLearning,
    saveAgentLearningSettings: saveLearning,
  },
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const { KnowledgeReviewGroups } = await import("./knowledge-review-groups");
const { AgentLearningSettingsEditor } = await import("./agent-learning-settings");
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test("opens the selected run's changes and paginates without losing its first group", async () => {
  list.mockReset();
  list.mockResolvedValueOnce({ batches: [batch], nextCursor: "next-page" });
  const other = {
    ...batch,
    id: crypto.randomUUID(),
    title: "Contract review",
    pendingCount: 2,
    scheduledTaskRunId: null,
  };
  list.mockResolvedValueOnce({ batches: [other], nextCursor: null });
  const selected = mock((_batch: KnowledgeReviewBatch) => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <KnowledgeReviewGroups workspaceId="workspace-a" refresh={0} onSelect={selected} />,
      );
    });
    expect(container.textContent).toContain("Customer feedback");
    expect(container.textContent).toContain("Scheduled run");
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review 4 items",
    )!;
    await act(async () => review.click());
    expect(selected).toHaveBeenCalledWith(batch);
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "More review groups",
    )!;
    await act(async () => more.click());
    expect(list.mock.calls[1]).toEqual([
      "workspace-a",
      { scope: undefined, cursor: "next-page", limit: 20 },
    ]);
    expect(container.textContent).toContain("Customer feedback");
    expect(container.textContent).toContain("Contract review");
    expect(container.textContent).not.toContain("More review groups");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("changing scope clears the old list and ignores its late response", async () => {
  list.mockReset();
  let finish!: (value: KnowledgeReviewBatchListResponse) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  list.mockResolvedValueOnce({ batches: [], nextCursor: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <KnowledgeReviewGroups
          workspaceId="workspace-a"
          scope="workspace"
          refresh={0}
          onSelect={() => {}}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <KnowledgeReviewGroups
          workspaceId="workspace-a"
          scope="personal"
          refresh={0}
          onSelect={() => {}}
        />,
      ),
    );
    await act(async () => finish({ batches: [batch], nextCursor: null }));
    expect(container.textContent).not.toContain("Customer feedback");
    expect(container.textContent).toContain("No Knowledge changes need review.");
    expect(list.mock.calls[1]?.[1].scope).toBe("personal");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an outstanding workspace save cannot replace the personal settings shown after switching scope", async () => {
  let finish!: (value: AgentLearningSettingsRecord) => void;
  saveLearning.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const notified = mock(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const knowledge = () => container.querySelector<HTMLSelectElement>('select[id$="-knowledge"]')!;
  try {
    await act(async () => {
      root.render(
        <AgentLearningSettingsEditor
          workspaceId="workspace-a"
          scope="workspace"
          onSaved={notified}
        />,
      );
    });
    expect(knowledge().value).toBe("automatic");
    await act(async () => {
      knowledge().value = "review_first";
      knowledge().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saveLearning).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(
        <AgentLearningSettingsEditor
          workspaceId="workspace-a"
          scope="personal"
          onSaved={notified}
        />,
      );
    });
    expect(knowledge().value).toBe("off");
    await act(async () => {
      finish({
        ...learningRecord("workspace"),
        version: 1,
        settings: {
          knowledge: "review_first",
          instructions: "review_first",
          skills: "review_first",
        },
      });
    });
    expect(knowledge().value).toBe("off");
    expect(notified).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Saved. Applies");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("late pagination from workspace review never enters the personal review list", async () => {
  list.mockReset();
  list.mockResolvedValueOnce({ batches: [batch], nextCursor: "old-page" });
  let resolveOld!: (value: KnowledgeReviewBatchListResponse) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const personal = {
    ...batch,
    id: crypto.randomUUID(),
    title: "Personal review",
    scope: "personal" as const,
  };
  list.mockResolvedValueOnce({ batches: [personal], nextCursor: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <KnowledgeReviewGroups
          workspaceId="workspace-a"
          scope="workspace"
          refresh={0}
          onSelect={() => {}}
        />,
      ),
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "More review groups")!
        .click(),
    );
    await act(async () =>
      root.render(
        <KnowledgeReviewGroups
          workspaceId="workspace-a"
          scope="personal"
          refresh={0}
          onSelect={() => {}}
        />,
      ),
    );
    await act(async () =>
      resolveOld({ batches: [{ ...batch, title: "Late workspace result" }], nextCursor: "stale" }),
    );
    expect(container.textContent).toContain("Personal review");
    expect(container.textContent).not.toContain("Late workspace result");
    expect(container.textContent).not.toContain("More review groups");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
