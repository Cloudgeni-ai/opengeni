import { describe, expect, test } from "bun:test";

import {
  resolveAmbientNewSessionProjectChannelId,
  resolveHydratedNewSessionProjectSelection,
} from "./sessions-index-hydration";

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
      launchChannelId: undefined,
      remote: { selectedProjectChannelId: PROJECT_A },
      history: staleProjectAHistory,
      restoredCompute: restoredProjectBCompute,
    });

    expect(hydrated).toEqual({ channelId: PROJECT_A, compute: restoredProjectBCompute });
    expect(
      resolveAmbientNewSessionProjectChannelId({
        launchChannelId: undefined,
        recentChannelId: PROJECT_A,
        remoteDraftHydrated: true,
      }),
    ).toBeUndefined();
    expect(hydrated.compute).toBe(restoredProjectBCompute);
  });

  test("explicit persisted Default provenance does not fall back to Recents", () => {
    expect(
      resolveHydratedNewSessionProjectSelection({
        launchChannelId: undefined,
        remote: { selectedProjectChannelId: null },
        history: staleProjectAHistory,
        restoredCompute: restoredProjectBCompute,
      }),
    ).toEqual({ channelId: null, compute: restoredProjectBCompute });
  });

  test("legacy drafts without provenance fall back to Recents", () => {
    expect(
      resolveHydratedNewSessionProjectSelection({
        launchChannelId: undefined,
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
        launchChannelId: PROJECT_C,
        remote: { selectedProjectChannelId: PROJECT_B },
        history: staleProjectAHistory,
        restoredCompute: restoredProjectBCompute,
      }),
    ).toEqual({
      channelId: PROJECT_C,
      compute: { kind: "sandbox", backend: "" },
    });
  });

  test("ambient Recents applies before hydration but never reapplies afterward", () => {
    expect(
      resolveAmbientNewSessionProjectChannelId({
        launchChannelId: undefined,
        recentChannelId: PROJECT_A,
        remoteDraftHydrated: false,
      }),
    ).toBe(PROJECT_A);
    expect(
      resolveAmbientNewSessionProjectChannelId({
        launchChannelId: undefined,
        recentChannelId: PROJECT_A,
        remoteDraftHydrated: true,
      }),
    ).toBeUndefined();
    expect(
      resolveAmbientNewSessionProjectChannelId({
        launchChannelId: null,
        recentChannelId: PROJECT_A,
        remoteDraftHydrated: true,
      }),
    ).toBeNull();
  });
});
