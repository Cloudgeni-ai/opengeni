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

/** What the fake recorder says, for the test that sets it; idle otherwise. */
let recorderNow: { state: string; title?: string | null; elapsedMilliseconds?: number } = {
  state: "idle",
};

mock.module("../recordings", () => ({
  useRecorder: ({ workspaceId }: { workspaceId: string }) => {
    const now = recorderNow;
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- the fake is a hook
    return useMemo(
      () => ({ recordingId: null, elapsedMilliseconds: 0, ...now, workspaceId }),
      [workspaceId, now],
    );
  },
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

  test("tells the desktop app what it records, again when the title or a pause changes", async () => {
    const calls: unknown[][] = [];
    (globalThis as Record<string, unknown>).opengeniDesktop = {
      version: 1,
      capabilities: ["meetingDetection"],
      meetingDetection: {
        status: async () => ({}),
        update: async () => ({}),
        setRecording: (...args: unknown[]) => void calls.push(args),
        onRequest: () => () => {},
        onChange: () => () => {},
      },
    };
    const store = createMeetingRecorderStore(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (next: typeof recorderNow) =>
      act(async () => {
        recorderNow = next;
        root.render(<RecorderHost store={store} workspaceId="workspace-a" />);
      });
    try {
      await render({ state: "idle" });
      expect(calls).toEqual([[false]]);
      await render({ state: "recording", title: null, elapsedMilliseconds: 1_000 });
      await render({ state: "recording", title: "Planning", elapsedMilliseconds: 5_000 });
      await render({ state: "paused", title: "Planning", elapsedMilliseconds: 9_000 });
      // Only a change it shows is sent: the time moves on in the app.
      await render({ state: "paused", title: "Planning", elapsedMilliseconds: 9_500 });
      await render({ state: "stopped", title: "Planning", elapsedMilliseconds: 9_500 });
      // Never a stop between: the app would think the recording ended.
      expect(calls).toEqual([
        [false],
        [true, { title: null, elapsedMilliseconds: 1_000, paused: false }],
        [true, { title: "Planning", elapsedMilliseconds: 5_000, paused: false }],
        [true, { title: "Planning", elapsedMilliseconds: 9_000, paused: true }],
        [false],
        [false],
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      recorderNow = { state: "idle" };
      delete (globalThis as Record<string, unknown>).opengeniDesktop;
    }
  });
});
