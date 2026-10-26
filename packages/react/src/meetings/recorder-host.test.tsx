// The real recorder host hands over to the next one without clearing it: the
// next host publishes before the old one's cleanup runs. The capture itself is
// replaced by a fake recorder per host.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useMemo } from "react";
import { createRoot } from "react-dom/client";

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

mock.module("../recordings", () => ({
  useRecorder: ({ workspaceId }: { workspaceId: string }) =>
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- the fake is a hook
    useMemo(() => ({ state: "idle", recordingId: null, workspaceId }), [workspaceId]),
}));

const { default: RecorderHost } = await import("./recorder-host");
const { createMeetingRecorderStore } = await import("./recorder-context");

describe("The recorder host", () => {
  test("leaving keeps the recorder the next host already published, and clears its own", async () => {
    const store = createMeetingRecorderStore(() => {});
    const published = () => (store.get() as { workspaceId?: string } | null)?.workspaceId ?? null;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (workspaceId: string | null) =>
      act(async () => {
        root.render(
          workspaceId ? (
            <RecorderHost key={workspaceId} store={store} workspaceId={workspaceId} />
          ) : null,
        );
      });
    try {
      await render("workspace-a");
      expect(published()).toBe("workspace-a");
      expect(store.workspaceId?.()).toBe("workspace-a");
      // One host replaces the other in the same commit.
      await render("workspace-b");
      expect(published()).toBe("workspace-b");
      expect(store.workspaceId?.()).toBe("workspace-b");
      // The last host leaving clears it.
      await render(null);
      expect(store.get()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
