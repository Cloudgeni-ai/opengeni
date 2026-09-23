// Sample billing authority for the preview only; no API or customer data.
export function useAppContext() {
  return {
    workspaces: [{ id: "preview-workspace", accountId: "preview-account" }],
    accessContext: {
      mode: "managed",
      accountGrants: [{ accountId: "preview-account", permissions: ["billing:manage"] }],
      workspaceGrants: [],
    },
  } as never;
}