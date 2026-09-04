import { describe, expect, test } from "bun:test";

import {
  initialNewSessionProjectLaunchIntent,
  newSessionProjectSelection,
  nextNewSessionProjectLaunchIntent,
  resolveAmbientNewSessionProjectChannelId,
  resolveHydratedNewSessionProjectSelection,
} from "./sessions-index-hydration";
import {
  buildCreateSessionRequest,
  emptySessionDraft,
  submissionFromSessionDraft,
} from "../lib/session-create";

const PROJECT_A = "00000000-0000-4000-8000-000000000011";
const PROJECT_B = "00000000-0000-4000-8000-000000000012";
const PROJECT_C = "00000000-0000-4000-8000-000000000013";
const MACHINE_A = "00000000-0000-4000-8000-000000000021";
const MACHINE_B = "00000000-0000-4000-8000-000000000022";

const staleProjectAHistory = {
  projects: [
    {
      channelId: PROJECT_A,
      targetSandboxId: MACHINE_A,
      machines: [{ sandboxId: MACHINE_A, workingDir: "/workspace/project-a" }],
    },
  ],
};

const restoredProjectBCompute = {
  kind: "machine" as const,
  sandboxId: MACHINE_B,
  folder: { kind: "path" as const, path: "/workspace/project-b" },
};

describe("sessions-index project hydration", () => {
  test("newer same-project draft compute wins over stale selection history", () => {
    const hydrated = resolveHydratedNewSessionProjectSelection({
      launchIntent: initialNewSessionProjectLaunchIntent(undefined),
      remote: { selectedProjectChannelId: PROJECT_A },
      history: staleProjectAHistory,
      restoredCompute: restoredProjectBCompute,
    });

    expect(hydrated).toEqual({ channelId: PROJECT_A, compute: restoredProjectBCompute });
    expect(
      resolveAmbientNewSessionProjectChannelId({
        launchChannelId: undefined,
        previousLaunchChannelId: undefined,
        recentChannelId: PROJECT_A,
        remoteDraftHydrated: true,
      }),
    ).toBeUndefined();
    expect(hydrated.compute).toBe(restoredProjectBCompute);
  });

  test("explicit persisted Default provenance does not fall back to Recents", () => {
    expect(
      resolveHydratedNewSessionProjectSelection({
        launchIntent: initialNewSessionProjectLaunchIntent(undefined),
        remote: { selectedProjectChannelId: null },
        history: staleProjectAHistory,
        restoredCompute: restoredProjectBCompute,
      }),
    ).toEqual({ channelId: null, compute: restoredProjectBCompute });
  });

  test("legacy drafts without provenance fall back to Recents", () => {
    expect(
      resolveHydratedNewSessionProjectSelection({
        launchIntent: initialNewSessionProjectLaunchIntent(undefined),
        remote: {},
        history: staleProjectAHistory,
        restoredCompute: restoredProjectBCompute,
      }),
    ).toEqual({
      channelId: PROJECT_A,
      compute: {
        kind: "machine",
        sandboxId: MACHINE_A,
        folder: { kind: "path", path: "/workspace/project-a" },
      },
    });
  });

  test("explicit launch intent wins over persisted provenance", () => {
    expect(
      resolveHydratedNewSessionProjectSelection({
        launchIntent: initialNewSessionProjectLaunchIntent(PROJECT_C),
        remote: { selectedProjectChannelId: PROJECT_B },
        history: staleProjectAHistory,
        restoredCompute: restoredProjectBCompute,
      }),
    ).toEqual({
      channelId: PROJECT_C,
      compute: { kind: "sandbox", backend: "" },
    });
  });

  test.each([
    ["named", PROJECT_C],
    ["Default", null],
  ] as const)(
    "a deferred %s-to-omitted transition keeps the newer Recents intent during hydration",
    (_label, explicitChannelId) => {
      const initial = initialNewSessionProjectLaunchIntent(explicitChannelId);
      const newest = nextNewSessionProjectLaunchIntent(initial, explicitChannelId, undefined);

      expect(newest).toEqual({ generation: 1, kind: "omitted_after_explicit" });
      expect(
        resolveHydratedNewSessionProjectSelection({
          launchIntent: newest,
          remote: { selectedProjectChannelId: PROJECT_B },
          history: staleProjectAHistory,
          restoredCompute: restoredProjectBCompute,
        }),
      ).toEqual({
        channelId: PROJECT_A,
        compute: {
          kind: "machine",
          sandboxId: MACHINE_A,
          folder: { kind: "path", path: "/workspace/project-a" },
        },
      });
    },
  );

  test("ambient Recents applies before hydration without overwriting hydrated selection history", () => {
    expect(
      resolveAmbientNewSessionProjectChannelId({
        launchChannelId: undefined,
        previousLaunchChannelId: undefined,
        recentChannelId: PROJECT_A,
        remoteDraftHydrated: false,
      }),
    ).toBe(PROJECT_A);
    expect(
      resolveAmbientNewSessionProjectChannelId({
        launchChannelId: undefined,
        previousLaunchChannelId: undefined,
        recentChannelId: PROJECT_A,
        remoteDraftHydrated: true,
      }),
    ).toBeUndefined();
    expect(
      resolveAmbientNewSessionProjectChannelId({
        launchChannelId: null,
        previousLaunchChannelId: undefined,
        recentChannelId: PROJECT_A,
        remoteDraftHydrated: true,
      }),
    ).toBeNull();
  });

  test("post-hydration explicit Default to omitted intent selects Recents for every create mode", () => {
    const channelId = resolveAmbientNewSessionProjectChannelId({
      launchChannelId: undefined,
      previousLaunchChannelId: null,
      recentChannelId: PROJECT_A,
      remoteDraftHydrated: true,
    });
    expect(channelId).toBe(PROJECT_A);

    const selection = newSessionProjectSelection(staleProjectAHistory, channelId!, {
      channelId: null,
      compute: restoredProjectBCompute,
    });
    expect(selection).toEqual({
      channelId: PROJECT_A,
      compute: {
        kind: "machine",
        sandboxId: MACHINE_A,
        folder: { kind: "path", path: "/workspace/project-a" },
      },
    });

    const submission = submissionFromSessionDraft({
      ...emptySessionDraft(),
      compute: selection.compute,
    });
    const requests = [undefined, "realtime" as const].map((startMode) =>
      buildCreateSessionRequest({
        currentResources: [],
        submission: { text: startMode ? "" : "start", resources: [], ...submission.extras },
        startMode,
        selectedTools: [],
        defaultModel: "gpt-5.4",
        defaultReasoningEffort: "medium",
        defaultLatencyMode: "standard",
        clientEventId: `event-${startMode ?? "normal"}`,
        idempotencyKey: `create-${startMode ?? "normal"}`,
        channelId: selection.channelId,
        targetSandboxId: submission.options.targetSandboxId,
        workingDir: submission.options.workingDir,
      }),
    );
    for (const request of requests) {
      expect(request).toMatchObject({
        channelId: PROJECT_A,
        targetSandboxId: MACHINE_A,
        workingDir: "/workspace/project-a",
      });
    }
    expect(requests[0]?.initialMessage).toBe("start");
    expect(requests[1]).not.toHaveProperty("initialMessage");

    expect(
      resolveAmbientNewSessionProjectChannelId({
        launchChannelId: undefined,
        previousLaunchChannelId: undefined,
        recentChannelId: PROJECT_B,
        remoteDraftHydrated: true,
      }),
    ).toBeUndefined();
  });
});
