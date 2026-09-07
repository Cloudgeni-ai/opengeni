import type { NewSessionSelectionHistory } from "@opengeni/sdk";

import { rememberedProjectCompute, type ComputeTarget } from "@/lib/session-create";
import type { SandboxBackend } from "@/types";

type PersistedProjectProvenance = {
  selectedProjectChannelId?: string | null | undefined;
};

export type NewSessionProjectLaunchIntent =
  | { generation: number; kind: "initial_omitted" }
  | { generation: number; kind: "explicit"; channelId: string | null }
  | { generation: number; kind: "omitted_after_explicit" };

export function initialNewSessionProjectLaunchIntent(
  launchChannelId: string | null | undefined,
): NewSessionProjectLaunchIntent {
  return launchChannelId === undefined
    ? { generation: 0, kind: "initial_omitted" }
    : { generation: 0, kind: "explicit", channelId: launchChannelId };
}

export function nextNewSessionProjectLaunchIntent(
  current: NewSessionProjectLaunchIntent,
  previousLaunchChannelId: string | null | undefined,
  launchChannelId: string | null | undefined,
): NewSessionProjectLaunchIntent {
  if (previousLaunchChannelId === launchChannelId) return current;
  return launchChannelId === undefined
    ? { generation: current.generation + 1, kind: "omitted_after_explicit" }
    : { generation: current.generation + 1, kind: "explicit", channelId: launchChannelId };
}

export function nextFocusedNewSessionProjectLaunchIntent(
  current: NewSessionProjectLaunchIntent,
  channelId: string | null | undefined,
): NewSessionProjectLaunchIntent {
  // Same-route New session requests are meaningful even when the URL/search
  // value is unchanged, so every request gets a fresh committed generation.
  return channelId === undefined
    ? { generation: current.generation + 1, kind: "omitted_after_explicit" }
    : { generation: current.generation + 1, kind: "explicit", channelId };
}

/**
 * Resolve the route's ambient project-selection effect. Undefined means the
 * effect must not mutate an authority already installed by remote hydration;
 * an explicit-to-omitted route transition is a new ordinary launch intent.
 */
export function resolveAmbientNewSessionProjectChannelId(input: {
  launchChannelId: string | null | undefined;
  previousLaunchChannelId: string | null | undefined;
  recentChannelId: string | null;
  remoteDraftHydrated: boolean;
}): string | null | undefined {
  if (input.launchChannelId !== undefined) return input.launchChannelId;
  if (input.previousLaunchChannelId !== undefined) return input.recentChannelId;
  return input.remoteDraftHydrated ? undefined : input.recentChannelId;
}

// Keep project-selection orchestration in this route-only leaf. session-create.ts
// is also retained by the active-session route and must not carry new-session-only code.
/** Apply a project change without leaving compute from the prior project behind. */
export function newSessionProjectSelection(
  history: NewSessionSelectionHistory,
  channelId: string | null,
  currentSelection: {
    /** Undefined means the current compute came from a draft with unknown project provenance. */
    channelId: string | null | undefined;
    compute: ComputeTarget;
  },
  defaultSandboxBackend?: SandboxBackend,
): { channelId: string | null; compute: ComputeTarget } {
  return {
    channelId,
    compute:
      currentSelection.channelId === channelId
        ? currentSelection.compute
        : (rememberedProjectCompute(history, channelId, defaultSandboxBackend) ??
          (defaultSandboxBackend === "selfhosted"
            ? { kind: "machine", sandboxId: null, folder: { kind: "root" } }
            : { kind: "sandbox", backend: "" })),
  };
}

export function resolveHydratedNewSessionProjectSelection(input: {
  launchIntent: NewSessionProjectLaunchIntent;
  remote: PersistedProjectProvenance;
  history: NewSessionSelectionHistory;
  restoredCompute: ComputeTarget;
  defaultSandboxBackend?: SandboxBackend;
}): { channelId: string | null; compute: ComputeTarget } {
  const persistedOrRecentChannelId = Object.hasOwn(input.remote, "selectedProjectChannelId")
    ? (input.remote.selectedProjectChannelId ?? null)
    : (input.history.projects[0]?.channelId ?? null);
  const channelId =
    input.launchIntent.kind === "explicit"
      ? input.launchIntent.channelId
      : input.launchIntent.kind === "omitted_after_explicit"
        ? (input.history.projects[0]?.channelId ?? null)
        : persistedOrRecentChannelId;

  return newSessionProjectSelection(
    input.history,
    channelId,
    {
      channelId: input.remote.selectedProjectChannelId,
      compute: input.restoredCompute,
    },
    input.defaultSandboxBackend,
  );
}

export function hydratedNewSessionProjectProvenancePresent(
  launchIntent: NewSessionProjectLaunchIntent,
  remote: PersistedProjectProvenance,
): boolean {
  if (launchIntent.kind === "explicit") return true;
  if (launchIntent.kind === "omitted_after_explicit") return false;
  return Object.hasOwn(remote, "selectedProjectChannelId");
}
