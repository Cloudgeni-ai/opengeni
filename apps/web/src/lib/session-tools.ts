import type { CapabilityCatalogItem, ClientConfig, GitHubRepository, ReasoningEffort, ResourceRef, ToolRef } from "@/types";

export type RepoDraft = { id: number; url: string; ref: string };
export type IntelligenceEffort = Extract<ReasoningEffort, "low" | "medium" | "high" | "xhigh">;
export type McpServerOption = { id: string; name: string };

export const uiReasoningEffortOrder: IntelligenceEffort[] = ["low", "medium", "high", "xhigh"];

export function isUiReasoningEffort(value: ReasoningEffort): value is IntelligenceEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

export function labelEffort(value: IntelligenceEffort): string {
  return value === "xhigh" ? "Extra high" : value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function buildTools(existing: ToolRef[] | undefined, mcpServerIds: string[] = []): ToolRef[] {
  const out = [...(existing ?? [])];
  const ids = [...mcpServerIds];
  // Document Search is one user-facing tool but needs its file-download helper
  // ("files") alongside it; pull it in whenever "docs" is selected.
  if (ids.includes("docs") && !ids.includes("files")) {
    ids.push("files");
  }
  for (const id of ids) {
    if (id && !out.some((tool) => tool.kind === "mcp" && tool.id === id)) {
      out.push({ kind: "mcp", id });
    }
  }
  return out;
}

export function buildResources(manualRepos: RepoDraft[], repos: GitHubRepository[], selected: Set<number>, selectedRefs: Record<number, string>): ResourceRef[] {
  const raw = [
    ...repos.filter((repo) => selected.has(repo.id)).map((repo) => ({
      url: repo.cloneUrl,
      ref: (selectedRefs[repo.id] ?? repo.defaultBranch).trim(),
      repositoryId: repo.id,
      installationId: repo.installationId,
      private: repo.private,
    })),
    ...manualRepos.map((repo) => ({
      url: repo.url.trim(),
      ref: repo.ref.trim(),
      repositoryId: null,
      installationId: null,
      private: false,
    })),
  ].filter((repo) => repo.url.length > 0);
  const mountPaths = new Set<string>();
  return raw.map((repo) => {
    if (!repo.ref) {
      throw new Error("Repository ref is required.");
    }
    const parsed = normalizeRepositoryUrl(repo.url);
    const mountPath = `repos/${parsed.repo}`;
    if (mountPaths.has(mountPath)) {
      throw new Error(`Duplicate repository mount path: ${mountPath}`);
    }
    mountPaths.add(mountPath);
    return {
      kind: "repository",
      uri: `https://${parsed.host}/${parsed.repo}.git`,
      ref: repo.ref,
      mountPath,
      ...(repo.private && repo.repositoryId ? { githubRepositoryId: repo.repositoryId } : {}),
      ...(repo.private && repo.installationId ? { githubInstallationId: repo.installationId } : {}),
    };
  });
}

export function gitHubRepositoryResource(repo: GitHubRepository, ref: string): Extract<ResourceRef, { kind: "repository" }> {
  const parsed = normalizeRepositoryUrl(repo.cloneUrl);
  return {
    kind: "repository",
    uri: `https://${parsed.host}/${parsed.repo}.git`,
    ref: ref.trim() || repo.defaultBranch,
    mountPath: `repos/${parsed.repo}`,
    ...(repo.private ? { githubRepositoryId: repo.id, githubInstallationId: repo.installationId } : {}),
  };
}

export function isRepositoryResourceForGitHubRepo(resource: Extract<ResourceRef, { kind: "repository" }>, repo: GitHubRepository): boolean {
  if (repo.private) {
    return resource.githubRepositoryId === repo.id && resource.githubInstallationId === repo.installationId;
  }
  return sameRepositoryUri(resource, gitHubRepositoryResource(repo, repo.defaultBranch).uri);
}

export function sameRepositoryUri(resource: ResourceRef, uri: string): boolean {
  return resource.kind === "repository" && resource.uri === uri;
}

export function repositoryDisplayName(resource: Extract<ResourceRef, { kind: "repository" }>): string {
  try {
    return new URL(resource.uri).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  } catch {
    return resource.uri;
  }
}

export function normalizeRepositoryUrl(value: string): { host: string; repo: string } {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:") {
    throw new Error("Repository URL must use HTTPS.");
  }
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Repository URL must include owner and repo.");
  }
  return { host: url.hostname.toLowerCase(), repo: parts.join("/") };
}

export type RepositoryGroup = { installationId: number; label: string; detail: string; repositories: GitHubRepository[] };

export function groupRepositories(repositories: GitHubRepository[]): RepositoryGroup[] {
  return repositories.reduce<RepositoryGroup[]>((groups, repo) => {
    let group = groups.find((item) => item.installationId === repo.installationId);
    if (!group) {
      group = {
        installationId: repo.installationId,
        label: repo.accountLogin,
        detail: repo.accountType ?? "GitHub account",
        repositories: [],
      };
      groups.push(group);
    }
    group.repositories.push(repo);
    return groups;
  }, []);
}

export function selectableMcpServers(config: ClientConfig | null): McpServerOption[] {
  if (!config) {
    return [];
  }
  // "files" is the document-search download helper, attached automatically with
  // "docs" (see buildTools) — it is not a tool the user picks on its own, so
  // hide it. Everything else, including the first-party "opengeni" and "docs",
  // is selectable from the unified Tools dropdown.
  const hidden = new Set(["files"]);
  return config.mcpServers.filter((server) => !hidden.has(server.id));
}

export function enabledWorkspaceCapabilityMcpServers(items: CapabilityCatalogItem[]): McpServerOption[] {
  return items.flatMap((item) => {
    if (item.kind !== "mcp" || !item.enabled || !item.runtime.available || !item.runtime.mcpServerId) {
      return [];
    }
    return [{ id: item.runtime.mcpServerId, name: item.name }];
  });
}

export function mergeMcpServerOptions(...groups: McpServerOption[][]): McpServerOption[] {
  const byId = new Map<string, McpServerOption>();
  for (const group of groups) {
    for (const server of group) {
      if (server.id && !byId.has(server.id)) {
        byId.set(server.id, server);
      }
    }
  }
  return [...byId.values()];
}

export function selectedAvailableCapabilityToolIds(current: Set<string>, availableIds: string[], previouslyAvailableIds: Set<string> = new Set()): Set<string> {
  const available = new Set(availableIds);
  const next = new Set([...current].filter((id) => available.has(id)));
  for (const id of availableIds) {
    if (id && !previouslyAvailableIds.has(id)) {
      next.add(id);
    }
  }
  return next;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
