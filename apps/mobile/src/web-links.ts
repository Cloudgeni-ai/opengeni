import { Linking } from "react-native";

/**
 * Administration stays on the web: open the deployment's page in the system
 * browser, which shares the sign-in the app was approved from.
 */
export function openOnWeb(baseUrl: string, path: string): void {
  void Linking.openURL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
}

export const webPaths = {
  /** The workspace's new-chat page, where every composer option lives. */
  workspace: (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`,
  organizationSettings: (workspaceId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/organization`,
  workspaceSettings: (workspaceId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/settings`,
  security: () => "/settings/security",
  home: () => "/",
};
