import type { NewSessionSelectionHistory } from "@opengeni/sdk";

import { resolveComposerLaunchChannelId } from "@/lib/composer-launch";
import { newSessionProjectSelection, type ComputeTarget } from "@/lib/session-create";
import type { SandboxBackend } from "@/types";

type PersistedProjectProvenance = {
  selectedProjectChannelId?: string | null | undefined;
};

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
  const channelId = resolveComposerLaunchChannelId(
    input.launchChannelId,
    persistedOrRecentChannelId,
  );

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
