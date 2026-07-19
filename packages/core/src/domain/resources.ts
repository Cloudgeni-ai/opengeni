import type { Settings } from "@opengeni/config";
import {
  mergeResourceRefs as mergeContractResourceRefs,
  mergeToolRefs,
  resourceIdentityKey,
  ResourceRefConflictError,
  stableJson,
  type ResourceRef,
  type ToolRef,
} from "@opengeni/contracts";
import { listGitHubInstallationIdsForWorkspace, requireFile, type Database } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

export function validateToolRefs(tools: ToolRef[], settings: McpSettings): ToolRef[] {
  const mcpServerIds = new Set(settings.mcpServers.map((server) => server.id));
  const out: ToolRef[] = [];
  for (const tool of tools) {
    if (tool.kind !== "mcp") {
      throw new HTTPException(422, {
        message: `unsupported tool kind: ${(tool as { kind?: string }).kind}`,
      });
    }
    const optional = tool.optional === true;
    if (!mcpServerIds.has(tool.id)) {
      if (optional) {
        continue;
      }
      throw new HTTPException(422, { message: `unknown MCP server id: ${tool.id}` });
    }
    // Tool refs are tri-state for pack portability across deployments:
    //  - bare / optional:false is STRICT: the id must be configured here and
    //    runtime connection failure fails the turn.
    //  - optional:true + known id is preserved: runtime treats it like an
    //    auto-attached capability MCP and skips connect/list failures.
    //  - optional:true + unknown id is skipped above: the client explicitly
    //    opted into graceful degradation for MCPs (for example docs servers
    //    like context7) that only some deployments configure.
    out.push(
      optional ? { kind: "mcp", id: tool.id, optional: true } : { kind: "mcp", id: tool.id },
    );
  }
  return mergeToolRefs([], out);
}

type McpSettings = Pick<Settings, "mcpServers">;

export function enabledCapabilityMcpToolRefs(
  settings: McpSettings,
  runtimeSettings: McpSettings,
): ToolRef[] {
  const configuredIds = new Set(settings.mcpServers.map((server) => server.id));
  return (
    runtimeSettings.mcpServers
      .filter((server) => !configuredIds.has(server.id))
      // AUTO-ATTACHED (workspace-default) capability servers are marked optional:
      // one of them having a broken/expired credential must SKIP that server, not
      // fail the whole turn before the model runs. The caller only reaches here
      // when the request omitted `tools`; an explicit list is never defaulted.
      .map((server) => ({ kind: "mcp", id: server.id, optional: true }))
  );
}

export function withDefaultEnabledCapabilityMcpTools(
  tools: ToolRef[],
  settings: McpSettings,
  runtimeSettings: McpSettings,
): ToolRef[] {
  return mergeToolRefs(tools, enabledCapabilityMcpToolRefs(settings, runtimeSettings));
}

/** Drop stored refs that are no longer present in the current runtime registry. */
export function availableToolRefs(tools: ToolRef[], settings: McpSettings): ToolRef[] {
  const available = new Set(settings.mcpServers.map((server) => server.id));
  return tools.filter((tool) => available.has(tool.id));
}

/** A child or fixed-policy follow-up may narrow its allow-list, never widen it. */
export function assertToolRefsSubset(
  requested: ToolRef[],
  allowed: ToolRef[],
  message = "requested tools exceed the session tool policy",
): void {
  const allowedIds = new Set(allowed.map((tool) => `${tool.kind}:${tool.id}`));
  const widened = requested.find((tool) => !allowedIds.has(`${tool.kind}:${tool.id}`));
  if (widened) {
    throw new HTTPException(403, { message: `${message}: ${widened.id}` });
  }
}

/** Validate runtime availability and then enforce the durable policy fence. */
export function validateToolRefsForSessionPolicy(input: {
  requested: ToolRef[];
  settings: McpSettings;
  allowedTools: ToolRef[];
  message: string;
}): ToolRef[] {
  const validated = validateToolRefs(input.requested, input.settings);
  assertToolRefsSubset(validated, input.allowedTools, input.message);
  return validated;
}

