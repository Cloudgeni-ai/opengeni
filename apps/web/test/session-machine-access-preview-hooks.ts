// Preview data only; the rendered picker and notices are production components.
export function useWorkspaceRigs() {
  return { rigs: [] };
}
export function useWorkspaceMachines() {
  throw new Error("Preview supplies its machine list explicitly");
}
