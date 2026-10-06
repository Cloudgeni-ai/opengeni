import {
  useNewSessionDraft,
  type NewSessionDraftEditable,
} from "@opengeni/react/new-session-draft";
import type { NativeFileAttachmentsResult } from "@opengeni/react-native";
import type { LatencyMode, OpenGeniClient, ReasoningEffort, ResourceRef } from "@opengeni/sdk";
import { useMemo } from "react";
import { gitHubRepositoryResource, type NewSessionOptions } from "@/new-session-options";

/**
 * The home composer's draft, saved to the server like web's new-session
 * draft: text, model, project, options and uploaded files follow the person
 * across leaving the screen, relaunching and other devices (and the web).
 */
export function useHomeDraftSync(input: {
  client: OpenGeniClient;
  workspaceId: string | null;
  text: string;
  setText(text: string): void;
  model: string | null;
  effort: ReasoningEffort | null;
  latencyMode: LatencyMode;
  /** True when the person picked the model here, false while it follows the default. */
  modelProvided: boolean;
  applyModel(model: string, effort: ReasoningEffort, latencyMode: LatencyMode): void;
  options: NewSessionOptions;
  attachments: NativeFileAttachmentsResult;
  suspend: boolean;
}) {
  const { options, attachments } = input;
  const choices = options.choices;
  const repositoryResources = useMemo(
    () =>
      options.repositories
        .filter((repo) => choices.repositoryIds.includes(repo.id))
        .map(gitHubRepositoryResource),
    [choices.repositoryIds, options.repositories],
  );
  const value: NewSessionDraftEditable = {
    text: input.text,
    resources: [...repositoryResources, ...attachments.readyResources],
    tools: [],
    // Connectors turned off are the only tool choice here: the rest follow the workspace.
    toolsProvided: choices.excludedConnectorIds.length > 0,
    model: input.model ?? "",
    reasoningEffort: input.effort ?? "medium",
    latencyMode: input.latencyMode,
    modelProvided: input.modelProvided,
    selectedProjectChannelId: choices.channelId,
    options: {
      ...(choices.visibility === "private" ? { visibility: "private" as const } : {}),
      ...(choices.targetSandboxId ? { targetSandboxId: choices.targetSandboxId } : {}),
      ...(choices.variableSetIds.length > 0 ? { variableSetIds: choices.variableSetIds } : {}),
      ...(choices.excludedConnectorIds.length > 0
        ? { excludedMcpServerIds: choices.excludedConnectorIds }
        : {}),
    },
  };
  return useNewSessionDraft({
    workspaceId: input.workspaceId ?? "",
    client: input.client,
    value,
    // Read only once the lists a restored draft refers to are known.
    resourceHydrationReady: Boolean(input.workspaceId && input.model && options.ready),
    suspendAutosave: input.suspend || !input.model,
    onApplyRemote: (remote) => {
      input.setText(remote.text);
      if (remote.modelProvided && remote.model) {
        input.applyModel(remote.model, remote.reasoningEffort, remote.latencyMode);
      }
      options.apply({
        visibility: remote.options.visibility ?? "workspace",
        targetSandboxId: remote.options.targetSandboxId ?? null,
        channelId: remote.selectedProjectChannelId ?? null,
        variableSetIds: remote.options.variableSetIds ?? [],
        excludedConnectorIds: remote.options.excludedMcpServerIds ?? [],
        repositoryIds: remote.resources.flatMap((resource: ResourceRef) =>
          resource.kind === "repository" && resource.githubRepositoryId
            ? [resource.githubRepositoryId]
            : [],
        ),
      });
    },
    restoreReadyFiles: (files) => attachments.restoreReady(files),
  });
}
