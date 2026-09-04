import type { NewSessionSelectionHistory } from "@opengeni/sdk";

import { rememberedProjectCompute, type ComputeTarget } from "@/lib/session-create";
import type { SandboxBackend } from "@/types";

type PersistedProjectProvenance = {
  selectedProjectChannelId?: string | null | undefined;
};

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
      rememberedProjectCompute(history, channelId, defaultSandboxBackend) ??
      (currentSelection.channelId === channelId
        ? currentSelection.compute
        : defaultSandboxBackend === "selfhosted"
          ? { kind: "machine", sandboxId: null, folder: { kind: "root" } }
          : { kind: "sandbox", backend: "" }),
  };
}

export function resolveHydratedNewSessionProjectSelection(input: {
  launchChannelId: string | null | undefined;
  remote: PersistedProjectProvenance;
  history: NewSessionSelectionHistory;
  restoredCompute: ComputeTarget;
  defaultSandboxBackend?: SandboxBackend;
}): { channelId: string | null; compute: ComputeTarget } {
  const persistedOrRecentChannelId = Object.hasOwn(input.remote, "selectedProjectChannelId")
    ? (input.remote.selectedProjectChannelId ?? null)
    : (input.history.projects[0]?.channelId ?? null);
  const channelId =
    input.launchChannelId !== undefined ? input.launchChannelId : persistedOrRecentChannelId;

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
