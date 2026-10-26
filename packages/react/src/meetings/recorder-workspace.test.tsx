// Leaving a workspace must not end a recording made in it. The capture host is
// replaced by a fake that, like the real one, stops a capture when it unmounts:
// these tests are about where the provider keeps the host, not about capture.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type { MeetingRecorder, MeetingRecorderStore } from "./recorder-context";

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

type State = MeetingRecorder["state"];
const events: string[] = [];
const setStates = new Map<string, (state: State) => void>();

mock.module("./recorder-host", () => ({
  default: function FakeRecorderHost({
    store,
    workspaceId,
  }: {
    store: MeetingRecorderStore;
    workspaceId: string;
  }) {
    const [state, setState] = useState<State>("idle");
    const latest = useRef(state);
    latest.current = state;
    const recorder = useMemo(
      () =>
        ({
          state,
          recordingId: state === "idle" ? null : `recording-in-${workspaceId}`,
          stop: async () => setState("stopped"),
        }) as unknown as MeetingRecorder,
      [state, workspaceId],
    );
    const published = useRef(recorder);
    useLayoutEffect(() => {
      published.current = recorder;
      store.set(recorder, workspaceId);
    });
    useEffect(() => {
      setStates.set(workspaceId, setState);
      events.push(`mount ${workspaceId}`);
      return () => {
        // The real host's recorder stops a capture here, which finalizes it.
        const captured = ["starting", "recording", "paused", "stopping"].includes(latest.current);
        events.push(`unmount ${workspaceId}${captured ? " (capture ended)" : ""}`);
        if (store.get() === published.current) store.set(null);
      };
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per host
    }, []);
    return null;
  },
}));

const { MeetingRecorderProvider, useMeetingRecorder, usePendingMeetingStart } =
  await import("./recorder-context");

async function settle(milliseconds = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await settle();
  }
}

type Desktop = {
  listener: ((request: { kind: "record"; title?: string } | { kind: "stop" }) => void) | null;
};

function installDesktop(): Desktop {
  const desktop: Desktop = { listener: null };
  (globalThis as Record<string, unknown>).opengeniDesktop = {
    version: 1,
    capabilities: ["meetingDetection"],
    meetingDetection: {
      status: async () => ({}),
      update: async () => ({}),
      setRecording() {},
      onRequest(listener: Desktop["listener"]) {
        desktop.listener = listener;
        return () => {
          if (desktop.listener === listener) desktop.listener = null;
        };
      },
    },
  };
  return desktop;
}

function removeDesktop() {
  delete (globalThis as Record<string, unknown>).opengeniDesktop;
}

