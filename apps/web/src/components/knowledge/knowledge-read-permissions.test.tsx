import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const workspaceId = "reader-workspace";
const published = { id: "published", revision: { title: "Published runbook" } };
const pending = {
  id: "pending",
  revision: { id: "revision", title: "Proposed runbook", createdAt: "2026-10-18T00:00:00Z" },
};
const batch = { id: "batch", title: "Agent proposals" };
const context = {
  accessContext: {
    subjectId: "user:reader",
    workspaceGrants: [{ workspaceId, permissions: ["workspace:read", "documents:search"] }],
    accountGrants: [],
  },
  workspaces: [{ id: workspaceId, accountId: "account", kind: "shared" }],
  managedSelfContext: null,
  client: {
    listKnowledgeEntries: mock(async (_id: string, request: { view: string }) => ({
      entries: request.view === "needs_review" ? [pending] : [published],
      nextCursor: null,
    })),
    listKnowledgeReviewBatches: mock(async () => ({ batches: [batch], nextCursor: null })),
    listAgentInstructionReviews: mock(async () => ({ entries: [], nextCursor: null })),
    listWorkspaceSkills: mock(async () => ({ skills: [], nextCursor: null })),
  },
};
mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));
const { useReviewQueue } = await import("./knowledge-review");
const { useKnowledgeList } = await import("./knowledge-data");
function Probe() {
  const list = useKnowledgeList(workspaceId, { view: "published", limit: 20 });
  const queue = useReviewQueue(workspaceId, 0);
  return (
    <div>
      <p>{list.entries.map((entry) => entry.revision.title).join(",")}</p>
      <output>{queue.count}</output>
      <span role="alert">{queue.error}</span>
    </div>
  );
}
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test("readers keep published Knowledge; only managers fetch pending batches; errors and revocations remain visible", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toContain("Published runbook");
    expect(context.client.listKnowledgeReviewBatches).not.toHaveBeenCalled();
    expect(context.client.listAgentInstructionReviews).not.toHaveBeenCalled();
    expect(context.client.listWorkspaceSkills).toHaveBeenCalledTimes(1);
    expect(context.client.listKnowledgeEntries.mock.calls.map((call) => call[1].view)).toEqual([
      "published",
    ]);
    context.accessContext.workspaceGrants[0]!.permissions.push("documents:manage");
    await act(async () => root.render(<Probe />));
    expect(container.querySelector("output")?.textContent).toBe("1");
    expect(context.client.listKnowledgeReviewBatches).toHaveBeenCalledTimes(1);
    expect(context.client.listKnowledgeEntries.mock.calls.at(-1)?.[1].view).toBe("needs_review");
    // Change authority while a pending fetch is in flight, without replacing the SDK client.
    context.accessContext.workspaceGrants[0]!.permissions = ["workspace:admin"];
    let finish!: (value: { batches: (typeof batch)[]; nextCursor: null }) => void;
    context.client.listKnowledgeReviewBatches.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => root.render(<Probe />));
    context.accessContext.workspaceGrants[0]!.permissions = ["workspace:read", "documents:search"];
    await act(async () => root.render(<Probe />));
    await act(async () => finish({ batches: [batch], nextCursor: null }));
    expect(container.querySelector("output")?.textContent).toBe("0");
    expect(container.textContent).toContain("Published runbook");
    context.accessContext.workspaceGrants[0]!.permissions.push("documents:manage");
    context.client.listKnowledgeReviewBatches.mockRejectedValueOnce(
      new Error("pending service unavailable"),
    );
    await act(async () => root.render(<Probe />));
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "pending service unavailable",
    );
    expect(container.textContent).toContain("Published runbook");
  } finally {
    await act(async () => root.unmount());
  }
});
