// Preview-only navigation state. InboxLink and the inbox store are production code.
export const workspaceId = "22222222-2222-4222-8222-222222222222";
export function useRail() {
  return { workspaceId, collapsed: false, setDrawerOpen: () => {} };
}
export const useOptionalRail = useRail;