export function normalizeResources(resources: ResourceRef[]): ResourceRef[] {
  const mountPaths = new Map<string, string>();
  const identities = new Map<string, string>();
  const seenResources = new Set<string>();
  const out: ResourceRef[] = [];
  for (const resource of resources) {
    let normalized: ResourceRef;
    if (resource.kind === "file") {
      const mountPath = normalizeMountPath(resource.mountPath ?? `files/${resource.fileId}`);
      normalized = {
        kind: "file",
        fileId: resource.fileId,
        mountPath,
      };
    } else {
      const url = parseResourceUrl(resource.uri);
      if (url.protocol !== "https:" || !url.hostname) {
        throw new HTTPException(422, { message: "repository resources must use HTTPS Git URLs" });
      }
      const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
      const parts = path.split("/").filter(Boolean);
      if (parts.length < 2) {
        throw new HTTPException(422, { message: "repository URL must include owner and repo" });
      }
      const repo = parts.join("/");
      const mountPath = normalizeMountPath(resource.mountPath ?? `repos/${repo}`);
      normalized = {
        kind: "repository",
        uri: `https://${url.hostname.toLowerCase()}/${repo}.git`,
        ref: resource.ref.trim(),
        mountPath,
        ...(resource.subpath ? { subpath: normalizeMountPath(resource.subpath) } : {}),
        ...(resource.provider ? { provider: resource.provider } : {}),
        ...(resource.repositoryId !== undefined ? { repositoryId: resource.repositoryId } : {}),
        ...(resource.installationId !== undefined
          ? { installationId: resource.installationId }
          : {}),
        ...(resource.projectId !== undefined ? { projectId: resource.projectId } : {}),
        ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
        ...(resource.githubInstallationId
          ? { githubInstallationId: resource.githubInstallationId }
          : {}),
        ...(resource.githubRepositoryId ? { githubRepositoryId: resource.githubRepositoryId } : {}),
      };
    }
    const key = stableJson(normalized);
    const mounted = normalized.mountPath ? mountPaths.get(normalized.mountPath) : undefined;
    if (mounted && mounted !== key) {
      throw new HTTPException(422, {
        message: `duplicate resource mount path: ${normalized.mountPath}`,
      });
    }
    if (normalized.mountPath) {
      mountPaths.set(normalized.mountPath, key);
    }
    const identity = resourceIdentityKey(normalized);
    const seenIdentity = identities.get(identity);
    if (seenIdentity && seenIdentity !== key) {
      throw new HTTPException(422, {
        message: `duplicate resource with different settings: ${identity}`,
      });
    }
    identities.set(identity, key);
    if (!seenResources.has(key)) {
      seenResources.add(key);
      out.push(normalized);
    }
  }
  return out;
}

export function mergeResourceRefs(
  existing: ResourceRef[],
  additions: ResourceRef[],
): ResourceRef[] {
  try {
    return mergeContractResourceRefs(existing, additions, { rejectConflicts: true });
  } catch (error) {
    if (error instanceof ResourceRefConflictError) {
      throw new HTTPException(422, { message: error.message });
    }
    throw error;
  }
}

export function validateGitHubRepositorySelectionShape(resources: ResourceRef[]): number | null {
  const selected = resources.flatMap((resource) => {
    if (resource.kind !== "repository") {
      return [];
    }
    const installationRaw =
      resource.githubInstallationId ??
      (resource.provider === "github" ? resource.installationId : undefined);
    const repositoryRaw =
      resource.githubRepositoryId ??
      (resource.provider === "github" ? resource.repositoryId : undefined);
    if (installationRaw === null && repositoryRaw === null) {
      return [];
    }
    if (installationRaw === undefined && repositoryRaw === undefined) {
      return [];
    }
    const installationId = positiveInteger(installationRaw);
    const repositoryId = positiveInteger(repositoryRaw);
    if (!installationId || !repositoryId) {
      throw new HTTPException(422, {
        message:
          "GitHub App repository resources require positive github_installation_id and github_repository_id",
      });
    }
    return [{ installationId, repositoryId }];
  });
  if (selected.length === 0) {
    return null;
  }
  const installationId = selected[0]!.installationId;
  if (selected.some((item) => item.installationId !== installationId)) {
    throw new HTTPException(422, {
      message: "GitHub App repository resources must belong to one installation",
    });
  }
  return installationId;
}

export async function validateGitHubRepositorySelection(
  db: Database,
  workspaceId: string,
  resources: ResourceRef[],
): Promise<void> {
  const installationId = validateGitHubRepositorySelectionShape(resources);
  if (installationId === null) {
    return;
  }
  const linkedInstallationIds = new Set(
    await listGitHubInstallationIdsForWorkspace(db, workspaceId),
  );
  if (!linkedInstallationIds.has(installationId)) {
    throw new HTTPException(422, {
      message:
        "GitHub App repository resources must belong to a GitHub App installation linked to this workspace",
    });
  }
}

export async function validateFileResources(
  db: Database,
  workspaceId: string,
  resources: ResourceRef[],
): Promise<void> {
  const fileIds = new Set<string>();
  for (const resource of resources) {
    if (resource.kind !== "file") {
      continue;
    }
    if (fileIds.has(resource.fileId)) {
      throw new HTTPException(422, { message: `duplicate file resource: ${resource.fileId}` });
    }
    fileIds.add(resource.fileId);
    const file = await requireFile(db, workspaceId, resource.fileId).catch(() => null);
    if (!file) {
      throw new HTTPException(422, { message: `unknown file resource: ${resource.fileId}` });
    }
    if (file.status !== "ready") {
      throw new HTTPException(422, {
        message: `file resource ${resource.fileId} is ${file.status}`,
      });
    }
  }
}

function normalizeMountPath(path: string): string {
  const normalized = path.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..")) {
    throw new HTTPException(422, { message: `invalid resource mount path: ${path}` });
  }
  return normalized;
}

function parseResourceUrl(uri: string): URL {
  try {
    return new URL(uri);
  } catch {
    throw new HTTPException(422, { message: "repository resources must use valid URLs" });
  }
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return null;
}

export { mergeToolRefs, stableJson };
