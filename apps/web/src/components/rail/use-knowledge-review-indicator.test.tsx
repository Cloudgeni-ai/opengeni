import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const list = mock(async (_workspace: string, _request: unknown) => ({ entries: [{}] }));
const client = { listKnowledgeEntries: list };
mock.module("@/context", () => ({ useAppContext: () => ({ client }) }));
const { useKnowledgeReviewIndicator, notifyKnowledgeReviewUpdated } =
  await import("./use-knowledge-review-indicator");
function Probe({ workspace }: { workspace: string }) {
  return <span>{useKnowledgeReviewIndicator(workspace) ? "pending" : "none"}</span>;
}
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test("refreshes after decisions, retains the cue on failure, and fences workspace switches", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspace="one" />));
    expect(container.textContent).toBe("pending");
    expect(list).toHaveBeenLastCalledWith("one", { view: "needs_review", limit: 1 });
    list.mockRejectedValueOnce(new Error("offline"));
    await act(async () => notifyKnowledgeReviewUpdated());
    expect(container.textContent).toBe("pending");
    list.mockResolvedValueOnce({ entries: [] });
    await act(async () => notifyKnowledgeReviewUpdated());
    expect(container.textContent).toBe("none");
    let finish!: (value: { entries: {}[] }) => void;
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => notifyKnowledgeReviewUpdated());
    list.mockResolvedValueOnce({ entries: [] });
    await act(async () => root.render(<Probe workspace="two" />));
    await act(async () => finish({ entries: [{}] }));
    expect(container.textContent).toBe("none");
  } finally {
    await act(async () => root.unmount());
  }
});