function mountProvider() {
  const seen: { recorder: MeetingRecorder | null; workspaceId: string | null } = {
    recorder: null,
    workspaceId: null,
  };
  const opened: string[] = [];
  const meetingsOpened: string[] = [];
  let pendingStart: () => boolean = () => false;
  let open: ((recordingId: string, workspaceId: string) => boolean) | null = null;
  function Probe() {
    const current = useMeetingRecorder();
    seen.recorder = current.recorder;
    seen.workspaceId = current.workspaceId;
    open = current.openMeeting;
    return null;
  }
  function PendingStart() {
    const { take } = usePendingMeetingStart();
    pendingStart = () => take() !== null;
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    seen,
    opened,
    meetingsOpened,
    takePendingStart: () => pendingStart(),
    open: (recordingId: string, workspaceId: string) => open!(recordingId, workspaceId),
    render: (workspaceId: string | null, options: { scope?: string | null } = {}) =>
      act(async () => {
        root.render(
          <MeetingRecorderProvider
            workspaceId={workspaceId}
            {...("scope" in options ? { scope: options.scope } : {})}
            client={{}}
            onOpenMeetings={() => meetingsOpened.push(workspaceId ?? "none")}
            onOpenMeeting={(recordingId, recordingWorkspaceId) =>
              opened.push(`${recordingWorkspaceId}/${recordingId}`)
            }
          >
            <Probe />
            <PendingStart />
          </MeetingRecorderProvider>,
        );
      }),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("A recording and the workspace it was made in", () => {
  test("keeps recording when the person moves to another workspace, then follows them", async () => {
    events.length = 0;
    const view = mountProvider();
    try {
      await view.render("workspace-a");
      await until(() => view.seen.recorder !== null);
      await act(async () => setStates.get("workspace-a")!("recording"));

      // The shell drops the workspace while the next one loads, then shows it.
      await view.render(null);
      await view.render("workspace-b");
      await settle();
      // Nothing unmounted the host, so nothing stopped the capture.
      expect(events).toEqual(["mount workspace-a"]);
      expect(view.seen.recorder?.state).toBe("recording");
      expect(view.seen.recorder?.recordingId).toBe("recording-in-workspace-a");
      expect(view.seen.workspaceId).toBe("workspace-a");

      // Stopping it opens the meeting in its own workspace...
      await act(async () => view.seen.recorder!.stop());
      expect(view.open("recording-in-workspace-a", "workspace-a")).toBe(true);
      expect(view.opened).toEqual(["workspace-a/recording-in-workspace-a"]);
      // ...and the recorder moves to the workspace shown, without ending anything.
      await until(() => view.seen.workspaceId === "workspace-b");
      expect(events).toEqual(["mount workspace-a", "unmount workspace-a", "mount workspace-b"]);
      expect(view.seen.recorder?.state).toBe("idle");
    } finally {
      await view.unmount();
    }
  });

  test("a paused recording is kept too, and an idle recorder follows at once", async () => {
    events.length = 0;
    const view = mountProvider();
    try {
      await view.render("workspace-a");
      await until(() => view.seen.recorder !== null);
      await view.render("workspace-b");
      await until(() => events.includes("mount workspace-b"));
      await act(async () => setStates.get("workspace-b")!("paused"));
      await view.render("workspace-a");
      await settle();
      expect(events.some((event) => event.includes("capture ended"))).toBe(false);
      expect(view.seen.workspaceId).toBe("workspace-b");
    } finally {
      await view.unmount();
    }
  });

  for (const state of ["starting", "stopping"] as const) {
    test(`a recording that is ${state} stays in its workspace too`, async () => {
      events.length = 0;
      const view = mountProvider();
      try {
        await view.render("workspace-a");
        await until(() => view.seen.recorder !== null);
        await act(async () => setStates.get("workspace-a")!(state));
        await view.render("workspace-b");
        await settle();
        expect(events).toEqual(["mount workspace-a"]);
        expect(view.seen.workspaceId).toBe("workspace-a");
      } finally {
        await view.unmount();
      }
    });
  }

  test("a stop that fails lets the recorder follow, keeping its chunks for the next host", async () => {
    events.length = 0;
    const view = mountProvider();
    try {
      await view.render("workspace-a");
      await until(() => view.seen.recorder !== null);
      await act(async () => setStates.get("workspace-a")!("stopping"));
      await view.render("workspace-b");
      await settle();
      expect(events).toEqual(["mount workspace-a"]);
      await act(async () => setStates.get("workspace-a")!("failed"));
      await until(() => view.seen.workspaceId === "workspace-b");
      // Nothing was capturing when the host moved.
      expect(events).toEqual(["mount workspace-a", "unmount workspace-a", "mount workspace-b"]);
    } finally {
      await view.unmount();
    }
  });

  test("the desktop app's Stop opens the meeting in the workspace it was recorded in", async () => {
    events.length = 0;
    const desktop = installDesktop();
    const view = mountProvider();
    try {
      await view.render("workspace-a");
      await until(() => view.seen.recorder !== null);
      await act(async () => setStates.get("workspace-a")!("recording"));
      await view.render("workspace-b");
      await settle();
      expect(desktop.listener).not.toBeNull();
      await act(async () => desktop.listener!({ kind: "stop" }));
      await settle();
      expect(view.opened).toEqual(["workspace-a/recording-in-workspace-a"]);
      await until(() => view.seen.workspaceId === "workspace-b");
      expect(events.some((event) => event.includes("capture ended"))).toBe(false);
    } finally {
      await view.unmount();
      removeDesktop();
    }
  });
});

describe("A recording and the person who made it", () => {
  test("ends at once when someone else signs in, and the next person gets a fresh recorder", async () => {
    events.length = 0;
    const view = mountProvider();
    try {
      await view.render("workspace-a", { scope: "person-1" });
      await until(() => view.seen.recorder !== null);
      await act(async () => setStates.get("workspace-a")!("recording"));
      await view.render("workspace-a", { scope: "person-2" });
      await until(() => events.length === 3);
      expect(events).toEqual([
        "mount workspace-a",
        "unmount workspace-a (capture ended)",
        "mount workspace-a",
      ]);
      expect(view.seen.recorder?.state).toBe("idle");
    } finally {
      await view.unmount();
    }
  });

  test("ends at once on sign-out, even in another workspace, and nothing records while signed out", async () => {
    events.length = 0;
    const view = mountProvider();
    try {
      await view.render("workspace-a", { scope: "person-1" });
      await until(() => view.seen.recorder !== null);
      await act(async () => setStates.get("workspace-a")!("recording"));
      await view.render("workspace-b", { scope: "person-1" });
      await settle();
      expect(events).toEqual(["mount workspace-a"]);
      await view.render(null, { scope: null });
      await settle();
      expect(events).toEqual(["mount workspace-a", "unmount workspace-a (capture ended)"]);
      expect(view.seen.recorder).toBeNull();
      await view.render("workspace-b", { scope: null });
      await settle();
      expect(events).toHaveLength(2);
    } finally {
      await view.unmount();
    }
  });

  test("a desktop Record while signed out is not kept for whoever signs in next", async () => {
    events.length = 0;
    const desktop = installDesktop();
    const view = mountProvider();
    try {
      await view.render(null, { scope: null });
      await settle();
      await act(async () => desktop.listener!({ kind: "record", title: "Call" }));
      expect(view.meetingsOpened).toEqual([]);
      await view.render("workspace-a", { scope: "person-1" });
      await settle();
      expect(view.takePendingStart()).toBe(false);

      // Signed in, it opens Meetings and asks for a start...
      await act(async () => desktop.listener!({ kind: "record", title: "Call" }));
      expect(view.meetingsOpened).toEqual(["workspace-a"]);
      // ...which a change of person drops.
      await view.render("workspace-a", { scope: "person-2" });
      await settle();
      expect(view.takePendingStart()).toBe(false);
    } finally {
      await view.unmount();
      removeDesktop();
    }
  });
});
