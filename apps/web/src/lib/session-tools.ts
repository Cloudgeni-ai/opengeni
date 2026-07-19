import type {
  CapabilityCatalogItem,
  ClientConfig,
  GitHubRepository,
  ReasoningEffort,
  ResourceRef,
  Session,
  ToolRef,
} from "@/types";

export type RepoDraft = { id: number; url: string; ref: string };
// The composer's effort picker spans the FULL host enum, not a UI-only subset:
// the old `Extract<…,"low"|…>` silently dropped `none`/`minimal`, so a deployment
// whose default is one of those was overridden to "low" on every web turn
// (billing impact — "low" beats the deployer's configured default server-side).
export type IntelligenceEffort = ReasoningEffort;
export type McpServerOption = { id: string; name: string };

// Canonical low→high ordering over the full enum; the picker renders efforts in
// this order, filtered to whatever the host curates in `allowedReasoningEfforts`.
export const reasoningEffortOrder: IntelligenceEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function labelEffort(value: IntelligenceEffort): string {
  if (value === "xhigh") {
    return "Extra high";
  }
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

// The host-curated effort options for the picker, in canonical order. Falls back
// to the full enum when the host exposes no allow-list. No lossy UI filter: every
// effort the host allows (including `none`/`minimal`) is offered, so the deployer's
// configured default is always representable/selectable.
export function effortOptionsFor(
  config: Pick<ClientConfig, "allowedReasoningEfforts"> | null,
): IntelligenceEffort[] {
  const allowed = config?.allowedReasoningEfforts ?? reasoningEffortOrder;
  return reasoningEffortOrder.filter((effort) => allowed.includes(effort));
}

// The composer's initial effort once config lands: the deployment default,
// faithfully — no clamping to a UI subset (the bug that pinned `none`/`minimal`
// defaults to "low").
export function initialReasoningEffort(
  config: Pick<ClientConfig, "defaultReasoningEffort">,
): IntelligenceEffort {
  return config.defaultReasoningEffort;
}

export function buildTools(
  existing: ToolRef[] | undefined,
  mcpServerIds: string[] = [],
): ToolRef[] {
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

function canonicalToolIds(tools: ToolRef[]): string[] {
  return [...new Set(tools.map((tool) => `${tool.kind}:${tool.id}`))].sort();
}

/**
 * Materialize the picker's selection only when it narrows/pins the inherited
 * baseline. `undefined` is the wire-level omitted-tools contract; `[]` is an
 * intentional empty selection. Canonicalization includes hidden helpers such
 * as docs → files, so UI-only representation differences do not pin a turn.
 */
export function toolsForPolicySelection(input: {
  existing?: ToolRef[];
  selectedMcpServerIds: Iterable<string>;
  baselineMcpServerIds: Iterable<string>;
  forceExplicit?: boolean;
}): ToolRef[] | undefined {
  const selected = buildTools(input.existing, [...input.selectedMcpServerIds]);
  if (input.forceExplicit === true) {
    return selected;
  }
  const baseline = buildTools(undefined, [...input.baselineMcpServerIds]);
  return canonicalToolIds(selected).join("\u0000") === canonicalToolIds(baseline).join("\u0000")
    ? undefined
    : selected;
}

/**
 * Project the server-authoritative session policy into currently selectable
 * picker IDs. Workspace-default sessions follow the live capability baseline;
 * fixed policies use their effective IDs (or their persisted refs for rolling
 * compatibility). Unavailable IDs remain visible in policy truth/inspector but
 * cannot be selected by a picker that cannot execute them.
 */
export function sessionPolicyPickerIds(
  session: Pick<Session, "tools" | "toolPolicy" | "effectiveToolPolicy">,
  selectableIds: Iterable<string>,
  workspaceDefaultIds: Iterable<string>,
): Set<string> {
  const selectable = new Set(selectableIds);
  const mode = session.effectiveToolPolicy?.mode ?? session.toolPolicy?.mode ?? "legacy";
  const policyIds =
    mode === "workspace_default"
      ? [...workspaceDefaultIds]
      : (session.effectiveToolPolicy?.effectiveIds ?? session.tools.map((tool) => tool.id));
  return new Set(policyIds.filter((id) => selectable.has(id)));
}

export function buildResources(
  manualRepos: RepoDraft[],
  repos: GitHubRepository[],
  selected: Set<number>,
  selectedRefs: Record<number, string>,
): ResourceRef[] {
  const raw = [
    ...repos
      .filter((repo) => selected.has(repo.id))
      .map((repo) => ({
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

export function gitHubRepositoryResource(
  repo: GitHubRepository,
  ref: string,
): Extract<ResourceRef, { kind: "repository" }> {
  const parsed = normalizeRepositoryUrl(repo.cloneUrl);
  return {
    kind: "repository",
    uri: `https://${parsed.host}/${parsed.repo}.git`,
    ref: ref.trim() || repo.defaultBranch,
    mountPath: `repos/${parsed.repo}`,
    ...(repo.private
      ? { githubRepositoryId: repo.id, githubInstallationId: repo.installationId }
      : {}),
  };
}

export function isRepositoryResourceForGitHubRepo(
  resource: Extract<ResourceRef, { kind: "repository" }>,
  repo: GitHubRepository,
): boolean {
  if (repo.private) {
    return (
      resource.githubRepositoryId === repo.id &&
      resource.githubInstallationId === repo.installationId
    );
  }
  return sameRepositoryUri(resource, gitHubRepositoryResource(repo, repo.defaultBranch).uri);
}

export function sameRepositoryUri(resource: ResourceRef, uri: string): boolean {
  return resource.kind === "repository" && resource.uri === uri;
}

export function repositoryDisplayName(
  resource: Extract<ResourceRef, { kind: "repository" }>,
): string {
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

export type RepositoryGroup = {
  installationId: number;
  label: string;
  detail: string;
  repositories: GitHubRepository[];
};

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

export function enabledWorkspaceCapabilityMcpServers(
  items: CapabilityCatalogItem[],
): McpServerOption[] {
  return items.flatMap((item) => {
    if (
      item.kind !== "mcp" ||
      !item.enabled ||
      !item.runtime.available ||
      !item.runtime.mcpServerId
    ) {
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

export function selectedAvailableCapabilityToolIds(
  current: Set<string>,
  availableIds: string[],
  previouslyAvailableIds: Set<string> = new Set(),
  defaultIds: string[] = availableIds,
): Set<string> {
  const available = new Set(availableIds);
  const next = new Set([...current].filter((id) => available.has(id)));
  for (const id of defaultIds) {
    if (id && available.has(id) && !previouslyAvailableIds.has(id)) {
      next.add(id);
    }
  }
  return next;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
