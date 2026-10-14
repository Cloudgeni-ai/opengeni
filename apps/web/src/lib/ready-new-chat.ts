import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

/**
 * Puts `text` in a workspace's new-chat composer, ready to send: the saved
 * draft's message is replaced and everything else it holds (model, resources,
 * tools, options) stays as it was. The person sends, edits or clears it there,
 * so nothing starts until they do.
 */
export async function readyNewChat(
  client: Pick<OpenGeniBrowserClient, "getNewSessionDraft" | "saveNewSessionDraft">,
  workspaceId: string,
  text: string,
): Promise<void> {
  const draft = await client.getNewSessionDraft(workspaceId);
  await client.saveNewSessionDraft(workspaceId, {
    text,
    resources: draft.resources,
    tools: draft.tools,
    toolsProvided: draft.toolsProvided,
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    latencyMode: draft.latencyMode,
    ...(draft.modelProvided !== undefined ? { modelProvided: draft.modelProvided } : {}),
    ...(draft.selectedProjectChannelId !== undefined
      ? { selectedProjectChannelId: draft.selectedProjectChannelId }
      : {}),
    options: draft.options,
    expectedRevision: draft.revision,
  });
}
