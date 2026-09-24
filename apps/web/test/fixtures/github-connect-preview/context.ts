const connected = new URLSearchParams(window.location.search).get("state") === "connected";

export const githubCatalogItem = {
  id: "api:github-app",
  kind: "api",
  name: "GitHub App",
  description: "Connect your GitHub account and choose the repositories this workspace can access.",
  providerDomain: "github.com",
  logoAssetPath: null,
  enabled: false,
  authKind: "oauth2",
  metadata: {},
};

export function useAppContext() {
  return {
    client: {
      catalogAssetUrl: () => null,
      getGitHubApp: async () => await new Promise(() => {}), // Preview of the pending navigation state.
    },
    githubStatus: connected ? { status: "bound", installations: [{ installationId: 42 }] } : null,
    refreshGitHub: async () => {},
    workspaceCapabilityCatalog: [githubCatalogItem],
  };
}