import type { WorkspaceStateResponse } from "@opengeni/sdk";

export function activeGlobalWorkspaceInstructionHead(state: WorkspaceStateResponse) {
  return (
    state.policy.activeHeads.find(
      (head) => head.kind === "policy" && head.scope === "global" && head.roleKey === null,
    ) ?? null
  );
}
