import { Linking, Platform } from "react-native";

/**
 * The deployment's web address for a path, such as a chat's shareable link.
 * Plain: for links people share and for the app's own API requests. A page
 * the app opens itself goes through `hostedUrl`.
 */
export function webUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The query the iOS app adds to the deployment's pages it opens. */
export const HOSTED_CLIENT_PARAM = "client";
export const HOSTED_CLIENT_IOS = "ios";

/**
 * A deployment page the app opens (in the browser or a web view). On iOS it
 * says so with `client=ios`, so the hosted pages show their in-app context
 * (no purchase prompts). The page's own query and hash are kept.
 */
export function markHostedUrl(url: string, platform: string = Platform.OS): string {
  if (platform !== "ios") return url;
  try {
    const marked = new URL(url);
    marked.searchParams.set(HOSTED_CLIENT_PARAM, HOSTED_CLIENT_IOS);
    return marked.toString();
  } catch {
    return url;
  }
}

/** `webUrl` for a page the app opens itself; see `markHostedUrl`. */
export function hostedUrl(baseUrl: string, path: string, platform: string = Platform.OS): string {
  return markHostedUrl(webUrl(baseUrl, path), platform);
}

/**
 * Administration stays on the web: open the deployment's page in the system
 * browser, which shares the sign-in the app was approved from.
 */
export function openOnWeb(baseUrl: string, path: string): void {
  void Linking.openURL(hostedUrl(baseUrl, path));
}

export const webPaths = {
  /** The workspace's new-chat page, where every composer option lives. */
  workspace: (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`,
  /** The same conversation in the web app. */
  session: (workspaceId: string, sessionId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
  organizationSettings: (workspaceId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/organization`,
  /** The organization's people, where owners are made. */
  organizationMembers: (workspaceId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/organization?section=people`,
  workspaceSettings: (workspaceId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/settings`,
  /** One agent's page, where it is managed. */
  agent: (workspaceId: string, agentId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
  /** One automation's page, where its form and event triggers are edited. */
  automation: (workspaceId: string, automationId: string) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automationId)}`,
  security: () => "/settings/security",
  home: () => "/",
};
