import { Linking } from "react-native";

/** The deployment's web address for a path, such as a chat's shareable link. */
export function webUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Administration stays on the web: open the deployment's page in the system
 * browser, which shares the sign-in the app was approved from.
 */
export function openOnWeb(baseUrl: string, path: string): void {
  void Linking.openURL(webUrl(baseUrl, path));
}

export const webPaths = {
  /** The workspace's new-chat page, where every composer option lives. */
  workspace: (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`,
  /** The same conversation in the web app. */
  session: (workspaceId: string, sessionId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
  organizationSettings: (workspaceId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/organization`,
  workspaceSettings: (workspaceId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/settings`,
  /** One automation's page, where its form and event triggers are edited. */
  automation: (workspaceId: string, automationId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automationId)}`,
  security: () => "/settings/security",
  home: () => "/",
};
