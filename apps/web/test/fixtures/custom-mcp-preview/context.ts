const canManage = new URLSearchParams(window.location.search).get("role") !== "viewer";

export function useAppContext() {
  return {
    client: {
      listCapabilities: async () => ({ items: [] }),
      createCapability: async () => await new Promise(() => {}),
    },
    workspaceCapabilityCatalog: [],
    accessContext: {
      workspaceGrants: [{ workspaceId: "sample", permissions: canManage ? ["capabilities:manage"] : [] }],
    },
  };
}