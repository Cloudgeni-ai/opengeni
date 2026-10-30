import type { OpenGeniClient, WorkspaceInstructionPolicyHead } from "@opengeni/sdk";

/**
 * Keep one logical save's operation IDs across uncertain transport outcomes.
 * Empty text clears the instructions: it is saved as an empty version, which
 * agents ignore. A stored earlier-settings override would then apply again, so
 * clearing also removes it when `clearLegacy` says one is set.
 */
export function createWorkspaceInstructionSave(
  client: Pick<
    OpenGeniClient,
    | "createWorkspaceInstructionPolicyDraft"
    | "activateWorkspaceInstructionPolicyRevision"
    | "updateWorkspace"
  >,
  workspaceId: string,
  content: string,
  head: Pick<WorkspaceInstructionPolicyHead, "revisionId" | "activationVersion"> | null,
  clearLegacy = false,
) {
  const cleared = !content.trim();
  const draftRequest = {
    operationId: crypto.randomUUID(),
    kind: "policy" as const,
    scope: "global" as const,
    roleKey: null,
    content: cleared ? "" : content,
    provenanceSource: "human" as const,
    provenanceSourceId: null,
    supersedesRevisionId: head?.revisionId ?? null,
  };
  const activationRequest = {
    operationId: crypto.randomUUID(),
    expectedCurrentRevisionId: head?.revisionId ?? null,
    expectedActivationVersion: head?.activationVersion ?? 0,
    reason: cleared
      ? "Cleared by a workspace admin from Knowledge"
      : "Updated by a workspace admin from Knowledge",
  };
  return {
    content,
    matches(
      nextClient: typeof client,
      nextWorkspaceId: string,
      nextContent: string,
      nextHead: typeof head,
      nextClearLegacy = false,
    ) {
      return (
        client === nextClient &&
        workspaceId === nextWorkspaceId &&
        content === nextContent &&
        clearLegacy === nextClearLegacy &&
        (head?.revisionId ?? null) === (nextHead?.revisionId ?? null) &&
        (head?.activationVersion ?? 0) === (nextHead?.activationVersion ?? 0)
      );
    },
    async run() {
      // Remove the override first: if that is refused, nothing has changed,
      // and while a policy with text is active the override never applies.
      if (cleared && clearLegacy) {
        await client.updateWorkspace(workspaceId, { agentInstructions: null });
      }
      const draft = await client.createWorkspaceInstructionPolicyDraft(workspaceId, draftRequest);
      const activated = await client.activateWorkspaceInstructionPolicyRevision(
        workspaceId,
        draft.id,
        activationRequest,
      );
      return { head: activated.head, content: draft.content };
    },
  };
}
