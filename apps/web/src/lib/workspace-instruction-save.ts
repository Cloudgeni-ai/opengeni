import type { OpenGeniClient, WorkspaceInstructionPolicyHead } from "@opengeni/sdk";

/** Keep one logical save's operation IDs across uncertain transport outcomes. */
export function createWorkspaceInstructionSave(
  client: Pick<
    OpenGeniClient,
    "createWorkspaceInstructionPolicyDraft" | "activateWorkspaceInstructionPolicyRevision"
  >,
  workspaceId: string,
  content: string,
  head: Pick<WorkspaceInstructionPolicyHead, "revisionId" | "activationVersion"> | null,
) {
  const draftRequest = {
    operationId: crypto.randomUUID(),
    kind: "policy" as const,
    scope: "global" as const,
    roleKey: null,
    content,
    provenanceSource: "human" as const,
    provenanceSourceId: null,
    supersedesRevisionId: head?.revisionId ?? null,
  };
  const activationRequest = {
    operationId: crypto.randomUUID(),
    expectedCurrentRevisionId: head?.revisionId ?? null,
    expectedActivationVersion: head?.activationVersion ?? 0,
    reason: "Updated by a workspace admin from Agent Knowledge",
  };
  return {
    content,
    matches(
      nextClient: typeof client,
      nextWorkspaceId: string,
      nextContent: string,
      nextHead: typeof head,
    ) {
      return (
        client === nextClient &&
        workspaceId === nextWorkspaceId &&
        content === nextContent &&
        (head?.revisionId ?? null) === (nextHead?.revisionId ?? null) &&
        (head?.activationVersion ?? 0) === (nextHead?.activationVersion ?? 0)
      );
    },
    async run() {
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
